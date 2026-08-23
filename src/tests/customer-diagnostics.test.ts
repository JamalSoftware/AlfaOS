import { describe, it, expect, beforeEach } from "vitest";
import {
  GET as getDiagnostic,
  POST as refreshDiagnostic,
} from "@/app/api/service-orders/[id]/diagnostic/route";
import { prisma } from "@/lib/prisma";
import {
  getCustomerDiagnostic,
  refreshCustomerDiagnostic,
} from "@/lib/customer-diagnostics";
import { MockERPAdapter } from "@/integrations/MockERPAdapter";
import { ReceitanetAdapter } from "@/integrations/ReceitanetAdapter";
import {
  supportsDiagnostics,
  withIntegrationTimeout,
} from "@/integrations/diagnostics";
import { IntegrationError, isIntegrationError } from "@/integrations/errors";
import {
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
// Fixtures
// ---------------------------------------------------------------------------

async function enableMock(companyId: string) {
  return prisma.eRPIntegration.create({
    data: { companyId, provider: "MOCK", name: "Mock ERP", enabled: true },
  });
}

async function customerWith(companyId: string, externalId: string | null) {
  return prisma.customer.create({
    data: {
      companyId,
      name: "Cliente Diagnóstico",
      document: "123.456.789-01",
      externalProvider: externalId ? "MOCK" : null,
      externalId,
    },
  });
}

async function orderFor(options: {
  companyId: string;
  customerId: string;
  technicianId?: string | null;
}) {
  return prisma.serviceOrder.create({
    data: {
      companyId: options.companyId,
      customerId: options.customerId,
      technicianId: options.technicianId ?? null,
      type: "Suporte",
      description: "diagnóstico",
      status: options.technicianId ? "ASSIGNED" : "PENDING",
      assignedAt: options.technicianId ? new Date() : null,
    },
  });
}

async function techFor(companyId: string, userId: string) {
  return prisma.technician.upsert({
    where: { userId },
    update: {},
    create: { companyId, userId },
  });
}

// ---------------------------------------------------------------------------
// Contract conformance — same normalized model from every provider
// ---------------------------------------------------------------------------

describe("Conformidade do contrato de diagnóstico", () => {
  it("MockERP e ReceitaNet declaram a capability de diagnóstico", () => {
    expect(supportsDiagnostics(new MockERPAdapter())).toBe(true);
    expect(
      supportsDiagnostics(
        new ReceitanetAdapter({ token: "t", fetchImpl: async () => ({
          ok: true,
          status: 200,
          text: async () => "{}",
        }) }),
      ),
    ).toBe(true);
  });

  it("MockERP retorna apenas status do modelo normalizado", async () => {
    const mock = new MockERPAdapter();
    for (const externalId of ["MOCK-CUST-1", "MOCK-CUST-2", "MOCK-CUST-3"]) {
      const obs = await mock.fetchCustomerConnectivity({
        externalId,
        document: null,
        name: "x",
      });
      expect(["ONLINE", "OFFLINE", "UNKNOWN"]).toContain(obs.status);
      expect(
        obs.sourceUpdatedAt === null || obs.sourceUpdatedAt instanceof Date,
      ).toBe(true);
    }
  });

  it("ReceitaNet sem identificador do provider não inventa estado", async () => {
    // Substitui o antigo teste de NOT_SUPPORTED: a capability agora é real
    // (v0.6), mas continua valendo que ela NUNCA fabrica um estado.
    const adapter = new ReceitanetAdapter({
      token: "t",
      fetchImpl: async () => {
        throw new Error("a rede não deveria ser tocada");
      },
    });
    await expect(
      adapter.fetchCustomerConnectivity({
        externalId: null,
        document: null,
        name: "x",
      }),
    ).rejects.toSatisfy(
      (e: unknown) => isIntegrationError(e) && e.code === "CUSTOMER_NOT_FOUND",
    );
  });

  it("cliente desconhecido pelo provider resolve UNKNOWN, não CUSTOMER_NOT_FOUND", async () => {
    const obs = await new MockERPAdapter().fetchCustomerConnectivity({
      externalId: "NAO-EXISTE",
      document: null,
      name: "x",
    });
    expect(obs.status).toBe("UNKNOWN");
  });
});

// ---------------------------------------------------------------------------
// The core invariant: error != OFFLINE
// ---------------------------------------------------------------------------

describe("Falha de integração nunca vira OFFLINE", () => {
  it("upstream indisponível => ok:false, status NÃO gravado", async () => {
    await enableMock(fixture.companyA.id);
    const customer = await customerWith(fixture.companyA.id, "MOCK-CUST-FAIL");

    const result = await refreshCustomerDiagnostic(
      fixture.companyA.id,
      fixture.adminA.id,
      customer.id,
    );

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("UPSTREAM_UNAVAILABLE");
    expect(result.snapshot).toBeNull();
    // Nothing persisted at all — least of all OFFLINE.
    expect(
      await prisma.customerDiagnosticSnapshot.count({
        where: { customerId: customer.id },
      }),
    ).toBe(0);
  });

  it("payload inválido => INVALID_RESPONSE, nada gravado", async () => {
    await enableMock(fixture.companyA.id);
    const customer = await customerWith(fixture.companyA.id, "MOCK-CUST-INVALID");
    const result = await refreshCustomerDiagnostic(
      fixture.companyA.id,
      fixture.adminA.id,
      customer.id,
    );
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("INVALID_RESPONSE");
    expect(
      await prisma.customerDiagnosticSnapshot.count({
        where: { customerId: customer.id },
      }),
    ).toBe(0);
  });

  it("timeout => TIMEOUT, nada gravado", async () => {
    await enableMock(fixture.companyA.id);
    const customer = await customerWith(fixture.companyA.id, "MOCK-CUST-TIMEOUT");
    // The adapter never settles; the call-site deadline is what ends this.
    const result = await withIntegrationTimeout(
      refreshCustomerDiagnostic(
        fixture.companyA.id,
        fixture.adminA.id,
        customer.id,
      ),
      "TEST",
      30_000,
    );
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("TIMEOUT");
    expect(
      await prisma.customerDiagnosticSnapshot.count({
        where: { customerId: customer.id },
      }),
    ).toBe(0);
  }, 30_000);

  /**
   * Antes da v0.6 este caminho devolvia NOT_SUPPORTED, porque o
   * `ReceitanetAdapter` recusava tudo. Agora a capability é real e o adapter
   * exige credencial — sem ela, a resposta correta é AUTHENTICATION_FAILED,
   * que diz ao operador o que de fato está faltando.
   *
   * O que NÃO mudou, e é o ponto do bloco: a falha continua não virando
   * OFFLINE e continua não gravando snapshot.
   */
  it("ReceitaNet sem credencial => AUTHENTICATION_FAILED, nada gravado", async () => {
    await prisma.eRPIntegration.create({
      data: {
        companyId: fixture.companyA.id,
        provider: "RECEITANET",
        name: "ReceitaNet",
        enabled: true,
      },
    });
    const customer = await customerWith(fixture.companyA.id, "QUALQUER");
    const result = await refreshCustomerDiagnostic(
      fixture.companyA.id,
      fixture.adminA.id,
      customer.id,
    );
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("AUTHENTICATION_FAILED");
    // A garantia que importa: falha de integração NUNCA vira estado.
    expect(result.snapshot).toBeNull();
    expect(
      await prisma.customerDiagnosticSnapshot.count({
        where: { customerId: customer.id },
      }),
    ).toBe(0);
  });

  it("nenhuma integração habilitada => NOT_SUPPORTED, sem fallback silencioso para o mock", async () => {
    const customer = await customerWith(fixture.companyA.id, "MOCK-CUST-1");
    const result = await refreshCustomerDiagnostic(
      fixture.companyA.id,
      fixture.adminA.id,
      customer.id,
    );
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("NOT_SUPPORTED");
    expect(result.snapshot).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Snapshot preservation
// ---------------------------------------------------------------------------

describe("Snapshot", () => {
  it("grava observação válida e devolve o modelo normalizado", async () => {
    await enableMock(fixture.companyA.id);
    const customer = await customerWith(fixture.companyA.id, "MOCK-CUST-1");

    const result = await refreshCustomerDiagnostic(
      fixture.companyA.id,
      fixture.adminA.id,
      customer.id,
    );

    expect(result.ok).toBe(true);
    expect(result.snapshot?.connectivityStatus).toBe("ONLINE");
    expect(result.snapshot?.provider).toBe("MOCK");
    expect(result.snapshot?.observedAt).toBeInstanceOf(Date);

    const audit = await prisma.auditLog.findFirst({
      where: {
        action: "CUSTOMER_DIAGNOSTIC.REFRESHED",
        entityId: customer.id,
      },
    });
    expect(audit).not.toBeNull();
    // No document, no phone, no payload in the trail.
    expect(audit?.details ?? "").not.toContain("123.456.789-01");
  });

  it("erro posterior NÃO sobrescreve um snapshot válido", async () => {
    await enableMock(fixture.companyA.id);
    // First observe ONLINE, then repoint the same customer at the failing id.
    const customer = await customerWith(fixture.companyA.id, "MOCK-CUST-1");
    await refreshCustomerDiagnostic(
      fixture.companyA.id,
      fixture.adminA.id,
      customer.id,
    );
    await prisma.customer.update({
      where: { id: customer.id },
      data: { externalId: "MOCK-CUST-FAIL" },
    });

    const result = await refreshCustomerDiagnostic(
      fixture.companyA.id,
      fixture.adminA.id,
      customer.id,
    );

    expect(result.ok).toBe(false);
    // The previous truth survives and is handed back for the "last known" line.
    expect(result.snapshot?.connectivityStatus).toBe("ONLINE");
    const stored = await prisma.customerDiagnosticSnapshot.findFirstOrThrow({
      where: { customerId: customer.id },
    });
    expect(stored.connectivityStatus).toBe("ONLINE");
  });

  it("observação mais antiga do provider não regride uma mais nova", async () => {
    await enableMock(fixture.companyA.id);
    const customer = await customerWith(fixture.companyA.id, "MOCK-CUST-2");
    await refreshCustomerDiagnostic(
      fixture.companyA.id,
      fixture.adminA.id,
      customer.id,
    );

    // Force the stored sourceUpdatedAt to be NEWER than what the mock reports.
    const future = new Date(Date.now() + 60 * 60_000);
    await prisma.customerDiagnosticSnapshot.updateMany({
      where: { customerId: customer.id },
      data: { sourceUpdatedAt: future, connectivityStatus: "ONLINE" },
    });

    const result = await refreshCustomerDiagnostic(
      fixture.companyA.id,
      fixture.adminA.id,
      customer.id,
    );
    expect(result.ok).toBe(true);
    // The older provider observation must not clobber the newer one.
    expect(result.snapshot?.connectivityStatus).toBe("ONLINE");
  });

  it("refreshes concorrentes não corrompem nem duplicam o snapshot", async () => {
    await enableMock(fixture.companyA.id);
    const customer = await customerWith(fixture.companyA.id, "MOCK-CUST-1");

    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        refreshCustomerDiagnostic(
          fixture.companyA.id,
          fixture.adminA.id,
          customer.id,
        ),
      ),
    );
    // Upsert on the composite key: concurrent writers converge on one row.
    //
    // `every`, not `some`: refresh is not a compare-and-set where one writer
    // must lose — all of them should succeed. A probe of 96 concurrent
    // invocations (N=4, 8 and 12) produced zero rejections, so tolerating a
    // failure here would only hide an unrelated regression.
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    // And the invariant that actually matters: still exactly one snapshot.
    expect(
      await prisma.customerDiagnosticSnapshot.count({
        where: { customerId: customer.id },
      }),
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Provider identity
// ---------------------------------------------------------------------------

describe("Identidade por provider", () => {
  it("mesmo externalId em empresas diferentes são entidades distintas", async () => {
    await enableMock(fixture.companyA.id);
    await enableMock(fixture.companyB.id);
    const a = await customerWith(fixture.companyA.id, "MOCK-CUST-1");
    const b = await customerWith(fixture.companyB.id, "MOCK-CUST-1");
    expect(a.id).not.toBe(b.id);

    await refreshCustomerDiagnostic(fixture.companyA.id, fixture.adminA.id, a.id);

    // A's observation must not appear under B.
    expect(await getCustomerDiagnostic(fixture.companyB.id, b.id)).toBeNull();
    expect(
      (await getCustomerDiagnostic(fixture.companyA.id, a.id))
        ?.connectivityStatus,
    ).toBe("ONLINE");
  });
});

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

describe("Autorização e multi-tenancy", () => {
  it("sem sessão => 401", async () => {
    const customer = await customerWith(fixture.companyA.id, "MOCK-CUST-1");
    const order = await orderFor({
      companyId: fixture.companyA.id,
      customerId: customer.id,
    });
    const res = await getDiagnostic(
      apiRequest(`/api/service-orders/${order.id}/diagnostic`, {}),
      { params: { id: order.id } },
    );
    expect(res.status).toBe(401);
  });

  it("empresa B não lê nem atualiza diagnóstico de OS da empresa A => 404", async () => {
    await enableMock(fixture.companyA.id);
    const customer = await customerWith(fixture.companyA.id, "MOCK-CUST-1");
    const order = await orderFor({
      companyId: fixture.companyA.id,
      customerId: customer.id,
    });
    await refreshCustomerDiagnostic(
      fixture.companyA.id,
      fixture.adminA.id,
      customer.id,
    );

    const tokenB = await createTokenFor(fixture.adminB.id);
    const read = await getDiagnostic(
      apiRequest(`/api/service-orders/${order.id}/diagnostic`, {}, tokenB),
      { params: { id: order.id } },
    );
    expect(read.status).toBe(404);
    expect(await read.text()).not.toContain("ONLINE");

    const refresh = await refreshDiagnostic(
      apiRequest(
        `/api/service-orders/${order.id}/diagnostic`,
        { method: "POST", body: {} },
        tokenB,
      ),
      { params: { id: order.id } },
    );
    expect(refresh.status).toBe(404);
  });

  it("técnico não-dono não acessa o diagnóstico da OS alheia => 404", async () => {
    await enableMock(fixture.companyA.id);
    const techA = await techFor(fixture.companyA.id, fixture.techA.id);
    await techFor(fixture.companyA.id, fixture.techB.id);
    const customer = await customerWith(fixture.companyA.id, "MOCK-CUST-1");
    const order = await orderFor({
      companyId: fixture.companyA.id,
      customerId: customer.id,
      technicianId: techA.id,
    });
    await refreshCustomerDiagnostic(
      fixture.companyA.id,
      fixture.adminA.id,
      customer.id,
    );

    const tokenB = await createTokenFor(fixture.techB.id);
    const read = await getDiagnostic(
      apiRequest(`/api/service-orders/${order.id}/diagnostic`, {}, tokenB),
      { params: { id: order.id } },
    );
    expect(read.status).toBe(404);
    const body = await read.text();
    expect(body).not.toContain("ONLINE");
    expect(body).not.toContain("MOCK");

    const refresh = await refreshDiagnostic(
      apiRequest(
        `/api/service-orders/${order.id}/diagnostic`,
        { method: "POST", body: {} },
        tokenB,
      ),
      { params: { id: order.id } },
    );
    expect(refresh.status).toBe(404);
  });

  it("técnico dono lê e atualiza o diagnóstico da própria OS (controle positivo)", async () => {
    await enableMock(fixture.companyA.id);
    const techA = await techFor(fixture.companyA.id, fixture.techA.id);
    const customer = await customerWith(fixture.companyA.id, "MOCK-CUST-1");
    const order = await orderFor({
      companyId: fixture.companyA.id,
      customerId: customer.id,
      technicianId: techA.id,
    });
    const token = await createTokenFor(fixture.techA.id);

    const refresh = await refreshDiagnostic(
      apiRequest(
        `/api/service-orders/${order.id}/diagnostic`,
        { method: "POST", body: {} },
        token,
      ),
      { params: { id: order.id } },
    );
    expect(refresh.status).toBe(200);
    const payload = await refresh.json();
    expect(payload.data.ok).toBe(true);
    expect(payload.data.diagnostic.connectivityStatus).toBe("ONLINE");

    const read = await getDiagnostic(
      apiRequest(`/api/service-orders/${order.id}/diagnostic`, {}, token),
      { params: { id: order.id } },
    );
    expect(read.status).toBe(200);
  });

  it("ADMIN da própria empresa lê e atualiza", async () => {
    await enableMock(fixture.companyA.id);
    const customer = await customerWith(fixture.companyA.id, "MOCK-CUST-2");
    const order = await orderFor({
      companyId: fixture.companyA.id,
      customerId: customer.id,
    });
    const token = await createTokenFor(fixture.adminA.id);
    const res = await refreshDiagnostic(
      apiRequest(
        `/api/service-orders/${order.id}/diagnostic`,
        { method: "POST", body: {} },
        token,
      ),
      { params: { id: order.id } },
    );
    expect(res.status).toBe(200);
    expect((await res.json()).data.diagnostic.connectivityStatus).toBe("OFFLINE");
  });
});

// ---------------------------------------------------------------------------
// Request hardening
// ---------------------------------------------------------------------------

describe("Contrato da rota", () => {
  async function scenario() {
    await enableMock(fixture.companyA.id);
    const customer = await customerWith(fixture.companyA.id, "MOCK-CUST-1");
    const order = await orderFor({
      companyId: fixture.companyA.id,
      customerId: customer.id,
    });
    return { customer, order, token: await createTokenFor(fixture.adminA.id) };
  }

  it("mass assignment é rejeitado", async () => {
    const s = await scenario();
    const banned = [
      "customerId",
      "companyId",
      "externalProvider",
      "externalId",
      "technicianId",
      "connectivityStatus",
      "observedAt",
      "sourceUpdatedAt",
      "provider",
    ];
    for (const field of banned) {
      const res = await refreshDiagnostic(
        apiRequest(
          `/api/service-orders/${s.order.id}/diagnostic`,
          { method: "POST", body: { [field]: "evil" } },
          s.token,
        ),
        { params: { id: s.order.id } },
      );
      expect(res.status, `campo ${field}`).toBe(400);
    }
    // Nothing was written by any of those attempts.
    expect(
      await prisma.customerDiagnosticSnapshot.count({
        where: { customerId: s.customer.id },
      }),
    ).toBe(0);
  });

  it("Origin de terceiro => 403 no refresh", async () => {
    const s = await scenario();
    const res = await refreshDiagnostic(
      apiRequest(
        `/api/service-orders/${s.order.id}/diagnostic`,
        {
          method: "POST",
          body: {},
          headers: { Origin: "https://evil.test" },
        },
        s.token,
      ),
      { params: { id: s.order.id } },
    );
    expect(res.status).toBe(403);
  });

  it("mensagens de erro não vazam segredos nem internals do provider", async () => {
    await enableMock(fixture.companyA.id);
    const customer = await customerWith(fixture.companyA.id, "MOCK-CUST-FAIL");
    const order = await orderFor({
      companyId: fixture.companyA.id,
      customerId: customer.id,
    });
    const token = await createTokenFor(fixture.adminA.id);
    const res = await refreshDiagnostic(
      apiRequest(
        `/api/service-orders/${order.id}/diagnostic`,
        { method: "POST", body: {} },
        token,
      ),
      { params: { id: order.id } },
    );
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toMatch(/https?:\/\//);
    expect(text).not.toMatch(/token|apiKey|Authorization|Bearer/i);
    expect(text).not.toMatch(/at .*\.ts:\d+/); // no stack frames
  });
});

// ---------------------------------------------------------------------------
// Operational invariant: a broken ERP must not break AlfaOS
// ---------------------------------------------------------------------------

describe("Falha do ERP não bloqueia a operação", () => {
  it("erro de diagnóstico não impede iniciar nem concluir a OS", async () => {
    await enableMock(fixture.companyA.id);
    const techA = await techFor(fixture.companyA.id, fixture.techA.id);
    const customer = await customerWith(fixture.companyA.id, "MOCK-CUST-FAIL");
    const order = await orderFor({
      companyId: fixture.companyA.id,
      customerId: customer.id,
      technicianId: techA.id,
    });

    const failed = await refreshCustomerDiagnostic(
      fixture.companyA.id,
      fixture.techA.id,
      customer.id,
    );
    expect(failed.ok).toBe(false);

    // The order lifecycle is untouched by the integration failure.
    const { startServiceOrder, updateServiceOrderExecution } = await import(
      "@/lib/service-orders"
    );
    const started = await startServiceOrder(
      fixture.companyA.id,
      fixture.techA.id,
      order.id,
      order.version,
    );
    expect(started.serviceOrder.status).toBe("IN_PROGRESS");

    const saved = await updateServiceOrderExecution(
      fixture.companyA.id,
      fixture.techA.id,
      order.id,
      started.execution.version,
      { diagnosis: "d", workPerformed: "w" },
    );
    expect(saved.diagnosis).toBe("d");

    const { completeServiceOrder } = await import("@/lib/service-order-closing");
    const fresh = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: order.id },
    });
    await completeServiceOrder(fixture.companyA.id, fixture.techA.id, order.id, {
      expectedOrderVersion: fresh.version,
      expectedExecutionVersion: saved.version,
    });
    const done = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(done.status).toBe("COMPLETED");
  });
});

// ---------------------------------------------------------------------------
// Timeout helper
// ---------------------------------------------------------------------------

describe("withIntegrationTimeout", () => {
  it("rejeita com TIMEOUT quando a promessa não resolve", async () => {
    await expect(
      withIntegrationTimeout(new Promise(() => {}), "TEST", 50),
    ).rejects.toSatisfy(
      (e: unknown) => isIntegrationError(e) && e.code === "TIMEOUT",
    );
  });

  it("passa o valor adiante quando resolve a tempo", async () => {
    await expect(
      withIntegrationTimeout(Promise.resolve("ok"), "TEST", 1000),
    ).resolves.toBe("ok");
  });

  it("propaga IntegrationError original sem transformá-la em TIMEOUT", async () => {
    await expect(
      withIntegrationTimeout(
        Promise.reject(new IntegrationError("RATE_LIMITED", "TEST")),
        "TEST",
        1000,
      ),
    ).rejects.toSatisfy(
      (e: unknown) => isIntegrationError(e) && e.code === "RATE_LIMITED",
    );
  });
});
