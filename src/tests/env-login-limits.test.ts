import { afterEach, describe, expect, it, vi } from "vitest";
import { readIntegerSetting, readLoginLimits } from "@/lib/env";

/**
 * RC-SEC-01 — o limitador de login não pode ser desligado por um erro de
 * digitação na configuração.
 *
 * Antes, `Number("abc")` virava `NaN`, e `tentativas >= NaN` é sempre falso: o
 * bloqueio por força bruta simplesmente deixava de existir, sem nenhum aviso.
 * A regra agora é a das outras variáveis críticas de `env.ts`: AUSENTE usa o
 * padrão oficial; PRESENTE e inválida falha na subida.
 */

const LOGIN_VARS = [
  "LOGIN_MAX_FAILED_ATTEMPTS",
  "LOGIN_WINDOW_SECONDS",
  "LOGIN_MAX_FAILED_ATTEMPTS_BY_IP",
] as const;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("readIntegerSetting", () => {
  const regra = { min: 1, max: 1000 };

  it("ausente usa o padrão", () => {
    expect(readIntegerSetting("X", undefined, 5, regra)).toBe(5);
  });

  it("inteiro válido é lido como número", () => {
    expect(readIntegerSetting("X", "7", 5, regra)).toBe(7);
    expect(readIntegerSetting("X", " 12 ", 5, regra)).toBe(12);
    expect(readIntegerSetting("X", "1", 5, regra)).toBe(1);
    expect(readIntegerSetting("X", "1000", 5, regra)).toBe(1000);
  });

  it.each([
    ["abc"],
    ["NaN"],
    ["Infinity"],
    ["-Infinity"],
    ["10abc"],
    ["1.5"],
    ["1e3"],
    ["0x10"],
    ["-1"],
    ["+5"],
    [""],
    ["   "],
  ])("recusa %j nomeando a variável", (valor) => {
    expect(() => readIntegerSetting("LOGIN_X", valor, 5, regra)).toThrow(
      /LOGIN_X/,
    );
  });

  it("recusa fora da faixa — zero não é um limite, é um bloqueio total", () => {
    expect(() => readIntegerSetting("LOGIN_X", "0", 5, regra)).toThrow(/entre 1 e 1000/);
    expect(() => readIntegerSetting("LOGIN_X", "1001", 5, regra)).toThrow(/entre 1 e 1000/);
    expect(() =>
      readIntegerSetting("LOGIN_X", "9".repeat(30), 5, regra),
    ).toThrow(/LOGIN_X/);
  });
});

describe("readLoginLimits", () => {
  it("sem variáveis, devolve os padrões oficiais (5 · 900 s · 20)", () => {
    expect(readLoginLimits({})).toEqual({
      maxFailedAttempts: 5,
      windowSeconds: 900,
      maxFailedAttemptsByIp: 20,
    });
  });

  it("janela abaixo de um minuto é recusada — o limitador perderia o sentido", () => {
    expect(() => readLoginLimits({ LOGIN_WINDOW_SECONDS: "30" })).toThrow(
      /LOGIN_WINDOW_SECONDS/,
    );
  });

  it.each(LOGIN_VARS)("%s inválida falha, em vez de desligar o limite", (nome) => {
    expect(() => readLoginLimits({ [nome]: "abc" })).toThrow(new RegExp(nome));
  });
});

describe("falha na subida — o módulo de constantes não carrega com valor inválido", () => {
  it.each(LOGIN_VARS)('%s="abc" derruba a importação de `constants`', async (nome) => {
    vi.stubEnv(nome, "abc");
    vi.resetModules();
    await expect(import("@/lib/constants")).rejects.toThrow(new RegExp(nome));
  });

  it("valor válido chega ao limitador como número", async () => {
    vi.stubEnv("LOGIN_MAX_FAILED_ATTEMPTS", "7");
    vi.resetModules();
    const constants = await import("@/lib/constants");
    expect(constants.LOGIN_MAX_FAILED_ATTEMPTS).toBe(7);
    expect(Number.isInteger(constants.LOGIN_WINDOW_SECONDS)).toBe(true);
  });
});
