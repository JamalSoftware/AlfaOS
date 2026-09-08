import { prisma } from "@/lib/prisma";

/** O mesmo teto de texto livre curto usado nas observações da porta. */
export { CTO_CONNECTION_REASON_MAX_LENGTH } from "@/lib/cto-connections";

/**
 * Resolve o vínculo pelo id, **dentro do tenant**, e devolve só o cliente.
 *
 * `findUnique({ id })` traria o vínculo de qualquer empresa, e a verificação de
 * tenant passaria a depender de quem chamou lembrar de fazê-la. Aqui o
 * `companyId` está no predicado: um id de outra empresa é tão inexistente
 * quanto um id que não existe, e as duas situações respondem `404`.
 *
 * Devolve apenas `customerId` de propósito — é tudo que a rota precisa para
 * chamar o domínio, que refaz a leitura autoritativa com o cliente travado.
 * Trazer mais daqui convidaria a decidir com dado lido fora da transação.
 */
export async function resolveConnectionTarget(
  companyId: string,
  connectionId: string,
): Promise<{ customerId: string } | null> {
  return prisma.customerNetworkConnection.findFirst({
    where: { id: connectionId, companyId },
    select: { customerId: true },
  });
}
