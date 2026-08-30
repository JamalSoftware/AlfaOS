import { describe, it, expect, beforeEach } from "vitest";
import type { TimeEntryType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  decideTimeAdjustment,
  getWorkdayView,
  requestTimeAdjustment,
} from "@/lib/time-clock";
import { workdayDateOf } from "@/lib/workday";
import { POST as adminAdjustmentRoute } from "@/app/api/time-clock/members/[userId]/adjustments/route";
import { GET as queueRoute } from "@/app/api/time-clock/adjustments/route";
import { POST as decisionRoute } from "@/app/api/time-clock/adjustments/[id]/decision/route";
import { POST as punchRoute } from "@/app/api/field/v1/time-clock/entries/route";
import { GET as todayRoute } from "@/app/api/field/v1/time-clock/today/route";
import { POST as fieldAdjustmentRoute } from "@/app/api/field/v1/time-clock/adjustments/route";
import {
  apiRequest,
  createTokenFor,
  fieldRequest,
  registerTestDevice,
  seedTestData,
  type TestFixture,
} from "./helpers";

/**
 * # Correção administrativa de jornada
 *
 * O gestor precisava de um caminho para corrigir a jornada de quem não podia
 * pedir — aparelho sem bateria, sem sinal, ou pessoa que não usa o Field. Sem
 * ele, a única saída seria um `UPDATE` na marcação, que é exatamente o que o
 * módulo existe para impedir (PRD §229).
 *
 * O que estes testes seguram: o caminho novo **não é um atalho**. Ele cria o
 * MESMO `TimeAdjustmentRequest`, entra na MESMA fila e é aprovado pelo MESMO
 * `decideTimeAdjustment`. Nenhuma linha de `TimeEntry` é editada em lugar
 * nenhum.
 *
 * Dados fictícios.
 */

let fixture: TestFixture;
let tz: string;
/** f=0 → meia-noite civil; f=1 → agora. Todo instante é passado e de HOJE. */
let em: (f: number) => Date;

beforeEach(async () => {
  fixture = await seedTestData();
  const agora = new Date();
  /*
    Fuso escolhido para que "agora" caia por volta das 18h locais.

    Com o dia civil já bem adiantado, todo horário calculado como fração do dia
    é passado — e o teste não depende da hora em que a suíte roda. Ancorar no
    fuso real deixaria a bateria quebrada quando ela rodasse de madrugada.
  */
  const d = (18 - agora.getUTCHours() + 24) % 24;
  tz = d === 0 ? "Etc/GMT" : d <= 14 ? `Etc/GMT-${d}` : `Etc/GMT+${24 - d}`;
  await prisma.company.update({
    where: { id: fixture.companyA.id },
    data: { timezone: tz },
  });
  const partes = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(agora);
  const n = (t: string) => Number(partes.find((p) => p.type === t)!.value);
  const ms = ((n("hour") * 60 + n("minute")) * 60 + n("second")) * 1000;
  em = (f: number) => new Date(agora.getTime() - Math.round(ms * (1 - f)));
});

async function abrirDia(userId?: string): Promise<string> {
  const dia = await prisma.workday.create({
    data: {
      companyId: fixture.companyA.id,
      userId: userId ?? fixture.techA.id,
      date: workdayDateOf(new Date(), tz),
      timezone: tz,
    },
    select: { id: true },
  });
  return dia.id;
}

function marcar(workdayId: string, type: TimeEntryType, occurredAt: Date) {
  return prisma.timeEntry.create({
    data: {
      companyId: fixture.companyA.id,
      userId: fixture.techA.id,
      workdayId,
      type,
      source: "WEB",
      occurredAt,
    },
    select: { id: true, occurredAt: true, type: true },
  });
}

const MESMA_ORIGEM = { Origin: "http://localhost", Host: "localhost" };

function pedirComoGestor(
  userId: string,
  body: Record<string, unknown>,
  token: string,
  headers: Record<string, string> = MESMA_ORIGEM,
) {
  return adminAdjustmentRoute(
    apiRequest(
      `/api/time-clock/members/${userId}/adjustments`,
      { method: "POST", body, headers },
      token,
    ),
    { params: { userId } },
  );
}

function corpoDoPedido(overrides: Record<string, unknown> = {}) {
  return {
    requestedType: "WRONG_TIME",
    requestedEntryType: "CLOCK_IN",
    requestedOccurredAt: em(0.4).toISOString(),
    reason: "Aparelho sem bateria; ele chegou no horário.",
    ...overrides,
  };
}

const view = () => getWorkdayView(fixture.companyA.id, fixture.techA.id);

describe("o gestor abre a correção, e ela é um PEDIDO", () => {
  it("cria pendente, com o gestor como autor e o funcionário como dono", async () => {
    const dia = await abrirDia();
    const entrada = await marcar(dia, "CLOCK_IN", em(0.2));

    const r = await pedirComoGestor(
      fixture.techA.id,
      corpoDoPedido({ targetEntryId: entrada.id }),
      await createTokenFor(fixture.adminA.id),
    );
    expect(r.status).toBe(201);

    const gravado = await prisma.timeAdjustmentRequest.findFirstOrThrow({
      select: {
        status: true,
        userId: true,
        requestedById: true,
        companyId: true,
        targetEntryId: true,
      },
    });

    /*
      Quem PEDE e de QUEM é a jornada são pessoas diferentes — e as duas ficam
      registradas. Sem isso o histórico diria que o técnico pediu uma correção
      que ele nunca abriu.
    */
    expect(gravado).toEqual({
      status: "PENDING",
      userId: fixture.techA.id,
      requestedById: fixture.adminA.id,
      companyId: fixture.companyA.id,
      targetEntryId: entrada.id,
    });

    // E NADA foi aplicado: a marcação original continua sendo a que vale.
    const v = await view();
    expect(v.entries).toHaveLength(1);
    expect(v.entries[0].id).toBe(entrada.id);
    expect(v.entries[0].occurredAt.getTime()).toBe(em(0.2).getTime());
  });

  it("o pedido do gestor cai na MESMA fila do pedido do aplicativo", async () => {
    const dia = await abrirDia();
    const entrada = await marcar(dia, "CLOCK_IN", em(0.2));

    // Um pelo painel...
    await pedirComoGestor(
      fixture.techA.id,
      corpoDoPedido({ targetEntryId: entrada.id }),
      await createTokenFor(fixture.adminA.id),
    );
    // ...e um pelo domínio, como o Field faz.
    await requestTimeAdjustment(fixture.companyA.id, fixture.techA.id, {
      requestedType: "MISSING_ENTRY",
      requestedEntryType: "CLOCK_OUT",
      requestedOccurredAt: em(0.8),
      reason: "esqueci de encerrar",
      targetEntryId: null,
    });

    const fila = await queueRoute(
      apiRequest(
        "/api/time-clock/adjustments",
        {},
        await createTokenFor(fixture.adminA.id),
      ),
    );
    const dados = (await fila.json()) as {
      data: {
        adjustments: { userName: string; requestedByName: string }[];
      };
    };

    // Duas filas seriam duas verdades sobre o que espera decisão.
    expect(dados.data.adjustments).toHaveLength(2);
    // A fila diz de QUEM é a jornada, e quem digitou o pedido.
    expect(
      dados.data.adjustments.every((a) => a.userName === "Tecnico Alfa"),
    ).toBe(true);
    expect(
      dados.data.adjustments.map((a) => a.requestedByName).sort(),
    ).toEqual(["Administrador Alfa", "Tecnico Alfa"]);
  });

  it("aprovar o pedido do gestor passa pelo caminho normal e preserva a original", async () => {
    const dia = await abrirDia();
    const entrada = await marcar(dia, "CLOCK_IN", em(0.2));
    const bruto = await prisma.timeEntry.findUniqueOrThrow({
      where: { id: entrada.id },
    });

    const criado = await pedirComoGestor(
      fixture.techA.id,
      corpoDoPedido({ targetEntryId: entrada.id }),
      await createTokenFor(fixture.adminA.id),
    );
    const pedidoId = (
      (await criado.json()) as { data: { adjustment: { id: string } } }
    ).data.adjustment.id;

    const decisao = await decisionRoute(
      apiRequest(
        `/api/time-clock/adjustments/${pedidoId}/decision`,
        {
          method: "POST",
          body: { decision: "APPROVED" },
          headers: MESMA_ORIGEM,
        },
        await createTokenFor(fixture.adminA.id),
      ),
      { params: { id: pedidoId } },
    );
    expect(decisao.status).toBe(200);

    /*
      A correção do painel é um FATO NOVO, não uma edição.

      A linha original continua byte a byte igual; o que mudou é qual delas
      compõe a jornada efetiva.
    */
    expect(
      await prisma.timeEntry.findUniqueOrThrow({ where: { id: entrada.id } }),
    ).toEqual(bruto);

    const v = await view();
    expect(v.entries).toHaveLength(1);
    expect(v.entries[0].id).not.toBe(entrada.id);
    expect(v.entries[0].fromAdjustment).toBe(true);
    expect(v.entries[0].occurredAt.getTime()).toBe(em(0.4).getTime());
    // Duas linhas no banco, uma efetiva.
    expect(
      await prisma.timeEntry.count({ where: { userId: fixture.techA.id } }),
    ).toBe(2);
  });

  it("rejeitar o pedido do gestor não muda horário nenhum", async () => {
    const dia = await abrirDia();
    const entrada = await marcar(dia, "CLOCK_IN", em(0.2));

    const criado = await pedirComoGestor(
      fixture.techA.id,
      corpoDoPedido({ targetEntryId: entrada.id }),
      await createTokenFor(fixture.adminA.id),
    );
    const pedidoId = (
      (await criado.json()) as { data: { adjustment: { id: string } } }
    ).data.adjustment.id;

    await decisionRoute(
      apiRequest(
        `/api/time-clock/adjustments/${pedidoId}/decision`,
        {
          method: "POST",
          body: { decision: "REJECTED", decisionReason: "Não confere." },
          headers: MESMA_ORIGEM,
        },
        await createTokenFor(fixture.adminA.id),
      ),
      { params: { id: pedidoId } },
    );

    const v = await view();
    expect(v.entries).toHaveLength(1);
    expect(v.entries[0].id).toBe(entrada.id);
    expect(v.entries[0].occurredAt.getTime()).toBe(em(0.2).getTime());
    expect(
      await prisma.timeEntry.count({ where: { userId: fixture.techA.id } }),
    ).toBe(1);
  });

  it("uma sequência impossível é recusada também pelo painel", async () => {
    const dia = await abrirDia();
    await marcar(dia, "CLOCK_IN", em(0.5));

    // Saída ANTES da entrada: o gestor não tem poder de gravar um dia
    // impossível só por estar no painel.
    const criado = await pedirComoGestor(
      fixture.techA.id,
      corpoDoPedido({
        requestedType: "MISSING_ENTRY",
        requestedEntryType: "CLOCK_OUT",
        requestedOccurredAt: em(0.3).toISOString(),
      }),
      await createTokenFor(fixture.adminA.id),
    );
    const pedidoId = (
      (await criado.json()) as { data: { adjustment: { id: string } } }
    ).data.adjustment.id;

    const decisao = await decisionRoute(
      apiRequest(
        `/api/time-clock/adjustments/${pedidoId}/decision`,
        {
          method: "POST",
          body: { decision: "APPROVED" },
          headers: MESMA_ORIGEM,
        },
        await createTokenFor(fixture.adminA.id),
      ),
      { params: { id: pedidoId } },
    );
    expect(decisao.status).toBe(400);
    expect(
      await prisma.timeEntry.count({ where: { userId: fixture.techA.id } }),
    ).toBe(1);
  });
});

describe("RBAC e tenancy da correção administrativa", () => {
  it("DISPATCHER não abre correção", async () => {
    await abrirDia();
    const r = await pedirComoGestor(
      fixture.techA.id,
      corpoDoPedido(),
      await createTokenFor(fixture.dispatcherA.id),
    );
    expect(r.status).toBe(403);
    expect(await prisma.timeAdjustmentRequest.count()).toBe(0);
  });

  it("TECHNICIAN não usa o endpoint administrativo", async () => {
    const r = await pedirComoGestor(
      fixture.techA.id,
      corpoDoPedido(),
      await createTokenFor(fixture.techA.id),
    );
    expect(r.status).toBe(403);
    expect(await prisma.timeAdjustmentRequest.count()).toBe(0);
  });

  it("sem sessão é 401", async () => {
    const r = await adminAdjustmentRoute(
      apiRequest(
        `/api/time-clock/members/${fixture.techA.id}/adjustments`,
        { method: "POST", body: corpoDoPedido(), headers: MESMA_ORIGEM },
      ),
      { params: { userId: fixture.techA.id } },
    );
    expect(r.status).toBe(401);
  });

  it("Origin de terceiro é recusado", async () => {
    const r = await pedirComoGestor(
      fixture.techA.id,
      corpoDoPedido(),
      await createTokenFor(fixture.adminA.id),
      { Origin: "https://atacante.example", Host: "localhost" },
    );
    expect(r.status).toBe(403);
    expect(await prisma.timeAdjustmentRequest.count()).toBe(0);
  });

  it("ADMIN da empresa B não corrige funcionário da A", async () => {
    await abrirDia();
    const r = await pedirComoGestor(
      fixture.techA.id,
      corpoDoPedido(),
      await createTokenFor(fixture.adminB.id),
    );

    // 404, não 403: confirmar que o id existe noutra empresa é o que uma sonda
    // não pode aprender.
    expect(r.status).toBe(404);
    expect(await prisma.timeAdjustmentRequest.count()).toBe(0);
    // E nenhuma jornada atravessada nasceu como efeito colateral.
    expect(
      await prisma.workday.count({ where: { companyId: fixture.companyB.id } }),
    ).toBe(0);
  });

  it("campo desconhecido no corpo é RECUSADO, não descartado", async () => {
    const token = await createTokenFor(fixture.adminA.id);
    for (const proibido of [
      { ...corpoDoPedido(), companyId: fixture.companyB.id },
      { ...corpoDoPedido(), userId: fixture.techB.id },
      { ...corpoDoPedido(), requestedById: fixture.techA.id },
      { ...corpoDoPedido(), status: "APPROVED" },
      { ...corpoDoPedido(), workdayId: "forjado" },
    ]) {
      const r = await pedirComoGestor(fixture.techA.id, proibido, token);
      expect(r.status).toBe(400);
    }
    expect(await prisma.timeAdjustmentRequest.count()).toBe(0);

    // CONTROLE POSITIVO: o corpo limpo passa.
    await abrirDia();
    const ok = await pedirComoGestor(fixture.techA.id, corpoDoPedido(), token);
    expect(ok.status).toBe(201);
  });

  it("o alvo tem de ser marcação DAQUELE funcionário", async () => {
    const diaA = await abrirDia();
    const daPessoaA = await marcar(diaA, "CLOCK_IN", em(0.2));

    // O gestor aponta a marcação do técnico A no pedido do técnico B.
    const r = await pedirComoGestor(
      fixture.techB.id,
      corpoDoPedido({ targetEntryId: daPessoaA.id }),
      await createTokenFor(fixture.adminA.id),
    );
    expect(r.status).toBe(404);
    expect(await prisma.timeAdjustmentRequest.count()).toBe(0);
  });
});

describe("JOR-06 — quem decide também é conferido no domínio", () => {
  it("decisor de outra empresa é recusado, sem efeito nenhum", async () => {
    const dia = await abrirDia();
    const entrada = await marcar(dia, "CLOCK_IN", em(0.2));
    const pedido = await requestTimeAdjustment(
      fixture.companyA.id,
      fixture.techA.id,
      {
        requestedType: "WRONG_TIME",
        requestedEntryType: "CLOCK_IN",
        requestedOccurredAt: em(0.4),
        reason: "cheguei antes",
        targetEntryId: entrada.id,
      },
    );

    /*
      Nenhuma rota monta este par — a rota de decisão tira empresa e decisor da
      MESMA sessão. O domínio se defende de qualquer forma, como `punch` e
      `requestTimeAdjustment` já faziam: é a lacuna que não pode ficar aberta
      esperando a primeira rota nova.
    */
    await expect(
      decideTimeAdjustment(
        fixture.companyA.id,
        fixture.adminB.id,
        pedido.id,
        "APPROVED",
      ),
    ).rejects.toMatchObject({ status: 404 });

    const depois = await prisma.timeAdjustmentRequest.findUniqueOrThrow({
      where: { id: pedido.id },
      select: { status: true, decidedById: true, decidedAt: true },
    });
    expect(depois).toEqual({
      status: "PENDING",
      decidedById: null,
      decidedAt: null,
    });

    // Nenhuma derivada, e nenhum AuditLog com o par atravessado.
    expect(
      await prisma.timeEntry.count({
        where: { userId: fixture.techA.id, source: "ADJUSTMENT" },
      }),
    ).toBe(0);
    expect(
      await prisma.auditLog.count({ where: { userId: fixture.adminB.id } }),
    ).toBe(0);
  });

  it("CONTROLE POSITIVO: o decisor da própria empresa aprova", async () => {
    const dia = await abrirDia();
    const entrada = await marcar(dia, "CLOCK_IN", em(0.2));
    const pedido = await requestTimeAdjustment(
      fixture.companyA.id,
      fixture.techA.id,
      {
        requestedType: "WRONG_TIME",
        requestedEntryType: "CLOCK_IN",
        requestedOccurredAt: em(0.4),
        reason: "cheguei antes",
        targetEntryId: entrada.id,
      },
    );

    const decidido = await decideTimeAdjustment(
      fixture.companyA.id,
      fixture.adminA.id,
      pedido.id,
      "APPROVED",
    );
    expect(decidido.status).toBe("APPROVED");
    expect(
      await prisma.auditLog.count({
        where: { companyId: fixture.companyA.id, userId: fixture.adminA.id },
      }),
    ).toBe(1);
  });

  it("um autor de outra empresa também é recusado no pedido", async () => {
    await abrirDia();
    await expect(
      requestTimeAdjustment(
        fixture.companyA.id,
        fixture.techA.id,
        {
          requestedType: "MISSING_ENTRY",
          requestedEntryType: "CLOCK_IN",
          requestedOccurredAt: em(0.4),
          reason: "autor atravessado",
          targetEntryId: null,
        },
        fixture.adminB.id,
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(await prisma.timeAdjustmentRequest.count()).toBe(0);
  });
});

describe("E2E da correção — Field pede, painel decide, Field relê", () => {
  async function tecnicoDeCampo() {
    await prisma.technician.upsert({
      where: { userId: fixture.techA.id },
      update: {},
      create: { companyId: fixture.companyA.id, userId: fixture.techA.id },
    });
    const { token } = await registerTestDevice(fixture.techA.id, {
      installationId: `inst-e2e-${Date.now()}`,
    });
    return token;
  }

  async function pedirPeloField(
    token: string,
    body: Record<string, unknown>,
    chave: string,
  ) {
    return fieldAdjustmentRoute(
      fieldRequest("/api/field/v1/time-clock/adjustments", {
        method: "POST",
        token,
        idempotencyKey: chave,
        body,
      }),
    );
  }

  it("aprovada: original preservada, correção efetiva, estado e ações certos", async () => {
    const token = await tecnicoDeCampo();
    const dia = await abrirDia();
    const entrada = await marcar(dia, "CLOCK_IN", em(0.2));
    await marcar(dia, "CLOCK_OUT", em(0.9));

    // 1. Field: o técnico pede.
    const pedido = await pedirPeloField(
      token,
      {
        requestedType: "WRONG_TIME",
        requestedEntryType: "CLOCK_IN",
        requestedOccurredAt: em(0.5).toISOString(),
        reason: "cheguei mais tarde do que a marcação diz",
        targetEntryId: entrada.id,
      },
      `e2e-pedido-${Date.now()}`,
    );
    expect(pedido.status).toBe(201);
    const pedidoId = (
      (await pedido.json()) as {
        data: { adjustment: { id: string } };
      }
    ).data.adjustment.id;

    // 2. Painel: o pedido aparece na fila do ADMIN.
    const fila = await queueRoute(
      apiRequest(
        "/api/time-clock/adjustments",
        {},
        await createTokenFor(fixture.adminA.id),
      ),
    );
    const naFila = (
      (await fila.json()) as { data: { adjustments: { id: string }[] } }
    ).data.adjustments;
    expect(naFila.map((a) => a.id)).toContain(pedidoId);

    // 3. Painel: o ADMIN aprova.
    const decisao = await decisionRoute(
      apiRequest(
        `/api/time-clock/adjustments/${pedidoId}/decision`,
        {
          method: "POST",
          body: { decision: "APPROVED" },
          headers: MESMA_ORIGEM,
        },
        await createTokenFor(fixture.adminA.id),
      ),
      { params: { id: pedidoId } },
    );
    expect(decisao.status).toBe(200);

    // 4. Field: o técnico relê.
    const hoje = await todayRoute(
      fieldRequest("/api/field/v1/time-clock/today", { token }),
    );
    const workday = (
      (await hoje.json()) as {
        data: {
          workday: {
            state: string;
            allowedActions: string[];
            entries: { id: string; occurredAt: string }[];
            workedMinutes: number;
          };
        };
      }
    ).data.workday;

    // A original continua no banco, e fora da jornada efetiva.
    expect(
      await prisma.timeEntry.count({ where: { userId: fixture.techA.id } }),
    ).toBe(3);
    expect(workday.entries).toHaveLength(2);
    expect(workday.entries.map((e) => e.id)).not.toContain(entrada.id);
    expect(new Date(workday.entries[0].occurredAt).getTime()).toBe(
      em(0.5).getTime(),
    );

    expect(workday.state).toBe("FINISHED");
    expect(workday.allowedActions).toEqual([]);
    // O espelho conta a partir do horário CORRIGIDO.
    expect(workday.workedMinutes).toBe(
      Math.round((em(0.9).getTime() - em(0.5).getTime()) / 60_000),
    );

    // E a jornada encerrada continua recusando batida.
    const tentativa = await punchRoute(
      fieldRequest("/api/field/v1/time-clock/entries", {
        method: "POST",
        token,
        idempotencyKey: `e2e-batida-${Date.now()}`,
        body: { type: "BREAK_END" },
      }),
    );
    expect(tentativa.status).toBe(400);
  });

  it("rejeitada: a original continua valendo e o app não vê correção aplicada", async () => {
    const token = await tecnicoDeCampo();
    const dia = await abrirDia();
    const entrada = await marcar(dia, "CLOCK_IN", em(0.2));

    const pedido = await pedirPeloField(
      token,
      {
        requestedType: "WRONG_TIME",
        requestedEntryType: "CLOCK_IN",
        requestedOccurredAt: em(0.5).toISOString(),
        reason: "acho que foi mais tarde",
        targetEntryId: entrada.id,
      },
      `e2e-rej-${Date.now()}`,
    );
    const pedidoId = (
      (await pedido.json()) as { data: { adjustment: { id: string } } }
    ).data.adjustment.id;

    await decisionRoute(
      apiRequest(
        `/api/time-clock/adjustments/${pedidoId}/decision`,
        {
          method: "POST",
          body: {
            decision: "REJECTED",
            decisionReason: "A OS do dia mostra você em campo às 08h.",
          },
          headers: MESMA_ORIGEM,
        },
        await createTokenFor(fixture.adminA.id),
      ),
      { params: { id: pedidoId } },
    );

    const hoje = await todayRoute(
      fieldRequest("/api/field/v1/time-clock/today", { token }),
    );
    const workday = (
      (await hoje.json()) as {
        data: {
          workday: {
            entries: { id: string; occurredAt: string; fromAdjustment: boolean }[];
          };
        };
      }
    ).data.workday;

    // Nada aplicado: a marcação original é a única, e não é derivada.
    expect(workday.entries).toHaveLength(1);
    expect(workday.entries[0].id).toBe(entrada.id);
    expect(workday.entries[0].fromAdjustment).toBe(false);
    expect(new Date(workday.entries[0].occurredAt).getTime()).toBe(
      em(0.2).getTime(),
    );
    expect(
      await prisma.timeEntry.count({ where: { userId: fixture.techA.id } }),
    ).toBe(1);

    // O pedido rejeitado NÃO é apagado: quem pediu precisa ver o porquê.
    const rejeitado = await prisma.timeAdjustmentRequest.findUniqueOrThrow({
      where: { id: pedidoId },
      select: { status: true, decisionReason: true },
    });
    expect(rejeitado.status).toBe("REJECTED");
    expect(rejeitado.decisionReason).toBe(
      "A OS do dia mostra você em campo às 08h.",
    );
  });
});
