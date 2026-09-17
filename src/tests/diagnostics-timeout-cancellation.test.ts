import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { runConnectivityRefreshCycle } from "@/lib/connectivity-monitor";
import { createCto } from "@/lib/cto";
import { MockERPAdapter } from "@/integrations/MockERPAdapter";
import { ReceitanetAdapter } from "@/integrations/ReceitanetAdapter";
import { withIntegrationTimeout } from "@/integrations/diagnostics";
import {
  ReceitanetCallCenterClient,
  type FetchLike,
} from "@/integrations/receitanet/CallCenterClient";
import { isIntegrationError } from "@/integrations/errors";
import { seedTestData, type TestFixture } from "./helpers";

/**
 * # `DIAG-ORPHAN-01` — o prazo solta a vaga; ele também precisa soltar a rede
 *
 * `withIntegrationTimeout` corre uma promessa contra um relógio e, perdendo, a
 * deixa terminar sozinha. No ReceitaNet a verificação são DUAS requisições
 * (`verificar-acesso`, depois `/v1/cliente`, best-effort), e o cliente HTTP só
 * cobria até os cabeçalhos. Resultado: vencido o prazo, o ciclo pegava o
 * próximo cliente enquanto a requisição anterior continuava em voo — e a
 * concorrência configurada deixava de ser o limite real de requisições
 * simultâneas ao provider.
 *
 * Nenhum teste aqui usa rede: `fetch` é um falso que conta quem está em voo e
 * obedece ao `AbortSignal` como o `fetch` do Node obedece.
 */

interface Rede {
  fetchImpl: FetchLike;
  emVoo: () => number;
  pico: () => number;
  abortadas: () => number;
}

/**
 * `verificar-acesso` responde em `atrasoAcessoMs` (ou nunca, com `null`);
 * `/v1/cliente` nunca responde. Os dois só terminam por aborto.
 */
function redeFalsa(atrasoAcessoMs: number | null, corpoTravado = false): Rede {
  let emVoo = 0;
  let pico = 0;
  let abortadas = 0;
  const fetchImpl: FetchLike = (url, init) =>
    new Promise((resolve, reject) => {
      emVoo += 1;
      pico = Math.max(pico, emVoo);
      let acabou = false;
      const acabar = () => {
        if (acabou) return false;
        acabou = true;
        emVoo -= 1;
        return true;
      };
      const abortar = () => {
        if (acabar()) {
          abortadas += 1;
          const erro = new Error("aborted");
          erro.name = "AbortError";
          reject(erro);
        }
      };
      if (init.signal?.aborted) return abortar();
      init.signal?.addEventListener("abort", abortar, { once: true });

      if (url.endsWith("/v1/cliente/verificar-acesso") && atrasoAcessoMs !== null) {
        setTimeout(() => {
          if (corpoTravado) {
            // Cabeçalhos chegam; o corpo nunca termina — a requisição segue em voo,
            // e dali em diante quem responde ao aborto é a leitura do corpo.
            init.signal?.removeEventListener("abort", abortar);
            resolve({
              ok: true,
              status: 200,
              contentType: "application/json",
              text: () =>
                new Promise<string>((_, rejeitarCorpo) => {
                  const cortar = () => {
                    if (acabar()) {
                      abortadas += 1;
                      const erro = new Error("aborted");
                      erro.name = "AbortError";
                      rejeitarCorpo(erro);
                    }
                  };
                  if (init.signal?.aborted) return cortar();
                  init.signal?.addEventListener("abort", cortar, { once: true });
                }),
            });
            return;
          }
          if (acabar()) {
            resolve({
              ok: true,
              status: 200,
              contentType: "application/json",
              text: async () => JSON.stringify({ success: true, status: 1 }),
            });
          }
        }, atrasoAcessoMs);
      }
    });
  return {
    fetchImpl,
    emVoo: () => emVoo,
    pico: () => pico,
    abortadas: () => abortadas,
  };
}

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));
const REF = { externalId: "123", document: null, name: "x" };

describe("DIAG-TIMEOUT — vencido o prazo, nada fica em voo", () => {
  it("DIAG-TIMEOUT-01 · a segunda requisição (best-effort) é CANCELADA no prazo, e o estado já obtido vale", async () => {
    const rede = redeFalsa(20);
    const adapter = new ReceitanetAdapter({
      token: "t",
      fetchImpl: rede.fetchImpl,
      diagnosticDeadlineMs: 120,
    });

    const resultado = await withIntegrationTimeout(
      adapter.fetchCustomerConnectivity(REF),
      "RECEITANET",
      120,
    ).then(
      (obs) => ({ obs }),
      (erro: unknown) => ({ erro }),
    );
    await esperar(30);

    // Nenhuma requisição sobrou em voo depois do prazo.
    expect(rede.emVoo()).toBe(0);
    expect(rede.abortadas()).toBe(1);
    // O essencial chegou dentro do prazo: ONLINE, sem os extras.
    expect("obs" in resultado && resultado.obs.status).toBe("ONLINE");
    expect("obs" in resultado && resultado.obs.technology).toBeNull();
  });

  it("DIAG-TIMEOUT-02 · a primeira requisição travada é cancelada, e a falha é TIMEOUT — nunca OFFLINE", async () => {
    const rede = redeFalsa(null);
    const adapter = new ReceitanetAdapter({
      token: "t",
      fetchImpl: rede.fetchImpl,
      diagnosticDeadlineMs: 100,
    });

    const erro = await withIntegrationTimeout(
      adapter.fetchCustomerConnectivity(REF),
      "RECEITANET",
      100,
    ).then(
      () => null,
      (e: unknown) => e,
    );
    await esperar(30);

    expect(isIntegrationError(erro) && erro.code).toBe("TIMEOUT");
    expect(rede.emVoo()).toBe(0);
  });

  it("DIAG-TIMEOUT-03 · o prazo do cliente HTTP cobre também a leitura do CORPO", async () => {
    const rede = redeFalsa(5, true);
    const client = new ReceitanetCallCenterClient({
      token: "t",
      fetchImpl: rede.fetchImpl,
      timeoutMs: 60,
    });

    const desfecho = await Promise.race([
      client.verificarAcesso(123).then(
        () => "respondeu",
        (e: unknown) => (isIntegrationError(e) ? e.code : "outro"),
      ),
      esperar(400).then(() => "pendurado"),
    ]);

    expect(desfecho).toBe("TIMEOUT");
    expect(rede.emVoo()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// O ciclo inteiro: concorrência N é N requisições, mesmo com prazos vencendo
// ---------------------------------------------------------------------------

let fixture: TestFixture;

beforeEach(async () => {
  fixture = await seedTestData();
});

describe("DIAG-CONCURRENCY — o teto de concorrência é teto de requisições", () => {
  it("DIAG-CONCURRENCY-01 · concorrência 2, toda verificação estoura o prazo: nunca mais de 2 requisições em voo", async () => {
    await prisma.eRPIntegration.create({
      data: { companyId: fixture.companyA.id, provider: "MOCK", name: "Mock ERP", enabled: true },
    });
    await prisma.company.update({
      where: { id: fixture.companyA.id },
      data: { ctoNetworkEnabled: true },
    });
    const cto = await createCto(fixture.companyA.id, fixture.adminA.id, {
      name: "CTO RC1FA CONC",
      capacity: 8,
    });
    const velha = new Date(Date.now() - 30 * 60_000);
    for (let porta = 1; porta <= 6; porta += 1) {
      const c = await prisma.customer.create({
        data: {
          companyId: fixture.companyA.id,
          name: `CONC ${porta}`,
          active: true,
          externalProvider: "MOCK",
          externalId: `CONC-${porta}-ONLINE`,
        },
      });
      const p = await prisma.cTOPort.findFirstOrThrow({ where: { ctoId: cto.id, number: porta } });
      await prisma.customerNetworkConnection.create({
        data: { companyId: fixture.companyA.id, customerId: c.id, ctoPortId: p.id, source: "WEB", connectedAt: new Date() },
      });
      await prisma.customerDiagnosticSnapshot.create({
        data: { companyId: fixture.companyA.id, customerId: c.id, externalProvider: "MOCK", connectivityStatus: "ONLINE", observedAt: velha, statusSince: velha },
      });
    }

    /*
      O ciclo resolve o adapter da empresa (Mock); o espião entrega a chamada ao
      adapter ReceitaNet REAL, com rede falsa: `verificar-acesso` responde em
      90 ms e `/v1/cliente` trava. Com prazo de 120 ms, a segunda requisição de
      toda verificação é a que o prazo pega.
    */
    const rede = redeFalsa(90);
    const receitanet = new ReceitanetAdapter({
      token: "t",
      fetchImpl: rede.fetchImpl,
      diagnosticDeadlineMs: 120,
    });
    /*
      O identificador precisa ser NUMÉRICO: o adapter ReceitaNet recusa outro
      formato antes de qualquer rede, e a primeira versão deste teste passava
      sem que uma requisição sequer saísse — vacuamente. Os controles positivos
      abaixo (seis ONLINE, seis abortos, pico exatamente 2) existem para isso
      não voltar a acontecer.
    */
    const espiao = vi
      .spyOn(MockERPAdapter.prototype, "fetchCustomerConnectivity")
      .mockImplementation((ref) =>
        receitanet.fetchCustomerConnectivity({ ...ref, externalId: "123" }),
      );

    let r;
    try {
      r = await runConnectivityRefreshCycle({ concurrency: 2, timeoutMs: 120 });
      await esperar(50);
    } finally {
      espiao.mockRestore();
    }

    expect(r.processed).toBe(6);
    // Controle positivo: a rede foi de fato usada, e o prazo cortou a segunda
    // requisição de cada uma das seis verificações.
    expect(r.online).toBe(6);
    expect(rede.abortadas()).toBe(6);
    // O invariante: nunca mais requisições em voo que a concorrência.
    expect(rede.pico()).toBe(2);
    expect(rede.emVoo()).toBe(0);
  }, 30_000);
});
