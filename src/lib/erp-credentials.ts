import type { ERPProvider } from "@prisma/client";
import { prisma } from "./prisma";
import { logAudit } from "./audit";
import { badRequest, notFound } from "./errors";
import {
  credentialLast4,
  CredentialEncryptionUnavailableError,
  decryptCredential,
  encryptCredential,
  isCredentialEncryptionConfigured,
} from "./erp-credential-cipher";

/**
 * ERPCredentialService — the only path through which an ERP token is written,
 * read or removed.
 *
 * Sits between the cipher (which knows nothing about the database) and the
 * routes/UI (which know nothing about encryption). A future ReceitaNet adapter
 * asks this service for a credential and never learns how it is stored.
 *
 * Two rules hold everywhere below:
 *  - the plaintext token exists only inside a single function call; nothing
 *    returns it except `getCredential`, which is server-only and used by
 *    adapters;
 *  - a missing or broken master key fails CLOSED. There is no path that falls
 *    back to storing plaintext.
 */

/**
 * Tokens are provider-opaque, so length is the only thing worth bounding —
 * and only to stop an absurd payload from reaching the database. Real API keys
 * sit far below this.
 */
export const CREDENTIAL_MAX_LENGTH = 4096;
export const CREDENTIAL_MIN_LENGTH = 8;

/** Safe to return from an API. Contains no secret material. */
export interface ErpCredentialStatus {
  provider: ERPProvider;
  configured: boolean;
  last4: string | null;
  updatedAt: Date | null;
  /**
   * Whether the server can encrypt/decrypt at all. Surfaced so an operator
   * sees "the key is missing" instead of a save that mysteriously fails.
   */
  encryptionAvailable: boolean;
}

export { CredentialEncryptionUnavailableError };

/**
 * Status for the admin screen.
 *
 * Deliberately returns only what may be shown: provider, a boolean, the last
 * four characters and a timestamp. There is no variant of this function that
 * returns the token — an admin who wants to know the credential must replace
 * it, which is the property "never show the full token again" depends on.
 */
export async function getCredentialStatus(
  companyId: string,
): Promise<ErpCredentialStatus> {
  const integration = await prisma.eRPIntegration.findFirst({
    where: { companyId },
    select: {
      provider: true,
      credentialCiphertext: true,
      credentialLast4: true,
      credentialUpdatedAt: true,
    },
  });

  return {
    provider: integration?.provider ?? "MOCK",
    configured: Boolean(integration?.credentialCiphertext),
    last4: integration?.credentialLast4 ?? null,
    updatedAt: integration?.credentialUpdatedAt ?? null,
    encryptionAvailable: isCredentialEncryptionConfigured(),
  };
}

export async function hasCredential(companyId: string): Promise<boolean> {
  const found = await prisma.eRPIntegration.findFirst({
    where: { companyId, credentialCiphertext: { not: null } },
    select: { id: true },
  });
  return found !== null;
}

/**
 * Saves or replaces the company's ERP credential.
 *
 * Encryption happens BEFORE the write, so a configuration problem (missing or
 * malformed key) aborts with nothing persisted — the failure can never leave a
 * half-configured integration or, worse, a plaintext fallback.
 *
 * The distinction between SAVED and REPLACED is read before writing, purely so
 * the audit trail says which one happened.
 */
export async function saveCredential(
  companyId: string,
  actorUserId: string,
  token: string,
): Promise<ErpCredentialStatus> {
  if (token.length < CREDENTIAL_MIN_LENGTH) {
    throw badRequest(
      `Token deve ter ao menos ${CREDENTIAL_MIN_LENGTH} caracteres.`,
    );
  }
  if (token.length > CREDENTIAL_MAX_LENGTH) {
    throw badRequest(
      `Token deve ter no máximo ${CREDENTIAL_MAX_LENGTH} caracteres.`,
    );
  }

  const integration = await prisma.eRPIntegration.findFirst({
    where: { companyId },
    select: { id: true, provider: true, credentialCiphertext: true },
  });
  if (!integration) {
    throw notFound("Integração não configurada para esta empresa.");
  }

  const replacing = Boolean(integration.credentialCiphertext);

  // Throws CredentialEncryptionUnavailableError when the key is absent or
  // malformed — nothing below runs, so nothing is written.
  //
  // The binding context comes from the row we just read under a tenant-scoped
  // query: `companyId` is the caller's session company (never the request
  // body) and `provider` is whatever the integration actually is. Nothing the
  // client sends can influence either, which is what makes the binding
  // meaningful rather than decorative.
  const encrypted = encryptCredential(token, {
    companyId,
    provider: integration.provider,
  });

  const saved = await prisma.eRPIntegration.update({
    // Scoped by BOTH id and companyId: the id came from a tenant-filtered read
    // above, and repeating the tenant here means a future refactor cannot
    // accidentally widen this write.
    where: { id: integration.id, companyId },
    data: {
      credentialCiphertext: encrypted.ciphertext,
      credentialIv: encrypted.iv,
      credentialAuthTag: encrypted.authTag,
      credentialLast4: credentialLast4(token),
      credentialUpdatedAt: new Date(),
      // The legacy plaintext column is explicitly cleared on every save, so a
      // company that had a value there stops carrying it the moment a real
      // credential is configured.
      apiKey: null,
    },
    select: {
      provider: true,
      credentialLast4: true,
      credentialUpdatedAt: true,
    },
  });

  await logAudit({
    companyId,
    userId: actorUserId,
    action: replacing ? "ERP_CREDENTIAL_REPLACED" : "ERP_CREDENTIAL_SAVED",
    entity: "ERPIntegration",
    entityId: integration.id,
    // Provider only. No token, no ciphertext, no IV, no tag, not even the
    // last4 — the trail records that a credential changed, not what it is.
    details: `Credencial do provedor ${integration.provider} ${
      replacing ? "substituída" : "salva"
    }`,
  });

  return {
    provider: saved.provider,
    configured: true,
    last4: saved.credentialLast4,
    updatedAt: saved.credentialUpdatedAt,
    encryptionAvailable: true,
  };
}

/**
 * Removes the credential.
 *
 * Every credential field is cleared together — leaving an orphan IV or tag
 * behind would make `configured` ambiguous and could resurrect a partially
 * decryptable state. Works even when the master key is missing: deleting a
 * secret must never depend on being able to read it.
 */
export async function removeCredential(
  companyId: string,
  actorUserId: string,
): Promise<ErpCredentialStatus> {
  const integration = await prisma.eRPIntegration.findFirst({
    where: { companyId },
    select: { id: true, provider: true },
  });
  if (!integration) {
    throw notFound("Integração não configurada para esta empresa.");
  }

  await prisma.eRPIntegration.update({
    where: { id: integration.id, companyId },
    data: {
      credentialCiphertext: null,
      credentialIv: null,
      credentialAuthTag: null,
      credentialLast4: null,
      credentialUpdatedAt: null,
      apiKey: null,
    },
  });

  await logAudit({
    companyId,
    userId: actorUserId,
    action: "ERP_CREDENTIAL_REMOVED",
    entity: "ERPIntegration",
    entityId: integration.id,
    details: `Credencial do provedor ${integration.provider} removida`,
  });

  return {
    provider: integration.provider,
    configured: false,
    last4: null,
    updatedAt: null,
    encryptionAvailable: isCredentialEncryptionConfigured(),
  };
}

/**
 * Returns the plaintext credential for a company, for adapter use only.
 *
 * SERVER-ONLY. Nothing in an HTTP response, a Server Component payload or a
 * log may carry this value. It exists so a future ReceitaNet adapter can
 * authenticate without knowing how the secret is stored — which is the whole
 * reason this service exists.
 *
 * Returns null when no credential is configured; throws when one exists but
 * cannot be decrypted, because silently treating a corrupted credential as
 * "absent" would turn a tampering event into a routine "not configured".
 */
export async function getCredential(
  companyId: string,
): Promise<string | null> {
  const integration = await prisma.eRPIntegration.findFirst({
    where: { companyId },
    select: {
      provider: true,
      credentialCiphertext: true,
      credentialIv: true,
      credentialAuthTag: true,
    },
  });

  if (
    !integration?.credentialCiphertext ||
    !integration.credentialIv ||
    !integration.credentialAuthTag
  ) {
    return null;
  }

  // The AAD is rebuilt from the row's real identity — the `companyId` this
  // function was scoped by, and the provider stored on that same row. A
  // ciphertext transplanted from another company or another provider verifies
  // against THIS identity and fails, which is the whole point of the binding.
  //
  // Credentials written before the binding existed (no AAD) also fail here, on
  // purpose: there is deliberately NO unbound fallback, because accepting one
  // would keep the transplant vector alive. Such credentials must be
  // reconfigured — see docs/SECURITY.md §8.4.
  return decryptCredential(
    {
      ciphertext: integration.credentialCiphertext,
      iv: integration.credentialIv,
      authTag: integration.credentialAuthTag,
    },
    { companyId, provider: integration.provider },
  );
}
