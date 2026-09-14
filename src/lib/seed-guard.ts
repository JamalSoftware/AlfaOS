/**
 * O seed de demonstração nunca roda em produção (RC-OPS-04).
 *
 * `prisma/seed.ts` cria — e REATIVA, se já existirem — usuários ADMIN com uma
 * senha de demonstração escrita no código-fonte. Contra a base de produção
 * (`npx prisma db seed`, ou o seed automático de `migrate reset`), isso daria
 * acesso administrativo a qualquer um que conheça o repositório.
 *
 * Recusa pura, sem modo de forçar: não há caso de uso legítimo para dados de
 * demonstração em produção.
 *
 * **Limite declarado:** a proteção depende de `NODE_ENV=production` estar
 * definido no ambiente onde o comando roda. O nome do banco não serve de
 * segunda trava — o `.env.example` usa `alfaos` para desenvolvimento, e uma
 * regra por nome quebraria o ambiente documentado. O runbook de produção
 * precisa dizer: nunca `db seed` nem `migrate reset` contra a base real.
 */
export function assertSeedAllowed(
  env: Record<string, string | undefined> = process.env,
): void {
  if (env.NODE_ENV === "production") {
    throw new Error(
      "Seed recusado: NODE_ENV=production. O seed cria usuários de " +
        "demonstração com senha conhecida e nunca roda em produção.",
    );
  }
}
