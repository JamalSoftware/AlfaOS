import { describe, it, expect, beforeEach } from "vitest";
import { GET as teamRoute } from "@/app/api/time-clock/team/route";
import { GET as adminAdjustmentsRoute } from "@/app/api/time-clock/adjustments/route";
import { POST as decisionRoute } from "@/app/api/time-clock/adjustments/[id]/decision/route";
import { GET as memberRoute } from "@/app/api/time-clock/members/[userId]/route";
import { POST as punchRoute } from "@/app/api/field/v1/time-clock/entries/route";
import { GET as todayRoute } from "@/app/api/field/v1/time-clock/today/route";
import { prisma } from "@/lib/prisma";
import { punchTimeClock, requestTimeAdjustment } from "@/lib/time-clock";
import {
  apiRequest,
  createTokenFor,
  fieldRequest,
  registerTestDevice,
  seedTestData,
  type TestFixture,
} from "./helpers";

/**
 * # Ataques à jornada
 *
 * Escritos DEPOIS da implementação e do commit `18fd29d`, para atacar o que os
 * testes funcionais não atacam: autorização por papel, CSRF, sessão, e a
 * fronteira entre empresas nas rotas administrativas.
 *
 * Cada negação vem com um **controle positivo** — provar que o caminho
 * autorizado devolve o dado. Sem ele, um teste negativo pode estar passando por
 * a rota estar quebrada para todo mundo.
 */

let fixture: TestFixture;

beforeEach(async () => {
  fixture = await seedTestData();
});

let seed = 0;
const key = (s: string) => `sec-${s}-${(seed += 1)}-${Date.now()}`;

async function body(response: Response) {
  return (await response.json()) as {
    ok?: boolean;
    error?: string | { code?: string; message?: string };
    data?: Record<string, unknown>;
  };
}

async function tecnicoComPonto() {
  await prisma.technician.upsert({
    where: { userId: fixture.techA.id },
    update: {},
    create: { companyId: fixture.companyA.id, userId: fixture.techA.id },
  });
  await punchTimeClock(fixture.companyA.id, fixture.techA.id, {
    type: "CLOCK_IN",
  });
  return requestTimeAdjustment(fixture.companyA.id, fixture.techA.id, {
    requestedType: "MISSING_ENTRY",
    requestedEntryType: "CLOCK_OUT",
    requestedOccurredAt: new Date(Date.now() - 60_000),
    reason: "Esqueci.",
  });
}

// ---------------------------------------------------------------------------
// Autorização por papel
// ---------------------------------------------------------------------------

describe("RBAC das rotas administrativas", () => {
  it("CONTROLE POSITIVO: ADMIN enxerga equipe, fila e espelho", async () => {
    await tecnicoComPonto();
    const admin = await createTokenFor(fixture.adminA.id);

    const equipe = await teamRoute(
      apiRequest("/api/time-clock/team", {}, admin),
    );
    expect(equipe.status).toBe(200);
    expect(
      ((await body(equipe)).data?.members as unknown[]).length,
    ).toBeGreaterThan(0);

    const fila = await adminAdjustmentsRoute(
      apiRequest("/api/time-clock/adjustments", {}, admin),
    );
    expect(fila.status).toBe(200);
    expect((await body(fila)).data?.adjustments).toHaveLength(1);

    const espelho = await memberRoute(
      apiRequest(`/api/time-clock/members/${fixture.techA.id}`, {}, admin),
      { params: { userId: fixture.techA.id } },
    );
    expect(espelho.status).toBe(200);
  });

  it("TECHNICIAN não abre a visão de equipe", async () => {
    const token = await createTokenFor(fixture.techA.id);
    const response = await teamRoute(
      apiRequest("/api/time-clock/team", {}, token),
    );
    // Esconder botão é UX; a rota precisa recusar por conta própria.
    expect(response.status).toBe(403);
  });

  it("DISPATCHER vê a equipe, mas NÃO a fila de ajustes", async () => {
    await tecnicoComPonto();
    const token = await createTokenFor(fixture.dispatcherA.id);

    /*
      A assimetria é deliberada.

      Saber quem está em jornada é insumo direto do despacho. Julgar a jornada
      de outra pessoa é da família de administrar usuário e credencial — e no
      AlfaOS isso é do ADMIN.
    */
    expect(
      (await teamRoute(apiRequest("/api/time-clock/team", {}, token))).status,
    ).toBe(200);

    expect(
      (
        await adminAdjustmentsRoute(
          apiRequest("/api/time-clock/adjustments", {}, token),
        )
      ).status,
    ).toBe(403);
  });

  it("DISPATCHER não abre o espelho detalhado de ninguém", async () => {
    await tecnicoComPonto();
    const token = await createTokenFor(fixture.dispatcherA.id);
    const response = await memberRoute(
      apiRequest(`/api/time-clock/members/${fixture.techA.id}`, {}, token),
      { params: { userId: fixture.techA.id } },
    );
    // Minimização: o despacho precisa do estado, não do minuto a minuto.
    expect(response.status).toBe(403);
  });

  it("DISPATCHER não decide ajuste", async () => {
    const pedido = await tecnicoComPonto();
    const token = await createTokenFor(fixture.dispatcherA.id);

    const response = await decisionRoute(
      apiRequest(
        `/api/time-clock/adjustments/${pedido.id}/decision`,
        { method: "POST", body: { decision: "APPROVED" } },
        token,
      ),
      { params: { id: pedido.id } },
    );
    expect(response.status).toBe(403);

    expect(
      (
        await prisma.timeAdjustmentRequest.findUniqueOrThrow({
          where: { id: pedido.id },
        })
      ).status,
    ).toBe("PENDING");
  });

  it("sem sessão nenhuma rota administrativa responde", async () => {
    const pedido = await tecnicoComPonto();
    for (const response of [
      await teamRoute(apiRequest("/api/time-clock/team")),
      await adminAdjustmentsRoute(apiRequest("/api/time-clock/adjustments")),
      await memberRoute(
        apiRequest(`/api/time-clock/members/${fixture.techA.id}`),
        { params: { userId: fixture.techA.id } },
      ),
      await decisionRoute(
        apiRequest(`/api/time-clock/adjustments/${pedido.id}/decision`, {
          method: "POST",
          body: { decision: "APPROVED" },
          headers: { Origin: "http://localhost", Host: "localhost" },
        }),
        { params: { id: pedido.id } },
      ),
    ]) {
      expect(response.status).toBe(401);
    }
  });
});

// ---------------------------------------------------------------------------
// CSRF
// ---------------------------------------------------------------------------

describe("CSRF na decisão de ajuste", () => {
  it("Origin de terceiro é recusado antes da autorização", async () => {
    const pedido = await tecnicoComPonto();
    const admin = await createTokenFor(fixture.adminA.id);

    const response = await decisionRoute(
      apiRequest(
        `/api/time-clock/adjustments/${pedido.id}/decision`,
        {
          method: "POST",
          body: { decision: "APPROVED" },
          headers: { Origin: "https://evil.example", Host: "localhost" },
        },
        admin,
      ),
      { params: { id: pedido.id } },
    );

    expect(response.status).toBe(403);
    expect(
      (
        await prisma.timeAdjustmentRequest.findUniqueOrThrow({
          where: { id: pedido.id },
        })
      ).status,
    ).toBe("PENDING");
  });

  it("CONTROLE POSITIVO: mesma origem, ADMIN, decide", async () => {
    const pedido = await tecnicoComPonto();
    const admin = await createTokenFor(fixture.adminA.id);

    const response = await decisionRoute(
      apiRequest(
        `/api/time-clock/adjustments/${pedido.id}/decision`,
        {
          method: "POST",
          body: { decision: "REJECTED", decisionReason: "Sem evidência." },
          headers: { Origin: "http://localhost", Host: "localhost" },
        },
        admin,
      ),
      { params: { id: pedido.id } },
    );

    expect(response.status).toBe(200);
    expect(
      (
        await prisma.timeAdjustmentRequest.findUniqueOrThrow({
          where: { id: pedido.id },
        })
      ).status,
    ).toBe("REJECTED");
  });
});

// ---------------------------------------------------------------------------
// Multi-tenancy pelas ROTAS
// ---------------------------------------------------------------------------

describe("Isolamento entre empresas nas rotas", () => {
  it("ADMIN da empresa B não decide pedido da empresa A", async () => {
    const pedido = await tecnicoComPonto();
    const adminB = await createTokenFor(fixture.adminB.id);

    const response = await decisionRoute(
      apiRequest(
        `/api/time-clock/adjustments/${pedido.id}/decision`,
        {
          method: "POST",
          body: { decision: "APPROVED" },
          headers: { Origin: "http://localhost", Host: "localhost" },
        },
        adminB,
      ),
      { params: { id: pedido.id } },
    );

    // 404 e não 403: confirmar que o id existe noutra empresa é o que uma
    // sonda não pode aprender.
    expect(response.status).toBe(404);
    expect(
      (
        await prisma.timeAdjustmentRequest.findUniqueOrThrow({
          where: { id: pedido.id },
        })
      ).status,
    ).toBe("PENDING");
  });

  it("ADMIN da empresa B não abre o espelho de funcionário da A", async () => {
    await tecnicoComPonto();
    const adminB = await createTokenFor(fixture.adminB.id);

    const response = await memberRoute(
      apiRequest(`/api/time-clock/members/${fixture.techA.id}`, {}, adminB),
      { params: { userId: fixture.techA.id } },
    );
    expect(response.status).toBe(404);
  });

  it("a fila do ADMIN da empresa B vem vazia, não com o pedido da A", async () => {
    await tecnicoComPonto();
    const adminB = await createTokenFor(fixture.adminB.id);

    const response = await adminAdjustmentsRoute(
      apiRequest("/api/time-clock/adjustments", {}, adminB),
    );
    expect(response.status).toBe(200);
    expect((await body(response)).data?.adjustments).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Elegibilidade
// ---------------------------------------------------------------------------

describe("Elegibilidade do técnico", () => {
  it("técnico DESATIVADO não bate ponto, mas continua lendo a jornada", async () => {
    const technician = await prisma.technician.upsert({
      where: { userId: fixture.techA.id },
      update: {},
      create: { companyId: fixture.companyA.id, userId: fixture.techA.id },
    });
    const { token } = await registerTestDevice(fixture.techA.id, {
      installationId: key("inst"),
    });

    // Controle positivo: enquanto ativo, bate.
    expect(
      (
        await punchRoute(
          fieldRequest("/api/field/v1/time-clock/entries", {
            method: "POST",
            token,
            idempotencyKey: key("ok"),
            body: { type: "CLOCK_IN" },
          }),
        )
      ).status,
    ).toBe(201);

    await prisma.technician.update({
      where: { id: technician.id },
      data: { active: false },
    });

    const negado = await punchRoute(
      fieldRequest("/api/field/v1/time-clock/entries", {
        method: "POST",
        token,
        idempotencyKey: key("negado"),
        body: { type: "BREAK_START" },
      }),
    );
    expect(negado.status).toBe(403);

    /*
      Leitura NÃO é bloqueada pela desativação — mesma regra do resto do Field.

      Quem foi desativado hoje continua vendo a jornada que registrou; apagar a
      visão dela seria esconder o próprio histórico da pessoa.
    */
    const leitura = await todayRoute(
      fieldRequest("/api/field/v1/time-clock/today", { token }),
    );
    expect(leitura.status).toBe(200);

    expect(
      await prisma.timeEntry.count({ where: { userId: fixture.techA.id } }),
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Fronteira do domínio
// ---------------------------------------------------------------------------

describe("Fronteira de tenant no domínio", () => {
  it("ATAQUE: punchTimeClock com empresa e usuário de tenants diferentes", async () => {
    await prisma.technician.upsert({
      where: { userId: fixture.techA.id },
      update: {},
      create: { companyId: fixture.companyA.id, userId: fixture.techA.id },
    });

    /*
      Ataque ao SERVIÇO, não à rota.

      Encontrado na auditoria própria deste módulo: antes da correção, o par
      (empresa B, usuário da A) era aceito e gravava uma jornada atravessada.
      Nenhuma rota conseguia produzi-lo — as duas derivam do mesmo principal —,
      mas a primeira tela de quiosque ou "bater por outra pessoa" herdaria o
      buraco.
    */
    await expect(
      punchTimeClock(fixture.companyB.id, fixture.techA.id, {
        type: "CLOCK_IN",
      }),
    ).rejects.toThrow();

    expect(
      await prisma.workday.count({
        where: { companyId: fixture.companyB.id, userId: fixture.techA.id },
      }),
    ).toBe(0);

    // O que NÃO pode acontecer: a rota do Field permitir isso. Ela deriva os
    // dois do token, e não há parâmetro que os separe.
    const { token } = await registerTestDevice(fixture.techA.id, {
      installationId: key("inst2"),
    });
    const response = await punchRoute(
      fieldRequest("/api/field/v1/time-clock/entries", {
        method: "POST",
        token,
        idempotencyKey: key("cross"),
        body: { type: "CLOCK_IN", companyId: fixture.companyB.id },
      }),
    );
    expect(response.status).toBe(400);
  });
});
