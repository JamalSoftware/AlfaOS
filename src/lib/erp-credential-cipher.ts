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
 * Every credential is additionally BOUND to its `(companyId, provider)` via
 * GCM's Additional Authenticated Data. The AAD is never stored — it is
 * recomputed from the row's real identity on decrypt — so encrypted bytes
 * copied into another company's row (or another provider's) fail the tag check
 * instead of decrypting. Without this, a ciphertext was portable: an audit
 * proved that transplanting ciphertext+IV+tag from company A to company B let
 * B read A's token.
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
 * The identity a credential is cryptographically bound to.
 *
 * Required by both `encryptCredential` and `decryptCredential` so the binding
 * cannot be forgotten: there is no overload that takes only a plaintext, which
 * means a future caller physically cannot produce an unbound ciphertext.
 */
export interface CredentialContext {
  companyId: string;
  provider: string;
}

/**
 * Version marker for the AAD format.
 *
 * Bumping it invalidates every previously stored ciphertext by design — the
 * AAD must match byte-for-byte on decrypt, so a format change fails closed
 * instead of silently accepting an old binding.
 */
const AAD_VERSION = "v1";

/**
 * Builds the Additional Authenticated Data that binds a ciphertext to one
 * tenant and one provider.
 *
 * Length-prefixed rather than plain `a:b` concatenation. Today `companyId` is
 * a cuid and `provider` an enum, so neither can contain the delimiter — but
 * relying on that makes the encoding correct by accident. With explicit
 * lengths, no pair of distinct (company, provider) values can ever collide on
 * the same AAD, whatever those fields become later.
 *
 * The AAD is NOT stored: it is recomputed on decrypt from the row's real
 * identity. That is precisely what makes a transplanted ciphertext fail —
 * moving the encrypted bytes to another company's row changes the AAD that
 * will be reconstructed, and GCM's tag check then rejects it.
 */
export function buildCredentialAad(context: CredentialContext): Buffer {
  const { companyId, provider } = context;
  const encoded =
    `alfaos:erp-credential:${AAD_VERSION}:` +
    `${companyId.length}:${companyId}:${provider.length}:${provider}`;
  return Buffer.from(encoded, "utf8");
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
export function encryptCredential(
  plaintext: string,
  context: CredentialContext,
): EncryptedCredential {
  const key = loadKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  // Binds this ciphertext to (company, provider). Without it, the encrypted
  // bytes are portable between rows and decrypt anywhere under the same key.
  cipher.setAAD(buildCredentialAad(context));
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
export function decryptCredential(
  encrypted: EncryptedCredential,
  context: CredentialContext,
): string {
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
    // Reconstructed from the row's OWN identity, never from anything the
    // caller supplied over the wire. A ciphertext copied into another
    // company's row is verified against that company's AAD and fails here.
    decipher.setAAD(buildCredentialAad(context));
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
