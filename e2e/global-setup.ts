import { execSync } from "node:child_process";
import path from "node:path";

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

export default function globalSetup() {
  run("npx prisma migrate deploy");
  run("npx tsx e2e/reset-db.ts");
  run("npx prisma db seed");
}
