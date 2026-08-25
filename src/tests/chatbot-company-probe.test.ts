import { describe, it, expect } from "vitest";
import {
  CHATBOT_BASE_URL,
  ReceitanetChatbotClient,
} from "@/integrations/receitanet/ChatbotClient";
import { CALLCENTER_BASE_URL } from "@/integrations/receitanet/CallCenterClient";
import type { FetchLike } from "@/integrations/receitanet/CallCenterClient";
import { isIntegrationError } from "@/integrations/errors";

/**
 * Sonda de credencial do Chatbot — `POST /empresa`.
 *
 * Nenhum token real. O fictício abaixo existe para provar que NÃO sai da
 * máquina em erro nem em resposta.
 */

const TOKEN = "token-chatbot-ficticio-BBBB";

/** Resposta REAL observada em teste manual: campos na RAIZ, sem wrapper. */
const EMPRESA_FLAT = {
  success: true,
  nome: "Provedor Fictício LTDA",
  cnpj: "00.000.000/0001-00",
  endereco: "Rua Fictícia",
  numero: "100",
  complemento: "Sala 1",
  bairro: "Centro",
  uf: "SP",
  cep: "00000-000",
  telefone1: "1100000000",
  telefone2: "1100000001",
};

function clientWith(
  respond: (url: string) => {
    status: number;
    body: string;
    contentType?: string | null;
  },
) {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    calls.push(url);
    const r = respond(url);
    return {
      ok: r.status < 300,
      status: r.status,
      text: async () => r.body,
      contentType: r.contentType ?? "application/json",
    };
  };
  return { calls, client: new ReceitanetChatbotClient({ token: TOKEN, fetchImpl }) };
}

async function probe(
  respond: (url: string) => { status: number; body: string; contentType?: string | null },
) {
  const { client, calls } = clientWith(respond);
  try {
    return { ok: await client.verificarCredencial(), code: "OK", calls };
  } catch (e) {
    return {
      ok: false,
      code: isIntegrationError(e) ? e.code : "desconhecido",
      message: e instanceof Error ? e.message : String(e),
      calls,
    };
  }
}

// ---------------------------------------------------------------------------
// A causa raiz: base URL vinda do contrato errado
// ---------------------------------------------------------------------------

describe("Base URL do Chatbot vem do SEU contrato", () => {
  /**
   * A regressão que teria evitado tudo isto.
   *
   * A suíte anterior provava fartamente quais bases eram RECUSADAS, mas nunca
   * que a base PADRÃO era a declarada pelo `servers` do OpenAPI do Chatbot. Com
   * o transporte injetado em todo teste, o host errado nunca aparecia — e a
   * allowlist, em vez de proteger, cimentava o engano.
   */
  it("REGRESSÃO: a base padrão é a do `servers` do OpenAPI do Chatbot", () => {
    expect(CHATBOT_BASE_URL).toBe("https://sistema.receitanet.net/api/novo/chatbot");
  });

  /**
   * As duas APIs do ReceitaNet vivem em hosts diferentes. Presumir uniformidade
   * foi exatamente o erro; esta asserção deixa a diferença explícita para quem
   * ler depois.
   */
  it("Chatbot e CallCenter NÃO compartilham base", () => {
    expect(CALLCENTER_BASE_URL).toBe("https://api.receitanet.net/callcenter");
    expect(new URL(CHATBOT_BASE_URL).hostname).not.toBe(
      new URL(CALLCENTER_BASE_URL).hostname,
    );
  });

  it("a chamada sai para o host real", async () => {
    const r = await probe(() => ({ status: 200, body: JSON.stringify(EMPRESA_FLAT) }));
    expect(r.calls[0]).toContain("https://sistema.receitanet.net/api/novo/chatbot/empresa");
  });

  it("a base oficial é aceita quando informada explicitamente", () => {
    expect(
      () => new ReceitanetChatbotClient({ token: TOKEN, baseUrl: CHATBOT_BASE_URL }),
    ).not.toThrow();
  });

  it.each([
    ["host do CallCenter", "https://api.receitanet.net/chatbot"],
    ["host arbitrário", "https://attacker.example.com/api/novo/chatbot"],
    ["sufixo enganoso", "https://sistema.receitanet.net.attacker.com/api/novo/chatbot"],
    ["http", "http://sistema.receitanet.net/api/novo/chatbot"],
    ["caminho fora do base", "https://sistema.receitanet.net/api/novo/outro"],
  ])("continua recusando: %s", (_l, baseUrl) => {
    expect(() => new ReceitanetChatbotClient({ token: TOKEN, baseUrl })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Schema flat, sem wrapper
// ---------------------------------------------------------------------------

describe("`/empresa` devolve os campos na RAIZ", () => {
  it("CONTROLE POSITIVO: 200 + schema flat + success=true => OK", async () => {
    const r = await probe(() => ({ status: 200, body: JSON.stringify(EMPRESA_FLAT) }));
    expect(r.ok).toBe(true);
    expect(r.code).toBe("OK");
  });

  /**
   * Só `success` é lido. Um parser que exigisse `payload.empresa` falharia
   * contra a resposta real — foi essa suposição que o teste manual desmentiu.
   */
  it("success=true sozinho basta, sem nenhum outro campo", async () => {
    const r = await probe(() => ({ status: 200, body: JSON.stringify({ success: true }) }));
    expect(r.ok).toBe(true);
  });

  it("REGRESSÃO: um wrapper `empresa` NÃO é exigido nem aceito como fonte", async () => {
    // Forma que NÃO existe no contrato: `success` só dentro do wrapper.
    const r = await probe(() => ({
      status: 200,
      body: JSON.stringify({ empresa: { success: true, nome: "X" } }),
    }));
    // Sem `success` na raiz, a resposta não é confiável.
    expect(r.ok).toBe(false);
    expect(r.code).toBe("INVALID_RESPONSE");
  });

  it("success=false vira falha do catálogo, sem ecoar a msg", async () => {
    const r = await probe(() => ({
      status: 200,
      body: JSON.stringify({ success: false, msg: "token invalido do provider" }),
    }));

    expect(r.ok).toBe(false);
    expect(r.code).toBe("AUTHENTICATION_FAILED");
    expect(r.message).not.toContain("token invalido do provider");
  });

  it.each([
    ["sem success", JSON.stringify({ nome: "X" })],
    ["success como string", JSON.stringify({ success: "true" })],
    ["success como número", JSON.stringify({ success: 1 })],
    ["success nulo", JSON.stringify({ success: null })],
    ["array", JSON.stringify([EMPRESA_FLAT])],
    ["JSON inválido", "{isso nao e json"],
  ])("INVALID_RESPONSE: %s", async (_l, body) => {
    const r = await probe(() => ({ status: 200, body }));
    expect(r.code).toBe("INVALID_RESPONSE");
  });

  it("2xx que não seja 200 também é aceito quando o corpo confere", async () => {
    const r = await probe(() => ({ status: 202, body: JSON.stringify(EMPRESA_FLAT) }));
    expect(r.ok).toBe(true);
  });

  it.each([
    [401, "AUTHENTICATION_FAILED"],
    [403, "AUTHENTICATION_FAILED"],
    [500, "UPSTREAM_UNAVAILABLE"],
    [404, "UPSTREAM_UNAVAILABLE"],
  ])("HTTP %s => %s", async (status, code) => {
    const r = await probe(() => ({ status: status as number, body: "{}" }));
    expect(r.code).toBe(code);
  });

  it("Content-Type não-JSON continua recusado", async () => {
    const r = await probe(() => ({
      status: 200,
      body: "<html>portal</html>",
      contentType: "text/html",
    }));
    expect(r.code).toBe("INVALID_RESPONSE");
  });
});

// ---------------------------------------------------------------------------
// Nada de empresa, nada de token
// ---------------------------------------------------------------------------

describe("A sonda não carrega dado da empresa nem o token", () => {
  /**
   * A resposta traz nome, CNPJ, endereço e telefones. Nada disso é lido, e o
   * retorno é um booleano — não há por onde vazar.
   */
  it("REGRESSÃO: o retorno é booleano, sem campo empresarial", async () => {
    const { client } = clientWith(() => ({
      status: 200,
      body: JSON.stringify(EMPRESA_FLAT),
    }));
    const result = await client.verificarCredencial();

    expect(result).toBe(true);
    const serialized = JSON.stringify(result);
    for (const campo of [
      EMPRESA_FLAT.nome,
      EMPRESA_FLAT.cnpj,
      EMPRESA_FLAT.endereco,
      EMPRESA_FLAT.telefone1,
      EMPRESA_FLAT.telefone2,
    ]) {
      expect(serialized).not.toContain(campo);
    }
  });

  it("REGRESSÃO: nenhum erro carrega o token, a URL ou o corpo", async () => {
    const casos: { status: number; body: string; contentType?: string }[] = [
      { status: 401, body: JSON.stringify({ msg: "nao autorizado" }) },
      { status: 500, body: JSON.stringify(EMPRESA_FLAT) },
      { status: 200, body: JSON.stringify({ success: false, msg: "recusado" }) },
      { status: 200, body: "<html>x</html>", contentType: "text/html" },
      { status: 200, body: "{quebrado" },
    ];

    for (const caso of casos) {
      const r = await probe(() => caso);
      const message = r.message ?? "";
      expect(message).not.toContain(TOKEN);
      // A URL carrega o token na query string — não pode aparecer inteira.
      expect(message).not.toContain("sistema.receitanet.net");
      expect(message).not.toContain(EMPRESA_FLAT.cnpj);
      expect(message).not.toContain("recusado");
      expect(message).not.toContain("nao autorizado");
    }
  });

  it("falha de rede não ecoa o erro original (que carrega a URL)", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new TypeError(
        `fetch failed: https://sistema.receitanet.net/api/novo/chatbot/empresa?token=${TOKEN}`,
      );
    };
    const client = new ReceitanetChatbotClient({ token: TOKEN, fetchImpl });

    let message = "";
    try {
      await client.verificarCredencial();
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).not.toContain(TOKEN);
    expect(message).not.toContain("sistema.receitanet.net");
  });
});
