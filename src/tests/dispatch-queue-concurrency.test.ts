import { describe, it, expect, beforeEach } from "vitest";
import type { ServiceOrderPriority } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { DomainError } from "@/lib/errors";
import { assignTechnician, startServiceOrder } from "@/lib/service-orders";
import { dispatchRank } from "@/lib/dispatch-queue";
import {
  moveOrderToPosition,
  placeAssignedOrder,
  reapplyPriorityToQueue,
} from "@/lib/dispatch-queue-service";
import { seedTestData, type TestFixture } from "./helpers";

/**
 * # Fila operacional — concorrência (DQ-2, `T-C1`–`T-C5`)
 *
 * Corridas **reais**, com `Promise.allSettled`. Sequência rápida não prova nada
 * sobre concorrência: as duas transações precisam partir juntas para que o
 * `FOR UPDATE` e o CAS tenham o que arbitrar.
 *
 * As asserções PROÍBEM o desfecho ruim (`toBe(1)`), nunca o toleram
 * (`toBeGreaterThanOrEqual`). Um teste que aceita o defeito documenta o bug
 * como comportamento esperado.
 */

let fixture: TestFixture;
let techA1: { id: string; userId: string };
let techA2: { id: string; userId: string };

beforeEach(async () => {
  fixture = await seedTestData();
  techA1 = await prisma.technician.create({
    data: { companyId: fixture.companyA.id, userId: fixture.techA.id },
    select: { id: true, userId: true },
  });
  techA2 = await prisma.technician.create({
    data: { companyId: fixture.companyA.id, userId: fixture.techB.id },
    select: { id: true, userId: true },
  });
});

let seq = 0;

async function makeOrder(
  priority: ServiceOrderPriority,
): Promise<{ id: string; number: number }> {
  const companyId = fixture.companyA.id;
  const customer = await prisma.customer.create({
    data: { companyId, name: `Cliente ${(seq += 1)}` },
  });
  const counter = await prisma.serviceOrderCounter.upsert({
    where: { companyId },
    create: { companyId, lastNumber: 1 },
    update: { lastNumber: { increment: 1 } },
  });
  return prisma.serviceOrder.create({
    data: {
      companyId,
      customerId: customer.id,
      number: counter.lastNumber,
      type: "Instalação",
      description: "OS de teste",
      priority,
      status: "PENDING",
    },
    select: { id: true, number: true },
  });
}

async function assign(orderId: string, technicianId: string): Promise<void> {
  await assignTechnician(
    fixture.companyA.id,
    fixture.adminA.id,
    orderId,
    technicianId,
  );
}

interface QueueRow {
  position: number;
  serviceOrderId: string;
  priority: ServiceOrderPriority;
}

async function rowsOf(technicianId: string): Promise<QueueRow[]> {
  const queue = await prisma.technicianDispatchQueue.findFirst({
    where: { companyId: fixture.companyA.id, technicianId },
    select: { id: true },
  });
  if (!queue) return [];
  const entries = await prisma.technicianDispatchQueueEntry.findMany({
    where: { queueId: queue.id },
    select: {
      position: true,
      serviceOrderId: true,
      serviceOrder: { select: { priority: true } },
    },
    orderBy: { position: "asc" },
  });
  return entries.map((e) => ({
    position: e.position,
    serviceOrderId: e.serviceOrderId,
    priority: e.serviceOrder.priority,
  }));
}

async function versionOf(technicianId: string): Promise<number | null> {
  const queue = await prisma.technicianDispatchQueue.findFirst({
    where: { companyId: fixture.companyA.id, technicianId },
    select: { version: true },
  });
  return queue?.version ?? null;
}

/**
 * As duas invariantes que precisam valer depois de QUALQUER corrida.
 *
 * `I-11` é do banco (unique). `I-12` é da aplicação — foi o preço de `D-11`
 * ter escolhido posição global — e é por isso que ela é verificada aqui em
 * todo cenário, não só no dedicado.
 */
async function expectQueueIntact(technicianId: string): Promise<void> {
  const rows = await rowsOf(technicianId);

  // I-11 + contiguidade: 1..N, sem buraco e sem repetição.
  expect(rows.map((r) => r.position)).toEqual(
    Array.from({ length: rows.length }, (_, i) => i + 1),
  );

  // I-12: nenhuma banda mais fraca à frente de uma mais forte.
  const bands = rows.map((r) => dispatchRank(r.priority));
  expect(bands).toEqual([...bands].sort((a, b) => a - b));
}

function countFulfilled(results: PromiseSettledResult<unknown>[]): number {
  return results.filter((r) => r.status === "fulfilled").length;
}

function conflictsIn(results: PromiseSettledResult<unknown>[]): number {
  return results.filter(
    (r) =>
      r.status === "rejected" &&
      r.reason instanceof DomainError &&
      r.reason.status === 409,
  ).length;
}

// ---------------------------------------------------------------------------

describe("T-C1 · dois reorder simultâneos", () => {
  it("um passa, o outro leva 409, e nenhuma posição duplica", async () => {
    /*
      O cenário que justifica a fila ter `version` própria (PRD §318).

      Os dois despachantes movem OS DIFERENTES, então cada um carregaria a
      `version` correta da PRÓPRIA OS e passaria num CAS de `ServiceOrder`. O
      que os arbitra é o CAS da FILA, que ambos leram como 4.
    */
    const a = await makeOrder("NORMAL");
    const b = await makeOrder("NORMAL");
    const c = await makeOrder("NORMAL");
    const d = await makeOrder("NORMAL");
    for (const os of [a, b, c, d]) await assign(os.id, techA1.id);

    const lida = await versionOf(techA1.id);
    expect(lida).not.toBeNull();

    const mover = (serviceOrderId: string) =>
      prisma.$transaction((tx) =>
        moveOrderToPosition(tx, {
          companyId: fixture.companyA.id,
          technicianId: techA1.id,
          serviceOrderId,
          targetPosition: 1,
          expectedQueueVersion: lida as number,
        }),
      );

    const results = await Promise.allSettled([mover(c.id), mover(d.id)]);

    expect(countFulfilled(results)).toBe(1);
    expect(conflictsIn(results)).toBe(1);
    await expectQueueIntact(techA1.id);
    expect(await versionOf(techA1.id)).toBe((lida as number) + 1);
  });

  it("sem expectedQueueVersion, as duas passam — mas a fila continua íntegra", async () => {
    /*
      Chamada interna do servidor não tem leitura de tela para proteger, então
      não manda `expectedQueueVersion`. O `FOR UPDATE` continua serializando: a
      segunda só calcula depois da primeira ter gravado, e o resultado é uma
      ordem válida — nunca posição duplicada.
    */
    const a = await makeOrder("NORMAL");
    const b = await makeOrder("NORMAL");
    const c = await makeOrder("NORMAL");
    for (const os of [a, b, c]) await assign(os.id, techA1.id);

    const mover = (serviceOrderId: string) =>
      prisma.$transaction((tx) =>
        moveOrderToPosition(tx, {
          companyId: fixture.companyA.id,
          technicianId: techA1.id,
          serviceOrderId,
          targetPosition: 1,
        }),
      );

    const results = await Promise.allSettled([mover(b.id), mover(c.id)]);

    expect(countFulfilled(results)).toBe(2);
    await expectQueueIntact(techA1.id);
  });
});

describe("T-C2 · reorder + mudança de prioridade simultâneos", () => {
  it("o estado final é coerente, sem posição duplicada", async () => {
    const u1 = await makeOrder("URGENT");
    const n1 = await makeOrder("NORMAL");
    const n2 = await makeOrder("NORMAL");
    const n3 = await makeOrder("NORMAL");
    for (const os of [u1, n1, n2, n3]) await assign(os.id, techA1.id);

    const reorder = prisma.$transaction((tx) =>
      moveOrderToPosition(tx, {
        companyId: fixture.companyA.id,
        technicianId: techA1.id,
        serviceOrderId: n3.id,
        targetPosition: 1,
      }),
    );
    const promover = prisma.$transaction(async (tx) => {
      await tx.serviceOrder.update({
        where: { id: n1.id },
        data: { priority: "URGENT" },
      });
      return reapplyPriorityToQueue(tx, {
        companyId: fixture.companyA.id,
        technicianId: techA1.id,
        serviceOrderId: n1.id,
      });
    });

    const results = await Promise.allSettled([reorder, promover]);

    expect(countFulfilled(results)).toBe(2);
    await expectQueueIntact(techA1.id);

    // A promovida está entre as urgentes, qualquer que tenha sido a ordem.
    const rows = await rowsOf(techA1.id);
    const promovida = rows.find((r) => r.serviceOrderId === n1.id);
    expect(promovida?.priority).toBe("URGENT");
    expect(promovida?.position).toBeLessThanOrEqual(2);
  });
});

describe("T-C3 · reatribuição concorrente com reorder na fila de origem", () => {
  it("as duas filas terminam íntegras", async () => {
    const a1 = await makeOrder("NORMAL");
    const a2 = await makeOrder("NORMAL");
    const a3 = await makeOrder("NORMAL");
    for (const os of [a1, a2, a3]) await assign(os.id, techA1.id);

    const reatribuir = assign(a1.id, techA2.id);
    const reordenar = prisma.$transaction((tx) =>
      moveOrderToPosition(tx, {
        companyId: fixture.companyA.id,
        technicianId: techA1.id,
        serviceOrderId: a3.id,
        targetPosition: 1,
      }),
    );

    const results = await Promise.allSettled([reatribuir, reordenar]);

    // Nenhuma das duas pode corromper a fila, tenha qual desfecho tiver: a
    // reordenação pode achar a OS já fora se ela for a reatribuída.
    expect(results.filter((r) => r.status === "rejected").length).toBeLessThanOrEqual(1);
    await expectQueueIntact(techA1.id);
    await expectQueueIntact(techA2.id);

    const entradas = await prisma.technicianDispatchQueueEntry.count({
      where: { serviceOrderId: a1.id },
    });
    expect(entradas).toBe(1);
  });
});

describe("T-C4 · I-12 sob corrida", () => {
  it("nenhuma NORMAL termina à frente de uma URGENT", async () => {
    /*
      O teste que sustenta a decisão `D-11`.

      Com posição GLOBAL, nada no Postgres impede uma NORMAL na posição 1 — só
      o passo de ordenação estável da normalização impede. Aqui várias
      transações empurram normais para o topo ao mesmo tempo, e a invariante
      precisa valer no estado final de qualquer entrelaçamento.
    */
    const urgentes = [
      await makeOrder("URGENT"),
      await makeOrder("URGENT"),
    ];
    const normais = [
      await makeOrder("NORMAL"),
      await makeOrder("NORMAL"),
      await makeOrder("NORMAL"),
    ];
    for (const os of [...urgentes, ...normais]) await assign(os.id, techA1.id);

    const empurrar = (serviceOrderId: string) =>
      prisma.$transaction((tx) =>
        moveOrderToPosition(tx, {
          companyId: fixture.companyA.id,
          technicianId: techA1.id,
          serviceOrderId,
          targetPosition: 1,
        }),
      );

    await Promise.allSettled(normais.map((os) => empurrar(os.id)));

    const rows = await rowsOf(techA1.id);
    const primeiraNormal = rows.findIndex((r) => r.priority === "NORMAL");
    const ultimaUrgente = rows.map((r) => r.priority).lastIndexOf("URGENT");

    expect(primeiraNormal).toBeGreaterThan(ultimaUrgente);
    await expectQueueIntact(techA1.id);
  });
});

describe("T-C5 · A→B e B→A simultâneos", () => {
  it("não travam em deadlock permanente", async () => {
    /*
      Sem ordem determinística de lock, cada transação seguraria a fila que a
      outra espera e o Postgres mataria uma com `deadlock detected` — que chega
      ao despachante como falha aleatória. Travando por `id` crescente, as duas
      pegam a mesma primeira fila e a segunda espera.
    */
    const daA = await makeOrder("NORMAL");
    const daB = await makeOrder("NORMAL");
    await assign(daA.id, techA1.id);
    await assign(daB.id, techA2.id);

    const results = await Promise.allSettled([
      assign(daA.id, techA2.id),
      assign(daB.id, techA1.id),
    ]);

    const deadlocks = results.filter(
      (r) =>
        r.status === "rejected" &&
        String((r.reason as Error)?.message ?? "").toLowerCase().includes("deadlock"),
    );
    expect(deadlocks).toHaveLength(0);
    expect(countFulfilled(results)).toBe(2);

    await expectQueueIntact(techA1.id);
    await expectQueueIntact(techA2.id);
    expect(
      (await rowsOf(techA1.id)).map((r) => r.serviceOrderId),
    ).toEqual([daB.id]);
    expect(
      (await rowsOf(techA2.id)).map((r) => r.serviceOrderId),
    ).toEqual([daA.id]);
  });

  it("repetido, para descartar corrida que sempre resolve na mesma ordem", async () => {
    for (let rodada = 0; rodada < 3; rodada += 1) {
      const x = await makeOrder("NORMAL");
      const y = await makeOrder("NORMAL");
      await assign(x.id, techA1.id);
      await assign(y.id, techA2.id);

      const results = await Promise.allSettled([
        assign(x.id, techA2.id),
        assign(y.id, techA1.id),
      ]);
      expect(countFulfilled(results)).toBe(2);
      await expectQueueIntact(techA1.id);
      await expectQueueIntact(techA2.id);
    }
  });
});

// ---------------------------------------------------------------------------
// Cenários adicionais pedidos no escopo (§31 A–E)
// ---------------------------------------------------------------------------

describe("A · duas inserções concorrentes na mesma fila", () => {
  it("as duas entram, com posições distintas", async () => {
    const um = await makeOrder("NORMAL");
    const dois = await makeOrder("URGENT");

    const results = await Promise.allSettled([
      assign(um.id, techA1.id),
      assign(dois.id, techA1.id),
    ]);

    expect(countFulfilled(results)).toBe(2);
    const rows = await rowsOf(techA1.id);
    expect(rows).toHaveLength(2);
    await expectQueueIntact(techA1.id);
    // A urgente ficou na frente, qualquer que tenha sido a ordem de chegada.
    expect(rows[0].serviceOrderId).toBe(dois.id);
  });
});

describe("B · duas criações concorrentes da MESMA fila", () => {
  it("produzem uma fila só, sem erro não tratado", async () => {
    /*
      O caso que `createMany skipDuplicates` resolve: as duas transações veem
      "sem fila" e tentam criar. Um `upsert` ou um check-then-insert deixaria a
      segunda estourar na unique com um erro cru do Prisma.
    */
    const um = await makeOrder("NORMAL");
    const dois = await makeOrder("NORMAL");

    const results = await Promise.allSettled([
      assign(um.id, techA1.id),
      assign(dois.id, techA1.id),
    ]);

    expect(countFulfilled(results)).toBe(2);
    const filas = await prisma.technicianDispatchQueue.count({
      where: { companyId: fixture.companyA.id, technicianId: techA1.id },
    });
    expect(filas).toBe(1);
    await expectQueueIntact(techA1.id);
  });
});

describe("D · o mesmo par de filas em sentidos opostos, repetidas vezes", () => {
  it("nenhum deadlock em cinco rodadas", async () => {
    for (let rodada = 0; rodada < 5; rodada += 1) {
      const x = await makeOrder("NORMAL");
      const y = await makeOrder("URGENT");
      await assign(x.id, techA1.id);
      await assign(y.id, techA2.id);

      const results = await Promise.allSettled([
        prisma.$transaction((tx) =>
          placeAssignedOrder(tx, {
            companyId: fixture.companyA.id,
            technicianId: techA2.id,
            serviceOrderId: x.id,
          }),
        ),
        prisma.$transaction((tx) =>
          placeAssignedOrder(tx, {
            companyId: fixture.companyA.id,
            technicianId: techA1.id,
            serviceOrderId: y.id,
          }),
        ),
      ]);

      for (const r of results) {
        if (r.status === "rejected") {
          expect(String((r.reason as Error).message).toLowerCase()).not.toContain(
            "deadlock",
          );
        }
      }
      await expectQueueIntact(techA1.id);
      await expectQueueIntact(techA2.id);
    }
  });
});

describe("E · start concorrente com mutação da mesma fila", () => {
  it("a OS sai da fila e o restante fica íntegro", async () => {
    const a = await makeOrder("NORMAL");
    const b = await makeOrder("NORMAL");
    const c = await makeOrder("NORMAL");
    for (const os of [a, b, c]) await assign(os.id, techA1.id);

    const fresh = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: a.id },
      select: { version: true },
    });

    const results = await Promise.allSettled([
      startServiceOrder(fixture.companyA.id, techA1.userId, a.id, fresh.version),
      prisma.$transaction((tx) =>
        moveOrderToPosition(tx, {
          companyId: fixture.companyA.id,
          technicianId: techA1.id,
          serviceOrderId: c.id,
          targetPosition: 1,
        }),
      ),
    ]);

    // O `start` não pode falhar por causa de uma reordenação concorrente.
    expect(results[0].status).toBe("fulfilled");
    await expectQueueIntact(techA1.id);

    const ids = (await rowsOf(techA1.id)).map((r) => r.serviceOrderId);
    expect(ids).not.toContain(a.id);
    expect(ids).toHaveLength(2);
  });
});
