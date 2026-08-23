import { PrismaClient } from "@prisma/client";

/**
 * Fail-fast guard: nothing that destroys test data — E2E or Vitest — may touch
 * a database that is not a dedicated test database.
 *
 * Originally E2E-only. The suite is destructive by construction —
 * `reset-db.ts` truncates every table, the seed rewrites users, and the specs
 * run ERP syncs that create orders. Pointed at the development database (or,
 * worse, a production one) it would silently destroy real data. Two things
 * used to make that reachable:
 *
 *   1. `reuseExistingServer: !process.env.CI` in playwright.config.ts. A
 *      `next dev` already listening on the port — started by the developer with
 *      the `.env` DATABASE_URL — was adopted as-is, so the suite ran against
 *      whatever database THAT process had open while `globalSetup` wiped and
 *      seeded the test one. Fixed by never reusing an unknown server and by
 *      moving the E2E server to its own port.
 *   2. `globalSetup` running `prisma migrate deploy` + reset + seed with
 *      whatever `E2E_DATABASE_URL` happened to contain, with no sanity check.
 *      Fixed here.
 *
 * Vitest's own destructive path (`src/tests/helpers.ts#resetDatabase`,
 * `src/tests/globalSetup.ts`) had no equivalent check — a misconfigured
 * `TEST_DATABASE_URL` could point it at `alfaos_dev` with nothing to stop it.
 * It now calls this same function rather than reimplementing the check, which
 * is why `refuse()` takes `label` instead of a hardcoded suite name: the
 * message has to be honest about which variable actually needs fixing,
 * whichever suite is asking.
 *
 * The check is deliberately two-layered: the URL is a claim, `current_database()`
 * is the truth. A connection string can name `alfaos_test` while the server
 * resolves somewhere else entirely (pgbouncer, a search_path trick, an
 * overridden PGDATABASE), so the name is verified over the live connection.
 */

/** A database is only writable by the E2E suite when its name ends in this. */
const REQUIRED_SUFFIX = "_test";

export function databaseNameFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const name = parsed.pathname.replace(/^\//, "");
    return name === "" ? null : name;
  } catch {
    return null;
  }
}

/**
 * `label` doubles as the name of the variable to fix — it is already what the
 * caller passed to identify the URL (e.g. `"E2E_DATABASE_URL"`,
 * `"TEST_DATABASE_URL"`). Threading it through here (instead of hardcoding a
 * single suite's variable name) is what let this guard move from E2E-only to
 * shared with Vitest without the message lying about which knob to turn.
 */
function refuse(reason: string, databaseUrl: string, label: string): never {
  // Never echo the URL: it carries credentials.
  const claimed = databaseNameFromUrl(databaseUrl) ?? "<ilegível>";
  throw new Error(
    [
      "",
      "  RECUSANDO OPERAÇÃO DESTRUTIVA DE TESTE.",
      "",
      `  Motivo: ${reason}`,
      `  Banco indicado pela connection string: "${claimed}"`,
      "",
      `  Testes que apagam/recriam dados só podem rodar contra um banco cujo`,
      `  nome termina em "${REQUIRED_SUFFIX}".`,
      "",
      `  Ajuste ${label} (padrão: .../alfaos_test) e rode de novo.`,
      "",
    ].join("\n"),
  );
}

/**
 * Verifies that `databaseUrl` names an allowed test database AND that the
 * server on the other end agrees. Throws with an actionable message otherwise.
 *
 * @param label where the URL came from, for the error message.
 */
export async function assertTestDatabase(
  databaseUrl: string | undefined,
  label: string,
): Promise<string> {
  if (!databaseUrl || databaseUrl.trim() === "") {
    refuse(`${label} não está definido.`, "", label);
  }

  const claimed = databaseNameFromUrl(databaseUrl);
  if (!claimed) {
    refuse(`${label} não contém um nome de banco válido.`, databaseUrl, label);
  }
  if (!claimed.endsWith(REQUIRED_SUFFIX)) {
    refuse(
      `${label} aponta para "${claimed}", que não termina em "${REQUIRED_SUFFIX}".`,
      databaseUrl,
      label,
    );
  }

  // The URL is only a claim — confirm against the live connection.
  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  let actual: string;
  try {
    const rows = await prisma.$queryRaw<
      { current_database: string }[]
    >`SELECT current_database()`;
    actual = rows[0]?.current_database ?? "";
  } finally {
    await prisma.$disconnect();
  }

  if (!actual.endsWith(REQUIRED_SUFFIX)) {
    refuse(
      `o servidor respondeu current_database() = "${actual}", que não termina em "${REQUIRED_SUFFIX}".`,
      databaseUrl,
      label,
    );
  }
  if (actual !== claimed) {
    refuse(
      `${label} diz "${claimed}" mas o servidor respondeu current_database() = "${actual}".`,
      databaseUrl,
      label,
    );
  }

  return actual;
}
