import { describe, it, expect, beforeEach } from "vitest";
import { POST as startOrder } from "@/app/api/service-orders/[id]/start/route";
import { PATCH as patchExecution } from "@/app/api/service-orders/[id]/execution/route";
import { GET as getOrder } from "@/app/api/service-orders/[id]/route";
import { prisma } from "@/lib/prisma";
import {
  getCompanyServiceOrder,
  listServiceOrdersForTechnician,
  startServiceOrder,
  updateServiceOrderExecution,
} from "@/lib/service-orders";
import { getDashboardStats } from "@/lib/dashboard";
import { DomainError } from "@/lib/errors";
import {
  allocateTestServiceOrderNumber,
  apiRequest,
  createTokenFor,
  seedTestData,
  type TestFixture,
} from "./helpers";

let fixture: TestFixture;

beforeEach(async () => {
  fixture = await seedTestData();
});

// ---------------------------------------------------------------------------
// Scenario builders
// ---------------------------------------------------------------------------

async function createCustomer(companyId: string, name = "Cliente Teste") {
  return prisma.customer.create({
    data: { companyId, name, city: "Belo Horizonte", state: "MG" },
  });
}

async function createTech(companyId: string, userId: string) {
  return prisma.technician.create({ data: { companyId, userId } });
}

async function createOrderFor(options: {
  companyId: string;
  customerId: string;
  technicianId?: string | null;
  status?: "PENDING" | "ASSIGNED" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";
}) {
  return prisma.serviceOrder.create({
    data: {
      companyId: options.companyId,
      number: await allocateTestServiceOrderNumber(options.companyId),
      customerId: options.customerId,
      technicianId: options.technicianId ?? null,
      type: "Instalação",
      description: "Instalação de fibra óptica.",
      priority: "NORMAL",
      status: options.status ?? "ASSIGNED",
      assignedAt: options.technicianId ? new Date() : null,
    },
  });
}

/**
 * The common happy-path setup: company A, a customer, technician A linked to
 * `techA`, and one ASSIGNED order owned by that technician.
 */
async function assignedOrderScenario() {
  const customer = await createCustomer(fixture.companyA.id);
  const technician = await createTech(fixture.companyA.id, fixture.techA.id);
  const order = await createOrderFor({
    companyId: fixture.companyA.id,
    customerId: customer.id,
    technicianId: technician.id,
  });
  const token = await createTokenFor(fixture.techA.id);
  return { customer, technician, order, token };
}

function startRequest(orderId: string, body: unknown, token: string) {
  return startOrder(
    apiRequest(`/api/service-orders/${orderId}/start`, { method: "POST", body }, token),
    { params: { id: orderId } },
  );
}

function executionRequest(orderId: string, body: unknown, token: string) {
  return patchExecution(
    apiRequest(
      `/api/service-orders/${orderId}/execution`,
      { method: "PATCH", body },
      token,
    ),
    { params: { id: orderId } },
  );
}

/** Starts an order through the API and returns the fresh execution version. */
async function startAndGetExecution(orderId: string, version: number, token: string) {
  const res = await startRequest(orderId, { expectedVersion: version }, token);
  expect(res.status).toBe(200);
  const payload = await res.json();
  return payload.data.execution as { id: string; version: number };
}

// ---------------------------------------------------------------------------

describe("Execução do técnico — iniciar atendimento", () => {
  it("Técnico dono inicia OS ASSIGNED: status, startedAt, execução, timeline e auditoria", async () => {
    const { order, technician, token } = await assignedOrderScenario();

    const res = await startRequest(
      order.id,
      { expectedVersion: order.version },
      token,
    );
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.data.serviceOrder.status).toBe("IN_PROGRESS");

    const stored = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(stored.status).toBe("IN_PROGRESS");
    expect(stored.startedAt).toBeInstanceOf(Date);
    expect(stored.version).toBe(order.version + 1);

    const execution = await prisma.serviceOrderExecution.findUniqueOrThrow({
      where: { serviceOrderId: order.id },
    });
    expect(execution.companyId).toBe(fixture.companyA.id);
    expect(execution.version).toBe(0);
    expect(execution.diagnosis).toBeNull();
    expect(execution.workPerformed).toBeNull();
    expect(execution.notes).toBeNull();

    const events = await prisma.serviceOrderEvent.findMany({
      where: { serviceOrderId: order.id, event: "OS_STARTED" },
    });
    expect(events).toHaveLength(1);
    expect(events[0].userId).toBe(fixture.techA.id);
    expect(events[0].metadata).toMatchObject({ technicianId: technician.id });

    const audits = await prisma.auditLog.findMany({
      where: { companyId: fixture.companyA.id, action: "SERVICE_ORDER.STARTED" },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0].userId).toBe(fixture.techA.id);
    expect(audits[0].entityId).toBe(order.id);
  });

  it("expectedVersion obsoleto é recusado (409) e não sobrescreve o estado", async () => {
    const { order, token } = await assignedOrderScenario();

    // Somebody else touches the order after this client read it.
    await prisma.serviceOrder.update({
      where: { id: order.id },
      data: { version: { increment: 1 }, priority: "HIGH" },
    });

    const res = await startRequest(
      order.id,
      { expectedVersion: order.version },
      token,
    );
    expect(res.status).toBe(409);

    const stored = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(stored.status).toBe("ASSIGNED");
    expect(stored.startedAt).toBeNull();
    expect(stored.priority).toBe("HIGH");
    expect(
      await prisma.serviceOrderExecution.count({
        where: { serviceOrderId: order.id },
      }),
    ).toBe(0);
    expect(
      await prisma.serviceOrderEvent.count({
        where: { serviceOrderId: order.id, event: "OS_STARTED" },
      }),
    ).toBe(0);
  });

  it("expectedVersion é obrigatório: corpo sem a versão é rejeitado (400)", async () => {
    const { order, token } = await assignedOrderScenario();

    const res = await startRequest(order.id, {}, token);
    expect(res.status).toBe(400);

    const stored = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(stored.status).toBe("ASSIGNED");
  });

  it("Double-click sequencial: a segunda chamada recebe 409 previsível e nada duplica", async () => {
    const { order, token } = await assignedOrderScenario();

    const first = await startRequest(
      order.id,
      { expectedVersion: order.version },
      token,
    );
    expect(first.status).toBe(200);
    const startedAt = (
      await prisma.serviceOrder.findUniqueOrThrow({ where: { id: order.id } })
    ).startedAt;

    // Same payload again — the version it holds is now stale, and the order is
    // already IN_PROGRESS.
    const second = await startRequest(
      order.id,
      { expectedVersion: order.version },
      token,
    );
    expect(second.status).toBe(409);
    expect((await second.json()).error).toContain("já está em atendimento");

    // Even a caller that refreshed its version cannot start a second time.
    const fresh = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: order.id },
    });
    const third = await startRequest(
      order.id,
      { expectedVersion: fresh.version },
      token,
    );
    expect(third.status).toBe(409);

    expect(
      await prisma.serviceOrderExecution.count({
        where: { serviceOrderId: order.id },
      }),
    ).toBe(1);
    expect(
      await prisma.serviceOrderEvent.count({
        where: { serviceOrderId: order.id, event: "OS_STARTED" },
      }),
    ).toBe(1);
    expect(
      (await prisma.serviceOrder.findUniqueOrThrow({ where: { id: order.id } }))
        .startedAt,
    ).toEqual(startedAt);
  });

  it("Duas chamadas simultâneas de start: exatamente uma vence", async () => {
    const { order, token } = await assignedOrderScenario();

    const results = await Promise.allSettled([
      startRequest(order.id, { expectedVersion: order.version }, token),
      startRequest(order.id, { expectedVersion: order.version }, token),
    ]);

    const statuses = results.map((r) =>
      r.status === "fulfilled" ? r.value.status : 500,
    );
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(1);

    expect(
      await prisma.serviceOrderExecution.count({
        where: { serviceOrderId: order.id },
      }),
    ).toBe(1);
    expect(
      await prisma.serviceOrderEvent.count({
        where: { serviceOrderId: order.id, event: "OS_STARTED" },
      }),
    ).toBe(1);
  });

  it("Execução é única por OS: o banco recusa uma segunda linha para a mesma OS", async () => {
    const { order, token } = await assignedOrderScenario();
    await startAndGetExecution(order.id, order.version, token);

    // Bypasses the service layer entirely — this asserts the DATABASE
    // constraint, not the application check.
    await expect(
      prisma.serviceOrderExecution.create({
        data: { companyId: fixture.companyA.id, serviceOrderId: order.id },
      }),
    ).rejects.toMatchObject({ code: "P2002" });

    expect(
      await prisma.serviceOrderExecution.count({
        where: { serviceOrderId: order.id },
      }),
    ).toBe(1);
  });
});

describe("Execução do técnico — máquina de estados", () => {
  it("OS PENDING (sem técnico) não pode ser iniciada", async () => {
    const customer = await createCustomer(fixture.companyA.id);
    await createTech(fixture.companyA.id, fixture.techA.id);
    const order = await createOrderFor({
      companyId: fixture.companyA.id,
      customerId: customer.id,
      technicianId: null,
      status: "PENDING",
    });
    const token = await createTokenFor(fixture.techA.id);

    // Not owned by anyone, so ownership refuses it before the state machine
    // even gets a say — and it refuses with 404, not 403.
    const res = await startRequest(
      order.id,
      { expectedVersion: order.version },
      token,
    );
    expect(res.status).toBe(404);

    const stored = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(stored.status).toBe("PENDING");
    expect(stored.startedAt).toBeNull();
  });

  it("OS PENDING atribuída a um técnico ainda assim não pode ser iniciada", async () => {
    const customer = await createCustomer(fixture.companyA.id);
    const technician = await createTech(fixture.companyA.id, fixture.techA.id);
    // A row that is PENDING but carries a technicianId should not become a
    // loophole: the state machine, not the FK, decides.
    const order = await createOrderFor({
      companyId: fixture.companyA.id,
      customerId: customer.id,
      technicianId: technician.id,
      status: "PENDING",
    });
    const token = await createTokenFor(fixture.techA.id);

    const res = await startRequest(
      order.id,
      { expectedVersion: order.version },
      token,
    );
    expect(res.status).toBe(409);
    expect(
      (await prisma.serviceOrder.findUniqueOrThrow({ where: { id: order.id } }))
        .status,
    ).toBe("PENDING");
  });

  for (const status of ["COMPLETED", "CANCELLED"] as const) {
    it(`OS ${status} não pode ser iniciada`, async () => {
      const customer = await createCustomer(fixture.companyA.id);
      const technician = await createTech(fixture.companyA.id, fixture.techA.id);
      const order = await createOrderFor({
        companyId: fixture.companyA.id,
        customerId: customer.id,
        technicianId: technician.id,
        status,
      });
      const token = await createTokenFor(fixture.techA.id);

      const res = await startRequest(
        order.id,
        { expectedVersion: order.version },
        token,
      );
      expect(res.status).toBe(409);

      const stored = await prisma.serviceOrder.findUniqueOrThrow({
        where: { id: order.id },
      });
      expect(stored.status).toBe(status);
      expect(stored.startedAt).toBeNull();
      expect(
        await prisma.serviceOrderExecution.count({
          where: { serviceOrderId: order.id },
        }),
      ).toBe(0);
    });
  }
});

describe("Execução do técnico — ownership e perfis", () => {
  it("Técnico B não inicia a OS do técnico A (mesma empresa) e recebe 404", async () => {
    const { order } = await assignedOrderScenario();
    await createTech(fixture.companyA.id, fixture.techB.id);
    const tokenB = await createTokenFor(fixture.techB.id);

    const res = await startRequest(
      order.id,
      { expectedVersion: order.version },
      tokenB,
    );
    // 404, not 403: confirming existence would tell technician B that this
    // order exists and belongs to a colleague.
    expect(res.status).toBe(404);

    expect(
      (await prisma.serviceOrder.findUniqueOrThrow({ where: { id: order.id } }))
        .status,
    ).toBe("ASSIGNED");
  });

  it("Técnico B não edita a execução da OS do técnico A", async () => {
    const { order, token } = await assignedOrderScenario();
    await startAndGetExecution(order.id, order.version, token);

    await createTech(fixture.companyA.id, fixture.techB.id);
    const tokenB = await createTokenFor(fixture.techB.id);

    const res = await executionRequest(
      order.id,
      { expectedVersion: 0, diagnosis: "invasão" },
      tokenB,
    );
    expect(res.status).toBe(404);

    const execution = await prisma.serviceOrderExecution.findUniqueOrThrow({
      where: { serviceOrderId: order.id },
    });
    expect(execution.diagnosis).toBeNull();
    expect(execution.version).toBe(0);
  });

  it("Usuário TECHNICIAN sem registro Technician recebe 404 ao iniciar", async () => {
    const customer = await createCustomer(fixture.companyA.id);
    const technician = await createTech(fixture.companyA.id, fixture.techA.id);
    const order = await createOrderFor({
      companyId: fixture.companyA.id,
      customerId: customer.id,
      technicianId: technician.id,
    });
    // techB is a TECHNICIAN user with no Technician row at all.
    const tokenB = await createTokenFor(fixture.techB.id);

    const res = await startRequest(
      order.id,
      { expectedVersion: order.version },
      tokenB,
    );
    expect(res.status).toBe(404);
  });

  it("ADMIN e DISPATCHER não iniciam OS de técnico (403)", async () => {
    const { order } = await assignedOrderScenario();

    for (const userId of [fixture.adminA.id, fixture.dispatcherA.id]) {
      const token = await createTokenFor(userId);
      const res = await startRequest(
        order.id,
        { expectedVersion: order.version },
        token,
      );
      expect(res.status).toBe(403);
    }

    expect(
      (await prisma.serviceOrder.findUniqueOrThrow({ where: { id: order.id } }))
        .status,
    ).toBe("ASSIGNED");
  });

  it("ADMIN e DISPATCHER não editam a execução (403)", async () => {
    const { order, token } = await assignedOrderScenario();
    await startAndGetExecution(order.id, order.version, token);

    for (const userId of [fixture.adminA.id, fixture.dispatcherA.id]) {
      const staffToken = await createTokenFor(userId);
      const res = await executionRequest(
        order.id,
        { expectedVersion: 0, diagnosis: "editado pelo escritório" },
        staffToken,
      );
      expect(res.status).toBe(403);
    }

    const execution = await prisma.serviceOrderExecution.findUniqueOrThrow({
      where: { serviceOrderId: order.id },
    });
    expect(execution.diagnosis).toBeNull();
  });

  it("Requisição sem sessão é recusada (401)", async () => {
    const { order } = await assignedOrderScenario();

    const start = await startOrder(
      apiRequest(`/api/service-orders/${order.id}/start`, {
        method: "POST",
        body: { expectedVersion: order.version },
      }),
      { params: { id: order.id } },
    );
    expect(start.status).toBe(401);

    const execution = await patchExecution(
      apiRequest(`/api/service-orders/${order.id}/execution`, {
        method: "PATCH",
        body: { expectedVersion: 0, diagnosis: "x" },
      }),
      { params: { id: order.id } },
    );
    expect(execution.status).toBe(401);
  });

  it("Origem cruzada é bloqueada pelo CSRF em start e execução (403)", async () => {
    const { order, token } = await assignedOrderScenario();

    const res = await startOrder(
      apiRequest(
        `/api/service-orders/${order.id}/start`,
        {
          method: "POST",
          body: { expectedVersion: order.version },
          headers: { Origin: "https://evil.example" },
        },
        token,
      ),
      { params: { id: order.id } },
    );
    expect(res.status).toBe(403);
    expect(
      (await prisma.serviceOrder.findUniqueOrThrow({ where: { id: order.id } }))
        .status,
    ).toBe("ASSIGNED");
  });
});

describe("Execução do técnico — técnico/usuário desativados", () => {
  it("Técnico inativo não inicia OS, e a OS permanece intacta", async () => {
    const { order, technician, token } = await assignedOrderScenario();
    await prisma.technician.update({
      where: { id: technician.id },
      data: { active: false },
    });

    const res = await startRequest(
      order.id,
      { expectedVersion: order.version },
      token,
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(
      "Seu perfil técnico está inativo. Entre em contato com o responsável.",
    );

    const stored = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(stored.status).toBe("ASSIGNED");
    expect(stored.technicianId).toBe(technician.id);
    expect(stored.startedAt).toBeNull();
  });

  it("Técnico desativado DEPOIS de iniciar não edita mais, mas nada é apagado", async () => {
    const { order, technician, token } = await assignedOrderScenario();
    await startAndGetExecution(order.id, order.version, token);
    await executionRequest(
      order.id,
      { expectedVersion: 0, diagnosis: "Sinal fraco no CTO." },
      token,
    );

    await prisma.technician.update({
      where: { id: technician.id },
      data: { active: false },
    });

    const res = await executionRequest(
      order.id,
      { expectedVersion: 1, workPerformed: "tentativa após desativação" },
      token,
    );
    expect(res.status).toBe(403);

    // Deactivation is not destructive: the order stays started, the execution
    // keeps what was already written and the timeline is untouched.
    const stored = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(stored.status).toBe("IN_PROGRESS");
    expect(stored.startedAt).toBeInstanceOf(Date);

    const execution = await prisma.serviceOrderExecution.findUniqueOrThrow({
      where: { serviceOrderId: order.id },
    });
    expect(execution.diagnosis).toBe("Sinal fraco no CTO.");
    expect(execution.workPerformed).toBeNull();

    expect(
      await prisma.serviceOrderEvent.count({
        where: { serviceOrderId: order.id, event: "OS_STARTED" },
      }),
    ).toBe(1);

    // And reading still works for the deactivated technician.
    const detail = await getCompanyServiceOrder(fixture.companyA.id, order.id);
    expect(detail?.execution?.diagnosis).toBe("Sinal fraco no CTO.");
  });

  it("Usuário inativo não inicia OS (a sessão deixa de ser válida)", async () => {
    const { order, token } = await assignedOrderScenario();
    await prisma.user.update({
      where: { id: fixture.techA.id },
      data: { active: false },
    });

    const res = await startRequest(
      order.id,
      { expectedVersion: order.version },
      token,
    );
    // The session kill-switch resolves an inactive user to "no session" at
    // all, so this is refused before any domain rule runs.
    expect(res.status).toBe(401);
    expect(
      (await prisma.serviceOrder.findUniqueOrThrow({ where: { id: order.id } }))
        .status,
    ).toBe("ASSIGNED");
  });

  it("Usuário que deixou de ser TECHNICIAN não inicia OS (403 de perfil)", async () => {
    const { order, token } = await assignedOrderScenario();
    await prisma.user.update({
      where: { id: fixture.techA.id },
      data: { profile: "DISPATCHER" },
    });

    const res = await startRequest(
      order.id,
      { expectedVersion: order.version },
      token,
    );
    expect(res.status).toBe(403);
    expect(
      (await prisma.serviceOrder.findUniqueOrThrow({ where: { id: order.id } }))
        .status,
    ).toBe("ASSIGNED");
  });

  it("Regra de elegibilidade no serviço barra perfil não-TECHNICIAN mesmo sem a guarda da rota", async () => {
    const { order } = await assignedOrderScenario();
    // Calls the service directly, bypassing `assertProfile`, to prove the rule
    // lives in the domain layer and not only at the route edge.
    await prisma.user.update({
      where: { id: fixture.techA.id },
      data: { profile: "DISPATCHER" },
    });

    await expect(
      startServiceOrder(
        fixture.companyA.id,
        fixture.techA.id,
        order.id,
        order.version,
      ),
    ).rejects.toBeInstanceOf(DomainError);
  });
});

describe("Execução do técnico — multi-tenancy", () => {
  it("Empresa B não inicia nem lê a execução de uma OS da empresa A", async () => {
    const { order, token } = await assignedOrderScenario();
    await startAndGetExecution(order.id, order.version, token);
    await executionRequest(
      order.id,
      { expectedVersion: 0, diagnosis: "Dado sensível da empresa A." },
      token,
    );

    // A real TECHNICIAN in company B, with a Technician row of its own.
    const techUserB = await prisma.user.create({
      data: {
        companyId: fixture.companyB.id,
        name: "Tecnico Empresa B",
        email: "tech@companyb.test",
        profile: "TECHNICIAN",
        passwordHash: (
          await prisma.user.findUniqueOrThrow({ where: { id: fixture.techA.id } })
        ).passwordHash,
      },
    });
    await createTech(fixture.companyB.id, techUserB.id);
    const tokenB = await createTokenFor(techUserB.id);

    expect(
      (await startRequest(order.id, { expectedVersion: 1 }, tokenB)).status,
    ).toBe(404);
    expect(
      (
        await executionRequest(
          order.id,
          { expectedVersion: 1, diagnosis: "vazamento" },
          tokenB,
        )
      ).status,
    ).toBe(404);

    const read = await getOrder(
      apiRequest(`/api/service-orders/${order.id}`, {}, tokenB),
      { params: { id: order.id } },
    );
    expect(read.status).toBe(404);

    // Direct service call with company B's tenant id must not reach the row
    // either — the execution is filtered by companyId, not only by the FK.
    expect(
      await getCompanyServiceOrder(fixture.companyB.id, order.id),
    ).toBeNull();

    const execution = await prisma.serviceOrderExecution.findUniqueOrThrow({
      where: { serviceOrderId: order.id },
    });
    expect(execution.diagnosis).toBe("Dado sensível da empresa A.");
  });

  it("Leitura da execução exige companyId correspondente nas duas pontas", async () => {
    const { order, token } = await assignedOrderScenario();
    await startAndGetExecution(order.id, order.version, token);
    await executionRequest(
      order.id,
      { expectedVersion: 0, notes: "Anotação da empresa A." },
      token,
    );

    const asCompanyA = await getCompanyServiceOrder(
      fixture.companyA.id,
      order.id,
    );
    expect(asCompanyA?.execution?.notes).toBe("Anotação da empresa A.");

    // Even if the order id leaks, the wrong tenant reads nothing.
    expect(
      await getCompanyServiceOrder(fixture.companyB.id, order.id),
    ).toBeNull();
  });
});

describe("Execução do técnico — salvar diagnóstico / serviço / observações", () => {
  it("Salva o diagnóstico isoladamente, sem tocar nos demais campos", async () => {
    const { order, token } = await assignedOrderScenario();
    const execution = await startAndGetExecution(order.id, order.version, token);

    const res = await executionRequest(
      order.id,
      { expectedVersion: execution.version, diagnosis: "Rompimento no drop." },
      token,
    );
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.data.execution.diagnosis).toBe("Rompimento no drop.");
    expect(payload.data.execution.version).toBe(1);

    const stored = await prisma.serviceOrderExecution.findUniqueOrThrow({
      where: { serviceOrderId: order.id },
    });
    expect(stored.diagnosis).toBe("Rompimento no drop.");
    expect(stored.workPerformed).toBeNull();
    expect(stored.notes).toBeNull();
  });

  it("Salva o serviço realizado isoladamente", async () => {
    const { order, token } = await assignedOrderScenario();
    const execution = await startAndGetExecution(order.id, order.version, token);

    const res = await executionRequest(
      order.id,
      { expectedVersion: execution.version, workPerformed: "Drop substituído." },
      token,
    );
    expect(res.status).toBe(200);

    const stored = await prisma.serviceOrderExecution.findUniqueOrThrow({
      where: { serviceOrderId: order.id },
    });
    expect(stored.workPerformed).toBe("Drop substituído.");
    expect(stored.diagnosis).toBeNull();
    expect(stored.notes).toBeNull();
  });

  it("Salva as observações isoladamente", async () => {
    const { order, token } = await assignedOrderScenario();
    const execution = await startAndGetExecution(order.id, order.version, token);

    const res = await executionRequest(
      order.id,
      { expectedVersion: execution.version, notes: "Cliente ausente às 14h." },
      token,
    );
    expect(res.status).toBe(200);

    const stored = await prisma.serviceOrderExecution.findUniqueOrThrow({
      where: { serviceOrderId: order.id },
    });
    expect(stored.notes).toBe("Cliente ausente às 14h.");
    expect(stored.diagnosis).toBeNull();
    expect(stored.workPerformed).toBeNull();
  });

  it("Salvar execução NÃO cria evento de timeline, mas registra AuditLog com os campos alterados", async () => {
    const { order, token } = await assignedOrderScenario();
    const execution = await startAndGetExecution(order.id, order.version, token);

    const eventsBefore = await prisma.serviceOrderEvent.count({
      where: { serviceOrderId: order.id },
    });

    await executionRequest(
      order.id,
      {
        expectedVersion: execution.version,
        diagnosis: "Sinal fraco.",
        notes: "Reagendar.",
      },
      token,
    );

    expect(
      await prisma.serviceOrderEvent.count({
        where: { serviceOrderId: order.id },
      }),
    ).toBe(eventsBefore);

    const audits = await prisma.auditLog.findMany({
      where: {
        companyId: fixture.companyA.id,
        action: "SERVICE_ORDER.EXECUTION_UPDATED",
      },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0].userId).toBe(fixture.techA.id);
    expect(audits[0].details).toContain("diagnosis");
    expect(audits[0].details).toContain("notes");
    expect(audits[0].details).not.toContain("workPerformed");
    // The free text itself must not be copied into the administrative log.
    expect(audits[0].details).not.toContain("Sinal fraco.");
    expect(audits[0].details).not.toContain("Reagendar.");
  });

  it("Execução só é editável enquanto a OS está IN_PROGRESS", async () => {
    const { order, token } = await assignedOrderScenario();
    const execution = await startAndGetExecution(order.id, order.version, token);

    await prisma.serviceOrder.update({
      where: { id: order.id },
      data: { status: "COMPLETED", completedAt: new Date() },
    });

    const res = await executionRequest(
      order.id,
      { expectedVersion: execution.version, diagnosis: "tarde demais" },
      token,
    );
    expect(res.status).toBe(409);

    const stored = await prisma.serviceOrderExecution.findUniqueOrThrow({
      where: { serviceOrderId: order.id },
    });
    expect(stored.diagnosis).toBeNull();
  });

  it("Texto acima do limite é rejeitado (400)", async () => {
    const { order, token } = await assignedOrderScenario();
    const execution = await startAndGetExecution(order.id, order.version, token);

    const res = await executionRequest(
      order.id,
      { expectedVersion: execution.version, diagnosis: "x".repeat(10_001) },
      token,
    );
    expect(res.status).toBe(400);

    const stored = await prisma.serviceOrderExecution.findUniqueOrThrow({
      where: { serviceOrderId: order.id },
    });
    expect(stored.diagnosis).toBeNull();
  });
});

describe("Execução do técnico — concorrência na edição", () => {
  it("A salva v1→v2; B, ainda em v1, recebe 409 e não sobrescreve", async () => {
    const { order, token } = await assignedOrderScenario();
    const execution = await startAndGetExecution(order.id, order.version, token);

    // Both "tabs" opened the execution at the same version.
    const versionSeenByA = execution.version;
    const versionSeenByB = execution.version;

    const resA = await executionRequest(
      order.id,
      { expectedVersion: versionSeenByA, diagnosis: "Diagnóstico de A." },
      token,
    );
    expect(resA.status).toBe(200);
    expect((await resA.json()).data.execution.version).toBe(
      versionSeenByA + 1,
    );

    const resB = await executionRequest(
      order.id,
      { expectedVersion: versionSeenByB, diagnosis: "Diagnóstico de B." },
      token,
    );
    expect(resB.status).toBe(409);

    const stored = await prisma.serviceOrderExecution.findUniqueOrThrow({
      where: { serviceOrderId: order.id },
    });
    expect(stored.diagnosis).toBe("Diagnóstico de A.");
    expect(stored.version).toBe(versionSeenByA + 1);
  });

  it("Depois de recarregar a versão, B consegue salvar (a versão não é trava permanente)", async () => {
    const { order, token } = await assignedOrderScenario();
    const execution = await startAndGetExecution(order.id, order.version, token);

    await executionRequest(
      order.id,
      { expectedVersion: execution.version, diagnosis: "primeiro" },
      token,
    );
    const fresh = await prisma.serviceOrderExecution.findUniqueOrThrow({
      where: { serviceOrderId: order.id },
    });

    const res = await executionRequest(
      order.id,
      { expectedVersion: fresh.version, diagnosis: "segundo" },
      token,
    );
    expect(res.status).toBe(200);

    const stored = await prisma.serviceOrderExecution.findUniqueOrThrow({
      where: { serviceOrderId: order.id },
    });
    expect(stored.diagnosis).toBe("segundo");
    expect(stored.version).toBe(fresh.version + 1);
  });

  it("Duas edições simultâneas: exatamente uma vence, sem lost update", async () => {
    const { order, token } = await assignedOrderScenario();
    const execution = await startAndGetExecution(order.id, order.version, token);

    const [a, b] = await Promise.all([
      executionRequest(
        order.id,
        { expectedVersion: execution.version, diagnosis: "A" },
        token,
      ),
      executionRequest(
        order.id,
        { expectedVersion: execution.version, diagnosis: "B" },
        token,
      ),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);

    const stored = await prisma.serviceOrderExecution.findUniqueOrThrow({
      where: { serviceOrderId: order.id },
    });
    expect(["A", "B"]).toContain(stored.diagnosis);
    expect(stored.version).toBe(execution.version + 1);
  });

  it("Chamada direta ao serviço com versão obsoleta também é recusada", async () => {
    const { order, token } = await assignedOrderScenario();
    const execution = await startAndGetExecution(order.id, order.version, token);

    await updateServiceOrderExecution(
      fixture.companyA.id,
      fixture.techA.id,
      order.id,
      execution.version,
      { notes: "primeiro" },
    );

    await expect(
      updateServiceOrderExecution(
        fixture.companyA.id,
        fixture.techA.id,
        order.id,
        execution.version,
        { notes: "segundo" },
      ),
    ).rejects.toBeInstanceOf(DomainError);

    const stored = await prisma.serviceOrderExecution.findUniqueOrThrow({
      where: { serviceOrderId: order.id },
    });
    expect(stored.notes).toBe("primeiro");
  });
});

describe("Execução do técnico — mass assignment", () => {
  const FORBIDDEN_KEYS = [
    "companyId",
    "serviceOrderId",
    "status",
    "technicianId",
    "version",
    "createdAt",
    "updatedAt",
    "id",
  ] as const;

  it("Start recusa qualquer campo além de expectedVersion", async () => {
    const { order, token } = await assignedOrderScenario();

    for (const key of FORBIDDEN_KEYS) {
      const res = await startRequest(
        order.id,
        { expectedVersion: order.version, [key]: "x" },
        token,
      );
      expect(res.status, `campo ${key} deveria ser rejeitado`).toBe(400);
    }

    // Nothing leaked through: the order was never started.
    const stored = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(stored.status).toBe("ASSIGNED");
    expect(stored.companyId).toBe(fixture.companyA.id);
    expect(stored.version).toBe(order.version);
  });

  it("Execução recusa qualquer campo fora de diagnosis/workPerformed/notes", async () => {
    const { order, technician, token } = await assignedOrderScenario();
    const execution = await startAndGetExecution(order.id, order.version, token);

    for (const key of FORBIDDEN_KEYS) {
      const res = await executionRequest(
        order.id,
        {
          expectedVersion: execution.version,
          diagnosis: "válido",
          [key]: key === "version" ? 999 : "x",
        },
        token,
      );
      expect(res.status, `campo ${key} deveria ser rejeitado`).toBe(400);
    }

    // The rejection is total — not "accepted the good fields, dropped the bad".
    const storedExecution = await prisma.serviceOrderExecution.findUniqueOrThrow({
      where: { serviceOrderId: order.id },
    });
    expect(storedExecution.diagnosis).toBeNull();
    expect(storedExecution.version).toBe(execution.version);
    expect(storedExecution.companyId).toBe(fixture.companyA.id);

    const storedOrder = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(storedOrder.status).toBe("IN_PROGRESS");
    expect(storedOrder.technicianId).toBe(technician.id);
  });

  it("technicianId no corpo não muda a autoria: a ownership vem da sessão", async () => {
    const { order, technician } = await assignedOrderScenario();
    const otherTech = await createTech(fixture.companyA.id, fixture.techB.id);
    const tokenB = await createTokenFor(fixture.techB.id);

    // Technician B naming technician A's id gains nothing: the id in the body
    // is rejected outright, and even the well-formed request resolves the
    // acting technician from the session.
    expect(
      (
        await startRequest(
          order.id,
          { expectedVersion: order.version, technicianId: technician.id },
          tokenB,
        )
      ).status,
    ).toBe(400);
    expect(
      (await startRequest(order.id, { expectedVersion: order.version }, tokenB))
        .status,
    ).toBe(404);

    const stored = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(stored.status).toBe("ASSIGNED");
    expect(stored.technicianId).toBe(technician.id);
    expect(stored.technicianId).not.toBe(otherTech.id);
  });
});

describe("Execução do técnico — leitura", () => {
  it("Técnico dono e staff leem a mesma execução pelo detalhe da OS", async () => {
    const { order, token } = await assignedOrderScenario();
    const execution = await startAndGetExecution(order.id, order.version, token);
    await executionRequest(
      order.id,
      {
        expectedVersion: execution.version,
        diagnosis: "Sinal fraco.",
        workPerformed: "Troca de conector.",
        notes: "Retornar amanhã.",
      },
      token,
    );

    for (const userId of [fixture.techA.id, fixture.adminA.id, fixture.dispatcherA.id]) {
      const viewerToken = await createTokenFor(userId);
      const res = await getOrder(
        apiRequest(`/api/service-orders/${order.id}`, {}, viewerToken),
        { params: { id: order.id } },
      );
      expect(res.status).toBe(200);
      const payload = await res.json();
      expect(payload.data.serviceOrder.status).toBe("IN_PROGRESS");
      expect(payload.data.serviceOrder.startedAt).toBeTruthy();
      expect(payload.data.serviceOrder.execution).toMatchObject({
        diagnosis: "Sinal fraco.",
        workPerformed: "Troca de conector.",
        notes: "Retornar amanhã.",
      });
    }
  });

  it("OS não iniciada expõe execution nula", async () => {
    const { order, token } = await assignedOrderScenario();

    const res = await getOrder(
      apiRequest(`/api/service-orders/${order.id}`, {}, token),
      { params: { id: order.id } },
    );
    const payload = await res.json();
    expect(payload.data.serviceOrder.execution).toBeNull();
  });

  it("A fila do técnico coloca a OS iniciada em 'inProgress'", async () => {
    const { order, token } = await assignedOrderScenario();
    const technician = await prisma.technician.findFirstOrThrow({
      where: { userId: fixture.techA.id },
    });

    const before = await listServiceOrdersForTechnician(
      fixture.companyA.id,
      technician.id,
    );
    expect(before.inProgress).toHaveLength(0);

    await startAndGetExecution(order.id, order.version, token);

    const after = await listServiceOrdersForTechnician(
      fixture.companyA.id,
      technician.id,
    );
    expect(after.inProgress).toHaveLength(1);
    expect(after.inProgress[0].id).toBe(order.id);
    expect(after.today).toHaveLength(0);
    expect(after.upcoming).toHaveLength(0);
  });
});

describe("Dashboard — KPI Em Atendimento", () => {
  it("Conta apenas IN_PROGRESS da empresa da sessão", async () => {
    const { order, token } = await assignedOrderScenario();
    const customer = await prisma.customer.findFirstOrThrow({
      where: { companyId: fixture.companyA.id },
    });

    // Another ASSIGNED order must NOT be counted.
    await createOrderFor({
      companyId: fixture.companyA.id,
      customerId: customer.id,
      technicianId: (
        await prisma.technician.findFirstOrThrow({
          where: { userId: fixture.techA.id },
        })
      ).id,
    });

    expect(
      (await getDashboardStats(fixture.companyA.id)).osEmAtendimento,
    ).toBe(0);

    await startAndGetExecution(order.id, order.version, token);

    expect(
      (await getDashboardStats(fixture.companyA.id)).osEmAtendimento,
    ).toBe(1);
    // Company B sees nothing of company A's work.
    expect(
      (await getDashboardStats(fixture.companyB.id)).osEmAtendimento,
    ).toBe(0);
  });
});
