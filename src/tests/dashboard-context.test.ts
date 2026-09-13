import { describe, it, expect, beforeEach, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  AccessProfile,
  type ConnectivityStatus,
  type ERPProvider,
  type ServiceOrderStatus,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { createCto } from "@/lib/cto";
import { getCompanyCtoStates, matchesCtoAttention } from "@/lib/cto-attention";
import { listCompanyCustomers } from "@/lib/customers";
import { connectivityAge } from "@/lib/connectivity-presentation";
import {
  countCompanyServiceOrders,
  listCompanyServiceOrders,
} from "@/lib/service-orders";
import {
  SERVICE_ORDER_SLICES,
  TIME_DEPENDENT_SLICES,
  parseServiceOrderSlice,
  serviceOrderSliceWhere,
} from "@/lib/service-order-slices";
import { listCompanyTechnicians } from "@/lib/technicians";
import { getOperationalDashboard, type OperationalDashboard } from "@/lib/dashboard";
import { buildDashboardCards } from "@/lib/dashboard-cards";
import {
  DASHBOARD_SLICE_COPY,
  DASHBOARD_SLICE_KEYS,
  countWithNoun,
  sliceEmptyState,
} from "@/lib/dashboard-slice-copy";
import {
  AUDIT_ACTION_LABELS,
  AUDIT_ENTITY_LABELS,
  auditActionLabel,
  auditEntityLabel,
} from "@/lib/audit-presentation";
import {
  formatCompanyDateTime,
  formatCompanyTime,
} from "@/lib/company-datetime";
import { seedTestData, type TestFixture } from "./helpers";

/**
 * # DASH-1a — por que cada linha está no recorte
 *
 * A DASH-1 provou que o cartão É a listagem. Esta fase prova a outra metade:
 * que a listagem **explica** o recorte — e que a explicação vem da MESMA
 * leitura que decidiu quem entra, sem consulta por linha. "Não testar só
 * texto": cada contexto é conferido pelo VALOR (a contagem certa, a leitura
 * vencedora, o estado derivado), e a tela é conferida pelo navegador em
 * `e2e/dashboard.spec.ts`.
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

async function usuarioTecnico(nome: string, companyId?: string) {
  numero += 1;
  return prisma.user.create({
    data: {
      companyId: companyId ?? fixture.companyA.id,
      name: nome,
      email: `ctx.tec.${numero}.${Date.now()}@sintetico.local`,
      profile: AccessProfile.TECHNICIAN,
      passwordHash: "x",
    },
  });
}

async function tecnico(nome: string, opcoes: { ativo?: boolean; companyId?: string } = {}) {
  const companyId = opcoes.companyId ?? fixture.companyA.id;
  const user = await usuarioTecnico(nome, companyId);
  return prisma.technician.create({
    data: { companyId, userId: user.id, active: opcoes.ativo ?? true },
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
      number: 7000 + numero,
      customerId: opcoes.customerId,
      type: "INSTALACAO",
      description: "os do contexto",
      status: opcoes.status,
      scheduledAt: opcoes.scheduledAt ?? null,
      technicianId: opcoes.technicianId ?? null,
      ...(opcoes.status === "COMPLETED" ? { completedAt: AGORA } : {}),
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
    clientes?: { id: string; porta: number }[];
    danificadas?: number[];
    ativa?: boolean;
  } = {},
) {
  const companyId = fixture.companyA.id;
  const cto = await createCto(companyId, fixture.adminA.id, {
    name: nome,
    capacity: 8,
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

function fonte(relativo: string): string {
  return readFileSync(path.join(process.cwd(), relativo), "utf8");
}

/** O código sem comentários — uma frase que CITA `router.back()` não é uso. */
function codigo(relativo: string): string {
  return fonte(relativo)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

const PAGINAS_DE_DESTINO = [
  "src/app/(app)/ordens/page.tsx",
  "src/app/(app)/tecnicos/page.tsx",
  "src/app/(app)/clientes/page.tsx",
  "src/app/(app)/ctos/page.tsx",
];

// ---------------------------------------------------------------------------
// RETURN — a volta ao painel
// ---------------------------------------------------------------------------

describe("DASHCTX-RETURN — Voltar ao Dashboard", () => {
  it("DASHCTX-RETURN-02 · o destino é FIXO: um Link para /dashboard, e nunca o histórico do navegador", () => {
    const componente = codigo("src/components/BackToDashboardLink.tsx");
    expect(componente).toMatch(/<Link\s[^>]*href="\/dashboard"/);
    expect(componente).toContain('data-testid="back-to-dashboard"');
    expect(componente).toContain("Voltar ao Dashboard");
    // Link real, não um botão com clique: nada de roteador nem de histórico.
    for (const proibido of ["router.back", "history.back", "useRouter", "onClick", '"use client"']) {
      expect(componente, proibido).not.toContain(proibido);
    }
    for (const pagina of PAGINAS_DE_DESTINO) {
      const src = codigo(pagina);
      expect(src, pagina).toContain("<BackToDashboardLink />");
      expect(src, pagina).not.toMatch(/router\.back|history\.back/);
    }
  });

  it("DASHCTX-RETURN-01/03 · a volta só aparece com recorte VÁLIDO — condicionada ao mesmo valor que liga a faixa", () => {
    // Em cada página, o retorno e a faixa dependem da MESMA variável: a do
    // recorte já validado (`parse…`/perfil). Recorte inválido é `null` e não
    // liga nenhum dos dois; a listagem comum não mostra a volta.
    const condicoes: Record<string, string> = {
      "src/app/(app)/ordens/page.tsx": "slice",
      "src/app/(app)/tecnicos/page.tsx": "inService",
      "src/app/(app)/clientes/page.tsx": "offlineOnly",
      "src/app/(app)/ctos/page.tsx": "sliceKey",
    };
    for (const [pagina, variavel] of Object.entries(condicoes)) {
      const src = codigo(pagina);
      expect(src, pagina).toContain(`{${variavel} && <BackToDashboardLink />}`);
      expect(src, pagina).toMatch(new RegExp(`\\{${variavel} && \\(\\s*<ListSliceBanner`));
    }
    expect(parseServiceOrderSlice("todas")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SLICE — a faixa, consistente nos oito
// ---------------------------------------------------------------------------

function painelFalso(): OperationalDashboard {
  return {
    generatedAt: AGORA,
    timezone: TZ,
    serviceOrders: { state: "ok", data: { abertas: 2, atrasadas: 1, hoje: 0, pendentes: 2 } },
    team: { state: "ok", data: { emAtendimento: 1 } },
    customers: { state: "ok", data: { offline: 1, comLeitura: 8, ativos: 9 } },
    ctos: { state: "ok", data: { comDefeito: 0, comOsAbertas: 1 } },
    recentActivity: { state: "ok", data: [] },
  };
}

describe("DASHCTX-SLICE — um nome, um singular, um plural por recorte", () => {
  it("DASHCTX-SLICE-01 · os oito cartões e as oito faixas leem a MESMA linha de texto", () => {
    const g = buildDashboardCards(painelFalso());
    const cartoes = [...g.serviceOrders, ...g.teamAndNetwork];
    expect(cartoes.map((c) => c.key).sort()).toEqual([...DASHBOARD_SLICE_KEYS].sort());
    for (const cartao of cartoes) {
      expect(cartao.label, cartao.key).toBe(DASHBOARD_SLICE_COPY[cartao.key].label);
    }
    // A faixa não tem texto próprio: ela recebe a chave e lê a mesma tabela.
    const faixa = codigo("src/components/ListSliceBanner.tsx");
    expect(faixa).toContain("DASHBOARD_SLICE_COPY[sliceKey]");
    expect(faixa).toContain("Recorte do painel:");
    expect(faixa).toContain("Limpar recorte");
    for (const pagina of PAGINAS_DE_DESTINO) {
      expect(codigo(pagina), pagina).not.toMatch(/<ListSliceBanner[^>]*\blabel=/);
    }
  });

  it("DASHCTX-SLICE-01b · singular e plural: 1 OS, 2 OS, 1 CTO, 2 CTOs, 1 técnico, 2 técnicos, 1 cliente, 2 clientes", () => {
    const c = DASHBOARD_SLICE_COPY;
    expect([0, 1, 2].map((n) => countWithNoun(n, c.pendentes))).toEqual(["0 OS", "1 OS", "2 OS"]);
    expect([1, 2].map((n) => countWithNoun(n, c["ctos-com-defeito"]))).toEqual(["1 CTO", "2 CTOs"]);
    expect([1, 2].map((n) => countWithNoun(n, c["tecnicos-em-atendimento"]))).toEqual([
      "1 técnico",
      "2 técnicos",
    ]);
    expect([1, 2].map((n) => countWithNoun(n, c["clientes-offline"]))).toEqual([
      "1 cliente",
      "2 clientes",
    ]);
    // "0 clientes", nunca "0 cliente": o singular é SÓ para exatamente 1.
    expect(countWithNoun(0, c["clientes-offline"])).toBe("0 clientes");
  });

  it("DASHCTX-SLICE-02 · OS pendentes é um recorte próprio, com o predicado PENDING e o relógio dispensado", async () => {
    expect(SERVICE_ORDER_SLICES).toContain("pendentes");
    expect(parseServiceOrderSlice("pendentes")).toBe("pendentes");
    expect(TIME_DEPENDENT_SLICES.has("pendentes")).toBe(false);
    expect(serviceOrderSliceWhere("pendentes", RELOGIO)).toEqual({ status: { in: ["PENDING"] } });
    expect(buildDashboardCards(painelFalso()).serviceOrders.find((c) => c.key === "pendentes")?.href).toBe(
      "/ordens?recorte=pendentes",
    );

    const c = await cliente("Cliente Pendente");
    const t = await tecnico("Técnico Pendente");
    await os({ customerId: c.id, status: "PENDING" });
    await os({ customerId: c.id, status: "PENDING", scheduledAt: new Date(AGORA.getTime() - 30 * 24 * HORA) });
    await os({ customerId: c.id, status: "ASSIGNED", technicianId: t.id });
    await os({ customerId: c.id, status: "COMPLETED", technicianId: t.id });

    const porRecorte = await listCompanyServiceOrders(fixture.companyA.id, { slice: "pendentes" });
    const porFiltro = await listCompanyServiceOrders(fixture.companyA.id, { status: "PENDING" });
    expect(porRecorte.total).toBe(2);
    expect(porRecorte.serviceOrders.map((o) => o.id).sort()).toEqual(
      porFiltro.serviceOrders.map((o) => o.id).sort(),
    );
    const dash = await getOperationalDashboard(
      { companyId: fixture.companyA.id, profile: AccessProfile.ADMIN },
      AGORA,
    );
    expect(dash.serviceOrders.state === "ok" && dash.serviceOrders.data.pendentes).toBe(2);
  });

  it("DASHCTX-SLICE-03 · a quantidade da faixa é o total da listagem — não o tamanho da página", async () => {
    const c = await cliente("Cliente Muitas");
    for (let i = 0; i < 25; i++) await os({ customerId: c.id, status: "PENDING" });
    const pagina = await listCompanyServiceOrders(fixture.companyA.id, {
      slice: "pendentes",
      pageSize: 20,
    });
    expect(pagina.serviceOrders).toHaveLength(20);
    expect(pagina.total).toBe(25);
    expect(await countCompanyServiceOrders(fixture.companyA.id, { slice: "pendentes" })).toBe(25);
    // A página passa o TOTAL à faixa.
    expect(codigo("src/app/(app)/ordens/page.tsx")).toMatch(
      /<ListSliceBanner\s+sliceKey=\{slice\}\s+total=\{result\.total\}/,
    );
  });
});

// ---------------------------------------------------------------------------
// CLIENT — conectividade na linha, da mesma leitura
// ---------------------------------------------------------------------------

describe("DASHCTX-CLIENT — Clientes offline", () => {
  it("DASHCTX-CLIENT-01 · cada linha do recorte traz a leitura que a pôs ali: OFFLINE", async () => {
    const offline = await cliente("Cliente Fora");
    const online = await cliente("Cliente No Ar");
    await cliente("Cliente Nunca Lido");
    await leitura(offline.id, "OFFLINE");
    await leitura(online.id, "ONLINE");

    const lista = await listCompanyCustomers(fixture.companyA.id, {
      active: true,
      connectivity: "OFFLINE",
    });
    expect(lista.customers.map((c) => c.id)).toEqual([offline.id]);
    expect(lista.connectivity).toEqual({
      [offline.id]: { status: "OFFLINE", observedAt: AGORA },
    });

    // Sem o recorte, a listagem não carrega conectividade — nem a da página.
    const comum = await listCompanyCustomers(fixture.companyA.id, { active: true });
    expect(comum.connectivity).toBeUndefined();
  });

  it("DASHCTX-CLIENT-02 · status cadastral e conectividade são campos diferentes, e os dois chegam", async () => {
    const inativo = await cliente("Inativo Fora", undefined, false);
    const ativo = await cliente("Ativo Fora");
    await leitura(inativo.id, "OFFLINE");
    await leitura(ativo.id, "OFFLINE");

    // Sem `active`: os dois estão offline, e só um está ativo.
    const lista = await listCompanyCustomers(fixture.companyA.id, { connectivity: "OFFLINE" });
    const porId = Object.fromEntries(lista.customers.map((c) => [c.id, c.active]));
    expect(porId).toEqual({ [inativo.id]: false, [ativo.id]: true });
    expect(lista.connectivity?.[inativo.id]?.status).toBe("OFFLINE");
    expect(lista.connectivity?.[ativo.id]?.status).toBe("OFFLINE");

    // A tela mostra as duas coisas com nomes próprios.
    const pagina = codigo("src/app/(app)/clientes/page.tsx");
    expect(pagina).toContain('"Status cadastral"');
    expect(pagina).toContain(">Conectividade<");
    expect(pagina).toMatch(/customer\.active \? \(/);
  });

  it("DASHCTX-CLIENT-03 · sem N+1: 2 ou 14 clientes offline, UMA leitura de snapshots e nenhuma por linha", async () => {
    const snapshotsFindMany = vi.spyOn(prisma.customerDiagnosticSnapshot, "findMany");
    const snapshotsFindFirst = vi.spyOn(prisma.customerDiagnosticSnapshot, "findFirst");
    const snapshotsFindUnique = vi.spyOn(prisma.customerDiagnosticSnapshot, "findUnique");
    const semear = async (quantos: number, prefixo: string) => {
      for (let i = 0; i < quantos; i++) {
        const c = await cliente(`${prefixo} ${i}`);
        await leitura(c.id, "OFFLINE");
      }
    };
    const medir = async () => {
      snapshotsFindMany.mockClear();
      snapshotsFindFirst.mockClear();
      snapshotsFindUnique.mockClear();
      await listCompanyCustomers(fixture.companyA.id, {
        active: true,
        connectivity: "OFFLINE",
        pageSize: 100,
      });
      return [
        snapshotsFindMany.mock.calls.length,
        snapshotsFindFirst.mock.calls.length,
        snapshotsFindUnique.mock.calls.length,
      ];
    };

    await semear(2, "Pouco");
    const pouco = await medir();
    await semear(12, "Muito");
    const muito = await medir();

    expect(pouco).toEqual([1, 0, 0]);
    expect(muito).toEqual(pouco);
    [snapshotsFindMany, snapshotsFindFirst, snapshotsFindUnique].forEach((s) => s.mockRestore());
  });

  it("DASHCTX-CLIENT-04 · a idade exibida é a da leitura VENCEDORA — a mais recente entre providers", async () => {
    const c = await cliente("Troca de ERP");
    await leitura(c.id, "ONLINE", { provider: "MOCK", observedAt: new Date(AGORA.getTime() - 9 * HORA) });
    await leitura(c.id, "OFFLINE", { provider: "RECEITANET", observedAt: new Date(AGORA.getTime() - 3 * HORA) });

    const lista = await listCompanyCustomers(fixture.companyA.id, {
      active: true,
      connectivity: "OFFLINE",
    });
    const conectividade = lista.connectivity?.[c.id];
    expect(conectividade).toEqual({
      status: "OFFLINE",
      observedAt: new Date(AGORA.getTime() - 3 * HORA),
    });
    expect(connectivityAge(conectividade!.observedAt.toISOString(), AGORA)).toBe("há 3 h");
  });

  it("DASHCTX-CLIENT-05 · a linha só carrega a conectividade dos clientes DA PÁGINA — o mapa da empresa não sai", async () => {
    for (let i = 0; i < 5; i++) {
      const c = await cliente(`Paginado ${i}`);
      await leitura(c.id, "OFFLINE");
    }
    const primeira = await listCompanyCustomers(fixture.companyA.id, {
      active: true,
      connectivity: "OFFLINE",
      pageSize: 2,
    });
    expect(primeira.total).toBe(5);
    expect(Object.keys(primeira.connectivity ?? {}).sort()).toEqual(
      primeira.customers.map((c) => c.id).sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// OS — o agendamento, no fuso da empresa
// ---------------------------------------------------------------------------

describe("DASHCTX-OS — Agendada para", () => {
  it("DASHCTX-OS-03 · a hora é a do fuso da EMPRESA, qualquer que seja o do processo", () => {
    const instante = new Date("2026-09-12T02:30:00.000Z");
    // São Paulo: ainda é 11/09, 23:30. Tóquio: 12/09, 11:30. Manaus: 11/09, 22:30.
    expect(formatCompanyDateTime(instante, "America/Sao_Paulo")).toBe("11/09/2026, 23:30");
    expect(formatCompanyDateTime(instante, "Asia/Tokyo")).toBe("12/09/2026, 11:30");
    expect(formatCompanyDateTime(instante, "America/Manaus")).toBe("11/09/2026, 22:30");
    expect(formatCompanyTime(instante, "Asia/Tokyo")).toBe("11:30");
  });

  it("DASHCTX-OS-01/04 · atrasadas e de hoje dependem do relógio; a página lê o relógio da empresa e o usa na coluna", () => {
    expect(Array.from(TIME_DEPENDENT_SLICES).sort()).toEqual(["atrasadas", "hoje"]);
    const pagina = codigo("src/app/(app)/ordens/page.tsx");
    // O MESMO relógio filtra e formata: um só `companySliceClock`, passado à
    // listagem e usado na célula.
    expect(pagina.match(/companySliceClock\(/g)).toHaveLength(1);
    expect(pagina).toContain("clock: clock ?? undefined");
    expect(pagina).toContain('"Agendada para"');
    expect(pagina).toContain("formatCompanyDateTime(order.scheduledAt, clock.timezone)");
  });

  it("DASHCTX-OS-02 · sem relógio (abertas, pendentes, lista comum), a coluna continua sendo 'Criada em'", () => {
    const pagina = codigo("src/app/(app)/ordens/page.tsx");
    expect(pagina).toMatch(/showScheduledAt \? "Agendada para" : "Criada em"/);
    expect(pagina).toContain("formatDate(order.createdAt)");
  });
});

// ---------------------------------------------------------------------------
// EMPTY — o vazio do recorte
// ---------------------------------------------------------------------------

describe("DASHCTX-EMPTY — estado vazio por recorte", () => {
  it("DASHCTX-EMPTY-01 · OS de hoje vazia diz que não há OS agendada para hoje", () => {
    expect(sliceEmptyState("hoje", false)).toEqual({
      title: "Nenhuma OS agendada para hoje",
      description: "Não há ordens abertas agendadas para o dia de hoje.",
    });
  });

  it("DASHCTX-EMPTY-02 · recorte vazio não sugere ação irrelevante — e com filtros não afirma o que não sabe", () => {
    for (const key of DASHBOARD_SLICE_KEYS) {
      const vazio = sliceEmptyState(key, false);
      const texto = `${vazio.title} ${vazio.description}`;
      expect(vazio.title, key).toMatch(/^Nenhum/);
      for (const proibido of [/mock/i, /sincroniz/i, /\bcrie\b/i, /cadastre/i, /importe/i, /erro/i]) {
        expect(texto, `${key}: ${proibido}`).not.toMatch(proibido);
      }
    }
    // Com filtros somados, o vazio é da COMBINAÇÃO: "Nenhuma OS agendada para
    // hoje" seria falso se foi a busca que tirou as OS de hoje da tela.
    const comFiltro = sliceEmptyState("hoje", true);
    expect(comFiltro.title).toBe("Nenhum resultado com estes filtros");
    expect(comFiltro.description).toContain("OS de hoje");
  });
});

// ---------------------------------------------------------------------------
// TECH — quantas OS em atendimento
// ---------------------------------------------------------------------------

describe("DASHCTX-TECH — Técnicos em atendimento", () => {
  it("DASHCTX-TECH-01 · cada técnico do recorte traz a sua contagem de OS IN_PROGRESS — só IN_PROGRESS", async () => {
    const c = await cliente("Cliente Técnico");
    const um = await tecnico("Um");
    const dois = await tecnico("Dois");
    await tecnico("Parado");
    await os({ customerId: c.id, status: "IN_PROGRESS", technicianId: um.id });
    await os({ customerId: c.id, status: "ASSIGNED", technicianId: um.id }); // não conta
    await os({ customerId: c.id, status: "COMPLETED", technicianId: um.id }); // não conta
    await os({ customerId: c.id, status: "IN_PROGRESS", technicianId: dois.id });
    await os({ customerId: c.id, status: "IN_PROGRESS", technicianId: dois.id });

    const lista = await listCompanyTechnicians(fixture.companyA.id, { inService: true });
    expect(lista.inServiceCounts).toEqual({ [um.id]: 1, [dois.id]: 2 });
    expect(lista.technicians.map((t) => t.id).sort()).toEqual([um.id, dois.id].sort());

    // Sem o recorte, nada de contagem.
    const comum = await listCompanyTechnicians(fixture.companyA.id, {});
    expect(comum.inServiceCounts).toBeUndefined();
  });

  it("DASHCTX-TECH-02 · duas OS em atendimento: o técnico aparece UMA vez, com 2", async () => {
    const c = await cliente("Cliente Duplo");
    const t = await tecnico("Duplo");
    await os({ customerId: c.id, status: "IN_PROGRESS", technicianId: t.id });
    await os({ customerId: c.id, status: "IN_PROGRESS", technicianId: t.id });

    const lista = await listCompanyTechnicians(fixture.companyA.id, { inService: true });
    expect(lista.total).toBe(1);
    expect(lista.technicians).toHaveLength(1);
    expect(lista.inServiceCounts?.[t.id]).toBe(2);
  });

  it("DASHCTX-TECH-03 · técnico INATIVO com OS em atendimento continua no recorte, com o status cadastral separado", async () => {
    const c = await cliente("Cliente Inativo");
    const inativo = await tecnico("Desligado", { ativo: false });
    await os({ customerId: c.id, status: "IN_PROGRESS", technicianId: inativo.id });

    const lista = await listCompanyTechnicians(fixture.companyA.id, { inService: true });
    expect(lista.technicians).toHaveLength(1);
    expect(lista.technicians[0]).toMatchObject({ id: inativo.id, active: false });
    expect(lista.inServiceCounts?.[inativo.id]).toBe(1);
  });

  it("DASHCTX-TECH-04 · sem N+1: 2 ou 12 técnicos, UM groupBy e nenhum count por técnico", async () => {
    const groupBy = vi.spyOn(prisma.serviceOrder, "groupBy");
    const count = vi.spyOn(prisma.serviceOrder, "count");
    const findMany = vi.spyOn(prisma.serviceOrder, "findMany");
    const c = await cliente("Cliente N1");
    const semear = async (quantos: number, prefixo: string) => {
      for (let i = 0; i < quantos; i++) {
        const t = await tecnico(`${prefixo} ${i}`);
        await os({ customerId: c.id, status: "IN_PROGRESS", technicianId: t.id });
      }
    };
    const medir = async () => {
      [groupBy, count, findMany].forEach((s) => s.mockClear());
      const lista = await listCompanyTechnicians(fixture.companyA.id, {
        inService: true,
        pageSize: 100,
      });
      return {
        linhas: lista.technicians.length,
        consultas: [groupBy.mock.calls.length, count.mock.calls.length, findMany.mock.calls.length],
      };
    };

    await semear(2, "Pouco");
    const pouco = await medir();
    await semear(10, "Muito");
    const muito = await medir();

    expect(pouco.linhas).toBe(2);
    expect(muito.linhas).toBe(12);
    expect(pouco.consultas).toEqual([1, 0, 0]);
    expect(muito.consultas).toEqual(pouco.consultas);
    [groupBy, count, findMany].forEach((s) => s.mockRestore());
  });

  it("DASHCTX-TECH-05 · a contagem é da empresa: OS de outro tenant apontando o técnico não entra", async () => {
    const c = await cliente("Cliente A");
    const cB = await cliente("Cliente B", fixture.companyB.id);
    const t = await tecnico("Cruzado");
    await os({ customerId: c.id, status: "IN_PROGRESS", technicianId: t.id });
    // O vetor da DQ-7.1: `ServiceOrder.technicianId` é FK simples.
    await os({ customerId: cB.id, status: "IN_PROGRESS", technicianId: t.id, companyId: fixture.companyB.id });

    const lista = await listCompanyTechnicians(fixture.companyA.id, { inService: true });
    expect(lista.inServiceCounts?.[t.id]).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// CTO — o estado operacional e as contagens
// ---------------------------------------------------------------------------

describe("DASHCTX-CTO — CTOs com defeito e com OS abertas", () => {
  it("DASHCTX-CTO-01 · CTO com OS abertas traz a quantidade — o número do selo do mapa", async () => {
    const um = await cliente("Um");
    const dois = await cliente("Dois");
    await os({ customerId: um.id, status: "PENDING" });
    await os({ customerId: um.id, status: "PENDING" });
    await os({ customerId: dois.id, status: "PENDING" });
    await os({ customerId: dois.id, status: "COMPLETED" }); // fechada: não conta
    const cx = await caixa("CX Duas", { clientes: [{ id: um.id, porta: 1 }, { id: dois.id, porta: 2 }] });
    const vazia = await caixa("CX Sem OS");

    const estados = await getCompanyCtoStates(fixture.companyA.id);
    expect(estados.get(cx.id)?.openServiceOrderCount).toBe(3);
    expect(matchesCtoAttention(estados.get(cx.id)!, "com-os-abertas")).toBe(true);
    expect(estados.get(vazia.id)?.openServiceOrderCount).toBe(0);
  });

  it("DASHCTX-CTO-02 · sem N+1: 2 ou 12 caixas, o mesmo número de consultas", async () => {
    const espioes = {
      ctos: vi.spyOn(prisma.cTO, "findMany"),
      portas: vi.spyOn(prisma.cTOPort, "findMany"),
      vinculos: vi.spyOn(prisma.customerNetworkConnection, "findMany"),
      osGroupBy: vi.spyOn(prisma.serviceOrder, "groupBy"),
      osCount: vi.spyOn(prisma.serviceOrder, "count"),
    };
    const medir = async () => {
      Object.values(espioes).forEach((s) => s.mockClear());
      await getCompanyCtoStates(fixture.companyA.id);
      return Object.fromEntries(Object.entries(espioes).map(([k, s]) => [k, s.mock.calls.length]));
    };
    const semear = async (quantas: number, prefixo: string) => {
      for (let i = 0; i < quantas; i++) {
        const c = await cliente(`${prefixo} ${i}`);
        await os({ customerId: c.id, status: "PENDING" });
        await caixa(`${prefixo} CX ${i}`, { danificadas: [3], clientes: [{ id: c.id, porta: 1 }] });
      }
    };
    await semear(2, "Pouco");
    const pouco = await medir();
    await semear(10, "Muito");
    const muito = await medir();
    expect(muito).toEqual(pouco);
    expect(pouco.osCount).toBe(0);
    Object.values(espioes).forEach((s) => s.mockRestore());
  });

  it("DASHCTX-CTO-03 · defeito traz o estado DAMAGED e as portas danificadas — só as da capacidade", async () => {
    const cx = await caixa("CX Quebrada", { danificadas: [1, 4] });
    const estados = await getCompanyCtoStates(fixture.companyA.id);
    expect(estados.get(cx.id)).toMatchObject({ status: "DAMAGED", damagedPortCount: 2 });

    // Porta histórica (acima da capacidade) danificada não conta, como no mapa.
    await prisma.cTOPort.updateMany({ where: { ctoId: cx.id, number: 8 }, data: { administrativeState: "DAMAGED" } });
    await prisma.cTO.update({ where: { id: cx.id }, data: { capacity: 6 } });
    const depois = await getCompanyCtoStates(fixture.companyA.id);
    expect(depois.get(cx.id)?.damagedPortCount).toBe(2);
  });

  it("DASHCTX-CTO-04 · caixa INATIVA com porta danificada é INACTIVE — não vira DAMAGED nem entra no recorte", async () => {
    const cx = await caixa("CX Desligada", { danificadas: [2], ativa: false });
    const estados = await getCompanyCtoStates(fixture.companyA.id);
    expect(estados.get(cx.id)?.status).toBe("INACTIVE");
    expect(matchesCtoAttention(estados.get(cx.id)!, "defeito")).toBe(false);
  });

  it("DASHCTX-CTO-05 · com recorte, o resultado vem ANTES do formulário; sem recorte, o cadastro continua primeiro", () => {
    const gerente = codigo("src/app/(app)/ctos/CtoListManager.tsx");
    const bloco = gerente.slice(gerente.indexOf("{slice ? ("));
    const comRecorte = bloco.slice(0, bloco.indexOf(") : ("));
    const semRecorte = bloco.slice(bloco.indexOf(") : ("));
    expect(comRecorte.indexOf("{results}")).toBeGreaterThan(-1);
    expect(comRecorte.indexOf("{results}")).toBeLessThan(comRecorte.indexOf("{createForm}"));
    expect(semRecorte.indexOf("{createForm}")).toBeLessThan(semRecorte.indexOf("{results}"));
  });
});

// ---------------------------------------------------------------------------
// AUDIT — a atividade recente em linguagem de gente
// ---------------------------------------------------------------------------

/**
 * Todo código de ação que o código de produção grava — literal, ternário ou
 * montado de um enum. Lido do FONTE, para que um código novo sem rótulo
 * derrube o teste em vez de aparecer cru na tela sem ninguém perceber.
 */
function codigosDeAuditoriaGravados(): Set<string> {
  const raiz = path.join(process.cwd(), "src");
  const arquivos: string[] = [];
  const andar = (dir: string) => {
    for (const nome of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, nome.name);
      if (nome.isDirectory()) {
        if (nome.name !== "tests") andar(p);
      } else if (/\.(ts|tsx)$/.test(nome.name)) {
        arquivos.push(p);
      }
    }
  };
  andar(raiz);

  const codigos = new Set<string>();
  for (const arquivo of arquivos) {
    const src = readFileSync(arquivo, "utf8");
    if (!/logAudit|logAuditWithin|auditLog\.create/.test(src)) continue;
    // Código com ponto — `DOMINIO.EVENTO` —, em qualquer linha: um ternário
    // quebrado em várias linhas deixa o segundo código longe da palavra
    // `action`, e é justamente ele que um extrator por linha perderia.
    for (const m of Array.from(src.matchAll(/"([A-Z][A-Z_]*\.[A-Z][A-Z_]*)"/g))) {
      codigos.add(m[1]);
    }
    // Código sem ponto (`PPPOE_CREDENTIAL_VIEWED`) só onde há `action`: sem o
    // ponto, uma constante qualquer em maiúsculas passaria por código.
    for (const linha of src.split("\n")) {
      if (!/\baction\b/.test(linha)) continue;
      for (const m of Array.from(linha.matchAll(/"([A-Z]+_[A-Z_]+)"/g))) codigos.add(m[1]);
    }
  }
  // Montados de enum: `CTO_CONNECTION.${action}` e `INVENTORY.${type}`.
  for (const acao of ["CONNECTED", "DISCONNECTED", "MOVED"]) codigos.add(`CTO_CONNECTION.${acao}`);
  const enumMov = fonte("prisma/schema.prisma").match(/enum InventoryMovementType \{([\s\S]*?)\}/)![1];
  for (const valor of enumMov.match(/^\s*([A-Z_]+)\s*$/gm) ?? []) codigos.add(`INVENTORY.${valor.trim()}`);
  return codigos;
}

describe("DASHCTX-AUDIT — Atividade recente humanizada", () => {
  it("DASHCTX-AUDIT-01 · AUTH.LOGIN vira 'Login realizado'", () => {
    expect(auditActionLabel("AUTH.LOGIN")).toBe("Login realizado");
    expect(auditActionLabel("SERVICE_ORDER.CREATED")).toBe("OS criada");
  });

  it("DASHCTX-AUDIT-02 · o registro 'User' aparece como 'Usuário' — e nenhum rótulo é o código em inglês", () => {
    expect(auditEntityLabel("User")).toBe("Usuário");
    for (const [codigoEntidade, rotulo] of Object.entries(AUDIT_ENTITY_LABELS)) {
      expect(rotulo, codigoEntidade).not.toMatch(/^(User|Customer|Technician|ServiceOrder)\b/);
    }
    // A página traduz as duas coisas; o código cru só vai no `title`.
    const pagina = codigo("src/app/(app)/dashboard/page.tsx");
    expect(pagina).toContain("{auditActionLabel(item.action)}");
    expect(pagina).toContain("auditEntityLabel(item.entity)");
    expect(pagina).not.toMatch(/>\s*\{item\.action\}\s*</);
    expect(pagina).not.toMatch(/\{item\.entity\}/);
  });

  it("DASHCTX-AUDIT-03 · código desconhecido volta como está — nunca some, nunca vira texto inventado", () => {
    expect(auditActionLabel("DASH1A.EVENTO_NOVO")).toBe("DASH1A.EVENTO_NOVO");
    expect(auditEntityLabel("EntidadeNova")).toBe("EntidadeNova");
    // Chave do protótipo não é rótulo.
    expect(auditActionLabel("constructor")).toBe("constructor");
    expect(auditActionLabel("toString")).toBe("toString");
  });

  it("DASHCTX-AUDIT-04 · todo código de auditoria gravado em produção tem rótulo — e nenhum rótulo é de código que não existe", () => {
    const gravados = codigosDeAuditoriaGravados();
    // Sanidade do extrator: os óbvios estão lá.
    for (const esperado of ["AUTH.LOGIN", "CTO.ACTIVATED", "ERP.ENABLED", "TIME_ADJUSTMENT.REJECTED", "ERP_CREDENTIAL_REPLACED", "INVENTORY.ADJUSTMENT_OUT"]) {
      expect(gravados.has(esperado), esperado).toBe(true);
    }
    const semRotulo = Array.from(gravados).filter((c) => !(c in AUDIT_ACTION_LABELS));
    expect(semRotulo).toEqual([]);

    // Só o legado documentado pode ter rótulo sem ser gravado hoje.
    const legado = new Set(["ERP_CREDENTIAL_INVALIDATED"]);
    const orfaos = Object.keys(AUDIT_ACTION_LABELS).filter((c) => !gravados.has(c) && !legado.has(c));
    expect(orfaos).toEqual([]);
  });
});
