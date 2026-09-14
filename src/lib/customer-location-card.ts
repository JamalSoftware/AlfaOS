import type { CustomerLocationSource } from "@prisma/client";
import { prisma } from "./prisma";
import { resolveTimezone } from "./workday";
import { OPERATIONAL_MAP_PATH } from "./return-to";
import { buildMapViewQuery } from "./map-view-params";

/**
 * # O cartão "Localização do cliente" — RC-LOC-03
 *
 * O que o ADMIN vê na ficha do cliente: SOMENTE LEITURA, e lido da AUTORIDADE
 * geográfica (`CustomerLocation`). Nada aqui escreve, e nenhum campo livre de
 * latitude/longitude existe — mover o ponto continua sendo "Corrigir
 * localização", no Field, com GPS e trilha.
 *
 * ## A projeção nunca alimenta o cartão
 *
 * `Customer.latitude/longitude` é a projeção de leitura que a listagem e a
 * navegação consomem. O cartão responde "onde o AlfaOS diz que o cliente
 * está", e essa resposta é a da autoridade — a mesma que o Mapa Operacional
 * desenha. Um cliente com projeção e SEM autoridade (o legado do RC-LOC-04)
 * aparece como o que ele é: sem localização geográfica, com uma nota de que há
 * um número antigo no cadastro — e sem esse número.
 *
 * ## Técnico e OS
 *
 * Só existem quando o ponto está verificado: `verified` só é escrito por ação
 * humana em campo (confirmar ou corrigir), e a importação nunca rebaixa nem
 * substitui um ponto verificado. Então a linha humana MAIS RECENTE que tocou a
 * coordenada é a que produziu o estado atual — e é dela que sai a OS. Ponto não
 * verificado veio de processo automático: não há técnico nem OS a nomear.
 *
 * Tenant em toda leitura, e de novo em cada relação: `verifiedByTechnician` e
 * `serviceOrder` são FK simples (o vetor da DQ-7.1), então um nome ou uma OS de
 * outra empresa numa linha corrompida é descartado aqui, e não exibido.
 */

export type CustomerLocationCard =
  | {
      state: "PRESENT";
      latitude: number;
      longitude: number;
      accuracyMeters: number | null;
      source: CustomerLocationSource;
      verified: boolean;
      updatedAt: Date;
      /** Quem conferiu o ponto em campo, quando conferido. */
      technicianName: string | null;
      /** A OS do atendimento que produziu o ponto atual, quando houver. */
      order: { id: string; number: number } | null;
      /** Fuso da empresa, para a tela formatar "Atualizada em". */
      timezone: string;
      /** "Ver no mapa" — `null` quando a empresa não tem o Mapa Operacional. */
      mapHref: string | null;
    }
  | {
      state: "MISSING";
      /** Há endereço textual? Muda a frase, não o estado. */
      hasAddress: boolean;
      /** Há um número antigo na projeção, sem autoridade (RC-LOC-04)? */
      hasLegacyProjection: boolean;
    };

/** Zoom de rua: o ponto e o entorno imediato, com a camada de clientes ligada. */
const ZOOM_DO_CLIENTE = 18;

/**
 * O cartão de UM cliente de UMA empresa, ou `null` se o cliente não é dela.
 *
 * As leituras vão num lote só (`$transaction([...])`): uma visita, uma conexão
 * — a lição da TL-1 com o pool frio do Docker.
 */
export async function getCustomerLocationCard(
  companyId: string,
  customerId: string,
): Promise<CustomerLocationCard | null> {
  const [empresa, cliente, ponto, ultimaHumana] = await prisma.$transaction([
    prisma.company.findUnique({
      where: { id: companyId },
      select: { timezone: true, ctoNetworkEnabled: true },
    }),
    prisma.customer.findFirst({
      where: { id: customerId, companyId },
      select: { address: true, city: true, latitude: true, longitude: true },
    }),
    prisma.customerLocation.findFirst({
      where: { customerId, companyId },
      select: {
        latitude: true,
        longitude: true,
        accuracyMeters: true,
        source: true,
        verified: true,
        updatedAt: true,
        verifiedByTechnician: {
          select: { companyId: true, user: { select: { name: true, companyId: true } } },
        },
      },
    }),
    prisma.customerLocationHistory.findFirst({
      where: {
        companyId,
        customerId,
        technicianId: { not: null },
        kind: { in: ["COORDINATES", "BOTH"] },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: {
        serviceOrder: { select: { id: true, number: true, companyId: true, customerId: true } },
      },
    }),
  ]);

  // Cliente de outra empresa não tem cartão aqui — nem com um ponto que, por FK
  // simples, apontasse para ele.
  if (!cliente) return null;

  if (!ponto) {
    return {
      state: "MISSING",
      hasAddress: Boolean(cliente.address?.trim() || cliente.city?.trim()),
      hasLegacyProjection: cliente.latitude !== null && cliente.longitude !== null,
    };
  }

  const latitude = Number(ponto.latitude);
  const longitude = Number(ponto.longitude);

  const verificador = ponto.verifiedByTechnician;
  const technicianName =
    ponto.verified &&
    verificador &&
    verificador.companyId === companyId &&
    verificador.user.companyId === companyId
      ? verificador.user.name
      : null;

  const os = ultimaHumana?.serviceOrder;
  const order =
    ponto.verified && os && os.companyId === companyId && os.customerId === customerId
      ? { id: os.id, number: os.number }
      : null;

  const query = buildMapViewQuery({
    latitude,
    longitude,
    zoom: ZOOM_DO_CLIENTE,
    layers: { CTOS: true, ORDERS: true, CUSTOMERS: true },
  });

  return {
    state: "PRESENT",
    latitude,
    longitude,
    accuracyMeters: ponto.accuracyMeters,
    source: ponto.source,
    verified: ponto.verified,
    updatedAt: ponto.updatedAt,
    technicianName,
    order,
    timezone: resolveTimezone(empresa?.timezone),
    // O Mapa Operacional só existe com o módulo de rede ligado (`/mapa` é 404
    // sem ele): um link para lá seria um botão que leva a uma página que não
    // existe.
    mapHref: empresa?.ctoNetworkEnabled === true ? `${OPERATIONAL_MAP_PATH}?${query}` : null,
  };
}
