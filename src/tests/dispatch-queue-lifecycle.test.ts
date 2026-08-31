import { describe, it, expect, beforeEach } from "vitest";
import type { ServiceOrderPriority } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { DomainError } from "@/lib/errors";
import { assignTechnician, startServiceOrder } from "@/lib/service-orders";
import { completeServiceOrder } from "@/lib/service-order-closing";
import { updateServiceOrderExecution } from "@/lib/service-orders";
import {
  moveOrderToPosition,
  placeAssignedOrder,
  reapplyPriorityToQueue,
  removeOrderFromQueue,
} from "@/lib/dispatch-queue-service";
import { backfillDispatchQueues } from "@/lib/dispatch-queue-backfill";
import { seedTestData, type TestFixture } from "./helpers";

/**
 * # Fila operacional — ciclo de vida e backfill (DQ-2)
 *
 * Contra Postgres real. O alvo aqui são os HOOKS: a fila é efeito das operações
 * de OS que já existiam, e o que estes testes provam é que ela acompanha
 * `assign`, `start` e `complete` sem que nenhuma delas tenha ganhado caminho
 * próprio.
 *
 * Corridas ficam em `dispatch-queue-concurrency.test.ts`; precedência pura, em
 * `dispatch-queue-domain.test.ts`.
 */

let fixture: TestFixture;
let techA1: { id: string; userId: string };
let techA2: { id: string; userId: string };
let techB1: { id: string };

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
  techB1 = await prisma.technician.create({
    data: { companyId: fixture.companyB.id, userId: fixture.adminB.id },
    select: { id: true },
  });
});

let seq = 0;

/** OS `PENDING` sem técnico, direto no banco: o alvo é o hook, não a criação. */
async function makeOrder(
  priority: ServiceOrderPriority,
  options: { companyId?: string; scheduledAt?: Date | null } = {},
): Promise<{ id: string; number: number }> {
  const companyId = options.companyId ?? fixture.companyA.id;
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
      scheduledAt: options.scheduledAt ?? null,
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

/** A fila do técnico como pares `[posição, número da OS]`, em ordem. */
async function queueOf(technicianId: string): Promise<[number, number][]> {
  const queue = await prisma.technicianDispatchQueue.findFirst({
    where: { companyId: fixture.companyA.id, technicianId },
    select: { id: true },
  });
  if (!queue) return [];
  const entries = await prisma.technicianDispatchQueueEntry.findMany({
    where: { queueId: queue.id },
    select: { position: true, serviceOrder: { select: { number: true } } },
    orderBy: { position: "asc" },
  });
  return entries.map((e) => [e.position, e.serviceOrder.number]);
}

async function versionOf(technicianId: string): Promise<number | null> {
  const queue = await prisma.technicianDispatchQueue.findFirst({
    where: { companyId: fixture.companyA.id, technicianId },
    select: { version: true },
  });
  return queue?.version ?? null;
}

/** Só as posições, para afirmar contiguidade sem depender dos números. */
function positionsOf(queue: [number, number][]): number[] {
  return queue.map(([p]) => p);
}

async function expectDomainError(
  fn: () => Promise<unknown>,
  status: number,
): Promise<void> {
  try {
    await fn();
    expect.unreachable("a operação deveria ter falhado");
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).status).toBe(status);
  }
}

// ---------------------------------------------------------------------------

describe("T-I1 · atribuir insere no fim da banda", () => {
  it("agrupa por banda e numera 1..N", async () => {
    const normal1 = await makeOrder("NORMAL");
    const urgente1 = await makeOrder("URGENT");
    const baixa1 = await makeOrder("LOW");
    const alta1 = await makeOrder("HIGH");

    for (const os of [normal1, urgente1, baixa1, alta1]) {
      await assign(os.id, techA1.id);
    }

    expect(await queueOf(techA1.id)).toEqual([
      [1, urgente1.number],
      [2, alta1.number],
      [3, normal1.number],
      [4, baixa1.number],
    ]);
  });

  it("a fila nasce ao atribuir, não no cadastro do técnico", async () => {
    // Criação preguiçosa: técnico sem OS não gera linha.
    expect(await versionOf(techA1.id)).toBeNull();
    const os = await makeOrder("NORMAL");
    await assign(os.id, techA1.id);
    expect(await versionOf(techA1.id)).toBe(1);
  });
});

describe("T-I2 · URGENT nova não ultrapassa as urgentes já ordenadas", () => {
  it("entra no fim do bloco urgente", async () => {
    const u1 = await makeOrder("URGENT");
    const u2 = await makeOrder("URGENT");
    await assign(u1.id, techA1.id);
    await assign(u2.id, techA1.id);

    const u3 = await makeOrder("URGENT");
    await assign(u3.id, techA1.id);

    // Chegar depois não é ser mais importante.
    expect(await queueOf(techA1.id)).toEqual([
      [1, u1.number],
      [2, u2.number],
      [3, u3.number],
    ]);
  });
});

describe("T-I3 · iniciar remove da fila e renormaliza", () => {
  it("a OS sai e as demais fecham o buraco", async () => {
    const a = await makeOrder("NORMAL");
    const b = await makeOrder("NORMAL");
    const c = await makeOrder("NORMAL");
    for (const os of [a, b, c]) await assign(os.id, techA1.id);

    const fresh = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: b.id },
      select: { version: true },
    });
    await startServiceOrder(
      fixture.companyA.id,
      techA1.userId,
      b.id,
      fresh.version,
    );

    expect(await queueOf(techA1.id)).toEqual([
      [1, a.number],
      [2, c.number],
    ]);
  });

  it("IN_PROGRESS fica FORA da fila, e a OS continua sendo a fonte de verdade", async () => {
    const a = await makeOrder("URGENT");
    await assign(a.id, techA1.id);
    const fresh = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: a.id },
      select: { version: true },
    });
    await startServiceOrder(
      fixture.companyA.id,
      techA1.userId,
      a.id,
      fresh.version,
    );

    expect(await queueOf(techA1.id)).toEqual([]);
    const order = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: a.id },
      select: { status: true },
    });
    // Nenhuma "fila de trabalho atual" paralela: o status é quem diz (PRD §321).
    expect(order.status).toBe("IN_PROGRESS");
  });

  it("mais de uma IN_PROGRESS continua permitida", async () => {
    const a = await makeOrder("NORMAL");
    const b = await makeOrder("NORMAL");
    for (const os of [a, b]) await assign(os.id, techA1.id);

    for (const os of [a, b]) {
      const fresh = await prisma.serviceOrder.findUniqueOrThrow({
        where: { id: os.id },
        select: { version: true },
      });
      await startServiceOrder(
        fixture.companyA.id,
        techA1.userId,
        os.id,
        fresh.version,
      );
    }

    const emAtendimento = await prisma.serviceOrder.count({
      where: { technicianId: techA1.id, status: "IN_PROGRESS" },
    });
    // A fila NÃO endureceu a máquina de estados (D-08).
    expect(emAtendimento).toBe(2);
    expect(await queueOf(techA1.id)).toEqual([]);
  });
});

describe("T-I4 · concluir mantém a OS fora da fila", () => {
  it("a conclusão não falha por ausência de entrada", async () => {
    const a = await makeOrder("NORMAL");
    const b = await makeOrder("NORMAL");
    for (const os of [a, b]) await assign(os.id, techA1.id);

    const beforeStart = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: a.id },
      select: { version: true },
    });
    const started = await startServiceOrder(
      fixture.companyA.id,
      techA1.userId,
      a.id,
      beforeStart.version,
    );
    const saved = await updateServiceOrderExecution(
      fixture.companyA.id,
      techA1.userId,
      a.id,
      started.execution.version,
      { diagnosis: "d", workPerformed: "w" },
    );
    const fresh = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: a.id },
      select: { version: true },
    });

    // A entrada já saiu no `start`: a limpeza aqui é NO-OP, e não pode falhar.
    await completeServiceOrder(fixture.companyA.id, techA1.userId, a.id, {
      expectedOrderVersion: fresh.version,
      expectedExecutionVersion: saved.version,
    });

    expect(await queueOf(techA1.id)).toEqual([[1, b.number]]);
  });

  it("uma entrada residual é limpa pela conclusão", async () => {
    /*
      Estado que os invariantes não produzem, mas que dado anterior à
      capability pode ter. Simulado escrevendo a entrada à mão depois do
      `start` — se ela sobrevivesse ao fechamento, apareceria na fila de
      amanhã como OS a fazer.
    */
    const a = await makeOrder("NORMAL");
    await assign(a.id, techA1.id);
    const beforeStart = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: a.id },
      select: { version: true },
    });
    const started = await startServiceOrder(
      fixture.companyA.id,
      techA1.userId,
      a.id,
      beforeStart.version,
    );

    const queue = await prisma.technicianDispatchQueue.findFirstOrThrow({
      where: { companyId: fixture.companyA.id, technicianId: techA1.id },
      select: { id: true },
    });
    await prisma.technicianDispatchQueueEntry.create({
      data: {
        companyId: fixture.companyA.id,
        queueId: queue.id,
        serviceOrderId: a.id,
        position: 1,
      },
    });

    const saved = await updateServiceOrderExecution(
      fixture.companyA.id,
      techA1.userId,
      a.id,
      started.execution.version,
      { diagnosis: "d", workPerformed: "w" },
    );
    const fresh = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: a.id },
      select: { version: true },
    });
    await completeServiceOrder(fixture.companyA.id, techA1.userId, a.id, {
      expectedOrderVersion: fresh.version,
      expectedExecutionVersion: saved.version,
    });

    expect(await queueOf(techA1.id)).toEqual([]);
  });
});

describe("T-I5 · reatribuir move entre as filas", () => {
  it("sai de A, entra em B, e as duas ficam normalizadas", async () => {
    const a1 = await makeOrder("NORMAL");
    const a2 = await makeOrder("NORMAL");
    const a3 = await makeOrder("NORMAL");
    for (const os of [a1, a2, a3]) await assign(os.id, techA1.id);

    const b1 = await makeOrder("URGENT");
    await assign(b1.id, techA2.id);

    await assign(a2.id, techA2.id);

    expect(await queueOf(techA1.id)).toEqual([
      [1, a1.number],
      [2, a3.number],
    ]);
    expect(await queueOf(techA2.id)).toEqual([
      [1, b1.number],
      [2, a2.number],
    ]);
  });

  it("a OS nunca fica nas duas filas", async () => {
    const os = await makeOrder("NORMAL");
    await assign(os.id, techA1.id);
    await assign(os.id, techA2.id);

    const entries = await prisma.technicianDispatchQueueEntry.count({
      where: { serviceOrderId: os.id },
    });
    expect(entries).toBe(1);
  });

  it("colocar de novo na MESMA fila é no-op e não move version", async () => {
    /*
      Testado na primitiva, e não por `assignTechnician`: a rota recusa antes,
      com 409 "A OS já está atribuída a este técnico" — guarda que já existia e
      que este teste não deve contornar.

      A idempotência importa porque `placeAssignedOrder` roda dentro de uma
      transação que pode ser retentada, e porque releitura idêntica não pode
      invalidar o CAS de quem está com a tela aberta (§16).
    */
    const os = await makeOrder("NORMAL");
    await assign(os.id, techA1.id);
    const antes = await versionOf(techA1.id);

    const result = await prisma.$transaction((tx) =>
      placeAssignedOrder(tx, {
        companyId: fixture.companyA.id,
        technicianId: techA1.id,
        serviceOrderId: os.id,
      }),
    );

    expect(result.changed).toBe(false);
    expect(await versionOf(techA1.id)).toBe(antes);
    const entries = await prisma.technicianDispatchQueueEntry.count({
      where: { serviceOrderId: os.id },
    });
    expect(entries).toBe(1);
  });
});

describe("T-I6 · mudança de prioridade recoloca na banda", () => {
  it("NORMAL → URGENT vai para o fim das urgentes", async () => {
    const u1 = await makeOrder("URGENT");
    const u2 = await makeOrder("URGENT");
    const n1 = await makeOrder("NORMAL");
    const n2 = await makeOrder("NORMAL");
    for (const os of [u1, u2, n1, n2]) await assign(os.id, techA1.id);

    await prisma.$transaction(async (tx) => {
      await tx.serviceOrder.update({
        where: { id: n2.id },
        data: { priority: "URGENT" },
      });
      await reapplyPriorityToQueue(tx, {
        companyId: fixture.companyA.id,
        technicianId: techA1.id,
        serviceOrderId: n2.id,
      });
    });

    expect(await queueOf(techA1.id)).toEqual([
      [1, u1.number],
      [2, u2.number],
      [3, n2.number],
      [4, n1.number],
    ]);
  });

  it("URGENT → NORMAL desce para o fim das normais", async () => {
    const u1 = await makeOrder("URGENT");
    const u2 = await makeOrder("URGENT");
    const n1 = await makeOrder("NORMAL");
    for (const os of [u1, u2, n1]) await assign(os.id, techA1.id);

    await prisma.$transaction(async (tx) => {
      await tx.serviceOrder.update({
        where: { id: u1.id },
        data: { priority: "NORMAL" },
      });
      await reapplyPriorityToQueue(tx, {
        companyId: fixture.companyA.id,
        technicianId: techA1.id,
        serviceOrderId: u1.id,
      });
    });

    expect(await queueOf(techA1.id)).toEqual([
      [1, u2.number],
      [2, n1.number],
      [3, u1.number],
    ]);
  });
});

describe("reordenação — a unique não colide na renumeração", () => {
  it("mover 4→1 termina em 1,2,3,4 sem violar a unique", async () => {
    /*
      A escrita ingênua (`1→2`, `2→3`, …) bateria na unique `(queueId,
      position)`, que não é DEFERRABLE. A implementação nega todas as posições
      num UPDATE só e depois reescreve o espaço positivo, agora vazio.
    */
    const a = await makeOrder("NORMAL");
    const b = await makeOrder("NORMAL");
    const c = await makeOrder("NORMAL");
    const d = await makeOrder("NORMAL");
    for (const os of [a, b, c, d]) await assign(os.id, techA1.id);

    await prisma.$transaction((tx) =>
      moveOrderToPosition(tx, {
        companyId: fixture.companyA.id,
        technicianId: techA1.id,
        serviceOrderId: d.id,
        targetPosition: 1,
      }),
    );

    const fila = await queueOf(techA1.id);
    expect(fila).toEqual([
      [1, d.number],
      [2, a.number],
      [3, b.number],
      [4, c.number],
    ]);
    expect(positionsOf(fila)).toEqual([1, 2, 3, 4]);
  });

  it("uma NORMAL pedindo a posição 1 é acomodada, não recusada", async () => {
    const u = await makeOrder("URGENT");
    const n1 = await makeOrder("NORMAL");
    const n2 = await makeOrder("NORMAL");
    for (const os of [u, n1, n2]) await assign(os.id, techA1.id);

    const result = await prisma.$transaction((tx) =>
      moveOrderToPosition(tx, {
        companyId: fixture.companyA.id,
        technicianId: techA1.id,
        serviceOrderId: n2.id,
        targetPosition: 1,
      }),
    );

    expect(result.changed).toBe(true);
    expect(await queueOf(techA1.id)).toEqual([
      [1, u.number],
      [2, n2.number],
      [3, n1.number],
    ]);
  });

  it("expectedQueueVersion obsoleta recusa com 409", async () => {
    const a = await makeOrder("NORMAL");
    const b = await makeOrder("NORMAL");
    for (const os of [a, b]) await assign(os.id, techA1.id);

    const atual = await versionOf(techA1.id);
    await expectDomainError(
      () =>
        prisma.$transaction((tx) =>
          moveOrderToPosition(tx, {
            companyId: fixture.companyA.id,
            technicianId: techA1.id,
            serviceOrderId: b.id,
            targetPosition: 1,
            expectedQueueVersion: (atual ?? 0) - 1,
          }),
        ),
      409,
    );
  });

  it("mover para onde já está é no-op e não move version", async () => {
    const a = await makeOrder("NORMAL");
    const b = await makeOrder("NORMAL");
    for (const os of [a, b]) await assign(os.id, techA1.id);
    const antes = await versionOf(techA1.id);

    const result = await prisma.$transaction((tx) =>
      moveOrderToPosition(tx, {
        companyId: fixture.companyA.id,
        technicianId: techA1.id,
        serviceOrderId: a.id,
        targetPosition: 1,
      }),
    );

    expect(result.changed).toBe(false);
    expect(await versionOf(techA1.id)).toBe(antes);
  });
});

describe("tenancy — o risco residual da DQ-1, fechado no serviço", () => {
  it("empresa A não alcança técnico da empresa B, e NÃO cria fila cruzada", async () => {
    /*
      A asserção que importa é a segunda.

      O 404 sozinho passa pelo motivo errado: sem a validação de tenant, o
      serviço chegaria a `ensureQueueRow`, criaria uma fila com o `companyId`
      de A apontando para o técnico de B — a inconsistência exata que a DQ-1
      registrou como risco residual do schema — e só então devolveria 404 no
      teste de membership da OS. Erro certo, dado corrompido.

      Provado por reversão: remover `assertTechnicianOfCompany` deixa o 404 de
      pé e faz a contagem abaixo virar 1.
    */
    await expectDomainError(
      () =>
        prisma.$transaction((tx) =>
          moveOrderToPosition(tx, {
            companyId: fixture.companyA.id,
            technicianId: techB1.id,
            serviceOrderId: "qualquer",
            targetPosition: 1,
          }),
        ),
      404,
    );

    const cruzadas = await prisma.technicianDispatchQueue.count({
      where: { technicianId: techB1.id },
    });
    expect(cruzadas).toBe(0);
  });

  it("colocar OS de A na fila de um técnico de B é recusado, e nada é gravado", async () => {
    /*
      Este é o ataque que a rollback da transação NÃO esconde.

      No caminho de `moveOrderToPosition` a operação termina em 404 de qualquer
      jeito, e a transação inteira volta — então a fila cruzada nunca persiste,
      e o teste passa mesmo sem validação de tenant. Aqui não: `placeAssignedOrder`
      **concluiria com sucesso**, gravando uma fila com `companyId` de A
      apontando para um técnico de B, e commitando. É exatamente a inconsistência
      que a DQ-1 registrou como risco residual do schema.

      Provado por reversão: sem `assertTechnicianOfCompany`, a chamada passa e a
      contagem vira 1.
    */
    const os = await makeOrder("NORMAL");
    await prisma.serviceOrder.update({
      where: { id: os.id },
      data: { status: "ASSIGNED" },
    });

    await expectDomainError(
      () =>
        prisma.$transaction((tx) =>
          placeAssignedOrder(tx, {
            companyId: fixture.companyA.id,
            technicianId: techB1.id,
            serviceOrderId: os.id,
          }),
        ),
      404,
    );

    const cruzadas = await prisma.technicianDispatchQueue.count({
      where: { technicianId: techB1.id },
    });
    expect(cruzadas).toBe(0);
    const entradas = await prisma.technicianDispatchQueueEntry.count({
      where: { serviceOrderId: os.id },
    });
    expect(entradas).toBe(0);
  });

  it("o backfill não cria fila cruzada nem por engano", async () => {
    // Controle: toda fila criada tem de concordar com a empresa do técnico.
    const os = await makeOrder("NORMAL");
    await assign(os.id, techA1.id);

    const filas = await prisma.technicianDispatchQueue.findMany({
      select: { companyId: true, technician: { select: { companyId: true } } },
    });
    expect(filas.length).toBeGreaterThan(0);
    for (const fila of filas) {
      expect(fila.companyId).toBe(fila.technician.companyId);
    }
  });

  it("OS de outra empresa não entra na fila", async () => {
    const ordemB = await makeOrder("NORMAL", { companyId: fixture.companyB.id });
    await expectDomainError(
      () =>
        prisma.$transaction((tx) =>
          moveOrderToPosition(tx, {
            companyId: fixture.companyA.id,
            technicianId: techA1.id,
            serviceOrderId: ordemB.id,
            targetPosition: 1,
          }),
        ),
      404,
    );
  });

  it("OS da própria empresa mas de OUTRA fila é recusada", async () => {
    const os = await makeOrder("NORMAL");
    await assign(os.id, techA1.id);

    // Membership: estar na empresa certa não basta, tem de estar NESTA fila.
    await expectDomainError(
      () =>
        prisma.$transaction((tx) =>
          moveOrderToPosition(tx, {
            companyId: fixture.companyA.id,
            technicianId: techA2.id,
            serviceOrderId: os.id,
            targetPosition: 1,
          }),
        ),
      404,
    );
  });

  it("remover com o tenant errado é no-op, não remoção", async () => {
    const os = await makeOrder("NORMAL");
    await assign(os.id, techA1.id);

    const result = await prisma.$transaction((tx) =>
      removeOrderFromQueue(tx, {
        companyId: fixture.companyB.id,
        serviceOrderId: os.id,
      }),
    );

    expect(result.changed).toBe(false);
    // Controle positivo: a entrada continua lá para o dono legítimo.
    expect(await queueOf(techA1.id)).toEqual([[1, os.number]]);
  });
});

describe("T-I7 · backfill produz a ordem especificada", () => {
  it("ordena por banda, agendamento, atribuição e id", async () => {
    const cedo = new Date("2026-08-30T09:00:00.000Z");
    const tarde = new Date("2026-08-30T15:00:00.000Z");

    const n_semHora = await makeOrder("NORMAL");
    const n_tarde = await makeOrder("NORMAL", { scheduledAt: tarde });
    const n_cedo = await makeOrder("NORMAL", { scheduledAt: cedo });
    const urgente = await makeOrder("URGENT");

    // Atribuídas direto no banco, SEM o hook: é o estado anterior à capability.
    for (const os of [n_semHora, n_tarde, n_cedo, urgente]) {
      await prisma.serviceOrder.update({
        where: { id: os.id },
        data: {
          technicianId: techA1.id,
          status: "ASSIGNED",
          assignedAt: new Date(),
        },
      });
    }
    expect(await queueOf(techA1.id)).toEqual([]);

    const result = await backfillDispatchQueues(fixture.companyA.id);

    expect(result.queuesCreated).toBe(1);
    expect(result.entriesCreated).toBe(4);
    expect(await queueOf(techA1.id)).toEqual([
      [1, urgente.number],
      [2, n_cedo.number],
      [3, n_tarde.number],
      [4, n_semHora.number],
    ]);
  });

  it("ignora IN_PROGRESS, COMPLETED e OS sem técnico", async () => {
    const semTecnico = await makeOrder("NORMAL");
    const emAtendimento = await makeOrder("NORMAL");
    await prisma.serviceOrder.update({
      where: { id: emAtendimento.id },
      data: { technicianId: techA1.id, status: "IN_PROGRESS" },
    });
    const atribuida = await makeOrder("NORMAL");
    await prisma.serviceOrder.update({
      where: { id: atribuida.id },
      data: { technicianId: techA1.id, status: "ASSIGNED" },
    });

    await backfillDispatchQueues(fixture.companyA.id);

    expect(await queueOf(techA1.id)).toEqual([[1, atribuida.number]]);
    void semTecnico;
  });

  it("não altera nenhum campo da OS", async () => {
    const os = await makeOrder("NORMAL", {
      scheduledAt: new Date("2026-09-01T10:00:00.000Z"),
    });
    await prisma.serviceOrder.update({
      where: { id: os.id },
      data: { technicianId: techA1.id, status: "ASSIGNED" },
    });
    const antes = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: os.id },
    });

    await backfillDispatchQueues(fixture.companyA.id);

    const depois = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: os.id },
    });
    expect(depois).toEqual(antes);
  });
});

describe("T-I8 · backfill é idempotente", () => {
  it("a segunda execução não duplica nem move version", async () => {
    const a = await makeOrder("NORMAL");
    const b = await makeOrder("URGENT");
    for (const os of [a, b]) {
      await prisma.serviceOrder.update({
        where: { id: os.id },
        data: { technicianId: techA1.id, status: "ASSIGNED" },
      });
    }

    const primeira = await backfillDispatchQueues(fixture.companyA.id);
    const filaDepoisDa1 = await queueOf(techA1.id);
    const versionDepoisDa1 = await versionOf(techA1.id);

    const segunda = await backfillDispatchQueues(fixture.companyA.id);

    expect(primeira.entriesCreated).toBe(2);
    expect(segunda.entriesCreated).toBe(0);
    expect(segunda.queuesChanged).toBe(0);
    expect(await queueOf(techA1.id)).toEqual(filaDepoisDa1);
    // Sem tempestade de version: releitura idêntica não escreve (§28, §29).
    expect(await versionOf(techA1.id)).toBe(versionDepoisDa1);
  });

  it("fila criada pelo backfill nasce em version 0", async () => {
    /*
      `version` é token de CAS: conta as mudanças que alguém PODERIA ter lido.
      Uma fila criada agora, com o conteúdo dela, não mudou — foi criada, e
      ninguém tinha token para invalidar.
    */
    const os = await makeOrder("NORMAL");
    await prisma.serviceOrder.update({
      where: { id: os.id },
      data: { technicianId: techA1.id, status: "ASSIGNED" },
    });

    await backfillDispatchQueues(fixture.companyA.id);
    expect(await versionOf(techA1.id)).toBe(0);
  });

  it("uma OS nova entre execuções é completada, e AÍ version anda", async () => {
    const a = await makeOrder("NORMAL");
    await prisma.serviceOrder.update({
      where: { id: a.id },
      data: { technicianId: techA1.id, status: "ASSIGNED" },
    });
    await backfillDispatchQueues(fixture.companyA.id);
    expect(await versionOf(techA1.id)).toBe(0);

    const b = await makeOrder("URGENT");
    await prisma.serviceOrder.update({
      where: { id: b.id },
      data: { technicianId: techA1.id, status: "ASSIGNED" },
    });

    const segunda = await backfillDispatchQueues(fixture.companyA.id);

    expect(segunda.entriesCreated).toBe(1);
    expect(await queueOf(techA1.id)).toEqual([
      [1, b.number],
      [2, a.number],
    ]);
    // Fila preexistente que mudou de verdade: quem tinha a tela aberta leva 409.
    expect(await versionOf(techA1.id)).toBe(1);
  });

  it("não vaza entre empresas", async () => {
    const daA = await makeOrder("NORMAL");
    await prisma.serviceOrder.update({
      where: { id: daA.id },
      data: { technicianId: techA1.id, status: "ASSIGNED" },
    });
    const daB = await makeOrder("NORMAL", { companyId: fixture.companyB.id });
    await prisma.serviceOrder.update({
      where: { id: daB.id },
      data: { technicianId: techB1.id, status: "ASSIGNED" },
    });

    await backfillDispatchQueues(fixture.companyA.id);

    const filasB = await prisma.technicianDispatchQueue.count({
      where: { companyId: fixture.companyB.id },
    });
    expect(filasB).toBe(0);
  });
});
