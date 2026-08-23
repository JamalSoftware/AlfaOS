import { execSync } from "node:child_process";
import path from "node:path";
import { assertTestDatabase } from "./test-db-guard";

const ROOT = path.resolve(__dirname, "..");

const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgresql://alfaos:alfaos_dev_password@localhost:5432/alfaos_test?schema=public";

function run(command: string) {
  execSync(command, {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: E2E_DATABASE_URL },
    stdio: "inherit",
  });
}

export default async function globalSetup() {
  // Guard FIRST. Everything below this line is destructive: `reset-db` truncates
  // every table and the seed rewrites users. Running it against the development
  // database would destroy real work, so the URL is validated — and confirmed
  // against `current_database()` on the live connection — before any of it runs.
  const database = await assertTestDatabase(E2E_DATABASE_URL, "E2E_DATABASE_URL");
  console.log(`[e2e] global setup usando o banco "${database}"`);

  run("npx prisma migrate deploy");
  run("npx tsx e2e/reset-db.ts");
  run("npx prisma db seed");
}
