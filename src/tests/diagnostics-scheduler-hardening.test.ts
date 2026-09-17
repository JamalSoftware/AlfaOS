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
    .mockImplementation(async function (this: MockERPAdapter, ref) {
      if (antes) await antes(ref.externalId);
      return original.call(this, ref);
    });
  return {
    chamadas: (externalId: string | null) =>
      espiao.mock.calls.filter(([ref]) => ref.externalId === externalId).length,
    total: () => espiao.mock.calls.length,
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
      isso está proibido. A ordem de quem nunca foi verificado é sorteada por
      volta (hash do cliente com o instante da volta), então nenhuma posição
      fixa se repete. O limite de 40 voltas deixa a chance de falso negativo em
      2^-40.
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
