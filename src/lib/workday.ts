import type { TimeEntryType } from "@prisma/client";
import { badRequest } from "./errors";

/**
 * # O dia operacional da jornada
 *
 * Multiempresa exige fuso configurável, e o dia civil do funcionário **não é
 * UTC**. Uma batida às 23h50 em São Paulo é `02h50 UTC do dia seguinte`:
 * calcular a jornada em UTC jogaria a saída da noite para o dia de amanhã, e o
 * espelho mostraria uma jornada aberta que nunca fechou e outra que começou
 * fechando.
 *
 * O fuso vem de `Company.timezone` — a única configuração de fuso do projeto.
 */

/** `America/Sao_Paulo` quando a empresa não declarou nada. */
export const DEFAULT_TIMEZONE = "America/Sao_Paulo";

/**
 * Data civil (`YYYY-MM-DD`) de um instante, no fuso dado.
 *
 * `Intl` faz a conversão, incluindo horário de verão, sem dependência nova e
 * sem tabela própria de offsets — que envelheceria na primeira mudança de lei.
 */
export function civilDateIn(instant: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
  // `en-CA` já formata como YYYY-MM-DD; não montamos a string à mão.
  return parts;
}

/**
 * A data civil como `Date` à meia-noite UTC.
 *
 * A coluna é `@db.Date` — guarda uma DATA, não um instante. Gravar o início do
 * dia no fuso local faria o Postgres receber um `timestamp` que, relido noutro
 * fuso, poderia cair no dia anterior. Meia-noite UTC é a convenção que torna a
 * coluna insensível a isso.
 */
export function workdayDateOf(instant: Date, timezone: string): Date {
  return new Date(`${civilDateIn(instant, timezone)}T00:00:00.000Z`);
}

/** `true` quando o fuso é aceito pelo runtime. */
export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Fuso utilizável da empresa.
 *
 * Um fuso inválido gravado no banco não pode derrubar a batida do técnico: cai
 * no default e segue. O que ele não pode é ser aceito em silêncio numa
 * ESCRITA — quem valida o valor é quem o grava.
 */
export function resolveTimezone(value: string | null | undefined): string {
  if (typeof value !== "string" || !isValidTimezone(value)) {
    return DEFAULT_TIMEZONE;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Máquina de estados da jornada
// ---------------------------------------------------------------------------

export type WorkdayState =
  | "NOT_STARTED"
  | "WORKING"
  | "ON_BREAK"
  | "FINISHED";

/**
 * Estado DERIVADO da sequência de marcações.
 *
 * Não existe coluna de status — e isso é decisão, não economia (PRD §226). Um
 * campo mutável de estado ao lado de um histórico imutável cria duas verdades,
 * e a que diverge primeiro é sempre a que ninguém revisa. O estado é o que a
 * sequência diz que ele é.
 *
 * A lista precisa chegar **ordenada por `occurredAt`**. Uma correção aprovada
 * insere marcação no meio do dia (§229), então ordem de criação não serve.
 */
export function deriveWorkdayState(
  types: readonly TimeEntryType[],
  from: WorkdayState = "NOT_STARTED",
): WorkdayState {
  let state: WorkdayState = from;
  for (const type of types) {
    switch (type) {
      case "CLOCK_IN":
        state = "WORKING";
        break;
      case "BREAK_START":
        state = "ON_BREAK";
        break;
      case "BREAK_END":
        state = "WORKING";
        break;
      case "CLOCK_OUT":
        state = "FINISHED";
        break;
    }
  }
  return state;
}

/**
 * O que a pessoa pode fazer agora.
 *
 * **O servidor decide, o aplicativo obedece** (PRD §229 e a regra geral do
 * Field): a tela desenha o botão a partir desta lista. Um cliente que derivasse
 * a transição sozinho seria uma segunda máquina de estados — e um APK antigo em
 * campo continuaria oferecendo uma ação que o servidor já não aceita.
 */
export function allowedTransitions(
  state: WorkdayState,
): readonly TimeEntryType[] {
  switch (state) {
    case "NOT_STARTED":
      return ["CLOCK_IN"];
    case "WORKING":
      // Encerrar sem intervalo é válido: jornada curta não tem pausa.
      return ["BREAK_START", "CLOCK_OUT"];
    case "ON_BREAK":
      // Só voltar. Encerrar a jornada em intervalo deixaria um intervalo aberto
      // para sempre, e o espelho não saberia quanto durou.
      return ["BREAK_END"];
    case "FINISHED":
      // Jornada encerrada não reabre por batida. Reabrir é correção, e correção
      // passa por pedido com aprovação (§229).
      return [];
  }
}

/**
 * A sequência inteira é legal?
 *
 * Existe por causa do AJUSTE. Uma batida entra sempre no FIM do dia, então
 * validar a transição contra o estado atual basta. Uma correção aprovada insere
 * no MEIO — e o horário pedido pode produzir um dia impossível: uma saída
 * anterior à entrada, um retorno de intervalo antes do início.
 *
 * Sem esta conferência, a aprovação gravaria o fato e o espelho mostraria um
 * estado que a sequência não sustenta — a pessoa aparecendo "trabalhando"
 * depois de ter saído.
 */
export function isValidSequence(types: readonly TimeEntryType[]): boolean {
  let state: WorkdayState = "NOT_STARTED";
  for (const type of types) {
    if (!allowedTransitions(state).includes(type)) return false;
    state = deriveWorkdayState([type as TimeEntryType], state);
  }
  return true;
}

const LABELS: Record<TimeEntryType, string> = {
  CLOCK_IN: "entrada",
  BREAK_START: "início do intervalo",
  BREAK_END: "retorno do intervalo",
  CLOCK_OUT: "saída",
};

const STATE_LABELS: Record<WorkdayState, string> = {
  NOT_STARTED: "a jornada de hoje ainda não começou",
  WORKING: "você está em jornada",
  ON_BREAK: "você está em intervalo",
  FINISHED: "a jornada de hoje já foi encerrada",
};

/**
 * Recusa estruturada de uma transição inválida.
 *
 * A mensagem diz o estado e a saída, não só "inválido": o técnico precisa saber
 * o que fazer, e "transição inválida" não é instrução.
 */
export function assertTransitionAllowed(
  state: WorkdayState,
  type: TimeEntryType,
): void {
  const allowed = allowedTransitions(state);
  if (allowed.includes(type)) return;

  const saida =
    allowed.length === 0
      ? "Para corrigir, solicite um ajuste."
      : `Agora só é possível registrar ${allowed
          .map((t) => LABELS[t])
          .join(" ou ")}.`;

  throw badRequest(
    `Não é possível registrar ${LABELS[type]}: ${STATE_LABELS[state]}. ${saida}`,
  );
}
