import { describe, it, expect, beforeEach } from "vitest";
import {
  POST as createOrder,
  GET as listOrders,
} from "@/app/api/service-orders/route";
import { GET as getOrder } from "@/app/api/service-orders/[id]/route";
import { POST as assignOrder } from "@/app/api/service-orders/[id]/assign/route";
import { POST as syncOrders } from "@/app/api/integrations/sync/route";
import { prisma } from "@/lib/prisma";
import { assignTechnician } from "@/lib/service-orders";
import { DomainError } from "@/lib/errors";
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

async function enableMockERP(companyId: string): Promise<void> {
  await prisma.eRPIntegration.upsert({
    where: { companyId },
    update: { enabled: true, provider: "MOCK" },
    create: { companyId, provider: "MOCK", name: "Mock ERP", enabled: true },
  });
}

async function createTech(
  companyId: string,
  userId: string,
): Promise<{ id: string }> {
  return prisma.technician.create({ data: { companyId, userId } });
}

async function createManualOrder(
  token: string,
  customerId: string,
): Promise<string> {
  const res = await createOrder(
    apiRequest(
      "/api/service-orders",
      {
        method: "POST",
        body: {
          customerId,
          type: "Instalação",
          description: "Instalação de fibra óptica.",
          priority: "NORMAL",
        },
      },
      token,
    ),
  );
  expect(res.status).toBe(201);
  const payload = await res.json();
  return payload.data.serviceOrder.id;
}

describe("Ordens de serviço", () => {
  it("Cria OS manual com status PENDING e evento na timeline", async () => {
    const token = await createTokenFor(fixture.adminA.id);
    const customer = await prisma.customer.create({
      data: { companyId: fixture.companyA.id, name: "Cliente A" },
    });

    const id = await createManualOrder(token, customer.id);

    const detail = await getOrder(
      apiRequest(`/api/service-orders/${id}`, {}, token),
      { params: { id } },
    );
    expect(detail.status).toBe(200);
    const payload = await detail.json();
    expect(payload.data.serviceOrder.status).toBe("PENDING");
    expect(payload.data.serviceOrder.source).toBe("MANUAL");
    expect(payload.data.serviceOrder.events).toHaveLength(1);
    expect(payload.data.serviceOrder.events[0].event).toBe(
      "SERVICE_ORDER_CREATED",
    );
  });

  it("Mass assignment é bloqueado ao criar OS", async () => {
    const token = await createTokenFor(fixture.adminA.id);
    const customer = await prisma.customer.create({
      data: { companyId: fixture.companyA.id, name: "Cliente A" },
    });

    const res = await createOrder(
      apiRequest(
        "/api/service-orders",
        {
          method: "POST",
          body: {
            customerId: customer.id,
            type: "Manutenção",
            description: "Sem conexão.",
            status: "COMPLETED",
            companyId: fixture.companyB.id,
            technicianId: "fake-id",
          },
        },
        token,
      ),
    );
    expect(res.status).toBe(400);
    const count = await prisma.serviceOrder.count();
    expect(count).toBe(0);
  });

  it("OS manual exige cliente da mesma empresa (404)", async () => {
    const token = await createTokenFor(fixture.adminA.id);
    const customerB = await prisma.customer.create({
      data: { companyId: fixture.companyB.id, name: "Cliente B" },
    });

    const res = await createOrder(
      apiRequest(
        "/api/service-orders",
        {
          method: "POST",
          body: {
            customerId: customerB.id,
            type: "Manutenção",
            description: "Sem conexão.",
          },
        },
        token,
      ),
    );
    expect(res.status).toBe(404);
  });

  it("Sync do Mock ERP cria 3 OS e segunda sync não duplica", async () => {
    await enableMockERP(fixture.companyA.id);
    const token = await createTokenFor(fixture.adminA.id);

    const first = await syncOrders(apiRequest("/api/integrations/sync", { method: "POST" }, token));
    expect(first.status).toBe(200);
    let payload = await first.json();
    expect(payload.data.sync.fetched).toBe(3);
    expect(payload.data.sync.created).toBe(3);
    expect(payload.data.sync.updated).toBe(0);

    const imported = await prisma.serviceOrder.findMany({
      where: { companyId: fixture.companyA.id, source: "IMPORTED" },
    });
    expect(imported).toHaveLength(3);
    for (const order of imported) {
      expect(order.status).toBe("PENDING");
      expect(order.externalNumber).not.toBeNull();
    }

    const second = await syncOrders(apiRequest("/api/integrations/sync", { method: "POST" }, token));
    payload = await second.json();
    expect(payload.data.sync.created).toBe(0);
    expect(payload.data.sync.updated).toBe(3);

    const total = await prisma.serviceOrder.count({
      where: { companyId: fixture.companyA.id },
    });
    expect(total).toBe(3);
  });

  it("Reimportação não sobrescreve technician_id, status nem timeline", async () => {
    await enableMockERP(fixture.companyA.id);
    const token = await createTokenFor(fixture.adminA.id);
    await syncOrders(apiRequest("/api/integrations/sync", { method: "POST" }, token));

    const tech = await createTech(fixture.companyA.id, fixture.techA.id);

    const os = await prisma.serviceOrder.findFirst({
      where: { companyId: fixture.companyA.id, externalNumber: "10001" },
    });
    expect(os).not.toBeNull();

    const assignRes = await assignOrder(
      apiRequest(
        `/api/service-orders/${os!.id}/assign`,
        { method: "POST", body: { technicianId: tech.id } },
        token,
      ),
      { params: { id: os!.id } },
    );
    expect(assignRes.status).toBe(200);

    await syncOrders(apiRequest("/api/integrations/sync", { method: "POST" }, token));

    const after = await prisma.serviceOrder.findUnique({
      where: { id: os!.id },
    });
    expect(after?.status).toBe("ASSIGNED");
    expect(after?.technicianId).toBe(tech.id);

    const events = await prisma.serviceOrderEvent.findMany({
      where: { serviceOrderId: os!.id },
      orderBy: { createdAt: "asc" },
    });
    expect(events.map((e) => e.event)).toEqual([
      "SERVICE_ORDER_IMPORTED",
      "TECHNICIAN_ASSIGNED",
    ]);
  });

  it("Atribui OS e registra TECHNICIAN_ASSIGNED na timeline", async () => {
    const token = await createTokenFor(fixture.adminA.id);
    const customer = await prisma.customer.create({
      data: { companyId: fixture.companyA.id, name: "Cliente A" },
    });
    const id = await createManualOrder(token, customer.id);
    const tech = await createTech(fixture.companyA.id, fixture.techA.id);

    const res = await assignOrder(
      apiRequest(
        `/api/service-orders/${id}/assign`,
        { method: "POST", body: { technicianId: tech.id } },
        token,
      ),
      { params: { id } },
    );
    expect(res.status).toBe(200);

    const detail = await getOrder(apiRequest(`/api/service-orders/${id}`, {}, token), {
      params: { id },
    });
    const payload = await detail.json();
    const order = payload.data.serviceOrder;
    expect(order.status).toBe("ASSIGNED");
    expect(order.technician.id).toBe(tech.id);
    expect(order.assignedAt).not.toBeNull();

    const events = order.events.map((e: { event: string }) => e.event);
    expect(events).toContain("TECHNICIAN_ASSIGNED");
  });

  it("Troca de técnico registra TECHNICIAN_CHANGED e mantém status ASSIGNED", async () => {
    const token = await createTokenFor(fixture.adminA.id);
    const customer = await prisma.customer.create({
      data: { companyId: fixture.companyA.id, name: "Cliente A" },
    });
    const id = await createManualOrder(token, customer.id);
    const techA = await createTech(fixture.companyA.id, fixture.techA.id);
    const techB = await createTech(fixture.companyA.id, fixture.techB.id);

    await assignOrder(
      apiRequest(
        `/api/service-orders/${id}/assign`,
        { method: "POST", body: { technicianId: techA.id } },
        token,
      ),
      { params: { id } },
    );

    const changeRes = await assignOrder(
      apiRequest(
        `/api/service-orders/${id}/assign`,
        { method: "POST", body: { technicianId: techB.id } },
        token,
      ),
      { params: { id } },
    );
    expect(changeRes.status).toBe(200);

    const detail = await getOrder(apiRequest(`/api/service-orders/${id}`, {}, token), {
      params: { id },
    });
    const payload = await detail.json();
    const order = payload.data.serviceOrder;
    expect(order.status).toBe("ASSIGNED");
    expect(order.technician.id).toBe(techB.id);

    const events = order.events.map((e: { event: string }) => e.event);
    expect(events).toEqual([
      "SERVICE_ORDER_CREATED",
      "TECHNICIAN_ASSIGNED",
      "TECHNICIAN_CHANGED",
    ]);
  });

  it("Não atribui a OS já atribuída ao mesmo técnico (409)", async () => {
    const token = await createTokenFor(fixture.adminA.id);
    const customer = await prisma.customer.create({
      data: { companyId: fixture.companyA.id, name: "Cliente A" },
    });
    const id = await createManualOrder(token, customer.id);
    const tech = await createTech(fixture.companyA.id, fixture.techA.id);

    await assignOrder(
      apiRequest(
        `/api/service-orders/${id}/assign`,
        { method: "POST", body: { technicianId: tech.id } },
        token,
      ),
      { params: { id } },
    );

    const again = await assignOrder(
      apiRequest(
        `/api/service-orders/${id}/assign`,
        { method: "POST", body: { technicianId: tech.id } },
        token,
      ),
      { params: { id } },
    );
    expect(again.status).toBe(409);
  });

  it("Não atribui OS em estado terminal (COMPLETED/CANCELLED)", async () => {
    const token = await createTokenFor(fixture.adminA.id);
    const customer = await prisma.customer.create({
      data: { companyId: fixture.companyA.id, name: "Cliente A" },
    });
    const id = await createManualOrder(token, customer.id);
    const tech = await createTech(fixture.companyA.id, fixture.techA.id);

    await prisma.serviceOrder.update({
      where: { id },
      data: { status: "COMPLETED", completedAt: new Date() },
    });

    const res = await assignOrder(
      apiRequest(
        `/api/service-orders/${id}/assign`,
        { method: "POST", body: { technicianId: tech.id } },
        token,
      ),
      { params: { id } },
    );
    expect(res.status).toBe(409);
  });

  it("Não atribui técnico de outra empresa (404)", async () => {
    const token = await createTokenFor(fixture.adminA.id);
    const customer = await prisma.customer.create({
      data: { companyId: fixture.companyA.id, name: "Cliente A" },
    });
    const id = await createManualOrder(token, customer.id);
    const techB = await createTech(fixture.companyB.id, fixture.adminB.id);

    const res = await assignOrder(
      apiRequest(
        `/api/service-orders/${id}/assign`,
        { method: "POST", body: { technicianId: techB.id } },
        token,
      ),
      { params: { id } },
    );
    expect(res.status).toBe(404);
  });

  it("Técnico só acessa OS atribuída a ele (ownership)", async () => {
    const adminToken = await createTokenFor(fixture.adminA.id);
    const customer = await prisma.customer.create({
      data: { companyId: fixture.companyA.id, name: "Cliente A" },
    });
    const id = await createManualOrder(adminToken, customer.id);
    const techA = await createTech(fixture.companyA.id, fixture.techA.id);
    await createTech(fixture.companyA.id, fixture.techB.id);

    await assignOrder(
      apiRequest(
        `/api/service-orders/${id}/assign`,
        { method: "POST", body: { technicianId: techA.id } },
        adminToken,
      ),
      { params: { id } },
    );

    const ownerToken = await createTokenFor(fixture.techA.id);
    const ownerRes = await getOrder(
      apiRequest(`/api/service-orders/${id}`, {}, ownerToken),
      { params: { id } },
    );
    expect(ownerRes.status).toBe(200);

    const otherToken = await createTokenFor(fixture.techB.id);
    const otherRes = await getOrder(
      apiRequest(`/api/service-orders/${id}`, {}, otherToken),
      { params: { id } },
    );
    expect(otherRes.status).toBe(404);
  });

  it("Empresa B não enxerga OS da Empresa A", async () => {
    const adminToken = await createTokenFor(fixture.adminA.id);
    const customer = await prisma.customer.create({
      data: { companyId: fixture.companyA.id, name: "Cliente A" },
    });
    const id = await createManualOrder(adminToken, customer.id);

    const tokenB = await createTokenFor(fixture.adminB.id);
    const res = await getOrder(
      apiRequest(`/api/service-orders/${id}`, {}, tokenB),
      { params: { id } },
    );
    expect(res.status).toBe(404);

    const listRes = await listOrders(apiRequest("/api/service-orders", {}, tokenB));
    const list = await listRes.json();
    expect(list.data.total).toBe(0);
  });

  it("Concorrência: atribuições simultâneas nunca duplicam evento", async () => {
    const token = await createTokenFor(fixture.adminA.id);
    const customer = await prisma.customer.create({
      data: { companyId: fixture.companyA.id, name: "Cliente A" },
    });
    const id = await createManualOrder(token, customer.id);
    const techA = await createTech(fixture.companyA.id, fixture.techA.id);
    const techB = await createTech(fixture.companyA.id, fixture.techB.id);

    const results = await Promise.allSettled([
      assignTechnician(fixture.companyA.id, fixture.adminA.id, id, techA.id),
      assignTechnician(fixture.companyA.id, fixture.adminA.id, id, techB.id),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);

    for (const result of results) {
      if (result.status === "rejected") {
        expect(result.reason).toBeInstanceOf(DomainError);
      }
    }

    const os = await prisma.serviceOrder.findUnique({ where: { id } });
    expect(os?.status).toBe("ASSIGNED");

    const events = await prisma.serviceOrderEvent.findMany({
      where: { serviceOrderId: id },
      orderBy: { createdAt: "asc" },
    });
    expect(events).toHaveLength(fulfilled.length + 1);
    expect(events[0].event).toBe("SERVICE_ORDER_CREATED");
    const assignmentEvents = events
      .slice(1)
      .map((e) => e.event);
    expect(assignmentEvents).toEqual([
      "TECHNICIAN_ASSIGNED",
      ...(fulfilled.length === 2 ? ["TECHNICIAN_CHANGED"] : []),
    ]);
  });
});
