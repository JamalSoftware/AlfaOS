import { PrismaClient } from "@prisma/client";
import { validateEnv } from "./env";

validateEnv();

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

/*
  O log `error` do PRÓPRIO Prisma fica só em desenvolvimento (RC-LOG-01).

  Ele imprime a mensagem do banco como veio, e o Postgres põe o VALOR nela —
  `invalid input syntax for type integer: "<o que foi enviado>"` —, além dos
  argumentos das validações do cliente. Fora de desenvolvimento isso seria
  documento, nome ou chave de storage num log de produção.

  Nada se perde: todo erro do motor é LANÇADO para quem fez a consulta, e quem
  o registra é `logServerError`, com o tipo e o código `P####`.
*/
export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["warn"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
