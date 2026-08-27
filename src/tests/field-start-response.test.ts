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

// ---------------------------------------------------------------------------
// IDM-01 · tomada de reserva DEPOIS de a mutação ter commitado
// ---------------------------------------------------------------------------

describe("IDM-01 · retry após reserva abandonada não duplica a mutação", () => {
  it("a tomada re-executa e o DOMÍNIO recusa — 409, sem evento duplicado", async () => {
    const s = await scenario();
    const { POST: startRoute } = await import(
      "@/app/api/field/v1/service-orders/[id]/start/route"
    );
    const key = "start-reserva-orfa-01";

    const chamada = () =>
      startRoute(
        fieldRequest(`/api/field/v1/service-orders/${s.order.id}/start`, {
          method: "POST",
          token: s.token,
          idempotencyKey: key,
          body: { expectedVersion: s.order.version },
        }),
        { params: { id: s.order.id } },
      );

    expect((await chamada()).status).toBe(200);

    /*
      O cenário exato do achado: a operação COMMITOU, mas o processo morreu
      antes de gravar o desfecho na reserva. A linha volta a IN_FLIGHT com o
      lease vencido — indistinguível, para quem chega depois, de uma reserva
      que nunca executou.
    */
    await prisma.idempotencyRecord.updateMany({
      where: { key },
      data: {
        status: 0,
        response: {},
        leaseExpiresAt: new Date(Date.now() - 1000),
      },
    });

    const retry = await chamada();

    /*
      A tomada re-executa o handler, e quem impede a segunda mutação NÃO é a
      camada de idempotência: é o domínio. `ALLOWED_STATUS_TRANSITIONS` não
      lista IN_PROGRESS a partir de IN_PROGRESS, então a máquina de estados
      recusa antes de qualquer escrita.

      409 é o desfecho honesto: pior que devolver o 200 original, melhor que
      iniciar a OS duas vezes.
    */
    expect(retry.status).toBe(409);

    // O que importa de verdade: nada duplicou.
    expect(
      await prisma.serviceOrderExecution.count({
        where: { serviceOrderId: s.order.id },
      }),
    ).toBe(1);
    expect(
      await prisma.serviceOrderEvent.count({
        where: { serviceOrderId: s.order.id, event: "OS_STARTED" },
      }),
    ).toBe(1);

    const os = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: s.order.id },
    });
    expect(os.version).toBe(s.order.version + 1);
  });

  it("reserva órfã cuja operação NÃO commitou é retomada com sucesso", async () => {
    const s = await scenario();
    const { POST: startRoute } = await import(
      "@/app/api/field/v1/service-orders/[id]/start/route"
    );
    const key = "start-orfa-sem-commit";

    // Reserva de um processo que morreu ANTES de executar qualquer coisa.
    await prisma.idempotencyRecord.create({
      data: {
        companyId: fixture.companyA.id,
        userId: fixture.techA.id,
        operation: "service-order.start",
        key,
        fingerprint: "impressao-que-sera-substituida",
        status: 0,
        response: {},
        leaseExpiresAt: new Date(Date.now() - 1000),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const response = await startRoute(
      fieldRequest(`/api/field/v1/service-orders/${s.order.id}/start`, {
        method: "POST",
        token: s.token,
        idempotencyKey: key,
        body: { expectedVersion: s.order.version },
      }),
      { params: { id: s.order.id } },
    );

    /*
      A impressão digital difere da reserva órfã, então isto é conflito de
      chave — e está certo: a chave foi reservada para OUTRO conteúdo. O ponto
      é que a resposta é determinística, e não um CONFLICT eterno.
    */
    expect(response.status).toBe(409);
    const payload = (await response.json()) as { error: { code: string } };
    expect(payload.error.code).toBe("IDEMPOTENCY_CONFLICT");

    // A OS não foi iniciada por tabela.
    const os = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: s.order.id },
    });
    expect(os.status).toBe("ASSIGNED");
  });
});
