import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readConnectivityRunSettings } from "@/lib/connectivity-monitor";

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
});
