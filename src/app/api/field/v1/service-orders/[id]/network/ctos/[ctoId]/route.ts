import { assertFieldCtoEnabled, getFieldCandidateCto } from "@/lib/field/cto";
import { FieldError } from "@/lib/field/errors";
import { fieldOk, noStore, runFieldApi } from "@/lib/field/response";
import { requireFieldPrincipal } from "@/lib/field/route";
import { resolveOwnedOrderCustomer } from "@/lib/field/service-orders";

/**
 * `GET /api/field/v1/service-orders/:id/network/ctos/:ctoId`
 *
 * Uma caixa e as posições dela, para o técnico escolher o destino.
 *
 * A caixa de outra empresa responde **404**, e o corpo é o mesmo de um id que
 * não existe: distinguir os dois transformaria a rota num oráculo de
 * existência.
 *
 * As portas trazem `administrativeState` e `occupied` **separados**. O ocupante
 * não vem: `occupied: true` responde a pergunta operacional inteira sem
 * entregar o cliente de outro atendimento.
 */
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: { id: string; ctoId: string } },
) {
  return runFieldApi(async () => {
    const principal = await requireFieldPrincipal(request);
    await assertFieldCtoEnabled(principal);

    await resolveOwnedOrderCustomer(
      principal.user.companyId,
      principal.technician.id,
      context.params.id,
      { requireInProgress: true },
    );

    const cto = await getFieldCandidateCto(
      principal.user.companyId,
      context.params.ctoId,
    );
    if (!cto) {
      throw new FieldError("NOT_FOUND", "CTO não encontrada.");
    }

    return noStore(fieldOk({ cto }));
  });
}
