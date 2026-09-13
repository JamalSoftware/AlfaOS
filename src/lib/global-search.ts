import { AccessProfile } from "@prisma/client";
import { prisma } from "./prisma";
import { customerSearchFilter } from "./customers";
import { serviceOrderSearchFilter } from "./service-orders";
import { technicianSearchFilter } from "./technicians";
import { searchCtosForMap } from "./cto-map";
import { GLOBAL_SEARCH_PER_TYPE, parseGlobalSearchQuery } from "./global-search-rules";
import { formatServiceOrderNumber, SERVICE_ORDER_STATUS_LABELS } from "./service-order-labels";
import { canUseGlobalSearch } from "./navigation";
import { forbidden } from "./errors";

/**
 * # Busca global do AlfaOS — GS-1 (PRD §384)
 *
 * Uma busca só para o operador achar cliente, OS, CTO ou técnico sem saber em
 * que tela procurar. É uma LEITURA: nada é gravado, nem o termo, e nenhum
 * índice, cache ou tabela de "coisa pesquisável" existe.
 *
 * ## Cada tipo pela busca que já existe (§201)
 *
 * Cliente, OS e técnico usam o MESMO predicado das listagens `/clientes`,
 * `/ordens` e `/tecnicos` (`customerSearchFilter`, `serviceOrderSearchFilter`,
 * `technicianSearchFilter`); a CTO usa a busca de caixa do mapa
 * (`searchCtosForMap`, nome e código). Busca duplicada é autorização duplicada,
 * e o "ver todos" de cada grupo abre a listagem com o mesmo termo — que mostra os
 * mesmos registros porque o `where` é o mesmo.
 *
 * ## Quem vê o quê
 *
 * O que a listagem correspondente já mostra, e nada além (MASTER-PLAN §7):
 *
 * ```text
 * ADMIN       clientes · OS · técnicos · CTOs (só com a rede ligada — /ctos é dele)
 * DISPATCHER  clientes · OS · técnicos — /ctos é só do ADMIN
 * TECHNICIAN  nada: não tem listagem na web (decisão do dono)
 * ```
 *
 * Equipamento ficou FORA da V1 por decisão do dono: não tem identidade própria,
 * página nem listagem de onde herdar permissão.
 *
 * ## Tenant em SQL, e o dado é o mínimo
 *
 * `companyId` da sessão em todo `where` — inclusive dentro das relações com
 * cliente e usuário. O DTO não leva documento, telefone, e-mail, coordenada nem
 * identificador de ERP: o operador reconhece pelo nome e pelo contexto, e abre o
 * registro para ver o resto, na tela que já decide quem pode ver.
 */

export type GlobalSearchType = "CUSTOMER" | "SERVICE_ORDER" | "CTO" | "TECHNICIAN";

export interface GlobalSearchHit {
  type: GlobalSearchType;
  id: string;
  title: string;
  subtitle: string | null;
  inactive: boolean;
  href: string;
}

export interface GlobalSearchGroup {
  type: GlobalSearchType;
  hits: GlobalSearchHit[];
  /** Havia mais do que o teto do tipo. */
  truncated: boolean;
  /** A listagem com o MESMO predicado — o "ver todos". `null` quando não existe. */
  moreHref: string | null;
}

export interface GlobalSearchViewer {
  companyId: string;
  profile: AccessProfile;
}

export type GlobalSearchResult =
  | { state: "idle" }
  | { state: "too-short"; term: string }
  | { state: "too-long"; term: string }
  | { state: "ok"; term: string; groups: GlobalSearchGroup[] };

export type GlobalSearchSection = GlobalSearchResult | { state: "error"; term: string };

const customerSelect = {
  id: true,
  name: true,
  active: true,
  district: true,
  city: true,
  state: true,
} as const;

const orderSelect = {
  id: true,
  number: true,
  type: true,
  status: true,
  serviceOrderType: { select: { name: true } },
  customer: { select: { name: true, companyId: true } },
} as const;

const technicianSelect = {
  id: true,
  active: true,
  user: { select: { name: true } },
} as const;

function joined(parts: (string | null | undefined)[]): string | null {
  const texto = parts.filter((p): p is string => Boolean(p && p.trim())).join(" · ");
  return texto === "" ? null : texto;
}

function group(
  type: GlobalSearchType,
  hits: GlobalSearchHit[],
  truncated: boolean,
  moreHref: string | null,
): GlobalSearchGroup {
  return { type, hits, truncated, moreHref: truncated ? moreHref : null };
}

/**
 * A busca. Uma ida ao banco para cliente, OS e técnico — um lote numa conexão
 * só, nunca uma rajada de consultas em paralelo (a lição da `TL-1`) — e, para o
 * ADMIN com a rede ligada, a busca de caixa.
 */
export async function searchGlobal(
  viewer: GlobalSearchViewer,
  raw: unknown,
): Promise<GlobalSearchResult> {
  if (!canUseGlobalSearch(viewer.profile)) {
    throw forbidden("A busca global não está disponível para este perfil.");
  }
  const query = parseGlobalSearchQuery(raw);
  if (query.kind === "empty") return { state: "idle" };
  if (query.kind === "too-short") return { state: "too-short", term: query.term };
  if (query.kind === "too-long") return { state: "too-long", term: query.term };

  const { companyId } = viewer;
  const { term, orderNumber, textSearch } = query;
  const take = GLOBAL_SEARCH_PER_TYPE + 1;
  const isAdmin = viewer.profile === AccessProfile.ADMIN;

  /*
    O lote tem sempre a mesma forma, para que o custo de uma busca não dependa
    do termo. Consulta que não se aplica recebe o predicado que não casa nada:
    "7" procura só a OS Nº 7, e nenhum cliente com "7" no telefone.
  */
  const NADA = { id: { in: [] as string[] } };
  const porNumero = orderNumber !== null ? { companyId, number: orderNumber } : NADA;

  const [clientes, ordens, ordemExata, tecnicos, empresa] = await prisma.$transaction([
    prisma.customer.findMany({
      where: textSearch ? { companyId, ...customerSearchFilter(term) } : NADA,
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take,
      select: customerSelect,
    }),
    prisma.serviceOrder.findMany({
      where: textSearch ? { companyId, ...serviceOrderSearchFilter(companyId, term) } : porNumero,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take,
      select: orderSelect,
    }),
    // O número exato vem PRIMEIRO, mesmo quando outras OS citam "12" no texto
    // e são mais novas.
    prisma.serviceOrder.findMany({
      where: textSearch ? porNumero : NADA,
      take: 1,
      select: orderSelect,
    }),
    prisma.technician.findMany({
      where: textSearch ? { companyId, ...technicianSearchFilter(companyId, term) } : NADA,
      orderBy: [{ user: { name: "asc" } }, { id: "asc" }],
      take,
      select: technicianSelect,
    }),
    prisma.company.findUnique({
      where: { id: companyId },
      select: { ctoNetworkEnabled: true },
    }),
  ]);

  const groups: GlobalSearchGroup[] = [];
  const encoded = encodeURIComponent(term);

  if (clientes.length > 0) {
    groups.push(
      group(
        "CUSTOMER",
        clientes.slice(0, GLOBAL_SEARCH_PER_TYPE).map((c) => ({
          type: "CUSTOMER",
          id: c.id,
          title: c.name,
          subtitle: joined([c.district, c.city ? (c.state ? `${c.city}/${c.state}` : c.city) : null]),
          inactive: !c.active,
          href: `/clientes/${encodeURIComponent(c.id)}/editar`,
        })),
        clientes.length > GLOBAL_SEARCH_PER_TYPE,
        `/clientes?search=${encoded}`,
      ),
    );
  }

  const vistas = new Set<string>();
  const ordensUnicas = [...ordemExata, ...ordens].filter((o) => {
    if (vistas.has(o.id)) return false;
    vistas.add(o.id);
    return true;
  });
  if (ordensUnicas.length > 0) {
    groups.push(
      group(
        "SERVICE_ORDER",
        ordensUnicas.slice(0, GLOBAL_SEARCH_PER_TYPE).map((o) => ({
          type: "SERVICE_ORDER",
          id: o.id,
          title: formatServiceOrderNumber(o),
          subtitle: joined([
            // O nome só sai se o cliente é da MESMA empresa (FK simples).
            o.customer.companyId === companyId ? o.customer.name : null,
            o.serviceOrderType?.name ?? o.type,
            SERVICE_ORDER_STATUS_LABELS[o.status],
          ]),
          inactive: false,
          href: `/ordens/${encodeURIComponent(o.id)}`,
        })),
        ordensUnicas.length > GLOBAL_SEARCH_PER_TYPE,
        textSearch ? `/ordens?search=${encoded}` : null,
      ),
    );
  }

  if (isAdmin && empresa?.ctoNetworkEnabled && textSearch) {
    const caixas = await searchCtosForMap(companyId, term);
    if (caixas.hits.length > 0) {
      groups.push(
        group(
          "CTO",
          caixas.hits.slice(0, GLOBAL_SEARCH_PER_TYPE).map((cto) => ({
            type: "CTO",
            id: cto.id,
            title: cto.name,
            subtitle: cto.code ? `Código ${cto.code}` : null,
            inactive: false,
            href: `/ctos/${encodeURIComponent(cto.id)}`,
          })),
          caixas.truncated || caixas.hits.length > GLOBAL_SEARCH_PER_TYPE,
          // `/ctos` não tem busca por texto: não há "ver todos" honesto.
          null,
        ),
      );
    }
  }

  if (tecnicos.length > 0) {
    groups.push(
      group(
        "TECHNICIAN",
        tecnicos.slice(0, GLOBAL_SEARCH_PER_TYPE).map((t) => ({
          type: "TECHNICIAN",
          id: t.id,
          title: t.user.name,
          subtitle: null,
          inactive: !t.active,
          // Não existe página de técnico: a listagem filtrada pelo nome dele é o
          // destino que já existe, com os mesmos perfis.
          href: `/tecnicos?search=${encodeURIComponent(t.user.name)}`,
        })),
        tecnicos.length > GLOBAL_SEARCH_PER_TYPE,
        `/tecnicos?search=${encoded}`,
      ),
    );
  }

  return { state: "ok", term, groups };
}

/**
 * A busca para a tela: falha vira `error`, NUNCA "nenhum resultado" — dizer que
 * um cliente não existe porque uma consulta caiu seria o contrário da verdade.
 *
 * O log leva só o tipo do erro: nem a mensagem (pode trazer fragmento de
 * consulta) nem o termo (pode ser um telefone ou um CPF).
 */
export async function loadGlobalSearch(
  viewer: GlobalSearchViewer,
  raw: unknown,
): Promise<GlobalSearchSection> {
  try {
    return await searchGlobal(viewer, raw);
  } catch (error) {
    console.error("[global-search] falhou", {
      companyId: viewer.companyId,
      erro: error instanceof Error ? error.name : "desconhecido",
    });
    const query = parseGlobalSearchQuery(raw);
    return { state: "error", term: query.kind === "empty" ? "" : query.term };
  }
}
