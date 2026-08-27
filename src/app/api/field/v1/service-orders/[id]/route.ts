import { fieldOk, runFieldApi } from "@/lib/field/response";
import { requireFieldPrincipal } from "@/lib/field/route";
import { getFieldServiceOrder } from "@/lib/field/service-orders";

/**
 * Rota autenticada por Bearer: nunca estática.
 *
 * O Next já a marcaria como dinâmica ao ver a leitura de `headers`, mas por
 * exceção — que o envelope de erro do Field captura e registra como falha no
 * build. Declarar a intenção evita o ruído e, mais importante, não deixa o
 * comportamento de uma rota que carrega dado de cliente depender de inferência.
 */
export const dynamic = "force-dynamic";

/**
 * `GET /api/field/v1/service-orders/:id`
 *
 * Detalhe operacional: o que o técnico precisa para chegar, entender e
 * executar. Nada além disso.
 *
 * OS de outro técnico responde **404**, nunca 403 — 403 confirmaria que aquele
 * id existe, e é justamente o que um técnico sondando ids não pode aprender.
 *
 * O corpo não carrega CPF, senha, `externalId`, `externalProvider` nem payload
 * de provider (`src/lib/field/dto.ts`). Uma OS importada do ReceitaNet chega
 * aqui idêntica a uma interna: como o dado do provedor não é enviado, não
 * existe `if (RECEITANET)` possível do lado do aplicativo.
 */
export async function GET(
  request: Request,
  context: { params: { id: string } },
) {
  return runFieldApi(async () => {
    const principal = await requireFieldPrincipal(request);
    const order = await getFieldServiceOrder(
      principal.user.companyId,
      principal.technician.id,
      context.params.id,
    );
    return fieldOk({ serviceOrder: order });
  });
}
