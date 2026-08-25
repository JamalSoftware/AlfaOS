import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { encryptCredential } from "@/lib/erp-credential-cipher";
import {
  getCredentialFor,
  listCredentialStatus,
  removeCredentialFor,
  saveCredentialFor,
} from "@/lib/erp-credential-store";
import { seedTestData, type TestFixture } from "./helpers";

/**
 * Duas credenciais ReceitaNet por empresa, com ciclos de vida independentes.
 *
 * O que estes testes protegem é uma regressão que já aconteceu neste projeto:
 * mexer numa credencial destruiu outra. Aqui o isolamento é estrutural — cada
 * credencial é uma linha — e os testes existem para provar que continua sendo.
 *
 * Nenhum token real aparece: são strings inventadas, longas o bastante para
 * passar no mínimo do validador.
 */

const TOKEN_CALLCENTER = "token-callcenter-ficticio-AAAA";
const TOKEN_CHATBOT = "token-chatbot-ficticio-BBBB";

let fixture: TestFixture;
beforeEach(async () => {
  fixture = await seedTestData();
});

// ---------------------------------------------------------------------------
// Combinações de configuração
// ---------------------------------------------------------------------------

describe("Empresa pode ter uma, outra, ou as duas credenciais", () => {
  it("somente CallCenter configurado", async () => {
    await saveCredentialFor(
      fixture.companyA.id,
      fixture.adminA.id,
      "RECEITANET",
      "CALLCENTER",
      TOKEN_CALLCENTER,
    );

    expect(
      await getCredentialFor(fixture.companyA.id, "RECEITANET", "CALLCENTER"),
    ).toBe(TOKEN_CALLCENTER);
    // Ausente não é erro: "esta empresa não usa o Chatbot" é estado legítimo.
    expect(
      await getCredentialFor(fixture.companyA.id, "RECEITANET", "CHATBOT"),
    ).toBeNull();
  });

  it("somente Chatbot configurado", async () => {
    await saveCredentialFor(
      fixture.companyA.id,
      fixture.adminA.id,
      "RECEITANET",
      "CHATBOT",
      TOKEN_CHATBOT,
    );

    expect(
      await getCredentialFor(fixture.companyA.id, "RECEITANET", "CHATBOT"),
    ).toBe(TOKEN_CHATBOT);
    expect(
      await getCredentialFor(fixture.companyA.id, "RECEITANET", "CALLCENTER"),
    ).toBeNull();
  });

  it("as duas configuradas, com valores diferentes", async () => {
    await saveCredentialFor(fixture.companyA.id, fixture.adminA.id, "RECEITANET", "CALLCENTER", TOKEN_CALLCENTER);
    await saveCredentialFor(fixture.companyA.id, fixture.adminA.id, "RECEITANET", "CHATBOT", TOKEN_CHATBOT);

    // Cada API recebe SOMENTE o seu token — é o ponto da separação.
    expect(await getCredentialFor(fixture.companyA.id, "RECEITANET", "CALLCENTER")).toBe(TOKEN_CALLCENTER);
    expect(await getCredentialFor(fixture.companyA.id, "RECEITANET", "CHATBOT")).toBe(TOKEN_CHATBOT);
  });

  /**
   * Mesmo valor nas duas não as funde: continuam duas linhas, dois ciclos de
   * vida. Trocar uma depois não pode arrastar a outra só porque coincidiam.
   */
  it("mesmo VALOR nas duas continua sendo duas credenciais", async () => {
    const mesmo = "token-identico-nas-duas-CCCC";
    await saveCredentialFor(fixture.companyA.id, fixture.adminA.id, "RECEITANET", "CALLCENTER", mesmo);
    await saveCredentialFor(fixture.companyA.id, fixture.adminA.id, "RECEITANET", "CHATBOT", mesmo);

    expect(await prisma.eRPCredential.count({ where: { companyId: fixture.companyA.id } })).toBe(2);

    await saveCredentialFor(fixture.companyA.id, fixture.adminA.id, "RECEITANET", "CHATBOT", TOKEN_CHATBOT);

    expect(await getCredentialFor(fixture.companyA.id, "RECEITANET", "CALLCENTER")).toBe(mesmo);
    expect(await getCredentialFor(fixture.companyA.id, "RECEITANET", "CHATBOT")).toBe(TOKEN_CHATBOT);
  });
});

// ---------------------------------------------------------------------------
// Isolamento de ciclo de vida — a regressão que já aconteceu
// ---------------------------------------------------------------------------

describe("Mexer numa credencial nunca toca a outra", () => {
  beforeEach(async () => {
    await saveCredentialFor(fixture.companyA.id, fixture.adminA.id, "RECEITANET", "CALLCENTER", TOKEN_CALLCENTER);
    await saveCredentialFor(fixture.companyA.id, fixture.adminA.id, "RECEITANET", "CHATBOT", TOKEN_CHATBOT);
  });

  it("REGRESSÃO: atualizar o Chatbot preserva o CallCenter", async () => {
    await saveCredentialFor(fixture.companyA.id, fixture.adminA.id, "RECEITANET", "CHATBOT", "token-chatbot-novo-DDDD");

    expect(await getCredentialFor(fixture.companyA.id, "RECEITANET", "CALLCENTER")).toBe(TOKEN_CALLCENTER);
  });

  it("REGRESSÃO: atualizar o CallCenter preserva o Chatbot", async () => {
    await saveCredentialFor(fixture.companyA.id, fixture.adminA.id, "RECEITANET", "CALLCENTER", "token-cc-novo-EEEE");

    expect(await getCredentialFor(fixture.companyA.id, "RECEITANET", "CHATBOT")).toBe(TOKEN_CHATBOT);
  });

  it("REGRESSÃO: remover o Chatbot preserva o CallCenter", async () => {
    await removeCredentialFor(fixture.companyA.id, fixture.adminA.id, "RECEITANET", "CHATBOT");

    expect(await getCredentialFor(fixture.companyA.id, "RECEITANET", "CHATBOT")).toBeNull();
    expect(await getCredentialFor(fixture.companyA.id, "RECEITANET", "CALLCENTER")).toBe(TOKEN_CALLCENTER);
  });

  it("REGRESSÃO: remover o CallCenter preserva o Chatbot", async () => {
    await removeCredentialFor(fixture.companyA.id, fixture.adminA.id, "RECEITANET", "CALLCENTER");

    expect(await getCredentialFor(fixture.companyA.id, "RECEITANET", "CALLCENTER")).toBeNull();
    expect(await getCredentialFor(fixture.companyA.id, "RECEITANET", "CHATBOT")).toBe(TOKEN_CHATBOT);
  });
});

// ---------------------------------------------------------------------------
// Multi-tenant e vínculo do ciphertext
// ---------------------------------------------------------------------------

describe("Isolamento entre empresas e entre APIs", () => {
  it("empresa B não alcança a credencial da empresa A", async () => {
    await saveCredentialFor(fixture.companyA.id, fixture.adminA.id, "RECEITANET", "CALLCENTER", TOKEN_CALLCENTER);

    expect(await getCredentialFor(fixture.companyB.id, "RECEITANET", "CALLCENTER")).toBeNull();
    // Controle positivo: a de A existe e é legível por A.
    expect(await getCredentialFor(fixture.companyA.id, "RECEITANET", "CALLCENTER")).toBe(TOKEN_CALLCENTER);
  });

  /**
   * O ataque que o AAD v2 fecha: transplantar o ciphertext do Chatbot para a
   * linha do CallCenter. Com AAD só de (empresa, provider), os dois seriam
   * intercambiáveis — e são tokens com privilégios diferentes, já que o do
   * Chatbot devolve senha de cliente em texto puro.
   */
  it("ciphertext do Chatbot não decripta na linha do CallCenter", async () => {
    await saveCredentialFor(fixture.companyA.id, fixture.adminA.id, "RECEITANET", "CHATBOT", TOKEN_CHATBOT);
    await saveCredentialFor(fixture.companyA.id, fixture.adminA.id, "RECEITANET", "CALLCENTER", TOKEN_CALLCENTER);

    const chatbot = await prisma.eRPCredential.findFirstOrThrow({
      where: { companyId: fixture.companyA.id, kind: "CHATBOT" },
    });

    // Transplante direto no banco.
    await prisma.eRPCredential.updateMany({
      where: { companyId: fixture.companyA.id, kind: "CALLCENTER" },
      data: {
        credentialCiphertext: chatbot.credentialCiphertext,
        credentialIv: chatbot.credentialIv,
        credentialAuthTag: chatbot.credentialAuthTag,
      },
    });

    await expect(
      getCredentialFor(fixture.companyA.id, "RECEITANET", "CALLCENTER"),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// A migração não pode custar o token que a empresa já tinha
// ---------------------------------------------------------------------------

describe("Credencial migrada (AAD v1) continua utilizável", () => {
  /**
   * Reproduz exatamente o que a migration produziu: ciphertext cifrado com o
   * AAD antigo — (empresa, provider), SEM `kind` — numa linha marcada `v1`.
   */
  async function seedLegacyRow(companyId: string, token: string) {
    const encrypted = encryptCredential(token, {
      companyId,
      provider: "RECEITANET",
    });
    await prisma.eRPCredential.create({
      data: {
        companyId,
        provider: "RECEITANET",
        kind: "CALLCENTER",
        credentialCiphertext: encrypted.ciphertext,
        credentialIv: encrypted.iv,
        credentialAuthTag: encrypted.authTag,
        credentialLast4: token.slice(-4),
        aadVersion: "v1",
      },
    });
  }

  it("REGRESSÃO: token migrado decripta sem reconfiguração", async () => {
    await seedLegacyRow(fixture.companyA.id, TOKEN_CALLCENTER);

    // Se a migração tivesse recomputado o AAD como v2, isto lançaria — e a
    // empresa perderia um token que estava funcionando.
    expect(
      await getCredentialFor(fixture.companyA.id, "RECEITANET", "CALLCENTER"),
    ).toBe(TOKEN_CALLCENTER);
  });

  it("regravar promove a linha de v1 para v2", async () => {
    await seedLegacyRow(fixture.companyA.id, TOKEN_CALLCENTER);

    await saveCredentialFor(
      fixture.companyA.id,
      fixture.adminA.id,
      "RECEITANET",
      "CALLCENTER",
      "token-cc-regravado-FFFF",
    );

    const row = await prisma.eRPCredential.findFirstOrThrow({
      where: { companyId: fixture.companyA.id, kind: "CALLCENTER" },
    });
    expect(row.aadVersion).toBe("v2");
    expect(
      await getCredentialFor(fixture.companyA.id, "RECEITANET", "CALLCENTER"),
    ).toBe("token-cc-regravado-FFFF");
  });

  it("uma linha v1 e outra v2 coexistem na mesma empresa", async () => {
    await seedLegacyRow(fixture.companyA.id, TOKEN_CALLCENTER);
    await saveCredentialFor(fixture.companyA.id, fixture.adminA.id, "RECEITANET", "CHATBOT", TOKEN_CHATBOT);

    expect(await getCredentialFor(fixture.companyA.id, "RECEITANET", "CALLCENTER")).toBe(TOKEN_CALLCENTER);
    expect(await getCredentialFor(fixture.companyA.id, "RECEITANET", "CHATBOT")).toBe(TOKEN_CHATBOT);
  });
});

// ---------------------------------------------------------------------------
// O token não escapa
// ---------------------------------------------------------------------------

describe("O token nunca vaza por status nem por auditoria", () => {
  it("status expõe configurado e last4, nunca o token", async () => {
    await saveCredentialFor(fixture.companyA.id, fixture.adminA.id, "RECEITANET", "CALLCENTER", TOKEN_CALLCENTER);

    const status = await listCredentialStatus(fixture.companyA.id, "RECEITANET", [
      "CALLCENTER",
      "CHATBOT",
    ]);

    expect(JSON.stringify(status)).not.toContain(TOKEN_CALLCENTER);
    expect(status.find((s) => s.kind === "CALLCENTER")?.configured).toBe(true);
    expect(status.find((s) => s.kind === "CHATBOT")?.configured).toBe(false);
  });

  it("REGRESSÃO: AuditLog não carrega o token nem o last4", async () => {
    await saveCredentialFor(fixture.companyA.id, fixture.adminA.id, "RECEITANET", "CHATBOT", TOKEN_CHATBOT);

    const logs = await prisma.auditLog.findMany({
      where: { companyId: fixture.companyA.id, action: { startsWith: "ERP_CREDENTIAL" } },
    });

    expect(logs.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain(TOKEN_CHATBOT);
    // last4 é fragmento do segredo e também não entra.
    expect(serialized).not.toContain(TOKEN_CHATBOT.slice(-4));
  });

  it("token curto demais é recusado antes de qualquer escrita", async () => {
    await expect(
      saveCredentialFor(fixture.companyA.id, fixture.adminA.id, "RECEITANET", "CHATBOT", "curto"),
    ).rejects.toThrow();

    expect(await prisma.eRPCredential.count({ where: { companyId: fixture.companyA.id } })).toBe(0);
  });
});
