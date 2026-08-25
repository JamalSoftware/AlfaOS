import { describe, it, expect, beforeEach } from "vitest";
import { encryptCredential } from "@/lib/erp-credential-cipher";
import {
  getCredentialFor,
  normalizeCredentialToken,
  saveCredentialFor,
} from "@/lib/erp-credential-store";
import { resolveChatbotClient, resolveCompanyAdapter } from "@/lib/erp-adapter";
import { isIntegrationError } from "@/integrations/errors";
import { normalizeChatbotCustomer } from "@/integrations/chatbot-enrichment";
import { prisma } from "@/lib/prisma";
import { seedTestData, type TestFixture } from "./helpers";

/**
 * Cutover do store de credenciais e as regressões da auditoria v0.7.
 *
 * Nenhum token real: strings inventadas, longas o bastante para o mínimo.
 */

const TOKEN_CC = "token-callcenter-ficticio-AAAA";
const TOKEN_CB = "token-chatbot-ficticio-BBBB";

let fixture: TestFixture;
beforeEach(async () => {
  fixture = await seedTestData();
});

async function integration(companyId: string, provider: "MOCK" | "RECEITANET") {
  await prisma.eRPIntegration.create({
    data: { companyId, provider, name: provider, enabled: true },
  });
}

// ---------------------------------------------------------------------------
// M1 — o legado ficou inerte
// ---------------------------------------------------------------------------

describe("M1: ERPCredential é a única fonte operacional", () => {
  it("REGRESSÃO: gravar credencial não escreve nas colunas legadas", async () => {
    await integration(fixture.companyA.id, "RECEITANET");

    await saveCredentialFor(
      fixture.companyA.id,
      fixture.adminA.id,
      "RECEITANET",
      "CALLCENTER",
      TOKEN_CC,
    );

    const legacy = await prisma.eRPIntegration.findUniqueOrThrow({
      where: { companyId: fixture.companyA.id },
    });
    // O legado permanece FISICAMENTE no banco, mas inerte.
    expect(legacy.credentialCiphertext).toBeNull();
    expect(legacy.credentialIv).toBeNull();
    expect(legacy.credentialAuthTag).toBeNull();
    expect(legacy.credentialLast4).toBeNull();
    expect(legacy.apiKey).toBeNull();
  });

  it("REGRESSÃO: credencial só no legado NÃO é aceita pelo adapter", async () => {
    await integration(fixture.companyA.id, "RECEITANET");

    // Simula o estado pré-migração: segredo apenas nas colunas antigas.
    const encrypted = encryptCredential(TOKEN_CC, {
      companyId: fixture.companyA.id,
      provider: "RECEITANET",
    });
    await prisma.eRPIntegration.update({
      where: { companyId: fixture.companyA.id },
      data: {
        credentialCiphertext: encrypted.ciphertext,
        credentialIv: encrypted.iv,
        credentialAuthTag: encrypted.authTag,
        credentialLast4: TOKEN_CC.slice(-4),
      },
    });

    /**
     * Depois do cutover isto é indisponibilidade, e não uma segunda fonte de
     * verdade. Um sistema que ainda lesse aqui teria dois lugares podendo
     * discordar sobre qual é a credencial vigente.
     */
    let code = "SEM ERRO";
    try {
      await resolveCompanyAdapter(fixture.companyA.id, "RECEITANET");
    } catch (e) {
      code = isIntegrationError(e) ? e.code : "desconhecido";
    }
    expect(code).toBe("AUTHENTICATION_FAILED");
  });

  it("CONTROLE POSITIVO: credencial no store novo é aceita", async () => {
    await integration(fixture.companyA.id, "RECEITANET");
    await saveCredentialFor(
      fixture.companyA.id,
      fixture.adminA.id,
      "RECEITANET",
      "CALLCENTER",
      TOKEN_CC,
    );

    const adapter = await resolveCompanyAdapter(fixture.companyA.id, "RECEITANET");
    expect(adapter.provider).toBe("RECEITANET");
  });
});

// ---------------------------------------------------------------------------
// Resolução por capability, sem fallback
// ---------------------------------------------------------------------------

describe("Cada API usa exclusivamente a própria credencial", () => {
  it("REGRESSÃO: CallCenter configurado NÃO habilita o Chatbot", async () => {
    await integration(fixture.companyA.id, "RECEITANET");
    await saveCredentialFor(
      fixture.companyA.id,
      fixture.adminA.id,
      "RECEITANET",
      "CALLCENTER",
      TOKEN_CC,
    );

    /**
     * `null`, não o cliente com o token do CallCenter. Cair para "o outro
     * token" concederia ao Chatbot um acesso que a empresa nunca configurou.
     */
    expect(await resolveChatbotClient(fixture.companyA.id)).toBeNull();
  });

  it("REGRESSÃO: Chatbot configurado NÃO habilita o CallCenter", async () => {
    await integration(fixture.companyA.id, "RECEITANET");
    await saveCredentialFor(
      fixture.companyA.id,
      fixture.adminA.id,
      "RECEITANET",
      "CHATBOT",
      TOKEN_CB,
    );

    let code = "SEM ERRO";
    try {
      await resolveCompanyAdapter(fixture.companyA.id, "RECEITANET");
    } catch (e) {
      code = isIntegrationError(e) ? e.code : "desconhecido";
    }
    expect(code).toBe("AUTHENTICATION_FAILED");
  });

  it("CONTROLE POSITIVO: com as duas, ambas resolvem", async () => {
    await integration(fixture.companyA.id, "RECEITANET");
    await saveCredentialFor(fixture.companyA.id, fixture.adminA.id, "RECEITANET", "CALLCENTER", TOKEN_CC);
    await saveCredentialFor(fixture.companyA.id, fixture.adminA.id, "RECEITANET", "CHATBOT", TOKEN_CB);

    expect((await resolveCompanyAdapter(fixture.companyA.id, "RECEITANET")).provider).toBe(
      "RECEITANET",
    );
    expect(await resolveChatbotClient(fixture.companyA.id)).not.toBeNull();
  });

  /**
   * Isolamento de falha: o Chatbot ausente é estado legítimo, não erro. Uma
   * empresa que só usa o CallCenter não pode ver a integração inteira quebrar.
   */
  it("Chatbot ausente não derruba o CallCenter", async () => {
    await integration(fixture.companyA.id, "RECEITANET");
    await saveCredentialFor(fixture.companyA.id, fixture.adminA.id, "RECEITANET", "CALLCENTER", TOKEN_CC);

    expect(await resolveChatbotClient(fixture.companyA.id)).toBeNull();
    // E o CallCenter continua funcionando ao lado disso.
    expect((await resolveCompanyAdapter(fixture.companyA.id, "RECEITANET")).provider).toBe(
      "RECEITANET",
    );
  });
});

// ---------------------------------------------------------------------------
// AAD — downgrade e transplante
// ---------------------------------------------------------------------------

describe("AAD: vínculo por empresa, provider e API", () => {
  async function seedBoth() {
    await integration(fixture.companyA.id, "RECEITANET");
    await integration(fixture.companyB.id, "RECEITANET");
    await saveCredentialFor(fixture.companyA.id, fixture.adminA.id, "RECEITANET", "CALLCENTER", TOKEN_CC);
    await saveCredentialFor(fixture.companyA.id, fixture.adminA.id, "RECEITANET", "CHATBOT", TOKEN_CB);
  }

  /**
   * O ataque de downgrade: marcar uma linha v2 como v1 faria o AAD ser
   * recomputado SEM o `kind` — e, se decriptasse, as duas credenciais da
   * empresa voltariam a ser intercambiáveis.
   */
  it("REGRESSÃO: v2 rebaixado para v1 não decripta", async () => {
    await seedBoth();

    await prisma.eRPCredential.updateMany({
      where: { companyId: fixture.companyA.id, kind: "CALLCENTER" },
      data: { aadVersion: "v1" },
    });

    await expect(
      getCredentialFor(fixture.companyA.id, "RECEITANET", "CALLCENTER"),
    ).rejects.toThrow();
  });

  it("REGRESSÃO: ciphertext do CALLCENTER na linha do CHATBOT não decripta", async () => {
    await seedBoth();
    const cc = await prisma.eRPCredential.findFirstOrThrow({
      where: { companyId: fixture.companyA.id, kind: "CALLCENTER" },
    });

    await prisma.eRPCredential.updateMany({
      where: { companyId: fixture.companyA.id, kind: "CHATBOT" },
      data: {
        credentialCiphertext: cc.credentialCiphertext,
        credentialIv: cc.credentialIv,
        credentialAuthTag: cc.credentialAuthTag,
      },
    });

    await expect(
      getCredentialFor(fixture.companyA.id, "RECEITANET", "CHATBOT"),
    ).rejects.toThrow();
  });

  it("REGRESSÃO: ciphertext da empresa A na empresa B não decripta", async () => {
    await seedBoth();
    const a = await prisma.eRPCredential.findFirstOrThrow({
      where: { companyId: fixture.companyA.id, kind: "CALLCENTER" },
    });

    await prisma.eRPCredential.create({
      data: {
        companyId: fixture.companyB.id,
        provider: "RECEITANET",
        kind: "CALLCENTER",
        credentialCiphertext: a.credentialCiphertext,
        credentialIv: a.credentialIv,
        credentialAuthTag: a.credentialAuthTag,
        aadVersion: "v2",
      },
    });

    await expect(
      getCredentialFor(fixture.companyB.id, "RECEITANET", "CALLCENTER"),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// L5 — normalização do token
// ---------------------------------------------------------------------------

describe("L5: normalização central do token", () => {
  it("apara espaço nas pontas", () => {
    expect(normalizeCredentialToken(`  ${TOKEN_CC}  `)).toBe(TOKEN_CC);
  });

  /**
   * Quebra de linha NAS PONTAS e o caso 'colei com newline': `trim` resolve,
   * e resolver em silencio e o comportamento util -- recusar obrigaria o
   * operador a caçar um caractere invisivel.
   */
  it.each([
    ["newline no fim", TOKEN_CC + String.fromCharCode(10)],
    ["CR no fim", TOKEN_CC + String.fromCharCode(13)],
    ["CRLF no fim", TOKEN_CC + String.fromCharCode(13, 10)],
  ])("apara controle nas pontas: %s", (_l, raw) => {
    expect(normalizeCredentialToken(raw as string)).toBe(TOKEN_CC);
  });

  /**
   * Controle NO MEIO e o ataque: `trim` nao alcança, e um CRLF dentro de um
   * valor que vira header HTTP e injeção de cabeçalho. O token do CallCenter
   * vai exatamente num header.
   */
  it.each([
    ["CRLF no meio", "token-com" + String.fromCharCode(13, 10) + "injecao-header"],
    ["newline no meio", "token-com" + String.fromCharCode(10) + "quebra-no-meio"],
    ["tab no meio", "token-com" + String.fromCharCode(9) + "tab-no-meio-ok"],
    ["NUL no meio", "token-com" + String.fromCharCode(0) + "nulo-no-meio-ok"],
  ])("REGRESSAO: recusa controle no meio: %s", (_l, raw) => {
    expect(() => normalizeCredentialToken(raw as string)).toThrow();
  });

  it("recusa vazio e só-espaço", () => {
    expect(() => normalizeCredentialToken("")).toThrow();
    expect(() => normalizeCredentialToken("     ")).toThrow();
  });

  it("NÃO altera caractere válido no meio", () => {
    const comEspacoInterno = "token com espaco interno valido";
    expect(normalizeCredentialToken(comEspacoInterno)).toBe(comEspacoInterno);
  });

  it("o token gravado é o normalizado, não o cru", async () => {
    await integration(fixture.companyA.id, "RECEITANET");
    await saveCredentialFor(
      fixture.companyA.id,
      fixture.adminA.id,
      "RECEITANET",
      "CALLCENTER",
      `  ${TOKEN_CC}  `,
    );

    expect(
      await getCredentialFor(fixture.companyA.id, "RECEITANET", "CALLCENTER"),
    ).toBe(TOKEN_CC);
  });
});

// ---------------------------------------------------------------------------
// M4 — múltiplos contratos
// ---------------------------------------------------------------------------

describe("M4: múltiplos contratos não são resolvidos por índice", () => {
  function contract(idContrato: number, login: string) {
    return {
      idCliente: 15678,
      idContrato,
      razaoSocial: "Cliente",
      login,
      senha: "s",
      logins: [{ login, senha: "s", isPrincipal: true }],
    };
  }

  it("0 contratos => NONE", () => {
    expect(normalizeChatbotCustomer({ contratos: [] }).outcome).toBe("NONE");
  });

  it("CONTROLE POSITIVO: 1 contrato resolve", () => {
    const r = normalizeChatbotCustomer({ contratos: [contract(1, "a")] });
    expect(r.outcome).toBe("RESOLVED");
    expect(r.outcome === "RESOLVED" && r.customer.contractId).toBe("1");
  });

  /**
   * A regressão que dá nome ao bloco: escolher `contratos[0]` gravaria PPPoE,
   * telefone, endereço e coordenada de um contrato que talvez não seja o que o
   * técnico vai atender.
   */
  it("REGRESSÃO: 2 contratos sem desempate => AMBIGUOUS, nunca o primeiro", () => {
    const r = normalizeChatbotCustomer({
      contratos: [contract(1, "a"), contract(2, "b")],
    });

    expect(r.outcome).toBe("AMBIGUOUS");
    expect(r.outcome === "AMBIGUOUS" && r.contractIds).toEqual(["1", "2"]);
  });

  it("2 contratos com idContrato conhecido resolvem pelo match exato", () => {
    const r = normalizeChatbotCustomer(
      { contratos: [contract(1, "a"), contract(2, "b")] },
      { contractId: "2" },
    );

    expect(r.outcome).toBe("RESOLVED");
    expect(r.outcome === "RESOLVED" && r.customer.contractId).toBe("2");
    expect(r.outcome === "RESOLVED" && r.customer.logins[0].login).toBe("b");
  });

  /**
   * `idCliente` é COMPARTILHADO entre os contratos do mesmo cliente, então não
   * desempata nada — e aceitar que desempatasse reintroduziria a escolha
   * silenciosa por outro nome.
   */
  it("REGRESSÃO: idCliente sozinho NÃO desempata contratos", () => {
    const r = normalizeChatbotCustomer(
      { contratos: [contract(1, "a"), contract(2, "b")] },
      { externalId: "15678" },
    );
    expect(r.outcome).toBe("AMBIGUOUS");
  });

  it("idContrato que não casa com nenhum => AMBIGUOUS", () => {
    const r = normalizeChatbotCustomer(
      { contratos: [contract(1, "a"), contract(2, "b")] },
      { contractId: "999" },
    );
    expect(r.outcome).toBe("AMBIGUOUS");
  });
});
