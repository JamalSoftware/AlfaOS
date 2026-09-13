import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  AccessProfile,
  type ConnectivityStatus,
  type ERPProvider,
  type ServiceOrderStatus,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  getOperationalDashboard,
  type DashboardSection,
  type OperationalDashboard,
} from "@/lib/dashboard";
import { createCto, listCompanyCtos } from "@/lib/cto";
import { getCtoMapView } from "@/lib/cto-map";
import {
  getCompanyCtoStates,
  matchesCtoAttention,
} from "@/lib/cto-attention";
import {
  getCompanyConnectivityStatuses,
  getConnectivityForCustomers,
} from "@/lib/customer-diagnostics";
import { listCompanyCustomers } from "@/lib/customers";
import { listCompanyServiceOrders } from "@/lib/service-orders";
import { SERVICE_ORDER_SLICES } from "@/lib/service-order-slices";
import { listCompanyTechnicians } from "@/lib/technicians";
import { seedTestData, type TestFixture } from "./helpers";

/**
 * # DASH-1 — o painel operacional (PRD §380, MASTER-PLAN §4)
 *
 * Três afirmações atravessam o arquivo:
 *
 * 1. **o cartão é a listagem** — cada número é igual à contagem da tela que o
 *    cartão abre, com o mesmo filtro que o link leva;
 * 2. **o painel não interpreta o domínio** — OS aberta, conectividade e
 *    estado da CTO vêm das autoridades que já existem;
 * 3. **zero é dado, erro é erro** — seção que falha nunca vira `0`.
 *
 * O relógio é fixo: 12h de 12/09/2026 em São Paulo (15h UTC). "Hoje" e
 * "atrasada" dependem dele, e um teste que dependesse da hora em que roda
 * seria a bomba-relógio que a `DQ-4` e a `NF-3` já desarmaram.
 */

let fixture: TestFixture;
let numero = 0;

const AGORA = new Date("2026-09-12T15:00:00.000Z");
const TZ = "America/Sao_Paulo";
const RELOGIO = { now: AGORA, timezone: TZ };
const HORA = 3_600_000;

beforeEach(async () => {
  fixture = await seedTestData();
  numero = 0;
  for (const id of [fixture.companyA.id, fixture.companyB.id]) {
    await prisma.company.update({
      where: { id },
      data: { ctoNetworkEnabled: true, timezone: TZ },
    });
  }
});

const admin = (companyId?: string) => ({
  companyId: companyId ?? fixture.companyA.id,
  profile: AccessProfile.ADMIN,
});

function ok<T>(secao: DashboardSection<T>): T {
  if (secao.state !== "ok") throw new Error(`seção em estado ${secao.state}`);
  return secao.data;
}

const painel = (companyId?: string): Promise<OperationalDashboard> =>
  getOperationalDashboard(admin(companyId), AGORA);

async function tecnico(userId: string, companyId: string) {
  return prisma.technician.upsert({
    where: { userId },
    update: {},
    create: { companyId, userId },
  });
}

async function cliente(nome: string, companyId?: string, ativo = true) {
  return prisma.customer.create({
    data: { companyId: companyId ?? fixture.companyA.id, name: nome, active: ativo },
  });
}

async function os(opcoes: {
  customerId: string;
  status: ServiceOrderStatus;
  companyId?: string;
  scheduledAt?: Date | null;
  technicianId?: string | null;
}) {
  numero += 1;
  return prisma.serviceOrder.create({
    data: {
      companyId: opcoes.companyId ?? fixture.companyA.id,
      number: 9000 + numero,
      customerId: opcoes.customerId,
      type: "INSTALACAO",
      description: "os do painel",
      status: opcoes.status,
      scheduledAt: opcoes.scheduledAt ?? null,
      technicianId: opcoes.technicianId ?? null,
      ...(opcoes.status === "COMPLETED" ? { completedAt: AGORA } : {}),
      ...(opcoes.status === "CANCELLED" ? { cancelledAt: AGORA } : {}),
    },
  });
}

async function leitura(
  customerId: string,
  status: ConnectivityStatus,
  opcoes: { companyId?: string; provider?: ERPProvider; observedAt?: Date } = {},
) {
  return prisma.customerDiagnosticSnapshot.create({
    data: {
      companyId: opcoes.companyId ?? fixture.companyA.id,
      customerId,
      externalProvider: opcoes.provider ?? "MOCK",
      connectivityStatus: status,
      observedAt: opcoes.observedAt ?? AGORA,
      technology: "1",
    },
  });
}

async function caixa(
  nome: string,
  opcoes: {
    companyId?: string;
    autorId?: string;
    clientes?: { id: string; porta: number }[];
    danificadas?: number[];
    ativa?: boolean;
    comCoordenada?: boolean;
  } = {},
) {
  const companyId = opcoes.companyId ?? fixture.companyA.id;
  const cto = await createCto(companyId, opcoes.autorId ?? fixture.adminA.id, {
    name: nome,
    capacity: 8,
    ...(opcoes.comCoordenada === false ? {} : { latitude: -20.5, longitude: -41.5 }),
  });
  for (const vinculo of opcoes.clientes ?? []) {
    const porta = await prisma.cTOPort.findFirstOrThrow({
      where: { ctoId: cto.id, number: vinculo.porta },
    });
    await prisma.customerNetworkConnection.create({
      data: {
        companyId,
        customerId: vinculo.id,
        ctoPortId: porta.id,
        source: "WEB",
        connectedAt: AGORA,
      },
    });
  }
  for (const n of opcoes.danificadas ?? []) {
    await prisma.cTOPort.updateMany({
      where: { ctoId: cto.id, number: n },
      data: { administrativeState: "DAMAGED" },
    });
  }
  if (opcoes.ativa === false) {
    await prisma.cTO.update({ where: { id: cto.id }, data: { active: false } });
  }
  return cto;
}

// ---------------------------------------------------------------------------
// DASH-OS — os recortes de OS
// ---------------------------------------------------------------------------

describe("DASH-OS — OS abertas, atrasadas, de hoje e pendentes", () => {
  it("DASH-OS-01 · abertas é o predicado compartilhado; pendentes é só PENDING", async () => {
    const c = await cliente("Cliente OS");
    const t = await tecnico(fixture.techA.id, fixture.companyA.id);
    await os({ customerId: c.id, status: "PENDING" });
    await os({ customerId: c.id, status: "ASSIGNED", technicianId: t.id });
    await os({ customerId: c.id, status: "IN_PROGRESS", technicianId: t.id });
    await os({ customerId: c.id, status: "COMPLETED", technicianId: t.id });
    await os({ customerId: c.id, status: "CANCELLED" });

    const dados = ok((await painel()).serviceOrders);
    expect(dados.abertas).toBe(3);
    expect(dados.pendentes).toBe(1);
  });

  it("DASH-OS-02 · atrasada = agendada, vencida e AINDA NÃO iniciada (decisão do dono)", async () => {
    const c = await cliente("Cliente Atraso");
    const t = await tecnico(fixture.techA.id, fixture.companyA.id);
    const ontem = new Date(AGORA.getTime() - 20 * HORA);
    const daquiAPouco = new Date(AGORA.getTime() + 2 * HORA);

    await os({ customerId: c.id, status: "PENDING", scheduledAt: ontem }); // conta
    await os({ customerId: c.id, status: "ASSIGNED", technicianId: t.id, scheduledAt: ontem }); // conta
    await os({ customerId: c.id, status: "IN_PROGRESS", technicianId: t.id, scheduledAt: ontem }); // não: em atendimento
    await os({ customerId: c.id, status: "PENDING", scheduledAt: daquiAPouco }); // não: não venceu
    await os({ customerId: c.id, status: "PENDING", scheduledAt: null }); // não: sem prazo
    await os({ customerId: c.id, status: "COMPLETED", technicianId: t.id, scheduledAt: ontem }); // não
    await os({ customerId: c.id, status: "CANCELLED", scheduledAt: ontem }); // não

    expect(ok((await painel()).serviceOrders).atrasadas).toBe(2);
  });

  it("DASH-OS-03 · hoje é o dia da EMPRESA, e o fuso dela muda a resposta", async () => {
    const c = await cliente("Cliente Hoje");
    const t = await tecnico(fixture.techA.id, fixture.companyA.id);
    // 23h30 de hoje em São Paulo — em UTC já é amanhã.
    await os({ customerId: c.id, status: "PENDING", scheduledAt: new Date("2026-09-13T02:30:00Z") });
    // Em atendimento, agendada de manhã — continua sendo trabalho de hoje.
    await os({ customerId: c.id, status: "IN_PROGRESS", technicianId: t.id, scheduledAt: new Date("2026-09-12T11:00:00Z") });
    // 00h30 de amanhã em São Paulo.
    await os({ customerId: c.id, status: "PENDING", scheduledAt: new Date("2026-09-13T03:30:00Z") });
    // 23h30 de ontem em São Paulo.
    await os({ customerId: c.id, status: "PENDING", scheduledAt: new Date("2026-09-12T02:30:00Z") });
    // Concluída hoje: saiu do trabalho que falta.
    await os({ customerId: c.id, status: "COMPLETED", technicianId: t.id, scheduledAt: new Date("2026-09-12T13:00:00Z") });
    // 07h de amanhã em São Paulo — 19h do dia 13 em Tóquio.
    await os({ customerId: c.id, status: "PENDING", scheduledAt: new Date("2026-09-13T10:00:00Z") });

    expect(ok((await painel()).serviceOrders).hoje).toBe(2);

    /*
      Em Tóquio, 15h UTC já é 00h do dia 13: o "hoje" é OUTRO dia, e a
      resposta muda — 02h30Z, 03h30Z e 10h00Z do dia 13. É isso que prova que o
      fuso vem da EMPRESA: o do processo de teste não mudou.
    */
    await prisma.company.update({
      where: { id: fixture.companyA.id },
      data: { timezone: "Asia/Tokyo" },
    });
    const toquio = await painel();
    expect(ok(toquio.serviceOrders).hoje).toBe(3);
    expect(toquio.timezone).toBe("Asia/Tokyo");
  });

  it("DASH-OS-04 · o cartão É a listagem de destino, recorte por recorte", async () => {
    const c = await cliente("Cliente Igualdade");
    const t = await tecnico(fixture.techA.id, fixture.companyA.id);
    const ontem = new Date(AGORA.getTime() - 20 * HORA);
    for (let i = 0; i < 3; i++) {
      await os({ customerId: c.id, status: "PENDING", scheduledAt: ontem });
      await os({ customerId: c.id, status: "ASSIGNED", technicianId: t.id, scheduledAt: AGORA });
      await os({ customerId: c.id, status: "IN_PROGRESS", technicianId: t.id });
      await os({ customerId: c.id, status: "COMPLETED", technicianId: t.id, scheduledAt: ontem });
    }
    const dados = ok((await painel()).serviceOrders);

    for (const slice of SERVICE_ORDER_SLICES) {
      // pageSize 1: a igualdade é com o TOTAL, não com o tamanho da página.
      const lista = await listCompanyServiceOrders(fixture.companyA.id, {
        slice,
        clock: RELOGIO,
        pageSize: 1,
      });
      expect(lista.total, `recorte ${slice}`).toBe(dados[slice]);
    }
    const pendentes = await listCompanyServiceOrders(fixture.companyA.id, {
      status: "PENDING",
      pageSize: 1,
    });
    expect(pendentes.total).toBe(dados.pendentes);
    expect(dados).toEqual({ abertas: 9, atrasadas: 3, hoje: 3, pendentes: 3 });
  });

  it("DASH-OS-05 · recorte e filtro de status somam por AND — nenhum sobrescreve o outro", async () => {
    const c = await cliente("Cliente AND");
    const ontem = new Date(AGORA.getTime() - 20 * HORA);
    await os({ customerId: c.id, status: "PENDING", scheduledAt: ontem });
    await os({ customerId: c.id, status: "COMPLETED", scheduledAt: ontem });

    const vazia = await listCompanyServiceOrders(fixture.companyA.id, {
      slice: "atrasadas",
      status: "COMPLETED",
      clock: RELOGIO,
    });
    expect(vazia.total).toBe(0);
    const soPendentes = await listCompanyServiceOrders(fixture.companyA.id, {
      slice: "abertas",
      status: "PENDING",
      clock: RELOGIO,
    });
    expect(soPendentes.total).toBe(1);
  });

  it("DASH-OS-06 · nenhuma relação 1:N infla a contagem de OS", async () => {
    const c = await cliente("Cliente Eventos");
    const aberta = await os({ customerId: c.id, status: "PENDING" });
    for (let i = 0; i < 5; i++) {
      await prisma.serviceOrderEvent.create({
        data: {
          companyId: fixture.companyA.id,
          serviceOrderId: aberta.id,
          event: "NOTE",
          metadata: { i },
        },
      });
    }
    expect(ok((await painel()).serviceOrders).abertas).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// DASH-TEAM — técnicos em atendimento
// ---------------------------------------------------------------------------

describe("DASH-TEAM — técnicos em atendimento", () => {
  it("DASH-TEAM-01 · duas OS em atendimento contam UM técnico; ASSIGNED não põe ninguém em atendimento", async () => {
    const c = await cliente("Cliente Equipe");
    const t = await tecnico(fixture.techA.id, fixture.companyA.id);
    const outro = await prisma.user.create({
      data: {
        companyId: fixture.companyA.id,
        name: "Outro Técnico",
        email: "outro.tecnico@alfa.test",
        profile: AccessProfile.TECHNICIAN,
        passwordHash: "x",
      },
    });
    const t2 = await tecnico(outro.id, fixture.companyA.id);
    await os({ customerId: c.id, status: "IN_PROGRESS", technicianId: t.id });
    await os({ customerId: c.id, status: "IN_PROGRESS", technicianId: t.id });
    await os({ customerId: c.id, status: "ASSIGNED", technicianId: t2.id });

    const dados = ok((await painel()).team);
    expect(dados.emAtendimento).toBe(1);
    const lista = await listCompanyTechnicians(fixture.companyA.id, { inService: true });
    expect(lista.total).toBe(dados.emAtendimento);
    expect(lista.technicians.map((x) => x.id)).toEqual([t.id]);
  });

  it("DASH-TEAM-02 · OS de OUTRA empresa apontando o técnico da A não o põe em atendimento (vetor da DQ-7.1)", async () => {
    const tA = await tecnico(fixture.techA.id, fixture.companyA.id);
    const cB = await cliente("Cliente B", fixture.companyB.id);
    // O schema aceita: `ServiceOrder.technicianId` é FK simples, sem companyId.
    await os({
      customerId: cB.id,
      companyId: fixture.companyB.id,
      status: "IN_PROGRESS",
      technicianId: tA.id,
    });
    expect(ok((await painel()).team).emAtendimento).toBe(0);
    expect(ok((await painel(fixture.companyB.id)).team).emAtendimento).toBe(0);

    // Controle positivo: a OS da própria empresa põe.
    const cA = await cliente("Cliente A");
    await os({ customerId: cA.id, status: "IN_PROGRESS", technicianId: tA.id });
    expect(ok((await painel()).team).emAtendimento).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// DASH-CLI — clientes offline
// ---------------------------------------------------------------------------

describe("DASH-CLI — clientes offline pela autoridade da §370", () => {
  it("DASH-CLI-01 · offline é a última leitura OFFLINE de cliente ATIVO; sem leitura não é offline", async () => {
    const on = await cliente("Online");
    const off = await cliente("Offline");
    const unk = await cliente("Unknown");
    await cliente("Nunca lido");
    const inativo = await cliente("Inativo offline", undefined, false);
    await leitura(on.id, "ONLINE");
    await leitura(off.id, "OFFLINE");
    await leitura(unk.id, "UNKNOWN");
    await leitura(inativo.id, "OFFLINE");

    expect(ok((await painel()).customers)).toEqual({
      offline: 1,
      comLeitura: 2,
      ativos: 4,
    });
  });

  it("DASH-CLI-02 · entre providers, a leitura MAIS RECENTE vence — a mesma regra do lote do mapa", async () => {
    const voltou = await cliente("Voltou");
    const caiu = await cliente("Caiu");
    await leitura(voltou.id, "OFFLINE", { provider: "MOCK", observedAt: new Date(AGORA.getTime() - 5 * HORA) });
    await leitura(voltou.id, "ONLINE", { provider: "RECEITANET", observedAt: AGORA });
    await leitura(caiu.id, "ONLINE", { provider: "MOCK", observedAt: new Date(AGORA.getTime() - 5 * HORA) });
    await leitura(caiu.id, "OFFLINE", { provider: "RECEITANET", observedAt: AGORA });

    expect(ok((await painel()).customers).offline).toBe(1);

    // Paridade com a leitura em lote do mapa e da OS, cliente a cliente.
    const empresa = await getCompanyConnectivityStatuses(fixture.companyA.id);
    const lote = await getConnectivityForCustomers(fixture.companyA.id, [voltou.id, caiu.id]);
    for (const id of [voltou.id, caiu.id]) {
      expect(empresa.get(id)?.status).toBe(lote.get(id)?.connectivityStatus);
      // A idade exibida na listagem (DASH-1a) é a da MESMA leitura vencedora.
      expect(empresa.get(id)?.observedAt).toEqual(lote.get(id)?.observedAt);
    }
  });

  it("DASH-CLI-03 · o cartão É a listagem /clientes?active=true&conectividade=OFFLINE", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const c = await cliente(`Offline ${i}`);
      await leitura(c.id, "OFFLINE");
      ids.push(c.id);
    }
    const online = await cliente("Online");
    await leitura(online.id, "ONLINE");

    const dados = ok((await painel()).customers);
    const lista = await listCompanyCustomers(fixture.companyA.id, {
      active: true,
      connectivity: "OFFLINE",
      pageSize: 1,
    });
    expect(lista.total).toBe(dados.offline);
    const todas = await listCompanyCustomers(fixture.companyA.id, {
      active: true,
      connectivity: "OFFLINE",
      pageSize: 100,
    });
    expect(todas.customers.map((c) => c.id).sort()).toEqual([...ids].sort());
  });

  it("DASH-CLI-04 · empresa sem leitura nenhuma: comLeitura 0 — a tela diz 'sem leitura', não '0 offline'", async () => {
    await cliente("Nunca lido 1");
    await cliente("Nunca lido 2");
    expect(ok((await painel()).customers)).toEqual({ offline: 0, comLeitura: 0, ativos: 2 });
  });
});

// ---------------------------------------------------------------------------
// DASH-CTO — CTOs com defeito e com OS abertas
// ---------------------------------------------------------------------------

describe("DASH-CTO — o estado da caixa é o do mapa", () => {
  it("DASH-CTO-01 · defeito = estado DAMAGED; a inativa não conta; a sem coordenada conta", async () => {
    await caixa("CX DANIFICADA", { danificadas: [2] });
    await caixa("CX INATIVA DANIFICADA", { danificadas: [2], ativa: false });
    await caixa("CX SEM COORDENADA", { danificadas: [3], comCoordenada: false });
    await caixa("CX SAUDAVEL");

    expect(ok((await painel()).ctos).comDefeito).toBe(2);
  });

  it("DASH-CTO-02 · com OS abertas = o selo do marcador: OS abertas de clientes ATIVOS vinculados", async () => {
    const comOs = await cliente("Com OS aberta");
    const soConcluida = await cliente("Só concluída");
    const inativo = await cliente("Inativo com OS", undefined, false);
    await os({ customerId: comOs.id, status: "PENDING" });
    await os({ customerId: soConcluida.id, status: "COMPLETED" });
    await os({ customerId: inativo.id, status: "PENDING" });
    await caixa("CX COM OS", { clientes: [{ id: comOs.id, porta: 1 }] });
    await caixa("CX CONCLUIDA", { clientes: [{ id: soConcluida.id, porta: 1 }] });
    await caixa("CX INATIVO", { clientes: [{ id: inativo.id, porta: 1 }] });

    expect(ok((await painel()).ctos).comOsAbertas).toBe(1);
  });

  it("DASH-CTO-03 · paridade, caixa a caixa, com o marcador do Mapa Operacional", async () => {
    const c = await cliente("Cliente CX");
    await os({ customerId: c.id, status: "ASSIGNED" });
    await caixa("CX P1", { danificadas: [1], clientes: [{ id: c.id, porta: 2 }] });
    await caixa("CX P2", { ativa: false });
    const cheia = await caixa("CX P3");
    await prisma.cTO.update({ where: { id: cheia.id }, data: { capacity: 1 } });
    const vizinho = await cliente("Vizinho");
    const porta1 = await prisma.cTOPort.findFirstOrThrow({ where: { ctoId: cheia.id, number: 1 } });
    await prisma.customerNetworkConnection.create({
      data: { companyId: fixture.companyA.id, customerId: vizinho.id, ctoPortId: porta1.id, source: "WEB", connectedAt: AGORA },
    });

    const mapa = await getCtoMapView(fixture.companyA.id, {
      bbox: { north: -20.4, south: -20.6, east: -41.4, west: -41.6 },
    });
    const estados = await getCompanyCtoStates(fixture.companyA.id);
    expect(mapa.markers.length).toBe(3);
    for (const marcador of mapa.markers) {
      expect(estados.get(marcador.id), marcador.name).toEqual({
        status: marcador.status,
        openServiceOrderCount: marcador.operational.openServiceOrderCount,
        // DASH-1a: as portas danificadas que a listagem mostra são o `damaged`
        // do mesmo resumo que o marcador carrega.
        damagedPortCount: marcador.summary.damaged,
      });
    }
    expect(new Set(mapa.markers.map((m) => m.status))).toEqual(
      new Set(["DAMAGED", "INACTIVE", "FULL"]),
    );
  });

  it("DASH-CTO-04 · o cartão É a lista /ctos?situacao=…", async () => {
    const c = await cliente("Cliente Lista");
    await os({ customerId: c.id, status: "PENDING" });
    await caixa("CX L1", { danificadas: [1] });
    await caixa("CX L2", { danificadas: [1], clientes: [{ id: c.id, porta: 2 }] });
    await caixa("CX L3");

    const dados = ok((await painel()).ctos);
    const todas = await listCompanyCtos(fixture.companyA.id, { includeInactive: true });
    const estados = await getCompanyCtoStates(fixture.companyA.id);
    const filtrar = (f: "defeito" | "com-os-abertas") =>
      todas.filter((cto) => {
        const estado = estados.get(cto.id);
        return estado ? matchesCtoAttention(estado, f) : false;
      }).length;
    expect(filtrar("defeito")).toBe(dados.comDefeito);
    expect(filtrar("com-os-abertas")).toBe(dados.comOsAbertas);
    expect(dados).toEqual({ comDefeito: 2, comOsAbertas: 1 });
  });
});

// ---------------------------------------------------------------------------
// DASH-PERM — quem vê o quê
// ---------------------------------------------------------------------------

describe("DASH-PERM — o painel não amplia acesso", () => {
  it("DASH-PERM-01 · DISPATCHER: OS e equipe sim; clientes e CTOs nem são lidos", async () => {
    const espiaoSnapshot = vi.spyOn(prisma.customerDiagnosticSnapshot, "findMany");
    const espiaoCto = vi.spyOn(prisma.cTO, "findMany");
    const resultado = await getOperationalDashboard(
      { companyId: fixture.companyA.id, profile: AccessProfile.DISPATCHER },
      AGORA,
    );
    expect(resultado.serviceOrders.state).toBe("ok");
    expect(resultado.team.state).toBe("ok");
    expect(resultado.customers).toEqual({ state: "hidden" });
    expect(resultado.ctos).toEqual({ state: "hidden" });
    expect(espiaoSnapshot).not.toHaveBeenCalled();
    expect(espiaoCto).not.toHaveBeenCalled();
    espiaoSnapshot.mockRestore();
    espiaoCto.mockRestore();
  });

  it("DASH-PERM-02 · ADMIN com a capability de rede DESLIGADA: a seção de CTO não existe", async () => {
    await caixa("CX QUALQUER", { danificadas: [1] });
    await prisma.company.update({
      where: { id: fixture.companyA.id },
      data: { ctoNetworkEnabled: false },
    });
    const resultado = await painel();
    expect(resultado.ctos).toEqual({ state: "hidden" });
    expect(resultado.customers.state).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// DASH-TEN — tenancy
// ---------------------------------------------------------------------------

describe("DASH-TEN — nenhum número atravessa empresa", () => {
  it("DASH-TEN-01 · tudo na empresa B, nada na A: o painel da A é todo zero — e o da B vê o dela", async () => {
    const B = fixture.companyB.id;
    const tB = await tecnico(fixture.techB.id, B);
    const ontem = new Date(AGORA.getTime() - 20 * HORA);
    const cB = await cliente("Cliente da B", B);
    await leitura(cB.id, "OFFLINE", { companyId: B });
    await os({ customerId: cB.id, companyId: B, status: "PENDING", scheduledAt: ontem });
    await os({ customerId: cB.id, companyId: B, status: "IN_PROGRESS", technicianId: tB.id, scheduledAt: AGORA });
    await caixa("CX B", {
      companyId: B,
      autorId: fixture.adminB.id,
      danificadas: [1],
      clientes: [{ id: cB.id, porta: 2 }],
    });

    const a = await painel();
    expect(ok(a.serviceOrders)).toEqual({ abertas: 0, atrasadas: 0, hoje: 0, pendentes: 0 });
    expect(ok(a.team)).toEqual({ emAtendimento: 0 });
    expect(ok(a.customers)).toEqual({ offline: 0, comLeitura: 0, ativos: 0 });
    expect(ok(a.ctos)).toEqual({ comDefeito: 0, comOsAbertas: 0 });
    expect(ok(a.recentActivity).some((l) => l.entity === "CTO")).toBe(false);

    // Controle positivo: os mesmos dados SÃO contados na empresa dona.
    const b = await painel(B);
    expect(ok(b.serviceOrders)).toEqual({ abertas: 2, atrasadas: 1, hoje: 1, pendentes: 1 });
    expect(ok(b.team)).toEqual({ emAtendimento: 1 });
    expect(ok(b.customers)).toEqual({ offline: 1, comLeitura: 1, ativos: 1 });
    expect(ok(b.ctos)).toEqual({ comDefeito: 1, comOsAbertas: 1 });
  });
});

// ---------------------------------------------------------------------------
// DASH-ERR — zero é dado, erro é erro
// ---------------------------------------------------------------------------

describe("DASH-ERR — seção que falha nunca vira zero", () => {
  it("DASH-ERR-01 · empresa vazia: tudo ok e tudo zero — zero verdadeiro", async () => {
    const resultado = await painel();
    expect(resultado.serviceOrders).toEqual({
      state: "ok",
      data: { abertas: 0, atrasadas: 0, hoje: 0, pendentes: 0 },
    });
    expect(resultado.team).toEqual({ state: "ok", data: { emAtendimento: 0 } });
    expect(resultado.customers).toEqual({
      state: "ok",
      data: { offline: 0, comLeitura: 0, ativos: 0 },
    });
    expect(resultado.ctos).toEqual({ state: "ok", data: { comDefeito: 0, comOsAbertas: 0 } });
  });

  it("DASH-ERR-02 · a contagem de OS falha: a seção é ERRO, e as outras seguem de pé", async () => {
    const silencio = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const espiao = vi
      .spyOn(prisma.serviceOrder, "count")
      .mockRejectedValueOnce(new Error("banco fora"));
    const resultado = await painel();
    expect(resultado.serviceOrders).toEqual({ state: "error" });
    expect(resultado.team.state).toBe("ok");
    expect(resultado.customers.state).toBe("ok");
    espiao.mockRestore();
    silencio.mockRestore();
  });

  it("DASH-ERR-03 · a leitura de conectividade falha: clientes é ERRO, nunca '0 offline'", async () => {
    const silencio = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const c = await cliente("Offline de verdade");
    await leitura(c.id, "OFFLINE");
    const espiao = vi
      .spyOn(prisma.customerDiagnosticSnapshot, "findMany")
      .mockRejectedValue(new Error("banco fora"));
    const resultado = await painel();
    expect(resultado.customers).toEqual({ state: "error" });
    expect(resultado.serviceOrders.state).toBe("ok");
    espiao.mockRestore();
    silencio.mockRestore();
  });

  it("DASH-ERR-04 · a leitura da empresa falha: OS e CTOs são ERRO; equipe não depende dela", async () => {
    const silencio = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const espiao = vi
      .spyOn(prisma.company, "findUnique")
      .mockRejectedValueOnce(new Error("banco fora"));
    const resultado = await painel();
    expect(resultado.serviceOrders).toEqual({ state: "error" });
    expect(resultado.ctos).toEqual({ state: "error" });
    expect(resultado.team.state).toBe("ok");
    espiao.mockRestore();
    silencio.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// DASH-N1 — o número de consultas não cresce com os dados
// ---------------------------------------------------------------------------

describe("DASH-N1 — consultas constantes, nenhuma lista para contar", () => {
  it("DASH-N1-01 · 2 ou 14 de cada coisa: o mesmo número de consultas, e nenhum findMany de OS", async () => {
    const modelos = {
      osCount: vi.spyOn(prisma.serviceOrder, "count"),
      osFindMany: vi.spyOn(prisma.serviceOrder, "findMany"),
      osGroupBy: vi.spyOn(prisma.serviceOrder, "groupBy"),
      tecnicoCount: vi.spyOn(prisma.technician, "count"),
      clienteCount: vi.spyOn(prisma.customer, "count"),
      snapshots: vi.spyOn(prisma.customerDiagnosticSnapshot, "findMany"),
      ctos: vi.spyOn(prisma.cTO, "findMany"),
      portas: vi.spyOn(prisma.cTOPort, "findMany"),
      vinculos: vi.spyOn(prisma.customerNetworkConnection, "findMany"),
      empresa: vi.spyOn(prisma.company, "findUnique"),
      auditoria: vi.spyOn(prisma.auditLog, "findMany"),
    };
    const contar = () =>
      Object.fromEntries(
        Object.entries(modelos).map(([nome, espiao]) => [nome, espiao.mock.calls.length]),
      );
    const zerar = () => Object.values(modelos).forEach((e) => e.mockClear());

    const semear = async (quantos: number, prefixo: string) => {
      const t = await tecnico(fixture.techA.id, fixture.companyA.id);
      for (let i = 0; i < quantos; i++) {
        const c = await cliente(`${prefixo} ${i}`);
        await leitura(c.id, i % 2 ? "ONLINE" : "OFFLINE");
        await os({ customerId: c.id, status: i % 2 ? "PENDING" : "IN_PROGRESS", technicianId: i % 2 ? null : t.id });
        await caixa(`${prefixo} CX ${i}`, { danificadas: [1], clientes: [{ id: c.id, porta: 2 }] });
      }
    };

    await semear(2, "Pouco");
    zerar();
    await painel();
    const pouco = contar();

    await semear(12, "Muito");
    zerar();
    await painel();
    const muito = contar();

    expect(muito).toEqual(pouco);
    expect(pouco.osFindMany).toBe(0);
    expect(pouco.empresa).toBe(1);

    Object.values(modelos).forEach((e) => e.mockRestore());
  });
});

// ---------------------------------------------------------------------------
// DASH-STRUCT — o que o painel não faz
// ---------------------------------------------------------------------------

function fonteSemComentarios(relativo: string): string {
  return readFileSync(path.join(process.cwd(), relativo), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("DASH-STRUCT — escopo e fronteiras", () => {
  it("DASH-STRUCT-01 · nenhum módulo do painel fala com ERP ou provider", () => {
    for (const arquivo of [
      "src/lib/dashboard.ts",
      "src/lib/dashboard-cards.ts",
      "src/lib/cto-attention.ts",
      "src/lib/service-order-slices.ts",
      "src/app/(app)/dashboard/page.tsx",
    ]) {
      const fonte = fonteSemComentarios(arquivo);
      expect(fonte, arquivo).not.toMatch(
        /refreshCustomerDiagnostic|resolveCompanyAdapter|integrations\/|fetch\(/,
      );
    }
  });

  it("DASH-STRUCT-02 · a página desenha os cartões da função pura — não monta os seus", () => {
    const fonte = fonteSemComentarios("src/app/(app)/dashboard/page.tsx");
    expect(fonte).toMatch(/buildDashboardCards\(painel\)/);
    // Destino escrito na página seria um segundo lugar para divergir do contrato.
    expect(fonte).not.toMatch(/href:\s*"\/(ordens|tecnicos|clientes|ctos)/);
  });
});
