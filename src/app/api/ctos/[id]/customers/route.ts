import { AccessProfile } from "@prisma/client";
import { jsonError, jsonOk, runApi } from "@/lib/api";
import { requireCtoAccess } from "@/lib/cto-access";
import { getCtoPortCustomers } from "@/lib/operational-map";
import { prisma } from "@/lib/prisma";

/**
 * `GET /api/ctos/[id]/customers`
 *
 * Quem está em cada porta desta caixa, para o detalhe do marcador.
 *
 * ## Por que isto é uma rota própria, e não parte do recorte
 *
 * `GET /api/ctos/map` devolve **contagens** por caixa. Mandar a lista nominal de
 * clientes de cada caixa visível seria payload enorme, custo inútil e — o que
 * pesa mais — espalhar nome de assinante por uma resposta cujo trabalho é
 * desenhar pontos. O nome só viaja quando alguém pede aquela caixa.
 *
 * ## `ADMIN`, como a camada de clientes
 *
 * Aqui saem nomes de assinantes, então vale a mesma regra: o `DISPATCHER` lê o
 * mapa de caixas e de OS abertas, e a carteira nominal é `ADMIN` nesta fase.
 * Fosse diferente, a lista por porta seria a porta dos fundos da decisão que a
 * camada de clientes tomou pela porta da frente.
 */
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: { id: string } },
) {
  return runApi(async () => {
    const access = await requireCtoAccess(request, [AccessProfile.ADMIN]);
    if (!access.ok) return access.response;

    /*
      A CAIXA é conferida antes, com tenant no predicado.

      Sem isto, um id de outra empresa devolveria uma lista vazia — que é
      indistinguível de "esta caixa não tem ninguém". Parece inofensivo e não é:
      a diferença entre lista vazia e 404 confirma a existência da caixa alheia.
    */
    const cto = await prisma.cTO.findFirst({
      where: { id: context.params.id, companyId: access.session.companyId },
      select: { id: true },
    });
    if (!cto) {
      return jsonError("CTO não encontrada.", 404);
    }

    const customers = await getCtoPortCustomers(
      access.session.companyId,
      cto.id,
    );

    return jsonOk({ customers });
  });
}
