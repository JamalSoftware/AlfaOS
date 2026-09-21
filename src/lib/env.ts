/**
 * Central environment validation.
 *
 * Fails fast at startup with a clear message when critical configuration is
 * missing or insecure. Never prints the contents of secrets.
 */

import { resolveStorageRoot } from "./storage/root";

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
    // Sem teto superior, a faixa "entre 1 e 9007199254740991" só confundiria.
    const faixa =
      rule.max === Number.MAX_SAFE_INTEGER
        ? `a partir de ${rule.min}`
        : `entre ${rule.min} e ${rule.max}`;
    throw new Error(
      `${name} inválido: use um número inteiro ${faixa} ` +
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

  validateOptionalAes256Key("ERP_CREDENTIAL_ENCRYPTION_KEY");
  validateOptionalAes256Key("CUSTOMER_CREDENTIAL_ENCRYPTION_KEY");

  const loginLimits = readLoginLimits();

  /*
    `TRUSTED_PROXY_HOPS` (`ENV-01`, `RC-1F-A`).

    `rate-limit.ts` a lê a cada requisição com `parseInt` e cai para 0 no que
    não entende — `"abc"` virava 0 e `"2abc"` virava 2, em silêncio. Aqui ela é
    conferida na subida, com a regra das outras: ausente é o padrão 0, presente e
    inválida derruba. Sem teto superior: um número de proxies maior que o real é
    erro de configuração que só quem conhece a infraestrutura enxerga, e a
    documentação (docs/SECURITY.md) é quem o descreve.
  */
  readIntegerSetting(
    "TRUSTED_PROXY_HOPS",
    process.env.TRUSTED_PROXY_HOPS,
    0,
    { min: 0, max: Number.MAX_SAFE_INTEGER },
  );

  /*
    `STORAGE_ROOT` (`RC-1F-B`, `RC-STO-03`).

    A regra vive em `resolveStorageRoot`, que é a autoridade do adapter; aqui ela
    é só ANTECIPADA, para a subida do web e de todo comando (todos importam
    `prisma`, que chama esta função) falhar dizendo o que está errado — em vez de
    o defeito aparecer no primeiro upload de um técnico, em campo.

    A EXCEÇÃO é a compilação: `next build` roda com `NODE_ENV=production` e não
    grava arquivo nenhum, então exigir a raiz ali impediria compilar em qualquer
    máquina de desenvolvimento. A fase é a própria constante do Next, e o erro
    de uma futura mudança dela é conservador: a compilação passaria a exigir a
    variável e diria exatamente qual — nunca o contrário.
  */
  if (nodeEnv === "production" && process.env.NEXT_PHASE !== "phase-production-build") {
    resolveStorageRoot();
  }

  validateAppOrigins(nodeEnv);

  return { nodeEnv, databaseUrl, authSecret, loginLimits };
}

/**
 * `APP_ORIGINS` (`SEC-038`, INFO da revisão de segurança).
 *
 * ## Por que em produção ela é obrigatória
 *
 * Sem ela, `csrf.ts` cai na política de comparar `Origin` × `Host` — que é uma
 * defesa real, e é por isso que **nada aqui a enfraquece**. Mas ela depende de
 * um cabeçalho da requisição, e a allowlist explícita não: com as origens
 * fixadas na configuração, a decisão deixa de ter qualquer entrada do cliente.
 *
 * O runbook já lista `APP_ORIGINS` no mínimo de produção. A diferença é que
 * esquecê-la passava em silêncio, com a aplicação rodando na política mais
 * fraca sem nada dizer — o mesmo padrão de falha do `TRUSTED_PROXY_HOPS`
 * inválido e do limitador de login com `NaN`.
 *
 * ## Entrada malformada também derruba
 *
 * `configuredOrigins` DESCARTA o que não é origem absoluta. Uma vírgula
 * sobrando, um `app.exemplo.com.br` sem esquema ou uma barra a mais reduziam a
 * allowlist em silêncio — no limite, a zero, que é indistinguível de não ter
 * configurado. Aqui cada entrada é conferida e a recusa NOMEIA a que está
 * errada.
 *
 * Fora de produção nada é exigido: desenvolvimento e teste alcançam a aplicação
 * por `localhost`, por IP de rede local e pela porta do Playwright.
 *
 * ## A compilação é exceção, e pela mesma razão do `STORAGE_ROOT`
 *
 * `next build` roda com `NODE_ENV=production` e EXECUTA os módulos de rota para
 * coletar dados de página — mas não atende requisição nenhuma, então não há
 * origem a conferir. Exigir a variável ali impediria compilar em qualquer
 * máquina de desenvolvimento e em CI, o que este guarda descobriu do jeito
 * certo: quebrando o `npm run build` do gate.
 *
 * O FORMATO continua conferido na compilação. Um valor malformado é malformado
 * em qualquer fase, e é melhor descobri-lo ao compilar que ao subir.
 */
function validateAppOrigins(nodeEnv: string): void {
  const raw = process.env.APP_ORIGINS;
  const compilando = process.env.NEXT_PHASE === "phase-production-build";

  if (raw !== undefined && raw.trim().length > 0) {
    const entradas = raw.split(",").map((valor) => valor.trim());
    const invalidas = entradas.filter((valor) => {
      if (valor.length === 0) return true;
      try {
        const url = new URL(valor);
        // Precisa ser uma ORIGEM: esquema web e sem caminho, busca ou fragmento.
        return (
          (url.protocol !== "https:" && url.protocol !== "http:") ||
          url.hash.length > 0 ||
          url.search.length > 0 ||
          (url.pathname !== "/" && url.pathname !== "")
        );
      } catch {
        return true;
      }
    });
    if (invalidas.length > 0) {
      throw new Error(
        `APP_ORIGINS tem entrada inválida: ${invalidas.map((v) => JSON.stringify(v)).join(", ")}. ` +
          "Use origens absolutas separadas por vírgula, sem caminho — " +
          "por exemplo https://app.exemplo.com.br,https://exemplo.com.br",
      );
    }
    return;
  }

  if (nodeEnv === "production" && !compilando) {
    throw new Error(
      "APP_ORIGINS é obrigatória em produção: sem ela a proteção de origem cai " +
        "na comparação Origin × Host, que depende de cabeçalho da requisição. " +
        "Defina as origens da aplicação, por exemplo https://app.exemplo.com.br",
    );
  }
}

/** AES-256 key length, in bytes. */
const AES_256_KEY_BYTES = 32;

/**
 * Validates an AES-256 master key IF it is set.
 *
 * Deliberately optional: AlfaOS runs fine without any ERP credential or
 * customer connection password configured, so demanding a key at boot would
 * block every deployment that does not use one — and both ciphers already fail
 * CLOSED at use when the key is absent. What must not happen is a key that
 * LOOKS configured but is the wrong size — that would only surface at the first
 * save or reveal, which is the worst moment to discover it. So: absent is fine,
 * present-and-malformed fails fast.
 *
 * Two keys go through here: `ERP_CREDENTIAL_ENCRYPTION_KEY` (since v0.6) and
 * `CUSTOMER_CREDENTIAL_ENCRYPTION_KEY` (`RC-1F-A`; before it, a malformed
 * customer key was only discovered when a technician tried to reveal a PPPoE
 * password).
 *
 * The value itself is never printed, only its decoded length.
 */
function validateOptionalAes256Key(name: string): void {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") {
    return;
  }

  const decoded = Buffer.from(raw, "base64");
  if (decoded.length !== AES_256_KEY_BYTES) {
    throw new Error(
      `${name} deve decodificar (base64) para exatamente ` +
        `${AES_256_KEY_BYTES} bytes (recebido: ${decoded.length}). ` +
        "Gere uma chave válida com: openssl rand -base64 32",
    );
  }
}
