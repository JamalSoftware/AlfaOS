import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  decideTimeAdjustment,
  getWorkdayView,
  requestTimeAdjustment,
} from "@/lib/time-clock";
import { workdayDateOf } from "@/lib/workday";
import { POST as adminAdjustmentRoute } from "@/app/api/time-clock/members/[userId]/adjustments/route";
import { apiRequest, createTokenFor, seedTestData, type TestFixture } from "./helpers";

/**
 * # A tela do gestor sobre a jornada de UM funcionário
 *
 * Guardas da página `/jornada/:userId` e do endpoint que ela usa. O que estes
 * testes seguram, e que os testes da rota não alcançam: a PÁGINA recusa por
 * conta própria, sem depender de o link estar escondido.
 *
 * Esconder um botão é UX. A tela é server component e resolve sessão, papel e
 * empresa antes de ler jornada nenhuma — quem digitar a URL na barra de
 * endereços recebe a mesma recusa de quem não viu o link.
 *
 * Dados fictícios.
 */

const session = vi.hoisted(() => ({ token: null as string | null }));
vi.mock("next/headers", () => ({
  cookies: () => ({
    get: (name: string) =>
      session.token ? { name, value: session.token } : undefined,
  }),
}));

let fixture: TestFixture;
let tz: string;
let em: (f: number) => Date;

beforeEach(async () => {
  fixture = await seedTestData();
  session.token = null;
  const agora = new Date();
  const d = (18 - agora.getUTCHours() + 24) % 24;
  tz = d === 0 ? "Etc/GMT" : d <= 14 ? `Etc/GMT-${d}` : `Etc/GMT+${24 - d}`;
  await prisma.company.update({
    where: { id: fixture.companyA.id },
    data: { timezone: tz },
  });
  const p = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(agora);
  const n = (t: string) => Number(p.find((x) => x.type === t)!.value);
  const ms = ((n("hour") * 60 + n("minute")) * 60 + n("second")) * 1000;
  em = (f: number) => new Date(agora.getTime() - Math.round(ms * (1 - f)));
});

const MESMA_ORIGEM = { Origin: "http://localhost", Host: "localhost" };

function corpo(overrides: Record<string, unknown> = {}) {
  return {
    requestedType: "MISSING_ENTRY",
    requestedEntryType: "CLOCK_IN",
    requestedOccurredAt: em(0.4).toISOString(),
    reason: "ataque",
    ...overrides,
  };
}

function pedir(userId: string, token: string, body = corpo()) {
  return adminAdjustmentRoute(
    apiRequest(
      `/api/time-clock/members/${userId}/adjustments`,
      { method: "POST", body, headers: MESMA_ORIGEM },
      token,
    ),
    { params: { userId } },
  );
}

describe("ATAQUE: enumeração pelo endpoint administrativo", () => {
  it("id inexistente e id de outra empresa respondem IGUAL", async () => {
    const token = await createTokenFor(fixture.adminA.id);

    const inexistente = await pedir("cku00000000000000000000000", token);
    const deOutraEmpresa = await pedir(fixture.adminB.id, token);

    expect(inexistente.status).toBe(deOutraEmpresa.status);
    expect(await inexistente.json()).toEqual(await deOutraEmpresa.json());
    expect(inexistente.status).toBe(404);
  });
});

describe("ATAQUE: guard da página /jornada/[userId]", () => {
  it("ADMIN da empresa B não renderiza a jornada de um usuário da A", async () => {
    const { default: MemberWorkdayPage } = await import(
      "@/app/(app)/jornada/[userId]/page"
    );
    session.token = await createTokenFor(fixture.adminB.id);

    // `notFound()` sinaliza por exceção marcada, como `redirect()`.
    await expect(
      MemberWorkdayPage({
        params: { userId: fixture.techA.id },
        searchParams: {},
      }),
    ).rejects.toMatchObject({ digest: "NEXT_NOT_FOUND" });
  });

  it("DISPATCHER é redirecionado, não renderiza", async () => {
    const { default: MemberWorkdayPage } = await import(
      "@/app/(app)/jornada/[userId]/page"
    );
    session.token = await createTokenFor(fixture.dispatcherA.id);

    await expect(
      MemberWorkdayPage({
        params: { userId: fixture.techA.id },
        searchParams: {},
      }),
    ).rejects.toMatchObject({
      digest: expect.stringContaining("NEXT_REDIRECT"),
    });
  });

  it("CONTROLE POSITIVO: o ADMIN da própria empresa renderiza", async () => {
    const { default: MemberWorkdayPage } = await import(
      "@/app/(app)/jornada/[userId]/page"
    );
    session.token = await createTokenFor(fixture.adminA.id);

    const arvore = await MemberWorkdayPage({
      params: { userId: fixture.techA.id },
      searchParams: {},
    });
    expect(arvore).toBeTruthy();
  });

  it("data hostil no query param não derruba a página", async () => {
    const { default: MemberWorkdayPage } = await import(
      "@/app/(app)/jornada/[userId]/page"
    );
    session.token = await createTokenFor(fixture.adminA.id);

    for (const raw of ["9999-99-99", "abc", "", "2026-13-45", "../../etc"]) {
      const arvore = await MemberWorkdayPage({
        params: { userId: fixture.techA.id },
        searchParams: { date: raw },
      });
      expect(arvore).toBeTruthy();
    }
  });
});

describe("ATAQUE: dois pedidos administrativos idênticos em corrida", () => {
  it("duplicam a fila, mas nunca duplicam a marcação", async () => {
    const dia = await prisma.workday.create({
      data: {
        companyId: fixture.companyA.id,
        userId: fixture.techA.id,
        date: workdayDateOf(new Date(), tz),
        timezone: tz,
      },
      select: { id: true },
    });
    const entrada = await prisma.timeEntry.create({
      data: {
        companyId: fixture.companyA.id,
        userId: fixture.techA.id,
        workdayId: dia.id,
        type: "CLOCK_IN",
        source: "WEB",
        occurredAt: em(0.2),
      },
      select: { id: true },
    });

    const token = await createTokenFor(fixture.adminA.id);
    const body = corpo({
      requestedType: "WRONG_TIME",
      targetEntryId: entrada.id,
    });

    // A rota da web não tem Idempotency-Key — ela é infraestrutura do Field.
    const r = await Promise.all([
      pedir(fixture.techA.id, token, body),
      pedir(fixture.techA.id, token, body),
    ]);
    expect(r.map((x) => x.status)).toEqual([201, 201]);

    const pedidos = await prisma.timeAdjustmentRequest.findMany({
      select: { id: true },
    });
    expect(pedidos).toHaveLength(2);

    // Aprovar os DOIS: o segundo bate na regra de alvo já superado.
    const primeiro = await decideTimeAdjustment(
      fixture.companyA.id,
      fixture.adminA.id,
      pedidos[0].id,
      "APPROVED",
    );
    expect(primeiro.status).toBe("APPROVED");

    await expect(
      decideTimeAdjustment(
        fixture.companyA.id,
        fixture.adminA.id,
        pedidos[1].id,
        "APPROVED",
      ),
    ).rejects.toMatchObject({ status: 409 });

    // UMA versão efetiva, sempre.
    const v = await getWorkdayView(fixture.companyA.id, fixture.techA.id);
    expect(v.entries).toHaveLength(1);
    expect(v.entries.filter((e) => e.type === "CLOCK_IN")).toHaveLength(1);
  });
});

describe("ATAQUE: o ADMIN corrige a PRÓPRIA jornada", () => {
  it("consegue abrir e decidir sozinho — e tudo fica auditado", async () => {
    const token = await createTokenFor(fixture.adminA.id);

    const r = await pedir(fixture.adminA.id, token);
    expect(r.status).toBe(201);
    const id = (
      (await r.json()) as { data: { adjustment: { id: string } } }
    ).data.adjustment.id;

    const decidido = await decideTimeAdjustment(
      fixture.companyA.id,
      fixture.adminA.id,
      id,
      "APPROVED",
    );
    expect(decidido.status).toBe("APPROVED");

    /*
      Não há separação de funções: quem pede e quem decide podem ser a mesma
      pessoa. O que existe é RASTRO — pedido, autor, decisor e AuditLog ficam
      todos gravados, e a marcação derivada aponta para o pedido.
    */
    const linha = await prisma.timeAdjustmentRequest.findUniqueOrThrow({
      where: { id },
      select: { requestedById: true, decidedById: true, reason: true },
    });
    expect(linha.requestedById).toBe(fixture.adminA.id);
    expect(linha.decidedById).toBe(fixture.adminA.id);

    const auditoria = await prisma.auditLog.findMany({
      where: { entityId: id },
      select: { action: true, userId: true, companyId: true },
    });
    expect(auditoria).toHaveLength(1);
    expect(auditoria[0]).toEqual({
      action: "TIME_ADJUSTMENT.APPROVED",
      userId: fixture.adminA.id,
      companyId: fixture.companyA.id,
    });
  });
});

describe("ATAQUE: texto livre do motivo", () => {
  it("é guardado como TEXTO, sem interpretação", async () => {
    const veneno = "<script>alert(1)</script> & \"aspas\" 'simples'";
    const token = await createTokenFor(fixture.adminA.id);

    const r = await pedir(
      fixture.techA.id,
      token,
      corpo({ reason: veneno }),
    );
    expect(r.status).toBe(201);

    const linha = await prisma.timeAdjustmentRequest.findFirstOrThrow({
      select: { reason: true },
    });
    // Nada é escapado nem removido na gravação: quem escapa é a renderização.
    expect(linha.reason).toBe(veneno);
  });

  it("motivo vazio ou só espaços é recusado", async () => {
    const token = await createTokenFor(fixture.adminA.id);
    for (const vazio of ["", "   "]) {
      const r = await pedir(fixture.techA.id, token, corpo({ reason: vazio }));
      expect([400]).toContain(r.status);
    }
    expect(await prisma.timeAdjustmentRequest.count()).toBe(0);
  });
});

describe("ATAQUE: a jornada é do FUNCIONÁRIO, não só do técnico", () => {
  it("o gestor corrige a jornada de um DISPATCHER", async () => {
    const r = await pedir(
      fixture.dispatcherA.id,
      await createTokenFor(fixture.adminA.id),
    );
    // §226: a jornada é presa à PESSOA. Quem passou o dia no almoxarifado
    // também tem jornada.
    expect(r.status).toBe(201);
    const linha = await prisma.timeAdjustmentRequest.findFirstOrThrow({
      select: { userId: true },
    });
    expect(linha.userId).toBe(fixture.dispatcherA.id);
  });
});

describe("ATAQUE: autor forjado direto no domínio", () => {
  it("um autor de fora da empresa é recusado sem efeito parcial", async () => {
    await expect(
      requestTimeAdjustment(
        fixture.companyA.id,
        fixture.techA.id,
        {
          requestedType: "MISSING_ENTRY",
          requestedEntryType: "CLOCK_IN",
          requestedOccurredAt: em(0.4),
          reason: "autor de outra empresa",
          targetEntryId: null,
        },
        fixture.adminB.id,
      ),
    ).rejects.toMatchObject({ status: 404 });

    expect(await prisma.timeAdjustmentRequest.count()).toBe(0);
    // A jornada NÃO pode nascer como efeito colateral do caminho recusado.
    expect(await prisma.workday.count()).toBe(0);
  });
});
