import { PrismaClient } from "@prisma/client";
import { assertTestDatabase } from "./test-db-guard";

const prisma = new PrismaClient();

/**
 * Tabelas que NÃO podem ser esvaziadas.
 *
 * `_prisma_migrations` é o histórico do próprio banco: apagá-lo faria o
 * `migrate deploy` seguinte reaplicar tudo sobre um schema que já existe.
 */
const PRESERVADAS = new Set(["_prisma_migrations"]);

async function main() {
  // This script truncates every table. It is also runnable by hand
  // (`npx tsx e2e/reset-db.ts`), where a stray `.env` would point it at the
  // development database — so it refuses to run anywhere but a `_test` database,
  // independently of whatever called it.
  await assertTestDatabase(process.env.DATABASE_URL, "DATABASE_URL");

  /*
    TRUNCATE de tudo, e não uma lista de `deleteMany`.

    A lista enumerada envelhecia a cada migration: quem acrescentasse um modelo
    novo com FK `Restrict` para `User` só descobria a omissão quando a suíte
    Playwright rodasse DEPOIS da Vitest — as duas usam o mesmo banco de teste, e
    a Vitest deixa linhas para trás. Foi assim que `Workday` derrubou o
    `globalSetup`: o reset tentava apagar usuários com jornada gravada.

    Perguntar ao catálogo remove a classe inteira de defeito. `CASCADE` dispensa
    a ordem topológica, e `RESTART IDENTITY` devolve as sequências ao início,
    coisa que `deleteMany` nunca fez.
  */
  const tabelas = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  `;

  const alvos = tabelas
    .map((t) => t.tablename)
    .filter((nome) => !PRESERVADAS.has(nome));

  if (alvos.length === 0) return;

  const lista = alvos.map((nome) => `"public"."${nome}"`).join(", ");
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${lista} RESTART IDENTITY CASCADE`,
  );
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
