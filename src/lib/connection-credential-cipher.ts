import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Authenticated encryption for customer connection passwords (PPPoE).
 *
 * Deliberately a SEPARATE module from `erp-credential-cipher`, with its own key
 * and its own AAD namespace. The two protect different things for different
 * audiences: an ERP token is one secret per company, handled by ADMINs; a PPPoE
 * password is one secret per customer, read by technicians in the field. Sharing
 * a cipher would make it possible — one careless call site away — to decrypt one
 * under the other's context.
 *
 * AES-256-GCM from `node:crypto`: standard, authenticated, no new dependency and
 * no home-grown scheme. Tampered ciphertext fails loudly instead of yielding a
 * wrong password that a technician would then type into a customer's router.
 *
 * There is deliberately NO `last4` helper here. Showing the last four characters
 * of an API token helps an operator tell WHICH token is configured; doing the
 * same to a password just leaks a quarter of it. The UI shows a boolean.
 */

const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const KEY_BYTES = 32; // AES-256
const ALGORITHM = "aes-256-gcm";

export const CONNECTION_CREDENTIAL_KEY_ENV =
  "CUSTOMER_CREDENTIAL_ENCRYPTION_KEY";

/**
 * Thrown when the key is absent or malformed, or when a stored credential
 * cannot be authenticated.
 *
 * A distinct type so callers fail CLOSED: the outcome that must never happen is
 * falling back to storing or returning a password in plaintext because the key
 * was missing.
 */
export class ConnectionCredentialUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ConnectionCredentialUnavailableError";
  }
}

export interface EncryptedConnectionCredential {
  ciphertext: string;
  iv: string;
  authTag: string;
}

/**
 * The identity a connection password is cryptographically bound to.
 *
 * All four fields are required by both encrypt and decrypt, so the binding
 * cannot be forgotten — there is no overload taking only a plaintext, which
 * means no call site can physically produce an unbound ciphertext.
 */
export interface ConnectionCredentialContext {
  companyId: string;
  customerId: string;
  connectionId: string;
  type: string;
}

/**
 * Version marker for the AAD format. Bumping it invalidates every stored
 * ciphertext by design: the AAD must match byte-for-byte, so a format change
 * fails closed instead of silently accepting an old binding.
 */
const AAD_VERSION = "v1";

/**
 * Builds the AAD binding a ciphertext to one tenant, one customer, one
 * connection and one connection type.
 *
 * Length-prefixed rather than `a:b:c:d` concatenation. Today every field is a
 * cuid or an enum and none can contain the delimiter, but relying on that makes
 * the encoding correct by accident. With explicit lengths no two distinct
 * identity tuples can ever collide on the same AAD, whatever those fields
 * become later.
 *
 * The AAD is NOT stored. It is recomputed on decrypt from the row's real
 * identity, which is exactly what makes a transplanted ciphertext fail: moving
 * the encrypted bytes to another customer's row changes the AAD that gets
 * reconstructed, and GCM's tag check rejects it.
 *
 * The `alfaos:customer-connection-credential:` prefix keeps this namespace
 * disjoint from the ERP one even if both ever ran under the same key.
 */
export function buildConnectionCredentialAad(
  context: ConnectionCredentialContext,
): Buffer {
  const { companyId, customerId, connectionId, type } = context;
  const encoded =
    `alfaos:customer-connection-credential:${AAD_VERSION}:` +
    `${companyId.length}:${companyId}:` +
    `${customerId.length}:${customerId}:` +
    `${connectionId.length}:${connectionId}:` +
    `${type.length}:${type}`;
  return Buffer.from(encoded, "utf8");
}

/**
 * Loads and validates the key.
 *
 * Read from the environment on every call rather than cached at module load:
 * caching would freeze whatever was set at first import, making the
 * "key missing" path untestable and silently keeping a rotated-away key alive
 * for the lifetime of the process.
 *
 * The key value never appears in an error — only its absence or wrong length.
 */
function loadKey(): Buffer {
  const raw = process.env[CONNECTION_CREDENTIAL_KEY_ENV];
  if (!raw || raw.trim() === "") {
    throw new ConnectionCredentialUnavailableError(
      `${CONNECTION_CREDENTIAL_KEY_ENV} não está configurada. ` +
        "Senhas de conexão não podem ser gravadas nem reveladas sem ela.",
    );
  }

  let key: Buffer;
  try {
    key = Buffer.from(raw, "base64");
  } catch {
    throw new ConnectionCredentialUnavailableError(
      `${CONNECTION_CREDENTIAL_KEY_ENV} não é base64 válido.`,
    );
  }

  if (key.length !== KEY_BYTES) {
    throw new ConnectionCredentialUnavailableError(
      `${CONNECTION_CREDENTIAL_KEY_ENV} deve decodificar para exatamente ` +
        `${KEY_BYTES} bytes (recebido: ${key.length}). ` +
        "Gere uma com: openssl rand -base64 32",
    );
  }

  return key;
}

/** True when a usable key is configured. Never reveals the key. */
export function isConnectionCredentialEncryptionConfigured(): boolean {
  try {
    loadKey();
    return true;
  } catch {
    return false;
  }
}

/**
 * Encrypts a connection password.
 *
 * A fresh random IV per call is what makes two encryptions of the SAME password
 * produce different ciphertexts — without it, anyone reading the database could
 * tell that two customers share a password. Reusing an IV under one key would
 * also destroy GCM entirely, which is why it is generated here and never
 * derived from anything.
 */
export function encryptConnectionCredential(
  plaintext: string,
  context: ConnectionCredentialContext,
): EncryptedConnectionCredential {
  const key = loadKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(buildConnectionCredentialAad(context));
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

/**
 * Decrypts a connection password, verifying integrity and binding.
 *
 * Any tampering — with ciphertext, IV or tag — fails here, as does decryption
 * under the wrong key or the wrong identity. All surface as the same generic
 * error: distinguishing "wrong key" from "wrong customer" from "tampered" in a
 * message would hand an attacker an oracle, and none of it is actionable to a
 * caller beyond "this credential is unusable".
 */
export function decryptConnectionCredential(
  encrypted: EncryptedConnectionCredential,
  context: ConnectionCredentialContext,
): string {
  const key = loadKey();

  const iv = Buffer.from(encrypted.iv, "base64");
  const authTag = Buffer.from(encrypted.authTag, "base64");
  const ciphertext = Buffer.from(encrypted.ciphertext, "base64");

  // Reject malformed lengths before touching the cipher: `createDecipheriv`
  // throws differently for these, and normalizing keeps one failure mode.
  if (iv.length !== IV_BYTES || authTag.length !== AUTH_TAG_BYTES) {
    throw new ConnectionCredentialUnavailableError(
      "Credencial de conexão armazenada está corrompida.",
    );
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    // Reconstructed from the row's OWN identity, never from anything the caller
    // supplied over the wire. A ciphertext copied into another customer's row
    // is verified against that customer's AAD and fails here.
    decipher.setAAD(buildConnectionCredentialAad(context));
    decipher.setAuthTag(authTag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new ConnectionCredentialUnavailableError(
      "Credencial de conexão armazenada está corrompida.",
    );
  }
}
