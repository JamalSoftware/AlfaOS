import { assertTestDatabase } from "./test-db-guard";

/**
 * Preflight for the Playwright `webServer`.
 *
 * Runs as the first half of the webServer command, so it sees the EXACT
 * `DATABASE_URL` the Next.js process is about to be started with — not the one
 * playwright.config.ts intended, not the one in `.env`. If it exits non-zero the
 * server never starts and Playwright fails with this message.
 *
 * This is the check that makes "the E2E server is talking to a test database" a
 * fact instead of an assumption.
 */
assertTestDatabase(process.env.DATABASE_URL, "DATABASE_URL do servidor E2E")
  .then((name) => {
    console.log(`[e2e] banco de testes confirmado: ${name}`);
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
