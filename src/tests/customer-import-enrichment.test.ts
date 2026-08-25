import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { decryptConnectionCredential } from "@/lib/connection-credential-cipher";
import {
  apiRequest,
  createTokenFor,
  seedTestData,
  type TestFixture,
} from "./helpers";

/**
 * O caso REAL que falhou em campo.
 *
 * Um cliente já importado numa sessão anterior era "selecionado" pela tela sem
 * passar pela importação — e por isso nunca recebia telefone, e-mail, endereço
 * completo, coordenadas nem acesso PPPoE. O sintoma na OS era "Telefone: Não
 * informado" e "Acesso PPPoE não configurado" num cliente aparentemente
 * importado com sucesso.
 *
 * Nenhum dado real: documento fictício, telefone com prefixo reservado, senha
 * inventada. Nenhum teste toca a rede.
 */

const CPF_FORMATADO = "100.200.300-44";
const CPF_DIGITOS = "10020030044";
const CNPJ_FORMATADO = "10.020.030.0044/55";
const SENHA_REAL = "senha-real-x9";
const TELEFONE = "11900000001";

let fixture: TestFixture;
beforeEach(async () => {
  fixture = await seedTestData();
  vi.doUnmock("@/lib/erp-adapter");
  vi.resetModules();
});

/** Detalhe do CallCenter — documento FORMATADO, como o provider costuma mandar. */
function callCenterDetalhe(document = CPF_FORMATADO) {
  return {
    idCliente: 15678,
    razaoSocial: "Cliente Real",
    cpfCnpj: document,
    login: "cliente.callcenter",
    contratoStatusDisplay: "Ativo",
    endereco: "Rua Real",
    cidade: "Cidade",
    uf: "SP",
  };
}

/**
 * Resposta do Chatbot com `contratos` como OBJETO único — a forma observada na
 * homologação manual, e a que precisa funcionar sem virar NOT_FOUND.
 */
function chatbotObjeto(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    msg: "ok",
    contratos: {
      idCliente: 15678,
      idContrato: 4321,
      razaoSocial: "Cliente Real",
      cpfCnpj: CPF_FORMATADO,
      email: "cliente@exemplo.invalid",
      login: "cliente.chatbot",
      senha: SENHA_REAL,
      telefones: [TELEFONE],
      coordenadas: { x: -22.1, y: -51.4 },
      endereco: {
        endereco: "Rua Real",
        numero: "10",
        complemento: null,
        bairro: "Centro",
        cidade: "Cidade",
        uf: "sp",
        cep: "19000-000",
        referencia: "Perto da praça",
      },
      servidor: { servidor: "SRV", profile: "P", tipo: "PPPOE", ip: null, isManutencao: false },
      planos: [{ descricao: "Plano", quantidade: 1, valor: "99,90" }],
      logins: [{ login: "cliente.chatbot", senha: SENHA_REAL, isPrincipal: true }],
      tecnologia: 3,
      ...overrides,
    },
  };
}

interface Scenario {
  callCenter?: unknown;
  chatbot?: unknown;
  chatbotStatus?: number;
  chatbotThrows?: boolean;
}

/** Roda a importação REAL com os dois transportes falsos. */
async function runImport(scenario: Scenario, externalId = "15678") {
  const chatbotCalls: string[] = [];

  vi.doMock("@/lib/erp-adapter", async () => {
    const { ReceitanetAdapter } = await import("@/integrations/ReceitanetAdapter");
    const { ReceitanetChatbotClient } = await import(
      "@/integrations/receitanet/ChatbotClient"
    );
    return {
      resolveCompanyAdapter: async () =>
        new ReceitanetAdapter({
          token: "t",
          fetchImpl: async () => ({
            ok: true,
            status: 200,
            text: async () => JSON.stringify(scenario.callCenter ?? callCenterDetalhe()),
            contentType: "application/json",
          }),
        }),
      resolveChatbotClient: async () => {
        if (scenario.chatbotThrows) throw new Error("falha inesperada");
        if (scenario.chatbot === null) return null;
        return new ReceitanetChatbotClient({
          token: "t",
          fetchImpl: async (url: string) => {
            chatbotCalls.push(url);
            return {
              ok: (scenario.chatbotStatus ?? 200) < 300,
              status: scenario.chatbotStatus ?? 200,
              text: async () => JSON.stringify(scenario.chatbot ?? chatbotObjeto()),
              contentType: "application/json",
            };
          },
        });
      },
    };
  });

  const mod = await import("@/lib/erp-customer-lookup");
  const result = await mod.importErpCustomer(
    fixture.companyA.id,
    fixture.adminA.id,
    externalId,
  );
  return { result, chatbotCalls };
}

async function setupIntegration() {
  await prisma.eRPIntegration.create({
    data: {
      companyId: fixture.companyA.id,
      provider: "RECEITANET",
      name: "ReceitaNet",
      enabled: true,
    },
  });
  await prisma.company.update({
    where: { id: fixture.companyA.id },
    data: { pppoePasswordPolicy: "DOCUMENT_LAST4" },
  });
}

beforeEach(setupIntegration);

// ---------------------------------------------------------------------------
// O caso real, de ponta a ponta
// ---------------------------------------------------------------------------

describe("Importação real enriquece o cadastro", () => {
  it("CONTROLE POSITIVO: CPF formatado + contratos OBJETO => tudo aplicado", async () => {
    const { result, chatbotCalls } = await runImport({});

    expect(result.outcome).toBe("CREATED");
    expect(result.enrichment.outcome).toBe("SUCCESS");

    const row = await prisma.customer.findUniqueOrThrow({
      where: { id: result.customerId },
    });
    expect(row.phone).toBe(TELEFONE);
    expect(row.email).toBe("cliente@exemplo.invalid");
    expect(row.number).toBe("10");
    expect(row.complement).toContain("Perto da praça");
    expect(row.externalContractId).toBe("4321");
    expect(row.locationSource).toBe("IMPORTED");
    expect(row.locationVerified).toBe(false);
    expect(Number(row.latitude)).toBe(-22.1);
    expect(Number(row.longitude)).toBe(-51.4);

    // O documento formatado NÃO pode chegar cru na query do Chatbot.
    expect(chatbotCalls[0]).toContain(`cpfcnpj=${CPF_DIGITOS}`);
    expect(chatbotCalls[0]).not.toContain("100.200.300-44");
    expect(chatbotCalls[0]).not.toContain("%2E");
  });

  it("a conexão PPPoE nasce com a credencial REAL do Chatbot", async () => {
    const { result } = await runImport({});

    const conn = await prisma.customerConnection.findFirstOrThrow({
      where: { customerId: result.customerId },
    });
    expect(conn.username).toBe("cliente.chatbot");
    expect(conn.usernameSource).toBe("RECEITANET_CHATBOT");
    expect(conn.passwordSource).toBe("RECEITANET_CHATBOT");

    const senha = decryptConnectionCredential(
      {
        ciphertext: conn.credentialCiphertext as string,
        iv: conn.credentialIv as string,
        authTag: conn.credentialAuthTag as string,
      },
      {
        companyId: conn.companyId,
        customerId: conn.customerId,
        connectionId: conn.id,
        type: conn.type,
      },
    );
    expect(senha).toBe(SENHA_REAL);
    // NÃO o palpite dos 4 últimos do CPF.
    expect(senha).not.toBe("0044");
  });

  /**
   * A regressão que dá nome ao ajuste.
   *
   * A tela pulava a importação quando o cliente já existia, e o enriquecimento
   * nunca rodava. Aqui o cliente JÁ está vinculado, e importar de novo tem de
   * preencher o que faltava.
   */
  it("REGRESSÃO: cliente JÁ vinculado é reenriquecido, não ignorado", async () => {
    // Estado exato do campo: importado antes, sem telefone e sem conexão.
    const existente = await prisma.customer.create({
      data: {
        companyId: fixture.companyA.id,
        name: "Cliente Real",
        document: CPF_FORMATADO,
        externalProvider: "RECEITANET",
        externalId: "15678",
        address: "Rua Real",
      },
    });
    expect(existente.phone).toBeNull();

    const { result } = await runImport({});

    expect(result.outcome).toBe("ALREADY_LINKED");
    expect(result.enrichment.outcome).toBe("SUCCESS");

    const row = await prisma.customer.findUniqueOrThrow({ where: { id: existente.id } });
    expect(row.phone).toBe(TELEFONE);
    expect(row.email).toBe("cliente@exemplo.invalid");
    expect(
      await prisma.customerConnection.count({ where: { customerId: existente.id } }),
    ).toBe(1);
  });

  it("REGRESSÃO: reimportar não duplica Customer nem conexão", async () => {
    const primeira = await runImport({});
    const segunda = await runImport({});

    expect(segunda.result.customerId).toBe(primeira.result.customerId);
    expect(
      await prisma.customer.count({ where: { companyId: fixture.companyA.id } }),
    ).toBe(1);
    expect(
      await prisma.customerConnection.count({
        where: { customerId: primeira.result.customerId },
      }),
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Formas de `contratos`
// ---------------------------------------------------------------------------

describe("Formas aceitas de `contratos`", () => {
  it("OBJETO único é um contrato, nunca NOT_FOUND", async () => {
    const { result } = await runImport({ chatbot: chatbotObjeto() });
    expect(result.enrichment.outcome).toBe("SUCCESS");
  });

  it("ARRAY com um é o mesmo contrato", async () => {
    const { result } = await runImport({
      chatbot: { success: true, msg: "ok", contratos: [chatbotObjeto().contratos] },
    });
    expect(result.enrichment.outcome).toBe("SUCCESS");
  });

  it("ARRAY com múltiplos e sem desempate => AMBIGUOUS, nada gravado", async () => {
    const um = chatbotObjeto().contratos;
    const { result } = await runImport({
      chatbot: {
        success: true,
        contratos: [{ ...um, idContrato: 1 }, { ...um, idContrato: 2 }],
      },
    });

    expect(result.enrichment.outcome).toBe("AMBIGUOUS");
    const row = await prisma.customer.findUniqueOrThrow({
      where: { id: result.customerId },
    });
    expect(row.phone).toBeNull();
  });

  it.each([
    ["contratos nulo", { success: true, contratos: null }],
    ["contratos ausente", { success: true }],
    ["array vazio", { success: true, contratos: [] }],
  ])("%s => NOT_FOUND, sem escrita de contato", async (_l, body) => {
    const { result } = await runImport({ chatbot: body });

    expect(result.enrichment.outcome).toBe("NOT_FOUND");
    const row = await prisma.customer.findUniqueOrThrow({
      where: { id: result.customerId },
    });
    expect(row.phone).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Documento
// ---------------------------------------------------------------------------

describe("Normalização do documento na consulta ao Chatbot", () => {
  it("CNPJ formatado também chega só com dígitos", async () => {
    const { chatbotCalls } = await runImport({
      callCenter: callCenterDetalhe(CNPJ_FORMATADO),
      chatbot: chatbotObjeto({ cpfCnpj: CNPJ_FORMATADO }),
    });

    expect(chatbotCalls[0]).toContain("cpfcnpj=10020030004455");
  });

  it("REGRESSÃO: CNPJ não recebe a regra DOCUMENT_LAST4", async () => {
    const semLogins = chatbotObjeto({ logins: [], login: undefined, senha: undefined });
    const { result } = await runImport({
      callCenter: { ...callCenterDetalhe(CNPJ_FORMATADO), login: null },
      chatbot: { ...semLogins, contratos: { ...semLogins.contratos } },
    });

    // Sem login do Chatbot e sem login do CallCenter, nada a provisionar — e o
    // CNPJ jamais deriva senha.
    expect(result.pppoe).toBe("SKIPPED_NO_LOGIN");
    expect(
      await prisma.customerConnection.count({ where: { customerId: result.customerId } }),
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Falha do Chatbot não derruba a importação
// ---------------------------------------------------------------------------

describe("Importação sobrevive à falha do Chatbot", () => {
  it("Chatbot não configurado => cliente importado, enrichment UNAVAILABLE", async () => {
    const { result } = await runImport({ chatbot: null });

    expect(result.outcome).toBe("CREATED");
    expect(result.enrichment.outcome).toBe("UNAVAILABLE");
    expect(result.enrichment.code).toBe("NOT_CONFIGURED");
  });

  it("Chatbot fora do ar => importado, com o código do catálogo", async () => {
    const { result } = await runImport({ chatbotStatus: 500, chatbot: {} });

    expect(result.outcome).toBe("CREATED");
    expect(result.enrichment.outcome).toBe("UNAVAILABLE");
    expect(result.enrichment.code).toBe("UPSTREAM_UNAVAILABLE");
  });

  /**
   * A promessa "o enriquecimento nunca lança" precisa valer para o corpo
   * inteiro. Uma exceção inesperada não pode derrubar uma importação que já
   * concluiu a parte essencial — era esse caminho que virava 500 na tela.
   */
  it("REGRESSÃO: exceção inesperada no enriquecimento NÃO derruba a importação", async () => {
    const { result } = await runImport({ chatbotThrows: true });

    expect(result.outcome).toBe("CREATED");
    expect(result.enrichment.outcome).toBe("UNAVAILABLE");
    // E o cliente existe de verdade.
    expect(
      await prisma.customer.count({ where: { id: result.customerId } }),
    ).toBe(1);
  });

  it("sem Chatbot, o PPPoE ainda vem do login do CallCenter", async () => {
    const { result } = await runImport({ chatbot: null });

    const conn = await prisma.customerConnection.findFirstOrThrow({
      where: { customerId: result.customerId },
    });
    expect(conn.username).toBe("cliente.callcenter");
    expect(conn.usernameSource).toBe("RECEITANET_CALLCENTER");
    // Senha pela política da empresa, já que o CallCenter não expõe credencial.
    expect(conn.passwordSource).toBe("AUTO_DOCUMENT_LAST4");
  });
});

// ---------------------------------------------------------------------------
// A rota devolve o desfecho, sem vazar
// ---------------------------------------------------------------------------

describe("Rota de importação reporta o enriquecimento", () => {
  async function callRoute(scenario: Scenario) {
    const chatbotCalls: string[] = [];
    vi.doMock("@/lib/erp-adapter", async () => {
      const { ReceitanetAdapter } = await import("@/integrations/ReceitanetAdapter");
      const { ReceitanetChatbotClient } = await import(
        "@/integrations/receitanet/ChatbotClient"
      );
      return {
        resolveCompanyAdapter: async () =>
          new ReceitanetAdapter({
            token: "t",
            fetchImpl: async () => ({
              ok: true,
              status: 200,
              text: async () => JSON.stringify(scenario.callCenter ?? callCenterDetalhe()),
              contentType: "application/json",
            }),
          }),
        resolveChatbotClient: async () => {
          if (scenario.chatbot === null) return null;
          return new ReceitanetChatbotClient({
            token: "t",
            fetchImpl: async (url: string) => {
              chatbotCalls.push(url);
              return {
                ok: true,
                status: 200,
                text: async () => JSON.stringify(scenario.chatbot ?? chatbotObjeto()),
                contentType: "application/json",
              };
            },
          });
        },
      };
    });

    const { POST } = await import("@/app/api/integrations/customers/import/route");
    const token = await createTokenFor(fixture.adminA.id);
    return POST(
      apiRequest(
        "/api/integrations/customers/import",
        { method: "POST", body: { externalId: "15678" } },
        token,
      ),
    );
  }

  it("CONTROLE POSITIVO: sucesso devolve outcome SUCCESS", async () => {
    const res = await callRoute({});
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.enrichment.outcome).toBe("SUCCESS");
  });

  it("Chatbot indisponível devolve 200 com o aviso, NUNCA 500", async () => {
    const res = await callRoute({ chatbot: null });

    // Importação parcial é sucesso com ressalva, não erro interno.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.enrichment.outcome).toBe("UNAVAILABLE");
  });

  it("REGRESSÃO: a resposta não carrega senha, telefone nem corpo do provedor", async () => {
    const res = await callRoute({});
    const raw = await res.text();

    expect(raw).not.toContain(SENHA_REAL);
    expect(raw).not.toContain(TELEFONE);
    expect(raw).not.toContain("cliente@exemplo.invalid");
    expect(raw).not.toContain("Perto da praça");
    // Nem os ids de contrato candidatos.
    expect(raw).not.toContain("contractIds");
  });
});
