import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  findConnectionsDueForCheck,
  runConnectivityRefreshCycle,
} from "@/lib/connectivity-monitor";
import {
  CONNECTIVITY_POLICY_DEFAULTS,
  isVerificationStale,
} from "@/lib/connectivity-policy";
import { createCto } from "@/lib/cto";
import { MockERPAdapter } from "@/integrations/MockERPAdapter";
import { seedTestData, type TestFixture } from "./helpers";

/**
 * # `RC-1F-A` — o motor de diagnóstico antes de alguém agendá-lo
 *
 * A descoberta da `RC-1F` provou três defeitos com sonda fora do repositório.
 * Nenhum deles aparece numa asserção sobre estado final: o banco fica coerente
 * nos três. O que se perde é CHAMADA AO PROVIDER (duplicada, ou nunca feita), e
 * por isso os testes daqui contam chamadas.
 *
 *   DIAG-OVERLAP-01  ciclo com lista velha repetia a chamada depois da reserva
 *   DIAG-STARV-01    cliente que sempre falha ocupava o teto de toda volta
 *   DIAG-CADENCE-01  cron de 5 min com alvo de 5 min revisitava em ~10 min
 */

let fixture: TestFixture;
let contador = 0;

const MIN = 60_000;
const ALVO = CONNECTIVITY_POLICY_DEFAULTS.refreshTargetMs;

beforeEach(async () => {
  fixture = await seedTestData();
  contador = 0;
  await prisma.eRPIntegration.create({
    data: { companyId: fixture.companyA.id, provider: "MOCK", name: "Mock ERP", enabled: true },
  });
});

async function caixa(companyId: string) {
  await prisma.company.update({ where: { id: companyId }, data: { ctoNetworkEnabled: true } });
  const autor = companyId === fixture.companyA.id ? fixture.adminA.id : fixture.adminB.id;
  contador += 1;
  const cto = await createCto(companyId, autor, { name: `CTO RC1FA ${contador}`, capacity: 16 });
  return cto.id;
}

/**
 * Cliente ligado numa porta. `leitura` grava um snapshot no passado; sem ela o
 * cliente nunca foi verificado. O sufixo decide o que o Mock responde:
 * `-ONLINE` responde, `-FAIL` falha sempre (UPSTREAM_UNAVAILABLE).
 */
async function ligado(
  ctoId: string,
  porta: number,
  sufixo: "-ONLINE" | "-FAIL",
  leitura?: Date,
  companyId = fixture.companyA.id,
) {
  contador += 1;
  const c = await prisma.customer.create({
    data: {
      companyId,
      name: `RC1FA ${contador}`,
      active: true,
      externalProvider: "MOCK",
      externalId: `RC1FA-${contador}${sufixo}`,
    },
  });
  const p = await prisma.cTOPort.findFirstOrThrow({ where: { ctoId, number: porta } });
  await prisma.customerNetworkConnection.create({
    data: { companyId, customerId: c.id, ctoPortId: p.id, source: "WEB", connectedAt: new Date() },
  });
  if (leitura) {
    await prisma.customerDiagnosticSnapshot.create({
      data: {
        companyId,
        customerId: c.id,
        externalProvider: "MOCK",
        connectivityStatus: "ONLINE",
        observedAt: leitura,
        statusSince: new Date(leitura.getTime() - 2 * 24 * 60 * MIN),
      },
    });
  }
  return c;
}

function adiado() {
  let soltar!: () => void;
  const promessa = new Promise<void>((r) => (soltar = r));
  return { promessa, soltar };
}

/** Conta chamadas ao provider por `externalId`, lendo ANTES de restaurar o espião. */
function espiarProvider(
  antes?: (externalId: string | null) => Promise<void>,
) {
  const original = MockERPAdapter.prototype.fetchCustomerConnectivity;
  const espiao = vi
    .spyOn(MockERPAdapter.prototype, "fetchCustomerConnectivity")
    .mockImplementation(async function (this: MockERPAdapter, ref, context) {
      if (antes) await antes(ref.externalId);
      return original.call(this, ref, context);
    });
  return {
    chamadas: (externalId: string | null) =>
      espiao.mock.calls.filter(([ref]) => ref.externalId === externalId).length,
    total: () => espiao.mock.calls.length,
    /** Os externalId das chamadas, na ordem em que aconteceram. */
    lista: () => espiao.mock.calls.map(([ref]) => ref.externalId),
    restaurar: () => espiao.mockRestore(),
  };
}

// ---------------------------------------------------------------------------
// DIAG-OVERLAP-01 — a seleção não é a autoridade final
// ---------------------------------------------------------------------------

describe("DIAG-OVERLAP — a reserva confere o frescor ATUAL", () => {
  it("DIAG-OVERLAP-FIX-01 · ciclo com lista velha não repete a chamada de quem outro ciclo acabou de verificar", async () => {
    const ctoId = await caixa(fixture.companyA.id);
    const velha = new Date(Date.now() - 30 * MIN);
    const x = await ligado(ctoId, 1, "-ONLINE", velha);
    const y = await ligado(ctoId, 2, "-ONLINE", velha);

    /*
      Relógio do ciclo B: 70 s à frente do A, o que simula B chegar ao cliente
      que A verificou depois de vencida a reserva de 60 s que A pôs nele. A
      lista de B é lida AGORA, com os dois vencidos — e é essa lista que
      envelhece.
    */
    const inicio = Date.now();
    const portao = adiado();
    const bDentro = adiado();
    let primeiro: string | null = null;
    const provider = espiarProvider(async (externalId) => {
      if (primeiro === null) {
        // A primeira chamada é a de B, qualquer que seja o cliente que ele escolheu.
        primeiro = externalId;
        bDentro.soltar();
        await portao.promessa;
      }
    });

    let b;
    try {
      const cicloB = runConnectivityRefreshCycle({ now: new Date(inicio + 70_000), concurrency: 1 });
      await bDentro.promessa; // B reservou um dos dois e está no provider

      const a = await runConnectivityRefreshCycle({ now: new Date(), concurrency: 1 });
      expect(a.processed).toBe(1);

      portao.soltar();
      b = await cicloB;

      // Cada um foi consultado UMA vez: B, ao chegar no que A verificou, achou a
      // leitura recém-gravada e desistiu sem chamar o provider.
      expect(provider.chamadas(x.externalId)).toBe(1);
      expect(provider.chamadas(y.externalId)).toBe(1);
    } finally {
      provider.restaurar();
    }
    expect(b.skippedFresh).toBe(1);
    expect(b.processed).toBe(1);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// A primeira verificação continua arbitrada pelo advisory lock
// ---------------------------------------------------------------------------

describe("DIAG-FIRST — cliente sem leitura", () => {
  it("DIAG-FIRST-01 · dois ciclos sobrepostos na PRIMEIRA verificação: uma chamada ao provider", async () => {
    const ctoId = await caixa(fixture.companyA.id);
    const n = await ligado(ctoId, 1, "-ONLINE");

    const portao = adiado();
    const dentro = adiado();
    const provider = espiarProvider(async (externalId) => {
      if (externalId === n.externalId) {
        dentro.soltar();
        await portao.promessa;
      }
    });
    try {
      const um = runConnectivityRefreshCycle({ concurrency: 1 });
      await dentro.promessa; // o primeiro está com o lock e dentro do provider

      const dois = await runConnectivityRefreshCycle({ concurrency: 1 });
      expect(dois.processed).toBe(0);
      expect(dois.claimedByOther).toBe(1);

      portao.soltar();
      expect((await um).processed).toBe(1);
      expect(provider.chamadas(n.externalId)).toBe(1);
    } finally {
      provider.restaurar();
    }
    expect(await prisma.customerDiagnosticSnapshot.count({ where: { customerId: n.id } })).toBe(1);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// DIAG-STARV-01 — quem falha sempre não monopoliza o teto
// ---------------------------------------------------------------------------

describe("DIAG-FAIR — uma falha repetida não impede os demais", () => {
  it("DIAG-FAIR-01 · COM leitura: teto 1, A falha sempre, B saudável — B é consultado na volta seguinte", async () => {
    const ctoId = await caixa(fixture.companyA.id);
    const velha = new Date(Date.now() - 60 * MIN);
    // A é criado primeiro: na ordem física da tabela, ele vem antes.
    const a = await ligado(ctoId, 1, "-FAIL", velha);
    const b = await ligado(ctoId, 2, "-ONLINE", velha);

    const provider = espiarProvider();
    try {
      /*
        Cada volta começa depois de vencida a reserva da anterior. A primeira
        volta pode escolher qualquer um dos dois (empate); a segunda não pode
        escolher A de novo, porque A foi tentado há pouco e B não.
      */
      for (let volta = 1; volta <= 2; volta += 1) {
        const agora = new Date(velha.getTime() + volta * 6 * MIN);
        const r = await runConnectivityRefreshCycle({ now: agora, limit: 1, concurrency: 1 });
        expect(r.processed).toBe(1);
      }
      expect(provider.chamadas(b.externalId)).toBe(1);
      expect(provider.chamadas(a.externalId)).toBeLessThanOrEqual(1);
    } finally {
      provider.restaurar();
    }
    const sb = await prisma.customerDiagnosticSnapshot.findFirstOrThrow({ where: { customerId: b.id } });
    expect(sb.observedAt.getTime()).toBeGreaterThan(velha.getTime());
  }, 30_000);

  it("DIAG-FAIR-02 · SEM leitura: teto 1, A nunca verificado e falha sempre, B nunca verificado — B é consultado", async () => {
    const ctoId = await caixa(fixture.companyA.id);
    const a = await ligado(ctoId, 1, "-FAIL");
    const b = await ligado(ctoId, 2, "-ONLINE");

    /*
      Sem linha não há onde registrar a tentativa — e fabricar um snapshot para
      isso está proibido. A fila de quem nunca foi verificado GIRA por tick
      sobre a ordem estável (DIAG-FAIR-DETERMINISTIC): com dois candidatos e
      teto 1, o saudável é consultado em no máximo dois ticks, qualquer que seja
      a fase do relógio.
    */
    const base = Date.now() - 100 * MIN;
    let voltas = 0;
    const provider = espiarProvider();
    try {
      while (voltas < 40 && provider.chamadas(b.externalId) === 0) {
        voltas += 1;
        await runConnectivityRefreshCycle({
          now: new Date(base + voltas * MIN),
          limit: 1,
          concurrency: 1,
        });
      }
      expect(provider.chamadas(b.externalId)).toBe(1);
      expect(provider.chamadas(a.externalId)).toBe(voltas - 1);
      expect(voltas).toBeLessThanOrEqual(2);
    } finally {
      provider.restaurar();
    }
  }, 60_000);

  it("DIAG-FAIR-03 · empresa sem diagnóstico não gasta o teto: B de outra empresa é consultado na MESMA volta", async () => {
    // A empresa B não tem integração nenhuma: NOT_SUPPORTED.
    const ctoB = await caixa(fixture.companyB.id);
    for (let porta = 1; porta <= 3; porta += 1) {
      await ligado(ctoB, porta, "-ONLINE", undefined, fixture.companyB.id);
    }
    /*
      O saudável TEM leitura vencida, e os três da empresa sem diagnóstico não
      têm. A intercalação começa pela fila sem leitura, então o primeiro
      candidato é sempre da empresa sem diagnóstico — sem isso, o sorteio podia
      pôr o saudável na frente e a volta acabar antes de a empresa ser vista.
    */
    const ctoA = await caixa(fixture.companyA.id);
    const saudavel = await ligado(ctoA, 1, "-ONLINE", new Date(Date.now() - 60 * MIN));

    const provider = espiarProvider();
    let r;
    try {
      r = await runConnectivityRefreshCycle({ limit: 1, concurrency: 1 });
      expect(provider.chamadas(saudavel.externalId)).toBe(1);
      expect(provider.total()).toBe(1);
    } finally {
      provider.restaurar();
    }
    expect(r.processed).toBe(1);
    expect(r.skippedCompanies).toBe(1);
    expect(r.providerFailures).toBe(0);
  }, 30_000);

  it("DIAG-FAIR-04 · a falha continua não escrevendo nada — a justiça não fabrica leitura", async () => {
    const ctoId = await caixa(fixture.companyA.id);
    const velha = new Date(Date.now() - 60 * MIN);
    const a = await ligado(ctoId, 1, "-FAIL", velha);
    const nunca = await ligado(ctoId, 2, "-FAIL");
    const antes = await prisma.customerDiagnosticSnapshot.findFirstOrThrow({ where: { customerId: a.id } });

    for (let volta = 1; volta <= 3; volta += 1) {
      await runConnectivityRefreshCycle({ now: new Date(velha.getTime() + volta * 6 * MIN) });
    }

    const depois = await prisma.customerDiagnosticSnapshot.findFirstOrThrow({ where: { customerId: a.id } });
    expect(depois.observedAt.getTime()).toBe(antes.observedAt.getTime());
    expect(depois.statusSince.getTime()).toBe(antes.statusSince.getTime());
    expect(depois.connectivityStatus).toBe("ONLINE");
    // Quem nunca foi verificado continua sem linha: nenhum UNKNOWN inventado.
    expect(await prisma.customerDiagnosticSnapshot.count({ where: { customerId: nunca.id } })).toBe(0);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Decisão do dono (C): justiça DETERMINÍSTICA para quem nunca foi verificado
// ---------------------------------------------------------------------------

/**
 * Cliente nunca verificado com id ESCOLHIDO, para a ordem estável ser
 * conhecida pelo teste. A inserção é feita na ordem inversa dos ids: se a
 * seleção dependesse da ordem física da tabela, ela apareceria.
 */
async function nuncaVerificadosComId(ctoId: string, ids: string[], sufixo: (id: string) => "-ONLINE" | "-FAIL") {
  const criados = new Map<string, { id: string; externalId: string }>();
  for (const [indice, id] of Array.from([...ids].reverse().entries())) {
    const externalId = `${id}${sufixo(id)}`;
    await prisma.customer.create({
      data: { id, companyId: fixture.companyA.id, name: `DET ${id}`, active: true, externalProvider: "MOCK", externalId },
    });
    const p = await prisma.cTOPort.findFirstOrThrow({ where: { ctoId, number: indice + 1 } });
    await prisma.customerNetworkConnection.create({
      data: { companyId: fixture.companyA.id, customerId: id, ctoPortId: p.id, source: "WEB", connectedAt: new Date() },
    });
    criados.set(id, { id, externalId });
  }
  return criados;
}

/** Um instante alinhado ao início de um minuto, no passado. */
function minutoAlinhado(minutosAtras: number): number {
  return Math.floor(Date.now() / MIN) * MIN - minutosAtras * MIN;
}

describe("DIAG-FAIR-DETERMINISTIC — progresso previsível, sem sorteio", () => {
  it("DIAG-FAIR-DETERMINISTIC-01 · 5 nunca verificados, teto 1, todos falham: em 5 ticks seguidos cada um é tentado UMA vez, em rotação pela ordem estável", async () => {
    const ctoId = await caixa(fixture.companyA.id);
    const ids = ["rc1fa-det1-a", "rc1fa-det1-b", "rc1fa-det1-c", "rc1fa-det1-d", "rc1fa-det1-e"];
    const clientes = await nuncaVerificadosComId(ctoId, ids, () => "-FAIL");
    const porExterno = new Map(Array.from(clientes.values()).map((c) => [c.externalId, c.id]));

    async function rodada(inicio: number): Promise<string[]> {
      const sequencia: string[] = [];
      const provider = espiarProvider();
      try {
        for (let tick = 0; tick < ids.length; tick += 1) {
          const antes = provider.total();
          const r = await runConnectivityRefreshCycle({ now: new Date(inicio + tick * MIN), limit: 1, concurrency: 1 });
          expect(r.processed).toBe(1);
          expect(provider.total() - antes).toBe(1);
        }
        return provider.lista().map((externo) => porExterno.get(externo ?? "") ?? "?");
      } finally {
        provider.restaurar();
      }
    }

    const inicio = minutoAlinhado(200);
    const sequencia = await rodada(inicio);

    // Cobertura completa em N ticks: ninguém repetido, ninguém esquecido.
    expect([...sequencia].sort()).toEqual(ids);
    // E em ROTAÇÃO pela ordem estável: cada tick pega o seguinte ao anterior.
    const posicao = sequencia.map((id) => ids.indexOf(id));
    for (let i = 1; i < posicao.length; i += 1) {
      expect(posicao[i]).toBe((posicao[i - 1] + 1) % ids.length);
    }
    // Nada foi escrito: falha não vira leitura, então o conjunto é estável.
    expect(await prisma.customerDiagnosticSnapshot.count({ where: { customerId: { in: ids } } })).toBe(0);
  }, 60_000);

  it("DIAG-FAIR-DETERMINISTIC-02 · reprodutível: os MESMOS ticks dão a MESMA sequência, e um cliente que falha sempre não segura os saudáveis além de 2N ticks, em qualquer fase", async () => {
    const ctoId = await caixa(fixture.companyA.id);

    // Parte 1 — mesmos ticks, mesma sequência (três repetições).
    const ids = ["rc1fa-det2-a", "rc1fa-det2-b", "rc1fa-det2-c", "rc1fa-det2-d"];
    const clientes = await nuncaVerificadosComId(ctoId, ids, () => "-FAIL");
    const porExterno = new Map(Array.from(clientes.values()).map((c) => [c.externalId, c.id]));
    const inicio = minutoAlinhado(300);
    const sequencias: string[][] = [];
    for (let repeticao = 0; repeticao < 3; repeticao += 1) {
      const provider = espiarProvider();
      try {
        for (let tick = 0; tick < 6; tick += 1) {
          await runConnectivityRefreshCycle({ now: new Date(inicio + tick * MIN), limit: 1, concurrency: 1 });
        }
        sequencias.push(provider.lista().map((externo) => porExterno.get(externo ?? "") ?? "?"));
      } finally {
        provider.restaurar();
      }
    }
    expect(sequencias[0]).toHaveLength(6);
    expect(sequencias[1]).toEqual(sequencias[0]);
    expect(sequencias[2]).toEqual(sequencias[0]);
    await prisma.customerNetworkConnection.updateMany({
      where: { customerId: { in: ids } },
      data: { disconnectedAt: new Date() },
    });

    // Parte 2 — o primeiro da ordem estável falha sempre; os outros quatro são
    // saudáveis. Para CADA fase do relógio, os quatro são verificados em no
    // máximo 2N ticks.
    for (let fase = 0; fase < 5; fase += 1) {
      const idsFase = ["a", "b", "c", "d", "e"].map((l) => `rc1fa-det2-f${fase}-${l}`);
      const criados = await nuncaVerificadosComId(ctoId, idsFase, (id) => (id.endsWith("-a") ? "-FAIL" : "-ONLINE"));
      const saudaveis = idsFase.filter((id) => !id.endsWith("-a"));
      const inicioFase = minutoAlinhado(1000) + fase * MIN;
      let ticks = 0;
      while (
        ticks < 2 * idsFase.length &&
        (await prisma.customerDiagnosticSnapshot.count({ where: { customerId: { in: saudaveis } } })) < saudaveis.length
      ) {
        await runConnectivityRefreshCycle({ now: new Date(inicioFase + ticks * MIN), limit: 1, concurrency: 1 });
        ticks += 1;
      }
      expect(
        await prisma.customerDiagnosticSnapshot.count({ where: { customerId: { in: saudaveis } } }),
        `fase ${fase}`,
      ).toBe(saudaveis.length);
      expect(ticks, `fase ${fase}`).toBeLessThanOrEqual(2 * idsFase.length);
      await prisma.customerNetworkConnection.updateMany({
        where: { customerId: { in: Array.from(criados.keys()) } },
        data: { disconnectedAt: new Date() },
      });
    }
  }, 120_000);
});

// ---------------------------------------------------------------------------
// DIAG-CADENCE-01 — o alvo é 5 min, e o tick pode ser mais frequente
// ---------------------------------------------------------------------------

describe("DIAG-CADENCE — tick de 1 minuto, alvo de 5", () => {
  it("DIAG-CADENCE-FIX-01 · observado em T+20s: nenhum tick até T+5m chama; o de T+6m chama uma vez", async () => {
    const ctoId = await caixa(fixture.companyA.id);
    const T = Date.now() - 20 * MIN;
    const c = await ligado(ctoId, 1, "-ONLINE", new Date(T + 20_000));

    const porTick: number[] = [];
    const provider = espiarProvider();
    try {
      for (let minuto = 1; minuto <= 6; minuto += 1) {
        const antes = provider.chamadas(c.externalId);
        await runConnectivityRefreshCycle({ now: new Date(T + minuto * MIN) });
        porTick.push(provider.chamadas(c.externalId) - antes);
      }
    } finally {
      provider.restaurar();
    }
    // Revisita em 5 min 40 s, e não perto de 10.
    expect(porTick).toEqual([0, 0, 0, 0, 0, 1]);
  }, 30_000);

  it("DIAG-CADENCE-FIX-02 · a seleção nunca devolve quem está dentro do alvo", async () => {
    const ctoId = await caixa(fixture.companyA.id);
    const agora = Date.now();
    const fresco = await ligado(ctoId, 1, "-ONLINE", new Date(agora - ALVO + 1_000));
    const vencido = await ligado(ctoId, 2, "-ONLINE", new Date(agora - ALVO));

    const { due } = await findConnectionsDueForCheck(new Date(agora), ALVO);
    const ids = due.map((d) => d.customerId);
    expect(ids).not.toContain(fresco.id);
    expect(ids).toContain(vencido.id);
  });
});

// ---------------------------------------------------------------------------
// Provider falhando: a leitura envelhece em público
// ---------------------------------------------------------------------------

describe("DIAG-STALE — o provider falha por mais que o limiar", () => {
  it("DIAG-STALE-01 · observedAt, statusSince e estado intactos; nunca OFFLINE; a tela avisa", async () => {
    const ctoId = await caixa(fixture.companyA.id);
    const T = Date.now() - 30 * MIN;
    const c = await ligado(ctoId, 1, "-FAIL", new Date(T));
    const antes = await prisma.customerDiagnosticSnapshot.findFirstOrThrow({ where: { customerId: c.id } });

    const provider = espiarProvider();
    try {
      for (const minuto of [6, 7, 11]) {
        const r = await runConnectivityRefreshCycle({ now: new Date(T + minuto * MIN) });
        expect(r.offline).toBe(0);
      }
      // O ciclo TENTOU — a leitura só não foi renovada.
      expect(provider.chamadas(c.externalId)).toBeGreaterThanOrEqual(2);
    } finally {
      provider.restaurar();
    }

    const depois = await prisma.customerDiagnosticSnapshot.findFirstOrThrow({ where: { customerId: c.id } });
    expect(depois.connectivityStatus).toBe("ONLINE");
    expect(depois.observedAt.getTime()).toBe(antes.observedAt.getTime());
    expect(depois.statusSince.getTime()).toBe(antes.statusSince.getTime());
    expect(
      isVerificationStale(depois.observedAt, new Date(T + 11 * MIN), CONNECTIVITY_POLICY_DEFAULTS),
    ).toBe(true);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// O motor não conhece provider concreto
// ---------------------------------------------------------------------------

function codigoSemComentarios(relativo: string): string {
  return readFileSync(path.join(process.cwd(), relativo), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

describe("DIAG-PROVIDER — o agendador é indiferente ao ERP", () => {
  it("DIAG-PROVIDER-01 · o ciclo e o comando não nomeiam provider, adapter nem referência externa", () => {
    for (const arquivo of ["src/lib/connectivity-monitor.ts", "scripts/connectivity-refresh.ts"]) {
      const codigo = codigoSemComentarios(arquivo);
      expect(codigo, arquivo).not.toMatch(/receitanet|\bsgp\b|mockerp|"MOCK"/i);
      expect(codigo, arquivo).not.toMatch(/Adapter"|\/integrations\//);
      expect(codigo, arquivo).not.toMatch(/externalId/);
    }
  });
});
