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

/**
 * Quanto tempo uma reivindicação vale.
 *
 * Cinco minutos: uma ordem de grandeza acima do envio normal — que é uma
 * chamada HTTP a um provider de push, medida em segundos — e curto o bastante
 * para que um worker morto não segure o evento por um turno inteiro.
 *
 * Curto demais e dois workers processam o mesmo evento porque o primeiro ainda
 * estava trabalhando. Longo demais e o crash de meio-dia só é recuperado à
 * noite. Não é configurável de propósito: uma constante que alguém lê no código
 * vale mais que um `.env` que ninguém sabe que existe.
 */
export const OUTBOX_LEASE_MS = 5 * 60 * 1000;

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
 * Predicado do que pode ser reivindicado AGORA.
 *
 * Duas situações, e a segunda é a que faltava:
 *
 * 1. `PENDING` cuja hora chegou — o caso normal.
 * 2. `PROCESSING` cujo **lease venceu** — o worker que o pegou morreu. Sem
 *    isto o evento ficava preso para sempre: nada mais procurava por
 *    `PROCESSING`, e `requeueFailedOutboxEvent` só aceita `FAILED`.
 *
 * A terceira cláusula é compatibilidade: linha reivindicada antes desta coluna
 * existir tem `leaseExpiresAt` nulo. A idade dela sai de `updatedAt`, que foi
 * escrito no momento da reivindicação — nenhum backfill é necessário, e uma
 * linha antiga presa deixa de ser eterna.
 */
function claimableWhere(now: Date) {
  const legacyCutoff = new Date(now.getTime() - OUTBOX_LEASE_MS);
  return {
    OR: [
      { status: "PENDING" as const, availableAt: { lte: now } },
      { status: "PROCESSING" as const, leaseExpiresAt: { lte: now } },
      {
        status: "PROCESSING" as const,
        leaseExpiresAt: null,
        updatedAt: { lte: legacyCutoff },
      },
    ],
  };
}

/**
 * Processa um lote. Devolve contagens — nunca conteúdo.
 *
 * A reivindicação é um `updateMany` cujo predicado é o MESMO da busca: o banco
 * serializa, exatamente um processo consegue trocar o estado, e os demais casam
 * zero linhas e seguem em frente. É o que permite rodar dois workers — ou um
 * cron que se sobrepôs ao anterior — sem entregar o mesmo push duas vezes.
 *
 * ## Semântica de entrega: at-least-once
 *
 * Um worker pode morrer DEPOIS de o provider aceitar a mensagem e ANTES de
 * marcar `PROCESSED`. Quando o lease vencer, o evento é reivindicado de novo e
 * a notificação sai outra vez.
 *
 * Isso é deliberado e não tem conserto barato: garantir exactly-once exigiria
 * transação distribuída com um provider de push que não a oferece. A escolha é
 * entre entregar duas vezes e perder — e perder um aviso de atribuição é pior.
 * O aplicativo precisa tolerar duplicata, o que é natural para push.
 */
export async function processOutboxBatch(
  handler: OutboxHandler,
  limit = 25,
  now: Date = new Date(),
): Promise<OutboxRunResult> {
  const candidates = await prisma.outboxEvent.findMany({
    where: claimableWhere(now),
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
      where: { id: candidate.id, ...claimableWhere(now) },
      data: {
        status: "PROCESSING",
        leaseExpiresAt: new Date(Date.now() + OUTBOX_LEASE_MS),
        attempts: { increment: 1 },
      },
    });
    if (claim.count !== 1) {
      // Outro worker levou, ou o lease dele ainda vale. Não é erro.
      continue;
    }
    result.claimed += 1;

    const event = await prisma.outboxEvent.findUnique({
      where: { id: candidate.id },
    });
    if (!event) continue;

    /*
      Teto também no caminho de RECLAIM.

      Uma falha normal já vira FAILED ao esgotar as tentativas, dentro do
      `catch`. Mas um worker que morre antes de chegar lá nunca executa esse
      trecho — sem esta guarda, um evento que derruba o processo seria
      reivindicado para sempre, a cada lease vencido, sem nunca parar.
    */
    if (event.attempts > OUTBOX_MAX_ATTEMPTS) {
      await prisma.outboxEvent.update({
        where: { id: event.id },
        data: {
          status: "FAILED",
          leaseExpiresAt: null,
          lastError: `Reivindicado ${event.attempts} vezes sem concluir.`,
        },
      });
      result.exhausted += 1;
      continue;
    }

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
          leaseExpiresAt: null,
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
          // O lease morre junto com a reivindicação: um evento que voltou para
          // PENDING é escolhido pela hora do backoff, não por lease vencido.
          leaseExpiresAt: null,
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
      leaseExpiresAt: null,
      lastError: null,
    },
  });
  return result.count === 1;
}
