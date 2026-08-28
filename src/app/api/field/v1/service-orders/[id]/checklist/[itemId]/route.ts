import { z } from "zod";
import { answerChecklistItem } from "@/lib/checklists";
import { assertCanExecute } from "@/lib/field/auth";
import { parseIdempotencyKey, withIdempotency } from "@/lib/field/idempotency";
import { fieldOk, runFieldApi } from "@/lib/field/response";
import {
  clientMutationId,
  fieldExpectedVersion,
  readFieldBody,
  requireFieldPrincipal,
} from "@/lib/field/route";

/**
 * `POST /api/field/v1/service-orders/:id/checklist/:itemId`
 *
 * Responde um item do checklist DESTA OS.
 *
 * Não usa `fieldOrderCommand` porque tem um segundo parâmetro de rota, e o
 * `itemId` precisa entrar na impressão digital da idempotência: sem ele, a
 * mesma chave reapresentada para outro item devolveria o desfecho do primeiro,
 * e o aplicativo daria por respondida uma pergunta que ninguém respondeu.
 *
 * O valor é validado contra o TIPO gravado no snapshot da própria OS, não
 * contra o template atual — é o snapshot que o técnico está respondendo.
 */
const schema = z
  .object({
    expectedVersion: fieldExpectedVersion,
    valueBoolean: z.boolean().optional().nullable(),
    valueText: z.string().max(2_000).optional().nullable(),
    valueNumber: z.number().finite().optional().nullable(),
    clientMutationId,
  })
  .strict();

export async function POST(
  request: Request,
  context: { params: { id: string; itemId: string } },
) {
  return runFieldApi(async () => {
    const principal = await requireFieldPrincipal(request);
    assertCanExecute(principal);

    const key = parseIdempotencyKey(request);
    const body = await readFieldBody(request, schema);
    const { id: orderId, itemId } = context.params;

    const outcome = await withIdempotency(
      principal,
      "service-order.checklist.answer",
      key,
      {
        orderId,
        itemId,
        expectedVersion: body.expectedVersion,
        valueBoolean: body.valueBoolean ?? null,
        valueText: body.valueText ?? null,
        valueNumber: body.valueNumber ?? null,
      },
      async () => {
        const item = await answerChecklistItem(
          principal.user.companyId,
          principal.user.id,
          orderId,
          {
            itemId,
            expectedOrderVersion: body.expectedVersion,
            valueBoolean: body.valueBoolean ?? null,
            valueText: body.valueText ?? null,
            valueNumber: body.valueNumber ?? null,
          },
        );

        return {
          status: 200,
          resourceId: item.id,
          body: {
            item: {
              id: item.id,
              label: item.label,
              type: item.type,
              required: item.required,
              valueBoolean: item.valueBoolean,
              valueText: item.valueText,
              valueNumber: item.valueNumber,
              answeredAt: item.answeredAt?.toISOString() ?? null,
            },
            ...(body.clientMutationId
              ? { clientMutationId: body.clientMutationId }
              : {}),
          },
        };
      },
    );

    return fieldOk(outcome.body, outcome.status);
  });
}
