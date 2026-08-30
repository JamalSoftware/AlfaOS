import { describe, it, expect, beforeEach } from "vitest";
import { POST as adminAdjustmentRoute } from "@/app/api/time-clock/members/[userId]/adjustments/route";
import { POST as decisionRoute } from "@/app/api/time-clock/adjustments/[id]/decision/route";
import { POST as punchRoute } from "@/app/api/field/v1/time-clock/entries/route";
import { prisma } from "@/lib/prisma";
import { decideTimeAdjustment, requestTimeAdjustment } from "@/lib/time-clock";
import {
  apiRequest,
  createTokenFor,
  fieldRequest,
  registerTestDevice,
  seedTestData,
  type TestFixture,
} from "./helpers";

/**
 * # Ataques ao endurecimento final da Jornada Fase 1
 *
 * Escritos na revisão de segurança, **depois** da implementação, para atacar o
 * que os testes funcionais não atacam: injeção de autoria, a chave de
 * idempotência como oráculo, corrida em torno da regra de quatro olhos e fuso
 * vindo do cliente.
 *
 * Um deles encontrou defeito real e ficou como regressão permanente: a resposta
 * da BATIDA não trazia `utcOffset`, e ela é a outra fonte de `Workday` do
 * aplicativo. Quando a releitura de `today` falha logo depois de bater — rede
 * caindo em campo —, o estado FICA com o que veio da batida, e o Field voltava
 * ao relógio do aparelho para exibir e para montar correção (§253, LOW-3).
 *
 * O guard do banco destrutivo NÃO é reatacado aqui: `test-db-guard.test.ts` já
 * o cobre por inteiro, e duplicar seria contar o mesmo teste duas vezes.
 *
 * Dados fictícios.
 */

let fixture: TestFixture;

beforeEach(async () => {
  fixture = await seedTestData();
});

const ORIGEM = { Origin: "http://localhost", Host: "localhost" };
let n = 0;
const chave = () => `audit-${Date.now()}-${(n += 1)}`;

function criar(
  userId: string,
  token: string,
  body: Record<string, unknown>,
  k = chave(),
) {
  return adminAdjustmentRoute(
    apiRequest(
      `/api/time-clock/members/${userId}/adjustments`,
      { method: "POST", body, headers: { ...ORIGEM, "Idempotency-Key": k } },
      token,
    ),
    { params: { userId } },
  );
}

const corpo = (extra: Record<string, unknown> = {}) => ({
  requestedType: "MISSING_ENTRY",
  requestedEntryType: "CLOCK_IN",
  requestedOccurredAt: new Date(Date.now() - 3_600_000).toISOString(),
  reason: "auditoria",
  ...extra,
});

const admin2 = () =>
  prisma.user.create({
    data: {
      companyId: fixture.companyA.id,
      name: "Auditor Dois",
      email: "auditor2@alfa.test",
      profile: "ADMIN",
      active: true,
      passwordHash: "x",
    },
    select: { id: true },
  });

// ---------------------------------------------------------------------------
// A1 — mass assignment na autoria
// ---------------------------------------------------------------------------

describe("A1: o corpo não pode escolher QUEM pediu", () => {
  it("requestedById no corpo é RECUSADO, não descartado em silêncio", async () => {
    /*
      O ataque: o ADMIN abre uma correção para a PRÓPRIA jornada mas declara
      outra pessoa como autora. Se o campo passasse, `requestedById !== decisor`
      e a regra de quatro olhos cairia — a pessoa aprovaria o próprio pedido.
    */
    const r = await criar(
      fixture.adminA.id,
      await createTokenFor(fixture.adminA.id),
      corpo({ requestedById: fixture.techA.id }),
    );

    expect(r.status).toBe(400);
    expect(await prisma.timeAdjustmentRequest.count()).toBe(0);
    // E nem sequer reservou chave: o schema recusa antes da idempotência.
    expect(await prisma.idempotencyRecord.count()).toBe(0);
  });

  it("userId e companyId no corpo também são recusados", async () => {
    for (const veneno of [
      { userId: fixture.techA.id },
      { companyId: fixture.companyB.id },
      { status: "APPROVED" },
      { decidedById: fixture.adminA.id },
    ]) {
      const r = await criar(
        fixture.techA.id,
        await createTokenFor(fixture.adminA.id),
        corpo(veneno),
      );
      expect(r.status).toBe(400);
    }
    expect(await prisma.timeAdjustmentRequest.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// A2 — a chave de idempotência como oráculo
// ---------------------------------------------------------------------------

describe("A2: a chave não vaza nem confunde alvo", () => {
  it("MESMA chave com alvo DIFERENTE não reproduz o pedido do outro", async () => {
    /*
      O ataque mais sutil da LOW-2: o `userId` alvo vem da ROTA, não do corpo.
      Se ele ficasse de fora da impressão digital, reapresentar a chave com
      outro alvo devolveria o desfecho guardado — e a tela mostraria "correção
      aberta para Fulano" quando o pedido gravado é de Beltrano.
    */
    const token = await createTokenFor(fixture.adminA.id);
    const k = chave();

    const primeira = await criar(fixture.techA.id, token, corpo(), k);
    expect(primeira.status).toBe(201);

    const segunda = await criar(fixture.techB.id, token, corpo(), k);

    // Conteúdo diferente para a mesma chave: conflito, nunca reprodução.
    expect(segunda.status).toBe(409);

    const linhas = await prisma.timeAdjustmentRequest.findMany({
      select: { userId: true },
    });
    expect(linhas).toHaveLength(1);
    expect(linhas[0].userId).toBe(fixture.techA.id);
  });

  it("a chave da empresa A não devolve nada para a empresa B", async () => {
    const k = chave();
    expect(
      (await criar(fixture.techA.id, await createTokenFor(fixture.adminA.id), corpo(), k))
        .status,
    ).toBe(201);

    // Mesmo id de rota, mesma chave, sessão da empresa B.
    const r = await criar(
      fixture.techA.id,
      await createTokenFor(fixture.adminB.id),
      corpo(),
      k,
    );

    // 404: o funcionário não é da empresa dele. E NADA do desfecho de A sai.
    expect(r.status).toBe(404);
    const texto = await r.text();
    expect(texto).not.toContain(fixture.companyA.id);
    expect(texto).not.toContain("auditoria");

    expect(await prisma.timeAdjustmentRequest.count()).toBe(1);
  });

  it("perfil não-ADMIN é recusado ANTES de reservar chave", async () => {
    for (const usuario of [fixture.dispatcherA.id, fixture.techA.id]) {
      const r = await criar(
        fixture.techA.id,
        await createTokenFor(usuario),
        corpo(),
      );
      expect(r.status).toBe(403);
    }
    // Nenhuma reserva: um não-autorizado não consegue nem ocupar uma chave.
    expect(await prisma.idempotencyRecord.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// A3 — corridas em torno da regra de quatro olhos
// ---------------------------------------------------------------------------

describe("A3: corrida real na decisão", () => {
  async function pedidoProprio() {
    const p = await requestTimeAdjustment(
      fixture.companyA.id,
      fixture.adminA.id,
      {
        requestedType: "MISSING_ENTRY",
        requestedEntryType: "CLOCK_IN",
        requestedOccurredAt: new Date(Date.now() - 3_600_000),
        reason: "corrida",
        targetEntryId: null,
      },
    );
    return p.id;
  }

  it("autor e outro admin decidindo JUNTOS: só a decisão legítima vale", async () => {
    const id = await pedidoProprio();
    const segundo = await admin2();

    const [proprio, alheio] = await Promise.allSettled([
      decideTimeAdjustment(fixture.companyA.id, fixture.adminA.id, id, "APPROVED"),
      decideTimeAdjustment(fixture.companyA.id, segundo.id, id, "APPROVED"),
    ]);

    expect(proprio.status).toBe("rejected");
    expect(alheio.status).toBe("fulfilled");

    const linha = await prisma.timeAdjustmentRequest.findUniqueOrThrow({
      where: { id },
      select: { status: true, decidedById: true },
    });
    expect(linha.status).toBe("APPROVED");
    expect(linha.decidedById).toBe(segundo.id);

    // Uma marcação derivada, nunca duas.
    expect(
      await prisma.timeEntry.count({ where: { adjustmentRequestId: id } }),
    ).toBe(1);
    // E um AuditLog só, do decisor legítimo.
    const auditoria = await prisma.auditLog.findMany({
      where: { entityId: id },
      select: { userId: true },
    });
    expect(auditoria).toHaveLength(1);
    expect(auditoria[0].userId).toBe(segundo.id);
  });

  it("dez tentativas do PRÓPRIO autor em paralelo não produzem efeito nenhum", async () => {
    const id = await pedidoProprio();

    const r = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        decideTimeAdjustment(fixture.companyA.id, fixture.adminA.id, id, "APPROVED"),
      ),
    );

    expect(r.every((x) => x.status === "rejected")).toBe(true);
    expect(
      await prisma.timeAdjustmentRequest.findUniqueOrThrow({
        where: { id },
        select: { status: true },
      }),
    ).toEqual({ status: "PENDING" });
    expect(await prisma.timeEntry.count()).toBe(0);
    expect(await prisma.auditLog.count({ where: { entityId: id } })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// A4 — fuso vindo do cliente
// ---------------------------------------------------------------------------

describe("A4: o cliente não escolhe o fuso", () => {
  it("timezone/utcOffset no corpo da batida do Field são recusados", async () => {
    await prisma.technician.upsert({
      where: { userId: fixture.techA.id },
      update: {},
      create: { companyId: fixture.companyA.id, userId: fixture.techA.id },
    });
    const { token } = await registerTestDevice(fixture.techA.id, {
      installationId: `inst-audit-${Date.now()}`,
    });

    for (const veneno of [
      { type: "CLOCK_IN", timezone: "Pacific/Kiritimati" },
      { type: "CLOCK_IN", utcOffset: "+14:00" },
    ]) {
      const r = await punchRoute(
        fieldRequest("/api/field/v1/time-clock/entries", {
          method: "POST",
          token,
          idempotencyKey: chave(),
          body: veneno,
        }),
      );
      expect(r.status).toBe(400);
    }
    expect(await prisma.timeEntry.count()).toBe(0);
  });

  it("timezone no corpo da correção administrativa é recusado", async () => {
    const r = await criar(
      fixture.techA.id,
      await createTokenFor(fixture.adminA.id),
      corpo({ timezone: "Pacific/Kiritimati" }),
    );
    expect(r.status).toBe(400);
  });

  it("o dia gravado usa o fuso da EMPRESA, não o do corpo", async () => {
    await prisma.company.update({
      where: { id: fixture.companyA.id },
      data: { timezone: "Asia/Kolkata" },
    });
    await prisma.technician.upsert({
      where: { userId: fixture.techA.id },
      update: {},
      create: { companyId: fixture.companyA.id, userId: fixture.techA.id },
    });
    const { token } = await registerTestDevice(fixture.techA.id, {
      installationId: `inst-tz-${Date.now()}`,
    });

    const r = await punchRoute(
      fieldRequest("/api/field/v1/time-clock/entries", {
        method: "POST",
        token,
        idempotencyKey: chave(),
        body: { type: "CLOCK_IN" },
      }),
    );
    expect(r.status).toBe(201);

    const dia = await prisma.workday.findFirstOrThrow({
      select: { timezone: true },
    });
    expect(dia.timezone).toBe("Asia/Kolkata");

    const payload = (await r.json()) as {
      data: { workday: { utcOffset: string; timezone: string } };
    };
    expect(payload.data.workday.utcOffset).toBe("+05:30");
  });
});

// ---------------------------------------------------------------------------
// A5 — cross-tenant na decisão, com controle positivo
// ---------------------------------------------------------------------------

describe("A5: decisão cross-tenant pela ROTA", () => {
  it("ADMIN da empresa B recebe 404 e o corpo não descreve o pedido", async () => {
    const pedido = await requestTimeAdjustment(
      fixture.companyA.id,
      fixture.techA.id,
      {
        requestedType: "MISSING_ENTRY",
        requestedEntryType: "CLOCK_IN",
        requestedOccurredAt: new Date(Date.now() - 3_600_000),
        reason: "segredo da empresa A",
        targetEntryId: null,
      },
    );

    const r = await decisionRoute(
      apiRequest(
        `/api/time-clock/adjustments/${pedido.id}/decision`,
        { method: "POST", body: { decision: "APPROVED" }, headers: ORIGEM },
        await createTokenFor(fixture.adminB.id),
      ),
      { params: { id: pedido.id } },
    );

    expect(r.status).toBe(404);
    const texto = await r.text();
    expect(texto).not.toContain("segredo da empresa A");
    expect(texto).not.toContain(fixture.techA.id);

    expect(
      await prisma.timeAdjustmentRequest.findUniqueOrThrow({
        where: { id: pedido.id },
        select: { status: true },
      }),
    ).toEqual({ status: "PENDING" });

    // CONTROLE POSITIVO: o mesmo pedido, pelo ADMIN certo, é decidido.
    const ok = await decisionRoute(
      apiRequest(
        `/api/time-clock/adjustments/${pedido.id}/decision`,
        { method: "POST", body: { decision: "APPROVED" }, headers: ORIGEM },
        await createTokenFor(fixture.adminA.id),
      ),
      { params: { id: pedido.id } },
    );
    expect(ok.status).toBe(200);
  });
});
