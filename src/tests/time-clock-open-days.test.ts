import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  decideTimeAdjustment,
  getTeamWorkday,
  getWorkdayHistory,
  getWorkdayView,
  punchTimeClock,
  requestTimeAdjustment,
} from "@/lib/time-clock";
import { civilDateIn } from "@/lib/workday";
import { seedTestData, type TestFixture } from "./helpers";

/**
 * # Dia em aberto: o que é progresso e o que é buraco
 *
 * `JOR-A1`, achado da auditoria clean-room que liberou a v0.11: um dia
 * histórico deixado `WORKING` — entrada batida, saída esquecida — continuava
 * somando até `Date.now()` **toda vez que era lido**. Um dia de dez semanas
 * atrás devolvia centenas de horas, e o número mudava a cada consulta.
 *
 * A regra que este arquivo trava:
 *
 * > Só conta o intervalo com **as duas pontas provadas**. A única exceção é o
 * > dia operacional CORRENTE, onde o período aberto ainda é progresso e contar
 * > até agora é o que a tela do técnico precisa mostrar.
 *
 * `JOR-A2` sai da mesma raiz. "Jornada em aberto" só é sinal quando o dia já
 * passou: num dia em andamento, ele valeria para todo mundo que está
 * trabalhando agora — e um alerta que aparece sempre é um alerta que ninguém lê.
 *
 * Nada de dado real: funcionários e empresas são fictícios.
 */

let fixture: TestFixture;

beforeEach(async () => {
  fixture = await seedTestData();
});

type Tipo = "CLOCK_IN" | "BREAK_START" | "BREAK_END" | "CLOCK_OUT";

/**
 * Semeia uma jornada `diasAtras` dias no passado, com horas UTC fixas.
 *
 * 11h–21h UTC caem no mesmo dia civil em qualquer fuso brasileiro, então a
 * sequência semeada não muda de dia conforme a hora em que a suíte roda.
 */
async function jornadaPassada(
  diasAtras: number,
  sequencia: readonly (readonly [Tipo, number])[],
  opcoes: { companyId?: string; userId?: string } = {},
) {
  const companyId = opcoes.companyId ?? fixture.companyA.id;
  const userId = opcoes.userId ?? fixture.techA.id;
  const company = await prisma.company.findUniqueOrThrow({
    where: { id: companyId },
    select: { timezone: true },
  });

  const alvo = new Date(Date.now() - diasAtras * 24 * 3_600_000);
  const dia = civilDateIn(alvo, company.timezone);
  const t = (horaUtc: number) =>
    new Date(`${dia}T${String(horaUtc).padStart(2, "0")}:00:00.000Z`);

  const workday = await prisma.workday.create({
    data: {
      companyId,
      userId,
      date: new Date(`${dia}T00:00:00.000Z`),
      timezone: company.timezone,
    },
  });

  const entries = [];
  for (const [type, hora] of sequencia) {
    entries.push(
      await prisma.timeEntry.create({
        data: {
          companyId,
          userId,
          workdayId: workday.id,
          type,
          source: "FIELD_APP",
          occurredAt: t(hora),
        },
      }),
    );
  }

  return { companyId, userId, workday, entries, t, dia };
}

/** Espelho de um dia passado — o instante escolhe QUAL dia é lido. */
function verDia(ctx: { companyId: string; userId: string; t: (h: number) => Date }) {
  return getWorkdayView(ctx.companyId, ctx.userId, ctx.t(15));
}

// ---------------------------------------------------------------------------
// JOR-A1 — o total confirmado
// ---------------------------------------------------------------------------

describe("JOR-A1 — dia histórico em aberto não fabrica tempo", () => {
  it("A. dia CORRENTE em jornada conta o parcial até agora", async () => {
    /*
      O comportamento útil não pode ser quebrado pela correção.

      Enquanto o dia é o de hoje, o período aberto é PROGRESSO: é o que o
      técnico vê no card "trabalhado" e o que o gestor vê no painel de quem
      ainda está em jornada.
    */
    const ctx = { companyId: fixture.companyA.id, userId: fixture.techA.id };
    await punchTimeClock(ctx.companyId, ctx.userId, { type: "CLOCK_IN" });

    const view = await getWorkdayView(ctx.companyId, ctx.userId);
    expect(view.state).toBe("WORKING");
    // Bateu agora: o parcial existe e é pequeno, não é zero por regra nova.
    expect(view.workedMinutes).toBeGreaterThanOrEqual(0);
    expect(view.workedMinutes).toBeLessThan(5);

    // E não é sinalizado: estar trabalhando agora não é inconsistência.
    expect(view.inconsistencies).toEqual([]);
  });

  it("B. dia de 10 dias atrás com só a ENTRADA não acumula até hoje", async () => {
    /*
      O defeito, na sua forma mais crua.

      Antes da correção este dia devolvia ~240 HORAS — dez dias de relógio
      corrido —, e o número crescia a cada leitura.
    */
    const ctx = await jornadaPassada(10, [["CLOCK_IN", 11]]);

    const view = await verDia(ctx);
    expect(view.state).toBe("WORKING");
    expect(view.workedMinutes).toBe(0);
    expect(view.inconsistencies).toContain("Jornada em aberto.");

    // O contraexemplo explícito: dez dias de relógio seriam 14 400 minutos.
    expect(view.workedMinutes).toBeLessThan(24 * 60);
  });

  it("C. dia passado com ENTRADA e INÍCIO DE INTERVALO soma só o fechado", async () => {
    // 11h → 15h tem as duas pontas provadas. Depois disso, nada.
    const ctx = await jornadaPassada(3, [
      ["CLOCK_IN", 11],
      ["BREAK_START", 15],
    ]);

    const view = await verDia(ctx);
    expect(view.state).toBe("ON_BREAK");
    expect(view.workedMinutes).toBe(4 * 60);
    // O intervalo não tem fim: ele não tem duração, e não vira tempo nenhum.
    expect(view.breakMinutes).toBe(0);
    expect(view.inconsistencies).toContain("Intervalo em aberto.");
  });

  it("D. dia passado sem SAÍDA soma só os blocos fechados", async () => {
    /*
      O exemplo do §4 do escopo aprovado.

      11h → 15h é fechado e conta. 16h → ? não tem término comprovado e não
      pode virar tempo confirmado, por mais óbvio que pareça o que aconteceu.
    */
    const ctx = await jornadaPassada(5, [
      ["CLOCK_IN", 11],
      ["BREAK_START", 15],
      ["BREAK_END", 16],
    ]);

    const view = await verDia(ctx);
    expect(view.state).toBe("WORKING");
    expect(view.workedMinutes).toBe(4 * 60);
    expect(view.breakMinutes).toBe(60);
    expect(view.inconsistencies).toContain("Jornada em aberto.");
  });

  it("E. dia passado ENCERRADO corretamente devolve o total normal", async () => {
    // Controle positivo: a correção não pode zerar quem fechou o dia direito.
    const ctx = await jornadaPassada(4, [
      ["CLOCK_IN", 11],
      ["BREAK_START", 15],
      ["BREAK_END", 16],
      ["CLOCK_OUT", 20],
    ]);

    const view = await verDia(ctx);
    expect(view.state).toBe("FINISHED");
    expect(view.workedMinutes).toBe(8 * 60);
    expect(view.breakMinutes).toBe(60);
    expect(view.inconsistencies).toEqual([]);
  });

  it("F. correção aprovada fecha o dia e o total volta ao certo", async () => {
    /*
      Sem segunda lógica de correção (§7 do escopo): a conta continua saindo
      de `resolveEffectiveTimeEntries`, e fechar o dia por aprovação é
      indistinguível de ter batido a saída na hora.
    */
    const ctx = await jornadaPassada(6, [
      ["CLOCK_IN", 11],
      ["BREAK_START", 15],
      ["BREAK_END", 16],
    ]);

    const antes = await verDia(ctx);
    expect(antes.workedMinutes).toBe(4 * 60);
    expect(antes.inconsistencies).toContain("Jornada em aberto.");

    const pedido = await requestTimeAdjustment(ctx.companyId, ctx.userId, {
      requestedType: "MISSING_ENTRY",
      requestedEntryType: "CLOCK_OUT",
      requestedOccurredAt: ctx.t(20),
      reason: "Esqueci de bater a saída.",
    });
    await decideTimeAdjustment(
      ctx.companyId,
      fixture.adminA.id,
      pedido.id,
      "APPROVED",
    );

    const depois = await verDia(ctx);
    expect(depois.state).toBe("FINISHED");
    expect(depois.workedMinutes).toBe(8 * 60);
    expect(depois.breakMinutes).toBe(60);
    expect(depois.inconsistencies).toEqual([]);
  });

  it("G. a marcação original continua imutável depois de tudo", async () => {
    const ctx = await jornadaPassada(7, [
      ["CLOCK_IN", 11],
      ["BREAK_START", 15],
      ["BREAK_END", 16],
    ]);
    const original = ctx.entries[0];
    const antes = {
      occurredAt: original.occurredAt.toISOString(),
      type: original.type,
      source: original.source,
    };

    const pedido = await requestTimeAdjustment(ctx.companyId, ctx.userId, {
      requestedType: "MISSING_ENTRY",
      requestedEntryType: "CLOCK_OUT",
      requestedOccurredAt: ctx.t(20),
      reason: "Esqueci.",
    });
    await decideTimeAdjustment(
      ctx.companyId,
      fixture.adminA.id,
      pedido.id,
      "APPROVED",
    );

    const depois = await prisma.timeEntry.findUniqueOrThrow({
      where: { id: original.id },
    });
    expect(depois.occurredAt.toISOString()).toBe(antes.occurredAt);
    expect(depois.type).toBe(antes.type);
    expect(depois.source).toBe(antes.source);
    // Nenhuma linha foi apagada: as três originais mais a derivada.
    expect(
      await prisma.timeEntry.count({ where: { workdayId: ctx.workday.id } }),
    ).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Histórico e painel — a mesma conta, nas outras superfícies
// ---------------------------------------------------------------------------

describe("O histórico e o painel usam a mesma regra", () => {
  it("o histórico não mostra centenas de horas num dia esquecido", async () => {
    const ctx = await jornadaPassada(9, [
      ["CLOCK_IN", 11],
      ["BREAK_START", 15],
      ["BREAK_END", 16],
    ]);

    const historico = await getWorkdayHistory(
      ctx.companyId,
      ctx.userId,
      new Date(Date.now() - 30 * 24 * 3_600_000),
      new Date(Date.now() + 24 * 3_600_000),
    );

    const dia = historico.find((d) => d.date === ctx.dia);
    expect(dia).toBeDefined();
    expect(dia!.workedMinutes).toBe(4 * 60);
    expect(dia!.state).toBe("WORKING");
    // §10: o dia histórico em aberto mostra tempo confirmado E a inconsistência.
    expect(dia!.inconsistencies).toContain("Jornada em aberto.");
  });

  it("o painel do gestor conta o parcial de HOJE, e não sinaliza", async () => {
    const ctx = { companyId: fixture.companyA.id, userId: fixture.techA.id };
    await punchTimeClock(ctx.companyId, ctx.userId, { type: "CLOCK_IN" });

    const equipe = await getTeamWorkday(ctx.companyId);
    const membro = equipe.members.find((m) => m.userId === ctx.userId);
    expect(membro?.state).toBe("WORKING");
    expect(membro?.workedMinutes).toBeLessThan(5);
    expect(membro?.inconsistencies).toEqual([]);
  });

  it("o painel de um dia PASSADO sinaliza e não acumula", async () => {
    const ctx = await jornadaPassada(2, [["CLOCK_IN", 11]]);

    // O painel aceita um instante: aqui ele lê o dia de dois dias atrás.
    const equipe = await getTeamWorkday(ctx.companyId, ctx.t(15));
    const membro = equipe.members.find((m) => m.userId === ctx.userId);
    expect(membro?.state).toBe("WORKING");
    expect(membro?.workedMinutes).toBe(0);
    expect(membro?.inconsistencies).toContain("Jornada em aberto.");
  });
});

// ---------------------------------------------------------------------------
// Fuso — quem decide o que é "hoje"
// ---------------------------------------------------------------------------

describe("O fuso da EMPRESA decide qual dia ainda está aberto", () => {
  /**
   * O instante em que São Paulo e Nova York discordam da data.
   *
   * `2026-05-05T02:00:00Z` é 4 de maio às 23h em São Paulo e 4 de maio às 22h
   * em Nova York — mesmo dia civil nos dois. Já `2026-05-05T12:00:00Z` é 5 de
   * maio nos dois. O que muda entre os fusos é ONDE fica a fronteira do dia, e
   * é isso que decide se um período aberto ainda é progresso.
   */
  it("um dia é 'hoje' pelo fuso da empresa, não pelo da máquina", async () => {
    /*
      A prova direta: a MESMA jornada, o MESMO instante de leitura, duas
      empresas em fusos diferentes — e uma delas ainda está no dia, a outra já
      virou.

      Empresa em São Paulo (UTC-3) e empresa em Nova York (UTC-4) no horário de
      verão. Às 02h UTC do dia 5, São Paulo ainda está no dia 4 às 23h e Nova
      York está no dia 4 às 22h. Uma hora depois — 03h UTC — São Paulo virou
      para o dia 5, e Nova York ainda está no dia 4.
    */
    const saoPaulo = new Date("2026-05-05T02:00:00.000Z");
    const novaYork = new Date("2026-05-05T03:00:00.000Z");

    expect(civilDateIn(saoPaulo, "America/Sao_Paulo")).toBe("2026-05-04");
    expect(civilDateIn(novaYork, "America/Sao_Paulo")).toBe("2026-05-05");
    expect(civilDateIn(novaYork, "America/New_York")).toBe("2026-05-04");

    /*
      O contraexemplo que a regra existe para impedir.

      `toISOString().slice(0, 10)` devolveria `2026-05-05` para os dois
      instantes, em qualquer fuso — e um dia que ainda está acontecendo em Nova
      York seria tratado como encerrado.
    */
    expect(novaYork.toISOString().slice(0, 10)).toBe("2026-05-05");
    expect(civilDateIn(novaYork, "America/New_York")).not.toBe(
      novaYork.toISOString().slice(0, 10),
    );
  });

  it("empresa em America/New_York calcula o próprio dia corrente", async () => {
    /*
      Não basta o helper de data conhecer o fuso: a conta de jornada precisa
      usá-lo. Aqui a empresa B está em Nova York, e o dia dela é semeado pelo
      fuso DELA — se a decisão de "é hoje?" usasse o fuso da máquina ou um
      padrão fixo, este dia corrente seria lido como passado e o parcial
      sumiria.
    */
    await prisma.company.update({
      where: { id: fixture.companyB.id },
      data: { timezone: "America/New_York" },
    });

    await punchTimeClock(fixture.companyB.id, fixture.adminB.id, {
      type: "CLOCK_IN",
    });

    const view = await getWorkdayView(fixture.companyB.id, fixture.adminB.id);
    expect(view.timezone).toBe("America/New_York");
    expect(view.state).toBe("WORKING");
    // Dia corrente em Nova York: parcial existe, e não é sinalizado.
    expect(view.workedMinutes).toBeLessThan(5);
    expect(view.inconsistencies).toEqual([]);
  });

  it("trocar o fuso NÃO reabre um dia antigo", async () => {
    /*
      Ataque ao critério de "hoje".

      `openPeriodEnd` compara o dia gravado com o dia civil de agora no fuso da
      EMPRESA. Um fuso diferente desloca essa fronteira — e a pergunta é de
      quanto. Qualquer fuso válido do mundo move o dia civil em no máximo um
      dia, então um dia de 10 dias atrás continua passado sob qualquer um deles,
      e nenhuma escolha de fuso ressuscita a acumulação até agora.

      O valor também não é livre: `resolveTimezone` cai no padrão diante de
      lixo, e `Company.timezone` ainda não tem superfície administrativa
      (JOR-05).
    */
    const ctx = await jornadaPassada(10, [["CLOCK_IN", 11]]);

    for (const fuso of [
      "America/New_York",
      "Pacific/Kiritimati", // UTC+14, a fronteira mais adiantada do mundo
      "Pacific/Midway", // UTC-11, a mais atrasada
      "nao-e-um-fuso", // lixo: cai no padrão por `resolveTimezone`
    ]) {
      await prisma.company.update({
        where: { id: ctx.companyId },
        data: { timezone: fuso },
      });

      const view = await getWorkdayView(ctx.companyId, ctx.userId, ctx.t(15));

      // O INVARIANTE: nenhum fuso do mundo faz um dia antigo somar tempo.
      expect(view.workedMinutes).toBe(0);

      /*
        O sinal só é exigido quando o dia continua sendo ACHADO.

        `getWorkdayView` resolve a data do instante pelo fuso ATUAL da empresa —
        comportamento anterior a esta correção. Sob `Pacific/Kiritimati` o mesmo
        instante cai no dia civil seguinte, a busca não encontra a jornada, e a
        resposta é o dia vazio. O teste diz isso em vez de fingir que não
        acontece: over-assertar aqui esconderia a coisa real que ele prova.
      */
      if (view.workdayId !== null) {
        expect(view.inconsistencies).toContain("Jornada em aberto.");
      }
    }
  });

  it("empresa em America/New_York não acumula num dia passado dela", async () => {
    await prisma.company.update({
      where: { id: fixture.companyB.id },
      data: { timezone: "America/New_York" },
    });

    const ctx = await jornadaPassada(
      8,
      [["CLOCK_IN", 14]],
      { companyId: fixture.companyB.id, userId: fixture.adminB.id },
    );

    const view = await getWorkdayView(ctx.companyId, ctx.userId, ctx.t(18));
    expect(view.workedMinutes).toBe(0);
    expect(view.inconsistencies).toContain("Jornada em aberto.");
  });
});

// ---------------------------------------------------------------------------
// Tenancy — o campo novo não abre porta nenhuma
// ---------------------------------------------------------------------------

describe("As superfícies novas continuam isoladas por empresa", () => {
  it("o histórico da empresa B não enxerga o dia da empresa A", async () => {
    /*
      `getWorkdayHistory` ganhou uma consulta nova (o fuso da empresa) e um campo
      novo no DTO. Consulta nova é sempre a chance de um recorte de tenant ficar
      para trás.
    */
    const ctx = await jornadaPassada(6, [["CLOCK_IN", 11]]);

    const deFora = await getWorkdayHistory(
      fixture.companyB.id,
      ctx.userId,
      new Date(Date.now() - 30 * 24 * 3_600_000),
      new Date(),
    );
    expect(deFora).toEqual([]);

    // CONTROLE POSITIVO: pela própria empresa, o dia está lá — sem isto, o
    // teste acima poderia estar passando por vazio.
    const daCasa = await getWorkdayHistory(
      ctx.companyId,
      ctx.userId,
      new Date(Date.now() - 30 * 24 * 3_600_000),
      new Date(),
    );
    expect(daCasa.some((d) => d.date === ctx.dia)).toBe(true);
  });

  it("o painel da empresa B não mostra a inconsistência da empresa A", async () => {
    const ctx = await jornadaPassada(2, [["CLOCK_IN", 11]]);

    const equipeB = await getTeamWorkday(fixture.companyB.id, ctx.t(15));
    expect(equipeB.members.some((m) => m.userId === ctx.userId)).toBe(false);
    // Nenhum membro de B herda o sinal de A.
    expect(equipeB.members.every((m) => m.inconsistencies.length === 0)).toBe(
      true,
    );

    // CONTROLE POSITIVO: na empresa certa, o sinal aparece.
    const equipeA = await getTeamWorkday(ctx.companyId, ctx.t(15));
    const membro = equipeA.members.find((m) => m.userId === ctx.userId);
    expect(membro?.inconsistencies).toContain("Jornada em aberto.");
  });

  it("a inconsistência é texto FIXO do servidor, não conteúdo de usuário", async () => {
    /*
      O texto vai para duas telas. Se ele pudesse carregar conteúdo de usuário,
      seria um vetor de injeção em ambas.

      Aqui o motivo do pedido — o único texto livre por perto — é hostil de
      propósito, e não encosta na lista: as mensagens são literais do domínio.
    */
    const ctx = await jornadaPassada(3, [["CLOCK_IN", 11]]);

    await requestTimeAdjustment(ctx.companyId, ctx.userId, {
      requestedType: "MISSING_ENTRY",
      requestedEntryType: "CLOCK_OUT",
      requestedOccurredAt: ctx.t(20),
      reason: "<img src=x onerror=alert(1)> </script>",
    });

    const view = await getWorkdayView(ctx.companyId, ctx.userId, ctx.t(15));
    expect(view.inconsistencies).toEqual(["Jornada em aberto."]);
    expect(view.inconsistencies.join("")).not.toContain("<");
  });
});
