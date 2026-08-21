import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { validateEnv } from "@/lib/env";

// Next.js types declare `process.env.NODE_ENV` as readonly. Use a mutable
// view of the environment to set/reset it during the tests.
const env = process.env as Record<string, string | undefined>;

const ORIGINAL: Record<string, string | undefined> = {
  NODE_ENV: env.NODE_ENV,
  DATABASE_URL: env.DATABASE_URL,
  AUTH_SECRET: env.AUTH_SECRET,
};

function restoreEnv() {
  for (const [key, value] of Object.entries(ORIGINAL)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
}

beforeEach(() => {
  env.NODE_ENV = "test";
  env.DATABASE_URL = "postgresql://user:pass@localhost:5432/db";
  env.AUTH_SECRET = "this-is-a-long-secret-key-of-at-least-32-chars";
});

afterEach(() => {
  restoreEnv();
});

describe("Validação de variáveis de ambiente", () => {
  it("aceita configuração válida", () => {
    const result = validateEnv();
    expect(result.databaseUrl).toContain("localhost:5432");
    expect(result.authSecret.length).toBeGreaterThanOrEqual(32);
  });

  it("falha quando DATABASE_URL está ausente", () => {
    delete env.DATABASE_URL;
    expect(() => validateEnv()).toThrow(/DATABASE_URL/);
  });

  it("falha quando AUTH_SECRET está ausente", () => {
    delete env.AUTH_SECRET;
    expect(() => validateEnv()).toThrow(/AUTH_SECRET/);
  });

  it("falha quando AUTH_SECRET é curto", () => {
    env.AUTH_SECRET = "short";
    expect(() => validateEnv()).toThrow(/32 caracteres/);
  });

  it("rejeita o secret padrão em produção", () => {
    env.NODE_ENV = "production";
    env.AUTH_SECRET = "change-me-to-a-long-random-string";
    expect(() => validateEnv()).toThrow(/valor padrão/);
  });

  it("permite o secret padrão fora de produção (desenvolvimento)", () => {
    env.AUTH_SECRET = "change-me-to-a-long-random-string";
    expect(() => validateEnv()).not.toThrow();
  });
});
