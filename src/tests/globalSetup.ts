import { execSync } from "node:child_process";
import path from "node:path";
import { assertTestDatabase } from "../../e2e/test-db-guard";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://alfaos:alfaos_dev_password@localhost:5432/alfaos_test?schema=public";

export default async function globalSetup() {
  // Guard FIRST, same as e2e/global-setup.ts. `migrate deploy` applying a
  // schema change to whatever `TEST_DATABASE_URL` happens to resolve to is not
  // a `deleteMany`, but running it against a real database is still not
  // something a misconfigured env var should be able to trigger silently.
  await assertTestDatabase(TEST_DATABASE_URL, "TEST_DATABASE_URL");

  execSync("npx prisma migrate deploy", {
    cwd: path.resolve(__dirname, "../.."),
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: "inherit",
  });
}
