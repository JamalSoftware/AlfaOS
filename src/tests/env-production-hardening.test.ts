import { spawnSync } from "node:child_process";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateEnv } from "@/lib/env";
import { readConnectivityRunSettings } from "@/lib/connectivity-monitor";
import { readOutboxBatchLimit } from "@/lib/outbox";

/**
 * # `RC-1F-A` — `ENV-01`: configuração de produção que falhava em silêncio
 *
 * A mesma regra que a `RC-1B` aplicou ao login (`RC-SEC-01`): AUSENTE usa o
 * padrão; PRESENTE e inválida derruba a subida. Um erro de digitação não pode
 * virar outro número sem ninguém saber — "60" no lugar de "6" é uma rajada
 * contra o ERP de um provedor real, e um `TRUSTED_PROXY_HOPS` ilegível virando 0
 * é um limite por IP que ninguém configurou.
 */

const INVALIDOS = ["6.5", "1e6", "Infinity", "NaN", "0", "-1", "", "abc", "0x10", "+5"];

describe("DIAG-ENV — teto e concorrência do ciclo", () => {
  it("DIAG-ENV-01 · ausentes usam os padrões documentados (300 e 6)", () => {
    expect(readConnectivityRunSettings({})).toEqual({ limit: 300, concurrency: 6 });
  });

  it("DIAG-ENV-02 · inteiro positivo é aceito", () => {
    expect(
      readConnectivityRunSettings({
        DIAGNOSTICS_REFRESH_BATCH_LIMIT: "120",
        DIAGNOSTICS_REFRESH_CONCURRENCY: " 3 ",
      }),
    ).toEqual({ limit: 120, concurrency: 3 });
  });

  it.each(INVALIDOS)("DIAG-ENV-03 · DIAGNOSTICS_REFRESH_BATCH_LIMIT=%j derruba a subida", (valor) => {
    expect(() => readConnectivityRunSettings({ DIAGNOSTICS_REFRESH_BATCH_LIMIT: valor })).toThrow(
      /DIAGNOSTICS_REFRESH_BATCH_LIMIT/,
    );
  });

  it("DIAG-ENV-05 · a mensagem nomeia a variável, a faixa aprovada e o valor recebido", () => {
    expect(() => readConnectivityRunSettings({ DIAGNOSTICS_REFRESH_CONCURRENCY: "13" })).toThrow(
      'DIAGNOSTICS_REFRESH_CONCURRENCY inválido: use um número inteiro entre 1 e 12 (recebido: "13")',
    );
    expect(() => readConnectivityRunSettings({ DIAGNOSTICS_REFRESH_BATCH_LIMIT: "1001" })).toThrow(
      'DIAGNOSTICS_REFRESH_BATCH_LIMIT inválido: use um número inteiro entre 1 e 1000 (recebido: "1001")',
    );
  });

  /*
    Tetos decididos pelo dono em 17/09/2026 (RC-1F-A): concorrência 1..12,
    lote do ciclo 1..1000, lote do outbox 1..500. Os padrões não mudaram
    (6, 300, 50): sem a variável, o comportamento é o de antes.
  */
  it.each([
    ["1", 1],
    ["12", 12],
  ])("ENV-MAX-CONCURRENCY · %s é aceito", (valor, esperado) => {
    expect(readConnectivityRunSettings({ DIAGNOSTICS_REFRESH_CONCURRENCY: valor }).concurrency).toBe(esperado);
  });

  it("ENV-MAX-CONCURRENCY · 13 derruba a subida", () => {
    expect(() => readConnectivityRunSettings({ DIAGNOSTICS_REFRESH_CONCURRENCY: "13" })).toThrow(/DIAGNOSTICS_REFRESH_CONCURRENCY/);
  });

  it.each([
    ["1", 1],
    ["1000", 1000],
  ])("ENV-MAX-DIAG-BATCH · %s é aceito", (valor, esperado) => {
    expect(readConnectivityRunSettings({ DIAGNOSTICS_REFRESH_BATCH_LIMIT: valor }).limit).toBe(esperado);
  });

  it("ENV-MAX-DIAG-BATCH · 1001 derruba a subida", () => {
    expect(() => readConnectivityRunSettings({ DIAGNOSTICS_REFRESH_BATCH_LIMIT: "1001" })).toThrow(/DIAGNOSTICS_REFRESH_BATCH_LIMIT/);
  });

  it.each(INVALIDOS)("DIAG-ENV-04 · DIAGNOSTICS_REFRESH_CONCURRENCY=%j derruba a subida", (valor) => {
    expect(() => readConnectivityRunSettings({ DIAGNOSTICS_REFRESH_CONCURRENCY: valor })).toThrow(
      /DIAGNOSTICS_REFRESH_CONCURRENCY/,
    );
  });
});

/**
 * Os comandos rodam por cron, e o `catch` deles registra só o tipo do erro
 * (RC-LOG-01). Sem a leitura explícita, uma variável inválida sairia como
 * "erro=Error" — o operador saberia que quebrou e não o quê.
 */
const RAIZ = process.cwd();
const TSX = path.join(RAIZ, "node_modules", "tsx", "dist", "cli.mjs");
function comando(script: string, args: string[], extra: Record<string, string>) {
  return spawnSync(process.execPath, [TSX, script, ...args], {
    cwd: RAIZ,
    env: { ...process.env, ...extra },
    encoding: "utf8",
    timeout: 90_000,
  });
}

describe("CMD-ENV — os comandos recusam configuração inválida dizendo qual", () => {
  it("CMD-ENV-01 · diagnostics: concorrência inválida sai com 2, nomeia a variável e não consulta nada", () => {
    const r = comando("scripts/connectivity-refresh.ts", ["--dry-run"], {
      DIAGNOSTICS_REFRESH_CONCURRENCY: "6.5",
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/configuracao invalida: DIAGNOSTICS_REFRESH_CONCURRENCY/);
    expect(r.stdout).not.toMatch(/SIMULACAO|ciclo iniciado/);
  }, 90_000);

  it("CMD-ENV-02 · diagnostics: alvo inválido também sai com 2 — não derruba o import", () => {
    const r = comando("scripts/connectivity-refresh.ts", ["--dry-run"], {
      DIAGNOSTICS_REFRESH_TARGET_MS: "abc",
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/configuracao invalida: DIAGNOSTICS_REFRESH_TARGET_MS/);
  }, 90_000);

  it("CMD-ENV-03 · outbox: lote inválido sai com 2 antes de reivindicar qualquer evento", () => {
    const r = comando("scripts/outbox-worker.ts", [], { OUTBOX_BATCH_LIMIT: "0" });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/configuracao invalida: OUTBOX_BATCH_LIMIT/);
    expect(r.stdout).not.toMatch(/reivindicados=/);
  }, 90_000);
});

describe("CMD-ENV — --customer-id malformado nunca vira \"sem filtro\"", () => {
  it.each([
    [["--customer-id"]],
    [["--customer-id", "--dry-run"]],
    [["--dry-run", "--customer-id="]],
    [["--customer-id=a", "--customer-id=b", "--dry-run"]],
  ])("CMD-ENV-04 · %j sai com 2 antes de ler o banco", (args) => {
    const r = comando("scripts/connectivity-refresh.ts", args, {});
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/configuracao invalida: --customer-id/);
    expect(r.stdout).not.toMatch(/SIMULACAO|ciclo iniciado/);
  }, 90_000);
});

describe("OUTBOX-ENV — teto do lote do outbox", () => {
  it("OUTBOX-ENV-01 · ausente continua 50", () => {
    expect(readOutboxBatchLimit({})).toBe(50);
  });

  it("OUTBOX-ENV-02 · inteiro positivo é aceito", () => {
    expect(readOutboxBatchLimit({ OUTBOX_BATCH_LIMIT: "20" })).toBe(20);
  });

  it.each([
    ["1", 1],
    ["500", 500],
  ])("ENV-MAX-OUTBOX · %s é aceito", (valor, esperado) => {
    expect(readOutboxBatchLimit({ OUTBOX_BATCH_LIMIT: valor })).toBe(esperado);
  });

  it("ENV-MAX-OUTBOX · 501 derruba a subida, nomeando a faixa", () => {
    expect(() => readOutboxBatchLimit({ OUTBOX_BATCH_LIMIT: "501" })).toThrow(
      'OUTBOX_BATCH_LIMIT inválido: use um número inteiro entre 1 e 500 (recebido: "501")',
    );
  });

  it.each(INVALIDOS)("OUTBOX-ENV-03 · OUTBOX_BATCH_LIMIT=%j derruba a subida", (valor) => {
    expect(() => readOutboxBatchLimit({ OUTBOX_BATCH_LIMIT: valor })).toThrow(/OUTBOX_BATCH_LIMIT/);
  });
});

// ---------------------------------------------------------------------------
// validateEnv — subida da aplicação web
// ---------------------------------------------------------------------------

const env = process.env as Record<string, string | undefined>;
const VARIAVEIS = [
  "NODE_ENV",
  "DATABASE_URL",
  "AUTH_SECRET",
  "TRUSTED_PROXY_HOPS",
  "CUSTOMER_CREDENTIAL_ENCRYPTION_KEY",
  "ERP_CREDENTIAL_ENCRYPTION_KEY",
] as const;
const ORIGINAL = Object.fromEntries(VARIAVEIS.map((k) => [k, env[k]]));

beforeEach(() => {
  env.NODE_ENV = "production";
  env.DATABASE_URL = "postgresql://user:pass@localhost:5432/db";
  env.AUTH_SECRET = "a-production-secret-that-is-long-enough-123";
  delete env.TRUSTED_PROXY_HOPS;
  delete env.CUSTOMER_CREDENTIAL_ENCRYPTION_KEY;
  delete env.ERP_CREDENTIAL_ENCRYPTION_KEY;
});

afterEach(() => {
  for (const k of VARIAVEIS) {
    if (ORIGINAL[k] === undefined) delete env[k];
    else env[k] = ORIGINAL[k];
  }
});

describe("PROXY-ENV — TRUSTED_PROXY_HOPS", () => {
  it("PROXY-ENV-01 · ausente é aceito (padrão 0)", () => {
    expect(() => validateEnv()).not.toThrow();
  });

  it.each(["0", "1", "2"])("PROXY-ENV-02 · %s é aceito", (valor) => {
    env.TRUSTED_PROXY_HOPS = valor;
    expect(() => validateEnv()).not.toThrow();
  });

  it("PROXY-ENV-04 · fora de produção a regra é a mesma — o contrato não previa exceção", () => {
    env.NODE_ENV = "development";
    env.TRUSTED_PROXY_HOPS = "abc";
    expect(() => validateEnv()).toThrow(/TRUSTED_PROXY_HOPS/);
  });

  it("PROXY-ENV-05 · sem teto documentado, a mensagem diz \"a partir de 0\" em vez de inventar um", () => {
    env.TRUSTED_PROXY_HOPS = "-1";
    expect(() => validateEnv()).toThrow(
      'TRUSTED_PROXY_HOPS inválido: use um número inteiro a partir de 0 (recebido: "-1")',
    );
  });

  it.each(["abc", "-1", "1.5", "", "2abc", "Infinity"])(
    "PROXY-ENV-03 · %j derruba a subida em produção, em vez de virar 0",
    (valor) => {
      env.TRUSTED_PROXY_HOPS = valor;
      expect(() => validateEnv()).toThrow(/TRUSTED_PROXY_HOPS/);
    },
  );
});

describe("CUSTOMER-KEY-ENV — CUSTOMER_CREDENTIAL_ENCRYPTION_KEY", () => {
  const valida = Buffer.alloc(32, 7).toString("base64");

  it("CUSTOMER-KEY-ENV-01 · ausente é aceito — a gravação falha fechada no uso", () => {
    expect(() => validateEnv()).not.toThrow();
  });

  it("CUSTOMER-KEY-ENV-02 · 32 bytes em base64 é aceito", () => {
    env.CUSTOMER_CREDENTIAL_ENCRYPTION_KEY = valida;
    expect(() => validateEnv()).not.toThrow();
  });

  it("CUSTOMER-KEY-ENV-03 · presente e malformada derruba a subida, sem imprimir o valor", () => {
    const errada = Buffer.alloc(16, 9).toString("base64");
    env.CUSTOMER_CREDENTIAL_ENCRYPTION_KEY = errada;
    let mensagem = "";
    try {
      validateEnv();
    } catch (e) {
      mensagem = e instanceof Error ? e.message : String(e);
    }
    expect(mensagem).toMatch(/CUSTOMER_CREDENTIAL_ENCRYPTION_KEY/);
    expect(mensagem).toMatch(/16/);
    expect(mensagem).not.toContain(errada);
  });
});
