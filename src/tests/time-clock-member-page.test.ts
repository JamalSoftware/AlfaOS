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

/**
 * Chave nova a cada chamada.
 *
 * A rota exige `Idempotency-Key` (§253, LOW-2), e cada `pedir()` destes testes
 * é um COMANDO diferente. Repetir a chave faria o segundo receber o desfecho
 * guardado do primeiro — e um teste de enumeração passaria por replay em vez
 * de por autorização, que é o oposto do que ele afirma.
 */
let sequencia = 0;
const chaveNova = () => `teste-membro-${Date.now()}-${++sequencia}`;

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
      {
        method: "POST",
        body,
        headers: { ...MESMA_ORIGEM, "Idempotency-Key": chaveNova() },
      },
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

/*
  SEPARAÇÃO DE FUNÇÕES NA PRÓPRIA JORNADA (§253, LOW-1).

  A v0.9 fechou sem esta regra, e o registro dizia isso com todas as letras:
  quem pedia podia decidir, e o que existia era rastro. O piloto físico
  transformou a observação em decisão normativa da Fase 1 — abrir continua
  permitido, fechar o ciclo sozinho não.

  Proibir a ABERTURA seria o erro fácil: um ADMIN que esqueceu de bater ficaria
  sem caminho nenhum, e o único jeito de acertar o próprio dia voltaria a ser
  o `UPDATE` na marcação — exatamente o que o módulo existe para impedir.
*/
describe("ATAQUE: o ADMIN corrige a PRÓPRIA jornada", () => {
  /**
   * Um SEGUNDO ADMIN da empresa A.
   *
   * Criado aqui, e não na fixture compartilhada: acrescentar um usuário à
   * empresa A mexeria na contagem de todo teste que lista gente dela.
   */
  const outroAdmin = () =>
    prisma.user.create({
      data: {
        companyId: fixture.companyA.id,
        name: "Segundo Administrador",
        email: "admin2@alfa.test",
        profile: "ADMIN",
        active: true,
        passwordHash: "x",
      },
      select: { id: true },
    });

  async function abrirParaSiMesmo() {
    const token = await createTokenFor(fixture.adminA.id);
    const r = await pedir(fixture.adminA.id, token);
    // (A) ABRIR é permitido.
    expect(r.status).toBe(201);
    return ((await r.json()) as { data: { adjustment: { id: string } } }).data
      .adjustment.id;
  }

  it("abre para si mesmo, mas NÃO aprova nem rejeita", async () => {
    const id = await abrirParaSiMesmo();

    // (B) e (C): as duas decisões, não só a aprovação. Recusar só o "sim"
    // deixaria o mesmo conflito de interesse pela porta do "não".
    for (const decisao of ["APPROVED", "REJECTED"] as const) {
      await expect(
        decideTimeAdjustment(
          fixture.companyA.id,
          fixture.adminA.id,
          id,
          decisao,
        ),
      ).rejects.toMatchObject({ status: 403 });
    }

    // (F) O pedido sobrevive à tentativa, e sobrevive PENDENTE: recusar a
    // decisão não pode consumir o pedido, ou a pessoa perderia a correção
    // legítima ao tentar decidi-la por engano.
    const linha = await prisma.timeAdjustmentRequest.findUniqueOrThrow({
      where: { id },
      select: {
        status: true,
        requestedById: true,
        decidedById: true,
        decidedAt: true,
      },
    });
    expect(linha.status).toBe("PENDING");
    expect(linha.requestedById).toBe(fixture.adminA.id);
    expect(linha.decidedById).toBeNull();
    expect(linha.decidedAt).toBeNull();

    // (G) Nenhuma marcação derivada nasceu da tentativa.
    expect(
      await prisma.timeEntry.count({
        where: { adjustmentRequestId: id },
      }),
    ).toBe(0);

    // (H) E nenhum AuditLog de decisão que não houve. Um rastro de aprovação
    // sem aprovação é pior que rastro nenhum: mente para quem audita depois.
    expect(
      await prisma.auditLog.count({ where: { entityId: id } }),
    ).toBe(0);
  });

  it("OUTRO ADMIN da mesma empresa decide normalmente", async () => {
    const id = await abrirParaSiMesmo();
    const segundo = await outroAdmin();

    // (D) O caminho legítimo continua aberto — a regra é sobre a MESMA
    // pessoa, não sobre o perfil.
    const decidido = await decideTimeAdjustment(
      fixture.companyA.id,
      segundo.id,
      id,
      "APPROVED",
    );
    expect(decidido.status).toBe("APPROVED");

    const linha = await prisma.timeAdjustmentRequest.findUniqueOrThrow({
      where: { id },
      select: { requestedById: true, decidedById: true },
    });
    expect(linha.requestedById).toBe(fixture.adminA.id);
    expect(linha.decidedById).toBe(segundo.id);

    // Agora sim há decisão, e ela é auditada.
    const auditoria = await prisma.auditLog.findMany({
      where: { entityId: id },
      select: { action: true, userId: true, companyId: true },
    });
    expect(auditoria).toHaveLength(1);
    expect(auditoria[0]).toEqual({
      action: "TIME_ADJUSTMENT.APPROVED",
      userId: segundo.id,
      companyId: fixture.companyA.id,
    });

    // E a marcação derivada nasceu, apontando para o pedido.
    expect(
      await prisma.timeEntry.count({ where: { adjustmentRequestId: id } }),
    ).toBe(1);
  });

  it("ADMIN de OUTRA empresa não decide — e não aprende que existe", async () => {
    const id = await abrirParaSiMesmo();

    // (E) 404, não 403: a resposta é indistinguível de "pedido inexistente".
    // Um 403 aqui confirmaria a existência do id a quem sondasse.
    await expect(
      decideTimeAdjustment(
        fixture.companyB.id,
        fixture.adminB.id,
        id,
        "APPROVED",
      ),
    ).rejects.toMatchObject({ status: 404 });

    const linha = await prisma.timeAdjustmentRequest.findUniqueOrThrow({
      where: { id },
      select: { status: true, decidedById: true },
    });
    expect(linha.status).toBe("PENDING");
    expect(linha.decidedById).toBeNull();
  });

  it("o gestor decide o que abriu para OUTRA pessoa", async () => {
    // O contraponto que delimita a regra: quem abre em nome de um funcionário
    // não é beneficiário nenhum, e barrar isso quebraria o §231 — o caminho
    // do painel para quem ficou sem aparelho.
    const token = await createTokenFor(fixture.adminA.id);
    const r = await pedir(fixture.techA.id, token);
    expect(r.status).toBe(201);
    const id = ((await r.json()) as { data: { adjustment: { id: string } } })
      .data.adjustment.id;

    const decidido = await decideTimeAdjustment(
      fixture.companyA.id,
      fixture.adminA.id,
      id,
      "APPROVED",
    );
    expect(decidido.status).toBe("APPROVED");
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
