import { describe, it, expect, beforeEach, vi } from "vitest";
import { ReceitanetAdapter } from "@/integrations/ReceitanetAdapter";
import {
  ReceitanetCallCenterClient,
  type FetchLike,
} from "@/integrations/receitanet/CallCenterClient";
import { IntegrationError, isIntegrationError } from "@/integrations/errors";
import { prisma } from "@/lib/prisma";
import { resolveCompanyAdapter } from "@/lib/erp-adapter";
import { saveCredentialFor } from "@/lib/erp-credential-store";
import {
  apiRequest,
  createTokenFor,
  seedTestData,
  type TestFixture,
} from "./helpers";

/**
 * Nenhum teste deste arquivo toca a API real do ReceitaNet.
 *
 * O transporte é injetado (`fetchImpl`), então cada modo de falha — 401, 404,
 * 500, timeout, JSON inválido, payload incompleto — é exercitado de forma
 * determinística e a suíte nunca depende de internet.
 *
 * Os fixtures abaixo são derivados do OpenAPI oficial da CallCenter, não de
 * respostas reais capturadas.
 */

let fixture: TestFixture;
beforeEach(async () => {
  fixture = await seedTestData();
});

// ---------------------------------------------------------------------------
// Transporte falso, com gravação do que foi enviado
// ---------------------------------------------------------------------------

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function recorder(
  respond: (url: string) => { status: number; body: string } | Promise<never>,
) {
  const calls: Recorded[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    const result = await respond(url);
    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      text: async () => result.body,
    };
  };
  return { calls, fetchImpl };
}

const CLIENTE_RESUMO = {
  idCliente: 15678,
  razaoSocial: "Cliente Exemplo",
  login: "cliente.exemplo",
  cpfcnpj: "44911891882",
  cep: "19000-000",
  endereco: "Rua Exemplo",
  cidade: "Presidente Prudente",
  bairro: "Centro",
  uf: "sp",
};

const CLIENTE_DETALHE = {
  idCliente: 15678,
  razaoSocial: "Cliente Exemplo",
  cpfCnpj: "44911891882",
  contratoStatusDisplay: "Ativo",
  contratoStatus: 1,
  cep: "19000-000",
  endereco: "Rua Exemplo",
  cidade: "Presidente Prudente",
  bairro: "Centro",
  uf: "SP",
  planos: [{ descricao: "Plano Fibra 500M", quantidade: 1, valor: 99.9 }],
  tecnologia: 3,
  servidor: { manutencao: false },
};

function adapterWith(
  respond: (url: string) => { status: number; body: string } | Promise<never>,
) {
  const rec = recorder(respond);
  return {
    ...rec,
    adapter: new ReceitanetAdapter({ token: "token-secreto-abc", fetchImpl: rec.fetchImpl }),
  };
}

// ---------------------------------------------------------------------------
// Transporte
// ---------------------------------------------------------------------------

describe("CallCenter — transporte", () => {
  it("envia form-urlencoded, token no HEADER e nada na URL", async () => {
    const { adapter, calls } = adapterWith(() => ({
      status: 200,
      body: JSON.stringify([CLIENTE_RESUMO]),
    }));

    await adapter.searchCustomers({ document: "449.118.918-82" });

    const call = calls[0];
    expect(call.method).toBe("POST");
    expect(call.url).toBe("https://api.receitanet.net/callcenter/v1/clientes");
    expect(call.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    // O OpenAPI não aceita JSON nestas rotas.
    expect(call.headers["Content-Type"]).not.toContain("json");
    expect(call.headers.token).toBe("token-secreto-abc");
    // Documento normalizado para só dígitos, como o contrato descreve.
    expect(call.body).toBe("cpfcnpj=44911891882");

    // O token NÃO pode estar na URL nem no corpo.
    expect(call.url).not.toContain("token");
    expect(call.url).not.toContain("token-secreto-abc");
    expect(call.body).not.toContain("token-secreto-abc");
  });

  it("um filtro por chamada, na ordem de precisão", async () => {
    const { adapter, calls } = adapterWith(() => ({ status: 200, body: "[]" }));

    await adapter.searchCustomers({ name: "Ana", document: "111", phone: "222" });
    expect(calls[0].body).toBe("cpfcnpj=111");

    await adapter.searchCustomers({ name: "Ana", phone: "222" });
    expect(calls[1].body).toBe("phone=222");

    await adapter.searchCustomers({ name: "Ana Maria" });
    expect(calls[2].body).toBe("nome=Ana+Maria");
  });

  it("/ping é GET, sem token e sem corpo", async () => {
    const rec = recorder(() => ({ status: 200, body: "" }));
    const client = new ReceitanetCallCenterClient({
      token: "t",
      fetchImpl: rec.fetchImpl,
    });
    expect(await client.ping()).toBe(true);
    expect(rec.calls[0].method).toBe("GET");
    expect(rec.calls[0].url).toBe("https://api.receitanet.net/callcenter/ping");
    expect(rec.calls[0].headers.token).toBeUndefined();
  });

  it("cliente sem token não é construído", () => {
    expect(() => new ReceitanetCallCenterClient({ token: "" })).toThrow();
  });

  it.each([
    [401, "AUTHENTICATION_FAILED"],
    [403, "AUTHENTICATION_FAILED"],
    [404, "CUSTOMER_NOT_FOUND"],
    [429, "RATE_LIMITED"],
    [500, "UPSTREAM_UNAVAILABLE"],
    [503, "UPSTREAM_UNAVAILABLE"],
    [418, "INVALID_RESPONSE"],
  ])("HTTP %i vira %s", async (status, code) => {
    const { adapter } = adapterWith(() => ({ status, body: "{}" }));
    await expect(adapter.searchCustomers({ document: "1" })).rejects.toSatisfy(
      (e: unknown) => isIntegrationError(e) && e.code === code,
    );
  });

  it("timeout vira TIMEOUT, não UPSTREAM_UNAVAILABLE", async () => {
    const { adapter } = adapterWith(() => {
      const error = new Error("aborted");
      error.name = "AbortError";
      return Promise.reject(error);
    });
    await expect(adapter.searchCustomers({ document: "1" })).rejects.toSatisfy(
      (e: unknown) => isIntegrationError(e) && e.code === "TIMEOUT",
    );
  });

  it("falha de rede vira UPSTREAM_UNAVAILABLE", async () => {
    const { adapter } = adapterWith(() => Promise.reject(new Error("ECONNREFUSED")));
    await expect(adapter.searchCustomers({ document: "1" })).rejects.toSatisfy(
      (e: unknown) => isIntegrationError(e) && e.code === "UPSTREAM_UNAVAILABLE",
    );
  });

  it("JSON inválido vira INVALID_RESPONSE", async () => {
    const { adapter } = adapterWith(() => ({ status: 200, body: "<html>erro</html>" }));
    await expect(adapter.searchCustomers({ document: "1" })).rejects.toSatisfy(
      (e: unknown) => isIntegrationError(e) && e.code === "INVALID_RESPONSE",
    );
  });

  it("nenhuma mensagem de erro renderizável carrega token ou URL", async () => {
    const { adapter } = adapterWith(() => ({ status: 401, body: "{}" }));
    try {
      await adapter.searchCustomers({ document: "1" });
      throw new Error("deveria ter lançado");
    } catch (error) {
      expect(isIntegrationError(error)).toBe(true);
      const message = (error as { userMessage: string }).userMessage;
      expect(message).not.toContain("token-secreto-abc");
      expect(message).not.toContain("api.receitanet.net");
    }
  });
});

// ---------------------------------------------------------------------------
// Busca e detalhe
// ---------------------------------------------------------------------------

describe("CallCenter — busca e detalhe", () => {
  it("normaliza o resumo para o DTO interno", async () => {
    const { adapter } = adapterWith(() => ({
      status: 200,
      body: JSON.stringify([CLIENTE_RESUMO]),
    }));

    const [hit] = await adapter.searchCustomers({ document: "44911891882" });

    expect(hit).toEqual({
      externalId: "15678",
      name: "Cliente Exemplo",
      document: "44911891882",
      login: "cliente.exemplo",
      address: "Rua Exemplo",
      district: "Centro",
      city: "Presidente Prudente",
      state: "SP",
      zipCode: "19000-000",
    });
    // Nenhum campo bruto do provider atravessa.
    expect(Object.keys(hit)).not.toContain("razaoSocial");
    expect(Object.keys(hit)).not.toContain("idCliente");
  });

  /**
   * Este teste já afirmou o contrário — que corpo de erro virava lista vazia —
   * e com isso fixou o defeito como comportamento esperado.
   *
   * A justificativa original era que "Informe ao menos 1 filtro." chega como
   * objeto no `oneOf` do contrato. Ela não se sustenta: busca sem filtro é
   * barrada nas duas camadas antes de sair daqui, então esse corpo específico
   * é inalcançável. O que de fato chega neste ponto é OUTRO erro qualquer — e
   * apresentá-lo como lista vazia é o que fazia o operador ler o ERP recusando
   * a consulta como cliente inexistente.
   */
  it("resposta de erro em forma de objeto é exceção, não lista vazia", async () => {
    const { adapter } = adapterWith(() => ({
      status: 200,
      body: JSON.stringify({ success: false, message: "Informe ao menos 1 filtro." }),
    }));

    let code = "SEM ERRO";
    try {
      await adapter.searchCustomers({ document: "1" });
    } catch (error) {
      code = isIntegrationError(error) ? error.code : "desconhecido";
    }
    expect(code).toBe("INVALID_RESPONSE");
  });

  it("detalhe traz plano, tecnologia crua e manutenção", async () => {
    const { adapter } = adapterWith(() => ({
      status: 200,
      body: JSON.stringify(CLIENTE_DETALHE),
    }));

    const detail = await adapter.getCustomerDetail("15678");

    expect(detail.plan).toBe("Plano Fibra 500M");
    // Código CRU: o contrato não documenta o significado do inteiro.
    expect(detail.technology).toBe("3");
    expect(detail.contractStatus).toBe("Ativo");
    expect(detail.serverMaintenance).toBe(false);
  });

  it("aceita cpfCnpj e cpfcnpj — os dois schemas divergem no contrato", async () => {
    const { adapter } = adapterWith(() => ({
      status: 200,
      body: JSON.stringify({ ...CLIENTE_DETALHE, cpfCnpj: undefined, cpfcnpj: "999" }),
    }));
    expect((await adapter.getCustomerDetail("15678")).document).toBe("999");
  });

  it("payload incompleto não inventa valor — campo ausente vira null", async () => {
    const { adapter } = adapterWith(() => ({
      status: 200,
      body: JSON.stringify({ idCliente: 1, razaoSocial: "Só o nome" }),
    }));

    const detail = await adapter.getCustomerDetail("1");
    expect(detail.address).toBeNull();
    expect(detail.plan).toBeNull();
    expect(detail.technology).toBeNull();
    expect(detail.serverMaintenance).toBeNull();
    expect(detail.zipCode).toBeNull();
  });

  it("externalId não numérico não vira chamada ao provider", async () => {
    const { adapter, calls } = adapterWith(() => ({ status: 200, body: "{}" }));
    await expect(adapter.getCustomerDetail("nao-numerico")).rejects.toSatisfy(
      (e: unknown) => isIntegrationError(e) && e.code === "CUSTOMER_NOT_FOUND",
    );
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Conectividade
// ---------------------------------------------------------------------------

describe("CallCenter — conectividade", () => {
  const ref = { externalId: "15678", document: null, name: "x" };

  function connectivityAdapter(acesso: unknown, detalhe?: unknown) {
    return adapterWith((url) => ({
      status: 200,
      body: JSON.stringify(
        url.includes("verificar-acesso") ? acesso : (detalhe ?? CLIENTE_DETALHE),
      ),
    }));
  }

  it("status 1 = ONLINE", async () => {
    const { adapter } = connectivityAdapter({ idCliente: 15678, status: 1 });
    const obs = await adapter.fetchCustomerConnectivity(ref);
    expect(obs.status).toBe("ONLINE");
    // O contrato não devolve instante de mudança — não inventar.
    expect(obs.sourceUpdatedAt).toBeNull();
  });

  it("status 2 = OFFLINE", async () => {
    const { adapter } = connectivityAdapter({ idCliente: 15678, status: 2 });
    expect((await adapter.fetchCustomerConnectivity(ref)).status).toBe("OFFLINE");
  });

  it("traz tecnologia e manutenção junto do estado", async () => {
    const { adapter } = connectivityAdapter({ idCliente: 15678, status: 1 });
    const obs = await adapter.fetchCustomerConnectivity(ref);
    expect(obs.technology).toBe("3");
    expect(obs.serverMaintenance).toBe(false);
  });

  it("falha ao buscar o detalhe NÃO custa o estado", async () => {
    const { adapter } = adapterWith((url) =>
      url.includes("verificar-acesso")
        ? { status: 200, body: JSON.stringify({ idCliente: 1, status: 1 }) }
        : { status: 500, body: "{}" },
    );
    const obs = await adapter.fetchCustomerConnectivity(ref);
    // O essencial sobrevive; o acessório fica nulo.
    expect(obs.status).toBe("ONLINE");
    expect(obs.technology).toBeNull();
  });

  it("status fora do enum vira INVALID_RESPONSE, NUNCA OFFLINE", async () => {
    for (const acesso of [
      { idCliente: 1, status: 0 },
      { idCliente: 1, status: 3 },
      { idCliente: 1 },
      {},
    ]) {
      const { adapter } = connectivityAdapter(acesso);
      await expect(adapter.fetchCustomerConnectivity(ref)).rejects.toSatisfy(
        (e: unknown) => isIntegrationError(e) && e.code === "INVALID_RESPONSE",
      );
    }
  });

  it.each([
    [401, "AUTHENTICATION_FAILED"],
    [404, "CUSTOMER_NOT_FOUND"],
    [500, "UPSTREAM_UNAVAILABLE"],
  ])("erro HTTP %i NUNCA vira OFFLINE", async (status, code) => {
    const { adapter } = adapterWith(() => ({ status, body: "{}" }));
    await expect(adapter.fetchCustomerConnectivity(ref)).rejects.toSatisfy(
      (e: unknown) =>
        isIntegrationError(e) &&
        e.code === code &&
        // A garantia central: nenhum caminho de erro produz um estado.
        !("status" in (e as object) && (e as { status?: string }).status === "OFFLINE"),
    );
  });

  it("timeout e JSON inválido também não viram OFFLINE", async () => {
    const abort = adapterWith(() => {
      const e = new Error("x");
      e.name = "AbortError";
      return Promise.reject(e);
    });
    await expect(abort.adapter.fetchCustomerConnectivity(ref)).rejects.toSatisfy(
      (e: unknown) => isIntegrationError(e) && e.code === "TIMEOUT",
    );

    const garbage = adapterWith(() => ({ status: 200, body: "nao é json" }));
    await expect(garbage.adapter.fetchCustomerConnectivity(ref)).rejects.toSatisfy(
      (e: unknown) => isIntegrationError(e) && e.code === "INVALID_RESPONSE",
    );
  });
});

// ---------------------------------------------------------------------------
// testConnection — alcançável ≠ credencial validada
// ---------------------------------------------------------------------------

describe("CallCenter — testConnection", () => {
  it("ping falhando: não alcançável, credencial não verificada", async () => {
    const { adapter } = adapterWith(() => ({ status: 502, body: "" }));
    const r = await adapter.testConnection();
    expect(r.ok).toBe(false);
    expect(r.reachable).toBe(false);
    expect(r.credentialValidated).toBe(false);
    expect(r.message).toContain("Credencial não foi verificada");
  });

  it("ping OK + 401: alcançável, credencial recusada", async () => {
    const { adapter } = adapterWith((url) =>
      url.endsWith("/ping") ? { status: 200, body: "" } : { status: 401, body: "{}" },
    );
    const r = await adapter.testConnection();
    // O ponto do finding: ping verde NÃO pode significar "conectado".
    expect(r.reachable).toBe(true);
    expect(r.credentialValidated).toBe(false);
    expect(r.ok).toBe(false);
  });

  it("ping OK + chamada autenticada aceita: os dois verdes", async () => {
    const { adapter } = adapterWith((url) =>
      url.endsWith("/ping") ? { status: 200, body: "" } : { status: 200, body: "[]" },
    );
    const r = await adapter.testConnection();
    expect(r.reachable).toBe(true);
    expect(r.credentialValidated).toBe(true);
    expect(r.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Credencial
// ---------------------------------------------------------------------------

describe("Resolução da credencial", () => {
  it("ReceitaNet sem credencial configurada falha fechado", async () => {
    await prisma.eRPIntegration.create({
      data: { companyId: fixture.companyA.id, provider: "RECEITANET", name: "RN", enabled: true },
    });
    await expect(
      resolveCompanyAdapter(fixture.companyA.id, "RECEITANET"),
    ).rejects.toSatisfy(
      (e: unknown) => isIntegrationError(e) && e.code === "AUTHENTICATION_FAILED",
    );
  });

  it("MOCK não exige credencial", async () => {
    const adapter = await resolveCompanyAdapter(fixture.companyA.id, "MOCK");
    expect(adapter.provider).toBe("MOCK");
  });

  /**
   * Regressão da busca que devolvia 502 com a credencial correta no banco.
   *
   * O token é gravado enquanto a integração ainda é MOCK — e é assim que ele
   * chega ao banco no fluxo real, porque `provider` só é persistido pela rota
   * de teste de conexão. O ciphertext fica ligado por AAD a `(empresa, MOCK)`.
   *
   * Pedir o adapter do ReceitaNet NÃO pode entregar esse segredo. O vínculo
   * AAD era conferido apenas contra o provider gravado na linha, nunca contra
   * o provider que o chamador pediu: a linha ainda dizia MOCK, o decrypt
   * passava, e o token seguia no header `token` para `api.receitanet.net`.
   * Um segredo gravado para um provedor viajava para outro.
   */
  it("credencial gravada sob outro provider não é entregue ao adapter pedido", async () => {
    await prisma.eRPIntegration.create({
      data: {
        companyId: fixture.companyA.id,
        provider: "MOCK",
        name: "Mock ERP",
        enabled: true,
      },
    });
    await saveCredentialFor(
      fixture.companyA.id,
      fixture.adminA.id,
      "MOCK",
      "CALLCENTER",
      "token-gravado-sob-mock",
    );

    await expect(
      resolveCompanyAdapter(fixture.companyA.id, "RECEITANET"),
    ).rejects.toSatisfy(
      (e: unknown) => isIntegrationError(e) && e.code === "AUTHENTICATION_FAILED",
    );
  });

  /**
   * Este teste gravava no store LEGADO (`ERPIntegration.credential*`) e
   * provava que o adapter o lia. Depois do cutover da v0.7.1 ele prova o
   * oposto do que provava: a credencial vem de `ERPCredential`, endereçada
   * por (empresa, provider, API).
   */
  it("credencial do CALLCENTER no store novo é a entregue ao adapter", async () => {
    await prisma.eRPIntegration.create({
      data: {
        companyId: fixture.companyA.id,
        provider: "RECEITANET",
        name: "RN",
        enabled: true,
      },
    });
    await saveCredentialFor(
      fixture.companyA.id,
      fixture.adminA.id,
      "RECEITANET",
      "CALLCENTER",
      "token-gravado-sob-receitanet",
    );

    const adapter = await resolveCompanyAdapter(
      fixture.companyA.id,
      "RECEITANET",
    );
    expect(adapter.provider).toBe("RECEITANET");
  });
});

// ---------------------------------------------------------------------------
// Troca de provider: o teste de conexão não pode aprovar o que ele apaga
// ---------------------------------------------------------------------------

describe("Teste de conexão na troca de provider (regressão do 502)", () => {
  /**
   * O caminho exato que deixou a integração verde e sem credencial.
   *
   * Um clique só fazia três coisas incompatíveis: validava a credencial ligada
   * ao provider ANTIGO contra a API do provider NOVO, gravava `lastTestStatus`
   * OK, e então apagava essa mesma credencial por causa da troca. O operador
   * ficava com uma integração que se anunciava saudável e sem token — e toda
   * busca seguinte morria em `AUTHENTICATION_FAILED`, que a rota traduz para
   * HTTP 502.
   *
   * Nenhuma rede é tocada aqui: a resolução do adapter falha antes do HTTP.
   * Se este teste voltar a depender de internet, a regressão voltou.
   */
  it("trocar de provider não reporta conexão OK com a credencial antiga", async () => {
    await prisma.eRPIntegration.create({
      data: {
        companyId: fixture.companyA.id,
        provider: "MOCK",
        name: "Mock ERP",
        enabled: true,
      },
    });
    await saveCredentialFor(
      fixture.companyA.id,
      fixture.adminA.id,
      "MOCK",
      "CALLCENTER",
      "token-gravado-sob-mock",
    );

    const { POST } = await import("@/app/api/integrations/test-connection/route");
    const token = await createTokenFor(fixture.adminA.id);
    const res = await POST(
      apiRequest(
        "/api/integrations/test-connection",
        { method: "POST", body: { provider: "RECEITANET" } },
        token,
      ),
    );
    expect(res.status).toBe(200);
    const payload = await res.json();

    // A credencial antiga continua sendo apagada — isso estava certo.
    expect(payload.data.invalidatedCredential).toBe(true);
    // O que estava errado: aprovar a integração enquanto a apaga.
    expect(payload.data.result.ok).toBe(false);
    expect(payload.data.result.credentialValidated).toBe(false);

    /**
     * A mensagem, e não só `ok`, é o que separa a correção do acaso.
     *
     * Sem rede, o bug antigo também produzia `ok: false` — mas por "a API não
     * respondeu", depois de já ter mandado o token para lá. A recusa correta
     * acontece ANTES de qualquer HTTP, por falta de credencial para este
     * provider, e é essa a única mensagem aceitável aqui.
     */
    expect(payload.data.result.reachable).toBe(false);
    expect(payload.data.result.message).toBe(
      new IntegrationError("AUTHENTICATION_FAILED", "RECEITANET").userMessage,
    );

    const row = await prisma.eRPIntegration.findUniqueOrThrow({
      where: { companyId: fixture.companyA.id },
      select: { provider: true, lastTestStatus: true, credentialCiphertext: true },
    });
    expect(row.provider).toBe("RECEITANET");
    expect(row.credentialCiphertext).toBeNull();
    // A tela lê este campo. OK aqui é a mentira que produziu o 502.
    expect(row.lastTestStatus).toBe("ERROR");
  });
});

// ---------------------------------------------------------------------------
// Rotas: perfis, schema e Same-Origin
// ---------------------------------------------------------------------------

describe("Rotas de busca no ERP", () => {
  async function search(userId: string, body: unknown, headers?: Record<string, string>) {
    const { POST } = await import("@/app/api/integrations/customers/search/route");
    const token = await createTokenFor(userId);
    return POST(
      apiRequest("/api/integrations/customers/search", { method: "POST", body, ...(headers ? { headers } : {}) }, token),
    );
  }

  it("TECHNICIAN não recebe busca global de clientes", async () => {
    const res = await search(fixture.techA.id, { name: "Ana" });
    expect(res.status).toBe(403);
  });

  it("sem sessão é 401", async () => {
    const { POST } = await import("@/app/api/integrations/customers/search/route");
    const res = await POST(
      apiRequest("/api/integrations/customers/search", { method: "POST", body: { name: "Ana" } }),
    );
    expect(res.status).toBe(401);
  });

  it("Origin de terceiros é rejeitado", async () => {
    const res = await search(fixture.adminA.id, { name: "Ana" }, { Origin: "https://evil.example.com" });
    expect(res.status).toBe(403);
  });

  it("schema strict recusa companyId e busca sem filtro", async () => {
    expect((await search(fixture.adminA.id, { name: "Ana", companyId: fixture.companyB.id })).status).toBe(400);
    expect((await search(fixture.adminA.id, {})).status).toBe(400);
    expect((await search(fixture.adminA.id, { name: "   " })).status).toBe(400);
  });

  it("import: schema aceita SOMENTE externalId", async () => {
    const { POST } = await import("@/app/api/integrations/customers/import/route");
    const token = await createTokenFor(fixture.adminA.id);
    const res = await POST(
      apiRequest(
        "/api/integrations/customers/import",
        { method: "POST", body: { externalId: "1", name: "Injetado", companyId: fixture.companyB.id } },
        token,
      ),
    );
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Importação de cliente
// ---------------------------------------------------------------------------

describe("Importação de cliente do ERP", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  async function importWith(
    respond: (url: string) => { status: number; body: string },
    externalId = "15678",
  ) {
    vi.doMock("@/lib/erp-adapter", () => ({
      resolveCompanyAdapter: async () =>
        new ReceitanetAdapter({ token: "t", fetchImpl: recorder(respond).fetchImpl }),
    }));
    const mod = await import("@/lib/erp-customer-lookup");
    return mod.importErpCustomer(fixture.companyA.id, fixture.adminA.id, externalId);
  }

  beforeEach(async () => {
    await prisma.eRPIntegration.create({
      data: { companyId: fixture.companyA.id, provider: "RECEITANET", name: "RN", enabled: true },
    });
  });

  it("cria o Customer quando não existe", async () => {
    const result = await importWith(() => ({ status: 200, body: JSON.stringify(CLIENTE_DETALHE) }));
    expect(result.outcome).toBe("CREATED");

    const row = await prisma.customer.findUniqueOrThrow({ where: { id: result.customerId } });
    expect(row.externalProvider).toBe("RECEITANET");
    expect(row.externalId).toBe("15678");
    expect(row.city).toBe("Presidente Prudente");
    // NUNCA inventados: o contrato CallCenter não devolve estes campos.
    expect(row.number).toBeNull();
    expect(row.phone).toBeNull();
    expect(row.latitude).toBeNull();
    expect(row.longitude).toBeNull();
  });

  it("reimportar não duplica", async () => {
    const first = await importWith(() => ({ status: 200, body: JSON.stringify(CLIENTE_DETALHE) }));
    const second = await importWith(() => ({ status: 200, body: JSON.stringify(CLIENTE_DETALHE) }));
    expect(second.outcome).toBe("ALREADY_LINKED");
    expect(second.customerId).toBe(first.customerId);
    expect(await prisma.customer.count({ where: { companyId: fixture.companyA.id } })).toBe(1);
  });

  it("cliente já cadastrado à mão é VINCULADO, não duplicado", async () => {
    const manual = await prisma.customer.create({
      data: { companyId: fixture.companyA.id, name: "Cadastrado à mão", document: "44911891882", number: "123" },
    });

    const result = await importWith(() => ({ status: 200, body: JSON.stringify(CLIENTE_DETALHE) }));

    expect(result.outcome).toBe("LINKED");
    expect(result.customerId).toBe(manual.id);
    expect(await prisma.customer.count({ where: { companyId: fixture.companyA.id } })).toBe(1);

    const row = await prisma.customer.findUniqueOrThrow({ where: { id: manual.id } });
    expect(row.externalId).toBe("15678");
    // Dado local que o ERP não devolve NÃO é apagado.
    expect(row.number).toBe("123");
  });

  it("documento já vinculado a OUTRA identidade externa é conflito, não palpite", async () => {
    await prisma.customer.create({
      data: {
        companyId: fixture.companyA.id,
        name: "Outro vínculo",
        document: "44911891882",
        externalProvider: "RECEITANET",
        externalId: "99999",
      },
    });
    await expect(
      importWith(() => ({ status: 200, body: JSON.stringify(CLIENTE_DETALHE) })),
    ).rejects.toThrow();
  });

  it("campo ausente na resposta não apaga dado local", async () => {
    const manual = await prisma.customer.create({
      data: {
        companyId: fixture.companyA.id,
        name: "Com endereço local",
        document: "44911891882",
        address: "Endereço digitado",
        city: "Cidade local",
      },
    });

    // Resposta mínima: sem endereço, sem cidade.
    await importWith(() => ({
      status: 200,
      body: JSON.stringify({ idCliente: 15678, razaoSocial: "Cliente Exemplo", cpfCnpj: "44911891882" }),
    }));

    const row = await prisma.customer.findUniqueOrThrow({ where: { id: manual.id } });
    expect(row.address).toBe("Endereço digitado");
    expect(row.city).toBe("Cidade local");
  });

  it("não cruza empresa: importar em A não toca cliente de B", async () => {
    await prisma.customer.create({
      data: { companyId: fixture.companyB.id, name: "Cliente da B", document: "44911891882" },
    });
    const result = await importWith(() => ({ status: 200, body: JSON.stringify(CLIENTE_DETALHE) }));
    const row = await prisma.customer.findUniqueOrThrow({ where: { id: result.customerId } });
    expect(row.companyId).toBe(fixture.companyA.id);
    expect(await prisma.customer.count({ where: { companyId: fixture.companyB.id } })).toBe(1);
  });

  /**
   * O detalhe é lido ANTES de qualquer escrita, então uma resposta recusada
   * aborta a importação inteira. A garantia que interessa não é só o erro:
   * é que o cadastro local sobrevive intacto e nenhum cliente fantasma
   * nasce da resposta inválida.
   */
  it("REGRESSÃO: detalhe inválido não altera o cadastro local nem cria fantasma", async () => {
    const antes = await prisma.customer.create({
      data: {
        companyId: fixture.companyA.id,
        name: "Cadastro Local Bom",
        document: "44911891882",
        externalId: "15678",
        externalProvider: "RECEITANET",
        address: "Rua Local",
        city: "Cidade Local",
        number: "123",
      },
    });

    // HTTP 200 sem `razaoSocial`: exatamente o payload que antes produzia
    // um cliente "(sem nome)".
    let code = "SEM ERRO";
    try {
      await importWith(() => ({
        status: 200,
        body: JSON.stringify({ idCliente: 15678 }),
      }));
    } catch (error) {
      code = isIntegrationError(error) ? error.code : "desconhecido";
    }
    expect(code).toBe("INVALID_RESPONSE");

    const depois = await prisma.customer.findUniqueOrThrow({ where: { id: antes.id } });
    expect(depois.name).toBe("Cadastro Local Bom");
    expect(depois.address).toBe("Rua Local");
    expect(depois.city).toBe("Cidade Local");
    expect(depois.number).toBe("123");
    expect(depois.externalId).toBe("15678");
    expect(depois.updatedAt.getTime()).toBe(antes.updatedAt.getTime());

    // Nenhum cliente novo foi fabricado a partir da resposta recusada.
    expect(
      await prisma.customer.count({ where: { companyId: fixture.companyA.id } }),
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// A regra obrigatória: buscar no ERP NÃO torna a OS externa
// ---------------------------------------------------------------------------

describe("Origem da OS após importar cliente do ERP", () => {
  it("OS criada com cliente importado nasce INTERNAL", async () => {
    await prisma.eRPIntegration.create({
      data: { companyId: fixture.companyA.id, provider: "RECEITANET", name: "RN", enabled: true },
    });

    // Cliente COM identidade externa, exatamente como após a importação.
    const customer = await prisma.customer.create({
      data: {
        companyId: fixture.companyA.id,
        name: "Cliente Exemplo",
        externalProvider: "RECEITANET",
        externalId: "15678",
      },
    });

    const { createManualServiceOrder } = await import("@/lib/service-orders");
    const order = await createManualServiceOrder(fixture.companyA.id, fixture.adminA.id, {
      customerId: customer.id,
      typeId: fixture.typeA.id,
      description: "Nasceu no AlfaOS, com cliente vindo do ERP.",
      priority: "NORMAL",
    });

    /**
     * A regra obrigatória da v0.6: a OS nasceu no AlfaOS, então é INTERNAL.
     * O cliente ter identidade externa é irrelevante — origem é onde a OS
     * nasceu, nunca um reflexo dos campos externos (PRD §122).
     */
    expect(order.origin).toBe("INTERNAL");

    const row = await prisma.serviceOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.origin).toBe("INTERNAL");
    expect(row.externalProvider).toBeNull();
    expect(row.externalId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// LOW-1 — base URL é allowlist estrita
//
// `ERPIntegration.baseUrl` é coluna do banco e hoje nenhuma tela a escreve.
// A proteção existe justamente para o dia em que alguém escrever: quem
// carrega o token não pode depender de nenhuma tela ter bom comportamento.
// ---------------------------------------------------------------------------

/** U+0430 CYRILLIC SMALL LETTER A — indistinguível de `a` num navegador. */
const HOMOGRAFO = "https://\u0430pi.receitanet.net/callcenter";

describe("Base URL — allowlist estrita", () => {
  const TOKEN = "token-secreto-abc";

  /** Constrói, faz UMA chamada e devolve o que o transporte viu. */
  async function callWith(baseUrl: string | undefined) {
    const rec = recorder(() => ({ status: 200, body: "[]" }));
    const client = new ReceitanetCallCenterClient({
      token: TOKEN,
      baseUrl,
      fetchImpl: rec.fetchImpl,
    });
    await client.searchClientes({ nome: "Ana" });
    return rec;
  }

  it.each([
    ["URL oficial", "https://api.receitanet.net/callcenter"],
    ["barra final", "https://api.receitanet.net/callcenter/"],
    ["porta 443 explícita", "https://api.receitanet.net:443/callcenter"],
    ["ausente (cai no padrão)", undefined],
    // `URL` normaliza o host para minúsculas; recusar isto seria falso positivo.
    ["host em maiúsculas", "https://API.RECEITANET.NET/callcenter"],
  ])("aceita e normaliza: %s", async (_label, baseUrl) => {
    const rec = await callWith(baseUrl);
    expect(rec.calls[0].url).toBe(
      "https://api.receitanet.net/callcenter/v1/clientes",
    );
  });

  it.each([
    ["http, sem TLS", "http://api.receitanet.net/callcenter"],
    ["host arbitrário", "https://attacker.example.com/callcenter"],
    ["sufixo enganoso", "https://api.receitanet.net.attacker.com/callcenter"],
    ["localhost", "https://localhost/callcenter"],
    ["IP literal", "https://127.0.0.1/callcenter"],
    ["credencial embutida", "https://user:pass@api.receitanet.net/callcenter"],
    ["porta não padrão", "https://api.receitanet.net:8443/callcenter"],
    ["caminho fora do base", "https://api.receitanet.net/outro"],
    ["query anexada", "https://api.receitanet.net/callcenter?x=1"],
    ["URL malformada", "nao-e-uma-url"],
    // `..` é resolvido por `URL` antes da checagem, então o caminho comparado
    // já é o final ("/admin") — não a string original.
    ["traversal no caminho", "https://api.receitanet.net/callcenter/../admin"],
    // Homógrafo cirílico: idêntico aos olhos, punycode distinto para o `URL`.
    ["host homógrafo", HOMOGRAFO],
  ])("recusa: %s", (_label, baseUrl) => {
    let code = "SEM ERRO";
    try {
      new ReceitanetCallCenterClient({ token: TOKEN, baseUrl });
    } catch (error) {
      code = isIntegrationError(error) ? error.code : "desconhecido";
    }
    expect(code).toBe("AUTHENTICATION_FAILED");
  });

  it("base URL recusada não emite requisição — logo, não emite token", () => {
    const rec = recorder(() => ({ status: 200, body: "[]" }));
    expect(
      () =>
        new ReceitanetCallCenterClient({
          token: TOKEN,
          baseUrl: "https://attacker.example.com/callcenter",
          fetchImpl: rec.fetchImpl,
        }),
    ).toThrow();
    // A asserção que importa: o transporte nunca foi acionado, então o token
    // não chegou a existir num header endereçado ao host do atacante.
    expect(rec.calls).toHaveLength(0);
  });

  it("a recusa não devolve a URL para a tela", () => {
    try {
      new ReceitanetCallCenterClient({
        token: TOKEN,
        baseUrl: "https://attacker.example.com/callcenter",
      });
      throw new Error("deveria ter recusado");
    } catch (error) {
      if (!isIntegrationError(error)) throw error;
      expect(error.userMessage).not.toContain("attacker");
    }
  });
});

// ---------------------------------------------------------------------------
// LOW-2 — corpo de erro com HTTP 200 não pode virar lista vazia
// ---------------------------------------------------------------------------

describe("Busca — erro nunca vira \"nenhum cliente encontrado\"", () => {
  async function search(status: number, body: string) {
    const { adapter } = adapterWith(() => ({ status, body }));
    try {
      return { outcome: "lista" as const, result: await adapter.searchCustomers({ name: "Ana" }) };
    } catch (error) {
      return {
        outcome: "erro" as const,
        code: isIntegrationError(error) ? error.code : "desconhecido",
      };
    }
  }

  it("[] do contrato continua significando zero resultados", async () => {
    const r = await search(200, "[]");
    expect(r.outcome).toBe("lista");
    expect(r.outcome === "lista" && r.result).toEqual([]);
  });

  it("array com cliente é normalizado", async () => {
    const r = await search(200, JSON.stringify([CLIENTE_RESUMO]));
    expect(r.outcome).toBe("lista");
    expect(r.outcome === "lista" && r.result[0]).toMatchObject({
      externalId: "15678",
      name: "Cliente Exemplo",
    });
  });

  it("success:false com HTTP 200 é erro, não lista vazia", async () => {
    const r = await search(
      200,
      JSON.stringify({ success: false, message: "Informe ao menos 1 filtro." }),
    );
    expect(r.outcome).toBe("erro");
    expect(r.outcome === "erro" && r.code).toBe("INVALID_RESPONSE");
  });

  it("objeto inesperado com HTTP 200 é erro, não lista vazia", async () => {
    const r = await search(200, JSON.stringify({ total: 0, dados: [] }));
    expect(r.outcome).toBe("erro");
    expect(r.outcome === "erro" && r.code).toBe("INVALID_RESPONSE");
  });

  /**
   * A regressão que dá nome ao finding.
   *
   * Antes da correção os dois casos devolviam `[]`, e o operador não tinha
   * como distinguir ERP recusando a consulta de cliente que não existe lá —
   * e o desfecho provável era um cadastro duplicado, feito à mão.
   */
  it("REGRESSÃO: vazio legítimo e corpo de erro têm desfechos distintos", async () => {
    const vazioLegitimo = await search(200, "[]");
    const corpoDeErro = await search(200, JSON.stringify({ success: false }));

    expect(vazioLegitimo.outcome).toBe("lista");
    expect(corpoDeErro.outcome).toBe("erro");
    expect(vazioLegitimo.outcome).not.toBe(corpoDeErro.outcome);
  });

  it("HTTP 500 continua UPSTREAM_UNAVAILABLE", async () => {
    const r = await search(500, JSON.stringify({ success: false }));
    expect(r.outcome).toBe("erro");
    expect(r.outcome === "erro" && r.code).toBe("UPSTREAM_UNAVAILABLE");
  });
});

// ---------------------------------------------------------------------------
// getCliente — HTTP 200 com forma inesperada não vira cliente
//
// O contrato declara `idCliente` e `razaoSocial` como os únicos campos sempre
// presentes. Sem validá-los, um 200 malformado atravessava o mapeamento e
// produzia `externalId` "undefined" com nome "(sem nome)" — um cadastro que
// parece importado do ERP e não corresponde a ninguém.
// ---------------------------------------------------------------------------

describe("Detalhe do cliente — só a forma documentada passa", () => {
  async function detail(status: number, body: string) {
    const { adapter } = adapterWith(() => ({ status, body }));
    try {
      return { outcome: "ok" as const, result: await adapter.getCustomerDetail("15678") };
    } catch (error) {
      return {
        outcome: "erro" as const,
        code: isIntegrationError(error) ? error.code : "desconhecido",
      };
    }
  }

  it("CONTROLE POSITIVO: payload documentado continua funcionando", async () => {
    const r = await detail(200, JSON.stringify(CLIENTE_DETALHE));

    expect(r.outcome).toBe("ok");
    expect(r.outcome === "ok" && r.result).toMatchObject({
      externalId: "15678",
      name: "Cliente Exemplo",
      document: "44911891882",
      city: "Presidente Prudente",
    });
  });

  /**
   * O contrato só garante estes dois campos. Um detalhe sem endereço, plano
   * ou tecnologia é resposta LEGÍTIMA — recusá-la seria inventar contrato
   * mais rígido que o do provider e quebrar cliente que existe de verdade.
   */
  it("CONTROLE POSITIVO: só idCliente + razaoSocial já é payload válido", async () => {
    const r = await detail(
      200,
      JSON.stringify({ idCliente: 15678, razaoSocial: "Cliente Mínimo" }),
    );

    expect(r.outcome).toBe("ok");
    expect(r.outcome === "ok" && r.result.externalId).toBe("15678");
    expect(r.outcome === "ok" && r.result.name).toBe("Cliente Mínimo");
    // Campo ausente vira null, nunca valor inventado.
    expect(r.outcome === "ok" && r.result.city).toBeNull();
  });

  it("success:false com HTTP 200 continua CUSTOMER_NOT_FOUND", async () => {
    const r = await detail(
      200,
      JSON.stringify({ success: false, message: "não localizado" }),
    );

    expect(r.outcome).toBe("erro");
    expect(r.outcome === "erro" && r.code).toBe("CUSTOMER_NOT_FOUND");
  });

  it.each([
    ["sem idCliente", JSON.stringify({ razaoSocial: "Só o nome" })],
    ["sem razaoSocial", JSON.stringify({ idCliente: 15678 })],
    ["razaoSocial em branco", JSON.stringify({ idCliente: 15678, razaoSocial: "   " })],
    ["idCliente como string", JSON.stringify({ idCliente: "15678", razaoSocial: "X" })],
    ["objeto sem nada do contrato", JSON.stringify({ total: 0, dados: [] })],
    ["array", JSON.stringify([CLIENTE_DETALHE])],
    ["array vazio", "[]"],
    ["null", "null"],
    ["string", JSON.stringify("texto")],
    ["booleano", "true"],
    ["numero", "42"],
    ["corpo vazio", ""],
  ])("recusa com INVALID_RESPONSE: %s", async (_label, body) => {
    const r = await detail(200, body);

    expect(r.outcome).toBe("erro");
    expect(r.outcome === "erro" && r.code).toBe("INVALID_RESPONSE");
  });

  /**
   * A regressão que dá nome ao ajuste: qualquer payload recusado tem de
   * virar exceção, nunca um cliente chamado "(sem nome)" com identidade
   * externa "undefined".
   */
  it("REGRESSÃO: nenhum payload inválido produz \"(sem nome)\"", async () => {
    const invalidos = [
      JSON.stringify({ razaoSocial: "Só o nome" }),
      JSON.stringify({ idCliente: 15678 }),
      JSON.stringify({}),
      "null",
    ];

    for (const body of invalidos) {
      const r = await detail(200, body);
      expect(r.outcome).toBe("erro");
      expect(r.outcome === "ok" && r.result.name).not.toBe("(sem nome)");
      expect(r.outcome === "ok" && r.result.externalId).not.toBe("undefined");
    }
  });

  it("HTTP 500 continua UPSTREAM_UNAVAILABLE", async () => {
    const r = await detail(500, JSON.stringify(CLIENTE_DETALHE));

    expect(r.outcome).toBe("erro");
    expect(r.outcome === "erro" && r.code).toBe("UPSTREAM_UNAVAILABLE");
  });
});
