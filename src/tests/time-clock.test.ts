import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { DomainError } from "@/lib/errors";
import {
  decideTimeAdjustment,
  getMemberWorkdayView,
  getTeamWorkday,
  getWorkdayHistory,
  getWorkdayView,
  listCompanyAdjustments,
  punchTimeClock,
  requestTimeAdjustment,
} from "@/lib/time-clock";
import {
  civilDateIn,
  deriveWorkdayState,
  allowedTransitions,
  workdayDateOf,
  resolveTimezone,
} from "@/lib/workday";
import { seedTestData, type TestFixture } from "./helpers";

/**
 * # Jornada / ponto do funcionário
 *
 * O módulo registra **jornada de trabalho**, e não chegada a uma OS. As duas
 * gravam "cheguei", com GPS, e param de se parecer aí (PRD §226) — por isso
 * este arquivo é separado de `field-execution.test.ts`, que cobre o check-in.
 *
 * Três invariantes atravessam tudo aqui:
 *
 * 1. o horário que vale é o do SERVIDOR;
 * 2. marcação é IMUTÁVEL — correção cria linha nova;
 * 3. o estado é DERIVADO da sequência, não de uma coluna.
 *
 * Nada de dado real: funcionários e empresas são fictícios.
 */

let fixture: TestFixture;

beforeEach(async () => {
  fixture = await seedTestData();
});

async function expectDomainError(fn: () => Promise<unknown>, status: number) {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).status).toBe(status);
    return error as DomainError;
  }
  throw new Error(`esperava DomainError ${status}, mas nada foi lançado`);
}

const A = () => ({ companyId: fixture.companyA.id, userId: fixture.techA.id });

/**
 * Jornada de ONTEM, com horários fixos — e ontem não é preciosismo.
 *
 * Duas armadilhas, as duas descobertas rodando o teste de madrugada:
 *
 * 1. **Correção só aceita horário no PASSADO.** Uma saída "uma hora depois" de
 *    uma entrada batida agora cai sempre no futuro, e o pedido é recusado.
 * 2. **"Uma hora atrás" pode ser OUTRO DIA.** Rodando às 00h30 em São Paulo, o
 *    horário pedido cai na véspera — e o domínio, corretamente, abre a jornada
 *    daquele dia, onde não existe entrada nenhuma. O teste falhava por hora do
 *    relógio, não por defeito.
 *
 * Ontem, em horas UTC fixas, resolve as duas: está inteiramente no passado e as
 * horas escolhidas (11h–21h UTC) caem no mesmo dia civil em qualquer fuso
 * brasileiro.
 */
async function jornadaSemeada(
  sequencia: readonly (readonly [TimeEntryTypeName, number])[],
) {
  const ctx = A();
  const company = await prisma.company.findUniqueOrThrow({
    where: { id: ctx.companyId },
    select: { timezone: true },
  });

  const ontem = new Date(Date.now() - 24 * 3_600_000);
  const dia = civilDateIn(ontem, company.timezone);
  /** Instante seguro dentro do dia civil de ontem, em qualquer fuso do Brasil. */
  const as = (horaUtc: number) =>
    new Date(`${dia}T${String(horaUtc).padStart(2, "0")}:00:00.000Z`);

  const workday = await prisma.workday.create({
    data: {
      companyId: ctx.companyId,
      userId: ctx.userId,
      date: new Date(`${dia}T00:00:00.000Z`),
      timezone: company.timezone,
    },
  });

  const entries = [];
  for (const [type, horaUtc] of sequencia) {
    entries.push(
      await prisma.timeEntry.create({
        data: {
          companyId: ctx.companyId,
          userId: ctx.userId,
          workdayId: workday.id,
          type,
          source: "FIELD_APP",
          occurredAt: as(horaUtc),
        },
      }),
    );
  }
  // `as` volta para o teste montar o horário do pedido no MESMO dia.
  return { ...ctx, workday, entries, as, dia };
}

type TimeEntryTypeName =
  | "CLOCK_IN"
  | "BREAK_START"
  | "BREAK_END"
  | "CLOCK_OUT";

// ---------------------------------------------------------------------------
// Dia operacional e fuso
// ---------------------------------------------------------------------------

describe("Dia operacional", () => {
  it("a batida das 23h50 em São Paulo pertence a HOJE, não a amanhã", () => {
    // 2026-03-10 23:50 em São Paulo = 2026-03-11 02:50 UTC.
    const instant = new Date("2026-03-11T02:50:00.000Z");

    expect(civilDateIn(instant, "America/Sao_Paulo")).toBe("2026-03-10");
    expect(workdayDateOf(instant, "America/Sao_Paulo").toISOString()).toBe(
      "2026-03-10T00:00:00.000Z",
    );

    /*
      O contra-exemplo é o defeito que o fuso existe para evitar.

      Em UTC o mesmo instante é dia 11, e a saída da noite cairia num dia que
      nunca teve entrada — o espelho mostraria uma jornada aberta que nunca
      fechou e outra que começou fechando.
    */
    expect(civilDateIn(instant, "UTC")).toBe("2026-03-11");
  });

  it("fusos diferentes produzem dias diferentes para o mesmo instante", () => {
    const instant = new Date("2026-07-15T03:30:00.000Z");
    expect(civilDateIn(instant, "America/Sao_Paulo")).toBe("2026-07-15");
    // Manaus é uma hora atrás: ainda é dia 14 lá.
    expect(civilDateIn(instant, "America/Manaus")).toBe("2026-07-14");
  });

  it("fuso inválido no banco cai no padrão em vez de derrubar a batida", () => {
    expect(resolveTimezone("Marte/Olympus")).toBe("America/Sao_Paulo");
    expect(resolveTimezone(null)).toBe("America/Sao_Paulo");
    expect(resolveTimezone("America/Manaus")).toBe("America/Manaus");
  });

  it("a empresa nasce com fuso declarado", async () => {
    const company = await prisma.company.findUniqueOrThrow({
      where: { id: fixture.companyA.id },
      select: { timezone: true },
    });
    expect(company.timezone).toBe("America/Sao_Paulo");
  });
});

// ---------------------------------------------------------------------------
// Máquina de estados — pura
// ---------------------------------------------------------------------------

describe("Estado derivado", () => {
  it("deriva o estado da sequência, sem coluna de status", () => {
    expect(deriveWorkdayState([])).toBe("NOT_STARTED");
    expect(deriveWorkdayState(["CLOCK_IN"])).toBe("WORKING");
    expect(deriveWorkdayState(["CLOCK_IN", "BREAK_START"])).toBe("ON_BREAK");
    expect(deriveWorkdayState(["CLOCK_IN", "BREAK_START", "BREAK_END"])).toBe(
      "WORKING",
    );
    expect(
      deriveWorkdayState([
        "CLOCK_IN",
        "BREAK_START",
        "BREAK_END",
        "CLOCK_OUT",
      ]),
    ).toBe("FINISHED");
  });

  it("mais de um intervalo por dia é sequência válida", () => {
    expect(
      deriveWorkdayState([
        "CLOCK_IN",
        "BREAK_START",
        "BREAK_END",
        "BREAK_START",
        "BREAK_END",
      ]),
    ).toBe("WORKING");
  });

  it("o servidor diz o que é permitido — o app não decide", () => {
    expect(allowedTransitions("NOT_STARTED")).toEqual(["CLOCK_IN"]);
    expect(allowedTransitions("WORKING")).toEqual(["BREAK_START", "CLOCK_OUT"]);
    // Em intervalo só se volta: encerrar aqui deixaria um intervalo aberto para
    // sempre, e o espelho não saberia quanto ele durou.
    expect(allowedTransitions("ON_BREAK")).toEqual(["BREAK_END"]);
    // Encerrada não reabre por batida — reabrir é correção, com aprovação.
    expect(allowedTransitions("FINISHED")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Batida
// ---------------------------------------------------------------------------

describe("Marcações", () => {
  it("a sequência completa funciona e o horário vem do SERVIDOR", async () => {
    const ctx = A();
    // O aparelho mente em três anos. O servidor ignora e guarda como metadata.
    const mentira = new Date("2029-01-01T00:00:00.000Z");

    const entrada = await punchTimeClock(ctx.companyId, ctx.userId, {
      type: "CLOCK_IN",
      deviceOccurredAt: mentira,
    });

    expect(entrada.entry.occurredAt.getFullYear()).toBe(
      new Date().getFullYear(),
    );
    expect(entrada.entry.deviceOccurredAt?.toISOString()).toBe(
      mentira.toISOString(),
    );
    expect(entrada.workday.state).toBe("WORKING");

    await punchTimeClock(ctx.companyId, ctx.userId, { type: "BREAK_START" });
    const volta = await punchTimeClock(ctx.companyId, ctx.userId, {
      type: "BREAK_END",
    });
    expect(volta.workday.state).toBe("WORKING");

    const saida = await punchTimeClock(ctx.companyId, ctx.userId, {
      type: "CLOCK_OUT",
    });
    expect(saida.workday.state).toBe("FINISHED");
    expect(saida.workday.allowedActions).toEqual([]);
    expect(saida.workday.entries).toHaveLength(4);
  });

  for (const cenario of [
    { nome: "CLOCK_OUT sem CLOCK_IN", antes: [], tipo: "CLOCK_OUT" },
    { nome: "BREAK_START sem CLOCK_IN", antes: [], tipo: "BREAK_START" },
    { nome: "BREAK_END sem BREAK_START", antes: ["CLOCK_IN"], tipo: "BREAK_END" },
    { nome: "CLOCK_IN duas vezes", antes: ["CLOCK_IN"], tipo: "CLOCK_IN" },
    {
      nome: "BREAK_START duas vezes",
      antes: ["CLOCK_IN", "BREAK_START"],
      tipo: "BREAK_START",
    },
    {
      nome: "CLOCK_OUT durante o intervalo",
      antes: ["CLOCK_IN", "BREAK_START"],
      tipo: "CLOCK_OUT",
    },
    {
      nome: "CLOCK_IN depois de encerrada",
      antes: ["CLOCK_IN", "CLOCK_OUT"],
      tipo: "CLOCK_IN",
    },
  ] as const) {
    it(`recusa: ${cenario.nome}`, async () => {
      const ctx = A();
      for (const tipo of cenario.antes) {
        await punchTimeClock(ctx.companyId, ctx.userId, { type: tipo });
      }

      const erro = await expectDomainError(
        () =>
          punchTimeClock(ctx.companyId, ctx.userId, { type: cenario.tipo }),
        400,
      );
      // A mensagem diz a SAÍDA, não só "inválido": o técnico precisa saber o
      // que fazer.
      expect(erro.message.length).toBeGreaterThan(20);

      // E nada foi gravado a mais.
      expect(
        await prisma.timeEntry.count({ where: { userId: ctx.userId } }),
      ).toBe(cenario.antes.length);
    });
  }

  it("CORRIDA: dois CLOCK_IN simultâneos deixam UMA marcação", async () => {
    const ctx = A();

    /*
      Corrida REAL, não sequência rápida.

      Sem a trava do dia, as duas transações leem "sem marcação" e inserem as
      duas — a máquina de estados sozinha não separa nada aqui, porque as duas
      leem o mesmo passado. Quem serializa é o `FOR UPDATE` na linha do dia.
    */
    const resultados = await Promise.allSettled([
      punchTimeClock(ctx.companyId, ctx.userId, { type: "CLOCK_IN" }),
      punchTimeClock(ctx.companyId, ctx.userId, { type: "CLOCK_IN" }),
    ]);

    const ok = resultados.filter((r) => r.status === "fulfilled");
    const falhas = resultados.filter((r) => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(falhas).toHaveLength(1);

    // Erro CONTROLADO, não 500 cru.
    const motivo = (falhas[0] as PromiseRejectedResult).reason;
    expect(motivo).toBeInstanceOf(DomainError);
    expect((motivo as DomainError).status).toBe(400);

    expect(
      await prisma.timeEntry.count({
        where: { userId: ctx.userId, type: "CLOCK_IN" },
      }),
    ).toBe(1);
    // E um dia só.
    expect(await prisma.workday.count({ where: { userId: ctx.userId } })).toBe(
      1,
    );
  });

  it("CORRIDA com o dia JÁ ABERTO: dois BREAK_START deixam UM", async () => {
    const ctx = A();
    const company = await prisma.company.findUniqueOrThrow({
      where: { id: ctx.companyId },
      select: { timezone: true },
    });
    const agora = new Date();

    /*
      Este é o caso que o `FOR UPDATE` protege — e o outro teste de corrida NÃO
      cobre.

      Com o dia ainda inexistente, quem serializa é o `ON CONFLICT` do insert:
      a segunda transação bloqueia até a primeira decidir. Provado por reversão
      — removendo o `FOR UPDATE`, aquele teste continuava passando.
      Com o dia JÁ ABERTO não há insert nenhum, ninguém bloqueia, e as duas
      transações leem `WORKING` e inserem as duas. O lock explícito é o que
      separa.
    */
    const workday = await prisma.workday.create({
      data: {
        companyId: ctx.companyId,
        userId: ctx.userId,
        date: workdayDateOf(agora, company.timezone),
        timezone: company.timezone,
      },
    });
    await prisma.timeEntry.create({
      data: {
        companyId: ctx.companyId,
        userId: ctx.userId,
        workdayId: workday.id,
        type: "CLOCK_IN",
        source: "FIELD_APP",
        occurredAt: agora,
      },
    });

    const resultados = await Promise.allSettled([
      punchTimeClock(ctx.companyId, ctx.userId, { type: "BREAK_START" }),
      punchTimeClock(ctx.companyId, ctx.userId, { type: "BREAK_START" }),
    ]);

    expect(resultados.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      await prisma.timeEntry.count({
        where: { userId: ctx.userId, type: "BREAK_START" },
      }),
    ).toBe(1);
  });

  it("CORRIDA no primeiro dia: quatro batidas paralelas não duplicam o dia", async () => {
    const ctx = A();

    // A linha do dia ainda não existe: as quatro tentam criá-la ao mesmo tempo.
    await Promise.allSettled([
      punchTimeClock(ctx.companyId, ctx.userId, { type: "CLOCK_IN" }),
      punchTimeClock(ctx.companyId, ctx.userId, { type: "CLOCK_IN" }),
      punchTimeClock(ctx.companyId, ctx.userId, { type: "CLOCK_IN" }),
      punchTimeClock(ctx.companyId, ctx.userId, { type: "CLOCK_IN" }),
    ]);

    expect(await prisma.workday.count({ where: { userId: ctx.userId } })).toBe(
      1,
    );
    expect(
      await prisma.timeEntry.count({ where: { userId: ctx.userId } }),
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// GPS
// ---------------------------------------------------------------------------

describe("GPS é evidência, não autoridade", () => {
  it("sem coordenada a batida acontece", async () => {
    const ctx = A();
    const resultado = await punchTimeClock(ctx.companyId, ctx.userId, {
      type: "CLOCK_IN",
    });
    expect(resultado.entry.latitude).toBeNull();
    expect(resultado.entry.longitude).toBeNull();
  });

  it("coordenada válida é gravada com a precisão", async () => {
    const ctx = A();
    const resultado = await punchTimeClock(ctx.companyId, ctx.userId, {
      type: "CLOCK_IN",
      latitude: -23.5505,
      longitude: -46.6333,
      accuracyMeters: 12.4,
    });
    expect(resultado.entry.latitude).toBeCloseTo(-23.5505, 4);
    expect(resultado.entry.accuracyMeters).toBe(12);
  });

  it("coordenada fora do intervalo é recusada", async () => {
    const ctx = A();
    await expectDomainError(
      () =>
        punchTimeClock(ctx.companyId, ctx.userId, {
          type: "CLOCK_IN",
          latitude: 91,
          longitude: 0,
        }),
      400,
    );
    expect(
      await prisma.timeEntry.count({ where: { userId: ctx.userId } }),
    ).toBe(0);
  });

  it("precisão absurda descarta a coordenada, mas NÃO a batida", async () => {
    const ctx = A();
    const resultado = await punchTimeClock(ctx.companyId, ctx.userId, {
      type: "CLOCK_IN",
      latitude: -23.55,
      longitude: -46.63,
      // 50 km: isso não é localização, é região. Guardar seria afirmar uma
      // posição que o dado não prova.
      accuracyMeters: 50_000,
    });
    expect(resultado.entry.latitude).toBeNull();
    expect(resultado.workday.state).toBe("WORKING");
  });
});

// ---------------------------------------------------------------------------
// Espelho
// ---------------------------------------------------------------------------

describe("Espelho", () => {
  it("soma trabalho e intervalo a partir das marcações", async () => {
    const ctx = A();
    const workday = await prisma.workday.create({
      data: {
        companyId: ctx.companyId,
        userId: ctx.userId,
        date: new Date("2026-05-04T00:00:00.000Z"),
        timezone: "America/Sao_Paulo",
      },
    });

    // Jornada fechada, escrita direto para controlar os horários.
    const base = "2026-05-04T";
    for (const [type, hora] of [
      ["CLOCK_IN", "11:00"],
      ["BREAK_START", "15:00"],
      ["BREAK_END", "16:00"],
      ["CLOCK_OUT", "20:00"],
    ] as const) {
      await prisma.timeEntry.create({
        data: {
          companyId: ctx.companyId,
          userId: ctx.userId,
          workdayId: workday.id,
          type,
          source: "WEB",
          occurredAt: new Date(`${base}${hora}:00.000Z`),
        },
      });
    }

    const view = await getWorkdayView(
      ctx.companyId,
      ctx.userId,
      new Date("2026-05-04T15:00:00.000Z"),
    );

    expect(view.state).toBe("FINISHED");
    expect(view.workedMinutes).toBe(8 * 60);
    expect(view.breakMinutes).toBe(60);
    expect(view.inconsistencies).toEqual([]);
  });

  it("jornada em aberto é sinalizada como inconsistência", async () => {
    const ctx = A();
    await punchTimeClock(ctx.companyId, ctx.userId, { type: "CLOCK_IN" });

    const view = await getWorkdayView(ctx.companyId, ctx.userId);
    expect(view.state).toBe("WORKING");
    expect(view.inconsistencies).toContain("Jornada em aberto.");
  });

  it("dia sem marcação nenhuma não inventa jornada", async () => {
    const ctx = A();
    const view = await getWorkdayView(ctx.companyId, ctx.userId);
    expect(view.workdayId).toBeNull();
    expect(view.state).toBe("NOT_STARTED");
    expect(view.entries).toEqual([]);
    expect(view.allowedActions).toEqual(["CLOCK_IN"]);
  });

  it("o histórico resume cada dia", async () => {
    const ctx = A();
    await punchTimeClock(ctx.companyId, ctx.userId, { type: "CLOCK_IN" });

    const historico = await getWorkdayHistory(
      ctx.companyId,
      ctx.userId,
      new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      new Date(Date.now() + 24 * 60 * 60 * 1000),
    );
    expect(historico).toHaveLength(1);
    expect(historico[0].state).toBe("WORKING");
    expect(historico[0].entryCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Ajustes
// ---------------------------------------------------------------------------

describe("Ajustes", () => {
  it("a aprovação NÃO edita a original — cria uma marcação derivada", async () => {
    const ctx = await jornadaSemeada([["CLOCK_IN", 11]]);
    const original = ctx.entries[0];
    const originalOccurredAt = original.occurredAt.toISOString();

    // DEPOIS da entrada: a saída precisa fazer sentido na sequência do dia.
    const pedido = await requestTimeAdjustment(ctx.companyId, ctx.userId, {
      requestedType: "MISSING_ENTRY",
      requestedEntryType: "CLOCK_OUT",
      requestedOccurredAt: ctx.as(20),
      reason: "Esqueci de bater a saída.",
    });
    expect(pedido.status).toBe("PENDING");

    const decidido = await decideTimeAdjustment(
      ctx.companyId,
      fixture.adminA.id,
      pedido.id,
      "APPROVED",
      "Confere com a OS do dia.",
    );
    expect(decidido.status).toBe("APPROVED");

    /*
      A original está intacta — byte a byte.

      É a regra que sustenta todas as outras (§229): um registro de jornada que
      pode ser reescrito não prova nada.
    */
    const depois = await prisma.timeEntry.findUniqueOrThrow({
      where: { id: original.id },
    });
    expect(depois.occurredAt.toISOString()).toBe(originalOccurredAt);
    expect(depois.source).toBe("FIELD_APP");

    // E existe uma marcação NOVA, derivada, apontando para o pedido.
    const derivada = await prisma.timeEntry.findFirstOrThrow({
      where: { adjustmentRequestId: pedido.id },
    });
    expect(derivada.source).toBe("ADJUSTMENT");
    expect(derivada.type).toBe("CLOCK_OUT");

    // O espelho passa a enxergar a jornada fechada — no dia em que ela existe.
    const view = await getWorkdayView(ctx.companyId, ctx.userId, ctx.as(12));
    expect(view.state).toBe("FINISHED");
    expect(view.entries.some((e) => e.fromAdjustment)).toBe(true);
  });

  it("corrigir o HORÁRIO não reescreve a marcação — ela é superada", async () => {
    const ctx = await jornadaSemeada([
      ["CLOCK_IN", 11],
      ["CLOCK_OUT", 20],
    ]);
    const original = ctx.entries[0];
    const originalOccurredAt = original.occurredAt.toISOString();

    // "Bati às 8h02, mas cheguei às 7h45."
    const pedido = await requestTimeAdjustment(ctx.companyId, ctx.userId, {
      requestedType: "WRONG_TIME",
      requestedEntryType: "CLOCK_IN",
      requestedOccurredAt: ctx.as(10),
      reason: "Cheguei antes; o aplicativo não abriu.",
      targetEntryId: original.id,
    });

    await decideTimeAdjustment(
      ctx.companyId,
      fixture.adminA.id,
      pedido.id,
      "APPROVED",
    );

    /*
      A linha original continua no banco, byte a byte.

      Um `UPDATE` aqui seria mais simples e destruiria exatamente o que o
      registro existe para preservar (§229): o que foi batido, o que foi pedido
      e quem decidiu.
    */
    const depois = await prisma.timeEntry.findUniqueOrThrow({
      where: { id: original.id },
    });
    expect(depois.occurredAt.toISOString()).toBe(originalOccurredAt);

    /*
      Mas ela sai da VISÃO EFETIVA.

      Se as duas contassem, o dia teria duas entradas e a sequência viraria
      impossível. O espelho mostra a corrigida; o histórico guarda as duas.
    */
    const view = await getWorkdayView(ctx.companyId, ctx.userId, ctx.as(12));
    const entradas = view.entries.filter((e) => e.type === "CLOCK_IN");
    expect(entradas).toHaveLength(1);
    expect(entradas[0].fromAdjustment).toBe(true);
    expect(entradas[0].occurredAt.toISOString()).toBe(
      ctx.as(10).toISOString(),
    );
    expect(view.state).toBe("FINISHED");
    // 10h às 20h UTC: a correção esticou a jornada de 9h para 10h.
    expect(view.workedMinutes).toBe(10 * 60);
  });

  it("aprovar correção que deixaria o dia impossível é recusado", async () => {
    const ctx = await jornadaSemeada([["CLOCK_IN", 14]]);

    /*
      Saída ANTES da entrada.

      A batida entra sempre no fim do dia, e validar contra o estado atual
      basta. A correção entra no MEIO — e sem conferir a sequência resultante, o
      espelho mostraria a pessoa "trabalhando" depois de ter saído.
    */
    const pedido = await requestTimeAdjustment(ctx.companyId, ctx.userId, {
      requestedType: "MISSING_ENTRY",
      requestedEntryType: "CLOCK_OUT",
      requestedOccurredAt: ctx.as(11),
      reason: "Horário impossível.",
    });

    await expectDomainError(
      () =>
        decideTimeAdjustment(
          ctx.companyId,
          fixture.adminA.id,
          pedido.id,
          "APPROVED",
        ),
      400,
    );

    // A recusa aborta a transação inteira: o pedido continua PENDENTE e nenhuma
    // marcação derivada foi criada.
    expect(
      (
        await prisma.timeAdjustmentRequest.findUniqueOrThrow({
          where: { id: pedido.id },
        })
      ).status,
    ).toBe("PENDING");
    expect(
      await prisma.timeEntry.count({
        where: { userId: ctx.userId, source: "ADJUSTMENT" },
      }),
    ).toBe(0);
  });

  it("rejeição não apaga o pedido nem cria marcação", async () => {
    const ctx = A();
    await punchTimeClock(ctx.companyId, ctx.userId, { type: "CLOCK_IN" });

    const pedido = await requestTimeAdjustment(ctx.companyId, ctx.userId, {
      requestedType: "WRONG_TIME",
      requestedEntryType: "CLOCK_IN",
      requestedOccurredAt: new Date(Date.now() - 3_600_000),
      reason: "Cheguei mais cedo.",
    });

    const decidido = await decideTimeAdjustment(
      ctx.companyId,
      fixture.adminA.id,
      pedido.id,
      "REJECTED",
      "Sem registro de acesso ao prédio.",
    );

    expect(decidido.status).toBe("REJECTED");
    expect(decidido.decisionReason).toBe("Sem registro de acesso ao prédio.");
    // Continua existindo: quem pediu precisa ver a recusa e o motivo.
    expect(
      await prisma.timeAdjustmentRequest.count({ where: { id: pedido.id } }),
    ).toBe(1);
    expect(
      await prisma.timeEntry.count({
        where: { userId: ctx.userId, source: "ADJUSTMENT" },
      }),
    ).toBe(0);
  });

  it("decidir duas vezes é conflito, e não cria duas derivadas", async () => {
    const ctx = await jornadaSemeada([["CLOCK_IN", 11]]);
    const pedido = await requestTimeAdjustment(ctx.companyId, ctx.userId, {
      requestedType: "MISSING_ENTRY",
      requestedEntryType: "CLOCK_OUT",
      requestedOccurredAt: ctx.as(20),
      reason: "Esqueci.",
    });

    await decideTimeAdjustment(
      ctx.companyId,
      fixture.adminA.id,
      pedido.id,
      "APPROVED",
    );
    await expectDomainError(
      () =>
        decideTimeAdjustment(
          ctx.companyId,
          fixture.adminA.id,
          pedido.id,
          "APPROVED",
        ),
      409,
    );

    expect(
      await prisma.timeEntry.count({
        where: { userId: ctx.userId, source: "ADJUSTMENT" },
      }),
    ).toBe(1);
  });

  it("a decisão gera AuditLog — a batida não", async () => {
    // Entrada e intervalo semeados no passado; falta o retorno.
    const ctx = await jornadaSemeada([
      ["CLOCK_IN", 11],
      ["BREAK_START", 15],
    ]);

    /*
      `TimeEntry` já É o histórico operacional imutável. Auditar cada batida
      duplicaria a mesma linha em duas tabelas e afogaria o AuditLog, que existe
      para ação ADMINISTRATIVA.
    */
    expect(
      await prisma.auditLog.count({
        where: { companyId: ctx.companyId, entity: "TimeEntry" },
      }),
    ).toBe(0);

    // Esqueceu de bater o retorno do intervalo.
    const pedido = await requestTimeAdjustment(ctx.companyId, ctx.userId, {
      requestedType: "MISSING_ENTRY",
      requestedEntryType: "BREAK_END",
      requestedOccurredAt: ctx.as(16),
      reason: "Esqueci.",
    });
    await decideTimeAdjustment(
      ctx.companyId,
      fixture.adminA.id,
      pedido.id,
      "APPROVED",
    );

    // Decisão sobre a jornada de outra pessoa é exercício de autoridade.
    expect(
      await prisma.auditLog.count({
        where: {
          companyId: ctx.companyId,
          entity: "TimeAdjustmentRequest",
          action: "TIME_ADJUSTMENT.APPROVED",
        },
      }),
    ).toBe(1);
  });

  it("pedido com horário no futuro é recusado", async () => {
    const ctx = A();
    await expectDomainError(
      () =>
        requestTimeAdjustment(ctx.companyId, ctx.userId, {
          requestedType: "MISSING_ENTRY",
          requestedEntryType: "CLOCK_IN",
          requestedOccurredAt: new Date(Date.now() + 3_600_000),
          reason: "Vou chegar.",
        }),
      400,
    );
  });

  it("pedido sem motivo é recusado", async () => {
    const ctx = A();
    await expectDomainError(
      () =>
        requestTimeAdjustment(ctx.companyId, ctx.userId, {
          requestedType: "OTHER",
          requestedEntryType: "CLOCK_IN",
          requestedOccurredAt: new Date(Date.now() - 60_000),
          reason: "   ",
        }),
      400,
    );
  });

  it("marcação-alvo de OUTRO funcionário não é aceita", async () => {
    const ctx = A();
    // Marcação do colega, na mesma empresa.
    await punchTimeClock(ctx.companyId, fixture.techB.id, { type: "CLOCK_IN" });
    const alheia = await prisma.timeEntry.findFirstOrThrow({
      where: { userId: fixture.techB.id },
    });

    await punchTimeClock(ctx.companyId, ctx.userId, { type: "CLOCK_IN" });

    /*
      Sem esta conferência, `targetEntryId` viraria ponteiro para qualquer linha
      da tabela: bastaria mandar o id da marcação de um colega para abrir um
      pedido sobre a jornada dele.
    */
    await expectDomainError(
      () =>
        requestTimeAdjustment(ctx.companyId, ctx.userId, {
          requestedType: "WRONG_TIME",
          requestedEntryType: "CLOCK_IN",
          requestedOccurredAt: new Date(Date.now() - 60_000),
          reason: "Tentando alcançar a jornada do colega.",
          targetEntryId: alheia.id,
        }),
      404,
    );
  });
});

// ---------------------------------------------------------------------------
// Tenancy
// ---------------------------------------------------------------------------

describe("Isolamento entre empresas", () => {
  it("pedido de outra empresa não é decidido nem listado", async () => {
    const ctx = A();
    await punchTimeClock(ctx.companyId, ctx.userId, { type: "CLOCK_IN" });
    const pedido = await requestTimeAdjustment(ctx.companyId, ctx.userId, {
      requestedType: "MISSING_ENTRY",
      requestedEntryType: "CLOCK_OUT",
      requestedOccurredAt: new Date(Date.now() - 60_000),
      reason: "Esqueci.",
    });

    // 404, não 403: confirmar que o id existe noutra empresa é justamente o que
    // uma sonda não pode aprender.
    await expectDomainError(
      () =>
        decideTimeAdjustment(
          fixture.companyB.id,
          fixture.adminB.id,
          pedido.id,
          "APPROVED",
        ),
      404,
    );

    expect(await listCompanyAdjustments(fixture.companyB.id)).toEqual([]);
    expect(
      (await prisma.timeAdjustmentRequest.findUniqueOrThrow({
        where: { id: pedido.id },
      })).status,
    ).toBe("PENDING");
  });

  it("o espelho de um funcionário de outra empresa é 404", async () => {
    await expectDomainError(
      () => getMemberWorkdayView(fixture.companyB.id, fixture.techA.id),
      404,
    );
  });

  it("a visão de equipe só enxerga a própria empresa", async () => {
    const ctx = A();
    await punchTimeClock(ctx.companyId, ctx.userId, { type: "CLOCK_IN" });

    const equipeA = await getTeamWorkday(fixture.companyA.id);
    expect(equipeA.members.some((m) => m.userId === ctx.userId)).toBe(true);

    const equipeB = await getTeamWorkday(fixture.companyB.id);
    expect(equipeB.members.some((m) => m.userId === ctx.userId)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Painel do gestor
// ---------------------------------------------------------------------------

describe("Painel do gestor", () => {
  it("mostra NÃO INICIOU para quem não bateu", async () => {
    const equipe = await getTeamWorkday(fixture.companyA.id);
    /*
      A lista parte dos USUÁRIOS, não das jornadas.

      Uma consulta que partisse de `Workday` mostraria só quem bateu — e "não
      iniciou" é justamente o estado que o gestor precisa ver.
    */
    expect(equipe.members.length).toBeGreaterThan(0);
    expect(equipe.members.every((m) => m.state === "NOT_STARTED")).toBe(true);
  });

  it("separa trabalhando, em intervalo e encerrado", async () => {
    await punchTimeClock(fixture.companyA.id, fixture.techA.id, {
      type: "CLOCK_IN",
    });
    await punchTimeClock(fixture.companyA.id, fixture.techB.id, {
      type: "CLOCK_IN",
    });
    await punchTimeClock(fixture.companyA.id, fixture.techB.id, {
      type: "BREAK_START",
    });

    const equipe = await getTeamWorkday(fixture.companyA.id);
    const byUser = new Map(equipe.members.map((m) => [m.userId, m]));

    expect(byUser.get(fixture.techA.id)?.state).toBe("WORKING");
    expect(byUser.get(fixture.techB.id)?.state).toBe("ON_BREAK");
    expect(byUser.get(fixture.adminA.id)?.state).toBe("NOT_STARTED");
    expect(byUser.get(fixture.techB.id)?.lastEntryType).toBe("BREAK_START");
  });

  it("conta ajustes pendentes por pessoa", async () => {
    const ctx = A();
    await punchTimeClock(ctx.companyId, ctx.userId, { type: "CLOCK_IN" });
    await requestTimeAdjustment(ctx.companyId, ctx.userId, {
      requestedType: "MISSING_ENTRY",
      requestedEntryType: "CLOCK_OUT",
      requestedOccurredAt: new Date(Date.now() - 60_000),
      reason: "Esqueci.",
    });

    const equipe = await getTeamWorkday(fixture.companyA.id);
    const tech = equipe.members.find((m) => m.userId === ctx.userId);
    expect(tech?.pendingAdjustments).toBe(1);
  });
});

/*
  O DESLOCAMENTO DO DIA VAI NO DTO (§253, LOW-3).

  O nome IANA sozinho não serve ao Flutter: resolver `America/Sao_Paulo` exige
  a base de fusos, que o Dart não traz. Sem um deslocamento pronto, o aplicativo
  só tinha o relógio do aparelho para montar "08:30 daquele dia" — e um celular
  configurado noutro fuso mandava outro instante.

  Quem calcula é o servidor, com `Intl`, que já conhece horário de verão e não
  envelhece dentro de um APK. O aplicativo só honra o que recebe; a prova de
  que ele honra está em `apps/field/test/company_time_test.dart`.
*/
describe("a visão do dia carrega o deslocamento do fuso da empresa", () => {
  async function comFuso(timezone: string) {
    await prisma.company.update({
      where: { id: fixture.companyA.id },
      data: { timezone },
    });
  }

  it("São Paulo devolve -03:00, e o nome IANA continua junto", async () => {
    await comFuso("America/Sao_Paulo");
    const v = await getWorkdayView(
      fixture.companyA.id,
      fixture.techA.id,
      new Date("2026-08-29T15:00:00.000Z"),
    );

    expect(v.timezone).toBe("America/Sao_Paulo");
    expect(v.utcOffset).toBe("-03:00");
  });

  it("HORÁRIO DE VERÃO: o mesmo fuso muda de deslocamento ao longo do ano", async () => {
    /*
      O teste que impede a tabela de offsets.

      `America/New_York` é `-05:00` em janeiro e `-04:00` em julho. Um valor
      fixo por fuso passaria em metade do ano e erraria a outra metade — de
      hora em hora, na jornada de gente real.

      A função recebe o INSTANTE justamente por isto.
    */
    await comFuso("America/New_York");

    const inverno = await getWorkdayView(
      fixture.companyA.id,
      fixture.techA.id,
      new Date("2026-01-15T17:00:00.000Z"),
    );
    const verao = await getWorkdayView(
      fixture.companyA.id,
      fixture.techA.id,
      new Date("2026-07-15T17:00:00.000Z"),
    );

    expect(inverno.utcOffset).toBe("-05:00");
    expect(verao.utcOffset).toBe("-04:00");
  });

  it("fuso sem deslocamento inteiro é devolvido com os minutos", async () => {
    // `Asia/Kolkata` é +05:30. Um contrato que só transportasse horas erraria
    // a Índia inteira — e a máscara `+HH:MM` existe para isso.
    await comFuso("Asia/Kolkata");
    const v = await getWorkdayView(
      fixture.companyA.id,
      fixture.techA.id,
      new Date("2026-08-29T06:00:00.000Z"),
    );
    expect(v.utcOffset).toBe("+05:30");
  });

  it("UTC devolve +00:00, e não a string vazia", async () => {
    // `Intl` crava "GMT" quando o deslocamento é zero, sem o "+00:00" que um
    // ISO precisa. Vazio no DTO faria o aplicativo cair no relógio do aparelho
    // justamente onde o fuso é conhecido.
    await comFuso("Etc/UTC");
    const v = await getWorkdayView(
      fixture.companyA.id,
      fixture.techA.id,
      new Date("2026-08-29T12:00:00.000Z"),
    );
    expect(v.utcOffset).toBe("+00:00");
  });

  it("o dia com jornada aberta também carrega o deslocamento", async () => {
    // O caminho com `Workday` é OUTRO retorno da mesma função: um deles ganhar
    // o campo e o outro não deixaria o app sem fuso justamente depois da
    // primeira batida.
    await comFuso("America/Sao_Paulo");
    await punchTimeClock(fixture.companyA.id, fixture.techA.id, {
      type: "CLOCK_IN",
    });

    const v = await getWorkdayView(fixture.companyA.id, fixture.techA.id);
    expect(v.workdayId).not.toBeNull();
    expect(v.utcOffset).toBe("-03:00");
  });

  it("a visão do gestor sobre um funcionário carrega o mesmo deslocamento", async () => {
    await comFuso("America/Sao_Paulo");
    const v = await getMemberWorkdayView(
      fixture.companyA.id,
      fixture.techA.id,
      new Date("2026-08-29T15:00:00.000Z"),
    );
    expect(v.utcOffset).toBe("-03:00");
  });
});
