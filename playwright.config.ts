import { defineConfig } from "@playwright/test";

const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgresql://alfaos:alfaos_dev_password@localhost:5432/alfaos_test?schema=public";

const E2E_AUTH_SECRET =
  process.env.E2E_AUTH_SECRET ??
  "e2e-secret-0123456789abcdefghijklmnopqrstuvwxyz";

/**
 * Throwaway AES-256 key so the E2E server can encrypt ERP credentials.
 *
 * Test-only, with no production meaning — the real key is operator-supplied
 * and never committed (see `.env.example`). Fixed rather than random so a
 * credential saved in one spec is still readable later in the same run.
 */
const E2E_CREDENTIAL_KEY =
  process.env.E2E_CREDENTIAL_KEY ??
  "ZTJlLW9ubHktYWVzMjU2LWtleS0zMi1ieXRlcyEhISE=";

/**
 * Dedicated port, NOT 3000.
 *
 * The suite used to share :3000 with `npm run dev`, and `reuseExistingServer`
 * made that dangerous rather than merely inconvenient (see below). Its own port
 * means a developer's dev server and the E2E server can coexist, and the one
 * Playwright talks to is unambiguously the one Playwright started.
 */
const E2E_PORT = process.env.E2E_PORT ?? "3100";
const E2E_BASE_URL = `http://localhost:${E2E_PORT}`;

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL: E2E_BASE_URL,
    trace: "on-first-retry",
  },
  webServer: {
    /**
     * The preflight runs in this command's environment, so it inspects the exact
     * DATABASE_URL the Next.js process below will boot with. It aborts (exit 1)
     * unless that resolves to a `_test` database, verified against
     * `current_database()` on a live connection. A misconfigured URL therefore
     * fails the run immediately instead of quietly writing to the dev database.
     */
    command: `npx tsx e2e/assert-test-db.ts && npm run dev -- --port ${E2E_PORT}`,
    url: E2E_BASE_URL,
    /**
     * NEVER reuse a server we did not start — not even locally.
     *
     * This was `!process.env.CI`. Any `next dev` already listening on the port
     * was adopted as-is, including the one a developer starts by hand with the
     * `.env` DATABASE_URL pointing at the DEVELOPMENT database. The `env` block
     * below was then silently ignored and the whole suite — ERP syncs, user
     * creation, assignments — ran against dev data, while `globalSetup` wiped
     * and seeded the test database nobody was reading. With `false`, Playwright
     * always spawns its own server, and that server always ran the preflight.
     */
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      DATABASE_URL: E2E_DATABASE_URL,
      AUTH_SECRET: E2E_AUTH_SECRET,
      SESSION_COOKIE_NAME: "alfaos_session",
      ERP_CREDENTIAL_ENCRYPTION_KEY: E2E_CREDENTIAL_KEY,
      NEXT_TELEMETRY_DISABLED: "1",
      PORT: E2E_PORT,
    },
  },
});
