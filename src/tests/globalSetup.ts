import { execSync } from "node:child_process";
import path from "node:path";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://alfaos:alfaos_dev_password@localhost:5432/alfaos_test?schema=public";

export default function globalSetup() {
  execSync("npx prisma migrate deploy", {
    cwd: path.resolve(__dirname, "../.."),
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: "inherit",
  });
}
