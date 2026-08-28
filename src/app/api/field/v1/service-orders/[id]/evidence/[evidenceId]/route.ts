import { z } from "zod";
import { assertCanExecute } from "@/lib/field/auth";
import { parseIdempotencyKey, withIdempotency } from "@/lib/field/idempotency";
import { fieldOk, runFieldApi } from "@/lib/field/response";
import {
  fieldExpectedVersion,
  readFieldBody,
  requireFieldPrincipal,
} from "@/lib/field/route";
import { removeEvidence } from "@/lib/service-order-closing";

/**
 * `POST /api/field/v1/service-orders/:id/evidence/:evidenceId/remove`
 * (montado como `POST` neste segmento)
 *
 * Remove uma foto ANTES da conclusão.
 *
 * `POST` com corpo, e não `DELETE`: o comando precisa de `expectedVersion` para
 * o compare-and-set, e corpo em `DELETE` é mal suportado por proxies e por
 * alguns clientes HTTP. O verbo não é a parte que importa aqui; a trava é.
 *
 * ## Só enquanto a OS está em andamento
 *
 * `removeEvidence` passa por `loadInProgressOwnedOrder`, então uma OS já
 * concluída recusa. É a regra de imutabilidade do fechamento: depois de
 * COMPLETED o técnico não apaga evidência histórica. Correção posterior existe,
 * é decisão administrativa e é auditada — não é este comando (PRD §162).
 *
 * A remoção é auditada mesmo antes da conclusão: `removeEvidence` grava
 * `SERVICE_ORDER.EVIDENCE_REMOVED`, então uma foto que existiu e sumiu deixa
 * rastro.
 */
const schema = z
  .object({ expectedVersion: fieldExpectedVersion })
  .strict();

export async function POST(
  request: Request,
  context: { params: { id: string; evidenceId: string } },
) {
  return runFieldApi(async () => {
    const principal = await requireFieldPrincipal(request);
    assertCanExecute(principal);

    const key = parseIdempotencyKey(request);
    const body = await readFieldBody(request, schema);
    const { id: orderId, evidenceId } = context.params;

    const outcome = await withIdempotency(
      principal,
      "service-order.evidence.remove",
      key,
      { orderId, evidenceId, expectedVersion: body.expectedVersion },
      async () => {
        await removeEvidence(
          principal.user.companyId,
          principal.user.id,
          orderId,
          evidenceId,
          body.expectedVersion,
        );
        return {
          status: 200,
          resourceId: evidenceId,
          body: { removed: true, evidenceId },
        };
      },
    );

    return fieldOk(outcome.body, outcome.status);
  });
}
