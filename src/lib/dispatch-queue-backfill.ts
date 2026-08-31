import { prisma } from "./prisma";
import { dispatchRank } from "./dispatch-queue";
import type { ServiceOrderPriority } from "@prisma/client";

/**
 * # Backfill da fila operacional (DQ-2)
 *
 * Popula `TechnicianDispatchQueue` com as OS `ASSIGNED` que já existiam antes
 * da capability. Fica **fora da migration** de propósito: uma migration que
 * escreve linha de domínio esconde regra de negócio num lugar que ninguém
 * testa, e não pode ser reexecutada nem coberta por asserção.
 *
 * ## Idempotente por construção
 *
 * Rodar duas vezes não duplica, não reposiciona arbitrariamente e não gera
 * tempestade de `version`. A segunda execução compara o conjunto desejado com o
 * que já existe e só escreve a diferença.
 *
 * ## O que ele NÃO toca
 *
 * `priority`, `status`, `technicianId`, `origin`, identidade externa,
 * `scheduledAt` e `assignedAt` ficam exatamente como estão. O backfill só
 * escreve fila, entradas e posições.
 */

/** Só `ASSIGNED`. `IN_PROGRESS` fica fora da fila; terminais não têm fila. */
const BACKFILL_STATUS = "ASSIGNED" as const;

export interface BackfillResult {
  /** Filas criadas nesta execução. */
  queuesCreated: number;
  /** Filas que ganharam ou perderam entradas. */
  queuesChanged: number;
  /** Entradas criadas nesta execução. */
  entriesCreated: number;
  /** OS `ASSIGNED` examinadas. */
  ordersScanned: number;
}

interface Candidate {
  id: string;
  priority: ServiceOrderPriority;
  scheduledAt: Date | null;
  assignedAt: Date | null;
}

/**
 * A ordem determinística do backfill (`docs/DISPATCH-QUEUE.md` §13).
 *
 * ```text
 * 1. banda de precedência        explícita, NUNCA o ordinal do enum
 * 2. scheduledAt ASC NULLS LAST  quem tem hora marcada primeiro
 * 3. assignedAt ASC NULLS LAST   há quanto tempo está com este técnico
 * 4. id ASC                      desempate que nunca empata
 * ```
 *
 * `assignedAt` e não `createdAt` nem `number`: os dois últimos respondem há
 * quanto tempo a OS **existe**, e a pergunta da fila é há quanto tempo ela está
 * **com este técnico**. `number` seria `createdAt` com outro nome, já que é
 * sequencial de criação.
 *
 * Nulos vão para o fim da própria chave, nunca para uma posição implícita: sem
 * isso a ordem dependeria de como o banco devolveu as linhas, e duas execuções
 * do backfill em réplicas diferentes poderiam divergir.
 */
export function compareBackfillOrder(a: Candidate, b: Candidate): number {
  const byBand = dispatchRank(a.priority) - dispatchRank(b.priority);
  if (byBand !== 0) return byBand;

  const bySchedule = nullsLast(a.scheduledAt, b.scheduledAt);
  if (bySchedule !== 0) return bySchedule;

  const byAssigned = nullsLast(a.assignedAt, b.assignedAt);
  if (byAssigned !== 0) return byAssigned;

  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function nullsLast(a: Date | null, b: Date | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a.getTime() - b.getTime();
}

/**
 * Executa o backfill.
 *
 * Uma transação **por técnico**, e não uma para tudo: uma transação única
 * seguraria lock sobre a base inteira durante a varredura, e uma falha no
 * último técnico desfaria o trabalho dos anteriores sem necessidade — não há
 * invariante que atravesse dois técnicos.
 *
 * @param companyId opcional, para rodar empresa por empresa.
 */
export async function backfillDispatchQueues(
  companyId?: string,
): Promise<BackfillResult> {
  const result: BackfillResult = {
    queuesCreated: 0,
    queuesChanged: 0,
    entriesCreated: 0,
    ordersScanned: 0,
  };

  const orders = await prisma.serviceOrder.findMany({
    where: {
      status: BACKFILL_STATUS,
      technicianId: { not: null },
      ...(companyId ? { companyId } : {}),
    },
    select: {
      id: true,
      companyId: true,
      technicianId: true,
      priority: true,
      scheduledAt: true,
      assignedAt: true,
    },
  });
  result.ordersScanned = orders.length;

  // Agrupadas por (empresa, técnico): é o escopo da fila, e o da transação.
  const groups = new Map<string, { companyId: string; technicianId: string; items: Candidate[] }>();
  for (const order of orders) {
    if (!order.technicianId) continue;
    const key = `${order.companyId}::${order.technicianId}`;
    const group = groups.get(key) ?? {
      companyId: order.companyId,
      technicianId: order.technicianId,
      items: [],
    };
    group.items.push({
      id: order.id,
      priority: order.priority,
      scheduledAt: order.scheduledAt,
      assignedAt: order.assignedAt,
    });
    groups.set(key, group);
  }

  for (const group of Array.from(groups.values())) {
    const outcome = await backfillOne(
      group.companyId,
      group.technicianId,
      group.items,
    );
    if (outcome.queueCreated) result.queuesCreated += 1;
    if (outcome.changed) result.queuesChanged += 1;
    result.entriesCreated += outcome.entriesCreated;
  }

  return result;
}

async function backfillOne(
  companyId: string,
  technicianId: string,
  items: Candidate[],
): Promise<{ queueCreated: boolean; changed: boolean; entriesCreated: number }> {
  return prisma.$transaction(async (tx) => {
    const before = await tx.technicianDispatchQueue.findFirst({
      where: { companyId, technicianId },
      select: { id: true },
    });
    const queueCreated = before === null;

    await tx.technicianDispatchQueue.createMany({
      data: [{ companyId, technicianId }],
      skipDuplicates: true,
    });

    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "technician_dispatch_queues"
      WHERE "companyId" = ${companyId} AND "technicianId" = ${technicianId}
      FOR UPDATE
    `;
    const queueId = locked[0]?.id;
    if (!queueId) {
      return { queueCreated: false, changed: false, entriesCreated: 0 };
    }

    const existing = await tx.technicianDispatchQueueEntry.findMany({
      where: { queueId },
      select: { id: true, serviceOrderId: true, position: true },
    });
    const existingByOrder = new Map(existing.map((e) => [e.serviceOrderId, e]));

    const desired = [...items].sort(compareBackfillOrder);
    const missing = desired.filter((c) => !existingByOrder.has(c.id));

    /*
      A segunda execução costuma cair aqui: nada faltando e as posições já
      corretas. Sem escrita, sem `version` movida, sem evento.
    */
    const positionsAlreadyRight =
      missing.length === 0 &&
      existing.length === desired.length &&
      desired.every((c, i) => existingByOrder.get(c.id)?.position === i + 1);
    if (positionsAlreadyRight) {
      return { queueCreated, changed: false, entriesCreated: 0 };
    }

    // Fase 1 da reescrita: tira todas as posições do espaço positivo, para que
    // a unique `(queueId, position)` não colida na renumeração.
    await tx.$executeRaw`
      UPDATE "technician_dispatch_queue_entries"
      SET "position" = -"position"
      WHERE "queueId" = ${queueId}
    `;

    let offset = existing.length;
    for (const candidate of missing) {
      offset += 1;
      await tx.technicianDispatchQueueEntry.create({
        data: {
          companyId,
          queueId,
          serviceOrderId: candidate.id,
          position: -offset,
        },
      });
    }

    // Fase 2: as posições definitivas, num espaço positivo agora vazio.
    const all = await tx.technicianDispatchQueueEntry.findMany({
      where: { queueId },
      select: { id: true, serviceOrderId: true },
    });
    const idByOrder = new Map(all.map((e) => [e.serviceOrderId, e.id]));
    let position = 0;
    for (const candidate of desired) {
      const entryId = idByOrder.get(candidate.id);
      if (!entryId) continue;
      position += 1;
      await tx.technicianDispatchQueueEntry.update({
        where: { id: entryId },
        data: { position },
      });
    }

    /*
      `version` só se move numa fila que ALGUÉM PODERIA TER LIDO.

      Uma fila criada nesta execução nasce com o conteúdo dela: não houve
      mudança, houve criação, e ninguém tinha um token de CAS para invalidar.
      Já uma fila preexistente que ganhou uma OS mudou de verdade, e quem
      estivesse com a tela aberta precisa levar 409.
    */
    if (!queueCreated) {
      await tx.technicianDispatchQueue.update({
        where: { id: queueId },
        data: { version: { increment: 1 } },
      });
    }

    return { queueCreated, changed: true, entriesCreated: missing.length };
  });
}
