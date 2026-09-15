import { describe, it, expect, beforeEach, vi } from "vitest";
import { AccessProfile, type ServiceOrderStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { listServiceOrdersForTechnician } from "@/lib/service-orders";
import {
  isOverdueServiceOrder,
  serviceOrderSliceWhere,
} from "@/lib/service-order-slices";
import { civilDateIn, civilDayBoundsIn } from "@/lib/workday";
import { seedTestData, type TestFixture } from "./helpers";

/**
 * # HOTFIX-FIELD-01 — o "hoje" de `/minhas-os` é o dia da EMPRESA
 *
 * `listServiceOrdersForTechnician` montava o dia com `new Date(ano, mês, dia)`,
 * o fuso do PROCESSO. O dia certo é o civil da empresa (`Company.timezone`),
 * a mesma autoridade do cartão "OS de hoje" do painel.
 *
 * Um teste em que o fuso do servidor e o da empresa dão o MESMO dia não prova
 * nada. Por isso o cenário central põe a empresa em `Asia/Tokyo` e escolhe um
 * instante em que Tóquio já está no dia seguinte: 15h30 UTC de 12/09 é 00h30 de
 * 13/09 em Tóquio, 12h30 de 12/09 em São Paulo e 15h30 de 12/09 em UTC. Um
 * pré-requisito explícito falha se o processo de teste rodar num fuso em que a
 * divergência não exista.
 */

let fixture: TestFixture;
let numero = 0;

const TOKYO = "Asia/Tokyo";
const AGORA = new Date("2026-09-12T15:30:00.000Z"); // 13/09 00h30 em Tóquio

// Os instantes do cenário, todos em UTC.
const INICIO_DIA_TOKYO = new Date("2026-09-12T15:00:00.000Z"); // 13/09 00h00 em Tóquio
const ONTEM_TOKYO_HOJE_SERVIDOR = new Date("2026-09-12T14:59:00.000Z"); // 12/09 23h59 em Tóquio
const HOJE_TOKYO_AMANHA_SERVIDOR = new Date("2026-09-13T10:00:00.000Z"); // 13/09 19h00 em Tóquio
const INICIO_DIA_SEGUINTE_TOKYO = new Date("2026-09-13T15:00:00.000Z"); // 14/09 00h00 em Tóquio

beforeEach(async () => {
  fixture = await seedTestData();
  numero = 0;
});

async function empresaNoFuso(companyId: string, timezone: string) {
  await prisma.company.update({ where: { id: companyId }, data: { timezone } });
}

async function tecnico(companyId: string, nome: string) {
  numero += 1;
  const user = await prisma.user.create({
    data: {
      companyId,
      name: nome,
      email: `hotfix.field.${numero}.${Date.now()}@sintetico.local`,
      profile: AccessProfile.TECHNICIAN,
      passwordHash: "x",
    },
  });
  return prisma.technician.create({ data: { companyId, userId: user.id } });
}

async function cliente(companyId: string) {
  return prisma.customer.create({ data: { companyId, name: `Cliente ${numero}` } });
}

async function os(opcoes: {
  companyId: string;
  customerId: string;
  technicianId: string;
  scheduledAt: Date | null;
  status?: ServiceOrderStatus;
}) {
  numero += 1;
  return prisma.serviceOrder.create({
    data: {
      companyId: opcoes.companyId,
      number: 5000 + numero,
      customerId: opcoes.customerId,
      technicianId: opcoes.technicianId,
      type: "INSTALACAO",
      description: "os do hotfix",
      status: opcoes.status ?? "ASSIGNED",
      scheduledAt: opcoes.scheduledAt,
    },
  });
}

/** O cenário de Tóquio: uma OS em cada lado de cada fronteira. */
async function cenarioTokyo() {
  const companyId = fixture.companyA.id;
  await empresaNoFuso(companyId, TOKYO);
  const t = await tecnico(companyId, "Técnico Hoje");
  const c = await cliente(companyId);
  const base = { companyId, customerId: c.id, technicianId: t.id };
  return {
    companyId,
    technicianId: t.id,
    customerId: c.id,
    inicio: await os({ ...base, scheduledAt: INICIO_DIA_TOKYO }),
    ontemEmpresa: await os({ ...base, scheduledAt: ONTEM_TOKYO_HOJE_SERVIDOR }),
    amanhaServidor: await os({ ...base, scheduledAt: HOJE_TOKYO_AMANHA_SERVIDOR }),
    inicioSeguinte: await os({ ...base, scheduledAt: INICIO_DIA_SEGUINTE_TOKYO }),
    semAgenda: await os({ ...base, scheduledAt: null }),
  };
}

const ids = (lista: { id: string }[]) => lista.map((o) => o.id).sort();

/** O dia que o código ANTIGO usava: o civil do processo, em hora local. */
function diaDoProcesso(agora: Date) {
  return {
    start: new Date(agora.getFullYear(), agora.getMonth(), agora.getDate()),
    end: new Date(agora.getFullYear(), agora.getMonth(), agora.getDate() + 1),
  };
}

describe("HOTFIX-FIELD-01 — o 'hoje' de /minhas-os", () => {
  it("pré-requisito · neste instante, o dia do processo de teste NÃO é o dia de Tóquio", () => {
    const processo = diaDoProcesso(AGORA);
    const empresa = civilDayBoundsIn(AGORA, TOKYO);
    // Se isto falhar, o processo roda num fuso onde o cenário não discrimina
    // (ex.: em Tóquio), e os testes abaixo deixariam de provar a correção.
    expect(processo.start.getTime()).not.toBe(empresa.start.getTime());
    // E as duas OS que o cenário usa para discriminar caem em lados opostos.
    const noDiaDoProcesso = (d: Date) => d >= processo.start && d < processo.end;
    expect(noDiaDoProcesso(ONTEM_TOKYO_HOJE_SERVIDOR)).toBe(true);
    expect(noDiaDoProcesso(HOJE_TOKYO_AMANHA_SERVIDOR)).toBe(false);
    expect(civilDateIn(AGORA, TOKYO)).toBe("2026-09-13");
  });

  it("FIELD-TODAY-01 · o dia vem do fuso da EMPRESA: trocar o fuso da empresa troca o 'hoje'", async () => {
    const c = await cenarioTokyo();

    const emTokyo = await listServiceOrdersForTechnician(c.companyId, c.technicianId, AGORA);
    expect(ids(emTokyo.today)).toEqual(ids([c.inicio, c.amanhaServidor]));

    // A mesma fila, com a empresa em São Paulo: outro dia civil, outro "hoje".
    await empresaNoFuso(c.companyId, "America/Sao_Paulo");
    const emSaoPaulo = await listServiceOrdersForTechnician(c.companyId, c.technicianId, AGORA);
    expect(ids(emSaoPaulo.today)).toEqual(ids([c.inicio, c.ontemEmpresa]));

    // E o que não é "hoje" continua na fila — nenhuma OS some. Desde a RC-1D
    // cada uma vai para a seção que a descreve: atrasada, próxima ou sem data.
    expect(
      ids([
        ...emTokyo.overdue,
        ...emTokyo.today,
        ...emTokyo.upcoming,
        ...emTokyo.unscheduled,
      ]),
    ).toEqual(
      ids([c.inicio, c.ontemEmpresa, c.amanhaServidor, c.inicioSeguinte, c.semAgenda]),
    );
  });

  /*
    RC-1D — "Próximas" era tudo o que não era "Em atendimento" nem "Hoje":
    futuro, vencido e sem data no mesmo balde. O dono viu uma OS de 06/09 lá
    numa validação de 13/09.
  */
  it("RC1D-FILA-01 · cada OS vai para a seção que a descreve: atrasada, hoje, próxima, sem data", async () => {
    const c = await cenarioTokyo();
    const fila = await listServiceOrdersForTechnician(c.companyId, c.technicianId, AGORA);

    expect(ids(fila.overdue)).toEqual(ids([c.ontemEmpresa]));
    expect(ids(fila.today)).toEqual(ids([c.inicio, c.amanhaServidor]));
    expect(ids(fila.upcoming)).toEqual(ids([c.inicioSeguinte]));
    expect(ids(fila.unscheduled)).toEqual(ids([c.semAgenda]));

    // Nenhuma OS em duas seções.
    const todas = [
      ...fila.inProgress,
      ...fila.overdue,
      ...fila.today,
      ...fila.upcoming,
      ...fila.unscheduled,
    ].map((o) => o.id);
    expect(new Set(todas).size).toBe(todas.length);
  });

  it("RC1D-FILA-02 · 'Hoje' vence 'Atrasadas': o agendamento de hoje que já passou é trabalho de HOJE", async () => {
    const c = await cenarioTokyo();
    // 13/09 00h30 em Tóquio já passou às 00h30… então usa-se um instante depois.
    const maisTarde = new Date("2026-09-13T02:00:00.000Z"); // 13/09 11h em Tóquio
    const cedoHoje = await os({
      companyId: c.companyId,
      customerId: c.customerId,
      technicianId: c.technicianId,
      scheduledAt: new Date("2026-09-12T23:00:00.000Z"), // 13/09 08h em Tóquio
    });
    const fila = await listServiceOrdersForTechnician(
      c.companyId,
      c.technicianId,
      maisTarde,
    );
    expect(ids(fila.today)).toContain(cedoHoje.id);
    expect(ids(fila.overdue)).not.toContain(cedoHoje.id);
  });

  it("RC1D-FILA-03 · a regra de atrasada é a do painel — a mesma resposta em SQL e em memória", async () => {
    const c = await cenarioTokyo();
    const clock = { now: AGORA, timezone: TOKYO };

    // O que o painel conta como atrasada, pelo predicado em SQL.
    const emSql = await prisma.serviceOrder.findMany({
      where: {
        companyId: c.companyId,
        technicianId: c.technicianId,
        ...serviceOrderSliceWhere("atrasadas", clock),
      },
      select: { id: true, status: true, scheduledAt: true },
    });
    // A mesma pergunta, em memória, sobre as linhas da fila.
    const todas = await prisma.serviceOrder.findMany({
      where: { companyId: c.companyId, technicianId: c.technicianId },
      select: { id: true, status: true, scheduledAt: true },
    });
    const emMemoria = todas.filter((o) => isOverdueServiceOrder(o, AGORA));

    expect(emMemoria.map((o) => o.id).sort()).toEqual(
      emSql.map((o) => o.id).sort(),
    );
    // E a seção "Atrasadas" é exatamente isso, menos o que "Hoje" levou.
    const fila = await listServiceOrdersForTechnician(c.companyId, c.technicianId, AGORA);
    const doDia = new Set(ids(fila.today));
    expect(ids(fila.overdue).sort()).toEqual(
      emSql.map((o) => o.id).filter((id) => !doDia.has(id)).sort(),
    );
  });

  it("RC1D-FILA-04 · OS sem agendamento nunca é atrasada — não há prazo a vencer", async () => {
    const c = await cenarioTokyo();
    const fila = await listServiceOrdersForTechnician(c.companyId, c.technicianId, AGORA);
    expect(ids(fila.overdue)).not.toContain(c.semAgenda.id);
    expect(ids(fila.unscheduled)).toContain(c.semAgenda.id);
    expect(
      isOverdueServiceOrder({ status: "ASSIGNED", scheduledAt: null }, AGORA),
    ).toBe(false);
  });

  it("FIELD-TODAY-01b · fuso ausente ou inválido segue o contrato de resolveTimezone — nada inventado", async () => {
    const c = await cenarioTokyo();
    await empresaNoFuso(c.companyId, "Nao/Existe");
    const invalido = await listServiceOrdersForTechnician(c.companyId, c.technicianId, AGORA);
    // `resolveTimezone` cai em DEFAULT_TIMEZONE (America/Sao_Paulo).
    await empresaNoFuso(c.companyId, "America/Sao_Paulo");
    const padrao = await listServiceOrdersForTechnician(c.companyId, c.technicianId, AGORA);
    expect(ids(invalido.today)).toEqual(ids(padrao.today));
  });

  it("FIELD-TODAY-02 · 'hoje' no servidor mas 'ontem' na empresa NÃO entra em Hoje — e desde a RC-1D é ATRASADA", async () => {
    const c = await cenarioTokyo();
    const fila = await listServiceOrdersForTechnician(c.companyId, c.technicianId, AGORA);
    expect(ids(fila.today)).not.toContain(c.ontemEmpresa.id);
    expect(ids(fila.overdue)).toContain(c.ontemEmpresa.id);
    expect(ids(fila.upcoming)).not.toContain(c.ontemEmpresa.id);
  });

  it("FIELD-TODAY-03 · 'amanhã' no servidor mas 'hoje' na empresa ENTRA em Hoje", async () => {
    const c = await cenarioTokyo();
    const fila = await listServiceOrdersForTechnician(c.companyId, c.technicianId, AGORA);
    expect(ids(fila.today)).toContain(c.amanhaServidor.id);
  });

  it("FIELD-TODAY-04 · o início do dia da empresa é INCLUSIVO", async () => {
    const c = await cenarioTokyo();
    const fila = await listServiceOrdersForTechnician(c.companyId, c.technicianId, AGORA);
    expect(civilDayBoundsIn(AGORA, TOKYO).start).toEqual(INICIO_DIA_TOKYO);
    expect(ids(fila.today)).toContain(c.inicio.id);
  });

  it("FIELD-TODAY-05 · o início do dia seguinte é EXCLUSIVO", async () => {
    const c = await cenarioTokyo();
    const fila = await listServiceOrdersForTechnician(c.companyId, c.technicianId, AGORA);
    expect(civilDayBoundsIn(AGORA, TOKYO).end).toEqual(INICIO_DIA_SEGUINTE_TOKYO);
    expect(ids(fila.today)).not.toContain(c.inicioSeguinte.id);
    expect(ids(fila.upcoming)).toContain(c.inicioSeguinte.id);
  });

  it("FIELD-TODAY-06 · tenant: OS de outra empresa apontando o técnico não aparece", async () => {
    const c = await cenarioTokyo();
    const clienteB = await cliente(fixture.companyB.id);
    // O vetor da DQ-7.1: `ServiceOrder.technicianId` é FK simples.
    const deB = await os({
      companyId: fixture.companyB.id,
      customerId: clienteB.id,
      technicianId: c.technicianId,
      scheduledAt: INICIO_DIA_TOKYO,
    });
    const fila = await listServiceOrdersForTechnician(c.companyId, c.technicianId, AGORA);
    const todas = ids([...fila.inProgress, ...fila.today, ...fila.upcoming]);
    expect(todas).not.toContain(deB.id);
  });

  it("FIELD-TODAY-07 · o técnico não ganha OS de outro técnico da mesma empresa", async () => {
    const c = await cenarioTokyo();
    const outro = await tecnico(c.companyId, "Outro Técnico");
    const doOutro = await os({
      companyId: c.companyId,
      customerId: c.customerId,
      technicianId: outro.id,
      scheduledAt: INICIO_DIA_TOKYO,
    });
    const fila = await listServiceOrdersForTechnician(c.companyId, c.technicianId, AGORA);
    const todas = ids([...fila.inProgress, ...fila.today, ...fila.upcoming]);
    expect(todas).not.toContain(doOutro.id);
  });

  it("FIELD-TODAY-07b · status continua vencendo o agendamento: IN_PROGRESS de hoje fica em 'Em atendimento'", async () => {
    const c = await cenarioTokyo();
    const iniciada = await os({
      companyId: c.companyId,
      customerId: c.customerId,
      technicianId: c.technicianId,
      scheduledAt: HOJE_TOKYO_AMANHA_SERVIDOR,
      status: "IN_PROGRESS",
    });
    const fila = await listServiceOrdersForTechnician(c.companyId, c.technicianId, AGORA);
    expect(ids(fila.inProgress)).toEqual([iniciada.id]);
    expect(ids(fila.today)).not.toContain(iniciada.id);
  });

  describe("FIELD-TODAY-08 · dia de horário de verão não tem 24 horas", () => {
    const NOVA_YORK = "America/New_York";

    it("dia de 25 h (fim do horário de verão): a última hora do dia ainda é 'hoje'", async () => {
      const companyId = fixture.companyA.id;
      await empresaNoFuso(companyId, NOVA_YORK);
      const t = await tecnico(companyId, "Técnico DST");
      const c = await cliente(companyId);
      const agora = new Date("2026-11-01T16:00:00.000Z"); // 01/11 11h00 EST
      const dia = civilDayBoundsIn(agora, NOVA_YORK);
      expect(dia.end.getTime() - dia.start.getTime()).toBe(25 * 3_600_000);

      // 01/11 23h30 EST — dentro do dia de 25 h, fora de um de 24 h.
      const ultimaHora = await os({
        companyId,
        customerId: c.id,
        technicianId: t.id,
        scheduledAt: new Date("2026-11-02T04:30:00.000Z"),
      });
      const fila = await listServiceOrdersForTechnician(companyId, t.id, agora);
      expect(ids(fila.today)).toEqual([ultimaHora.id]);
    });

    it("dia de 23 h (início do horário de verão): a meia-noite seguinte já é 'amanhã'", async () => {
      const companyId = fixture.companyA.id;
      await empresaNoFuso(companyId, NOVA_YORK);
      const t = await tecnico(companyId, "Técnico DST 2");
      const c = await cliente(companyId);
      const agora = new Date("2026-03-08T17:00:00.000Z"); // 08/03 13h00 EDT
      const dia = civilDayBoundsIn(agora, NOVA_YORK);
      expect(dia.end.getTime() - dia.start.getTime()).toBe(23 * 3_600_000);

      // 09/03 00h30 EDT — já é o dia seguinte; um dia fixo de 24 h o incluiria.
      const amanha = await os({
        companyId,
        customerId: c.id,
        technicianId: t.id,
        scheduledAt: new Date("2026-03-09T04:30:00.000Z"),
      });
      const fila = await listServiceOrdersForTechnician(companyId, t.id, agora);
      expect(ids(fila.today)).toEqual([]);
      expect(ids(fila.upcoming)).toEqual([amanha.id]);
    });
  });

  it("FIELD-TODAY-09 · consultas: a MESMA leitura da fila e UMA do fuso da empresa, com 2 ou 12 OS", async () => {
    const osFindMany = vi.spyOn(prisma.serviceOrder, "findMany");
    const empresa = vi.spyOn(prisma.company, "findUnique");
    const c = await cenarioTokyo();
    const medir = async () => {
      osFindMany.mockClear();
      empresa.mockClear();
      await listServiceOrdersForTechnician(c.companyId, c.technicianId, AGORA);
      return [osFindMany.mock.calls.length, empresa.mock.calls.length];
    };
    const pouco = await medir();
    for (let i = 0; i < 7; i++) {
      await os({
        companyId: c.companyId,
        customerId: c.customerId,
        technicianId: c.technicianId,
        scheduledAt: HOJE_TOKYO_AMANHA_SERVIDOR,
      });
    }
    const muito = await medir();
    expect(pouco).toEqual([1, 1]);
    expect(muito).toEqual(pouco);
    osFindMany.mockRestore();
    empresa.mockRestore();
  });
});
