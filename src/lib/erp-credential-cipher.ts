import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * Authenticated encryption for ERP provider credentials.
 *
 * AES-256-GCM from `node:crypto` — a standard, well-reviewed construction from
 * the platform's own library, so no new dependency and no home-grown scheme.
 * GCM is chosen over plain CBC/CTR because it authenticates: a tampered
 * ciphertext fails loudly on decrypt instead of silently producing a wrong
 * token that would then be sent to a provider.
 *
 * This module knows nothing about Prisma, HTTP or the UI. It takes strings and
 * returns strings, which is what lets it be tested exhaustively on its own.
 */

/** GCM's standard nonce size. 12 bytes is the size the mode is designed for. */
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const KEY_BYTES = 32; // AES-256
const ALGORITHM = "aes-256-gcm";

export const ERP_CREDENTIAL_KEY_ENV = "ERP_CREDENTIAL_ENCRYPTION_KEY";

/**
 * Thrown when the master key is absent or malformed.
 *
 * A distinct type so callers can fail CLOSED on configuration problems: the
 * one outcome that must never happen is falling back to storing a token in
 * plaintext because the key was missing.
 */
export class CredentialEncryptionUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "CredentialEncryptionUnavailableError";
  }
}

export interface EncryptedCredential {
  ciphertext: string;
  iv: string;
  authTag: string;
}

/**
 * Loads and validates the master key.
 *
 * Read from the environment on every call rather than cached at module load:
 * caching would freeze whatever was set when the module was first imported,
 * which makes the "key missing" path untestable and would silently keep using
 * a rotated-away key for the lifetime of the process.
 *
 * The key never appears in an error message — only its absence or its wrong
 * length does.
 */
function loadKey(): Buffer {
  const raw = process.env[ERP_CREDENTIAL_KEY_ENV];
  if (!raw || raw.trim() === "") {
    throw new CredentialEncryptionUnavailableError(
      `${ERP_CREDENTIAL_KEY_ENV} não está configurada. ` +
        "Credenciais de ERP não podem ser lidas nem gravadas sem ela.",
    );
  }

  let key: Buffer;
  try {
    key = Buffer.from(raw, "base64");
  } catch {
    throw new CredentialEncryptionUnavailableError(
      `${ERP_CREDENTIAL_KEY_ENV} não é base64 válido.`,
    );
  }

  if (key.length !== KEY_BYTES) {
    throw new CredentialEncryptionUnavailableError(
      `${ERP_CREDENTIAL_KEY_ENV} deve decodificar para exatamente ${KEY_BYTES} bytes ` +
        `(recebido: ${key.length}). Gere uma com: openssl rand -base64 32`,
    );
  }

  return key;
}

/** True when a usable master key is configured. Never reveals the key. */
export function isCredentialEncryptionConfigured(): boolean {
  try {
    loadKey();
    return true;
  } catch {
    return false;
  }
}

/**
 * Encrypts a token.
 *
 * A fresh random IV per call is what makes two encryptions of the SAME token
 * produce different ciphertexts — without it, an observer of the database
 * could tell that two companies configured the same credential. Reusing an IV
 * under one key would also destroy GCM's security entirely, which is why it is
 * generated here and never derived from anything (not from companyId, not from
 * a counter).
 */
export function encryptCredential(plaintext: string): EncryptedCredential {
  const key = loadKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
  };
}

/**
 * Decrypts a token, verifying integrity.
 *
 * Any tampering — with the ciphertext, the IV or the tag — fails here, as does
 * decryption under the wrong key. All of those surface as the same generic
 * error: distinguishing "wrong key" from "tampered ciphertext" in a message
 * would hand an attacker an oracle, and neither case is actionable to a caller
 * beyond "this credential is unusable".
 */
export function decryptCredential(encrypted: EncryptedCredential): string {
  const key = loadKey();

  const iv = Buffer.from(encrypted.iv, "base64");
  const authTag = Buffer.from(encrypted.authTag, "base64");
  const ciphertext = Buffer.from(encrypted.ciphertext, "base64");

  // Reject malformed lengths before touching the cipher: `createDecipheriv`
  // throws differently for these, and normalizing here keeps one failure mode.
  if (iv.length !== IV_BYTES || authTag.length !== AUTH_TAG_BYTES) {
    throw new CredentialEncryptionUnavailableError(
      "Credencial armazenada está corrompida.",
    );
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new CredentialEncryptionUnavailableError(
      "Credencial armazenada está corrompida.",
    );
  }
}

/**
 * The only fragment of a token ever displayed.
 *
 * Four characters cannot reconstruct a credential but are enough for an
 * operator to tell which one is configured. Short tokens yield fewer
 * characters rather than the whole value.
 */
export function credentialLast4(plaintext: string): string {
  return plaintext.length <= 4 ? "" : plaintext.slice(-4);
}

/** Constant-time comparison, for tests and any future verification path. */
export function secretsMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
