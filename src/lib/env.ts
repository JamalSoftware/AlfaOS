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

  return { nodeEnv, databaseUrl, authSecret };
}
