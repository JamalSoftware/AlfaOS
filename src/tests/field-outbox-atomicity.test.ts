import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  allocateTestServiceOrderNumber,
  seedTestData,
  type TestFixture,
} from "./helpers";

/**
 * A fronteira da transação de atribuição — provada de verdade.
 *
 * ## Por que este arquivo existe separado
 *
 * O teste óbvio ("CAS falha, logo nada é gravado") passa mesmo com a
 * notificação FORA da transação, e por um motivo bobo: o compare-and-set lança
 * **antes** de a notificação ser criada, então aquele caminho nunca a executa.
 * Ele documenta uma proteção que não verificou — o pior tipo de teste verde.
 *
 * O que prova a fronteira é falhar DEPOIS da escrita. Aqui o `enqueueOutboxEvent`
 * é substituído por um que lança: é a linha seguinte à notificação, dentro da
 * mesma transação. Se a notificação estiver no `tx`, ela desaparece junto; se
 * estiver no `prisma` global, ela sobrevive — e o técnico fica com aviso de uma
 * atribuição que não aconteceu.
 *
 * `vi.doMock` + import dinâmico porque `service-orders.ts` importa a função por
 * binding: um `vi.spyOn` no módulo já importado não trocaria a referência que
 * ele capturou.
 */

let fixture: TestFixture;

beforeEach(async () => {
  fixture = await seedTestData();
  vi.resetModules();
});

async function scenario() {
  const technician = await prisma.technician.create({
    data: { companyId: fixture.companyA.id, userId: fixture.techA.id },
  });
  const customer = await prisma.customer.create({
    data: { companyId: fixture.companyA.id, name: "Cliente" },
  });
  const order = await prisma.serviceOrder.create({
    data: {
      companyId: fixture.companyA.id,
      number: await allocateTestServiceOrderNumber(fixture.companyA.id),
      customerId: customer.id,
      type: "Instalação",
      description: "Instalação de fibra.",
      priority: "NORMAL",
      status: "PENDING",
    },
  });
  return { technician, customer, order };
}

describe("rollback DEPOIS da notificação", () => {
  it("falha ao enfileirar o evento desfaz a notificação e a atribuição", async () => {
    const s = await scenario();

    vi.doMock("@/lib/outbox", async () => {
      const real = await vi.importActual<typeof import("@/lib/outbox")>(
        "@/lib/outbox",
      );
      return {
        ...real,
        enqueueOutboxEvent: async () => {
          throw new Error("falha simulada ao enfileirar");
        },
      };
    });

    const { assignTechnician } = await import("@/lib/service-orders");

    await expect(
      assignTechnician(
        fixture.companyA.id,
        fixture.adminA.id,
        s.order.id,
        s.technician.id,
        s.order.version,
      ),
    ).rejects.toThrow("falha simulada ao enfileirar");

    /*
      As três asserções que importam.

      A notificação foi CRIADA antes da falha — se ela sobreviver, ela estava
      fora da transação, e o técnico receberia push de uma atribuição que o
      banco não registrou.
    */
    expect(await prisma.notification.count()).toBe(0);
    expect(await prisma.outboxEvent.count()).toBe(0);

    const order = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: s.order.id },
    });
    expect(order.status).toBe("PENDING");
    expect(order.technicianId).toBeNull();
    expect(order.version).toBe(s.order.version);

    expect(
      await prisma.serviceOrderEvent.count({
        where: { serviceOrderId: s.order.id },
      }),
    ).toBe(0);

    vi.doUnmock("@/lib/outbox");
  });

  it("controle positivo: sem a falha, tudo é gravado", async () => {
    const s = await scenario();

    // Mesmo caminho, sem sabotagem. Sem este controle, o teste acima passaria
    // até se `assignTechnician` estivesse quebrado de outra forma.
    const { assignTechnician } = await import("@/lib/service-orders");
    await assignTechnician(
      fixture.companyA.id,
      fixture.adminA.id,
      s.order.id,
      s.technician.id,
      s.order.version,
    );

    expect(await prisma.notification.count()).toBe(1);
    expect(await prisma.outboxEvent.count()).toBe(1);
    const order = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: s.order.id },
    });
    expect(order.status).toBe("ASSIGNED");
  });
});
