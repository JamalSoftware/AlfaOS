import { prisma } from "./prisma";
import {
  appendPositionForBand,
  dispatchRank,
  normalizeQueue,
  type QueueMember,
} from "./dispatch-queue";
import type { ServiceOrderPriority } from "@prisma/client";

/**
 * # Backfill da fila operacional (DQ-2)
 *
 * Popula `TechnicianDispatchQueue` com as OS `ASSIGNED` que já existiam antes
 * da capability. Fica **fora da migration** de propósito: uma migration que
 * escreve linha de domínio esconde regra de negócio num lugar que ninguém
 * testa, e não pode ser reexecutada nem coberta por asserção.
 *
 * ## Ele RECONCILIA, e não apenas completa (DQ-7.1, `BKF-01`)
 *
 * A pergunta não é "o que falta na fila?", é "o que a fila deveria ser?". A
 * primeira formulação ignora a entrada que **sobra**, e foi assim que uma OS
 * que deixou de ser `ASSIGNED` sobreviveu ao backfill com a posição negativa
 * da fase 1 da renumeração — `ORDER BY position ASC` a punha em primeiro, e a
 * fila aparecia com uma `-1ª` no topo.
 *
 * ```text
 * existente - elegível   → remover
 * elegível - existente   → acrescentar
 * interseção             → renumerar 1..N
 * ```
 *
 * ## A elegibilidade é lida sob o lock, não na varredura
 *
 * A varredura inicial responde **quem visitar**, e só isso. Quem decide o que
 * fica na fila é a leitura feita dentro da transação, **depois** do
 * `FOR UPDATE` — que é o que serializa o backfill contra `start`, `complete` e
 * `assign`. Uma OS que muda de estado entre a varredura e a escrita é vista
 * pela leitura autoritativa, nunca pela lista velha.
 *
 * ## Ele não é autoridade sobre uma fila já operada (DQ-7.2)
 *
 * ```text
 * BOOTSTRAP        fila que ainda não existe    banda → scheduledAt → assignedAt → id
 * RECONCILIAÇÃO    fila que já foi operada      preserva a ordem relativa dentro da banda
 * ```
 *
 * O backfill decide a ordem **inicial**. Depois disso quem decide a sequência
 * é o despacho — e um comando de manutenção que reescreve a decisão
 * operacional é pior que um comando que não roda. Ver [buildDesiredOrder].
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
  /** Entradas removidas por terem deixado de ser elegíveis (`BKF-01`). */
  entriesRemoved: number;
  /** OS `ASSIGNED` examinadas. */
  ordersScanned: number;
}

/** O desfecho da reconciliação de UMA fila. */
export interface ReconcileOutcome {
  queueCreated: boolean;
  changed: boolean;
  entriesCreated: number;
  entriesRemoved: number;
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
    entriesRemoved: 0,
    ordersScanned: 0,
  };

  /*
    As varreduras respondem QUEM visitar, e nada além disso.

    O que cada fila deve conter é decidido dentro da transação por técnico,
    sob o `FOR UPDATE` — ver `reconcileTechnicianQueue`. Antes da DQ-7.1 esta
    lista também era a autoridade sobre elegibilidade, e como ela é lida fora
    da transação, uma OS que saísse de `ASSIGNED` na janela era recriada como
    entrada: uma `IN_PROGRESS` de volta à fila de próximas, contra `I-06`.
  */
  const orders = await prisma.serviceOrder.findMany({
    where: {
      status: BACKFILL_STATUS,
      technicianId: { not: null },
      ...(companyId ? { companyId } : {}),
    },
    select: { id: true, companyId: true, technicianId: true },
  });
  result.ordersScanned = orders.length;

  // Agrupadas por (empresa, técnico): é o escopo da fila, e o da transação.
  const comOrdens = new Map<string, { companyId: string; technicianId: string }>();
  for (const order of orders) {
    if (!order.technicianId) continue;
    comOrdens.set(`${order.companyId}::${order.technicianId}`, {
      companyId: order.companyId,
      technicianId: order.technicianId,
    });
  }

  /*
    A SEGUNDA varredura, e a razão dela.

    Um técnico cuja fila só tem entrada obsoleta não aparece na varredura de
    OS — ele não tem nenhuma `ASSIGNED` —, e sem esta consulta a fila dele
    nunca seria visitada: a entrada morta sobreviveria a quantas execuções
    fossem. Reconciliar é responder pelo estado persistido, não só pelo
    estado desejado.
  */
  const filas = await prisma.technicianDispatchQueue.findMany({
    where: companyId ? { companyId } : {},
    select: { companyId: true, technicianId: true },
  });

  const alteradas = new Set<string>();
  const contabilizar = (
    chave: string,
    outcome: ReconcileOutcome,
  ): void => {
    if (outcome.queueCreated) result.queuesCreated += 1;
    if (outcome.changed) alteradas.add(chave);
    result.entriesCreated += outcome.entriesCreated;
    result.entriesRemoved += outcome.entriesRemoved;
  };

  /*
    PASSO 1 — PODA, antes de qualquer inserção.

    `serviceOrderId` é único no conjunto de entradas: uma OS está em UMA fila,
    nunca em duas. Uma OS reatribuída de A para B só cabe na fila de B depois
    de sair da de A, então a remoção precisa varrer TODAS as filas antes de a
    primeira inserção acontecer. Inverter os passos dá violação de unique — e
    foi assim que o teste de reatribuição encontrou este caminho.
  */
  for (const fila of filas) {
    const chave = `${fila.companyId}::${fila.technicianId}`;
    contabilizar(
      chave,
      await reconcileTechnicianQueue(fila.companyId, fila.technicianId, {
        insert: false,
      }),
    );
  }

  // PASSO 2 — o conteúdo definitivo, agora com o espaço livre.
  for (const target of Array.from(comOrdens.values())) {
    const chave = `${target.companyId}::${target.technicianId}`;
    contabilizar(
      chave,
      await reconcileTechnicianQueue(target.companyId, target.technicianId),
    );
  }

  result.queuesChanged = alteradas.size;
  return result;
}

/**
 * A ordem final da fila: o que já estava, do jeito que estava, mais o que falta.
 *
 * ## As duas regras, e por que são duas (DQ-7.2)
 *
 * ```text
 * BOOTSTRAP        fila que ainda não existe    banda → scheduledAt → assignedAt → id
 * RECONCILIAÇÃO    fila que já foi operada      preserva a ordem relativa dentro da banda
 * ```
 *
 * O backfill decide a ordem **inicial** de uma fila que nunca existiu. Depois
 * disso quem decide a sequência é o despacho, e um comando de manutenção que
 * reescreve a decisão operacional é pior que um comando que não roda: o
 * despachante ordenou a manhã do técnico, alguém rodou `dispatch:backfill`, e
 * a ordem voltou para uma regra determinística que não sabe de nada.
 *
 * ## Precedência continua sendo reparada
 *
 * Preservar a mão do despachante não é preservar estado inválido. Se o
 * persistido tiver uma `NORMAL` na frente de uma `URGENT` — prioridade
 * alterada fora do fluxo, dado antigo, importação —, a precedência é reposta.
 * Quem faz isso é [normalizeQueue], a **mesma** função que o serviço usa em
 * toda mutação de fila: a ordenação dela é estável, então repor a banda não
 * embaralha quem já estava dentro dela.
 *
 * Uma segunda implementação de precedência aqui seria uma segunda autoridade,
 * e as duas divergiriam na primeira vez que alguém ajustasse só uma.
 *
 * ## OS que trocou de banda por fora
 *
 * Ela vai para dentro da nova banda, no ponto que a posição persistida dela
 * implica. Numa fila coerente isso é o **fim** da banda de destino ao promover
 * — que é a regra normal de mudança de prioridade (`D-04`/`D-05`) —, porque a
 * posição global de quem estava numa banda mais fraca é maior que a de todas
 * as da banda mais forte.
 *
 * Não dá para fazer melhor sem inventar: a banda **anterior** não é
 * persistida, então "esta OS mudou de banda" não é uma pergunta que o estado
 * responda. Adivinhá-la por heurística seria exatamente a ordenação arbitrária
 * que esta fase existe para tirar do caminho.
 */
function buildDesiredOrder(
  existentesElegiveis: readonly { serviceOrderId: string; position: number }[],
  porOrdem: ReadonlyMap<string, Candidate>,
  faltantes: readonly Candidate[],
): Candidate[] {
  const prioridadeDe = (id: string): ServiceOrderPriority =>
    porOrdem.get(id)!.priority;

  // O que já está na fila, na ordem persistida, com a precedência reposta.
  let membros: QueueMember[] = normalizeQueue(
    existentesElegiveis.map((e) => ({
      serviceOrderId: e.serviceOrderId,
      priority: prioridadeDe(e.serviceOrderId),
      position: e.position,
    })),
  );

  /*
    Cada faltante entra no FIM da própria banda, uma de cada vez.

    `appendPositionForBand` é a mesma política de `placeAssignedOrder`: chegar
    depois não é ser mais importante, e a OS nova nunca desloca a ordem
    relativa de nenhuma outra.
  */
  for (const candidato of faltantes) {
    const at = appendPositionForBand(membros, candidato.priority);
    membros.splice(at - 1, 0, {
      serviceOrderId: candidato.id,
      priority: candidato.priority,
      position: at,
    });
    membros = membros.map((m, i) => ({ ...m, position: i + 1 }));
  }

  return membros.map((m) => porOrdem.get(m.serviceOrderId)!);
}

/**
 * Reconcilia a fila de UM técnico com o estado real das OS dele.
 *
 * ## A ordem das operações é a correção do `BKF-01`
 *
 * ```text
 * 1. trava a fila            FOR UPDATE
 * 2. lê a elegibilidade      DEPOIS do lock, e é ela que manda
 * 3. remove o que sobra      entrada cuja OS não é mais elegível
 * 4. acrescenta o que falta
 * 5. renumera 1..N
 * ```
 *
 * O passo 2 vir **depois** do passo 1 é o que fecha a janela de elegibilidade
 * obsoleta. `startServiceOrder` e `completeServiceOrder` mudam o status e
 * mexem na fila **na mesma transação**, então quem chega primeiro ao lock
 * decide a ordem dos fatos: se o backfill trava antes, ele lê `ASSIGNED`,
 * mantém a entrada e o `start` a remove logo depois; se o `start` trava antes,
 * o backfill lê `IN_PROGRESS` e não a recria. Os dois desfechos são corretos,
 * e nenhum deixa `IN_PROGRESS` na fila.
 *
 * ## Elegibilidade, por extenso
 *
 * `status = ASSIGNED` **e** `technicianId` = o dono desta fila **e** o mesmo
 * `companyId`, tudo em SQL. Os três predicados juntos: sem o segundo, uma OS
 * reatribuída sobreviveria na fila do técnico anterior; sem o terceiro, a
 * pergunta atravessaria tenant.
 *
 * Exportada porque é a unidade real de reconciliação — a varredura só decide
 * quem visitar, e testar a fila de um técnico não deveria exigir varrer a base.
 *
 * @param options.insert `false` só PODA: remove o que não é mais elegível e
 * renumera o que ficou, sem acrescentar nada. É o passo 1 do backfill, e ele
 * existe porque `serviceOrderId` é único entre entradas — uma OS reatribuída
 * precisa sair da fila antiga antes de caber na nova.
 */
export async function reconcileTechnicianQueue(
  companyId: string,
  technicianId: string,
  options: { insert?: boolean } = {},
): Promise<ReconcileOutcome> {
  const podeInserir = options.insert ?? true;
  const noop: ReconcileOutcome = {
    queueCreated: false,
    changed: false,
    entriesCreated: 0,
    entriesRemoved: 0,
  };

  return prisma.$transaction(async (tx) => {
    const before = await tx.technicianDispatchQueue.findFirst({
      where: { companyId, technicianId },
      select: { id: true },
    });
    const queueCreated = before === null;

    /*
      Fila inexistente e nada elegível: não há o que reconciliar, e criar uma
      fila vazia só porque a varredura passou por aqui seria escrever por
      escrever. Com algo elegível, a criação é a mesma que `placeAssignedOrder`
      faria — `createMany ... skipDuplicates`, tolerante a corrida.
    */
    if (queueCreated) {
      // A poda não cria fila: não há entrada obsoleta onde não há fila.
      if (!podeInserir) return noop;
      const elegiveis = await tx.serviceOrder.count({
        where: { companyId, technicianId, status: BACKFILL_STATUS },
      });
      if (elegiveis === 0) return noop;
    }

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
      return noop;
    }

    /*
      A LEITURA AUTORITATIVA. Tudo o que decide o conteúdo da fila sai daqui, e
      não da varredura que escolheu visitar este técnico.
    */
    const items = await tx.serviceOrder.findMany({
      where: { companyId, technicianId, status: BACKFILL_STATUS },
      select: {
        id: true,
        priority: true,
        scheduledAt: true,
        assignedAt: true,
      },
    });

    const existing = await tx.technicianDispatchQueueEntry.findMany({
      where: { queueId },
      select: { id: true, serviceOrderId: true, position: true },
    });
    const existingByOrder = new Map(existing.map((e) => [e.serviceOrderId, e]));

    const porOrdem = new Map(items.map((c) => [c.id, c]));
    const elegiveisIds = new Set(items.map((c) => c.id));
    // `existente - elegível`: concluída, iniciada, reatribuída ou desatribuída.
    const stale = existing.filter((e) => !elegiveisIds.has(e.serviceOrderId));

    /*
      Na poda, só o que JÁ está na fila entra no alvo. Fora dela, o conjunto
      elegível inteiro — e o que falta é ordenado pela regra de BOOTSTRAP.
    */
    const missing = podeInserir
      ? [...items]
          .filter((c) => !existingByOrder.has(c.id))
          .sort(compareBackfillOrder)
      : [];

    const desired = buildDesiredOrder(
      existing.filter((e) => elegiveisIds.has(e.serviceOrderId)),
      porOrdem,
      missing,
    );

    /*
      A segunda execução costuma cair aqui: nada faltando, nada sobrando e as
      posições já corretas. Sem escrita, sem `version` movida, sem evento.
    */
    const positionsAlreadyRight =
      missing.length === 0 &&
      stale.length === 0 &&
      existing.length === desired.length &&
      desired.every((c, i) => existingByOrder.get(c.id)?.position === i + 1);
    if (positionsAlreadyRight) {
      return { ...noop, queueCreated };
    }

    if (stale.length > 0) {
      await tx.technicianDispatchQueueEntry.deleteMany({
        where: { queueId, id: { in: stale.map((e) => e.id) } },
      });
    }

    // Fase 1 da reescrita: tira todas as posições do espaço positivo, para que
    // a unique `(queueId, position)` não colida na renumeração.
    await tx.$executeRaw`
      UPDATE "technician_dispatch_queue_entries"
      SET "position" = -"position"
      WHERE "queueId" = ${queueId}
    `;

    /*
      O espaço negativo das novas entradas começa DEPOIS da maior magnitude já
      negada, e não depois da contagem de sobreviventes.

      Remover a entrada da posição 1 de `[1, 2, 3]` deixa `-2` e `-3` vivos: um
      offset contado por sobreviventes (2) criaria a próxima em `-3` e
      colidiria com a unique `(queueId, position)`. A conta é sobre POSIÇÕES
      ocupadas, nunca sobre quantidade de linhas.
    */
    let offset = existing.reduce(
      (maior, e) => Math.max(maior, Math.abs(e.position)),
      existing.length,
    );
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

    /*
      A guarda que transforma um `BKF-01` futuro em falha, e não em fila torta.

      Posição não positiva só existe DENTRO desta transação, como espaço de
      manobra da fase 1. Se alguma sobreviver até aqui, houve entrada que a
      fase 2 não alcançou — exatamente o defeito original — e a transação
      inteira volta. Uma linha de contagem é barata; uma fila com `-1ª` no topo
      do despacho e do Field não é.
    */
    const naoNormalizadas = await tx.technicianDispatchQueueEntry.count({
      where: { queueId, position: { lte: 0 } },
    });
    if (naoNormalizadas > 0) {
      throw new Error(
        `dispatch-queue: ${naoNormalizadas} entrada(s) sem posição normalizada`,
      );
    }

    return {
      queueCreated,
      changed: true,
      entriesCreated: missing.length,
      entriesRemoved: stale.length,
    };
  });
}
