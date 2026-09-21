import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateEnv } from "@/lib/env";
import { DEFAULT_STORAGE_ROOT, resolveStorageRoot } from "@/lib/storage/root";
import { LocalFileStorageAdapter } from "@/lib/storage/local";

/**
 * # `RC-1F-B` — `STO-PROD`: a raiz de armazenamento em produção
 *
 * O defeito que estes testes impedem não aparece no dia do deploy. Com a raiz
 * dentro do release, o primeiro deploy seguinte troca o diretório e as fotos
 * ficam para trás, com o banco ainda apontando para elas: descobre-se quando
 * alguém abre uma OS antiga e a evidência não está lá.
 *
 * Fora de produção nada muda — `.storage` continua sendo o padrão, e a suíte
 * continua escrevendo no temporário do `setup.ts` (`RC-STO-02`).
 */

const APP = path.resolve("/opt/alfaos/current");
const TMP = path.resolve("/tmp");
const PROD = { NODE_ENV: "production" } as Record<string, string | undefined>;
/** Raiz de produção plausível e fora deste repositório — só um caminho, nunca criada. */
const RAIZ_FIXTURE = path.resolve("/srv/alfaos-storage-fixture");

describe("STO-PROD — produção exige raiz absoluta, persistente e fora da aplicação", () => {
  it("STO-PROD-01 · raiz relativa em produção derruba, nomeando a variável", () => {
    expect(() =>
      resolveStorageRoot({ ...PROD, STORAGE_ROOT: ".storage" }, APP, TMP),
    ).toThrow(/STORAGE_ROOT inválido: em produção o caminho precisa ser absoluto/);
    expect(() =>
      resolveStorageRoot({ ...PROD, STORAGE_ROOT: "storage/fotos" }, APP, TMP),
    ).toThrow(/STORAGE_ROOT/);
  });

  it("STO-PROD-02 · raiz ausente (ou vazia) em produção derruba", () => {
    for (const env of [PROD, { ...PROD, STORAGE_ROOT: "" }, { ...PROD, STORAGE_ROOT: "   " }]) {
      expect(() => resolveStorageRoot(env, APP, TMP)).toThrow(/STORAGE_ROOT é obrigatório/);
    }
  });

  it("STO-PROD-03 · raiz absoluta, fora da aplicação, é aceita e normalizada", () => {
    expect(resolveStorageRoot({ ...PROD, STORAGE_ROOT: "/srv/alfaos/storage" }, APP, TMP)).toBe(
      path.resolve("/srv/alfaos/storage"),
    );
    // Espaço em volta é erro de digitação em arquivo de ambiente, não caminho.
    expect(resolveStorageRoot({ ...PROD, STORAGE_ROOT: " /srv/alfaos/storage " }, APP, TMP)).toBe(
      path.resolve("/srv/alfaos/storage"),
    );
  });

  it("STO-PROD-04 · raiz dentro da aplicação, igual a ela, ou contendo-a, é recusada", () => {
    const dentro = [
      path.join(APP, ".storage"),
      path.join(APP, "public", "uploads"),
      path.join(APP, ".next", "cache", "storage"),
      APP,
    ];
    for (const alvo of dentro) {
      expect(() => resolveStorageRoot({ ...PROD, STORAGE_ROOT: alvo }, APP, TMP), alvo).toThrow(
        /dentro do diretório da aplicação/,
      );
    }
    // A raiz que CONTÉM a aplicação é o mesmo defeito pelo outro lado.
    expect(() => resolveStorageRoot({ ...PROD, STORAGE_ROOT: "/opt" }, APP, TMP)).toThrow(
      /dentro do diretório da aplicação/,
    );
  });

  it("STO-PROD-05 · temporário do sistema não é armazenamento persistente", () => {
    expect(() =>
      resolveStorageRoot({ ...PROD, STORAGE_ROOT: path.join(TMP, "alfaos") }, APP, TMP),
    ).toThrow(/temporário/);
  });

  it("STO-PROD-06 · fora de produção o padrão histórico continua valendo", () => {
    expect(resolveStorageRoot({ NODE_ENV: "development" }, APP, TMP)).toBe(
      path.resolve(APP, DEFAULT_STORAGE_ROOT),
    );
    expect(resolveStorageRoot({ NODE_ENV: "test", STORAGE_ROOT: "tmp/x" }, APP, TMP)).toBe(
      path.resolve(APP, "tmp/x"),
    );
  });
});

// ---------------------------------------------------------------------------
// A raiz tem UM dono, e a subida falha cedo
// ---------------------------------------------------------------------------

const env = process.env as Record<string, string | undefined>;
const VARIAVEIS = [
  "NODE_ENV",
  "DATABASE_URL",
  "AUTH_SECRET",
  "STORAGE_ROOT",
  "NEXT_PHASE",
  "APP_ORIGINS",
] as const;
const ORIGINAL = Object.fromEntries(VARIAVEIS.map((k) => [k, env[k]]));

describe("OPS-STORAGE — web e comandos resolvem a MESMA raiz", () => {
  beforeEach(() => {
    env.NODE_ENV = "production";
    env.DATABASE_URL = "postgresql://user:pass@localhost:5432/db";
    env.AUTH_SECRET = "a-production-secret-that-is-long-enough-123";
    // Produção exige `APP_ORIGINS` (`SEC-038`); este arquivo é sobre a RAIZ DE
    // ARMAZENAMENTO, então ela entra como fixture para não falhar pelo motivo
    // errado. A regra dela vive em `env-production-hardening.test.ts`.
    env.APP_ORIGINS = "https://app.exemplo.com.br";
    delete env.STORAGE_ROOT;
    delete env.NEXT_PHASE;
  });

  afterEach(() => {
    for (const k of VARIAVEIS) {
      if (ORIGINAL[k] === undefined) delete env[k];
      else env[k] = ORIGINAL[k];
    }
  });

  it("OPS-STORAGE-01 · a subida em produção falha sem STORAGE_ROOT, antes de qualquer upload", () => {
    expect(() => validateEnv()).toThrow(/STORAGE_ROOT/);
    env.STORAGE_ROOT = "relativo";
    expect(() => validateEnv()).toThrow(/STORAGE_ROOT/);
  });

  it("OPS-STORAGE-02 · raiz absoluta fora da aplicação deixa a subida passar", () => {
    env.STORAGE_ROOT = RAIZ_FIXTURE;
    expect(() => validateEnv()).not.toThrow();
  });

  it("OPS-STORAGE-03 · a compilação é a ÚNICA exceção — e ela não grava arquivo nenhum", () => {
    env.NEXT_PHASE = "phase-production-build";
    expect(() => validateEnv()).not.toThrow();
    delete env.NEXT_PHASE;
    expect(() => validateEnv()).toThrow(/STORAGE_ROOT/);
  });

  it("OPS-STORAGE-04 · o adapter usa a mesma autoridade, e ninguém mais lê a variável", () => {
    env.STORAGE_ROOT = "./relativa-em-producao";
    // O adapter do web e o dos comandos é o mesmo: a recusa é estrutural.
    expect(() => new LocalFileStorageAdapter()).toThrow(/STORAGE_ROOT/);
    // Raiz explícita continua sendo o seio de teste, sem passar pela regra.
    expect(() => new LocalFileStorageAdapter(os.tmpdir())).not.toThrow();

    /*
      Uma segunda leitura de `STORAGE_ROOT` em qualquer módulo seria uma segunda
      política — e a que divergisse seria a que ninguém revisou.
    */
    const fontes = ["src/lib/storage/local.ts", "src/lib/storage/index.ts", "src/lib/env.ts"];
    for (const arquivo of fontes) {
      const codigo = readFileSync(path.join(process.cwd(), arquivo), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
      expect(codigo, arquivo).not.toMatch(/STORAGE_ROOT/);
    }
  });
});
