import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";

/**
 * # Transactional outbox
 *
 * A regra é uma só: **evento importante não pode depender de chamada externa
 * dentro da transação principal** (PRD §156).
 *
 * ```text
 * TRANSACTION
 *  ├── alterar ServiceOrder
 *  ├── criar ServiceOrderEvent
 *  ├── criar Notification
 *  └── criar OutboxEvent
 * COMMIT
 *          depois, fora da transação
 * worker → lê o outbox → provider de push
 * ```
 *
 * Chamar o FCM lá dentro produz dois desfechos igualmente ruins: a transação
 * fica aberta esperando rede de terceiro, ou o push sai e a transação sofre
 * rollback — e o técnico recebe notificação de uma atribuição que não existe.
 *
 * ## Sem segredo no payload
 *
 * Esta tabela sobrevive à transação, é lida por worker, aparece em dump e em
 * backup. Ela carrega **referência** ao agregado; o worker relê o que precisa
 * na hora de processar. Nada de token, senha, CPF, telefone, endereço ou
 * payload cru de provider.
 *
 * `companyId` viaja no evento não por redundância: o worker precisa dele para
 * respeitar isolamento de tenant sem reconsultar o agregado.
 */

export const OUTBOX_EVENTS = {
  /** Uma OS passou a ser de um técnico. Agregado: `ServiceOrder`. */
  SERVICE_ORDER_ASSIGNED: "SERVICE_ORDER_ASSIGNED",
} as const;

export type OutboxEventType =
  (typeof OUTBOX_EVENTS)[keyof typeof OUTBOX_EVENTS];

/**
 * Payload permitido: só identificador e contador.
 *
 * O tipo é estreito de propósito. `Json` aceitaria qualquer coisa, e "qualquer
 * coisa" é como um CPF acaba numa tabela que vai para o backup — não por má
 * intenção, mas porque alguém acrescentou um campo útil sem pensar em onde a
 * linha ia parar.
 */
export type OutboxPayload = Record<string, string | number | boolean | null>;

export interface EnqueueOutboxInput {
  companyId: string;
  eventType: OutboxEventType;
  aggregateType: string;
  aggregateId: string;
  payload?: OutboxPayload;
}

/**
 * Grava a intenção. **Exige a transação de quem chama** — o `tx` não é
 * opcional por engano.
 *
 * Um `enqueue` que abrisse a própria conexão poderia commitar sozinho e
 * sobreviver ao rollback do domínio, que é exatamente o defeito que o outbox
 * existe para impedir. Recebendo o `tx`, o evento só existe se a mudança
 * existir.
 */
export async function enqueueOutboxEvent(
  tx: Prisma.TransactionClient,
  input: EnqueueOutboxInput,
): Promise<void> {
  await tx.outboxEvent.create({
    data: {
      companyId: input.companyId,
      eventType: input.eventType,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      payload: (input.payload ?? {}) as Prisma.InputJsonValue,
    },
  });
}

// ---------------------------------------------------------------------------
// Processamento
// ---------------------------------------------------------------------------

/**
 * Teto de tentativas.
 *
 * Depois dele o evento vira `FAILED` e PARA — visível, com motivo e contagem.
 * Um job que esgotou as tentativas e sumiu em silêncio é pior do que um job
 * que nunca rodou: ninguém sabe que faltou (PRD §157).
 */
export const OUTBOX_MAX_ATTEMPTS = 6;

/** Primeiro adiamento; dobra a cada tentativa. */
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_CAP_MS = 60 * 60 * 1000;

export function outboxBackoffMs(attempts: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), BACKOFF_CAP_MS);
}

/**
 * Motivo de falha, encurtado e sem segredo.
 *
 * O texto vem de uma exceção que pode ter passado perto de qualquer coisa. Ele
 * é truncado e o `lastError` nunca recebe o objeto de erro inteiro.
 */
function sanitizeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : "erro desconhecido";
  return raw.replace(/\s+/g, " ").slice(0, 300);
}

export interface OutboxHandlerContext {
  companyId: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: unknown;
}

export type OutboxHandler = (ctx: OutboxHandlerContext) => Promise<void>;

export interface OutboxRunResult {
  claimed: number;
  processed: number;
  failed: number;
  exhausted: number;
}

/**
 * Processa um lote. Devolve contagens — nunca conteúdo.
 *
 * A reivindicação é feita por `updateMany` com predicado de status: o banco
 * serializa, exatamente um processo troca `PENDING` por `PROCESSING`, e os
 * demais casam zero linhas e seguem em frente. É o que permite rodar dois
 * workers (ou um cron que se sobrepôs ao anterior) sem entregar o mesmo push
 * duas vezes.
 */
export async function processOutboxBatch(
  handler: OutboxHandler,
  limit = 25,
  now: Date = new Date(),
): Promise<OutboxRunResult> {
  const candidates = await prisma.outboxEvent.findMany({
    where: { status: "PENDING", availableAt: { lte: now } },
    orderBy: { availableAt: "asc" },
    take: limit,
    select: { id: true },
  });

  const result: OutboxRunResult = {
    claimed: 0,
    processed: 0,
    failed: 0,
    exhausted: 0,
  };

  for (const candidate of candidates) {
    const claim = await prisma.outboxEvent.updateMany({
      where: { id: candidate.id, status: "PENDING" },
      data: { status: "PROCESSING", attempts: { increment: 1 } },
    });
    if (claim.count !== 1) {
      // Outro worker levou. Não é erro.
      continue;
    }
    result.claimed += 1;

    const event = await prisma.outboxEvent.findUnique({
      where: { id: candidate.id },
    });
    if (!event) continue;

    try {
      await handler({
        companyId: event.companyId,
        eventType: event.eventType,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        payload: event.payload,
      });
      await prisma.outboxEvent.update({
        where: { id: event.id },
        data: {
          status: "PROCESSED",
          processedAt: new Date(),
          lastError: null,
        },
      });
      result.processed += 1;
    } catch (error) {
      const exhausted = event.attempts >= OUTBOX_MAX_ATTEMPTS;
      await prisma.outboxEvent.update({
        where: { id: event.id },
        data: {
          status: exhausted ? "FAILED" : "PENDING",
          availableAt: exhausted
            ? event.availableAt
            : new Date(Date.now() + outboxBackoffMs(event.attempts)),
          lastError: sanitizeError(error),
        },
      });
      if (exhausted) {
        result.exhausted += 1;
      } else {
        result.failed += 1;
      }
    }
  }

  return result;
}

/**
 * Devolve um evento `FAILED` para a fila.
 *
 * Falha definitiva precisa ser **recuperável**, não só visível: depois de
 * corrigida a causa, alguém tem de conseguir reprocessar sem mexer no banco à
 * mão.
 */
export async function requeueFailedOutboxEvent(
  companyId: string,
  eventId: string,
): Promise<boolean> {
  const result = await prisma.outboxEvent.updateMany({
    where: { id: eventId, companyId, status: "FAILED" },
    data: {
      status: "PENDING",
      attempts: 0,
      availableAt: new Date(),
      lastError: null,
    },
  });
  return result.count === 1;
}
