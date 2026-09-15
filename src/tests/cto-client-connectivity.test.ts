import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { createCto } from "@/lib/cto";
import { getCtoClientConnectivity } from "@/lib/cto-client-connectivity";
import { getCtoMapView } from "@/lib/cto-map";
import {
  CTO_PORT_FILTERS,
  CTO_PORT_FILTER_LABELS,
  countPortFilters,
  portMatchesFilter,
} from "@/lib/cto-port-filters";
import { getOperationalCtoDetail } from "@/lib/cto-read-model";
import { connectivityAge } from "@/lib/connectivity-presentation";
import { seedTestData, type TestFixture } from "./helpers";

/**
 * # RC-1D — os clientes da CTO, na tela da caixa (só leitura)
 *
 * A tela da CTO passou a responder "quais clientes desta caixa estão online,
 * offline ou sem leitura, e quantas OS abertas eles têm". O que este arquivo
 * prova é o que ela NÃO pode fazer:
 *
 * - criar uma segunda autoridade — o resumo é o MESMO do popup do mapa, e os
 *   filtros contam o mesmo conjunto que o resumo;
 * - chamar provider — abrir a caixa é leitura de banco, sem `fetch` nenhum;
 * - consultar por cliente — as consultas são constantes;
 * - misturar empresas — snapshot e OS de outro tenant não contam;
 * - escrever — nada muda no banco por abrir a tela.
 */

let fixture: TestFixture;
let contador = 0;

const BASE = { lat: -20.6, lng: -41.6 };
const BBOX = {
  north: BASE.lat + 0.05,
  south: BASE.lat - 0.05,
  east: BASE.lng + 0.05,
  west: BASE.lng - 0.05,
};

beforeEach(async () => {
  fixture = await seedTestData();
  contador = 0;
  for (const id of [fixture.companyA.id, fixture.companyB.id]) {
    await prisma.company.update({
      where: { id },
      data: { ctoNetworkEnabled: true },
    });
  }
});

async function criarCliente(
  nome: string,
  opcoes: { companyId?: string; ativo?: boolean } = {},
) {
  return prisma.customer.create({
    data: {
      companyId: opcoes.companyId ?? fixture.companyA.id,
      name: nome,
      active: opcoes.ativo ?? true,
    },
  });
}

async function gravarLeitura(
  customerId: string,
  status: "ONLINE" | "OFFLINE" | "UNKNOWN",
  observedAt: Date,
  companyId = fixture.companyA.id,
) {
  return prisma.customerDiagnosticSnapshot.create({
    data: {
      companyId,
      customerId,
      externalProvider: "MOCK",
      connectivityStatus: status,
      observedAt,
    },
  });
}

async function criarOs(
  customerId: string,
  status: "PENDING" | "ASSIGNED" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED",
  companyId = fixture.companyA.id,
) {
  contador += 1;
  return prisma.serviceOrder.create({
    data: {
      companyId,
      number: 8100 + contador,
      customerId,
      type: "INSTALACAO",
      description: "os de teste",
      status,
      ...(status === "COMPLETED" ? { completedAt: new Date() } : {}),
    },
  });
}

async function criarCaixa(
  nome: string,
  clientes: { id: string; porta: number }[],
  companyId = fixture.companyA.id,
  capacidade = 8,
) {
  const autor = companyId === fixture.companyA.id ? fixture.adminA.id : fixture.adminB.id;
  const cto = await createCto(companyId, autor, {
    name: nome,
    capacity: capacidade,
    latitude: BASE.lat,
    longitude: BASE.lng,
  });
  for (const vinculo of clientes) {
    const porta = await prisma.cTOPort.findFirstOrThrow({
      where: { ctoId: cto.id, number: vinculo.porta },
    });
    await prisma.customerNetworkConnection.create({
      data: {
        companyId,
        customerId: vinculo.id,
        ctoPortId: porta.id,
        source: "WEB",
        connectedAt: new Date(),
      },
    });
  }
  return cto;
}

const MIN = 60_000;

/**
 * A caixa do roteiro do dono (`CTO QA RC1D`), com os casos que a tela precisa
 * distinguir — e dois que ela precisa NÃO confundir: o cliente INATIVO que ainda
 * ocupa a porta, e a OS encerrada.
 */
async function caixaDoRoteiro() {
  const agora = Date.now();
  const online = await criarCliente("RC1D ONLINE");
  const offline = await criarCliente("RC1D OFFLINE");
  const semSnapshot = await criarCliente("RC1D SEM SNAPSHOT");
  const onlineComOs = await criarCliente("RC1D ONLINE COM OS");
  const offlineCom2Os = await criarCliente("RC1D OFFLINE COM 2 OS");
  const unknownLido = await criarCliente("RC1D UNKNOWN LIDO");
  const inativo = await criarCliente("RC1D INATIVO", { ativo: false });

  await gravarLeitura(online.id, "ONLINE", new Date(agora - 2 * MIN));
  await gravarLeitura(offline.id, "OFFLINE", new Date(agora - 18 * MIN));
  await gravarLeitura(onlineComOs.id, "ONLINE", new Date(agora - 5 * MIN));
  await gravarLeitura(offlineCom2Os.id, "OFFLINE", new Date(agora - 40 * MIN));
  await gravarLeitura(unknownLido.id, "UNKNOWN", new Date(agora - 180 * MIN));
  await gravarLeitura(inativo.id, "ONLINE", new Date(agora - MIN));

  await criarOs(onlineComOs.id, "ASSIGNED");
  await criarOs(onlineComOs.id, "COMPLETED");
  await criarOs(offlineCom2Os.id, "PENDING");
  await criarOs(offlineCom2Os.id, "IN_PROGRESS");
  await criarOs(offlineCom2Os.id, "CANCELLED");
  await criarOs(inativo.id, "ASSIGNED");

  const cto = await criarCaixa("CTO QA RC1D", [
    { id: online.id, porta: 1 },
    { id: offline.id, porta: 2 },
    { id: semSnapshot.id, porta: 3 },
    { id: onlineComOs.id, porta: 4 },
    { id: offlineCom2Os.id, porta: 5 },
    { id: unknownLido.id, porta: 6 },
    { id: inativo.id, porta: 7 },
  ]);
  return {
    cto,
    online,
    offline,
    semSnapshot,
    onlineComOs,
    offlineCom2Os,
    unknownLido,
    inativo,
  };
}

function porPorta(customers: { portNumber: number }[]) {
  return new Map(customers.map((c) => [c.portNumber, c]));
}

describe("CTO-CONN — a conectividade de cada porta vem da autoridade", () => {
  it("CTO-CONN-01/02/03/04 · online, offline, UNKNOWN lido e SEM snapshot — nunca offline por ausência", async () => {
    const r = await caixaDoRoteiro();
    const vista = await getCtoClientConnectivity(fixture.companyA.id, r.cto.id);
    const portas = porPorta(vista.customers);

    expect(portas.get(1)!.connectivityStatus).toBe("ONLINE");
    expect(portas.get(2)!.connectivityStatus).toBe("OFFLINE");
    // Sem snapshot é UNKNOWN, sem idade — e jamais OFFLINE.
    expect(portas.get(3)!.connectivityStatus).toBe("UNKNOWN");
    expect(portas.get(3)!.connectivityObservedAt).toBeNull();
    // UNKNOWN com leitura: o provedor foi consultado e não concluiu.
    expect(portas.get(6)!.connectivityStatus).toBe("UNKNOWN");
    expect(portas.get(6)!.connectivityObservedAt).not.toBeNull();
  });

  it("CTO-CONN-05 · porta livre não tem ocupante — e não entra em filtro de cliente", async () => {
    const r = await caixaDoRoteiro();
    const vista = await getCtoClientConnectivity(fixture.companyA.id, r.cto.id);
    const detalhe = (await getOperationalCtoDetail(fixture.companyA.id, r.cto.id))!;
    const ocupantes = porPorta(vista.customers);

    const livre = detalhe.ports.find((p) => p.number === 8)!;
    expect(ocupantes.has(8)).toBe(false);
    expect(portMatchesFilter("FREE", livre, undefined)).toBe(true);
    for (const filtro of ["ONLINE", "OFFLINE", "UNKNOWN", "OPEN_OS"] as const) {
      expect(portMatchesFilter(filtro, livre, undefined)).toBe(false);
    }
  });

  it("CTO-CONN-06 · a idade vem do observedAt gravado, calculada contra o relógio da página", async () => {
    const r = await caixaDoRoteiro();
    const vista = await getCtoClientConnectivity(fixture.companyA.id, r.cto.id);
    const offline = porPorta(vista.customers).get(2)!;

    const gravado = await prisma.customerDiagnosticSnapshot.findFirstOrThrow({
      where: { customerId: r.offline.id },
    });
    expect(offline.connectivityObservedAt).toBe(gravado.observedAt.toISOString());

    const relogio = new Date(gravado.observedAt.getTime() + 18 * MIN + 5_000);
    expect(connectivityAge(offline.connectivityObservedAt, relogio)).toBe("há 18 min");
    const tresHoras = porPorta(vista.customers).get(6)!;
    expect(
      connectivityAge(
        tresHoras.connectivityObservedAt,
        new Date(new Date(tresHoras.connectivityObservedAt!).getTime() + 180 * MIN),
      ),
    ).toBe("há 3 h");
    expect(connectivityAge(null, relogio)).toBeNull();
  });

  it("CTO-CONN-07/08 · abrir a caixa não chama provider nenhum — nem uma requisição de rede", async () => {
    const r = await caixaDoRoteiro();
    const rede = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("rede proibida na tela da CTO"));
    try {
      await getCtoClientConnectivity(fixture.companyA.id, r.cto.id);
      expect(rede).not.toHaveBeenCalled();
    } finally {
      rede.mockRestore();
    }
  });

  it("CTO-CONN-07b · da autoridade de conectividade, a tela usa SÓ a leitura em lote do banco", () => {
    /*
      O grafo de import alcança `src/integrations/` — e isso foi medido, não
      suposto: `operational-map` → `customer-diagnostics` →
      `integrations/diagnostics`, porque a leitura em lote e a atualização
      manual moram no mesmo módulo. O mapa congelado tem o mesmo grafo. Afirmar
      "o grafo não chega lá" seria falso; o que se afirma é o que é CHAMADO:
      de `customer-diagnostics` só a leitura em lote, e nenhuma função de
      atualização, adapter ou provider nos arquivos da tela.
    */
    const raiz = process.cwd();
    const codigo = (arquivo: string) =>
      readFileSync(path.join(raiz, arquivo), "utf8").replace(
        /\{\/\*[\s\S]*?\*\/\}|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
        "",
      );

    const mapa = codigo("src/lib/operational-map.ts");
    const importado = mapa.match(
      /import\s*\{([^}]*)\}\s*from\s*["']\.\/customer-diagnostics["']/,
    );
    expect(importado?.[1].trim()).toBe("getConnectivityForCustomers");

    const leitura = [
      "src/app/(app)/ctos/[id]/page.tsx",
      "src/lib/cto-client-connectivity.ts",
      "src/lib/cto-port-filters.ts",
      "src/lib/operational-map.ts",
    ];
    for (const arquivo of [...leitura, "src/app/(app)/ctos/[id]/CtoDetailManager.tsx"]) {
      const fonte = codigo(arquivo);
      expect(fonte, arquivo).not.toMatch(
        /refresh[A-Z]\w*Diagnostic|fetchCustomerConnectivity|resolveCompanyAdapter|getAdapter|@\/integrations|from\s*["'][^"']*integrations|\/diagnostic|\/refresh/,
      );
    }
    // A leitura da caixa não faz requisição nenhuma; os `fetch` do manager são
    // as ações administrativas que já existiam (capacidade, porta, foto).
    for (const arquivo of leitura) {
      expect(codigo(arquivo), arquivo).not.toMatch(/\bfetch\(/);
    }
  });

  it("CTO-CONN-09 · consultas CONSTANTES — duas portas ou seis, o mesmo número", async () => {
    const espiaoVinculo = vi.spyOn(prisma.customerNetworkConnection, "findMany");
    const espiaoSnapshot = vi.spyOn(prisma.customerDiagnosticSnapshot, "findMany");
    const espiaoOs = vi.spyOn(prisma.serviceOrder, "groupBy");
    const espiaoCliente = vi.spyOn(prisma.customer, "findUnique");
    const espiaoSnapUnico = vi.spyOn(prisma.customerDiagnosticSnapshot, "findFirst");

    const medir = async (quantos: number, nome: string) => {
      const clientes = await Promise.all(
        Array.from({ length: quantos }, (_, i) => criarCliente(`${nome} ${i}`)),
      );
      for (const c of clientes) await gravarLeitura(c.id, "ONLINE", new Date());
      const cto = await criarCaixa(
        nome,
        clientes.map((c, i) => ({ id: c.id, porta: i + 1 })),
      );
      for (const e of [espiaoVinculo, espiaoSnapshot, espiaoOs, espiaoCliente, espiaoSnapUnico]) {
        e.mockClear();
      }
      await getCtoClientConnectivity(fixture.companyA.id, cto.id);
      return {
        vinculos: espiaoVinculo.mock.calls.length,
        snapshots: espiaoSnapshot.mock.calls.length,
        os: espiaoOs.mock.calls.length,
        porCliente: espiaoCliente.mock.calls.length + espiaoSnapUnico.mock.calls.length,
      };
    };

    try {
      const pequena = await medir(2, "N1 DUAS");
      const grande = await medir(6, "N1 SEIS");
      expect(grande).toEqual(pequena);
      // Resumo + lista: uma de cada tipo por leitura, nunca uma por cliente.
      expect(grande).toEqual({ vinculos: 2, snapshots: 2, os: 2, porCliente: 0 });
    } finally {
      for (const e of [espiaoVinculo, espiaoSnapshot, espiaoOs, espiaoCliente, espiaoSnapUnico]) {
        e.mockRestore();
      }
    }
  });

  it("CTO-CONN-10 · snapshot e OS de OUTRA empresa não contam; a caixa de outra empresa não abre", async () => {
    const r = await caixaDoRoteiro();
    // O vetor da DQ-7.1: FK simples permite a linha da B apontando cliente da A.
    await gravarLeitura(r.semSnapshot.id, "OFFLINE", new Date(), fixture.companyB.id);
    await criarOs(r.online.id, "ASSIGNED", fixture.companyB.id);

    const vista = await getCtoClientConnectivity(fixture.companyA.id, r.cto.id);
    const portas = porPorta(vista.customers);
    expect(portas.get(3)!.connectivityStatus).toBe("UNKNOWN");
    expect(portas.get(1)!.openServiceOrderCount).toBe(0);

    // A empresa B pedindo a caixa da A: nada, nem contagem.
    const cruzada = await getCtoClientConnectivity(fixture.companyB.id, r.cto.id);
    expect(cruzada.customers).toEqual([]);
    expect(cruzada.summary).toEqual({
      activeCustomerCount: 0,
      onlineCount: 0,
      offlineCount: 0,
      unknownCount: 0,
      openServiceOrderCount: 0,
    });
    expect(await getOperationalCtoDetail(fixture.companyB.id, r.cto.id)).toBeNull();
  });
});

describe("CTO-COUNT — o resumo e as contagens", () => {
  it("CTO-COUNT-01 · 6 ocupadas (4 online, 1 offline, 1 sem leitura): 6 clientes, 8 de capacidade, 2 livres", async () => {
    const estados = ["ONLINE", "ONLINE", "ONLINE", "ONLINE", "OFFLINE", null] as const;
    const clientes = [];
    for (const [i, estado] of estados.entries()) {
      const c = await criarCliente(`CONTA ${i}`);
      if (estado) await gravarLeitura(c.id, estado, new Date());
      clientes.push(c);
    }
    const cto = await criarCaixa(
      "CTO CONTAGEM",
      clientes.map((c, i) => ({ id: c.id, porta: i + 1 })),
    );

    const vista = await getCtoClientConnectivity(fixture.companyA.id, cto.id);
    const detalhe = (await getOperationalCtoDetail(fixture.companyA.id, cto.id))!;

    expect(vista.summary).toEqual({
      activeCustomerCount: 6,
      onlineCount: 4,
      offlineCount: 1,
      unknownCount: 1,
      openServiceOrderCount: 0,
    });
    // Portas e clientes são dimensões separadas.
    expect(detalhe.summary.capacity).toBe(8);
    expect(detalhe.summary.occupied).toBe(6);
    expect(detalhe.summary.free).toBe(2);
  });

  it("CTO-COUNT-02 · o roteiro: ativos 6, online 2, offline 2, sem leitura 2, OS abertas 3 — o inativo e a OS encerrada fora", async () => {
    const r = await caixaDoRoteiro();
    const vista = await getCtoClientConnectivity(fixture.companyA.id, r.cto.id);
    expect(vista.summary).toEqual({
      activeCustomerCount: 6,
      onlineCount: 2,
      offlineCount: 2,
      unknownCount: 2,
      openServiceOrderCount: 3,
    });
    const portas = porPorta(vista.customers);
    // OS abertas pelo predicado canônico: concluída e cancelada não contam.
    expect(portas.get(4)!.openServiceOrderCount).toBe(1);
    expect(portas.get(5)!.openServiceOrderCount).toBe(2);
    // O inativo ocupa a porta e aparece — com o cadastro dito —, fora das contagens.
    expect(portas.get(7)!.customerActive).toBe(false);
    expect(portas.get(7)!.openServiceOrderCount).toBe(1);
  });
});

describe("CTO-CONSIST — o detalhe diz o que o popup diz", () => {
  it("CTO-CONSIST-01 · o resumo do detalhe é o do popup da caixa no mapa, número a número", async () => {
    const r = await caixaDoRoteiro();
    const vista = await getCtoClientConnectivity(fixture.companyA.id, r.cto.id);
    const mapa = await getCtoMapView(fixture.companyA.id, { bbox: BBOX });
    const popup = mapa.markers.find((m) => m.id === r.cto.id)!;
    expect(vista.summary).toEqual(popup.operational);

    // E as portas do popup são as do detalhe.
    const detalhe = (await getOperationalCtoDetail(fixture.companyA.id, r.cto.id))!;
    expect(popup.summary).toEqual(detalhe.summary);
  });

  it("CTO-CONSIST-02 · o número de cada filtro é o do resumo — nenhuma segunda contagem", async () => {
    const r = await caixaDoRoteiro();
    const vista = await getCtoClientConnectivity(fixture.companyA.id, r.cto.id);
    const detalhe = (await getOperationalCtoDetail(fixture.companyA.id, r.cto.id))!;
    const filtros = countPortFilters(detalhe.ports, vista.customers);

    expect(filtros.ALL).toBe(detalhe.ports.length);
    expect(filtros.FREE).toBe(detalhe.summary.free);
    expect(filtros.OCCUPIED).toBe(detalhe.summary.occupied);
    expect(filtros.ONLINE).toBe(vista.summary.onlineCount);
    expect(filtros.OFFLINE).toBe(vista.summary.offlineCount);
    expect(filtros.UNKNOWN).toBe(vista.summary.unknownCount);
    // "Com OS aberta" conta CLIENTES; a soma das OS deles é o resumo.
    const comOs = vista.customers.filter(
      (c) => c.customerActive && c.openServiceOrderCount > 0,
    );
    expect(filtros.OPEN_OS).toBe(comOs.length);
    expect(comOs.reduce((s, c) => s + c.openServiceOrderCount, 0)).toBe(
      vista.summary.openServiceOrderCount,
    );
  });

  it("CTO-FILTER-01 · cada filtro mostra só o que diz, e 'Todas' devolve tudo", async () => {
    const r = await caixaDoRoteiro();
    const vista = await getCtoClientConnectivity(fixture.companyA.id, r.cto.id);
    const detalhe = (await getOperationalCtoDetail(fixture.companyA.id, r.cto.id))!;
    const ocupantes = porPorta(vista.customers);
    const portas = (filtro: (typeof CTO_PORT_FILTERS)[number]) =>
      detalhe.ports
        .filter((p) => portMatchesFilter(filtro, p, ocupantes.get(p.number)))
        .map((p) => p.number);

    expect(portas("ALL")).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(portas("ONLINE")).toEqual([1, 4]);
    expect(portas("OFFLINE")).toEqual([2, 5]);
    expect(portas("UNKNOWN")).toEqual([3, 6]);
    expect(portas("FREE")).toEqual([8]);
    expect(portas("OCCUPIED")).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(portas("OPEN_OS")).toEqual([4, 5]);
  });

  it("CTO-FILTER-02 · os rótulos de conectividade são os da tabela única: 'Sem leitura', nunca 'Offline' nem 'Desativado'", () => {
    expect(CTO_PORT_FILTER_LABELS.UNKNOWN).toBe("Sem leitura");
    expect(CTO_PORT_FILTER_LABELS.OFFLINE).toBe("Offline");
    expect(Object.values(CTO_PORT_FILTER_LABELS).join(" ")).not.toMatch(
      /Desativ|Stale|STALE/,
    );
  });
});

describe("CTO-RO — abrir a caixa não escreve nada", () => {
  it("CTO-RO-01 · snapshot, vínculo, porta, CTO, OS e auditoria ficam como estavam", async () => {
    const r = await caixaDoRoteiro();
    const retrato = async () => ({
      snapshots: await prisma.customerDiagnosticSnapshot.findMany({
        where: { companyId: fixture.companyA.id },
        orderBy: { id: "asc" },
      }),
      vinculos: await prisma.customerNetworkConnection.findMany({
        where: { companyId: fixture.companyA.id },
        orderBy: { id: "asc" },
      }),
      portas: await prisma.cTOPort.findMany({
        where: { ctoId: r.cto.id },
        orderBy: { number: "asc" },
      }),
      cto: await prisma.cTO.findUnique({ where: { id: r.cto.id } }),
      ordens: await prisma.serviceOrder.findMany({
        where: { companyId: fixture.companyA.id },
        orderBy: { id: "asc" },
      }),
      auditoria: await prisma.auditLog.count({
        where: { companyId: fixture.companyA.id },
      }),
    });

    const antes = await retrato();
    await getCtoClientConnectivity(fixture.companyA.id, r.cto.id);
    await getCtoClientConnectivity(fixture.companyA.id, r.cto.id);
    expect(await retrato()).toEqual(antes);
  });
});
