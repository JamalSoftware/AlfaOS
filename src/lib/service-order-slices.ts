import type { Prisma, ServiceOrderStatus } from "@prisma/client";
import { OPEN_SERVICE_ORDER_STATUSES } from "./service-order-labels";
import { companyTimezone } from "./company-timezone";
import { civilDayBoundsIn } from "./workday";

/**
 * # Recortes operacionais de OS — DASH-1
 *
 * O painel operacional (PRD §380) mostra "OS abertas", "OS atrasadas" e "OS de
 * hoje", e **todo cartão abre a listagem filtrada** — com a contagem da
 * listagem igual à do cartão. A igualdade não é conferida depois: ela é
 * construída aqui. O cartão e a `/ordens?recorte=…` pedem o MESMO predicado a
 * esta função, e não existe segunda fórmula para divergir.
 *
 * ## As definições, e de onde elas vêm
 *
 * ```text
 * abertas    status aberto — OPEN_SERVICE_ORDER_STATUSES, o predicado
 *            compartilhado do mapa (§371), derivado dos estados TERMINAIS
 * atrasadas  agendada, com o agendamento já vencido, e AINDA NÃO INICIADA
 * hoje       aberta e agendada para o dia civil de hoje, no fuso da EMPRESA
 * ```
 *
 * "Atrasada" e "de hoje" não tinham definição no PRD nem no código — o SLA é
 * futuro (§112) e o único prazo que a OS carrega é `scheduledAt`. As duas
 * foram **decididas pelo dono** na abertura da DASH-1:
 *
 * - **atrasada não inclui a OS em atendimento.** Segue a regra que o código já
 *   usava na fila do técnico: *status vence agendamento* — uma OS iniciada é
 *   "em atendimento", não "atrasada". OS **sem** agendamento nunca é atrasada:
 *   não há prazo a vencer, e inventar um seria a inferência que o PRD proíbe.
 * - **de hoje é o trabalho que ainda falta hoje**: inclui a OS em atendimento
 *   e sai do número quando a OS é concluída ou cancelada.
 *
 * ## "Hoje" é o da empresa, nunca o do servidor
 *
 * `Company.timezone` é a única configuração de fuso do projeto, e os limites
 * do dia vêm de `civilDayBoundsIn` — a mesma autoridade de fuso da Jornada.
 * `new Date(ano, mês, dia)` usaria o fuso do processo, que em produção costuma
 * ser UTC.
 */

/*
  "pendentes" entrou na DASH-1a. O cartão abria `/ordens?status=PENDING` — o
  filtro comum da tela —, e por isso a listagem não tinha como saber que a
  pessoa viera do painel: nem faixa de recorte, nem "Voltar ao Dashboard". Um
  filtro que a pessoa escolhe e um recorte que o painel abre são coisas
  diferentes, e cada um tem o seu parâmetro. O predicado é o mesmo status.
*/
export const SERVICE_ORDER_SLICES = [
  "abertas",
  "atrasadas",
  "hoje",
  "pendentes",
] as const;
export type ServiceOrderSlice = (typeof SERVICE_ORDER_SLICES)[number];

/** Os recortes cuja resposta depende do relógio e do fuso da empresa. */
export const TIME_DEPENDENT_SLICES: ReadonlySet<ServiceOrderSlice> =
  new Set<ServiceOrderSlice>(["atrasadas", "hoje"]);

/**
 * Aberta e ainda não iniciada: o conjunto aberto, menos a OS em atendimento.
 *
 * Derivado de `OPEN_SERVICE_ORDER_STATUSES`, e não listado: um estado novo que
 * nasça aberto — digamos, "em deslocamento" — entra aqui sozinho, e a OS
 * nesse estado pode ficar atrasada. Com uma lista escrita à mão, ela sumiria
 * do cartão sem ninguém perceber.
 */
export const NOT_STARTED_SERVICE_ORDER_STATUSES: ServiceOrderStatus[] =
  OPEN_SERVICE_ORDER_STATUSES.filter((status) => status !== "IN_PROGRESS");

/** O relógio de um recorte: o instante de referência e o fuso da empresa. */
export interface SliceClock {
  now: Date;
  timezone: string;
}

/** `null` para qualquer valor fora da lista — nunca um recorte adivinhado. */
export function parseServiceOrderSlice(raw: unknown): ServiceOrderSlice | null {
  return typeof raw === "string" &&
    (SERVICE_ORDER_SLICES as readonly string[]).includes(raw)
    ? (raw as ServiceOrderSlice)
    : null;
}

/**
 * O predicado do recorte, sem o tenant — quem chama põe o `companyId`.
 *
 * `scheduledAt: { lt }` exclui `NULL` no próprio SQL: comparação com nulo não é
 * verdadeira, e é isso que faz a OS sem agendamento nunca ser atrasada.
 */
export function serviceOrderSliceWhere(
  slice: ServiceOrderSlice,
  clock: SliceClock,
): Prisma.ServiceOrderWhereInput {
  switch (slice) {
    case "abertas":
      return { status: { in: OPEN_SERVICE_ORDER_STATUSES } };
    case "atrasadas":
      return {
        status: { in: NOT_STARTED_SERVICE_ORDER_STATUSES },
        scheduledAt: { lt: clock.now },
      };
    case "hoje": {
      const dia = civilDayBoundsIn(clock.now, clock.timezone);
      return {
        status: { in: OPEN_SERVICE_ORDER_STATUSES },
        scheduledAt: { gte: dia.start, lt: dia.end },
      };
    }
    case "pendentes":
      // Sem técnico: exatamente o status PENDING, o mesmo do filtro da tela.
      return { status: { in: ["PENDING"] } };
  }
}

/**
 * A MESMA regra de "atrasada", para quem já tem a linha na mão — RC-1D.
 *
 * `serviceOrderSliceWhere("atrasadas")` responde no SQL, para contar; esta
 * responde em memória, para a fila do técnico decidir a seção de uma OS que já
 * veio do banco. Uma segunda leitura só para classificar seria consulta a mais,
 * e uma segunda FÓRMULA seria a divergência que o `DASH-1` existe para não ter:
 * as duas dizem "agendada, vencida e ainda não iniciada", e um teste compara as
 * duas contra os mesmos vetores.
 *
 * Sem agendamento nunca é atrasada — não há prazo a vencer.
 */
export function isOverdueServiceOrder(
  order: { status: ServiceOrderStatus; scheduledAt: Date | null },
  now: Date,
): boolean {
  return (
    NOT_STARTED_SERVICE_ORDER_STATUSES.includes(order.status) &&
    order.scheduledAt !== null &&
    order.scheduledAt < now
  );
}

/**
 * O relógio da empresa: agora, no fuso que ela declarou.
 *
 * A leitura do fuso mora em `companyTimezone` (`RC-1`): as telas que só
 * precisam formatar data a usam direto, sem carregar os recortes de OS, e
 * continua havendo UMA resposta para "qual é o fuso desta empresa".
 */
export async function companySliceClock(
  companyId: string,
  now: Date = new Date(),
): Promise<SliceClock> {
  return { now, timezone: await companyTimezone(companyId) };
}
