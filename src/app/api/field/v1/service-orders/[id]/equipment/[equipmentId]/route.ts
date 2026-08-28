import { z } from "zod";
import { assertCanExecute } from "@/lib/field/auth";
import { parseIdempotencyKey, withIdempotency } from "@/lib/field/idempotency";
import { fieldOk, runFieldApi } from "@/lib/field/response";
import {
  fieldExpectedVersion,
  readFieldBody,
  requireFieldPrincipal,
} from "@/lib/field/route";
import { removeServiceOrderEquipment } from "@/lib/service-order-equipment";

/**
 * `POST /api/field/v1/service-orders/:id/equipment/:equipmentId`
 *
 * Remove um equipamento registrado por engano, antes da conclusão.
 *
 * Existe porque o serial digitado errado precisa de saída: sem remoção, um erro
 * de digitação ocuparia a unique da empresa para sempre e o equipamento certo
 * não teria como ser cadastrado.
 *
 * Depois de COMPLETED, recusa — a OS fechada é imutável, e o snapshot de
 * fechamento já registrou o que foi instalado.
 */
const schema = z
  .object({ expectedVersion: fieldExpectedVersion })
  .strict();

export async function POST(
  request: Request,
  context: { params: { id: string; equipmentId: string } },
) {
  return runFieldApi(async () => {
    const principal = await requireFieldPrincipal(request);
    assertCanExecute(principal);

    const key = parseIdempotencyKey(request);
    const body = await readFieldBody(request, schema);
    const { id: orderId, equipmentId } = context.params;

    const outcome = await withIdempotency(
      principal,
      "service-order.equipment.remove",
      key,
      { orderId, equipmentId, expectedVersion: body.expectedVersion },
      async () => {
        await removeServiceOrderEquipment(
          principal.user.companyId,
          principal.user.id,
          orderId,
          equipmentId,
          body.expectedVersion,
        );
        return {
          status: 200,
          resourceId: equipmentId,
          body: { removed: true, equipmentId },
        };
      },
    );

    return fieldOk(outcome.body, outcome.status);
  });
}
