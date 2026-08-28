import { getFieldExecutionBundle } from "@/lib/field/execution";
import { fieldOk, runFieldApi } from "@/lib/field/response";
import { requireFieldPrincipal } from "@/lib/field/route";

/** Rota autenticada por Bearer: nunca estática. Ver `notifications/route.ts`. */
export const dynamic = "force-dynamic";

/**
 * `GET /api/field/v1/service-orders/:id/execution`
 *
 * Tudo que a tela de execução mostra, numa leitura só.
 *
 * Leitura NÃO exige `assertCanExecute`: um técnico desativado continua
 * consultando o que já tinha e só perde a capacidade de mexer. É a mesma porta
 * que o resto do Field usa desde a v0.9 — leitura e escrita têm regras
 * diferentes de propósito.
 */
export async function GET(
  request: Request,
  context: { params: { id: string } },
) {
  return runFieldApi(async () => {
    const principal = await requireFieldPrincipal(request);
    const bundle = await getFieldExecutionBundle(
      principal.user.companyId,
      principal.technician.id,
      context.params.id,
    );
    return fieldOk(bundle);
  });
}
