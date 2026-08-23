import { PrismaClient } from "@prisma/client";
import { assertTestDatabase } from "./test-db-guard";

const prisma = new PrismaClient();

async function main() {
  // This script truncates every table. It is also runnable by hand
  // (`npx tsx e2e/reset-db.ts`), where a stray `.env` would point it at the
  // development database — so it refuses to run anywhere but a `_test` database,
  // independently of whatever called it.
  await assertTestDatabase(process.env.DATABASE_URL, "DATABASE_URL");

  await prisma.serviceOrderEvent.deleteMany();
  await prisma.serviceOrder.deleteMany();
  await prisma.technician.deleteMany();
  await prisma.customer.deleteMany();
  await prisma.loginAttempt.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.eRPIntegration.deleteMany();
  await prisma.user.deleteMany();
  await prisma.company.deleteMany();
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
