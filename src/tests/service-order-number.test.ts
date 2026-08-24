import { describe, it, expect, beforeEach } from "vitest";
import { POST as createOrderRoute } from "@/app/api/service-orders/route";
import { POST as assignOrderRoute } from "@/app/api/service-orders/[id]/assign/route";
import { prisma } from "@/lib/prisma";
import { allocateServiceOrderNumber } from "@/lib/service-order-number";
import {
  createManualServiceOrder,
  importServiceOrder,
  listCompanyServiceOrders,
  startServiceOrder,
} from "@/lib/service-orders";
import {
  allocateTestServiceOrderNumber,
  apiRequest,
  createTokenFor,
  seedTestData,
  type TestFixture,
} from "./helpers";

/**
 * Número operacional da OS.
 *
 * Invariante central: `ServiceOrder.id` é identidade TÉCNICA e
 * `ServiceOrder.number` é identidade OPERACIONAL HUMANA. O que este arquivo
 * tenta quebrar é a segunda — duplicar um número, renumerar uma OS, deixar o
 * cliente escolher o número, ou fazer a sequência de uma empresa vazar para a
 * outra.
 */

let fixture: TestFixture;

beforeEach(async () => {
  fixture = await seedTestData();
});

async function createCustomer(
  companyId: string,
  name = "Cliente Nº",
): Promise<{ id: string }> {
  return prisma.customer.create({ data: { companyId, name } });
}

function importInput(externalId: string) {
  return {
    externalProvider: "MOCK",
    externalId,
    externalNumber: `EXT-${externalId}`,
    type: "INSTALACAO",
    description: "OS importada do ERP.",
    priority: "NORMAL" as const,
    scheduledAt: null,
    customer: { externalId: `CUST-${externalId}`, name: "Cliente ERP" },
  };
}

// ---------------------------------------------------------------------------
// Sequência por empresa
// ---------------------------------------------------------------------------

describe("Sequência do número da OS", () => {
  it("a primeira OS da empresa é 1 e a segunda é 2", async () => {
    const customer = await createCustomer(fixture.companyA.id);

    const first = await createManualServiceOrder(
      fixture.companyA.id,
      fixture.adminA.id,
      {
        customerId: customer.id,
        typeId: fixture.typeA.id,
        description: "Primeira OS da empresa.",
        priority: "NORMAL",
      },
    );
    const second = await createManualServiceOrder(
      fixture.companyA.id,
      fixture.adminA.id,
      {
        customerId: customer.id,
        typeId: fixture.typeA.id,
        description: "Segunda OS da empresa.",
        priority: "NORMAL",
      },
    );

    expect(first.number).toBe(1);
    expect(second.number).toBe(2);
  });

  it("a empresa B começa em 1 mesmo com a empresa A já numerada", async () => {
    const customerA = await createCustomer(fixture.companyA.id);
    const customerB = await createCustomer(fixture.companyB.id, "Cliente B");

    for (let i = 0; i < 3; i += 1) {
      await createManualServiceOrder(fixture.companyA.id, fixture.adminA.id, {
        customerId: customerA.id,
        typeId: fixture.typeA.id,
        description: `OS ${i} da empresa A.`,
        priority: "NORMAL",
      });
    }

    const firstOfB = await createManualServiceOrder(
      fixture.companyB.id,
      fixture.adminB.id,
      {
        customerId: customerB.id,
        typeId: fixture.typeB.id,
        description: "Primeira OS da empresa B.",
        priority: "NORMAL",
      },
    );

    expect(firstOfB.number).toBe(1);

    // Controle positivo: a empresa A realmente avançou. Sem isto, um `1` em B
    // poderia estar passando por vazio (nenhuma OS criada em lugar nenhum).
    const lastOfA = await prisma.serviceOrder.findFirst({
      where: { companyId: fixture.companyA.id },
      orderBy: { number: "desc" },
    });
    expect(lastOfA?.number).toBe(3);
  });

  it("INTERNAL e EXTERNAL compartilham a MESMA sequência operacional", async () => {
    const customer = await createCustomer(fixture.companyA.id);

    const internalOne = await createManualServiceOrder(
      fixture.companyA.id,
      fixture.adminA.id,
      {
        customerId: customer.id,
        typeId: fixture.typeA.id,
        description: "Interna 1.",
        priority: "NORMAL",
      },
    );
    const external = await importServiceOrder(
      fixture.companyA.id,
      fixture.adminA.id,
      importInput("ERP-1"),
    );
    const internalTwo = await createManualServiceOrder(
      fixture.companyA.id,
      fixture.adminA.id,
      {
        customerId: customer.id,
        typeId: fixture.typeA.id,
        description: "Interna 2.",
        priority: "NORMAL",
      },
    );

    expect(internalOne.number).toBe(1);
    expect(external.serviceOrder.number).toBe(2);
    expect(internalTwo.number).toBe(3);

    // A origem continua sendo gravada no ponto de criação, não derivada.
    expect(internalOne.origin).toBe("INTERNAL");
    expect(external.serviceOrder.origin).toBe("EXTERNAL");
    // E o número do ERP é OUTRO dado, que não substitui o operacional.
    expect(external.serviceOrder.externalNumber).toBe("EXT-ERP-1");
  });

  it("reimportar a mesma OS externa NÃO consome nem troca o número", async () => {
    const first = await importServiceOrder(
      fixture.companyA.id,
      fixture.adminA.id,
      importInput("ERP-IDEMPOTENTE"),
    );
    const again = await importServiceOrder(
      fixture.companyA.id,
      fixture.adminA.id,
      importInput("ERP-IDEMPOTENTE"),
    );

    expect(again.created).toBe(false);
    expect(again.serviceOrder.id).toBe(first.serviceOrder.id);
    expect(again.serviceOrder.number).toBe(first.serviceOrder.number);

    const counter = await prisma.serviceOrderCounter.findUnique({
      where: { companyId: fixture.companyA.id },
    });
    // A segunda importação é um UPDATE: não passa pelo alocador.
    expect(counter?.lastNumber).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Concorrência
// ---------------------------------------------------------------------------

describe("Concorrência na alocação do número", () => {
  it("20 criações simultâneas produzem 20 números distintos, sem buraco", async () => {
    const customer = await createCustomer(fixture.companyA.id);

    /**
     * Corrida REAL: as 20 promessas são disparadas antes de qualquer uma
     * resolver. Um `MAX(number) + 1` sob READ COMMITTED falharia aqui — várias
     * transações leriam o mesmo máximo.
     */
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        createManualServiceOrder(fixture.companyA.id, fixture.adminA.id, {
          customerId: customer.id,
          typeId: fixture.typeA.id,
          description: `OS concorrente ${i}.`,
          priority: "NORMAL",
        }),
      ),
    );

    const numbers = results.map((order) => order.number).sort((a, b) => a - b);

    // Proíbe o desfecho ruim em vez de tolerá-lo: exatamente 1..20.
    expect(numbers).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(new Set(numbers).size).toBe(20);

    const persisted = await prisma.serviceOrder.findMany({
      where: { companyId: fixture.companyA.id },
      select: { number: true },
      orderBy: { number: "asc" },
    });
    expect(persisted.map((o) => o.number)).toEqual(numbers);

    const counter = await prisma.serviceOrderCounter.findUnique({
      where: { companyId: fixture.companyA.id },
    });
    expect(counter?.lastNumber).toBe(20);
  });

  it("criações simultâneas em DUAS empresas não misturam as sequências", async () => {
    const customerA = await createCustomer(fixture.companyA.id);
    const customerB = await createCustomer(fixture.companyB.id, "Cliente B");

    const makeA = (i: number) =>
      createManualServiceOrder(fixture.companyA.id, fixture.adminA.id, {
        customerId: customerA.id,
        typeId: fixture.typeA.id,
        description: `A-${i}`,
        priority: "NORMAL",
      });
    const makeB = (i: number) =>
      createManualServiceOrder(fixture.companyB.id, fixture.adminB.id, {
        customerId: customerB.id,
        typeId: fixture.typeB.id,
        description: `B-${i}`,
        priority: "NORMAL",
      });

    // Intercaladas de propósito: se o lock fosse global, uma empresa herdaria
    // números da outra.
    const results = await Promise.all([
      makeA(1),
      makeB(1),
      makeA(2),
      makeB(2),
      makeA(3),
      makeB(3),
      makeA(4),
      makeB(4),
      makeA(5),
      makeB(5),
    ]);

    const numbersA = results
      .filter((o) => o.description.startsWith("A-"))
      .map((o) => o.number)
      .sort((a, b) => a - b);
    const numbersB = results
      .filter((o) => o.description.startsWith("B-"))
      .map((o) => o.number)
      .sort((a, b) => a - b);

    expect(numbersA).toEqual([1, 2, 3, 4, 5]);
    expect(numbersB).toEqual([1, 2, 3, 4, 5]);
  });

  it("importações concorrentes do mesmo externalId não gravam dois números", async () => {
    /**
     * A perdedora da corrida na unique de identidade externa rola a transação
     * INTEIRA de volta, e com ela o incremento do contador — que é um UPDATE
     * transacional, não uma sequence. Nenhuma OS fica com dois números, e o
     * número da perdedora não é queimado.
     */
    const input = (customerExternalId: string) => ({
      ...importInput("ERP-RACE"),
      customer: { externalId: customerExternalId, name: "Cliente Corrida" },
    });

    const results = await Promise.all([
      importServiceOrder(
        fixture.companyA.id,
        fixture.adminA.id,
        input("CUST-RACE-A"),
      ),
      importServiceOrder(
        fixture.companyA.id,
        fixture.adminA.id,
        input("CUST-RACE-B"),
      ),
    ]);

    expect(new Set(results.map((r) => r.serviceOrder.id)).size).toBe(1);

    const orders = await prisma.serviceOrder.findMany({
      where: { companyId: fixture.companyA.id },
      select: { number: true },
    });
    expect(orders).toHaveLength(1);
    expect(orders[0]?.number).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// O cliente nunca escolhe o número
// ---------------------------------------------------------------------------

describe("Mass assignment do número", () => {
  it("POST com `number` no corpo é recusado com 400", async () => {
    const customer = await createCustomer(fixture.companyA.id);
    const token = await createTokenFor(fixture.adminA.id);

    const res = await createOrderRoute(
      apiRequest(
        "/api/service-orders",
        {
          method: "POST",
          body: {
            customerId: customer.id,
            typeId: fixture.typeA.id,
            description: "Tentativa de escolher o número.",
            priority: "NORMAL",
            number: 9999,
          },
        },
        token,
      ),
    );

    expect(res.status).toBe(400);
    expect(
      await prisma.serviceOrder.count({ where: { companyId: fixture.companyA.id } }),
    ).toBe(0);
  });

  it("sem `number` no corpo a criação funciona e o servidor numera", async () => {
    // Controle positivo do teste acima: o 400 vinha do campo extra, não de o
    // corpo inteiro estar inválido.
    const customer = await createCustomer(fixture.companyA.id);
    const token = await createTokenFor(fixture.adminA.id);

    const res = await createOrderRoute(
      apiRequest(
        "/api/service-orders",
        {
          method: "POST",
          body: {
            customerId: customer.id,
            typeId: fixture.typeA.id,
            description: "Criação legítima.",
            priority: "NORMAL",
          },
        },
        token,
      ),
    );

    expect(res.status).toBe(201);
    const payload = await res.json();
    expect(payload.data.serviceOrder.number).toBe(1);
  });

  it("`number` no corpo da atribuição de técnico também é recusado", async () => {
    const customer = await createCustomer(fixture.companyA.id);
    const technician = await prisma.technician.create({
      data: { companyId: fixture.companyA.id, userId: fixture.techA.id },
    });
    const order = await createManualServiceOrder(
      fixture.companyA.id,
      fixture.adminA.id,
      {
        customerId: customer.id,
        typeId: fixture.typeA.id,
        description: "OS para atribuir.",
        priority: "NORMAL",
      },
    );
    const token = await createTokenFor(fixture.adminA.id);

    const res = await assignOrderRoute(
      apiRequest(
        `/api/service-orders/${order.id}/assign`,
        {
          method: "POST",
          body: {
            technicianId: technician.id,
            expectedVersion: order.version,
            number: 4242,
          },
        },
        token,
      ),
      { params: { id: order.id } },
    );

    expect(res.status).toBe(400);
    const row = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(row.number).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Imutabilidade
// ---------------------------------------------------------------------------

describe("Imutabilidade do número", () => {
  it("atribuir, iniciar e reimportar não alteram o número", async () => {
    const customer = await createCustomer(fixture.companyA.id);
    const technician = await prisma.technician.create({
      data: { companyId: fixture.companyA.id, userId: fixture.techA.id },
    });
    const created = await createManualServiceOrder(
      fixture.companyA.id,
      fixture.adminA.id,
      {
        customerId: customer.id,
        typeId: fixture.typeA.id,
        description: "OS que vai mudar de estado.",
        priority: "NORMAL",
      },
    );
    const token = await createTokenFor(fixture.adminA.id);

    const assigned = await assignOrderRoute(
      apiRequest(
        `/api/service-orders/${created.id}/assign`,
        {
          method: "POST",
          body: {
            technicianId: technician.id,
            expectedVersion: created.version,
          },
        },
        token,
      ),
      { params: { id: created.id } },
    );
    expect(assigned.status).toBe(200);
    const assignedOrder = (await assigned.json()).data.serviceOrder;

    await startServiceOrder(
      fixture.companyA.id,
      fixture.techA.id,
      created.id,
      assignedOrder.version,
    );

    const afterWrites = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(afterWrites.number).toBe(created.number);
    expect(afterWrites.status).toBe("IN_PROGRESS");
    // O lock otimista continua avançando — ou seja, houve escrita de verdade e
    // a asserção acima não passou por ausência de mudança.
    expect(afterWrites.version).toBeGreaterThan(created.version);
  });

  it("o BANCO recusa um UPDATE que troque o número, mesmo por SQL cru", async () => {
    const customer = await createCustomer(fixture.companyA.id);
    const order = await createManualServiceOrder(
      fixture.companyA.id,
      fixture.adminA.id,
      {
        customerId: customer.id,
        typeId: fixture.typeA.id,
        description: "OS imutável.",
        priority: "NORMAL",
      },
    );

    /**
     * Ataque pelo caminho mais baixo disponível: SQL direto, sem passar por
     * nenhuma validação de aplicação. O trigger é a última linha.
     */
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "service_orders" SET "number" = 999 WHERE "id" = $1`,
        order.id,
      ),
    ).rejects.toThrow();

    const row = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(row.number).toBe(order.number);

    // Controle positivo: um UPDATE que NÃO toca o número passa normalmente —
    // o trigger não está simplesmente bloqueando toda escrita na tabela.
    await prisma.$executeRawUnsafe(
      `UPDATE "service_orders" SET "subtype" = 'ok' WHERE "id" = $1`,
      order.id,
    );
    const updated = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(updated.subtype).toBe("ok");
    expect(updated.number).toBe(order.number);
  });

  it("o banco recusa número duplicado na mesma empresa e aceita em outra", async () => {
    const customerA = await createCustomer(fixture.companyA.id);
    const customerB = await createCustomer(fixture.companyB.id, "Cliente B");

    await prisma.serviceOrder.create({
      data: {
        companyId: fixture.companyA.id,
        number: 7,
        customerId: customerA.id,
        type: "Instalação",
        description: "OS Nº 7 da empresa A.",
      },
    });

    await expect(
      prisma.serviceOrder.create({
        data: {
          companyId: fixture.companyA.id,
          number: 7,
          customerId: customerA.id,
          type: "Instalação",
          description: "Segunda OS Nº 7 da empresa A.",
        },
      }),
    ).rejects.toThrow();

    // A MESMA numeração na empresa B é legítima: a unique é (companyId, number).
    const inB = await prisma.serviceOrder.create({
      data: {
        companyId: fixture.companyB.id,
        number: 7,
        customerId: customerB.id,
        type: "Instalação",
        description: "OS Nº 7 da empresa B.",
      },
    });
    expect(inB.number).toBe(7);
  });

  it("o banco recusa número zero ou negativo", async () => {
    const customer = await createCustomer(fixture.companyA.id);

    for (const number of [0, -1]) {
      await expect(
        prisma.serviceOrder.create({
          data: {
            companyId: fixture.companyA.id,
            number,
            customerId: customer.id,
            type: "Instalação",
            description: `OS com número ${number}.`,
          },
        }),
      ).rejects.toThrow();
    }

    expect(
      await prisma.serviceOrder.count({ where: { companyId: fixture.companyA.id } }),
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Isolamento entre empresas
// ---------------------------------------------------------------------------

describe("Isolamento multiempresa do número", () => {
  it("a busca por número não atravessa empresa", async () => {
    const customerA = await createCustomer(fixture.companyA.id);
    const customerB = await createCustomer(fixture.companyB.id, "Cliente B");

    const inA = await createManualServiceOrder(
      fixture.companyA.id,
      fixture.adminA.id,
      {
        customerId: customerA.id,
        typeId: fixture.typeA.id,
        description: "OS Nº 1 da A.",
        priority: "NORMAL",
      },
    );
    const inB = await createManualServiceOrder(
      fixture.companyB.id,
      fixture.adminB.id,
      {
        customerId: customerB.id,
        typeId: fixture.typeB.id,
        description: "OS Nº 1 da B.",
        priority: "NORMAL",
      },
    );

    // As duas empresas têm, legitimamente, a sua OS Nº 1.
    expect(inA.number).toBe(1);
    expect(inB.number).toBe(1);

    const foundInA = await listCompanyServiceOrders(fixture.companyA.id, {
      search: "1",
    });
    expect(foundInA.serviceOrders.map((o) => o.id)).toEqual([inA.id]);
    expect(foundInA.serviceOrders.map((o) => o.id)).not.toContain(inB.id);

    const foundInB = await listCompanyServiceOrders(fixture.companyB.id, {
      search: "1",
    });
    expect(foundInB.serviceOrders.map((o) => o.id)).toEqual([inB.id]);
  });

  it("busca com termo não numérico não quebra e continua filtrando por texto", async () => {
    const customer = await createCustomer(fixture.companyA.id);
    await createManualServiceOrder(fixture.companyA.id, fixture.adminA.id, {
      customerId: customer.id,
      typeId: fixture.typeA.id,
      description: "Troca de roteador.",
      priority: "NORMAL",
    });

    // `number` é coluna inteira: um termo textual não pode chegar até ela.
    const byText = await listCompanyServiceOrders(fixture.companyA.id, {
      search: "roteador",
    });
    expect(byText.serviceOrders).toHaveLength(1);

    const nonsense = await listCompanyServiceOrders(fixture.companyA.id, {
      search: "99999999999999999999",
    });
    expect(nonsense.serviceOrders).toHaveLength(0);
  });

  it("o contador de uma empresa é apagado junto com a empresa", async () => {
    const customer = await createCustomer(fixture.companyB.id, "Cliente B");
    await createManualServiceOrder(fixture.companyB.id, fixture.adminB.id, {
      customerId: customer.id,
      typeId: fixture.typeB.id,
      description: "OS da empresa B.",
      priority: "NORMAL",
    });

    expect(
      await prisma.serviceOrderCounter.findUnique({
        where: { companyId: fixture.companyB.id },
      }),
    ).not.toBeNull();

    await prisma.serviceOrderEvent.deleteMany({
      where: { companyId: fixture.companyB.id },
    });
    await prisma.serviceOrder.deleteMany({
      where: { companyId: fixture.companyB.id },
    });
    await prisma.serviceOrderType.deleteMany({
      where: { companyId: fixture.companyB.id },
    });
    await prisma.customer.deleteMany({ where: { companyId: fixture.companyB.id } });
    await prisma.auditLog.deleteMany({ where: { companyId: fixture.companyB.id } });
    await prisma.user.deleteMany({ where: { companyId: fixture.companyB.id } });
    await prisma.company.delete({ where: { id: fixture.companyB.id } });

    expect(
      await prisma.serviceOrderCounter.findUnique({
        where: { companyId: fixture.companyB.id },
      }),
    ).toBeNull();
    // A sequência da empresa A não foi afetada.
    expect(
      await prisma.serviceOrderCounter.findUnique({
        where: { companyId: fixture.companyA.id },
      }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Backfill da migration
// ---------------------------------------------------------------------------

describe("Backfill determinístico", () => {
  /**
   * A expressão exata da migration `20260824120000_add_service_order_number`.
   *
   * Testada contra uma TABELA TEMPORÁRIA, dentro de uma transação: é a
   * expressão que é arriscada (partição por empresa, ordem estável,
   * preservação das linhas), não o DDL em volta dela. Rodar em tabela temp
   * evita reescrever `service_orders` de verdade — renumerar OS é exatamente
   * o que o trigger de imutabilidade existe para impedir.
   */
  it("numera 1..n por empresa, em ordem estável, sem perder nem reidentificar linha", async () => {
    const rows = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`
        CREATE TEMP TABLE backfill_probe (
          "id" TEXT PRIMARY KEY,
          "companyId" TEXT NOT NULL,
          "createdAt" TIMESTAMP(3) NOT NULL,
          "number" INTEGER
        ) ON COMMIT DROP
      `);

      /*
        Duas empresas intercaladas, e DUAS linhas da empresa A com exatamente o
        mesmo `createdAt` — é o caso que obriga o desempate por `id`. Sem ele o
        resultado dependeria da ordem física das linhas e duas execuções da
        mesma migration poderiam numerar diferente.
      */
      await tx.$executeRawUnsafe(`
        INSERT INTO backfill_probe ("id", "companyId", "createdAt") VALUES
          ('a-03', 'A', TIMESTAMP '2026-01-03 10:00:00.000'),
          ('b-02', 'B', TIMESTAMP '2026-01-02 10:00:00.000'),
          ('a-01', 'A', TIMESTAMP '2026-01-01 10:00:00.000'),
          ('a-02b', 'A', TIMESTAMP '2026-01-02 10:00:00.000'),
          ('a-02a', 'A', TIMESTAMP '2026-01-02 10:00:00.000'),
          ('b-01', 'B', TIMESTAMP '2026-01-01 10:00:00.000')
      `);

      await tx.$executeRawUnsafe(`
        WITH numbered AS (
          SELECT
            "id",
            ROW_NUMBER() OVER (
              PARTITION BY "companyId"
              ORDER BY "createdAt" ASC, "id" ASC
            ) AS seq
          FROM backfill_probe
        )
        UPDATE backfill_probe AS so
        SET "number" = numbered.seq
        FROM numbered
        WHERE so."id" = numbered."id"
      `);

      return tx.$queryRawUnsafe<
        { id: string; companyId: string; number: number }[]
      >(`SELECT "id", "companyId", "number" FROM backfill_probe ORDER BY "companyId", "number"`);
    });

    // Nenhuma linha perdida, nenhum id alterado.
    expect(rows).toHaveLength(6);
    expect([...rows].map((r) => r.id).sort()).toEqual([
      "a-01",
      "a-02a",
      "a-02b",
      "a-03",
      "b-01",
      "b-02",
    ]);

    // Sequência por empresa, começando em 1 nas duas.
    expect(rows.filter((r) => r.companyId === "A")).toEqual([
      { id: "a-01", companyId: "A", number: 1 },
      { id: "a-02a", companyId: "A", number: 2 },
      { id: "a-02b", companyId: "A", number: 3 },
      { id: "a-03", companyId: "A", number: 4 },
    ]);
    expect(rows.filter((r) => r.companyId === "B")).toEqual([
      { id: "b-01", companyId: "B", number: 1 },
      { id: "b-02", companyId: "B", number: 2 },
    ]);
  });

  it("o contador fica alinhado ao maior número já atribuído, e a próxima OS continua a sequência", async () => {
    const customer = await createCustomer(fixture.companyA.id);

    /*
      Simula o estado logo após a migration: OS já numeradas e o contador
      alinhado por `MAX(number)`, como faz o INSERT ... SELECT da migration.
    */
    for (const number of [1, 2, 3]) {
      await prisma.serviceOrder.create({
        data: {
          companyId: fixture.companyA.id,
          number,
          customerId: customer.id,
          type: "Instalação",
          description: `OS histórica ${number}.`,
        },
      });
    }
    await prisma.serviceOrderCounter.create({
      data: { companyId: fixture.companyA.id, lastNumber: 3 },
    });

    const next = await createManualServiceOrder(
      fixture.companyA.id,
      fixture.adminA.id,
      {
        customerId: customer.id,
        typeId: fixture.typeA.id,
        description: "Primeira OS depois da migration.",
        priority: "NORMAL",
      },
    );

    // Continua a sequência em vez de recomeçar e colidir.
    expect(next.number).toBe(4);
    expect(
      await prisma.serviceOrder.count({ where: { companyId: fixture.companyA.id } }),
    ).toBe(4);
  });

  it("um contador desalinhado para BAIXO colide em vez de reatribuir número usado", async () => {
    /**
     * Cenário de operador: alguém restaura o contador de um backup antigo.
     *
     * O comportamento correto é FALHAR, não reaproveitar. Reatribuir um número
     * já impresso numa OS existente é pior do que uma criação recusada — dois
     * atendimentos diferentes passariam a atender pelo mesmo "OS Nº 2".
     */
    const customer = await createCustomer(fixture.companyA.id);
    for (const number of [1, 2, 3]) {
      await prisma.serviceOrder.create({
        data: {
          companyId: fixture.companyA.id,
          number,
          customerId: customer.id,
          type: "Instalação",
          description: `OS histórica ${number}.`,
        },
      });
    }
    await prisma.serviceOrderCounter.create({
      data: { companyId: fixture.companyA.id, lastNumber: 1 },
    });

    await expect(
      createManualServiceOrder(fixture.companyA.id, fixture.adminA.id, {
        customerId: customer.id,
        typeId: fixture.typeA.id,
        description: "Criação sobre contador atrasado.",
        priority: "NORMAL",
      }),
    ).rejects.toThrow();

    const numbers = await prisma.serviceOrder.findMany({
      where: { companyId: fixture.companyA.id },
      select: { number: true, description: true },
      orderBy: { number: "asc" },
    });
    // As três OS históricas continuam intactas e com os números originais.
    expect(numbers.map((o) => o.number)).toEqual([1, 2, 3]);
    expect(numbers.every((o) => o.description.startsWith("OS histórica"))).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Alocador, isoladamente
// ---------------------------------------------------------------------------

describe("allocateServiceOrderNumber", () => {
  it("cria a linha do contador na primeira chamada e incrementa depois", async () => {
    expect(
      await prisma.serviceOrderCounter.findUnique({
        where: { companyId: fixture.companyA.id },
      }),
    ).toBeNull();

    expect(await allocateServiceOrderNumber(prisma, fixture.companyA.id)).toBe(1);
    expect(await allocateServiceOrderNumber(prisma, fixture.companyA.id)).toBe(2);
    expect(await allocateTestServiceOrderNumber(fixture.companyA.id)).toBe(3);

    const counter = await prisma.serviceOrderCounter.findUniqueOrThrow({
      where: { companyId: fixture.companyA.id },
    });
    expect(counter.lastNumber).toBe(3);
  });

  it("50 alocações simultâneas na mesma empresa não repetem nenhum número", async () => {
    const allocated = await Promise.all(
      Array.from({ length: 50 }, () =>
        allocateServiceOrderNumber(prisma, fixture.companyA.id),
      ),
    );

    expect(new Set(allocated).size).toBe(50);
    expect([...allocated].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 50 }, (_, i) => i + 1),
    );
  });
});
