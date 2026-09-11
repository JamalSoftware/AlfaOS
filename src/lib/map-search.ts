import { prisma } from "./prisma";
import {
  CTO_MAP_SEARCH_MAX_RESULTS,
  searchCtosForMap,
} from "./cto-map";
import { OPEN_SERVICE_ORDER_STATUSES } from "./service-order-labels";

/**
 * # A busca do Mapa Operacional — três tipos, um envelope
 *
 * ## Por que este módulo existe separado
 *
 * `cto-map.ts` passou a importar `operational-map.ts` para compor o resumo das
 * caixas, e a busca precisa dos dois. Escrevê-la em qualquer um deles fecharia
 * um ciclo de imports. Aqui ela compõe sem que nenhum dos dois conheça o outro
 * na direção errada.
 *
 * ## Ela é GLOBAL no tenant, e não do recorte
 *
 * Quem procura um cliente quase sempre está olhando outro bairro. Limitar ao
 * que está na tela responderia *"não existe"* sobre alguém que existe — a pior
 * resposta que um campo de busca pode dar. É a mesma decisão que a `CTO-3.2`
 * tomou para caixas, e ela não muda por haver mais tipos.
 *
 * ## Um envelope, e NENHUMA superentidade
 *
 * `MapSearchHit` é DTO de busca, e só. Não existe tabela de "coisa
 * pesquisável", não existe índice unificado, não existe entidade nova
 * persistida: cada tipo é consultado na própria tabela, com o próprio
 * predicado, e o que se unifica é a forma da resposta — o suficiente para a
 * tela renderizar uma lista e, ao clicar, saber para onde ir.
 *
 * ## Coordenada é ANULÁVEL, de propósito
 *
 * Um cliente sem localização, ou uma OS cujo cliente não tem localização,
 * **aparecem na busca**. Elas simplesmente não recentralizam o mapa. O `null` é
 * o que permite à tela dizer "sem localização" em vez de mandar o mapa para um
 * ponto inventado — e as ações de abrir continuam disponíveis.
 */

export type MapSearchHitType = "CTO" | "CUSTOMER" | "SERVICE_ORDER";

export interface MapSearchHit {
  type: MapSearchHitType;
  id: string;
  /** O que identifica a coisa: nome da caixa, nome do cliente, "OS Nº 12". */
  label: string;
  /** Contexto curto: código da caixa, situação do cliente, tipo da OS. */
  secondaryLabel: string | null;
  latitude: number | null;
  longitude: number | null;
}

export interface MapSearchResult {
  hits: MapSearchHit[];
  /** Algum dos tipos bateu no teto? A tela pede um termo mais específico. */
  truncated: boolean;
  limit: number;
}

/**
 * Quantos resultados por TIPO.
 *
 * Por tipo, e não no total: com um teto global, dez caixas com nome parecido
 * empurrariam clientes e OS para fora da lista, e o operador concluiria que não
 * existem. Cada tipo tem o próprio espaço.
 */
const LIMITE_POR_TIPO = CTO_MAP_SEARCH_MAX_RESULTS;

/**
 * O termo é um número de OS?
 *
 * `ServiceOrder.number` é inteiro, e `contains` não se aplica a inteiro no
 * Prisma. Quem digita "12" quer a OS 12; quem digita "João" não quer OS nenhuma
 * — e tentar converter "João" para número produziria `NaN` numa consulta que o
 * banco recusaria.
 */
function comoNumeroDeOs(termo: string): number | null {
  const limpo = termo.trim().replace(/^(os|n[ºo°]?)\s*/i, "");
  if (!/^\d{1,9}$/.test(limpo)) return null;
  const valor = Number(limpo);
  return Number.isSafeInteger(valor) && valor > 0 ? valor : null;
}

/**
 * A busca operacional: caixas, clientes e OS abertas.
 *
 * O termo já chega normalizado por `normalizeMapSearchQuery` — a mesma função
 * que a busca de CTO usava, com os mesmos limites. Nada aqui reimplementa
 * validação de termo.
 */
export async function searchOperationalMap(
  companyId: string,
  termo: string,
): Promise<MapSearchResult> {
  const numeroDeOs = comoNumeroDeOs(termo);

  const [ctos, clientes, ordens] = await Promise.all([
    searchCtosForMap(companyId, termo),

    /*
      Cliente: por NOME, e só.

      Documento, telefone e e-mail ficam de fora desta fase por decisão
      explícita — buscar por CPF muda a conversa sobre privacidade e sobre quem
      pode enumerar a carteira, e isso é revisão própria, não efeito colateral
      de uma camada de mapa.

      Só cadastralmente ATIVO, coerente com a camada que a busca serve.
    */
    prisma.customer.findMany({
      where: {
        companyId,
        active: true,
        name: { contains: termo, mode: "insensitive" },
      },
      select: {
        id: true,
        name: true,
        location: { select: { latitude: true, longitude: true } },
      },
      orderBy: [{ name: "asc" }],
      take: LIMITE_POR_TIPO + 1,
    }),

    /*
      OS: pelo NÚMERO, que é como as pessoas se referem a ela.

      Só OS ABERTA, pelo predicado compartilhado. Uma busca que devolvesse OS
      concluída num mapa de operação atual mandaria o operador para um ponto que
      não pede nada dele.

      Sem termo numérico, a consulta nem acontece.
    */
    numeroDeOs === null
      ? Promise.resolve([])
      : prisma.serviceOrder.findMany({
          where: {
            companyId,
            number: numeroDeOs,
            status: { in: OPEN_SERVICE_ORDER_STATUSES },
          },
          select: {
            id: true,
            number: true,
            type: true,
            serviceOrderType: { select: { name: true } },
            customer: {
              select: {
                name: true,
                location: { select: { latitude: true, longitude: true } },
              },
            },
          },
          take: LIMITE_POR_TIPO + 1,
        }),
  ]);

  const clientesVisiveis = clientes.slice(0, LIMITE_POR_TIPO);
  const ordensVisiveis = ordens.slice(0, LIMITE_POR_TIPO);

  const hits: MapSearchHit[] = [
    ...ctos.hits.map<MapSearchHit>((cto) => ({
      type: "CTO",
      id: cto.id,
      label: cto.name,
      secondaryLabel: cto.code ? `Código ${cto.code}` : null,
      latitude: cto.latitude,
      longitude: cto.longitude,
    })),
    ...clientesVisiveis.map<MapSearchHit>((cliente) => ({
      type: "CUSTOMER",
      id: cliente.id,
      label: cliente.name,
      secondaryLabel: "Cliente ativo",
      latitude: cliente.location
        ? cliente.location.latitude.toNumber()
        : null,
      longitude: cliente.location
        ? cliente.location.longitude.toNumber()
        : null,
    })),
    ...ordensVisiveis.map<MapSearchHit>((ordem) => ({
      type: "SERVICE_ORDER",
      id: ordem.id,
      label: `OS Nº ${ordem.number}`,
      secondaryLabel: ordem.serviceOrderType?.name ?? ordem.type ?? null,
      latitude: ordem.customer.location
        ? ordem.customer.location.latitude.toNumber()
        : null,
      longitude: ordem.customer.location
        ? ordem.customer.location.longitude.toNumber()
        : null,
    })),
  ];

  return {
    hits,
    truncated:
      ctos.truncated ||
      clientes.length > LIMITE_POR_TIPO ||
      ordens.length > LIMITE_POR_TIPO,
    limit: LIMITE_POR_TIPO,
  };
}
