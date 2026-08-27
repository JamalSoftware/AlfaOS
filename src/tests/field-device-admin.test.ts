import { describe, it, expect, beforeEach } from "vitest";
import { GET as listDevices } from "@/app/api/mobile-devices/route";
import { POST as revokeRoute } from "@/app/api/mobile-devices/[id]/revoke/route";
import { GET as listOutbox } from "@/app/api/outbox-events/route";
import { POST as requeueRoute } from "@/app/api/outbox-events/[id]/requeue/route";
import { GET as fieldMe } from "@/app/api/field/v1/me/route";
import { GET as fieldOrders } from "@/app/api/field/v1/service-orders/route";
import { GET as fieldOrderDetail } from "@/app/api/field/v1/service-orders/[id]/route";
import { POST as fieldStart } from "@/app/api/field/v1/service-orders/[id]/start/route";
import { POST as fieldDiagnostic } from "@/app/api/field/v1/service-orders/[id]/diagnostic/route";
import { POST as fieldReveal } from "@/app/api/field/v1/service-orders/[id]/pppoe/reveal/route";
import { GET as fieldNotifications } from "@/app/api/field/v1/notifications/route";
import { POST as registerRoute } from "@/app/api/field/v1/devices/register/route";
import { prisma } from "@/lib/prisma";
import { enqueueOutboxEvent } from "@/lib/outbox";
import {
  allocateTestServiceOrderNumber,
  apiRequest,
  createTokenFor,
  fieldRequest,
  registerTestDevice,
  seedTestData,
  type TestFixture,
} from "./helpers";

/**
 * REV-01 — a revogação precisa ser alcançável pela aplicação.
 *
 * `revokeDevice` e `requeueFailedOutboxEvent` existiam e **nenhuma rota as
 * chamava**. Na prática o ADMIN de uma empresa cujo técnico perdeu o celular
 * não tinha como cortar o acesso, e um evento `FAILED` só era recuperável por
 * quem abrisse o banco. Capacidade de segurança que só existe em função
 * exportada é capacidade que a operação não tem.
 */

let fixture: TestFixture;

beforeEach(async () => {
  fixture = await seedTestData();
  await prisma.technician.create({
    data: { companyId: fixture.companyA.id, userId: fixture.techA.id },
  });
});

async function jsonBody(response: Response) {
  return (await response.json()) as {
    ok: boolean;
    data?: Record<string, unknown>;
    error?: unknown;
  };
}

// ---------------------------------------------------------------------------
// Listagem
// ---------------------------------------------------------------------------

describe("GET /api/mobile-devices", () => {
  it("ADMIN vê os aparelhos da própria empresa", async () => {
    await registerTestDevice(fixture.techA.id);
    const token = await createTokenFor(fixture.adminA.id);

    const response = await listDevices(
      apiRequest("/api/mobile-devices", {}, token),
    );
    expect(response.status).toBe(200);

    const data = (await jsonBody(response)).data as {
      devices: Array<{ userName: string }>;
    };
    expect(data.devices).toHaveLength(1);
    expect(data.devices[0].userName).toBe("Tecnico Alfa");
  });

  it("a listagem NÃO carrega token, push token nem installationId", async () => {
    await registerTestDevice(fixture.techA.id, {
      pushToken: "fcm-token-que-nao-pode-vazar",
    });
    const token = await createTokenFor(fixture.adminA.id);

    const response = await listDevices(
      apiRequest("/api/mobile-devices", {}, token),
    );
    const serial = JSON.stringify(await jsonBody(response));

    // Controle positivo: a resposta realmente tem conteúdo.
    expect(serial).toContain("Tecnico Alfa");

    expect(serial).not.toContain("fcm-token-que-nao-pode-vazar");
    expect(serial).not.toContain("tokenHash");
    expect(serial).not.toContain("pushToken");
    expect(serial).not.toContain("installationId");
  });

  it("DISPATCHER e TECHNICIAN não acessam", async () => {
    await registerTestDevice(fixture.techA.id);
    for (const userId of [fixture.dispatcherA.id, fixture.techA.id]) {
      const token = await createTokenFor(userId);
      const response = await listDevices(
        apiRequest("/api/mobile-devices", {}, token),
      );
      expect(response.status).toBe(403);
    }
  });

  it("sem sessão é 401", async () => {
    const response = await listDevices(apiRequest("/api/mobile-devices"));
    expect(response.status).toBe(401);
  });

  it("ADMIN de outra empresa não enxerga estes aparelhos", async () => {
    await registerTestDevice(fixture.techA.id);
    const token = await createTokenFor(fixture.adminB.id);

    const response = await listDevices(
      apiRequest("/api/mobile-devices", {}, token),
    );
    expect(response.status).toBe(200);
    const data = (await jsonBody(response)).data as { devices: unknown[] };
    expect(data.devices).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Revogação
// ---------------------------------------------------------------------------

describe("POST /api/mobile-devices/:id/revoke", () => {
  it("ADMIN revoga e o aparelho perde o acesso em TODAS as rotas do Field", async () => {
    const { token: fieldToken, deviceId } = await registerTestDevice(
      fixture.techA.id,
    );
    const customer = await prisma.customer.create({
      data: { companyId: fixture.companyA.id, name: "Cliente" },
    });
    const technician = await prisma.technician.findFirstOrThrow({
      where: { userId: fixture.techA.id },
    });
    const order = await prisma.serviceOrder.create({
      data: {
        companyId: fixture.companyA.id,
        number: await allocateTestServiceOrderNumber(fixture.companyA.id),
        customerId: customer.id,
        technicianId: technician.id,
        type: "Instalação",
        description: "OS.",
        priority: "NORMAL",
        status: "ASSIGNED",
        assignedAt: new Date(),
      },
    });

    // Controle positivo: antes de revogar, o aparelho funciona.
    expect(
      (await fieldMe(fieldRequest("/api/field/v1/me", { token: fieldToken })))
        .status,
    ).toBe(200);

    const adminToken = await createTokenFor(fixture.adminA.id);
    const revoke = await revokeRoute(
      apiRequest(
        `/api/mobile-devices/${deviceId}/revoke`,
        { method: "POST" },
        adminToken,
      ),
      { params: { id: deviceId } },
    );
    expect(revoke.status).toBe(200);

    const params = { params: { id: order.id } };
    const chamadas: Array<[string, () => Promise<Response>]> = [
      ["me", () => fieldMe(fieldRequest("/api/field/v1/me", { token: fieldToken }))],
      [
        "orders",
        () =>
          fieldOrders(
            fieldRequest("/api/field/v1/service-orders", { token: fieldToken }),
          ),
      ],
      [
        "detail",
        () =>
          fieldOrderDetail(
            fieldRequest(`/api/field/v1/service-orders/${order.id}`, {
              token: fieldToken,
            }),
            params,
          ),
      ],
      [
        "start",
        () =>
          fieldStart(
            fieldRequest(`/api/field/v1/service-orders/${order.id}/start`, {
              method: "POST",
              token: fieldToken,
              idempotencyKey: "revogado-start-00001",
              body: { expectedVersion: order.version },
            }),
            params,
          ),
      ],
      [
        "diagnostic",
        () =>
          fieldDiagnostic(
            fieldRequest(`/api/field/v1/service-orders/${order.id}/diagnostic`, {
              method: "POST",
              token: fieldToken,
            }),
            params,
          ),
      ],
      [
        "reveal",
        () =>
          fieldReveal(
            fieldRequest(
              `/api/field/v1/service-orders/${order.id}/pppoe/reveal`,
              {
                method: "POST",
                token: fieldToken,
                body: { connectionId: "qualquer" },
              },
            ),
            params,
          ),
      ],
      [
        "notifications",
        () =>
          fieldNotifications(
            fieldRequest("/api/field/v1/notifications", { token: fieldToken }),
          ),
      ],
      [
        "register",
        () =>
          registerRoute(
            fieldRequest("/api/field/v1/devices/register", {
              method: "POST",
              token: fieldToken,
              body: { appVersion: "9.9.9" },
            }),
          ),
      ],
    ];

    for (const [nome, chamada] of chamadas) {
      const response = await chamada();
      expect(response.status, `rota ${nome}`).toBe(401);
    }

    // E nada foi mutado por tabela.
    const depois = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(depois.status).toBe("ASSIGNED");
    expect(depois.version).toBe(order.version);
  });

  it("revogar é idempotente: a segunda vez é 404, não erro", async () => {
    const { deviceId } = await registerTestDevice(fixture.techA.id);
    const adminToken = await createTokenFor(fixture.adminA.id);
    const req = () =>
      revokeRoute(
        apiRequest(
          `/api/mobile-devices/${deviceId}/revoke`,
          { method: "POST" },
          adminToken,
        ),
        { params: { id: deviceId } },
      );

    expect((await req()).status).toBe(200);
    expect((await req()).status).toBe(404);
  });

  it("ADMIN de outra empresa não revoga — e o aparelho continua ativo", async () => {
    const { deviceId } = await registerTestDevice(fixture.techA.id);
    const token = await createTokenFor(fixture.adminB.id);

    const response = await revokeRoute(
      apiRequest(
        `/api/mobile-devices/${deviceId}/revoke`,
        { method: "POST" },
        token,
      ),
      { params: { id: deviceId } },
    );
    // 404, não 403: um ADMIN não descobre por aqui quais aparelhos existem
    // fora da própria empresa.
    expect(response.status).toBe(404);

    const device = await prisma.mobileDevice.findUniqueOrThrow({
      where: { id: deviceId },
    });
    expect(device.status).toBe("ACTIVE");
  });

  it("DISPATCHER e TECHNICIAN não revogam", async () => {
    const { deviceId } = await registerTestDevice(fixture.techA.id);
    for (const userId of [fixture.dispatcherA.id, fixture.techA.id]) {
      const token = await createTokenFor(userId);
      const response = await revokeRoute(
        apiRequest(
          `/api/mobile-devices/${deviceId}/revoke`,
          { method: "POST" },
          token,
        ),
        { params: { id: deviceId } },
      );
      expect(response.status).toBe(403);
    }

    const device = await prisma.mobileDevice.findUniqueOrThrow({
      where: { id: deviceId },
    });
    expect(device.status).toBe("ACTIVE");
  });

  it("origem de terceiro é barrada antes de qualquer coisa", async () => {
    const { deviceId } = await registerTestDevice(fixture.techA.id);
    const token = await createTokenFor(fixture.adminA.id);

    const response = await revokeRoute(
      apiRequest(
        `/api/mobile-devices/${deviceId}/revoke`,
        { method: "POST", headers: { Origin: "https://evil.example" } },
        token,
      ),
      { params: { id: deviceId } },
    );
    expect(response.status).toBe(403);

    const device = await prisma.mobileDevice.findUniqueOrThrow({
      where: { id: deviceId },
    });
    expect(device.status).toBe("ACTIVE");
  });

  it("a revogação é auditada", async () => {
    const { deviceId } = await registerTestDevice(fixture.techA.id);
    const token = await createTokenFor(fixture.adminA.id);
    await revokeRoute(
      apiRequest(
        `/api/mobile-devices/${deviceId}/revoke`,
        { method: "POST" },
        token,
      ),
      { params: { id: deviceId } },
    );

    const log = await prisma.auditLog.findFirstOrThrow({
      where: { action: "FIELD.DEVICE_REVOKED" },
    });
    expect(log.companyId).toBe(fixture.companyA.id);
    expect(log.userId).toBe(fixture.adminA.id);
    expect(log.entityId).toBe(deviceId);
  });
});

// ---------------------------------------------------------------------------
// Outbox operacional
// ---------------------------------------------------------------------------

describe("outbox operacional", () => {
  async function eventoFalhado(companyId: string) {
    await prisma.$transaction(async (tx) => {
      await enqueueOutboxEvent(tx, {
        companyId,
        eventType: "SERVICE_ORDER_ASSIGNED",
        aggregateType: "ServiceOrder",
        aggregateId: "os-x",
        payload: { notificationId: "n-1" },
      });
    });
    const event = await prisma.outboxEvent.findFirstOrThrow({
      where: { companyId },
    });
    return prisma.outboxEvent.update({
      where: { id: event.id },
      data: { status: "FAILED", attempts: 6, lastError: "provider fora" },
    });
  }

  it("ADMIN vê os eventos FAILED da própria empresa", async () => {
    await eventoFalhado(fixture.companyA.id);
    const token = await createTokenFor(fixture.adminA.id);

    const response = await listOutbox(
      apiRequest("/api/outbox-events", {}, token),
    );
    expect(response.status).toBe(200);
    const data = (await jsonBody(response)).data as {
      events: Array<{ status: string; lastError: string }>;
    };
    expect(data.events).toHaveLength(1);
    expect(data.events[0].status).toBe("FAILED");
    expect(data.events[0].lastError).toBe("provider fora");
  });

  it("a listagem não expõe o payload", async () => {
    await eventoFalhado(fixture.companyA.id);
    const token = await createTokenFor(fixture.adminA.id);
    const response = await listOutbox(
      apiRequest("/api/outbox-events", {}, token),
    );
    const serial = JSON.stringify(await jsonBody(response));
    expect(serial).toContain("SERVICE_ORDER_ASSIGNED");
    expect(serial).not.toContain("payload");
    expect(serial).not.toContain("n-1");
  });

  it("requeue devolve o evento à fila", async () => {
    const event = await eventoFalhado(fixture.companyA.id);
    const token = await createTokenFor(fixture.adminA.id);

    const response = await requeueRoute(
      apiRequest(
        `/api/outbox-events/${event.id}/requeue`,
        { method: "POST" },
        token,
      ),
      { params: { id: event.id } },
    );
    expect(response.status).toBe(200);

    const depois = await prisma.outboxEvent.findUniqueOrThrow({
      where: { id: event.id },
    });
    expect(depois.status).toBe("PENDING");
    expect(depois.attempts).toBe(0);
  });

  it("requeue não atravessa empresa", async () => {
    const event = await eventoFalhado(fixture.companyA.id);
    const token = await createTokenFor(fixture.adminB.id);

    const response = await requeueRoute(
      apiRequest(
        `/api/outbox-events/${event.id}/requeue`,
        { method: "POST" },
        token,
      ),
      { params: { id: event.id } },
    );
    expect(response.status).toBe(404);

    const depois = await prisma.outboxEvent.findUniqueOrThrow({
      where: { id: event.id },
    });
    expect(depois.status).toBe("FAILED");
  });

  it("DISPATCHER e TECHNICIAN não reenfileiram", async () => {
    const event = await eventoFalhado(fixture.companyA.id);
    for (const userId of [fixture.dispatcherA.id, fixture.techA.id]) {
      const token = await createTokenFor(userId);
      const response = await requeueRoute(
        apiRequest(
          `/api/outbox-events/${event.id}/requeue`,
          { method: "POST" },
          token,
        ),
        { params: { id: event.id } },
      );
      expect(response.status).toBe(403);
    }
  });

  it("requeue não aceita evento que não está FAILED", async () => {
    await prisma.$transaction(async (tx) => {
      await enqueueOutboxEvent(tx, {
        companyId: fixture.companyA.id,
        eventType: "SERVICE_ORDER_ASSIGNED",
        aggregateType: "ServiceOrder",
        aggregateId: "os-y",
      });
    });
    const pendente = await prisma.outboxEvent.findFirstOrThrow();
    const token = await createTokenFor(fixture.adminA.id);

    const response = await requeueRoute(
      apiRequest(
        `/api/outbox-events/${pendente.id}/requeue`,
        { method: "POST" },
        token,
      ),
      { params: { id: pendente.id } },
    );
    // Já está na fila: reenfileirar à mão criaria a duplicação que o lease
    // existe para evitar.
    expect(response.status).toBe(404);
  });
});
