import { isPortWithinCapacity } from "./cto";
import { deriveCtoMapStatus, type CtoMapStatus } from "./cto-map";
import { summarizePortCounts } from "./cto-read-model";
import { getCtoOperationalSummaries } from "./operational-map";
import { prisma } from "./prisma";

/**
 * # CTOs que pedem atenção — DASH-1
 *
 * O painel operacional (PRD §380) conta "CTOs com defeito" e "CTOs com OS
 * abertas", e cada cartão abre a lista de CTOs filtrada — com a lista mostrando
 * exatamente as caixas que o cartão contou. Este módulo é o único lugar que
 * responde as duas perguntas, e o cartão e a `/ctos?situacao=…` o chamam.
 *
 * ## Nenhuma regra de CTO nasce aqui
 *
 * O estado da caixa é o do Mapa Operacional, que está congelado (§392), e ele é
 * montado aqui com as MESMAS primitivas exportadas que o mapa usa — na mesma
 * ordem —, sem tocar o código do mapa:
 *
 * ```text
 * portas dentro da capacidade   isPortWithinCapacity      (cto.ts)
 * contagem de portas            summarizePortCounts       (cto-read-model.ts)
 * ocupação + OS abertas         getCtoOperationalSummaries (operational-map.ts)
 * estado da caixa               deriveCtoMapStatus         (cto-map.ts)
 * ```
 *
 * A diferença é o universo: o mapa monta as caixas do RECORTE; o painel, as da
 * empresa inteira — inclusive as sem coordenada, que o mapa não desenha e que
 * continuam podendo estar com defeito. Um teste de paridade compara, caixa a
 * caixa, o estado daqui com o do marcador do mapa: se as duas montagens
 * divergirem, ele cai.
 *
 * ## As duas perguntas
 *
 * ```text
 * com defeito     estado derivado DAMAGED — a caixa inativa é INACTIVE e não
 *                 conta: pela precedência congelada, nem se pergunta o resto
 * com OS abertas  OS abertas de clientes ativos vinculados à caixa > 0 — o
 *                 mesmo número do selo do marcador (§371)
 * ```
 */

export const CTO_ATTENTION_FILTERS = ["defeito", "com-os-abertas"] as const;
export type CtoAttentionFilter = (typeof CTO_ATTENTION_FILTERS)[number];

export const CTO_ATTENTION_LABELS: Record<CtoAttentionFilter, string> = {
  defeito: "CTOs com defeito",
  "com-os-abertas": "CTOs com OS abertas",
};

export function parseCtoAttentionFilter(raw: unknown): CtoAttentionFilter | null {
  return typeof raw === "string" &&
    (CTO_ATTENTION_FILTERS as readonly string[]).includes(raw)
    ? (raw as CtoAttentionFilter)
    : null;
}

export interface CtoOperationalState {
  status: CtoMapStatus;
  openServiceOrderCount: number;
}

export function matchesCtoAttention(
  state: CtoOperationalState,
  filter: CtoAttentionFilter,
): boolean {
  return filter === "defeito"
    ? state.status === "DAMAGED"
    : state.openServiceOrderCount > 0;
}

/**
 * O estado de cada CTO da empresa.
 *
 * Três leituras de dado, e o número delas não cresce com a quantidade de caixas:
 * as CTOs, as portas de todas elas (um `IN`), e o resumo operacional (que já é
 * em lote — vínculos, conectividade e OS numa consulta de cada).
 */
export async function getCompanyCtoStates(
  companyId: string,
): Promise<Map<string, CtoOperationalState>> {
  const estados = new Map<string, CtoOperationalState>();

  const ctos = await prisma.cTO.findMany({
    // Tenant no predicado SQL, nunca por navegação de FK.
    where: { companyId },
    select: { id: true, active: true, capacity: true },
  });
  if (ctos.length === 0) return estados;

  const ids = ctos.map((cto) => cto.id);
  const [portas, operacional] = await Promise.all([
    prisma.cTOPort.findMany({
      where: { companyId, ctoId: { in: ids } },
      select: {
        id: true,
        ctoId: true,
        number: true,
        administrativeState: true,
      },
    }),
    getCtoOperationalSummaries(companyId, ids),
  ]);

  const portasPorCto = new Map<string, typeof portas>();
  for (const porta of portas) {
    const lista = portasPorCto.get(porta.ctoId);
    if (lista) lista.push(porta);
    else portasPorCto.set(porta.ctoId, [porta]);
  }

  for (const cto of ctos) {
    const summary = summarizePortCounts(
      (portasPorCto.get(cto.id) ?? []).map((porta) => ({
        administrativeState: porta.administrativeState,
        withinCapacity: isPortWithinCapacity(porta, cto.capacity),
        occupied: operacional.occupiedPortIds.has(porta.id),
      })),
      cto.capacity,
    );
    estados.set(cto.id, {
      status: deriveCtoMapStatus(cto.active, summary),
      openServiceOrderCount:
        operacional.summaries.get(cto.id)?.openServiceOrderCount ?? 0,
    });
  }

  return estados;
}

/** Quantas caixas da empresa se encaixam em cada pergunta. */
export function countCtoAttention(
  estados: ReadonlyMap<string, CtoOperationalState>,
): Record<CtoAttentionFilter, number> {
  let defeito = 0;
  let comOs = 0;
  for (const estado of Array.from(estados.values())) {
    if (matchesCtoAttention(estado, "defeito")) defeito += 1;
    if (matchesCtoAttention(estado, "com-os-abertas")) comOs += 1;
  }
  return { defeito, "com-os-abertas": comOs };
}
