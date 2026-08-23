/**
 * Central environment validation.
 *
 * Fails fast at startup with a clear message when critical configuration is
 * missing or insecure. Never prints the contents of secrets.
 */

const DEFAULT_AUTH_SECRET = "change-me-to-a-long-random-string";
const MIN_AUTH_SECRET_LENGTH = 32;

export interface ValidatedEnv {
  nodeEnv: string;
  databaseUrl: string;
  authSecret: string;
}

function collectMissing(values: Record<string, string | undefined>): string[] {
  return Object.entries(values)
    .filter(([, value]) => !value || value.trim() === "")
    .map(([key]) => key);
}

export function validateEnv(): ValidatedEnv {
  const nodeEnv = process.env.NODE_ENV ?? "development";
  const databaseUrl = process.env.DATABASE_URL ?? "";
  const authSecret = process.env.AUTH_SECRET ?? "";

  const missing = collectMissing({
    DATABASE_URL: databaseUrl,
    AUTH_SECRET: authSecret,
  });

  if (missing.length > 0) {
    throw new Error(
      `Variáveis de ambiente obrigatórias ausentes: ${missing.join(", ")}. ` +
        `Defina-as no arquivo .env (veja .env.example).`,
    );
  }

  if (authSecret.length < MIN_AUTH_SECRET_LENGTH) {
    throw new Error(
      `AUTH_SECRET deve ter ao menos ${MIN_AUTH_SECRET_LENGTH} caracteres. ` +
        "Gere um valor forte com: openssl rand -base64 48",
    );
  }

  if (nodeEnv === "production" && authSecret === DEFAULT_AUTH_SECRET) {
    throw new Error(
      "AUTH_SECRET não pode ser o valor padrão em produção. " +
        "Defina um secret forte e único.",
    );
  }

  validateErpCredentialKey();

  return { nodeEnv, databaseUrl, authSecret };
}

/** AES-256 key length, in bytes. */
const ERP_CREDENTIAL_KEY_BYTES = 32;

/**
 * Validates the ERP credential master key IF it is set.
 *
 * Deliberately optional: AlfaOS runs fine without any ERP credential
 * configured, so demanding this at boot would block every deployment that does
 * not use one. What must not happen is a key that LOOKS configured but is the
 * wrong size — that would only surface at the first save attempt, which is the
 * worst moment to discover it. So: absent is fine, present-and-malformed fails
 * fast.
 *
 * The value itself is never printed, only its decoded length.
 */
function validateErpCredentialKey(): void {
  const raw = process.env.ERP_CREDENTIAL_ENCRYPTION_KEY;
  if (!raw || raw.trim() === "") {
    return;
  }

  const decoded = Buffer.from(raw, "base64");
  if (decoded.length !== ERP_CREDENTIAL_KEY_BYTES) {
    throw new Error(
      `ERP_CREDENTIAL_ENCRYPTION_KEY deve decodificar (base64) para exatamente ` +
        `${ERP_CREDENTIAL_KEY_BYTES} bytes (recebido: ${decoded.length}). ` +
        "Gere uma chave válida com: openssl rand -base64 32",
    );
  }
}
