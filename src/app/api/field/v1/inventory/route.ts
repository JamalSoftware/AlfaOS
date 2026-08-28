import { listTechnicianStock } from "@/lib/inventory";
import { fieldOk, runFieldApi } from "@/lib/field/response";
import { requireFieldPrincipal } from "@/lib/field/route";

/**
 * `GET /api/field/v1/inventory`
 *
 * O que ESTE técnico tem em mãos.
 *
 * O `technicianId` sai do principal resolvido pelo token, nunca da requisição:
 * não existe parâmetro capaz de listar o estoque de um colega. É a mesma regra
 * de posse do resto do Field, aplicada no `where` em SQL.
 *
 * Só itens com saldo POSITIVO. Oferecer um item zerado produziria uma recusa
 * previsível depois de o técnico já ter digitado a quantidade.
 *
 * O saldo devolvido é orientação para a tela. Quem valida saldo no consumo é o
 * servidor, dentro da transação e sob lock — o valor lido aqui pode estar velho
 * quando o comando chegar, e é por isso que a validação não pode morar no
 * aplicativo.
 */
export async function GET(request: Request) {
  return runFieldApi(async () => {
    const principal = await requireFieldPrincipal(request);
    const items = await listTechnicianStock(
      principal.user.companyId,
      principal.technician.id,
    );
    return fieldOk({ items });
  });
}
