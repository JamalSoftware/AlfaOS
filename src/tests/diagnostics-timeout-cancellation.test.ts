import { describe, expect, it } from "vitest";
import { ReceitanetAdapter } from "@/integrations/ReceitanetAdapter";
import { withIntegrationTimeout } from "@/integrations/diagnostics";
import {
  ReceitanetCallCenterClient,
  type FetchLike,
} from "@/integrations/receitanet/CallCenterClient";
import { isIntegrationError } from "@/integrations/errors";

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
