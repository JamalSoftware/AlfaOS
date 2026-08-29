import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { DomainError } from "@/lib/errors";
import {
  decideTimeAdjustment,
  getWorkdayView,
  punchTimeClock,
  requestTimeAdjustment,
} from "@/lib/time-clock";
import {
  civilDateIn,
  deriveWorkdayState,
  isValidSequence,
} from "@/lib/workday";
import { seedTestData, type TestFixture } from "./helpers";

/**
 * # A marcação efetiva é UMA só
 *
 * Este arquivo existe por causa de uma auditoria independente que encontrou
 * **duas noções diferentes de "marcação atual"** convivendo no módulo:
 *
 * - o espelho (`getWorkdayView`) já descartava as marcações superadas por uma
 *   correção aprovada;
 * - a batida (`punchTimeClock`) e a validação da aprovação
 *   (`decideTimeAdjustment`) ainda liam o histórico BRUTO.
 *
 * Três defeitos saíram da mesma raiz:
 *
 * - **JOR-01** — a batida era governada por um estado obsoleto: o servidor
 *   mostrava a jornada encerrada e aceitava um retorno de intervalo.
 * - **JOR-02** — a segunda correção legítima do dia era recusada, porque a
 *   versão antiga já superada continuava contando na sequência.
 * - **JOR-03** — dois pedidos sobre o MESMO fato podiam ser aprovados em
 *   paralelo, cada um cego para o outro.
 *
 * A correção é uma autoridade única: `resolveEffectiveTimeEntries`. Quem decide
 * estado, ação permitida, sequência válida e espelho passa por ela — e por
 * nenhuma outra definição.
 *
 * Nada de dado real: funcionários e empresas são fictícios.
 */

let fixture: TestFixture;

beforeEach(async () => {
  fixture = await seedTestData();
});

async function esperaErro(fn: () => Promise<unknown>, status: number) {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).status).toBe(status);
    return error as DomainError;
  }
  throw new Error(`esperava DomainError ${status}, mas nada foi lançado`);
}

type Tipo = "CLOCK_IN" | "BREAK_START" | "BREAK_END" | "CLOCK_OUT";

/**
 * Quantos milissegundos do dia civil da empresa já passaram.
 *
 * Sem isto, um teste de batida é refém do relógio: "duas horas atrás" rodando
 * às 00h30 em São Paulo cai na VÉSPERA, e o domínio — corretamente — abre outra
 * jornada. O teste falharia por hora da suíte, não por defeito.
 */
function decorridoHoje(agora: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(agora);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const hora = get("hour") % 24;
  return (
    ((hora * 60 + get("minute")) * 60 + get("second")) * 1000 +
    agora.getMilliseconds()
  );
}

/**
 * Semeia uma jornada e devolve `t(1..9)`, marcos ordenados dentro do dia.
 *
 * `hoje = true` ancora nas frações do que já passou HOJE — sempre no dia civil
 * de hoje, sempre no passado, em qualquer hora em que a suíte rode. É o que
 * torna possível testar a BATIDA, que acontece sempre agora.
 *
 * `hoje = false` usa horas UTC fixas de ontem (11h–21h caem no mesmo dia civil
 * em qualquer fuso brasileiro), que é o suficiente para testar CORREÇÃO.
 */
async function jornada(
  sequencia: readonly (readonly [Tipo, number])[],
  { hoje = false }: { hoje?: boolean } = {},
) {
  const companyId = fixture.companyA.id;
  const userId = fixture.techA.id;
  const company = await prisma.company.findUniqueOrThrow({
    where: { id: companyId },
    select: { timezone: true },
  });

  let t: (k: number) => Date;
  let dia: string;

  if (hoje) {
    const agora = new Date();
    dia = civilDateIn(agora, company.timezone);
    const decorrido = decorridoHoje(agora, company.timezone);
    const meiaNoite = agora.getTime() - decorrido;
    // Passo mínimo de 1ms mantém os marcos distintos mesmo à meia-noite.
    const passo = Math.max(1, Math.floor(decorrido / 10));
    t = (k: number) => new Date(meiaNoite + passo * k);
  } else {
    const ontem = new Date(Date.now() - 24 * 3_600_000);
    dia = civilDateIn(ontem, company.timezone);
    t = (k: number) =>
      new Date(`${dia}T${String(10 + k).padStart(2, "0")}:00:00.000Z`);
  }

  const workday = await prisma.workday.create({
    data: {
      companyId,
      userId,
      date: new Date(`${dia}T00:00:00.000Z`),
      timezone: company.timezone,
    },
  });

  const entries = [];
  for (const [type, k] of sequencia) {
    entries.push(
      await prisma.timeEntry.create({
        data: {
          companyId,
          userId,
          workdayId: workday.id,
          type,
          source: "FIELD_APP",
          occurredAt: t(k),
        },
      }),
    );
  }

  return { companyId, userId, workday, entries, t, dia };
}

/** Abre e aprova uma correção num passo — o caminho feliz, já coberto à parte. */
async function corrigir(
  ctx: { companyId: string; userId: string },
  input: {
    requestedEntryType: Tipo;
    requestedOccurredAt: Date;
    targetEntryId?: string | null;
    requestedType?: "MISSING_ENTRY" | "WRONG_TIME" | "BREAK" | "OTHER";
  },
) {
  const pedido = await requestTimeAdjustment(ctx.companyId, ctx.userId, {
    requestedType: input.requestedType ?? "WRONG_TIME",
    requestedEntryType: input.requestedEntryType,
    requestedOccurredAt: input.requestedOccurredAt,
    reason: "Correção do dia.",
    targetEntryId: input.targetEntryId ?? null,
  });
  await decideTimeAdjustment(
    ctx.companyId,
    fixture.adminA.id,
    pedido.id,
    "APPROVED",
  );
  return pedido;
}

// ---------------------------------------------------------------------------
// JOR-01 — a batida não pode ser governada por marcação superada
// ---------------------------------------------------------------------------

describe("JOR-01 — a batida usa a visão efetiva", () => {
  /**
   * Monta o ataque exato da auditoria.
   *
   * Entrada e início de intervalo batidos. A correção transforma o início de
   * intervalo das 18h numa SAÍDA às 17h: a marcação das 18h é superada, e a
   * jornada efetiva passa a ser entrada → saída, encerrada.
   *
   * No histórico bruto, porém, a última linha por horário continua sendo o
   * início de intervalo das 18h — e era ele que governava a batida.
   */
  async function ataque() {
    const ctx = await jornada(
      [
        ["CLOCK_IN", 2],
        ["BREAK_START", 8],
      ],
      { hoje: true },
    );

    await corrigir(ctx, {
      requestedEntryType: "CLOCK_OUT",
      requestedOccurredAt: ctx.t(5),
      targetEntryId: ctx.entries[1].id,
    });

    return ctx;
  }

  it("jornada encerrada não reabre por uma marcação já superada", async () => {
    const ctx = await ataque();

    // O servidor DIZ que a jornada está encerrada e que nada é permitido.
    const view = await getWorkdayView(ctx.companyId, ctx.userId);
    expect(view.state).toBe("FINISHED");
    expect(view.allowedActions).toEqual([]);

    /*
      E precisa RECUSAR de acordo.

      Antes da correção, o histórico bruto terminava num início de intervalo
      superado, o estado derivado era ON_BREAK e esta batida era aceita: o
      espelho mostrava a jornada fechada enquanto o funcionário continuava
      registrando ponto nela.
    */
    await esperaErro(
      () =>
        punchTimeClock(ctx.companyId, ctx.userId, { type: "BREAK_END" }),
      400,
    );

    // Nenhuma marcação nova entrou no dia.
    expect(
      await prisma.timeEntry.count({ where: { workdayId: ctx.workday.id } }),
    ).toBe(3);
  });

  it("nenhuma das quatro batidas é aceita depois de encerrada", async () => {
    const ctx = await ataque();

    /*
      A varredura completa é deliberada.

      `allowedActions` vazio é uma promessa sobre as QUATRO transições, e um fix
      que só recusasse o retorno de intervalo deixaria as outras três abertas.
    */
    for (const type of [
      "CLOCK_IN",
      "BREAK_START",
      "BREAK_END",
      "CLOCK_OUT",
    ] as const) {
      await esperaErro(
        () => punchTimeClock(ctx.companyId, ctx.userId, { type }),
        400,
      );
    }
  });

  it("o espelho e a batida concordam — a permitida passa, as outras não", async () => {
    /*
      O percurso do §20: sequência efetiva → espelho → ação permitida → batida.

      Duas máquinas de estado que concordam por coincidência não são uma
      máquina só. Este teste faz a volta completa: o que o espelho oferece é
      exatamente o que a escrita aceita, e nada além.
    */
    const ctx = await jornada(
      [
        ["CLOCK_IN", 2],
        ["CLOCK_OUT", 8],
      ],
      { hoje: true },
    );

    // A saída das 20h vira um início de intervalo: o dia REABRE em intervalo.
    await corrigir(ctx, {
      requestedEntryType: "BREAK_START",
      requestedOccurredAt: ctx.t(6),
      targetEntryId: ctx.entries[1].id,
    });

    const view = await getWorkdayView(ctx.companyId, ctx.userId);
    expect(view.state).toBe("ON_BREAK");
    expect(view.allowedActions).toEqual(["BREAK_END"]);

    // O que o espelho NÃO oferece é recusado.
    for (const type of ["CLOCK_IN", "BREAK_START", "CLOCK_OUT"] as const) {
      await esperaErro(
        () => punchTimeClock(ctx.companyId, ctx.userId, { type }),
        400,
      );
    }

    // E o que ele oferece funciona — controle positivo.
    const { workday } = await punchTimeClock(ctx.companyId, ctx.userId, {
      type: "BREAK_END",
    });
    expect(workday.state).toBe("WORKING");
  });

  it("PROVA CONTRÁRIA: correção válida não tranca a jornada", async () => {
    /*
      O jeito errado de fechar JOR-01 é recusar toda batida depois de um ajuste.
      Este teste existe para impedir isso: a correção só mexeu no HORÁRIO da
      entrada, o dia continua aberto, e a pessoa continua batendo normalmente.
    */
    const ctx = await jornada([["CLOCK_IN", 4]], { hoje: true });

    await corrigir(ctx, {
      requestedEntryType: "CLOCK_IN",
      requestedOccurredAt: ctx.t(2),
      targetEntryId: ctx.entries[0].id,
    });

    const view = await getWorkdayView(ctx.companyId, ctx.userId);
    expect(view.state).toBe("WORKING");
    expect([...view.allowedActions].sort()).toEqual([
      "BREAK_START",
      "CLOCK_OUT",
    ]);

    const { entry } = await punchTimeClock(ctx.companyId, ctx.userId, {
      type: "BREAK_START",
    });
    expect(entry.type).toBe("BREAK_START");
  });
});

// ---------------------------------------------------------------------------
// JOR-02 — correções sequenciais
// ---------------------------------------------------------------------------

describe("JOR-02 — corrigir duas vezes no mesmo dia", () => {
  it("corrigir a entrada e depois a saída", async () => {
    const ctx = await jornada([
      ["CLOCK_IN", 1],
      ["CLOCK_OUT", 9],
    ]);

    await corrigir(ctx, {
      requestedEntryType: "CLOCK_IN",
      requestedOccurredAt: ctx.t(2),
      targetEntryId: ctx.entries[0].id,
    });

    /*
      A segunda correção era recusada.

      A validação somava o histórico BRUTO: a entrada antiga, já superada,
      continuava contando, e a sequência resultante aparecia com duas entradas.
      O funcionário que errasse duas marcações no mesmo dia só conseguia
      corrigir a primeira.
    */
    await corrigir(ctx, {
      requestedEntryType: "CLOCK_OUT",
      requestedOccurredAt: ctx.t(8),
      targetEntryId: ctx.entries[1].id,
    });

    const view = await getWorkdayView(ctx.companyId, ctx.userId, ctx.t(5));
    expect(view.entries).toHaveLength(2);
    expect(view.entries.every((e) => e.fromAdjustment)).toBe(true);
    expect(view.entries[0].occurredAt.toISOString()).toBe(
      ctx.t(2).toISOString(),
    );
    expect(view.entries[1].occurredAt.toISOString()).toBe(
      ctx.t(8).toISOString(),
    );
    expect(view.state).toBe("FINISHED");

    // As quatro linhas continuam no banco: nada foi editado nem apagado.
    expect(
      await prisma.timeEntry.count({ where: { workdayId: ctx.workday.id } }),
    ).toBe(4);
  });

  it("corrigir a mesma marcação DUAS vezes segue a versão vigente", async () => {
    /*
      §17: o sistema não pode ficar preso depois da primeira correção.

      A segunda correção aponta para a marcação EFETIVA — a derivada da
      primeira — e a cadeia resolve para a última versão, sem graph engine:
      superar é remover do conjunto, não caminhar por arestas.
    */
    const ctx = await jornada([
      ["CLOCK_IN", 1],
      ["CLOCK_OUT", 9],
    ]);

    const pedido1 = await corrigir(ctx, {
      requestedEntryType: "CLOCK_IN",
      requestedOccurredAt: ctx.t(2),
      targetEntryId: ctx.entries[0].id,
    });
    const derivada1 = await prisma.timeEntry.findFirstOrThrow({
      where: { adjustmentRequestId: pedido1.id },
    });

    await corrigir(ctx, {
      requestedEntryType: "CLOCK_IN",
      requestedOccurredAt: ctx.t(3),
      targetEntryId: derivada1.id,
    });

    const view = await getWorkdayView(ctx.companyId, ctx.userId, ctx.t(5));
    const entradas = view.entries.filter((e) => e.type === "CLOCK_IN");
    expect(entradas).toHaveLength(1);
    expect(entradas[0].occurredAt.toISOString()).toBe(ctx.t(3).toISOString());

    // As três versões da entrada continuam no histórico.
    expect(
      await prisma.timeEntry.count({
        where: { workdayId: ctx.workday.id, type: "CLOCK_IN" },
      }),
    ).toBe(3);
  });

  it("corrigir uma marcação JÁ superada é recusado", async () => {
    /*
      O contrário de ficar preso é aceitar duas correções do mesmo fato.

      Depois de superada, a marcação antiga não volta a participar de nada — e
      um pedido sobre ela produziria uma segunda versão efetiva do mesmo fato.
      A recusa aponta para a marcação vigente.
    */
    const ctx = await jornada([["CLOCK_IN", 1]]);
    const original = ctx.entries[0];

    await corrigir(ctx, {
      requestedEntryType: "CLOCK_IN",
      requestedOccurredAt: ctx.t(2),
      targetEntryId: original.id,
    });

    await esperaErro(
      () =>
        requestTimeAdjustment(ctx.companyId, ctx.userId, {
          requestedType: "WRONG_TIME",
          requestedEntryType: "CLOCK_IN",
          requestedOccurredAt: ctx.t(3),
          reason: "Tentando corrigir a versão antiga.",
          targetEntryId: original.id,
        }),
      409,
    );
  });
});

// ---------------------------------------------------------------------------
// §18 — a sequência RESULTANTE
// ---------------------------------------------------------------------------

describe("Sequência resultante da aprovação", () => {
  const casos: {
    nome: string;
    dia: readonly (readonly [Tipo, number])[];
    pede: Tipo;
    em: number;
  }[] = [
    {
      nome: "saída antes da entrada",
      dia: [["CLOCK_IN", 5]],
      pede: "CLOCK_OUT",
      em: 2,
    },
    {
      nome: "retorno antes do início do intervalo",
      dia: [
        ["CLOCK_IN", 2],
        ["BREAK_START", 6],
      ],
      pede: "BREAK_END",
      em: 4,
    },
    {
      nome: "duas entradas efetivas",
      dia: [
        ["CLOCK_IN", 2],
        ["CLOCK_OUT", 8],
      ],
      pede: "CLOCK_IN",
      em: 4,
    },
    {
      nome: "duas saídas efetivas",
      dia: [
        ["CLOCK_IN", 2],
        ["CLOCK_OUT", 8],
      ],
      pede: "CLOCK_OUT",
      em: 6,
    },
    {
      nome: "dois inícios de intervalo efetivos",
      dia: [
        ["CLOCK_IN", 2],
        ["BREAK_START", 4],
        ["BREAK_END", 6],
      ],
      pede: "BREAK_START",
      em: 5,
    },
    {
      nome: "retorno sem início de intervalo",
      dia: [["CLOCK_IN", 2]],
      pede: "BREAK_END",
      em: 4,
    },
  ];

  for (const caso of casos) {
    it(`recusa: ${caso.nome}`, async () => {
      const ctx = await jornada(caso.dia);

      const pedido = await requestTimeAdjustment(ctx.companyId, ctx.userId, {
        requestedType: "MISSING_ENTRY",
        requestedEntryType: caso.pede,
        requestedOccurredAt: ctx.t(caso.em),
        reason: "Sequência impossível.",
      });

      await esperaErro(
        () =>
          decideTimeAdjustment(
            ctx.companyId,
            fixture.adminA.id,
            pedido.id,
            "APPROVED",
          ),
        400,
      );

      // A recusa aborta tudo: o pedido segue pendente e nada foi gravado.
      expect(
        (
          await prisma.timeAdjustmentRequest.findUniqueOrThrow({
            where: { id: pedido.id },
          })
        ).status,
      ).toBe("PENDING");
      expect(
        await prisma.timeEntry.count({
          where: { workdayId: ctx.workday.id, source: "ADJUSTMENT" },
        }),
      ).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// JOR-03 — aprovações concorrentes
// ---------------------------------------------------------------------------

describe("JOR-03 — decisões concorrentes no mesmo dia", () => {
  it("dois pedidos sobre a MESMA marcação: sobra uma versão efetiva", async () => {
    const ctx = await jornada([
      ["CLOCK_IN", 1],
      ["CLOCK_OUT", 9],
    ]);
    const original = ctx.entries[0];

    const a = await requestTimeAdjustment(ctx.companyId, ctx.userId, {
      requestedType: "WRONG_TIME",
      requestedEntryType: "CLOCK_IN",
      requestedOccurredAt: ctx.t(2),
      reason: "Cheguei às 12h.",
      targetEntryId: original.id,
    });
    const b = await requestTimeAdjustment(ctx.companyId, ctx.userId, {
      requestedType: "WRONG_TIME",
      requestedEntryType: "CLOCK_IN",
      requestedOccurredAt: ctx.t(3),
      reason: "Não, cheguei às 13h.",
      targetEntryId: original.id,
    });

    /*
      Corrida REAL, não sequência rápida.

      `updateMany(status = PENDING)` arbitra duas decisões sobre o MESMO pedido.
      Aqui os pedidos são DIFERENTES: cada um reivindica a sua própria linha sem
      atrapalhar o outro, e sem o lock do dia os dois liam o mesmo estado e
      criavam duas correções do mesmo fato.
    */
    const resultados = await Promise.allSettled([
      decideTimeAdjustment(ctx.companyId, fixture.adminA.id, a.id, "APPROVED"),
      decideTimeAdjustment(ctx.companyId, fixture.adminA.id, b.id, "APPROVED"),
    ]);

    const aprovadas = resultados.filter((r) => r.status === "fulfilled");
    expect(aprovadas).toHaveLength(1);

    // A recusa é CONTROLADA — nada de 500 nem de erro de banco vazando.
    const recusa = resultados.find((r) => r.status === "rejected");
    expect(recusa).toBeDefined();
    const erro = (recusa as PromiseRejectedResult).reason;
    expect(erro).toBeInstanceOf(DomainError);
    expect([400, 409]).toContain((erro as DomainError).status);

    // Exatamente UMA versão efetiva da entrada.
    const view = await getWorkdayView(ctx.companyId, ctx.userId, ctx.t(5));
    const entradas = view.entries.filter((e) => e.type === "CLOCK_IN");
    expect(entradas).toHaveLength(1);
    expect(view.state).toBe("FINISHED");

    // E uma derivada só no banco.
    expect(
      await prisma.timeEntry.count({
        where: { workdayId: ctx.workday.id, source: "ADJUSTMENT" },
      }),
    ).toBe(1);
  });

  it("o segundo pedido sobre a marcação já superada é recusado — mesmo sendo legal", async () => {
    /*
      A variante que a gramática do dia NÃO pega, e que por isso exige regra
      própria.

      Os dois pedidos nascem enquanto a entrada original ainda vale, então
      nenhum é barrado ao ser aberto. Aprovada a primeira correção, a segunda
      diz "aquela marcação era, na verdade, um início de intervalo" — e a
      sequência resultante (entrada corrigida + início de intervalo) é
      perfeitamente legal. Sem a conferência de alvo vigente, as duas passam e o
      MESMO fato ganha duas versões efetivas.

      Este cenário é sequencial de propósito: em paralelo a segunda morreria
      pela sequência, e o teste passaria sem provar a regra que alega.
    */
    const ctx = await jornada([["CLOCK_IN", 1]]);
    const original = ctx.entries[0];

    const a = await requestTimeAdjustment(ctx.companyId, ctx.userId, {
      requestedType: "WRONG_TIME",
      requestedEntryType: "CLOCK_IN",
      requestedOccurredAt: ctx.t(2),
      reason: "Entrada errada.",
      targetEntryId: original.id,
    });
    const b = await requestTimeAdjustment(ctx.companyId, ctx.userId, {
      requestedType: "WRONG_TIME",
      requestedEntryType: "BREAK_START",
      requestedOccurredAt: ctx.t(6),
      reason: "Na verdade era intervalo.",
      targetEntryId: original.id,
    });

    await decideTimeAdjustment(
      ctx.companyId,
      fixture.adminA.id,
      a.id,
      "APPROVED",
    );

    await esperaErro(
      () =>
        decideTimeAdjustment(
          ctx.companyId,
          fixture.adminA.id,
          b.id,
          "APPROVED",
        ),
      409,
    );

    // Uma derivada, e a original superada UMA vez.
    expect(
      await prisma.timeEntry.count({
        where: { workdayId: ctx.workday.id, source: "ADJUSTMENT" },
      }),
    ).toBe(1);
    expect(
      await prisma.timeAdjustmentRequest.count({
        where: { targetEntryId: original.id, status: "APPROVED" },
      }),
    ).toBe(1);

    // O pedido recusado continua PENDENTE — a decisão abortou inteira.
    expect(
      (
        await prisma.timeAdjustmentRequest.findUniqueOrThrow({
          where: { id: b.id },
        })
      ).status,
    ).toBe("PENDING");
  });

  it("dois pedidos de INCLUSÃO da mesma marcação faltante: só um entra", async () => {
    /*
      O ramo de alvo NULO — dois gestores aprovando dois "esqueci de bater a
      entrada" do mesmo dia.

      Aqui não há marcação para superar, então a conferência de alvo vigente não
      diz nada: quem arbitra é a sequência resultante, lida sob o lock. Sem o
      lock, as duas leem um dia sem entrada e o dia termina com duas.
    */
    const ctx = await jornada([["CLOCK_OUT", 9]]);

    const a = await requestTimeAdjustment(ctx.companyId, ctx.userId, {
      requestedType: "MISSING_ENTRY",
      requestedEntryType: "CLOCK_IN",
      requestedOccurredAt: ctx.t(1),
      reason: "Esqueci de bater a entrada.",
    });
    const b = await requestTimeAdjustment(ctx.companyId, ctx.userId, {
      requestedType: "MISSING_ENTRY",
      requestedEntryType: "CLOCK_IN",
      requestedOccurredAt: ctx.t(2),
      reason: "Esqueci mesmo.",
    });

    const resultados = await Promise.allSettled([
      decideTimeAdjustment(ctx.companyId, fixture.adminA.id, a.id, "APPROVED"),
      decideTimeAdjustment(ctx.companyId, fixture.adminA.id, b.id, "APPROVED"),
    ]);

    expect(resultados.filter((r) => r.status === "fulfilled")).toHaveLength(1);

    const view = await getWorkdayView(ctx.companyId, ctx.userId, ctx.t(5));
    expect(view.entries.filter((e) => e.type === "CLOCK_IN")).toHaveLength(1);
    expect(isValidSequence(view.entries.map((e) => e.type))).toBe(true);
  });

  it("correções DIFERENTES no mesmo dia: as duas passam, serializadas", async () => {
    /*
      §11: concorrência não pode virar recusa preguiçosa.

      Entrada e saída são fatos distintos e a combinação final é válida, então o
      desfecho correto é as duas passarem — a segunda relendo o estado que a
      primeira deixou. Serializar é ordenar, não bloquear.
    */
    const ctx = await jornada([
      ["CLOCK_IN", 1],
      ["CLOCK_OUT", 9],
    ]);

    const a = await requestTimeAdjustment(ctx.companyId, ctx.userId, {
      requestedType: "WRONG_TIME",
      requestedEntryType: "CLOCK_IN",
      requestedOccurredAt: ctx.t(2),
      reason: "Entrada.",
      targetEntryId: ctx.entries[0].id,
    });
    const b = await requestTimeAdjustment(ctx.companyId, ctx.userId, {
      requestedType: "WRONG_TIME",
      requestedEntryType: "CLOCK_OUT",
      requestedOccurredAt: ctx.t(8),
      reason: "Saída.",
      targetEntryId: ctx.entries[1].id,
    });

    const resultados = await Promise.allSettled([
      decideTimeAdjustment(ctx.companyId, fixture.adminA.id, a.id, "APPROVED"),
      decideTimeAdjustment(ctx.companyId, fixture.adminA.id, b.id, "APPROVED"),
    ]);

    expect(resultados.filter((r) => r.status === "fulfilled")).toHaveLength(2);

    const view = await getWorkdayView(ctx.companyId, ctx.userId, ctx.t(5));
    expect(view.entries).toHaveLength(2);
    expect(view.entries.every((e) => e.fromAdjustment)).toBe(true);
    expect(view.state).toBe("FINISHED");
  });

  it("o MESMO pedido aprovado em paralelo produz uma decisão e uma derivada", async () => {
    // §12: o comportamento que já existia não pode regredir com o lock novo.
    const ctx = await jornada([["CLOCK_IN", 1]]);

    const pedido = await requestTimeAdjustment(ctx.companyId, ctx.userId, {
      requestedType: "MISSING_ENTRY",
      requestedEntryType: "CLOCK_OUT",
      requestedOccurredAt: ctx.t(9),
      reason: "Esqueci a saída.",
    });

    const resultados = await Promise.allSettled([
      decideTimeAdjustment(
        ctx.companyId,
        fixture.adminA.id,
        pedido.id,
        "APPROVED",
      ),
      decideTimeAdjustment(
        ctx.companyId,
        fixture.adminA.id,
        pedido.id,
        "APPROVED",
      ),
    ]);

    expect(resultados.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const recusa = (
      resultados.find((r) => r.status === "rejected") as PromiseRejectedResult
    ).reason;
    expect(recusa).toBeInstanceOf(DomainError);
    expect((recusa as DomainError).status).toBe(409);

    expect(
      await prisma.timeEntry.count({
        where: { workdayId: ctx.workday.id, source: "ADJUSTMENT" },
      }),
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// JOR-04 — pertinência no domínio do ajuste
// ---------------------------------------------------------------------------

describe("JOR-04 — o pedido também confere a empresa do funcionário", () => {
  it("empresa B com usuário da empresa A é recusado, sem efeito parcial", async () => {
    const antesWorkdays = await prisma.workday.count();
    const antesPedidos = await prisma.timeAdjustmentRequest.count();

    /*
      Defesa em profundidade, igual à da batida.

      Nenhuma rota consegue desalinhar empresa e usuário hoje — as duas saem do
      mesmo principal. Sem a conferência aqui, porém, a função aceita o par e
      abre uma jornada ATRAVESSADA: a primeira tela que chame o domínio com um
      id vindo de outro lugar passa a criar dado cross-tenant.
    */
    await esperaErro(
      () =>
        requestTimeAdjustment(fixture.companyB.id, fixture.techA.id, {
          requestedType: "MISSING_ENTRY",
          requestedEntryType: "CLOCK_IN",
          requestedOccurredAt: new Date(Date.now() - 3_600_000),
          reason: "Atravessando empresa.",
        }),
      404,
    );

    expect(await prisma.workday.count()).toBe(antesWorkdays);
    expect(await prisma.timeAdjustmentRequest.count()).toBe(antesPedidos);
    expect(
      await prisma.workday.count({
        where: { companyId: fixture.companyB.id, userId: fixture.techA.id },
      }),
    ).toBe(0);
  });

  it("CONTROLE POSITIVO: a mesma chamada alinhada funciona", async () => {
    // Sem isto, o teste acima poderia estar passando por outro motivo qualquer.
    const ctx = await jornada([["CLOCK_IN", 1]]);
    const pedido = await requestTimeAdjustment(ctx.companyId, ctx.userId, {
      requestedType: "MISSING_ENTRY",
      requestedEntryType: "CLOCK_OUT",
      requestedOccurredAt: ctx.t(9),
      reason: "Esqueci a saída.",
    });
    expect(pedido.status).toBe("PENDING");
  });
});

// ---------------------------------------------------------------------------
// Supersessão: cadeia, ciclo e espelho
// ---------------------------------------------------------------------------

describe("Supersessão", () => {
  it("o ciclo é impossível por construção", async () => {
    /*
      §16: verificar se o modelo permite ciclo — sem inventar graph engine.

      Não permite, por duas razões independentes:

      1. A aresta só nasce apontando para o PASSADO. O alvo precisa existir
         quando o pedido é criado (chave estrangeira), e a marcação derivada só
         é criada na APROVAÇÃO, depois. Uma marcação nunca supera algo criado
         depois dela.
      2. Resolver é DIFERENÇA DE CONJUNTOS, não caminhada. Mesmo que uma aresta
         circular existisse, a resolução não entraria em laço.

      O teste prova (1): a chave estrangeira recusa um alvo inexistente.
    */
    const ctx = await jornada([["CLOCK_IN", 1]]);

    await expect(
      prisma.timeAdjustmentRequest.create({
        data: {
          companyId: ctx.companyId,
          userId: ctx.userId,
          workdayId: ctx.workday.id,
          targetEntryId: "entrada-que-ainda-nao-existe",
          requestedType: "WRONG_TIME",
          requestedEntryType: "CLOCK_IN",
          requestedOccurredAt: ctx.t(2),
          reason: "Alvo inexistente.",
          requestedById: ctx.userId,
        },
      }),
    ).rejects.toThrow();
  });

  it("um pedido de OUTRA empresa não consegue superar marcação daqui", async () => {
    /*
      A supersessão é uma consulta, e consulta sem escopo de tenant é um jeito
      silencioso de deixar a empresa B mexer no dia da empresa A.

      A linha abaixo é forjada DIRETO no banco — nenhuma rota a produz — com a
      empresa B apontando para a jornada da empresa A. Se o filtro por
      `companyId` não estivesse na consulta, a marcação sumiria do espelho de A
      por decisão de gente de fora.
    */
    const ctx = await jornada([
      ["CLOCK_IN", 1],
      ["CLOCK_OUT", 9],
    ]);

    await prisma.timeAdjustmentRequest.create({
      data: {
        companyId: fixture.companyB.id,
        userId: fixture.techB.id,
        workdayId: ctx.workday.id,
        targetEntryId: ctx.entries[0].id,
        requestedType: "WRONG_TIME",
        requestedEntryType: "CLOCK_IN",
        requestedOccurredAt: ctx.t(2),
        reason: "Forjado de fora.",
        requestedById: fixture.techB.id,
        status: "APPROVED",
      },
    });

    const view = await getWorkdayView(ctx.companyId, ctx.userId, ctx.t(5));
    // A entrada continua valendo, no horário original.
    expect(view.entries).toHaveLength(2);
    expect(view.entries[0].occurredAt.toISOString()).toBe(
      ctx.t(1).toISOString(),
    );
    // E a batida concorda com o espelho.
    expect(view.state).toBe("FINISHED");
  });

  it("o alvo de OUTRO DIA da própria pessoa é recusado", async () => {
    // O alvo é conferido contra a jornada do horário pedido, não contra a
    // tabela inteira: corrigir hoje apontando para a marcação de ontem
    // atravessaria dois dias e deixaria os dois inconsistentes.
    const ontem = await jornada([["CLOCK_IN", 1]]);

    await esperaErro(
      () =>
        requestTimeAdjustment(ontem.companyId, ontem.userId, {
          requestedType: "WRONG_TIME",
          requestedEntryType: "CLOCK_IN",
          requestedOccurredAt: new Date(Date.now() - 60_000),
          reason: "Alvo de outro dia.",
          targetEntryId: ontem.entries[0].id,
        }),
      404,
    );
  });

  it("bater ponto DURANTE uma aprovação deixa o dia coerente", async () => {
    /*
      Operações cruzadas — a corrida que nenhum teste de uma função só pega.

      A batida e a decisão escrevem o MESMO dia por caminhos diferentes. Se as
      duas passassem juntas, o dia terminaria com uma saída e um início de
      intervalo depois dela: uma sequência que a máquina de estados nunca
      aceitaria por nenhum caminho isolado.

      O invariante cobrado aqui não é quem vence — é que a sequência efetiva
      final seja SEMPRE válida, e que nada exploda.
    */
    const ctx = await jornada([["CLOCK_IN", 1]], { hoje: true });

    const pedido = await requestTimeAdjustment(ctx.companyId, ctx.userId, {
      requestedType: "MISSING_ENTRY",
      requestedEntryType: "CLOCK_OUT",
      requestedOccurredAt: ctx.t(9),
      reason: "Esqueci a saída.",
    });

    const resultados = await Promise.allSettled([
      decideTimeAdjustment(
        ctx.companyId,
        fixture.adminA.id,
        pedido.id,
        "APPROVED",
      ),
      punchTimeClock(ctx.companyId, ctx.userId, { type: "BREAK_START" }),
    ]);

    // Nenhum erro cru: o que falha, falha como recusa de domínio.
    for (const r of resultados) {
      if (r.status === "rejected") {
        expect(r.reason).toBeInstanceOf(DomainError);
      }
    }

    const view = await getWorkdayView(ctx.companyId, ctx.userId);
    expect(isValidSequence(view.entries.map((e) => e.type))).toBe(true);
    // E o estado do espelho é o que a própria sequência sustenta.
    expect(view.state).toBe(deriveWorkdayState(view.entries.map((e) => e.type)));
  });

  it("o espelho conta a partir do horário CORRIGIDO", async () => {
    /*
      §19: o espelho e a máquina de estados leem a MESMA sequência.

      Entrada às 11h corrigida para 11h30, saída às 20h. O total é de 11h30 em
      diante — não a soma das duas entradas, e não a original.
    */
    const ctx = await jornada([
      ["CLOCK_IN", 1],
      ["CLOCK_OUT", 10],
    ]);

    await corrigir(ctx, {
      requestedEntryType: "CLOCK_IN",
      requestedOccurredAt: new Date(`${ctx.dia}T11:30:00.000Z`),
      targetEntryId: ctx.entries[0].id,
    });

    const view = await getWorkdayView(ctx.companyId, ctx.userId, ctx.t(5));
    // 11h30 → 20h = 8h30. A original das 11h não entra na conta.
    expect(view.workedMinutes).toBe(8 * 60 + 30);
    expect(view.entries).toHaveLength(2);
  });
});
