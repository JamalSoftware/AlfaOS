import type { Prisma, ServiceOrderPriority } from "@prisma/client";
import { conflict, notFound } from "./errors";
import {
  appendPositionForBand,
  normalizeQueue,
  type QueueMember,
} from "./dispatch-queue";

/**
 * # Fila operacional de OS — serviço autoritativo (DQ-2)
 *
 * PRD Parte XII (§308–§332) e `docs/DISPATCH-QUEUE.md`.
 *
 * As primitivas puras vivem em `./dispatch-queue`; este arquivo persiste. A
 * separação é para valer: a precedência e a normalização precisam ser testáveis
 * sem Postgres, e misturar Prisma naquele arquivo arrastaria o banco para o
 * grafo de importação dos testes de domínio.
 *
 * ## Toda função recebe um `tx`
 *
 * Nenhuma abre transação própria — exceto o backfill, que não roda dentro de
 * nenhuma. É o mesmo contrato de `enqueueOutboxEvent` e de
 * `snapshotChecklistForOrder`: a fila é efeito de uma operação de OS, e precisa
 * commitar ou voltar **junto com ela**. Abrir uma transação aqui dentro
 * produziria o desfecho que a §156 do PRD proíbe — a OS atribuída sem entrada
 * de fila, ou a entrada sem a OS.
 *
 * ## O que este serviço NÃO faz
 *
 * Não autentica e não decide perfil. A autorização é da operação chamadora, que
 * já a tem (`assignTechnician` exige ADMIN/DISPATCHER na rota, `startServiceOrder`
 * resolve o técnico pelo token). Duplicar RBAC aqui criaria um segundo lugar
 * para ele divergir.
 *
 * O que este serviço **exige** é `companyId` autoritativo — vindo da sessão,
 * nunca do cliente — e o valida em toda leitura e escrita.
 */

/** Cliente de transação. Nunca `PrismaClient`: veja o cabeçalho. */
type Tx = Prisma.TransactionClient;

/** Estados que ocupam lugar na fila de próximas. */
const QUEUEABLE_STATUS = "ASSIGNED" as const;

/** O que uma mutação devolve, para o chamador saber se houve mudança real. */
export interface QueueMutationResult {
  queueId: string | null;
  /** `version` após a mutação. `null` quando não havia fila a tocar. */
  version: number | null;
  /** `false` quando a operação foi no-op — e então `version` não mudou. */
  changed: boolean;
}

const NO_CHANGE: QueueMutationResult = {
  queueId: null,
  version: null,
  changed: false,
};

// ---------------------------------------------------------------------------
// Fila: abertura e trava
// ---------------------------------------------------------------------------

/**
 * Abre (ou recupera) a fila do técnico e a **trava** para a transação.
 *
 * `createMany ... skipDuplicates` em vez de `upsert` ou de um check-then-insert:
 * duas atribuições simultâneas ao mesmo técnico que nunca teve fila colidiriam
 * na unique, e aqui a segunda simplesmente não insere nada. É o mesmo padrão que
 * `lockWorkday` usa na Jornada, e pela mesma razão.
 *
 * O `FOR UPDATE` é o que serializa requisição contra requisição: sem ele, duas
 * reordenações leem a mesma fila, calculam em cima do mesmo estado e a segunda
 * grava por cima da primeira sem que nenhum CAS perceba — porque cada uma
 * respondeu por uma OS e ninguém respondeu pela fila (PRD §318).
 *
 * O tenant vai no predicado do `SELECT`, não numa checagem posterior: buscar
 * por `technicianId` e conferir a empresa depois deixa a janela aberta.
 */
async function ensureAndLockQueue(
  tx: Tx,
  companyId: string,
  technicianId: string,
): Promise<{ id: string; version: number }> {
  await ensureQueueRow(tx, companyId, technicianId);
  return lockQueueByTechnician(tx, companyId, technicianId);
}

/**
 * Garante que a linha da fila existe, **sem travar**.
 *
 * Separado do lock de propósito: quem toca duas filas precisa descobrir os dois
 * `id` antes de travar qualquer um deles, para poder travar na ordem certa.
 * Travar primeiro e ordenar depois é o mesmo que não ordenar.
 */
async function ensureQueueRow(
  tx: Tx,
  companyId: string,
  technicianId: string,
): Promise<string> {
  await assertTechnicianOfCompany(tx, companyId, technicianId);

  await tx.technicianDispatchQueue.createMany({
    data: [{ companyId, technicianId }],
    skipDuplicates: true,
  });

  const queue = await tx.technicianDispatchQueue.findFirst({
    where: { companyId, technicianId },
    select: { id: true },
  });
  if (!queue) {
    throw conflict("Não foi possível abrir a fila do técnico. Tente de novo.");
  }
  return queue.id;
}

async function lockQueueByTechnician(
  tx: Tx,
  companyId: string,
  technicianId: string,
): Promise<{ id: string; version: number }> {
  const rows = await tx.$queryRaw<{ id: string; version: number }[]>`
    SELECT "id", "version" FROM "technician_dispatch_queues"
    WHERE "companyId" = ${companyId} AND "technicianId" = ${technicianId}
    FOR UPDATE
  `;
  const row = rows[0];
  if (!row) {
    // Só acontece se a linha sumir entre o insert e o lock, o que exigiria
    // exclusão concorrente — que nenhum caminho do produto faz.
    throw conflict("Não foi possível abrir a fila do técnico. Tente de novo.");
  }
  return row;
}

async function lockQueueById(
  tx: Tx,
  companyId: string,
  queueId: string,
): Promise<{ id: string; version: number } | null> {
  const rows = await tx.$queryRaw<{ id: string; version: number }[]>`
    SELECT "id", "version" FROM "technician_dispatch_queues"
    WHERE "id" = ${queueId} AND "companyId" = ${companyId}
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

/**
 * Trava as filas envolvidas em ordem determinística de `id`.
 *
 * É o que impede o deadlock evitável: `A→B` e `B→A` simultâneos travariam em
 * ordem oposta, cada transação segurando o que a outra espera, e o Postgres
 * mataria uma delas com `deadlock detected` — um erro que chega ao despachante
 * como falha aleatória. Ordenando por `id`, as duas pegam a mesma primeira
 * fila e a segunda espera.
 *
 * Os `SELECT` saem separados de propósito: um único `ORDER BY ... FOR UPDATE`
 * depende do plano de execução preservar a ordenação antes de travar, o que o
 * Postgres não garante.
 */
async function lockQueuesInOrder(
  tx: Tx,
  companyId: string,
  queueIds: string[],
): Promise<Map<string, { id: string; version: number }>> {
  const locked = new Map<string, { id: string; version: number }>();
  for (const id of Array.from(new Set(queueIds)).sort()) {
    const row = await lockQueueById(tx, companyId, id);
    if (row) locked.set(id, row);
  }
  return locked;
}

// ---------------------------------------------------------------------------
// Tenancy
// ---------------------------------------------------------------------------

/**
 * O risco residual que a DQ-1 registrou e não podia fechar no schema.
 *
 * Sem FK composta — que o projeto não usa em lugar nenhum — nada no banco
 * obriga `queue.companyId` a concordar com `technician.companyId`. Fechar isso
 * é obrigação desta camada, e é por isso que **nenhuma** função pública daqui
 * aceita um `technicianId` sem passar por aqui primeiro.
 *
 * Devolve 404, não 403: confirmar que o técnico existe em outra empresa é
 * enumeração.
 */
async function assertTechnicianOfCompany(
  tx: Tx,
  companyId: string,
  technicianId: string,
): Promise<void> {
  const technician = await tx.technician.findFirst({
    where: { id: technicianId, companyId },
    select: { id: true },
  });
  if (!technician) {
    throw notFound("Técnico não encontrado nesta empresa.");
  }
}

// ---------------------------------------------------------------------------
// Leitura e escrita das posições
// ---------------------------------------------------------------------------

interface EntryRow {
  id: string;
  serviceOrderId: string;
  position: number;
  priority: ServiceOrderPriority;
}

/**
 * As entradas da fila, com a prioridade lida da própria OS.
 *
 * A prioridade **não** é copiada para a entrada. Duplicá-la criaria dois
 * valores obrigados a concordar para sempre, e o dia em que divergissem a fila
 * ordenaria por um dado obsoleto sem ninguém notar (PRD §309).
 */
async function loadEntries(tx: Tx, queueId: string): Promise<EntryRow[]> {
  const rows = await tx.technicianDispatchQueueEntry.findMany({
    where: { queueId },
    select: {
      id: true,
      serviceOrderId: true,
      position: true,
      serviceOrder: { select: { priority: true } },
    },
    orderBy: { position: "asc" },
  });
  return rows.map((r) => ({
    id: r.id,
    serviceOrderId: r.serviceOrderId,
    position: r.position,
    priority: r.serviceOrder.priority,
  }));
}

/**
 * Reescreve as posições em duas fases, por causa da unique `(queueId, position)`.
 *
 * A escrita ingênua — `1→2`, `2→3`, … — colide: a unique não é `DEFERRABLE`, e
 * o Postgres a confere no momento de cada linha, então o primeiro `UPDATE` já
 * bate na linha que ainda ocupa o destino.
 *
 * ```text
 * fase 1   position = -position      todas de uma vez, num UPDATE só
 * fase 2   position = 1..N           o espaço positivo está vazio
 * ```
 *
 * A negação é injetiva sobre inteiros positivos e o espaço negativo está
 * sempre vazio fora desta função, então a fase 1 não pode colidir com nada. A
 * fase 2 escreve valores distintos num espaço agora livre.
 *
 * Foi preferida a apagar tudo e recriar: aquilo descartaria o `id` de cada
 * entrada a cada reordenação, e tornaria inútil qualquer referência futura a
 * `TechnicianDispatchQueueEntry.id`.
 *
 * @returns `true` se alguma posição de fato mudou.
 */
async function writePositions(
  tx: Tx,
  queueId: string,
  current: readonly EntryRow[],
  desired: readonly QueueMember[],
): Promise<boolean> {
  const currentById = new Map(current.map((e) => [e.serviceOrderId, e]));
  const moves = desired.filter(
    (d) => currentById.get(d.serviceOrderId)?.position !== d.position,
  );
  // Nada mudou: não escreve, e o chamador não incrementa `version`. Releitura
  // idêntica não pode mover o token de CAS de ninguém.
  if (moves.length === 0) return false;

  await tx.$executeRaw`
    UPDATE "technician_dispatch_queue_entries"
    SET "position" = -"position"
    WHERE "queueId" = ${queueId}
  `;

  for (const member of desired) {
    const entry = currentById.get(member.serviceOrderId);
    if (!entry) continue;
    await tx.technicianDispatchQueueEntry.update({
      where: { id: entry.id },
      data: { position: member.position },
    });
  }
  return true;
}

/** Incrementa o token de CAS da fila. Só é chamado quando houve mudança real. */
async function bumpVersion(tx: Tx, queueId: string): Promise<number> {
  const updated = await tx.technicianDispatchQueue.update({
    where: { id: queueId },
    data: { version: { increment: 1 } },
    select: { version: true },
  });
  return updated.version;
}

/**
 * Normaliza a fila inteira e grava. O coração de toda mutação.
 *
 * A normalização é a função pura da DQ-1, e é ela que reestabelece `I-12`
 * (urgente antes de normal) — a única invariante desta capability que o banco
 * não defende sozinho, porque `D-11` escolheu posição global.
 */
async function normalizeAndWrite(
  tx: Tx,
  queueId: string,
  intent?: { serviceOrderId: string; targetPosition: number },
): Promise<boolean> {
  const current = await loadEntries(tx, queueId);
  const desired = normalizeQueue(current, intent);
  return writePositions(tx, queueId, current, desired);
}

// ---------------------------------------------------------------------------
// Operações de ciclo de vida
// ---------------------------------------------------------------------------

/**
 * Coloca uma OS `ASSIGNED` na fila do técnico, tirando-a da anterior se houver.
 *
 * Cobre atribuição e reatribuição na **mesma unidade transacional** — nunca em
 * duas requisições, e nunca com um estado intermediário em que a OS está nas
 * duas filas ou em nenhuma (PRD §317). A unique em `serviceOrderId` é a rede:
 * se a remoção falhar, a inserção não acontece e a transação inteira volta.
 *
 * Idempotente: se a OS já está na fila certa, não cria segunda entrada, não a
 * move e não incrementa `version`.
 *
 * A posição inicial é o **fim da própria banda** — chegar depois não é ser mais
 * importante, e uma `URGENT` nova não ultrapassa as urgentes que o despachante
 * já ordenou (PRD §317).
 */
export async function placeAssignedOrder(
  tx: Tx,
  input: {
    companyId: string;
    technicianId: string;
    serviceOrderId: string;
  },
): Promise<QueueMutationResult> {
  const { companyId, technicianId, serviceOrderId } = input;

  const order = await tx.serviceOrder.findFirst({
    where: { id: serviceOrderId, companyId },
    select: { id: true, priority: true, status: true, technicianId: true },
  });
  if (!order) {
    throw notFound("Ordem de serviço não encontrada.");
  }
  // Só `ASSIGNED` ocupa lugar na fila de próximas. `IN_PROGRESS` fica fora por
  // decisão de produto (PRD §321), e os terminais não têm fila.
  if (order.status !== QUEUEABLE_STATUS) {
    return NO_CHANGE;
  }

  /*
    ORDEM DOS LOCKS — o ponto mais delicado desta função.

    Os dois `id` são descobertos ANTES de qualquer `FOR UPDATE`, e só então as
    filas são travadas em ordem crescente de `id`. Travar a de destino primeiro
    e ordenar depois não adianta nada: `A→B` e `B→A` simultâneos pegariam a
    primeira em ordem oposta e o Postgres mataria uma com `deadlock detected`.

    (Isto foi um defeito real desta implementação, encontrado pelo teste `T-C5`
    antes de sair daqui.)
  */
  const targetId = await ensureQueueRow(tx, companyId, technicianId);

  // Onde a OS está AGORA. Leitura sem lock, só para descobrir o que travar; o
  // tenant vai no predicado, nunca navegando a FK até a fila.
  const before = await tx.technicianDispatchQueueEntry.findFirst({
    where: { companyId, serviceOrderId },
    select: { queueId: true },
  });

  const locked = await lockQueuesInOrder(
    tx,
    companyId,
    before ? [before.queueId, targetId] : [targetId],
  );
  const target = locked.get(targetId);
  if (!target) {
    throw conflict("Não foi possível abrir a fila do técnico. Tente de novo.");
  }

  // Releitura SOB o lock: entre a descoberta e a trava, outra requisição pode
  // ter movido a OS.
  const existing = await tx.technicianDispatchQueueEntry.findFirst({
    where: { companyId, serviceOrderId },
    select: { id: true, queueId: true },
  });

  if (existing && !locked.has(existing.queueId)) {
    /*
      A OS foi para uma TERCEIRA fila entre a descoberta e o lock. Travá-la
      agora seria fora de ordem, que é exatamente o que produz deadlock — então
      a resposta honesta é recusar e deixar o chamador reler.

      Exige três reatribuições concorrentes da mesma OS para acontecer.
    */
    throw conflict(
      "A OS foi reatribuída por outra requisição. Recarregue e tente novamente.",
    );
  }

  if (existing?.queueId === target.id) {
    // Já está na fila certa. Não move e não mexe no `version` — releitura
    // idêntica não pode invalidar o CAS de quem está com a tela aberta.
    return { queueId: target.id, version: target.version, changed: false };
  }

  if (existing) {
    const source = locked.get(existing.queueId);
    if (source) {
      await tx.technicianDispatchQueueEntry.deleteMany({
        where: { id: existing.id, companyId },
      });
      await normalizeAndWrite(tx, source.id);
      await bumpVersion(tx, source.id);
    }
  }

  const members = await loadEntries(tx, target.id);
  const at = appendPositionForBand(members, order.priority);

  await tx.technicianDispatchQueueEntry.create({
    data: {
      companyId,
      queueId: target.id,
      serviceOrderId,
      // Posição temporária fora do espaço em uso: a normalização logo abaixo
      // decide a definitiva, e um valor positivo aqui colidiria com a unique.
      position: -(members.length + 1),
    },
  });
  await normalizeAndWrite(tx, target.id, {
    serviceOrderId,
    targetPosition: at,
  });
  const version = await bumpVersion(tx, target.id);

  return { queueId: target.id, version, changed: true };
}

/**
 * Tira uma OS da fila e renormaliza. **No-op seguro** quando ela não está lá.
 *
 * Chamada por `startServiceOrder` (a OS saiu para atendimento) e por
 * `completeServiceOrder` (onde normalmente já não há entrada — e por isso a
 * ausência não pode falhar a conclusão).
 *
 * A fila é achada pela ENTRADA, não pelo `technicianId` da OS: se as duas
 * discordarem por algum estado inconsistente, renormalizar sob o lock errado
 * seria pior que renormalizar a fila certa.
 */
export async function removeOrderFromQueue(
  tx: Tx,
  input: { companyId: string; serviceOrderId: string },
): Promise<QueueMutationResult> {
  const { companyId, serviceOrderId } = input;

  const existing = await tx.technicianDispatchQueueEntry.findFirst({
    where: { companyId, serviceOrderId },
    select: { id: true, queueId: true },
  });
  if (!existing) return NO_CHANGE;

  const queue = await lockQueueById(tx, companyId, existing.queueId);
  if (!queue) return NO_CHANGE;

  // Releitura SOB o lock: entre a busca e a trava, outra transação pode ter
  // removido a mesma entrada. Apagar zero linhas aqui é desfecho normal.
  const deleted = await tx.technicianDispatchQueueEntry.deleteMany({
    where: { id: existing.id, companyId },
  });
  if (deleted.count === 0) {
    return { queueId: queue.id, version: queue.version, changed: false };
  }

  await normalizeAndWrite(tx, queue.id);
  const version = await bumpVersion(tx, queue.id);
  return { queueId: queue.id, version, changed: true };
}

// ---------------------------------------------------------------------------
// Operações de despacho — primitivas, sem rota (as rotas são DQ-3)
// ---------------------------------------------------------------------------

/**
 * Move uma OS para uma posição absoluta na fila do próprio técnico.
 *
 * **Alvo absoluto, nunca delta.** "Subir uma posição" aplicada duas vezes sobe
 * duas, e retry de rede transformaria uma correção em duas (PRD §318).
 *
 * `expectedQueueVersion` é opcional aqui porque esta primitiva também serve a
 * chamadas internas do servidor, que não vêm de uma leitura de tela. Quando
 * vem de um despachante — o caso da DQ-3 — ela é obrigatória, e é o que
 * transforma "reordenar sobre uma tela de dez minutos atrás" em 409 em vez de
 * sobrescrita silenciosa.
 *
 * A precedência não é violável: uma `NORMAL` pedindo a posição 1 é **acomodada**
 * no topo da banda dela, não recusada. Recusar faria o cartão voltar sozinho na
 * tela, que se lê como travamento (PRD §204).
 */
export async function moveOrderToPosition(
  tx: Tx,
  input: {
    companyId: string;
    technicianId: string;
    serviceOrderId: string;
    targetPosition: number;
    expectedQueueVersion?: number;
  },
): Promise<QueueMutationResult> {
  const {
    companyId,
    technicianId,
    serviceOrderId,
    targetPosition,
    expectedQueueVersion,
  } = input;

  const queue = await ensureAndLockQueue(tx, companyId, technicianId);
  assertExpectedVersion(queue.version, expectedQueueVersion);

  // Membership: a OS tem de estar NESTA fila, desta empresa. Sem isto, um id
  // de outra fila viraria uma reordenação silenciosa que não muda nada.
  const entry = await tx.technicianDispatchQueueEntry.findFirst({
    where: { companyId, serviceOrderId, queueId: queue.id },
    select: { id: true },
  });
  if (!entry) {
    throw notFound("Ordem de serviço não está na fila deste técnico.");
  }

  const changed = await normalizeAndWrite(tx, queue.id, {
    serviceOrderId,
    targetPosition,
  });
  if (!changed) {
    return { queueId: queue.id, version: queue.version, changed: false };
  }
  return {
    queueId: queue.id,
    version: await bumpVersion(tx, queue.id),
    changed: true,
  };
}

/**
 * Recoloca na fila uma OS cuja prioridade mudou.
 *
 * O chamador grava a nova `priority` na `ServiceOrder` **antes**; esta função
 * relê do banco e recoloca no fim da banda nova. É a mesma regra nos dois
 * sentidos, promoção e rebaixamento (`D-04`, `D-05`), e é a única que não
 * altera a ordem relativa de nenhuma outra OS — quem quiser outra posição usa
 * [moveOrderToPosition].
 *
 * Não tem rota: a mutação administrativa de prioridade é DQ-3.
 */
export async function reapplyPriorityToQueue(
  tx: Tx,
  input: {
    companyId: string;
    technicianId: string;
    serviceOrderId: string;
    expectedQueueVersion?: number;
  },
): Promise<QueueMutationResult> {
  const { companyId, technicianId, serviceOrderId, expectedQueueVersion } =
    input;

  const queue = await ensureAndLockQueue(tx, companyId, technicianId);
  assertExpectedVersion(queue.version, expectedQueueVersion);

  const members = await loadEntries(tx, queue.id);
  const moved = members.find((m) => m.serviceOrderId === serviceOrderId);
  if (!moved) return { queueId: queue.id, version: queue.version, changed: false };

  // O fim da banda é calculado SEM a própria OS: incluí-la contaria a si
  // mesma e deixaria a promovida uma posição adiante do que deveria.
  const others = members.filter((m) => m.serviceOrderId !== serviceOrderId);
  const at = appendPositionForBand(others, moved.priority);

  const changed = await normalizeAndWrite(tx, queue.id, {
    serviceOrderId,
    targetPosition: at,
  });
  if (!changed) {
    return { queueId: queue.id, version: queue.version, changed: false };
  }
  return {
    queueId: queue.id,
    version: await bumpVersion(tx, queue.id),
    changed: true,
  };
}

/**
 * O compare-and-set da FILA.
 *
 * Responde a pergunta que o `FOR UPDATE` não responde: o `FOR UPDATE` serializa
 * requisição contra requisição, mas não sabe que a tela de quem está agindo foi
 * lida antes da mudança de outra pessoa. Os dois são necessários (PRD §318).
 */
function assertExpectedVersion(actual: number, expected?: number): void {
  if (expected !== undefined && expected !== actual) {
    throw conflict(
      "A fila foi alterada por outra requisição. Recarregue e tente novamente.",
    );
  }
}

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------

export interface DispatchQueueSnapshot {
  queueId: string | null;
  version: number;
  queued: { serviceOrderId: string; position: number }[];
}

/** A fila de um técnico, escopada por tenant. Sem fila ainda é fila vazia. */
export async function readDispatchQueue(
  tx: Tx,
  companyId: string,
  technicianId: string,
): Promise<DispatchQueueSnapshot> {
  await assertTechnicianOfCompany(tx, companyId, technicianId);

  const queue = await tx.technicianDispatchQueue.findFirst({
    where: { companyId, technicianId },
    select: { id: true, version: true },
  });
  if (!queue) return { queueId: null, version: 0, queued: [] };

  const entries = await loadEntries(tx, queue.id);
  return {
    queueId: queue.id,
    version: queue.version,
    queued: entries.map((e) => ({
      serviceOrderId: e.serviceOrderId,
      position: e.position,
    })),
  };
}
