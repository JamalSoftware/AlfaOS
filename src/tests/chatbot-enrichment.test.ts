import { describe, it, expect, beforeEach } from "vitest";
import {
  normalizeChatbotCustomer,
  selectPrincipalLogin,
} from "@/integrations/chatbot-enrichment";
import { ReceitanetChatbotClient } from "@/integrations/receitanet/ChatbotClient";
import type { FetchLike } from "@/integrations/receitanet/CallCenterClient";
import { isIntegrationError } from "@/integrations/errors";
import { decryptConnectionCredential } from "@/lib/connection-credential-cipher";
import { prisma } from "@/lib/prisma";
import { provisionPppoeFromErp } from "@/lib/pppoe-provisioning";
import { seedTestData, type TestFixture } from "./helpers";

/**
 * Enriquecimento via Chatbot.
 *
 * A API entrega senha de cliente em TEXTO PURO, e é isso que estes testes
 * vigiam: que ela chegue cifrada ao banco e não apareça em mais lugar nenhum.
 *
 * Nenhum dado real: documento fictício de 11 dígitos, senha inventada, e
 * telefone com prefixo reservado.
 */

const CPF_FICTICIO = "10020030044";
const CPF_LAST4 = "0044";
/** Senha que NÃO são os 4 últimos do CPF — é o ponto do teste de prioridade. */
const SENHA_REAL = "x9k2m4";
const TELEFONE = "11900000001";

let fixture: TestFixture;
beforeEach(async () => {
  fixture = await seedTestData();
});

function payload(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    msg: "ok",
    contratos: {
      idCliente: 15678,
      idContrato: 4321,
      razaoSocial: "Cliente Fictício",
      cpfCnpj: CPF_FICTICIO,
      email: "cliente@exemplo.invalid",
      login: "cliente.principal",
      senha: SENHA_REAL,
      telefones: [TELEFONE],
      coordenadas: { x: -22.1234, y: -51.4321 },
      endereco: {
        endereco: "Rua Fictícia",
        numero: null,
        complemento: "Fundos",
        bairro: "Centro",
        cidade: "Cidade",
        uf: "sp",
        cep: "19000-000",
        referencia: "Ao lado da praça",
      },
      servidor: {
        servidor: "SRV-01",
        profile: "PLANO-500",
        tipo: "PPPOE",
        ip: null,
        isManutencao: false,
        interface: "eth0",
        mac: "",
        idSerial: "",
        elementoRede: "",
      },
      planos: [{ descricao: "Plano 500M", quantidade: 1, valor: "99,90" }],
      logins: [
        { login: "cliente.principal", senha: SENHA_REAL, isPrincipal: true },
      ],
      contratoStatusDisplay: "Ativo",
      tecnologia: 3,
      ...overrides,
    },
  };
}

// ---------------------------------------------------------------------------
// Normalização
// ---------------------------------------------------------------------------

describe("Normalização do payload do Chatbot", () => {
  it("CONTROLE POSITIVO: extrai os campos homologados", () => {
    const dto = normalizeChatbotCustomer(payload());

    expect(dto).not.toBeNull();
    expect(dto?.externalId).toBe("15678");
    expect(dto?.contractId).toBe("4321");
    expect(dto?.contractStatus).toBe("Ativo");
    expect(dto?.technologyCode).toBe("3");
  });

  it("coordenadas: x é LATITUDE e y é LONGITUDE", () => {
    const dto = normalizeChatbotCustomer(payload());
    // Inverter aqui poria o cliente do outro lado do mundo, e a nomenclatura
    // x/y do provider torna a inversão fácil de cometer.
    expect(dto?.latitude).toBe(-22.1234);
    expect(dto?.longitude).toBe(-51.4321);
  });

  it("coordenadas ausentes não viram zero", () => {
    const dto = normalizeChatbotCustomer(payload({ coordenadas: {} }));
    // Zero é uma coordenada válida no golfo da Guiné — nunca pode significar
    // "não informado".
    expect(dto?.latitude).toBeNull();
    expect(dto?.longitude).toBeNull();
  });

  it("telefone único é preservado", () => {
    expect(normalizeChatbotCustomer(payload())?.phones).toEqual([TELEFONE]);
  });

  it("múltiplos telefones são todos preservados", () => {
    const dto = normalizeChatbotCustomer(
      payload({ telefones: [TELEFONE, "11900000002"] }),
    );
    expect(dto?.phones).toEqual([TELEFONE, "11900000002"]);
  });

  it("lista de telefones vazia não quebra", () => {
    expect(normalizeChatbotCustomer(payload({ telefones: [] }))?.phones).toEqual([]);
  });

  it("número do endereço nulo permanece nulo, nunca a string 'null'", () => {
    const dto = normalizeChatbotCustomer(payload());
    expect(dto?.address.number).toBeNull();
    expect(JSON.stringify(dto)).not.toContain('"null"');
  });

  it("referência do endereço é preservada", () => {
    // É o que faz o técnico achar a casa quando o número não existe.
    expect(normalizeChatbotCustomer(payload())?.address.reference).toBe(
      "Ao lado da praça",
    );
  });

  it("servidor: campos preenchidos passam, ausentes viram null", () => {
    const dto = normalizeChatbotCustomer(payload());
    expect(dto?.server.server).toBe("SRV-01");
    expect(dto?.server.profile).toBe("PLANO-500");
    expect(dto?.server.networkInterface).toBe("eth0");
    // Cliente offline: ip null, mac/serial/elemento vazios.
    expect(dto?.server.ip).toBeNull();
    expect(dto?.server.mac).toBeNull();
    expect(dto?.server.serial).toBeNull();
    expect(dto?.server.networkElement).toBeNull();
    expect(dto?.server.maintenance).toBe(false);
  });

  it("servidor inteiro ausente não quebra", () => {
    const dto = normalizeChatbotCustomer(payload({ servidor: undefined }));
    expect(dto?.server.server).toBeNull();
    expect(dto?.server.maintenance).toBeNull();
  });

  it.each([
    ["decimal brasileiro", "99,90", 99.9],
    ["milhar brasileiro", "1.234,56", 1234.56],
    ["ponto decimal", "99.90", 99.9],
    ["número puro", 99.9, 99.9],
  ])("valor do plano como String: %s", (_l, valor, esperado) => {
    const dto = normalizeChatbotCustomer(
      payload({ planos: [{ descricao: "P", quantidade: 1, valor }] }),
    );
    expect(dto?.plans[0].value).toBe(esperado);
  });

  it.each([
    ["vazio", ""],
    ["texto", "sob consulta"],
    ["nulo", null],
  ])("valor não numérico vira null, não zero: %s", (_l, valor) => {
    const dto = normalizeChatbotCustomer(
      payload({ planos: [{ descricao: "P", quantidade: 1, valor }] }),
    );
    // Zero pareceria um plano gratuito.
    expect(dto?.plans[0].value).toBeNull();
  });

  it("payload sem contratos devolve null, sem lançar", () => {
    expect(normalizeChatbotCustomer({ success: true })).toBeNull();
    expect(normalizeChatbotCustomer(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Múltiplos logins
// ---------------------------------------------------------------------------

describe("Seleção da conexão principal", () => {
  it("CONTROLE POSITIVO: uma conexão, marcada principal", () => {
    const dto = normalizeChatbotCustomer(payload());
    expect(dto?.logins).toHaveLength(1);
    expect(selectPrincipalLogin(dto!.logins)?.login).toBe("cliente.principal");
  });

  it("múltiplas conexões são todas preservadas", () => {
    const dto = normalizeChatbotCustomer(
      payload({
        logins: [
          { login: "a", senha: "s1", isPrincipal: false },
          { login: "b", senha: "s2", isPrincipal: true },
        ],
      }),
    );
    expect(dto?.logins).toHaveLength(2);
  });

  /**
   * A regressão que importa: a homologação viu o principal no índice 0, mas
   * uma amostra não é ordenação garantida. Assumir a ordem entregaria a
   * credencial errada ao técnico no primeiro cliente fora do padrão.
   */
  it("REGRESSÃO: principal NÃO está no índice 0 e ainda assim é escolhido", () => {
    const dto = normalizeChatbotCustomer(
      payload({
        logins: [
          { login: "secundario", senha: "s1", isPrincipal: false },
          { login: "principal", senha: "s2", isPrincipal: true },
        ],
      }),
    );
    expect(selectPrincipalLogin(dto!.logins)?.login).toBe("principal");
  });

  it("nenhum marcado principal: cai no primeiro, sem inventar", () => {
    const dto = normalizeChatbotCustomer(
      payload({
        logins: [
          { login: "a", senha: "s1", isPrincipal: false },
          { login: "b", senha: "s2", isPrincipal: false },
        ],
      }),
    );
    expect(selectPrincipalLogin(dto!.logins)?.login).toBe("a");
  });

  it("sem logins[], usa o par solto login/senha do contrato", () => {
    const dto = normalizeChatbotCustomer(payload({ logins: undefined }));
    expect(dto?.logins).toHaveLength(1);
    expect(dto?.logins[0].login).toBe("cliente.principal");
    expect(dto?.logins[0].isPrincipal).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Prioridade da senha — a mudança central do addendum
// ---------------------------------------------------------------------------

describe("Credencial real do Chatbot tem precedência sobre a política", () => {
  async function customer() {
    return prisma.customer.create({
      data: {
        companyId: fixture.companyA.id,
        name: "Cliente",
        document: CPF_FICTICIO,
      },
    });
  }

  beforeEach(async () => {
    await prisma.company.update({
      where: { id: fixture.companyA.id },
      data: { pppoePasswordPolicy: "DOCUMENT_LAST4" },
    });
  });

  /**
   * O caso REAL que motivou o addendum: um cliente cuja senha PPPoE é exceção
   * à política. A derivação daria `0044`; a senha verdadeira é outra.
   */
  it("REGRESSÃO: senha real vence os 4 últimos do CPF", async () => {
    const c = await customer();

    await provisionPppoeFromErp(fixture.companyA.id, fixture.adminA.id, {
      customerId: c.id,
      login: "cliente.principal",
      document: CPF_FICTICIO,
      chatbotLogins: [
        { login: "cliente.principal", password: SENHA_REAL, isPrincipal: true },
      ],
    });

    const row = await prisma.customerConnection.findFirstOrThrow({
      where: { customerId: c.id },
    });
    expect(row.passwordSource).toBe("RECEITANET_CHATBOT");
    expect(row.usernameSource).toBe("RECEITANET_CHATBOT");

    const senha = decryptConnectionCredential(
      {
        ciphertext: row.credentialCiphertext!,
        iv: row.credentialIv!,
        authTag: row.credentialAuthTag!,
      },
      {
        companyId: row.companyId,
        customerId: row.customerId,
        connectionId: row.id,
        type: row.type,
      },
    );
    expect(senha).toBe(SENHA_REAL);
    expect(senha).not.toBe(CPF_LAST4);
  });

  it("sem credencial real, a política volta a valer como FALLBACK", async () => {
    const c = await customer();

    await provisionPppoeFromErp(fixture.companyA.id, fixture.adminA.id, {
      customerId: c.id,
      login: "cliente.principal",
      document: CPF_FICTICIO,
      chatbotLogins: [],
    });

    const row = await prisma.customerConnection.findFirstOrThrow({
      where: { customerId: c.id },
    });
    expect(row.passwordSource).toBe("AUTO_DOCUMENT_LAST4");
    expect(row.usernameSource).toBe("RECEITANET_CALLCENTER");
  });

  it("login do Chatbot sem senha cai no fallback, mantendo o par coerente", async () => {
    const c = await customer();

    await provisionPppoeFromErp(fixture.companyA.id, fixture.adminA.id, {
      customerId: c.id,
      login: "do.callcenter",
      document: CPF_FICTICIO,
      chatbotLogins: [
        { login: "do.chatbot", password: null, isPrincipal: true },
      ],
    });

    const row = await prisma.customerConnection.findFirstOrThrow({
      where: { customerId: c.id },
    });
    // O usuário veio do Chatbot; a senha, da política.
    expect(row.username).toBe("do.chatbot");
    expect(row.usernameSource).toBe("RECEITANET_CHATBOT");
    expect(row.passwordSource).toBe("AUTO_DOCUMENT_LAST4");
  });

  it("REGRESSÃO: senha MANUAL não é sobrescrita nem pela credencial real", async () => {
    const c = await customer();
    const { createCustomerConnection } = await import("@/lib/customer-connections");
    await createCustomerConnection(fixture.companyA.id, fixture.adminA.id, {
      customerId: c.id,
      username: "definido.a.mao",
      password: "1122",
    });
    const antes = await prisma.customerConnection.findFirstOrThrow({
      where: { customerId: c.id },
    });

    await provisionPppoeFromErp(fixture.companyA.id, fixture.adminA.id, {
      customerId: c.id,
      login: "cliente.principal",
      document: CPF_FICTICIO,
      chatbotLogins: [
        { login: "cliente.principal", password: SENHA_REAL, isPrincipal: true },
      ],
    });

    const depois = await prisma.customerConnection.findFirstOrThrow({
      where: { id: antes.id },
    });
    expect(depois.passwordSource).toBe("MANUAL");
    expect(depois.credentialCiphertext).toBe(antes.credentialCiphertext);
    expect(depois.username).toBe("definido.a.mao");
  });
});

// ---------------------------------------------------------------------------
// O plaintext não escapa
// ---------------------------------------------------------------------------

describe("Senha do Chatbot nunca vaza", () => {
  it("REGRESSÃO: plaintext não é persistido em lugar nenhum", async () => {
    const c = await prisma.customer.create({
      data: { companyId: fixture.companyA.id, name: "Cliente", document: CPF_FICTICIO },
    });

    await provisionPppoeFromErp(fixture.companyA.id, fixture.adminA.id, {
      customerId: c.id,
      login: "cliente.principal",
      document: CPF_FICTICIO,
      chatbotLogins: [
        { login: "cliente.principal", password: SENHA_REAL, isPrincipal: true },
      ],
    });

    const [connections, audits, customers] = await Promise.all([
      prisma.customerConnection.findMany({ where: { companyId: fixture.companyA.id } }),
      prisma.auditLog.findMany({ where: { companyId: fixture.companyA.id } }),
      prisma.customer.findMany({ where: { companyId: fixture.companyA.id } }),
    ]);

    // A senha existe no banco SÓ como ciphertext.
    expect(JSON.stringify(connections)).not.toContain(SENHA_REAL);
    expect(JSON.stringify(audits)).not.toContain(SENHA_REAL);
    expect(JSON.stringify(customers)).not.toContain(SENHA_REAL);
  });

  it("o shape público da conexão não carrega a senha", async () => {
    const c = await prisma.customer.create({
      data: { companyId: fixture.companyA.id, name: "Cliente", document: CPF_FICTICIO },
    });
    await provisionPppoeFromErp(fixture.companyA.id, fixture.adminA.id, {
      customerId: c.id,
      login: "cliente.principal",
      document: CPF_FICTICIO,
      chatbotLogins: [
        { login: "cliente.principal", password: SENHA_REAL, isPrincipal: true },
      ],
    });

    const { listCustomerConnections } = await import("@/lib/customer-connections");
    const list = await listCustomerConnections(fixture.companyA.id, c.id);

    expect(JSON.stringify(list)).not.toContain(SENHA_REAL);
    expect(list[0].passwordConfigured).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Transporte
// ---------------------------------------------------------------------------

describe("Cliente HTTP do Chatbot", () => {
  function clientWith(respond: (url: string) => { status: number; body: string }) {
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      calls.push(url);
      const r = respond(url);
      return { ok: r.status < 300, status: r.status, text: async () => r.body };
    };
    return {
      calls,
      client: new ReceitanetChatbotClient({ token: "token-chatbot", fetchImpl }),
    };
  }

  it("CONTROLE POSITIVO: 200 com contratos devolve o payload", async () => {
    const { client } = clientWith(() => ({
      status: 200,
      body: JSON.stringify(payload()),
    }));
    const raw = await client.buscarClientes(CPF_FICTICIO);
    expect(normalizeChatbotCustomer(raw)?.externalId).toBe("15678");
  });

  it("envia app=chatbot e o token, e nada mais de segredo", async () => {
    const { client, calls } = clientWith(() => ({
      status: 200,
      body: JSON.stringify(payload()),
    }));
    await client.buscarClientes(CPF_FICTICIO);

    expect(calls[0]).toContain("app=chatbot");
    expect(calls[0]).toContain("cpfcnpj=" + CPF_FICTICIO);
  });

  it("construtor recusa token vazio", () => {
    expect(() => new ReceitanetChatbotClient({ token: "" })).toThrow();
  });

  it.each([
    ["host arbitrário", "https://attacker.example.com/chatbot"],
    ["sufixo enganoso", "https://api.receitanet.net.attacker.com/chatbot"],
    ["http", "http://api.receitanet.net/chatbot"],
  ])("base URL recusada: %s", (_l, baseUrl) => {
    expect(
      () => new ReceitanetChatbotClient({ token: "t", baseUrl }),
    ).toThrow();
  });

  it.each([
    [401, "AUTHENTICATION_FAILED"],
    [429, "RATE_LIMITED"],
    [500, "UPSTREAM_UNAVAILABLE"],
  ])("HTTP %s vira %s", async (status, code) => {
    const { client } = clientWith(() => ({ status: status as number, body: "{}" }));
    let got = "SEM ERRO";
    try {
      await client.buscarClientes(CPF_FICTICIO);
    } catch (e) {
      got = isIntegrationError(e) ? e.code : "desconhecido";
    }
    expect(got).toBe(code);
  });

  it("success:false vira CUSTOMER_NOT_FOUND", async () => {
    const { client } = clientWith(() => ({
      status: 200,
      body: JSON.stringify({ success: false, msg: "não localizado" }),
    }));
    let got = "SEM ERRO";
    try {
      await client.buscarClientes(CPF_FICTICIO);
    } catch (e) {
      got = isIntegrationError(e) ? e.code : "desconhecido";
    }
    expect(got).toBe("CUSTOMER_NOT_FOUND");
  });

  it("documento fora do formato nem chega a sair da máquina", async () => {
    const { client, calls } = clientWith(() => ({ status: 200, body: "{}" }));
    await expect(client.buscarClientes("123")).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});
