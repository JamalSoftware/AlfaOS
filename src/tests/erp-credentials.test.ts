import { describe, it, expect, beforeEach } from "vitest";
import { createCipheriv, randomBytes } from "node:crypto";
import {
  GET as getCredential,
  PUT as putCredential,
  DELETE as deleteCredential,
} from "@/app/api/integrations/credential/route";
import { prisma } from "@/lib/prisma";
import {
  buildCredentialAad,
  credentialLast4,
  CredentialEncryptionUnavailableError,
  decryptCredential,
  encryptCredential,
  isCredentialEncryptionConfigured,
} from "@/lib/erp-credential-cipher";
import {
  getCredentialFor,
  saveCredentialFor,
} from "@/lib/erp-credential-store";
import {
  getCredential as readCredential,
  getCredentialStatus,
  hasCredential,
  removeCredential,
  saveCredential,
} from "@/lib/erp-credentials";
import {
  apiRequest,
  createTokenFor,
  seedTestData,
  type TestFixture,
} from "./helpers";

let fixture: TestFixture;

const TOKEN = "rn_live_sk_9f3a2b7c4d1e8f0a5b6c7d8e9f0a1b2c3d4e5A9F2";
const OTHER_TOKEN = "rn_live_sk_00000000000000000000000000000000000ZZ99";

beforeEach(async () => {
  fixture = await seedTestData();
});

async function integrationFor(companyId: string, provider: "MOCK" | "RECEITANET" = "RECEITANET") {
  return prisma.eRPIntegration.create({
    data: { companyId, provider, name: "ERP", enabled: false },
  });
}

// ---------------------------------------------------------------------------
// Cipher
// ---------------------------------------------------------------------------

/** The binding context used across the cipher tests. */
const CTX_A = { companyId: "company_aaa", provider: "RECEITANET" };
const CTX_B = { companyId: "company_bbb", provider: "RECEITANET" };
const CTX_A_MOCK = { companyId: "company_aaa", provider: "MOCK" };

describe("Criptografia de credenciais (AES-256-GCM)", () => {
  it("encrypt → decrypt com o MESMO companyId + provider funciona", () => {
    const enc = encryptCredential(TOKEN, CTX_A);
    expect(decryptCredential(enc, CTX_A)).toBe(TOKEN);
  });

  it("o mesmo token cifrado duas vezes gera ciphertext e IV diferentes", () => {
    const a = encryptCredential(TOKEN, CTX_A);
    const b = encryptCredential(TOKEN, CTX_A);
    // Without a fresh IV per encryption, an observer of the database could tell
    // that two companies configured the same credential.
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.iv).not.toBe(b.iv);
    expect(a.authTag).not.toBe(b.authTag);
    // Both still decrypt to the same plaintext.
    expect(decryptCredential(a, CTX_A)).toBe(TOKEN);
    expect(decryptCredential(b, CTX_A)).toBe(TOKEN);
  });

  it("o ciphertext não contém o token em texto puro", () => {
    const enc = encryptCredential(TOKEN, CTX_A);
    const blob = `${enc.ciphertext}${enc.iv}${enc.authTag}`;
    expect(blob).not.toContain(TOKEN);
    expect(Buffer.from(enc.ciphertext, "base64").toString("utf8")).not.toContain(
      TOKEN,
    );
  });

  it("chave errada falha", () => {
    const enc = encryptCredential(TOKEN, CTX_A);
    const original = process.env.ERP_CREDENTIAL_ENCRYPTION_KEY;
    process.env.ERP_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString(
      "base64",
    );
    try {
      expect(() => decryptCredential(enc, CTX_A)).toThrow(
        CredentialEncryptionUnavailableError,
      );
    } finally {
      process.env.ERP_CREDENTIAL_ENCRYPTION_KEY = original;
    }
  });

  it("ciphertext alterado falha", () => {
    const enc = encryptCredential(TOKEN, CTX_A);
    const bytes = Buffer.from(enc.ciphertext, "base64");
    bytes[0] ^= 0xff;
    expect(() =>
      decryptCredential({ ...enc, ciphertext: bytes.toString("base64") }, CTX_A),
    ).toThrow(CredentialEncryptionUnavailableError);
  });

  it("auth tag alterada falha", () => {
    const enc = encryptCredential(TOKEN, CTX_A);
    const tag = Buffer.from(enc.authTag, "base64");
    tag[0] ^= 0xff;
    expect(() =>
      decryptCredential({ ...enc, authTag: tag.toString("base64") }, CTX_A),
    ).toThrow(CredentialEncryptionUnavailableError);
  });

  it("IV alterado falha", () => {
    const enc = encryptCredential(TOKEN, CTX_A);
    const iv = Buffer.from(enc.iv, "base64");
    iv[0] ^= 0xff;
    expect(() =>
      decryptCredential({ ...enc, iv: iv.toString("base64") }, CTX_A),
    ).toThrow(CredentialEncryptionUnavailableError);
  });

  it("chave ausente ou malformada => falha fechada", () => {
    const original = process.env.ERP_CREDENTIAL_ENCRYPTION_KEY;
    try {
      delete process.env.ERP_CREDENTIAL_ENCRYPTION_KEY;
      expect(isCredentialEncryptionConfigured()).toBe(false);
      expect(() => encryptCredential(TOKEN, CTX_A)).toThrow(
        CredentialEncryptionUnavailableError,
      );

      // Right shape, wrong length — must not be accepted.
      process.env.ERP_CREDENTIAL_ENCRYPTION_KEY =
        Buffer.alloc(16, 1).toString("base64");
      expect(isCredentialEncryptionConfigured()).toBe(false);
      expect(() => encryptCredential(TOKEN, CTX_A)).toThrow(
        CredentialEncryptionUnavailableError,
      );
    } finally {
      process.env.ERP_CREDENTIAL_ENCRYPTION_KEY = original;
    }
  });

  it("a mensagem de erro nunca contém a chave nem o token", () => {
    const original = process.env.ERP_CREDENTIAL_ENCRYPTION_KEY;
    try {
      delete process.env.ERP_CREDENTIAL_ENCRYPTION_KEY;
      let message = "";
      try {
        encryptCredential(TOKEN, CTX_A);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).not.toContain(TOKEN);
      expect(message).not.toContain(original ?? "___");
    } finally {
      process.env.ERP_CREDENTIAL_ENCRYPTION_KEY = original;
    }
  });

  it("last4 expõe no máximo 4 caracteres e nada para tokens curtos", () => {
    expect(credentialLast4(TOKEN)).toBe("A9F2");
    expect(credentialLast4(TOKEN)).toHaveLength(4);
    expect(credentialLast4("abcd")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// AAD binding — regression for the audit's ciphertext-swap attack
// ---------------------------------------------------------------------------

describe("Binding criptográfico (AAD) a companyId + provider", () => {
  it("companyId diferente => decrypt FALHA", () => {
    const enc = encryptCredential(TOKEN, CTX_A);
    // Exactly the transplant the audit performed: same bytes, other company.
    expect(() => decryptCredential(enc, CTX_B)).toThrow(
      CredentialEncryptionUnavailableError,
    );
  });

  it("provider diferente => decrypt FALHA", () => {
    const enc = encryptCredential(TOKEN, CTX_A);
    expect(() => decryptCredential(enc, CTX_A_MOCK)).toThrow(
      CredentialEncryptionUnavailableError,
    );
  });

  it("controle positivo: companyId e provider corretos continuam funcionando", () => {
    // Without this, the two negative tests above could pass on a cipher that
    // simply never decrypts anything.
    expect(decryptCredential(encryptCredential(TOKEN, CTX_A), CTX_A)).toBe(TOKEN);
    expect(decryptCredential(encryptCredential(TOKEN, CTX_B), CTX_B)).toBe(TOKEN);
    expect(
      decryptCredential(encryptCredential(TOKEN, CTX_A_MOCK), CTX_A_MOCK),
    ).toBe(TOKEN);
  });

  it("o AAD é determinístico e não é ambíguo entre pares distintos", () => {
    expect(buildCredentialAad(CTX_A).equals(buildCredentialAad(CTX_A))).toBe(true);
    expect(buildCredentialAad(CTX_A).equals(buildCredentialAad(CTX_B))).toBe(false);

    // Length prefixes are what stop a delimiter in one field from producing the
    // same AAD as a different (company, provider) pair.
    const collidingA = { companyId: "ab", provider: "c:d" };
    const collidingB = { companyId: "ab:c", provider: "d" };
    expect(
      buildCredentialAad(collidingA).equals(buildCredentialAad(collidingB)),
    ).toBe(false);
  });

  it("o AAD não é armazenado junto do ciphertext", () => {
    const enc = encryptCredential(TOKEN, CTX_A);
    const blob = `${enc.ciphertext}${enc.iv}${enc.authTag}`;
    // It is recomputed from the row's identity on decrypt; persisting it would
    // let an attacker transplant the binding along with the bytes.
    expect(blob).not.toContain(CTX_A.companyId);
    expect(blob).not.toContain(CTX_A.provider);
  });
});

// ---------------------------------------------------------------------------
// Service + persistence
// ---------------------------------------------------------------------------

describe("ERPCredentialService", () => {
  it("salva cifrado: o banco não contém o token em texto puro", async () => {
    await integrationFor(fixture.companyA.id);
    await saveCredential(fixture.companyA.id, fixture.adminA.id, TOKEN);

    const row = await prisma.eRPIntegration.findFirstOrThrow({
      where: { companyId: fixture.companyA.id },
    });

    // The decisive assertion: nothing stored equals or contains the plaintext.
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain(TOKEN);
    expect(row.credentialCiphertext).not.toBeNull();
    expect(row.credentialCiphertext).not.toContain(TOKEN);
    expect(row.credentialIv).not.toBeNull();
    expect(row.credentialAuthTag).not.toBeNull();
    expect(row.credentialLast4).toBe("A9F2");
    expect(row.credentialUpdatedAt).not.toBeNull();
    // The legacy plaintext column stays empty.
    expect(row.apiKey).toBeNull();

    // And it round-trips through the service.
    expect(await readCredential(fixture.companyA.id, "RECEITANET")).toBe(TOKEN);
  });

  it("substituir troca ciphertext, IV, tag e last4", async () => {
    await integrationFor(fixture.companyA.id);
    await saveCredential(fixture.companyA.id, fixture.adminA.id, TOKEN);
    const first = await prisma.eRPIntegration.findFirstOrThrow({
      where: { companyId: fixture.companyA.id },
    });

    await saveCredential(fixture.companyA.id, fixture.adminA.id, OTHER_TOKEN);
    const second = await prisma.eRPIntegration.findFirstOrThrow({
      where: { companyId: fixture.companyA.id },
    });

    expect(second.credentialCiphertext).not.toBe(first.credentialCiphertext);
    expect(second.credentialIv).not.toBe(first.credentialIv);
    expect(second.credentialLast4).toBe("ZZ99");
    expect(await readCredential(fixture.companyA.id, "RECEITANET")).toBe(OTHER_TOKEN);
  });

  it("remover limpa todos os campos de credencial", async () => {
    await integrationFor(fixture.companyA.id);
    await saveCredential(fixture.companyA.id, fixture.adminA.id, TOKEN);
    expect(await hasCredential(fixture.companyA.id)).toBe(true);

    await removeCredential(fixture.companyA.id, fixture.adminA.id);

    const row = await prisma.eRPIntegration.findFirstOrThrow({
      where: { companyId: fixture.companyA.id },
    });
    // All together — an orphan IV or tag would make `configured` ambiguous.
    expect(row.credentialCiphertext).toBeNull();
    expect(row.credentialIv).toBeNull();
    expect(row.credentialAuthTag).toBeNull();
    expect(row.credentialLast4).toBeNull();
    expect(row.credentialUpdatedAt).toBeNull();
    expect(await hasCredential(fixture.companyA.id)).toBe(false);
    expect(await readCredential(fixture.companyA.id, "RECEITANET")).toBeNull();
  });

  it("remoção funciona mesmo sem a chave mestra", async () => {
    await integrationFor(fixture.companyA.id);
    await saveCredential(fixture.companyA.id, fixture.adminA.id, TOKEN);

    const original = process.env.ERP_CREDENTIAL_ENCRYPTION_KEY;
    try {
      delete process.env.ERP_CREDENTIAL_ENCRYPTION_KEY;
      // Deleting a secret must not depend on being able to read it.
      await expect(
        removeCredential(fixture.companyA.id, fixture.adminA.id),
      ).resolves.toMatchObject({ configured: false });
    } finally {
      process.env.ERP_CREDENTIAL_ENCRYPTION_KEY = original;
    }
    expect(await hasCredential(fixture.companyA.id)).toBe(false);
  });

  it("sem a chave mestra, salvar falha e NADA é persistido", async () => {
    await integrationFor(fixture.companyA.id);
    const original = process.env.ERP_CREDENTIAL_ENCRYPTION_KEY;
    try {
      delete process.env.ERP_CREDENTIAL_ENCRYPTION_KEY;
      await expect(
        saveCredential(fixture.companyA.id, fixture.adminA.id, TOKEN),
      ).rejects.toBeInstanceOf(CredentialEncryptionUnavailableError);
    } finally {
      process.env.ERP_CREDENTIAL_ENCRYPTION_KEY = original;
    }

    const row = await prisma.eRPIntegration.findFirstOrThrow({
      where: { companyId: fixture.companyA.id },
    });
    // No plaintext fallback — the whole point.
    expect(row.credentialCiphertext).toBeNull();
    expect(row.apiKey).toBeNull();
    expect(JSON.stringify(row)).not.toContain(TOKEN);
  });

  it("status nunca inclui material secreto", async () => {
    await integrationFor(fixture.companyA.id);
    await saveCredential(fixture.companyA.id, fixture.adminA.id, TOKEN);

    const status = await getCredentialStatus(fixture.companyA.id);
    const serialized = JSON.stringify(status);
    expect(status.configured).toBe(true);
    expect(status.last4).toBe("A9F2");
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toMatch(/ciphertext|authTag|"iv"/i);
  });
});

// ---------------------------------------------------------------------------
// Ciphertext swap — the audit's attack, end to end through the service
// ---------------------------------------------------------------------------

describe("Ataque de transplante de ciphertext (regressão da auditoria)", () => {
  it("transplantar ciphertext de A para B: B NÃO consegue ler o token de A", async () => {
    await integrationFor(fixture.companyA.id);
    await integrationFor(fixture.companyB.id);
    await saveCredential(fixture.companyA.id, fixture.adminA.id, TOKEN);
    await saveCredential(fixture.companyB.id, fixture.adminB.id, OTHER_TOKEN);

    // Positive control first: each company reads its own.
    expect(await readCredential(fixture.companyA.id, "RECEITANET")).toBe(TOKEN);
    expect(await readCredential(fixture.companyB.id, "RECEITANET")).toBe(OTHER_TOKEN);

    const rowA = await prisma.eRPIntegration.findFirstOrThrow({
      where: { companyId: fixture.companyA.id },
    });
    const rowB = await prisma.eRPIntegration.findFirstOrThrow({
      where: { companyId: fixture.companyB.id },
    });

    // The exact transplant the audit performed: A's encrypted bytes written
    // into B's row, simulating an attacker with direct database write access.
    await prisma.eRPIntegration.update({
      where: { id: rowB.id },
      data: {
        credentialCiphertext: rowA.credentialCiphertext,
        credentialIv: rowA.credentialIv,
        credentialAuthTag: rowA.credentialAuthTag,
        credentialLast4: rowA.credentialLast4,
      },
    });

    // Before the AAD this returned A's token. Now the tag check fails.
    await expect(readCredential(fixture.companyB.id, "RECEITANET")).rejects.toBeInstanceOf(
      CredentialEncryptionUnavailableError,
    );

    // A's own credential is untouched by the attack.
    expect(await readCredential(fixture.companyA.id, "RECEITANET")).toBe(TOKEN);
  });

  it("transplantar ciphertext entre PROVIDERS: decrypt falha", async () => {
    const integration = await integrationFor(fixture.companyA.id, "RECEITANET");
    await saveCredential(fixture.companyA.id, fixture.adminA.id, TOKEN);
    expect(await readCredential(fixture.companyA.id, "RECEITANET")).toBe(TOKEN);

    // Same company, same row, same bytes — only the provider changes.
    await prisma.eRPIntegration.update({
      where: { id: integration.id },
      data: { provider: "MOCK" },
    });

    // Pedindo MOCK, que é o que a linha diz agora — um chamador real resolve o
    // adapter do provider gravado. A comparação de provider não intercepta
    // este caso, então quem recusa é o AAD, que é o ponto do teste.
    await expect(readCredential(fixture.companyA.id, "MOCK")).rejects.toBeInstanceOf(
      CredentialEncryptionUnavailableError,
    );

    // Restoring the real provider makes it readable again — proving the
    // failure came from the binding, not from corruption.
    await prisma.eRPIntegration.update({
      where: { id: integration.id },
      data: { provider: "RECEITANET" },
    });
    expect(await readCredential(fixture.companyA.id, "RECEITANET")).toBe(TOKEN);
  });

  it("credencial sem AAD (formato antigo) falha: não há fallback inseguro", async () => {
    const integration = await integrationFor(fixture.companyA.id);
    // Simulates a credential written before the binding existed. Accepting it
    // would keep the transplant vector alive, so it must fail closed.
    const unbound = encryptCredentialWithoutAad(TOKEN);
    await prisma.eRPIntegration.update({
      where: { id: integration.id },
      data: {
        credentialCiphertext: unbound.ciphertext,
        credentialIv: unbound.iv,
        credentialAuthTag: unbound.authTag,
        credentialLast4: "A9F2",
        credentialUpdatedAt: new Date(),
      },
    });

    await expect(readCredential(fixture.companyA.id, "RECEITANET")).rejects.toBeInstanceOf(
      CredentialEncryptionUnavailableError,
    );

    // Reconfiguring fixes it — the documented recovery path.
    await saveCredential(fixture.companyA.id, fixture.adminA.id, TOKEN);
    expect(await readCredential(fixture.companyA.id, "RECEITANET")).toBe(TOKEN);
  });
});

/** Reproduces the pre-AAD encryption, to prove old ciphertexts are rejected. */
function encryptCredentialWithoutAad(plaintext: string) {
  const key = Buffer.from(process.env.ERP_CREDENTIAL_ENCRYPTION_KEY!, "base64");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

// ---------------------------------------------------------------------------
// AuditLog
// ---------------------------------------------------------------------------

describe("AuditLog de credenciais", () => {
  it("registra SAVED, REPLACED e REMOVED sem qualquer material secreto", async () => {
    await integrationFor(fixture.companyA.id);
    await saveCredential(fixture.companyA.id, fixture.adminA.id, TOKEN);
    await saveCredential(fixture.companyA.id, fixture.adminA.id, OTHER_TOKEN);
    await removeCredential(fixture.companyA.id, fixture.adminA.id);

    const logs = await prisma.auditLog.findMany({
      where: { companyId: fixture.companyA.id, action: { startsWith: "ERP_CREDENTIAL" } },
      orderBy: { createdAt: "asc" },
    });
    const actions = logs.map((l) => l.action);
    expect(actions).toContain("ERP_CREDENTIAL_SAVED");
    expect(actions).toContain("ERP_CREDENTIAL_REPLACED");
    expect(actions).toContain("ERP_CREDENTIAL_REMOVED");

    const blob = JSON.stringify(logs);
    expect(blob).not.toContain(TOKEN);
    expect(blob).not.toContain(OTHER_TOKEN);
    expect(blob).not.toContain("A9F2");
    expect(blob).not.toContain(process.env.ERP_CREDENTIAL_ENCRYPTION_KEY ?? "___");
    for (const log of logs) {
      expect(log.userId).toBe(fixture.adminA.id);
      expect(log.companyId).toBe(fixture.companyA.id);
    }
  });
});

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

describe("Autorização da rota de credencial", () => {
  async function scenario() {
    await integrationFor(fixture.companyA.id);
    return { token: await createTokenFor(fixture.adminA.id) };
  }

  it("ADMIN salva, substitui e remove", async () => {
    const s = await scenario();

    const saved = await putCredential(
      apiRequest(
        "/api/integrations/credential",
        { method: "PUT", body: { kind: "CALLCENTER", token: TOKEN } },
        s.token,
      ),
    );
    expect(saved.status).toBe(200);
    const savedBody = await saved.json();
    expect(savedBody.data.credential.configured).toBe(true);
    expect(savedBody.data.credential.last4).toBe("A9F2");

    const replaced = await putCredential(
      apiRequest(
        "/api/integrations/credential",
        { method: "PUT", body: { kind: "CALLCENTER", token: OTHER_TOKEN } },
        s.token,
      ),
    );
    expect(replaced.status).toBe(200);
    expect((await replaced.json()).data.credential.last4).toBe("ZZ99");

    const removed = await deleteCredential(
      apiRequest("/api/integrations/credential", { method: "DELETE", body: { kind: "CALLCENTER" } }, s.token),
    );
    expect(removed.status).toBe(200);
    const afterRemove = (await removed.json()).data.credentials;
    expect(afterRemove.find((c: { kind: string }) => c.kind === "CALLCENTER").configured).toBe(false);
  });

  it("DISPATCHER e TECHNICIAN recebem 403 em todos os verbos", async () => {
    await integrationFor(fixture.companyA.id);
    for (const userId of [fixture.dispatcherA.id, fixture.techA.id]) {
      const token = await createTokenFor(userId);
      const read = await getCredential(
        apiRequest("/api/integrations/credential", {}, token),
      );
      expect(read.status).toBe(403);
      const write = await putCredential(
        apiRequest(
          "/api/integrations/credential",
          { method: "PUT", body: { kind: "CALLCENTER", token: TOKEN } },
          token,
        ),
      );
      expect(write.status).toBe(403);
      const del = await deleteCredential(
        apiRequest("/api/integrations/credential", { method: "DELETE", body: { kind: "CALLCENTER" } }, token),
      );
      expect(del.status).toBe(403);
    }
  });

  it("não autenticado recebe 401", async () => {
    await integrationFor(fixture.companyA.id);
    expect(
      (await getCredential(apiRequest("/api/integrations/credential", {})))
        .status,
    ).toBe(401);
    expect(
      (
        await putCredential(
          apiRequest("/api/integrations/credential", {
            method: "PUT",
            body: { kind: "CALLCENTER", token: TOKEN },
          }),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await deleteCredential(
          apiRequest("/api/integrations/credential", { method: "DELETE", body: { kind: "CALLCENTER" } }),
        )
      ).status,
    ).toBe(401);
  });

  it("Origin de terceiro é bloqueado", async () => {
    const s = await scenario();
    const res = await putCredential(
      apiRequest(
        "/api/integrations/credential",
        {
          method: "PUT",
          body: { kind: "CALLCENTER", token: TOKEN },
          headers: { Origin: "https://evil.test" },
        },
        s.token,
      ),
    );
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Multi-tenancy
// ---------------------------------------------------------------------------

describe("Multi-tenancy de credenciais", () => {
  it("ADMIN da empresa B não lê, não substitui e não remove a credencial de A", async () => {
    await integrationFor(fixture.companyA.id);
    await integrationFor(fixture.companyB.id);
    // A rota escreve no store NOVO desde o cutover; o cenario precisa
    // montar a credencial de A no mesmo lugar que a rota consultaria.
    await saveCredentialFor(
      fixture.companyA.id,
      fixture.adminA.id,
      "RECEITANET",
      "CALLCENTER",
      TOKEN,
    );

    const tokenB = await createTokenFor(fixture.adminB.id);

    // B's session only ever reaches B's own row — the companyId comes from the
    // session, so there is no payload that redirects it at A.
    const read = await getCredential(
      apiRequest("/api/integrations/credential", {}, tokenB),
    );
    expect(read.status).toBe(200);
    const raw = await read.text();
    expect(raw).not.toContain(TOKEN);
    expect(
      JSON.parse(raw).data.credentials.find(
        (c: { kind: string }) => c.kind === "CALLCENTER",
      ).configured,
    ).toBe(false);

    // B removing "the" credential must not touch A's.
    await deleteCredential(
      apiRequest("/api/integrations/credential", { method: "DELETE", body: { kind: "CALLCENTER" } }, tokenB),
    );
    expect(
      await getCredentialFor(fixture.companyA.id, "RECEITANET", "CALLCENTER"),
    ).toBe(TOKEN);

    // And B saving its own does not disturb A's.
    await putCredential(
      apiRequest(
        "/api/integrations/credential",
        { method: "PUT", body: { kind: "CALLCENTER", token: OTHER_TOKEN } },
        tokenB,
      ),
    );
    expect(
      await getCredentialFor(fixture.companyA.id, "RECEITANET", "CALLCENTER"),
    ).toBe(TOKEN);
    expect(
      await getCredentialFor(fixture.companyB.id, "RECEITANET", "CALLCENTER"),
    ).toBe(OTHER_TOKEN);
  });
});

// ---------------------------------------------------------------------------
// Contract hardening
// ---------------------------------------------------------------------------

describe("Contrato da rota", () => {
  async function scenario() {
    await integrationFor(fixture.companyA.id);
    return { token: await createTokenFor(fixture.adminA.id) };
  }

  it("mass assignment é rejeitado", async () => {
    const s = await scenario();
    const banned = [
      "companyId",
      "provider",
      "credentialCiphertext",
      "ciphertext",
      "iv",
      "authTag",
      "last4",
      "credentialLast4",
      "credentialUpdatedAt",
      "apiKey",
      "enabled",
      "id",
    ];
    for (const field of banned) {
      const res = await putCredential(
        apiRequest(
          "/api/integrations/credential",
          { method: "PUT", body: { kind: "CALLCENTER", token: TOKEN, [field]: "evil" } },
          s.token,
        ),
      );
      expect(res.status, `campo ${field}`).toBe(400);
    }
    // None of those attempts configured anything.
    expect(await hasCredential(fixture.companyA.id)).toBe(false);
  });

  it("GET nunca devolve o token, nem depois de salvo", async () => {
    const s = await scenario();
    await putCredential(
      apiRequest(
        "/api/integrations/credential",
        { method: "PUT", body: { kind: "CALLCENTER", token: TOKEN } },
        s.token,
      ),
    );

    const res = await getCredential(
      apiRequest("/api/integrations/credential", {}, s.token),
    );
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).toContain("A9F2"); // masked fragment is expected
    expect(text).not.toContain(TOKEN);
    expect(text).not.toMatch(/ciphertext|authTag/i);
    // The stored ciphertext must not leak either.
    const row = await prisma.eRPIntegration.findFirstOrThrow({
      where: { companyId: fixture.companyA.id },
    });
    expect(text).not.toContain(row.credentialCiphertext ?? "___");
  });

  it("token fora dos limites de tamanho é recusado sem ecoar o valor", async () => {
    const s = await scenario();
    for (const bad of ["curto", "x".repeat(5000)]) {
      const res = await putCredential(
        apiRequest(
          "/api/integrations/credential",
          { method: "PUT", body: { token: bad } },
          s.token,
        ),
      );
      expect(res.status).toBe(400);
      // The rejected value must not come back in the error body.
      expect(await res.text()).not.toContain(bad);
    }
  });

  it("o token não aparece em resposta de erro quando a criptografia está indisponível", async () => {
    const s = await scenario();
    const original = process.env.ERP_CREDENTIAL_ENCRYPTION_KEY;
    try {
      delete process.env.ERP_CREDENTIAL_ENCRYPTION_KEY;
      const res = await putCredential(
        apiRequest(
          "/api/integrations/credential",
          { method: "PUT", body: { kind: "CALLCENTER", token: TOKEN } },
          s.token,
        ),
      );
      expect(res.status).toBe(503);
      const text = await res.text();
      expect(text).not.toContain(TOKEN);
      expect(text).toContain("ERP_CREDENTIAL_ENCRYPTION_KEY");
      expect(text).not.toContain(original ?? "___");
    } finally {
      process.env.ERP_CREDENTIAL_ENCRYPTION_KEY = original;
    }
    expect(await hasCredential(fixture.companyA.id)).toBe(false);
  });

  it("empresa sem integração configurada => 404 ao salvar", async () => {
    const token = await createTokenFor(fixture.adminA.id);
    const res = await putCredential(
      apiRequest(
        "/api/integrations/credential",
        { method: "PUT", body: { kind: "CALLCENTER", token: TOKEN } },
        token,
      ),
    );
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Legacy column
// ---------------------------------------------------------------------------

describe("Coluna legacy apiKey", () => {
  it("conteúdo plaintext preexistente não é migrado automaticamente", async () => {
    const integration = await integrationFor(fixture.companyA.id);
    await prisma.eRPIntegration.update({
      where: { id: integration.id },
      data: { apiKey: "legacy-plaintext-value" },
    });

    // Reading a credential must not resurrect the legacy value.
    expect(await readCredential(fixture.companyA.id, "RECEITANET")).toBeNull();
    expect(await hasCredential(fixture.companyA.id)).toBe(false);
    expect((await getCredentialStatus(fixture.companyA.id)).configured).toBe(
      false,
    );
  });

  it("salvar uma credencial limpa a coluna legacy", async () => {
    const integration = await integrationFor(fixture.companyA.id);
    await prisma.eRPIntegration.update({
      where: { id: integration.id },
      data: { apiKey: "legacy-plaintext-value" },
    });

    await saveCredential(fixture.companyA.id, fixture.adminA.id, TOKEN);

    const row = await prisma.eRPIntegration.findFirstOrThrow({
      where: { companyId: fixture.companyA.id },
    });
    expect(row.apiKey).toBeNull();
  });
});
