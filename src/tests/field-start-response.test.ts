import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  allocateTestServiceOrderNumber,
  fieldRequest,
  registerTestDevice,
  seedTestData,
  type TestFixture,
} from "./helpers";

/**
 * START-01 — a resposta do comando vem da MUTAÇÃO, não de uma releitura.
 *
 * O defeito: a rota commitava o `start` e depois chamava `getFieldServiceOrder`
 * para montar o corpo. Essa releitura filtra por posse. Se o despachante
 * reatribuísse a OS nesse intervalo, ela devolvia **404** — e o aplicativo
 * marcava como falha uma operação que tinha acontecido, com `startedAt` gravado
 * e evento na timeline.
 *
 * A janela é curta mas real, e o desfecho é o pior possível para a fila local
 * offline: o técnico reenvia algo que já foi feito.
 *
 * O teste reproduz a janela de propósito, envolvendo `startServiceOrder` num
 * wrapper que reatribui a OS logo depois do commit.
 */

let fixture: TestFixture;

beforeEach(async () => {
  fixture = await seedTestData();
  vi.resetModules();
});

async function scenario() {
  const technicianA = await prisma.technician.create({
    data: { companyId: fixture.companyA.id, userId: fixture.techA.id },
  });
  const technicianB = await prisma.technician.create({
    data: { companyId: fixture.companyA.id, userId: fixture.techB.id },
  });
  const customer = await prisma.customer.create({
    data: { companyId: fixture.companyA.id, name: "Cliente" },
  });
  const order = await prisma.serviceOrder.create({
    data: {
      companyId: fixture.companyA.id,
      number: await allocateTestServiceOrderNumber(fixture.companyA.id),
      customerId: customer.id,
      technicianId: technicianA.id,
      type: "Instalação",
      description: "Instalação de fibra.",
      priority: "NORMAL",
      status: "ASSIGNED",
      assignedAt: new Date(),
    },
  });
  const { token } = await registerTestDevice(fixture.techA.id);
  return { technicianA, technicianB, customer, order, token };
}

describe("START-01 · reatribuição logo após o commit", () => {
  it("o técnico recebe o SUCESSO da operação que executou, não 404", async () => {
    const s = await scenario();

    vi.doMock("@/lib/service-orders", async () => {
      const real =
        await vi.importActual<typeof import("@/lib/service-orders")>(
          "@/lib/service-orders",
        );
      return {
        ...real,
        startServiceOrder: async (...args: Parameters<typeof real.startServiceOrder>) => {
          const result = await real.startServiceOrder(...args);
          /*
            A janela: a transação commitou, e o despachante tira a OS do
            técnico ANTES de a resposta ser montada. Com a releitura antiga,
            daqui em diante ele receberia "não encontrado".
          */
          await prisma.serviceOrder.update({
            where: { id: s.order.id },
            data: { technicianId: s.technicianB.id, version: { increment: 1 } },
          });
          return result;
        },
      };
    });

    const { POST: startRoute } = await import(
      "@/app/api/field/v1/service-orders/[id]/start/route"
    );

    const response = await startRoute(
      fieldRequest(`/api/field/v1/service-orders/${s.order.id}/start`, {
        method: "POST",
        token: s.token,
        idempotencyKey: "start-janela-reatrib1",
        body: { expectedVersion: s.order.version },
      }),
      { params: { id: s.order.id } },
    );

    expect(response.status).toBe(200);

    const payload = (await response.json()) as {
      ok: boolean;
      data: {
        serviceOrder: { id: string; status: string; version: number };
        execution: { id: string };
      };
    };
    expect(payload.ok).toBe(true);
    expect(payload.data.serviceOrder.id).toBe(s.order.id);
    // O estado relatado é o que a mutação produziu.
    expect(payload.data.serviceOrder.status).toBe("IN_PROGRESS");
    expect(payload.data.serviceOrder.version).toBe(s.order.version + 1);
    expect(payload.data.execution.id).toBeTruthy();

    // E a operação realmente aconteceu.
    const os = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: s.order.id },
    });
    expect(os.status).toBe("IN_PROGRESS");
    expect(os.startedAt).not.toBeNull();

    vi.doUnmock("@/lib/service-orders");
  });

  it("depois disso, o detalhe corretamente responde 404 — a OS não é mais dele", async () => {
    const s = await scenario();
    const { GET: detailRoute } = await import(
      "@/app/api/field/v1/service-orders/[id]/route"
    );

    // Controle positivo: enquanto é dele, o detalhe abre.
    const antes = await detailRoute(
      fieldRequest(`/api/field/v1/service-orders/${s.order.id}`, {
        token: s.token,
      }),
      { params: { id: s.order.id } },
    );
    expect(antes.status).toBe(200);

    await prisma.serviceOrder.update({
      where: { id: s.order.id },
      data: { technicianId: s.technicianB.id },
    });

    const depois = await detailRoute(
      fieldRequest(`/api/field/v1/service-orders/${s.order.id}`, {
        token: s.token,
      }),
      { params: { id: s.order.id } },
    );
    /*
      Aqui o 404 é CORRETO, e a distinção é o ponto do achado: negar uma
      LEITURA de quem não é mais dono está certo; negar o RELATO de uma escrita
      que já foi autorizada e commitada está errado.
    */
    expect(depois.status).toBe(404);
  });

  it("a resposta do start não carrega dado pessoal do cliente", async () => {
    const s = await scenario();
    await prisma.customer.update({
      where: { id: s.customer.id },
      data: {
        document: "12345678901",
        phone: "(28) 99999-0001",
        address: "Rua das Flores",
      },
    });

    const { POST: startRoute } = await import(
      "@/app/api/field/v1/service-orders/[id]/start/route"
    );
    const response = await startRoute(
      fieldRequest(`/api/field/v1/service-orders/${s.order.id}/start`, {
        method: "POST",
        token: s.token,
        idempotencyKey: "start-sem-pessoal-001",
        body: { expectedVersion: s.order.version },
      }),
      { params: { id: s.order.id } },
    );

    const serial = JSON.stringify(await response.json());
    // Controle positivo.
    expect(serial).toContain("IN_PROGRESS");
    // O corpo é mínimo: o app já tem o detalhe, e projetar o
    // `PublicServiceOrder` inteiro traria o CPF de volta.
    expect(serial).not.toContain("12345678901");
    expect(serial).not.toContain("99999-0001");
    expect(serial).not.toContain("Rua das Flores");
    expect(serial).not.toContain("customer");
  });

  it("o corpo memorizado pela idempotência é o mesmo da primeira vez", async () => {
    const s = await scenario();
    const { POST: startRoute } = await import(
      "@/app/api/field/v1/service-orders/[id]/start/route"
    );
    const chamada = () =>
      startRoute(
        fieldRequest(`/api/field/v1/service-orders/${s.order.id}/start`, {
          method: "POST",
          token: s.token,
          idempotencyKey: "start-repeticao-00001",
          body: { expectedVersion: s.order.version },
        }),
        { params: { id: s.order.id } },
      );

    const primeiro = await (await chamada()).json();

    // Reatribui: a repetição não pode passar a falhar por causa disso.
    await prisma.serviceOrder.update({
      where: { id: s.order.id },
      data: { technicianId: s.technicianB.id },
    });

    const segundo = await (await chamada()).json();
    expect(segundo).toEqual(primeiro);
  });
});
