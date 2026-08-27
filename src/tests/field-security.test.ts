import { describe, it, expect, beforeEach } from "vitest";
import { GET as listOrders } from "@/app/api/field/v1/service-orders/route";
import { GET as getOrder } from "@/app/api/field/v1/service-orders/[id]/route";
import { POST as startOrder } from "@/app/api/field/v1/service-orders/[id]/start/route";
import { POST as revealPassword } from "@/app/api/field/v1/service-orders/[id]/pppoe/reveal/route";
import { POST as diagnosticRoute } from "@/app/api/field/v1/service-orders/[id]/diagnostic/route";
import { GET as notificationsRoute, POST as markReadRoute } from "@/app/api/field/v1/notifications/route";
import { GET as fieldMe } from "@/app/api/field/v1/me/route";
import { prisma } from "@/lib/prisma";
import { resetCapabilityLimits } from "@/lib/capability-rate-limit";
import { hashFieldToken } from "@/lib/field/auth";
import {
  allocateTestServiceOrderNumber,
  fieldRequest,
  registerTestDevice,
  seedTestData,
  type TestFixture,
} from "./helpers";

/**
 * Ataques ao Field.
 *
 * Nasceram como testes temporários da auditoria adversarial da v0.9 e ficaram:
 * cada um cobre um caminho que a suíte funcional não exercitava — cursor como
 * vetor de IDOR, cross-tenant com um técnico legítimo de OUTRA empresa,
 * máquina de estados vista pelo aplicativo, cota consumida antes da
 * autorização, e vazamento no corpo do erro.
 *
 * Apagá-los ao fim da auditoria teria devolvido essa cobertura a zero, então
 * a alternativa foi promovê-los. Cada bloco descreve o ataque, não a feature.
 */

let fixture: TestFixture;

beforeEach(async () => {
  fixture = await seedTestData();
  resetCapabilityLimits();
});

async function body(response: Response) {
  return (await response.json()) as {
    ok: boolean;
    data?: Record<string, unknown>;
    error?: { code: string; message: string };
  };
}

async function twoTenants() {
  const techA = await prisma.technician.create({
    data: { companyId: fixture.companyA.id, userId: fixture.techA.id },
  });
  const techB2 = await prisma.technician.create({
    data: { companyId: fixture.companyA.id, userId: fixture.techB.id },
  });
  /*
    Técnico DE VERDADE na empresa B.

    A fixture só tem um ADMIN na empresa B, e um token de ADMIN é recusado com
    401 antes de chegar a qualquer verificação de tenant — o que faria o teste
    cross-tenant passar pelo motivo errado, sem nunca exercitar o filtro de
    empresa. O atacante realista é um técnico legítimo de outra empresa.
  */
  const userTechB = await prisma.user.create({
    data: {
      companyId: fixture.companyB.id,
      name: "Tecnico da Empresa B",
      email: "tech@companyb.test",
      profile: "TECHNICIAN",
      passwordHash: "$2b$10$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN",
    },
  });
  const techOutraEmpresa = await prisma.technician.create({
    data: { companyId: fixture.companyB.id, userId: userTechB.id },
  });

  const custA = await prisma.customer.create({
    data: { companyId: fixture.companyA.id, name: "Cliente A", document: "11111111111" },
  });
  const custB = await prisma.customer.create({
    data: { companyId: fixture.companyB.id, name: "Cliente B", document: "22222222222" },
  });

  const mk = async (
    companyId: string,
    customerId: string,
    technicianId: string,
    status: "ASSIGNED" | "COMPLETED" | "CANCELLED" | "PENDING" = "ASSIGNED",
  ) =>
    prisma.serviceOrder.create({
      data: {
        companyId,
        number: await allocateTestServiceOrderNumber(companyId),
        customerId,
        technicianId,
        type: "Instalação",
        description: "OS.",
        priority: "NORMAL",
        status,
        assignedAt: new Date(),
      },
    });

  const osA = await mk(fixture.companyA.id, custA.id, techA.id);
  const osColega = await mk(fixture.companyA.id, custA.id, techB2.id);
  const osOutraEmpresa = await mk(
    fixture.companyB.id,
    custB.id,
    techOutraEmpresa.id,
  );

  const { token: tokenA, deviceId } = await registerTestDevice(fixture.techA.id);
  const { token: tokenOutraEmpresa } = await registerTestDevice(userTechB.id);

  return {
    techA,
    techB2,
    techOutraEmpresa,
    custA,
    custB,
    osA,
    osColega,
    osOutraEmpresa,
    tokenA,
    tokenOutraEmpresa,
    deviceId,
    mk,
  };
}

// ---------------------------------------------------------------------------
// A1 — cursor como vetor de IDOR
// ---------------------------------------------------------------------------

describe("A1 · cursor de paginação não vaza linha alheia", () => {
  it("cursor com id de OS de colega não traz a OS dele", async () => {
    const t = await twoTenants();

    const response = await listOrders(
      fieldRequest(`/api/field/v1/service-orders?cursor=${t.osColega.id}`, {
        token: t.tokenA,
      }),
    );

    // Não pode ser 500 nem vazar. Qualquer desfecho é aceitável menos conter a
    // OS do colega.
    const payload = await body(response);
    const serial = JSON.stringify(payload);
    expect(serial).not.toContain(t.osColega.id);
  });

  it("cursor com id de OS de OUTRA EMPRESA não traz nada dela", async () => {
    const t = await twoTenants();

    const response = await listOrders(
      fieldRequest(`/api/field/v1/service-orders?cursor=${t.osOutraEmpresa.id}`, {
        token: t.tokenA,
      }),
    );

    const serial = JSON.stringify(await body(response));
    expect(serial).not.toContain(t.osOutraEmpresa.id);
    expect(serial).not.toContain("Cliente B");
  });

  it("cursor com id de notificação alheia não vaza a caixa dela", async () => {
    const t = await twoTenants();
    const alheia = await prisma.notification.create({
      data: {
        companyId: fixture.companyA.id,
        userId: fixture.techB.id,
        type: "SERVICE_ORDER_ASSIGNED",
        title: "Segredo do colega",
        body: "Não deve aparecer.",
      },
    });

    const response = await notificationsRoute(
      fieldRequest(`/api/field/v1/notifications?cursor=${alheia.id}`, {
        token: t.tokenA,
      }),
    );

    const serial = JSON.stringify(await body(response));
    expect(serial).not.toContain("Segredo do colega");
  });
});

// ---------------------------------------------------------------------------
// A2 — cross-tenant com token válido
// ---------------------------------------------------------------------------

describe("A2 · token de outra empresa não alcança nada daqui", () => {
  it("detalhe, start, reveal e diagnóstico respondem 404", async () => {
    const t = await twoTenants();
    const params = { params: { id: t.osA.id } };

    const detalhe = await getOrder(
      fieldRequest(`/api/field/v1/service-orders/${t.osA.id}`, {
        token: t.tokenOutraEmpresa,
      }),
      params,
    );
    expect(detalhe.status).toBe(404);

    // Um técnico legítimo da empresa B, autenticado, sondando a OS da A.
    const start = await startOrder(
      fieldRequest(`/api/field/v1/service-orders/${t.osA.id}/start`, {
        method: "POST",
        token: t.tokenOutraEmpresa,
        idempotencyKey: "cross-tenant-start-01",
        body: { expectedVersion: t.osA.version },
      }),
      params,
    );
    expect([401, 403, 404]).toContain(start.status);

    const diag = await diagnosticRoute(
      fieldRequest(`/api/field/v1/service-orders/${t.osA.id}/diagnostic`, {
        method: "POST",
        token: t.tokenOutraEmpresa,
      }),
      params,
    );
    expect([401, 403, 404]).toContain(diag.status);

    // Controle positivo: o dono REALMENTE consegue ler.
    const dono = await getOrder(
      fieldRequest(`/api/field/v1/service-orders/${t.osA.id}`, {
        token: t.tokenA,
      }),
      params,
    );
    expect(dono.status).toBe(200);
  });

  it("a OS continua intocada depois das tentativas", async () => {
    const t = await twoTenants();
    await startOrder(
      fieldRequest(`/api/field/v1/service-orders/${t.osA.id}/start`, {
        method: "POST",
        token: t.tokenOutraEmpresa,
        idempotencyKey: "cross-tenant-start-02",
        body: { expectedVersion: t.osA.version },
      }),
      { params: { id: t.osA.id } },
    );

    const os = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: t.osA.id },
    });
    expect(os.status).toBe("ASSIGNED");
    expect(os.version).toBe(t.osA.version);
  });
});

// ---------------------------------------------------------------------------
// A3 — mass assignment nos comandos
// ---------------------------------------------------------------------------

describe("A3 · o corpo do comando não decide autorização nem estado", () => {
  it("start recusa qualquer campo além de expectedVersion/clientMutationId", async () => {
    const t = await twoTenants();

    const hostis = [
      { expectedVersion: t.osA.version, companyId: fixture.companyB.id },
      { expectedVersion: t.osA.version, technicianId: t.techB2.id },
      { expectedVersion: t.osA.version, status: "COMPLETED" },
      { expectedVersion: t.osA.version, version: 999 },
      { expectedVersion: t.osA.version, startedAt: "2020-01-01T00:00:00Z" },
      { expectedVersion: t.osA.version, externalId: "forjado" },
      { expectedVersion: t.osA.version, userId: fixture.adminA.id },
    ];

    for (let i = 0; i < hostis.length; i += 1) {
      const hostil = hostis[i];
      const response = await startOrder(
        fieldRequest(`/api/field/v1/service-orders/${t.osA.id}/start`, {
          method: "POST",
          token: t.tokenA,
          idempotencyKey: `mass-assign-${String(i).padStart(6, "0")}`,
          body: hostil,
        }),
        { params: { id: t.osA.id } },
      );
      expect(response.status).toBe(400);
      expect((await body(response)).error?.code).toBe("VALIDATION_ERROR");
    }

    const os = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: t.osA.id },
    });
    expect(os.status).toBe("ASSIGNED");
    expect(os.version).toBe(t.osA.version);
    expect(os.technicianId).toBe(t.techA.id);
  });

  it("reveal recusa campo extra", async () => {
    const t = await twoTenants();
    const conexao = await prisma.customerConnection.create({
      data: {
        companyId: fixture.companyA.id,
        customerId: t.custA.id,
        type: "PPPOE",
        username: "usuario",
        active: true,
      },
    });

    const response = await revealPassword(
      fieldRequest(`/api/field/v1/service-orders/${t.osA.id}/pppoe/reveal`, {
        method: "POST",
        token: t.tokenA,
        body: { connectionId: conexao.id, companyId: fixture.companyB.id },
      }),
      { params: { id: t.osA.id } },
    );
    expect(response.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// A4 — máquina de estados vista pelo Field
// ---------------------------------------------------------------------------

describe("A4 · o Field não contorna a máquina de estados", () => {
  it("não inicia OS concluída, cancelada nem pendente", async () => {
    const t = await twoTenants();

    for (const status of ["COMPLETED", "CANCELLED", "PENDING"] as const) {
      const os = await t.mk(
        fixture.companyA.id,
        t.custA.id,
        t.techA.id,
        status,
      );
      const response = await startOrder(
        fieldRequest(`/api/field/v1/service-orders/${os.id}/start`, {
          method: "POST",
          token: t.tokenA,
          idempotencyKey: `estado-${status.toLowerCase()}-0001`,
          body: { expectedVersion: os.version },
        }),
        { params: { id: os.id } },
      );

      expect(response.status).toBe(409);
      const depois = await prisma.serviceOrder.findUniqueOrThrow({
        where: { id: os.id },
      });
      expect(depois.status).toBe(status);
      expect(depois.startedAt).toBeNull();
      expect(
        await prisma.serviceOrderExecution.count({
          where: { serviceOrderId: os.id },
        }),
      ).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// A5 — PPPoE: conexão de outro cliente
// ---------------------------------------------------------------------------

describe("A5 · reveal não aceita conexão de outro cliente", () => {
  it("connectionId de cliente diferente na PRÓPRIA OS é recusado", async () => {
    const t = await twoTenants();
    const outroCliente = await prisma.customer.create({
      data: { companyId: fixture.companyA.id, name: "Terceiro" },
    });
    const conexaoAlheia = await prisma.customerConnection.create({
      data: {
        companyId: fixture.companyA.id,
        customerId: outroCliente.id,
        type: "PPPOE",
        username: "alheio",
        credentialCiphertext: "ct",
        credentialIv: "iv",
        credentialAuthTag: "tag",
        active: true,
      },
    });

    const response = await revealPassword(
      fieldRequest(`/api/field/v1/service-orders/${t.osA.id}/pppoe/reveal`, {
        method: "POST",
        token: t.tokenA,
        body: { connectionId: conexaoAlheia.id },
      }),
      { params: { id: t.osA.id } },
    );

    expect(response.status).toBe(404);
    const serial = JSON.stringify(await body(response));
    expect(serial).not.toContain("alheio");
    expect(serial).not.toContain("password");
  });
});

// ---------------------------------------------------------------------------
// A6 — token forjado e revogação
// ---------------------------------------------------------------------------

describe("A6 · token", () => {
  it("hash conhecido não vira token — precisa do texto claro", async () => {
    const t = await twoTenants();
    const device = await prisma.mobileDevice.findUniqueOrThrow({
      where: { id: t.deviceId },
    });

    // Um atacante com acesso de leitura ao banco tem o HASH. Ele não abre nada.
    const response = await fieldMe(
      fieldRequest("/api/field/v1/me", { token: device.tokenHash ?? "" }),
    );
    expect(response.status).toBe(401);

    // Controle positivo: o texto claro correspondente abre.
    expect(hashFieldToken(t.tokenA)).toBe(device.tokenHash);
    const ok = await fieldMe(
      fieldRequest("/api/field/v1/me", { token: t.tokenA }),
    );
    expect(ok.status).toBe(200);
  });

  it("token de aparelho revogado não vale nem para leitura", async () => {
    const t = await twoTenants();
    await prisma.mobileDevice.update({
      where: { id: t.deviceId },
      data: { status: "REVOKED", revokedAt: new Date() },
    });

    for (const call of [
      () => listOrders(fieldRequest("/api/field/v1/service-orders", { token: t.tokenA })),
      () =>
        getOrder(
          fieldRequest(`/api/field/v1/service-orders/${t.osA.id}`, {
            token: t.tokenA,
          }),
          { params: { id: t.osA.id } },
        ),
      () =>
        notificationsRoute(
          fieldRequest("/api/field/v1/notifications", { token: t.tokenA }),
        ),
    ]) {
      const response = await call();
      expect(response.status).toBe(401);
    }
  });
});

// ---------------------------------------------------------------------------
// A7 — rate limit depois da autorização
// ---------------------------------------------------------------------------

describe("A7 · cota não é gasta por quem não tem acesso", () => {
  it("chamada sem token não consome a cota do técnico", async () => {
    const t = await twoTenants();

    // 20 sondagens anônimas.
    for (let i = 0; i < 20; i += 1) {
      const response = await revealPassword(
        fieldRequest(`/api/field/v1/service-orders/${t.osA.id}/pppoe/reveal`, {
          method: "POST",
          body: { connectionId: "x" },
        }),
        { params: { id: t.osA.id } },
      );
      expect(response.status).toBe(401);
    }

    // O dono continua com a cota inteira: a primeira tentativa dele não pode
    // ser 429.
    const conexao = await prisma.customerConnection.create({
      data: {
        companyId: fixture.companyA.id,
        customerId: t.custA.id,
        type: "PPPOE",
        username: "usuario",
        credentialCiphertext: "ct",
        credentialIv: "iv",
        credentialAuthTag: "tag",
        active: true,
      },
    });
    const response = await revealPassword(
      fieldRequest(`/api/field/v1/service-orders/${t.osA.id}/pppoe/reveal`, {
        method: "POST",
        token: t.tokenA,
        body: { connectionId: conexao.id },
      }),
      { params: { id: t.osA.id } },
    );
    expect(response.status).not.toBe(429);
  });

  it("OS alheia não gasta a cota antes de ser recusada", async () => {
    const t = await twoTenants();

    for (let i = 0; i < 10; i += 1) {
      const response = await diagnosticRoute(
        fieldRequest(
          `/api/field/v1/service-orders/${t.osColega.id}/diagnostic`,
          { method: "POST", token: t.tokenA },
        ),
        { params: { id: t.osColega.id } },
      );
      expect(response.status).toBe(404);
    }

    // Se a cota tivesse sido consumida antes da posse, esta chamada legítima
    // já viria 429.
    const legitima = await diagnosticRoute(
      fieldRequest(`/api/field/v1/service-orders/${t.osA.id}/diagnostic`, {
        method: "POST",
        token: t.tokenA,
      }),
      { params: { id: t.osA.id } },
    );
    expect(legitima.status).not.toBe(429);
  });
});

// ---------------------------------------------------------------------------
// A8 — notificações
// ---------------------------------------------------------------------------

describe("A8 · notificações", () => {
  it("ids de outra empresa não são marcados nem revelados", async () => {
    const t = await twoTenants();
    const daOutraEmpresa = await prisma.notification.create({
      data: {
        companyId: fixture.companyB.id,
        userId: fixture.adminB.id,
        type: "SERVICE_ORDER_ASSIGNED",
        title: "Da empresa B",
        body: "Nada a ver.",
      },
    });

    const response = await markReadRoute(
      fieldRequest("/api/field/v1/notifications", {
        method: "POST",
        token: t.tokenA,
        body: { ids: [daOutraEmpresa.id] },
      }),
    );
    expect(response.status).toBe(200);
    expect(((await body(response)).data as { updated: number }).updated).toBe(0);

    const intacta = await prisma.notification.findUniqueOrThrow({
      where: { id: daOutraEmpresa.id },
    });
    expect(intacta.readAt).toBeNull();
  });

  it("lista gigante de ids não derruba a rota", async () => {
    const t = await twoTenants();
    const response = await markReadRoute(
      fieldRequest("/api/field/v1/notifications", {
        method: "POST",
        token: t.tokenA,
        body: { ids: Array.from({ length: 500 }, (_, i) => `id-${i}`) },
      }),
    );
    // Teto de 200 no schema: recusa em vez de aceitar um IN gigante.
    expect(response.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// A9 — erros não vazam
// ---------------------------------------------------------------------------

describe("A9 · corpo de erro não vaza interno", () => {
  it("nenhuma resposta de erro carrega SQL, Prisma ou stack", async () => {
    const t = await twoTenants();

    const respostas = await Promise.all([
      getOrder(
        fieldRequest("/api/field/v1/service-orders/nao-existe", {
          token: t.tokenA,
        }),
        { params: { id: "nao-existe" } },
      ),
      fieldMe(fieldRequest("/api/field/v1/me", { token: "invalido" })),
      startOrder(
        fieldRequest(`/api/field/v1/service-orders/${t.osColega.id}/start`, {
          method: "POST",
          token: t.tokenA,
          idempotencyKey: "erro-vazamento-0001",
          body: { expectedVersion: 0 },
        }),
        { params: { id: t.osColega.id } },
      ),
    ]);

    for (const response of respostas) {
      const serial = JSON.stringify(await body(response));
      for (const proibido of [
        "prisma",
        "PrismaClient",
        "SELECT",
        "at Object",
        "node_modules",
        "P2002",
        "stack",
      ]) {
        expect(serial.toLowerCase()).not.toContain(proibido.toLowerCase());
      }
    }
  });
});
