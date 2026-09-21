import {
  assertFieldCtoEnabled,
  FIELD_CTO_MAX_PAGE_SIZE,
  listFieldCandidateCtos,
} from "@/lib/field/cto";
import { fieldOk, noStore, runFieldApi } from "@/lib/field/response";
import { requireFieldPrincipal } from "@/lib/field/route";
import { resolveOwnedOrderCustomer } from "@/lib/field/service-orders";

/**
 * `GET /api/field/v1/service-orders/:id/network/ctos?search=&limit=`
 *
 * As caixas candidatas do tenant da OS, com quantas posições livres cada uma
 * tem.
 *
 * **Vive sob a OS de propósito.** Uma rota global de CTOs para o Field
 * receberia o tenant da sessão e pararia por aí; aqui a OS é a autorização, e
 * ela é o `:id` do caminho — não um campo do corpo que o servidor depois
 * resolve confiar. Reduz o alcance para o intervalo em que o técnico está de
 * fato executando um atendimento.
 *
 * Não é mapa, não é topologia e não devolve OLT, PON, splitter nem trajeto de
 * fibra: isso é do FiberMap, e a fronteira segue sendo precedência, não
 * duplicação (PRD §334).
 */
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return runFieldApi(async () => {
    const principal = await requireFieldPrincipal(request);
    await assertFieldCtoEnabled(principal);

    // A OS autoriza a leitura, e é dela que vem o tenant efetivo — o mesmo
    // portão de posse das mutações, na mesma exigência de `IN_PROGRESS`.
    await resolveOwnedOrderCustomer(
      principal.user.companyId,
      principal.technician.id,
      (await context.params).id,
      { requireInProgress: true },
    );

    const params = new URL(request.url).searchParams;
    const rawLimit = params.get("limit");
    const parsedLimit = rawLimit === null ? undefined : Number(rawLimit);
    const limit =
      parsedLimit !== undefined &&
      Number.isInteger(parsedLimit) &&
      parsedLimit > 0
        ? Math.min(parsedLimit, FIELD_CTO_MAX_PAGE_SIZE)
        : undefined;

    const ctos = await listFieldCandidateCtos(principal.user.companyId, {
      search: params.get("search"),
      limit,
    });

    return noStore(fieldOk({ ctos }));
  });
}
