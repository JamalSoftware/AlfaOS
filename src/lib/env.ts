/**
 * Central environment validation.
 *
 * Fails fast at startup with a clear message when critical configuration is
 * missing or insecure. Never prints the contents of secrets.
 */

const DEFAULT_AUTH_SECRET = "change-me-to-a-long-random-string";
const MIN_AUTH_SECRET_LENGTH = 32;

export interface LoginLimits {
  maxFailedAttempts: number;
  windowSeconds: number;
  maxFailedAttemptsByIp: number;
}

export interface ValidatedEnv {
  nodeEnv: string;
  databaseUrl: string;
  authSecret: string;
  loginLimits: LoginLimits;
}

export interface IntegerSettingRule {
  min: number;
  max: number;
}

/**
 * Inteiro de configuração — AUSENTE usa o padrão, PRESENTE e inválido falha.
 *
 * Existe porque `Number()` aceita coisa demais e devolve `NaN` para o resto:
 * `LOGIN_MAX_FAILED_ATTEMPTS="abc"` virava `NaN`, e `tentativas >= NaN` é
 * sempre falso — o limitador de força bruta deixava de existir sem nenhum
 * aviso (RC-SEC-01). Um limite de segurança que um erro de digitação desliga
 * em silêncio é pior que um que derruba a subida.
 *
 * Só dígitos: `"1e3"`, `"0x10"`, `"1.5"`, `"+5"`, `"Infinity"` e string vazia
 * são recusados, porque todos eles `Number()` aceitaria de algum jeito. O valor
 * recebido entra na mensagem — é configuração, não segredo — encurtado.
 */
export function readIntegerSetting(
  name: string,
  raw: string | undefined,
  fallback: number,
  rule: IntegerSettingRule,
): number {
  if (raw === undefined) {
    return fallback;
  }
  const text = raw.trim();
  const value = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < rule.min || value > rule.max) {
    throw new Error(
      `${name} inválido: use um número inteiro entre ${rule.min} e ${rule.max} ` +
        `(recebido: "${raw.slice(0, 40)}"). Remova a variável para usar o padrão.`,
    );
  }
  return value;
}

/**
 * Os três limites do login, com a faixa aceita.
 *
 * Zero não entra em nenhuma: nas duas contagens ele bloquearia todo login, e
 * uma janela de 0 s não conta nada. A janela começa em 60 s porque abaixo
 * disso o limitador deixa de limitar — cinco tentativas por segundo é força
 * bruta com outro nome. Os padrões são os que o projeto sempre usou.
 */
export function readLoginLimits(
  env: Record<string, string | undefined> = process.env,
): LoginLimits {
  return {
    maxFailedAttempts: readIntegerSetting(
      "LOGIN_MAX_FAILED_ATTEMPTS",
      env.LOGIN_MAX_FAILED_ATTEMPTS,
      5,
      { min: 1, max: 1_000 },
    ),
    windowSeconds: readIntegerSetting(
      "LOGIN_WINDOW_SECONDS",
      env.LOGIN_WINDOW_SECONDS,
      900,
      { min: 60, max: 604_800 },
    ),
    maxFailedAttemptsByIp: readIntegerSetting(
      "LOGIN_MAX_FAILED_ATTEMPTS_BY_IP",
      env.LOGIN_MAX_FAILED_ATTEMPTS_BY_IP,
      20,
      { min: 1, max: 100_000 },
    ),
  };
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

  const loginLimits = readLoginLimits();

  return { nodeEnv, databaseUrl, authSecret, loginLimits };
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
