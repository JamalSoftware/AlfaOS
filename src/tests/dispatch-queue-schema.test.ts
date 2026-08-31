import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { seedTestData, type TestFixture } from "./helpers";

/**
 * # Fila operacional — invariantes de BANCO (DQ-1)
 *
 * Contra Postgres real, porque é o Postgres que precisa ser o árbitro.
 *
 * Estas quatro uniques são o motivo de a fila existir como agregado próprio em
 * vez de uma coluna `dispatchPosition` na `ServiceOrder`. Cada teste aqui
 * corresponde a uma delas, e nenhum passa por validação de aplicação: a escrita
 * é direta no Prisma, sem serviço no caminho, justamente para provar que a
 * garantia é do banco.
 *
 * `I-12` (urgente precede normal) **não** está aqui, e é deliberado: a decisão
 * `D-11` escolheu posição global, e com ela essa invariante virou regra de
 * aplicação. Ela é testada em `dispatch-queue-domain.test.ts`.
 */

let fixture: TestFixture;

/**
 * Técnicos reais. `fixture.techA` é um `User`, não um `Technician` — o seed não
 * cria a linha de técnico, cada teste cria a que precisa.
 */
let techA1: { id: string };
let techA2: { id: string };
let techB1: { id: string };

beforeEach(async () => {
  fixture = await seedTestData();
  techA1 = await prisma.technician.create({
    data: { companyId: fixture.companyA.id, userId: fixture.techA.id },
  });
  techA2 = await prisma.technician.create({
    data: { companyId: fixture.companyA.id, userId: fixture.techB.id },
  });
  techB1 = await prisma.technician.create({
    data: { companyId: fixture.companyB.id, userId: fixture.adminB.id },
  });
});

/** Um técnico da empresa A, com fila. */
async function queueForTechA() {
  return prisma.technicianDispatchQueue.create({
    data: { companyId: fixture.companyA.id, technicianId: techA1.id },
  });
}

/** Cria uma OS mínima direto no banco — o serviço de OS não é o alvo aqui. */
async function orderFor(companyId: string, technicianId: string | null) {
  const customer = await prisma.customer.create({
    data: { companyId, name: `Cliente ${crypto.randomUUID().slice(0, 8)}` },
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
      technicianId,
      number: counter.lastNumber,
      type: "Instalação",
      description: "OS de teste da fila",
      status: technicianId ? "ASSIGNED" : "PENDING",
    },
  });
}

describe("A. uma fila por (empresa, técnico)", () => {
  it("recusa a segunda fila do mesmo técnico na mesma empresa", async () => {
    await queueForTechA();
    await expect(
      prisma.technicianDispatchQueue.create({
        data: { companyId: fixture.companyA.id, technicianId: techA1.id },
      }),
    ).rejects.toThrow();
  });

  it("recusa a segunda fila do mesmo técnico mesmo sob OUTRA empresa", async () => {
    /*
      O caso que a unique composta sozinha NÃO cobriria.

      `(companyId, technicianId)` aceita duas linhas se o companyId diferir — e
      nada no schema obriga `queue.companyId` a concordar com
      `technician.companyId`, porque o projeto não usa FK composta em lugar
      nenhum. A unique em `technicianId` fecha exatamente esse buraco.
    */
    await queueForTechA();
    await expect(
      prisma.technicianDispatchQueue.create({
        data: { companyId: fixture.companyB.id, technicianId: techA1.id },
      }),
    ).rejects.toThrow();
  });
});

describe("B. a mesma OS não fica em duas filas", () => {
  it("recusa a segunda entrada para a mesma OS", async () => {
    /*
      É esta unique que torna a reatribuição segura POR CONSTRUÇÃO: inserir na
      fila de B antes de remover da de A falha no banco, em vez de produzir uma
      OS que aparece nas duas.
    */
    const queueA = await queueForTechA();
    const queueB = await prisma.technicianDispatchQueue.create({
      data: { companyId: fixture.companyA.id, technicianId: techA2.id },
    });
    const order = await orderFor(fixture.companyA.id, techA1.id);

    await prisma.technicianDispatchQueueEntry.create({
      data: {
        companyId: fixture.companyA.id,
        queueId: queueA.id,
        serviceOrderId: order.id,
        position: 1,
      },
    });

    await expect(
      prisma.technicianDispatchQueueEntry.create({
        data: {
          companyId: fixture.companyA.id,
          queueId: queueB.id,
          serviceOrderId: order.id,
          position: 1,
        },
      }),
    ).rejects.toThrow();
  });
});

describe("C. I-11 — sem posição duplicada na mesma fila", () => {
  it("recusa duas entradas na mesma posição", async () => {
    const queue = await queueForTechA();
    const um = await orderFor(fixture.companyA.id, techA1.id);
    const dois = await orderFor(fixture.companyA.id, techA1.id);

    await prisma.technicianDispatchQueueEntry.create({
      data: {
        companyId: fixture.companyA.id,
        queueId: queue.id,
        serviceOrderId: um.id,
        position: 1,
      },
    });

    await expect(
      prisma.technicianDispatchQueueEntry.create({
        data: {
          companyId: fixture.companyA.id,
          queueId: queue.id,
          serviceOrderId: dois.id,
          position: 1,
        },
      }),
    ).rejects.toThrow();
  });

  it("recusa a colisão mesmo sob corrida real", async () => {
    // Sequência rápida não prova nada sobre concorrência: as duas escritas
    // partem juntas, e quem arbitra é o índice.
    const queue = await queueForTechA();
    const um = await orderFor(fixture.companyA.id, techA1.id);
    const dois = await orderFor(fixture.companyA.id, techA1.id);

    const write = (serviceOrderId: string) =>
      prisma.technicianDispatchQueueEntry.create({
        data: {
          companyId: fixture.companyA.id,
          queueId: queue.id,
          serviceOrderId,
          position: 1,
        },
      });

    const results = await Promise.allSettled([write(um.id), write(dois.id)]);
    const ok = results.filter((r) => r.status === "fulfilled");

    // Proíbe o desfecho ruim (`toBe(1)`), não o tolera.
    expect(ok).toHaveLength(1);
    await expect(
      prisma.technicianDispatchQueueEntry.count({
        where: { queueId: queue.id, position: 1 },
      }),
    ).resolves.toBe(1);
  });
});

describe("D. a mesma posição existe em filas diferentes", () => {
  it("aceita position 1 em duas filas", async () => {
    // Controle positivo da unique de C: se este teste falhasse, a restrição
    // estaria larga demais e a fila de um técnico limitaria a do outro.
    const queueA = await queueForTechA();
    const queueB = await prisma.technicianDispatchQueue.create({
      data: { companyId: fixture.companyA.id, technicianId: techA2.id },
    });
    const um = await orderFor(fixture.companyA.id, techA1.id);
    const dois = await orderFor(fixture.companyA.id, techA2.id);

    await prisma.technicianDispatchQueueEntry.create({
      data: {
        companyId: fixture.companyA.id,
        queueId: queueA.id,
        serviceOrderId: um.id,
        position: 1,
      },
    });
    await prisma.technicianDispatchQueueEntry.create({
      data: {
        companyId: fixture.companyA.id,
        queueId: queueB.id,
        serviceOrderId: dois.id,
        position: 1,
      },
    });

    await expect(
      prisma.technicianDispatchQueueEntry.count({ where: { position: 1 } }),
    ).resolves.toBe(2);
  });
});

describe("E. tenants distintos têm filas próprias", () => {
  it("empresas diferentes mantêm filas independentes", async () => {
    const queueA = await queueForTechA();
    const queueB = await prisma.technicianDispatchQueue.create({
      data: { companyId: fixture.companyB.id, technicianId: techB1.id },
    });

    expect(queueA.companyId).toBe(fixture.companyA.id);
    expect(queueB.companyId).toBe(fixture.companyB.id);

    // A leitura escopada por tenant devolve só a própria fila. É o predicado
    // que o serviço vai usar — companyId em SQL, não navegação de FK.
    const daA = await prisma.technicianDispatchQueue.findMany({
      where: { companyId: fixture.companyA.id },
    });
    expect(daA).toHaveLength(1);
    expect(daA[0].id).toBe(queueA.id);
  });

  it("a entrada carrega companyId próprio, para filtro em SQL", async () => {
    const queue = await queueForTechA();
    const order = await orderFor(fixture.companyA.id, techA1.id);
    await prisma.technicianDispatchQueueEntry.create({
      data: {
        companyId: fixture.companyA.id,
        queueId: queue.id,
        serviceOrderId: order.id,
        position: 1,
      },
    });

    // Buscar a entrada de uma OS COM o tenant no predicado, sem passar pela
    // fila para descobrir de quem é a linha.
    await expect(
      prisma.technicianDispatchQueueEntry.findFirst({
        where: { companyId: fixture.companyB.id, serviceOrderId: order.id },
      }),
    ).resolves.toBeNull();
    await expect(
      prisma.technicianDispatchQueueEntry.findFirst({
        where: { companyId: fixture.companyA.id, serviceOrderId: order.id },
      }),
    ).resolves.not.toBeNull();
  });
});

describe("F. version e ciclo de vida", () => {
  it("a fila nasce com version 0", async () => {
    const queue = await queueForTechA();
    expect(queue.version).toBe(0);
  });

  it("apagar a fila leva as entradas junto", async () => {
    const queue = await queueForTechA();
    const order = await orderFor(fixture.companyA.id, techA1.id);
    await prisma.technicianDispatchQueueEntry.create({
      data: {
        companyId: fixture.companyA.id,
        queueId: queue.id,
        serviceOrderId: order.id,
        position: 1,
      },
    });

    await prisma.technicianDispatchQueue.delete({ where: { id: queue.id } });
    await expect(
      prisma.technicianDispatchQueueEntry.count({ where: { queueId: queue.id } }),
    ).resolves.toBe(0);
  });

  it("um técnico com fila NÃO pode ser apagado", async () => {
    /*
      `Restrict`, como toda outra relação do Technician no schema. Desativar
      (`technicians.active`) é a operação suportada; apagar levaria embora a
      fila de alguém que ainda tem OS atribuída.
    */
    await queueForTechA();
    await expect(
      prisma.technician.delete({ where: { id: techA1.id } }),
    ).rejects.toThrow();
  });

  it("a migration DQ-1 não criou fila nenhuma", async () => {
    // O backfill é DQ-2. Uma migration que escreve linha de domínio esconde
    // regra de negócio num lugar que ninguém testa.
    const fixtureLimpa = await seedTestData();
    expect(fixtureLimpa.companyA.id).toBeTruthy();
    await expect(prisma.technicianDispatchQueue.count()).resolves.toBe(0);
    await expect(prisma.technicianDispatchQueueEntry.count()).resolves.toBe(0);
  });
});

describe("a ordem do enum em Postgres não é a autoridade", () => {
  it("registra a ordem declarada, para que mudá-la seja visível", async () => {
    /*
      Tripwire, não asserção de produto.

      A precedência da fila vem de `DISPATCH_BAND` e não muda se alguém
      reordenar o enum. Mas TODA query existente com `ORDER BY priority` muda —
      e hoje há duas, na fila do técnico na web e na lista do Field.

      Se este teste falhar, a fila continua correta e aquelas duas listas
      inverteram. É o aviso de que as duas coisas se separaram.
    */
    const rows = await prisma.$queryRaw<{ enumlabel: string }[]>`
      SELECT e."enumlabel"
      FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'ServiceOrderPriority'
      ORDER BY e.enumsortorder
    `;
    expect(rows.map((r) => r.enumlabel)).toEqual([
      "LOW",
      "NORMAL",
      "HIGH",
      "URGENT",
    ]);
  });
});
