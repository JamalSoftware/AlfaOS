import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  fillPhoneSlots,
  normalizeCoordinates,
  normalizeCustomerEmail,
  normalizeCustomerPhone,
} from "@/lib/erp-customer-enrichment";
import { decryptConnectionCredential } from "@/lib/connection-credential-cipher";
import { saveCredentialFor } from "@/lib/erp-credential-store";
import { seedTestData, type TestFixture } from "./helpers";

/**
 * Enriquecimento de Customer via ReceitaNet Chatbot.
 *
 * Nenhum dado real: documento fictício de 11 dígitos, telefones com prefixo
 * reservado, senha inventada. Nenhum teste toca a rede — o transporte é
 * injetado no grafo recriado por `resetModules`.
 */

const CPF = "10020030044";
const CPF_LAST4 = "0044";
const SENHA_REAL = "x9k2m4";
const TEL_1 = "11900000001";
const TEL_2 = "1133330001";
const TEL_3 = "11900000003";

let fixture: TestFixture;
beforeEach(async () => {
  fixture = await seedTestData();
  /**
   * `resetModules` limpa o registro de MODULOS, nao o de MOCKS.
   *
   * Sem o `doUnmock`, um `vi.doMock` de um teste anterior continua valendo
   * para os imports dinamicos dos seguintes -- e um teste que deveria
   * exercitar a resolucao REAL da credencial passa usando o dublê do vizinho,
   * medindo outra coisa sem avisar.
   */
  vi.doUnmock("@/lib/erp-adapter");
  vi.resetModules();
});

function contrato(overrides: Record<string, unknown> = {}) {
  return {
    idCliente: 15678,
    idContrato: 4321,
    razaoSocial: "Cliente Fictício",
    cpfCnpj: CPF,
    email: "cliente@exemplo.invalid",
    telefones: [TEL_1],
    coordenadas: { x: -22.1234, y: -51.4321 },
    endereco: {
      endereco: "Rua Fictícia",
      numero: null,
      complemento: null,
      bairro: "Centro",
      cidade: "Cidade",
      uf: "sp",
      cep: "19000-000",
      referencia: "Ao lado da praça",
    },
    servidor: { servidor: "SRV-01", profile: "P500", tipo: "PPPOE", ip: null, isManutencao: false },
    planos: [{ descricao: "Plano 500M", quantidade: 1, valor: "99,90" }],
    logins: [{ login: "cliente.principal", senha: SENHA_REAL, isPrincipal: true }],
    tecnologia: 3,
    ...overrides,
  };
}

/** Roda o enriquecimento real com transporte falso. */
async function enrich(
  customerId: string,
  body: unknown,
  status = 200,
  companyId = fixture.companyA.id,
) {
  vi.doMock("@/lib/erp-adapter", async () => {
    const actual =
      await vi.importActual<typeof import("@/lib/erp-adapter")>("@/lib/erp-adapter");
    const { ReceitanetChatbotClient } = await import(
      "@/integrations/receitanet/ChatbotClient"
    );
    return {
      ...actual,
      resolveChatbotClient: async () =>
        new ReceitanetChatbotClient({
          token: "token-ficticio-do-chatbot",
          fetchImpl: async () => ({
            ok: status < 300,
            status,
            text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
            contentType: "application/json",
          }),
        }),
    };
  });

  const mod = await import("@/lib/erp-customer-enrichment");
  return mod.enrichCustomerFromChatbot(companyId, fixture.adminA.id, customerId);
}

/** Chatbot não configurado para a empresa. */
async function enrichWithoutChatbot(customerId: string) {
  vi.doMock("@/lib/erp-adapter", async () => {
    const actual =
      await vi.importActual<typeof import("@/lib/erp-adapter")>("@/lib/erp-adapter");
    return { ...actual, resolveChatbotClient: async () => null };
  });
  const mod = await import("@/lib/erp-customer-enrichment");
  return mod.enrichCustomerFromChatbot(
    fixture.companyA.id,
    fixture.adminA.id,
    customerId,
  );
}

async function customerWith(overrides: Record<string, unknown> = {}) {
  return prisma.customer.create({
    data: {
      companyId: fixture.companyA.id,
      name: "Cliente Local",
      document: CPF,
      externalProvider: "RECEITANET",
      externalId: "15678",
      ...overrides,
    },
  });
}

async function reload(id: string) {
  return prisma.customer.findUniqueOrThrow({ where: { id } });
}

// ---------------------------------------------------------------------------
// Normalizadores puros
// ---------------------------------------------------------------------------

describe("Normalização de telefone", () => {
  it("CONTROLE POSITIVO: celular e fixo com DDD passam", () => {
    expect(normalizeCustomerPhone(TEL_1)).toBe(TEL_1);
    expect(normalizeCustomerPhone(TEL_2)).toBe(TEL_2);
  });

  it("máscara é removida", () => {
    expect(normalizeCustomerPhone("(11) 90000-0001")).toBe(TEL_1);
  });

  it.each([
    ["curto", "1234"],
    ["longo", "119000000011234"],
    ["repetição total", "0000000000"],
    ["nove repetido", "99999999999"],
    ["vazio", ""],
    ["nulo", null],
    ["só letras", "sem numero"],
  ])("recusa: %s", (_l, raw) => {
    expect(normalizeCustomerPhone(raw as string | null)).toBeNull();
  });
});

const VAZIO = { phone: null, secondaryPhone: null };

describe("Preenchimento dos slots de telefone", () => {
  it("um telefone vai para phone", () => {
    expect(fillPhoneSlots([TEL_1], VAZIO)).toEqual({ phone: TEL_1, discarded: 0 });
  });

  it("dois telefones preenchem os dois campos", () => {
    expect(fillPhoneSlots([TEL_1, TEL_2], VAZIO)).toEqual({
      phone: TEL_1,
      secondaryPhone: TEL_2,
      discarded: 0,
    });
  });

  /**
   * O modelo tem dois campos e o provedor pode mandar mais. Descartar em
   * silêncio deixaria o operador sem saber que existe um terceiro contato.
   */
  it("REGRESSÃO: o excedente é CONTADO, não descartado em silêncio", () => {
    expect(fillPhoneSlots([TEL_1, TEL_2, TEL_3], VAZIO)).toEqual({
      phone: TEL_1,
      secondaryPhone: TEL_2,
      discarded: 1,
    });
  });

  it("duplicata não ocupa o segundo campo", () => {
    expect(fillPhoneSlots([TEL_1, TEL_1], VAZIO)).toEqual({ phone: TEL_1, discarded: 0 });
  });

  it("inválidos são ignorados antes da contagem", () => {
    expect(fillPhoneSlots(["123", TEL_1, "0000000000"], VAZIO)).toEqual({
      phone: TEL_1,
      discarded: 0,
    });
  });

  it("lista vazia não quebra", () => {
    expect(fillPhoneSlots([], VAZIO)).toEqual({ discarded: 0 });
  });
});

describe("Normalização de e-mail", () => {
  it("CONTROLE POSITIVO: endereço válido passa e é minúsculo", () => {
    expect(normalizeCustomerEmail("  Cliente@Exemplo.Invalid ")).toBe(
      "cliente@exemplo.invalid",
    );
  });

  it.each([
    ["sem arroba", "clienteexemplo.invalid"],
    ["sem domínio", "cliente@"],
    ["sem TLD", "cliente@exemplo"],
    ["com espaço", "cli ente@exemplo.invalid"],
    ["vazio", ""],
    ["nulo", null],
  ])("recusa: %s", (_l, raw) => {
    expect(normalizeCustomerEmail(raw as string | null)).toBeNull();
  });
});

describe("Normalização de coordenadas", () => {
  it("CONTROLE POSITIVO: par válido passa", () => {
    expect(normalizeCoordinates(-22.1234, -51.4321)).toEqual({
      latitude: -22.1234,
      longitude: -51.4321,
    });
  });

  /**
   * `(0,0)` é o Golfo da Guiné. Nenhum provedor brasileiro tem cliente lá — na
   * prática é o sentinela de "não preenchido", e gravá-lo mandaria o técnico
   * para o meio do Atlântico.
   */
  it("REGRESSÃO: (0,0) é recusado", () => {
    expect(normalizeCoordinates(0, 0)).toBeNull();
  });

  it.each([
    ["latitude fora da faixa", 91, -51],
    ["latitude negativa fora", -91, -51],
    ["longitude fora da faixa", -22, 181],
    ["longitude negativa fora", -22, -181],
  ])("recusa: %s", (_l, lat, lng) => {
    expect(normalizeCoordinates(lat as number, lng as number)).toBeNull();
  });

  it("ausência de uma das duas invalida o par", () => {
    expect(normalizeCoordinates(-22.1, null)).toBeNull();
    expect(normalizeCoordinates(null, -51.4)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Enriquecimento de fato
// ---------------------------------------------------------------------------

describe("Enriquecimento aplica os campos homologados", () => {
  it("CONTROLE POSITIVO: cliente vazio recebe tudo", async () => {
    const c = await customerWith();

    const result = await enrich(c.id, { success: true, contratos: contrato() });

    expect(result.outcome).toBe("SUCCESS");

    const row = await reload(c.id);
    expect(row.phone).toBe(TEL_1);
    expect(row.email).toBe("cliente@exemplo.invalid");
    expect(row.address).toBe("Rua Fictícia");
    expect(row.district).toBe("Centro");
    expect(row.state).toBe("SP");
    expect(row.externalContractId).toBe("4321");
  });

  it("x vira latitude e y vira longitude", async () => {
    const c = await customerWith();
    await enrich(c.id, { success: true, contratos: contrato() });

    const row = await reload(c.id);
    expect(Number(row.latitude)).toBe(-22.1234);
    expect(Number(row.longitude)).toBe(-51.4321);
  });

  /**
   * Coordenada de cadastro ajuda a chegar perto. Dizer que foi confirmada faria
   * o técnico confiar nela em vez de procurar o endereço quando estiver errada.
   */
  it("REGRESSÃO: coordenada importada NUNCA nasce verificada", async () => {
    const c = await customerWith();
    await enrich(c.id, { success: true, contratos: contrato() });

    const row = await reload(c.id);
    expect(row.locationSource).toBe("IMPORTED");
    expect(row.locationVerified).toBe(false);
  });

  it("coordenada inválida não grava nada de localização", async () => {
    const c = await customerWith();
    await enrich(c.id, {
      success: true,
      contratos: contrato({ coordenadas: { x: 0, y: 0 } }),
    });

    const row = await reload(c.id);
    expect(row.latitude).toBeNull();
    expect(row.locationSource).toBeNull();
  });

  it("numero nulo continua nulo, nunca a string 'null'", async () => {
    const c = await customerWith();
    await enrich(c.id, { success: true, contratos: contrato() });

    const row = await reload(c.id);
    expect(row.number).toBeNull();
    expect(JSON.stringify(row)).not.toContain('"null"');
  });

  it("referência é preservada quando não há complemento", async () => {
    const c = await customerWith();
    await enrich(c.id, { success: true, contratos: contrato() });

    expect((await reload(c.id)).complement).toContain("Ao lado da praça");
  });

  it("REGRESSÃO: referência NÃO destrói um complemento real", async () => {
    const c = await customerWith();
    await enrich(c.id, {
      success: true,
      contratos: contrato({
        endereco: { ...contrato().endereco, complemento: "Apto 42", referencia: "Praça" },
      }),
    });

    const row = await reload(c.id);
    expect(row.complement).toBe("Apto 42");
  });

  it("telefone extra é reportado como PARTIAL", async () => {
    const c = await customerWith();

    const result = await enrich(c.id, {
      success: true,
      contratos: contrato({ telefones: [TEL_1, TEL_2, TEL_3] }),
    });

    expect(result.outcome).toBe("PARTIAL");
    expect(result.phonesDiscarded).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Contato digitado por gente
// ---------------------------------------------------------------------------

describe("Contato manual não é sobrescrito", () => {
  /**
   * Telefone e e-mail são os campos que o despachante corrige à mão depois de
   * falar com o cliente. Deixar a releitura sobrescrever apagaria a informação
   * mais atual em favor da mais velha.
   */
  it("REGRESSÃO: telefone e e-mail existentes sobrevivem", async () => {
    const c = await customerWith({
      phone: "11988887777",
      email: "corrigido@exemplo.invalid",
    });

    await enrich(c.id, { success: true, contratos: contrato() });

    const row = await reload(c.id);
    expect(row.phone).toBe("11988887777");
    expect(row.email).toBe("corrigido@exemplo.invalid");
  });

  it("mas o campo VAZIO ao lado é preenchido", async () => {
    const c = await customerWith({ phone: "11988887777" });

    await enrich(c.id, {
      success: true,
      contratos: contrato({ telefones: [TEL_1, TEL_2] }),
    });

    const row = await reload(c.id);
    expect(row.phone).toBe("11988887777");
    expect(row.secondaryPhone).toBe(TEL_1);
  });
});

// ---------------------------------------------------------------------------
// Contratos
// ---------------------------------------------------------------------------

describe("Resolução de contrato", () => {
  it("nenhum contrato => NOT_FOUND, sem escrita", async () => {
    const c = await customerWith();
    const antes = await reload(c.id);

    const result = await enrich(c.id, { success: true, contratos: [] });

    expect(result.outcome).toBe("NOT_FOUND");
    expect((await reload(c.id)).updatedAt.getTime()).toBe(antes.updatedAt.getTime());
  });

  /**
   * A regra fail-safe: escolher em silêncio entre contratos espalharia dados de
   * um que talvez não seja o atendido, e o erro só apareceria em campo.
   */
  it("REGRESSÃO: múltiplos contratos sem desempate => AMBIGUOUS e NADA gravado", async () => {
    const c = await customerWith();
    const antes = await reload(c.id);

    const result = await enrich(c.id, {
      success: true,
      contratos: [contrato({ idContrato: 1 }), contrato({ idContrato: 2 })],
    });

    expect(result.outcome).toBe("AMBIGUOUS");
    expect(result.contractIds).toEqual(["1", "2"]);

    const depois = await reload(c.id);
    expect(depois.phone).toBeNull();
    expect(depois.latitude).toBeNull();
    expect(depois.updatedAt.getTime()).toBe(antes.updatedAt.getTime());
    // E nenhuma conexão foi criada.
    expect(await prisma.customerConnection.count({ where: { customerId: c.id } })).toBe(0);
  });

  it("idContrato já conhecido desempata", async () => {
    const c = await customerWith({ externalContractId: "2" });

    const result = await enrich(c.id, {
      success: true,
      contratos: [
        contrato({ idContrato: 1, telefones: ["11911110001"] }),
        contrato({ idContrato: 2, telefones: [TEL_1] }),
      ],
    });

    expect(result.outcome).toBe("SUCCESS");
    expect((await reload(c.id)).phone).toBe(TEL_1);
  });

  it("REGRESSÃO: idContrato de OUTRA empresa não desempata", async () => {
    // O contrato "2" pertence a um cliente da empresa B.
    await prisma.customer.create({
      data: {
        companyId: fixture.companyB.id,
        name: "Cliente da B",
        document: CPF,
        externalProvider: "RECEITANET",
        externalId: "999",
        externalContractId: "2",
      },
    });
    // O cliente de A não tem contrato conhecido.
    const c = await customerWith();

    const result = await enrich(c.id, {
      success: true,
      contratos: [contrato({ idContrato: 1 }), contrato({ idContrato: 2 })],
    });

    // O hint sai do PRÓPRIO cliente, nunca de uma varredura global.
    expect(result.outcome).toBe("AMBIGUOUS");
  });
});

// ---------------------------------------------------------------------------
// Isolamento de falha
// ---------------------------------------------------------------------------

describe("Chatbot indisponível não derruba nada", () => {
  it("Chatbot não configurado => UNAVAILABLE, sem escrita", async () => {
    const c = await customerWith();
    const antes = await reload(c.id);

    const result = await enrichWithoutChatbot(c.id);

    expect(result.outcome).toBe("UNAVAILABLE");
    expect(result.code).toBe("NOT_CONFIGURED");
    expect((await reload(c.id)).updatedAt.getTime()).toBe(antes.updatedAt.getTime());
  });

  it("cliente sem documento => UNAVAILABLE, sem consultar o provedor", async () => {
    const c = await customerWith({ document: null });

    const result = await enrich(c.id, { success: true, contratos: contrato() });

    expect(result.outcome).toBe("UNAVAILABLE");
    expect(result.code).toBe("NO_DOCUMENT");
  });

  it.each([
    [500, "UPSTREAM_UNAVAILABLE"],
    [401, "AUTHENTICATION_FAILED"],
  ])("HTTP %s => UNAVAILABLE com o código", async (status, code) => {
    const c = await customerWith();

    const result = await enrich(c.id, { success: false }, status as number);

    expect(result.outcome).toBe("UNAVAILABLE");
    expect(result.code).toBe(code);
  });

  it("provedor não conhece o documento => NOT_FOUND", async () => {
    const c = await customerWith();
    const result = await enrich(c.id, { success: false, msg: "nao localizado" });
    expect(result.outcome).toBe("NOT_FOUND");
  });
});

// ---------------------------------------------------------------------------
// PPPoE e segredo
// ---------------------------------------------------------------------------

describe("PPPoE a partir do Chatbot", () => {
  beforeEach(async () => {
    await prisma.company.update({
      where: { id: fixture.companyA.id },
      data: { pppoePasswordPolicy: "DOCUMENT_LAST4" },
    });
  });

  it("CONTROLE POSITIVO: senha real é gravada cifrada", async () => {
    const c = await customerWith();

    const result = await enrich(c.id, { success: true, contratos: contrato() });
    expect(result.pppoe).toBe("CREATED");

    const conn = await prisma.customerConnection.findFirstOrThrow({
      where: { customerId: c.id },
    });
    expect(conn.username).toBe("cliente.principal");
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
    // A senha REAL, não o palpite dos 4 últimos do CPF.
    expect(senha).toBe(SENHA_REAL);
    expect(senha).not.toBe(CPF_LAST4);
  });

  it("dois logins sem principal => AMBIGUOUS, nenhuma conexão", async () => {
    const c = await customerWith();

    const result = await enrich(c.id, {
      success: true,
      contratos: contrato({
        logins: [
          { login: "a", senha: "s1", isPrincipal: false },
          { login: "b", senha: "s2", isPrincipal: false },
        ],
      }),
    });

    expect(result.pppoe).toBe("SKIPPED_AMBIGUOUS");
    expect(await prisma.customerConnection.count({ where: { customerId: c.id } })).toBe(0);
  });

  /**
   * Idempotência: reimportar o mesmo cliente não pode multiplicar conexões nem
   * reescrever a credencial sem motivo.
   */
  it("REGRESSÃO: enriquecer duas vezes não duplica conexão", async () => {
    const c = await customerWith();

    await enrich(c.id, { success: true, contratos: contrato() });
    const primeira = await prisma.customerConnection.findFirstOrThrow({
      where: { customerId: c.id },
    });

    const segunda = await enrich(c.id, { success: true, contratos: contrato() });

    expect(await prisma.customerConnection.count({ where: { customerId: c.id } })).toBe(1);
    // Mesma senha, mesma fonte: nada a atualizar.
    expect(segunda.pppoe).toBe("PASSWORD_REFRESHED");
    const depois = await prisma.customerConnection.findFirstOrThrow({
      where: { id: primeira.id },
    });
    expect(depois.username).toBe(primeira.username);
  });

  it("REGRESSÃO: nenhuma senha aparece em AuditLog", async () => {
    const c = await customerWith();
    await enrich(c.id, { success: true, contratos: contrato() });

    const logs = await prisma.auditLog.findMany({
      where: { companyId: fixture.companyA.id },
    });
    const serialized = JSON.stringify(logs);

    expect(serialized).not.toContain(SENHA_REAL);
    // Nem os dados pessoais que o payload trouxe.
    expect(serialized).not.toContain(TEL_1);
    expect(serialized).not.toContain("cliente@exemplo.invalid");
    expect(serialized).not.toContain("Rua Fictícia");
  });

  it("REGRESSÃO: o resultado devolvido não carrega senha", async () => {
    const c = await customerWith();
    const result = await enrich(c.id, { success: true, contratos: contrato() });

    expect(JSON.stringify(result)).not.toContain(SENHA_REAL);
  });
});

// ---------------------------------------------------------------------------
// Multi-tenancy
// ---------------------------------------------------------------------------

describe("Isolamento entre empresas", () => {
  it("REGRESSÃO: empresa B não enriquece cliente da empresa A", async () => {
    const c = await customerWith();
    const antes = await reload(c.id);

    // Empresa B pedindo o cliente de A.
    const result = await enrich(
      c.id,
      { success: true, contratos: contrato() },
      200,
      fixture.companyB.id,
    );

    expect(result.outcome).toBe("UNAVAILABLE");
    // O cliente de A ficou intacto — nem sequer foi lido como alvo.
    const depois = await reload(c.id);
    expect(depois.phone).toBeNull();
    expect(depois.updatedAt.getTime()).toBe(antes.updatedAt.getTime());
  });

  it("CONTROLE POSITIVO: a própria empresa enriquece normalmente", async () => {
    const c = await customerWith();
    const result = await enrich(c.id, { success: true, contratos: contrato() });
    expect(result.outcome).toBe("SUCCESS");
  });
});

// ---------------------------------------------------------------------------
// Credencial usada é a do Chatbot
// ---------------------------------------------------------------------------

describe("O enriquecimento usa a credencial do Chatbot", () => {
  it("com só o CallCenter configurado, não enriquece", async () => {
    await prisma.eRPIntegration.create({
      data: {
        companyId: fixture.companyA.id,
        provider: "RECEITANET",
        name: "ReceitaNet",
        enabled: true,
      },
    });
    await saveCredentialFor(
      fixture.companyA.id,
      fixture.adminA.id,
      "RECEITANET",
      "CALLCENTER",
      "token-callcenter-ficticio-AAAA",
    );

    const c = await customerWith();
    const mod = await import("@/lib/erp-customer-enrichment");
    const result = await mod.enrichCustomerFromChatbot(
      fixture.companyA.id,
      fixture.adminA.id,
      c.id,
    );

    // Sem fallback para o token do CallCenter.
    expect(result.outcome).toBe("UNAVAILABLE");
    expect(result.code).toBe("NOT_CONFIGURED");
  });
});
