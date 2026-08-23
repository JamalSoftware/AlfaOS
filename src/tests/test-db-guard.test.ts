import { describe, it, expect } from "vitest";
import { assertTestDatabase, databaseNameFromUrl } from "../../e2e/test-db-guard";
import { resetDatabase } from "./helpers";

/**
 * Regression for M-1: the destructive path Vitest uses before every test had
 * no equivalent of the E2E guard, so a misconfigured `TEST_DATABASE_URL` could
 * silently point `resetDatabase()` at `alfaos_dev`.
 *
 * The name-suffix checks below (dev/prod/bare-name/invalid) never connect to
 * anything — `assertTestDatabase` rejects on the string alone before it ever
 * opens a socket, which is exactly what makes it safe to test them here
 * against real-looking connection strings without touching any live database.
 * Only the "allowed" case needs a live round trip, and it targets the actual
 * `alfaos_test` database this whole suite already runs against.
 */
describe("assertTestDatabase — guard reutilizado pelo Vitest", () => {
  const HOST = "postgresql://alfaos:alfaos_dev_password@localhost:5432";

  it("alfaos_test → permitido", async () => {
    const url = process.env.DATABASE_URL ?? `${HOST}/alfaos_test?schema=public`;
    await expect(assertTestDatabase(url, "TEST")).resolves.toBe("alfaos_test");
  });

  it("alfaos_dev → recusado, sem conectar", async () => {
    await expect(
      assertTestDatabase(`${HOST}/alfaos_dev?schema=public`, "TEST_DATABASE_URL"),
    ).rejects.toThrow(/não termina em "_test"/);
  });

  it("alfaos_prod → recusado, sem conectar", async () => {
    await expect(
      assertTestDatabase(`${HOST}/alfaos_prod?schema=public`, "TEST_DATABASE_URL"),
    ).rejects.toThrow(/não termina em "_test"/);
  });

  it("alfaos (sem sufixo) → recusado, sem conectar", async () => {
    await expect(
      assertTestDatabase(`${HOST}/alfaos?schema=public`, "TEST_DATABASE_URL"),
    ).rejects.toThrow(/não termina em "_test"/);
  });

  it("URL ausente/vazia → recusada", async () => {
    await expect(assertTestDatabase(undefined, "TEST_DATABASE_URL")).rejects.toThrow(
      /não está definido/,
    );
    await expect(assertTestDatabase("", "TEST_DATABASE_URL")).rejects.toThrow(
      /não está definido/,
    );
  });

  it("URL sem nome de banco (ambígua) → recusada", async () => {
    await expect(
      assertTestDatabase("postgresql://alfaos:pw@localhost:5432", "TEST_DATABASE_URL"),
    ).rejects.toThrow(/não contém um nome de banco válido/);
  });

  it("URL ilegível (não parseável) → recusada", async () => {
    await expect(
      assertTestDatabase("nao-e-uma-url", "TEST_DATABASE_URL"),
    ).rejects.toThrow(/não contém um nome de banco válido/);
  });

  it("a mensagem de recusa referencia o label recebido, não um nome fixo", async () => {
    // Regression for the pre-existing bug this reuse forced into the open:
    // `refuse()` used to hardcode "E2E_DATABASE_URL" in its closing hint
    // regardless of which variable the caller actually named.
    await expect(
      assertTestDatabase(`${HOST}/alfaos_dev?schema=public`, "MINHA_VARIAVEL"),
    ).rejects.toThrow(/Ajuste MINHA_VARIAVEL/);
  });

  it("databaseNameFromUrl extrai o nome do path", () => {
    expect(databaseNameFromUrl(`${HOST}/alfaos_test?schema=public`)).toBe(
      "alfaos_test",
    );
    expect(databaseNameFromUrl("nao-e-uma-url")).toBeNull();
  });
});

describe("resetDatabase() — integração com o guard", () => {
  it("recusa e não apaga nada quando DATABASE_URL aponta para banco não-test", async () => {
    const real = process.env.DATABASE_URL;
    process.env.DATABASE_URL =
      "postgresql://alfaos:alfaos_dev_password@localhost:5432/alfaos_dev?schema=public";
    try {
      // Rejected on the string alone — assertTestDatabase never reaches the
      // network for a name that does not end in "_test", so this is safe even
      // though the URL above names the real development database.
      await expect(resetDatabase()).rejects.toThrow(
        /RECUSANDO OPERAÇÃO DESTRUTIVA DE TESTE/,
      );
    } finally {
      process.env.DATABASE_URL = real;
    }
  });

  it("volta a funcionar normalmente com a URL de teste restaurada", async () => {
    await expect(resetDatabase()).resolves.toBeUndefined();
  });
});
