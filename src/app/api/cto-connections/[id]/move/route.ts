import { z } from "zod";
import { jsonError, jsonOk, runApi } from "@/lib/api";
import { assertSameOrigin } from "@/lib/csrf";
import { moveCustomerToPort } from "@/lib/cto-connections";
import { requireCtoAccess } from "@/lib/cto-access";
import {
  idempotencyActor,
  parseIdempotencyKey,
  withIdempotency,
} from "@/lib/field/idempotency";
import {
  CTO_CONNECTION_REASON_MAX_LENGTH,
  resolveConnectionTarget,
} from "../../shared";

/**
 * `POST /api/cto-connections/:id/move`
 *
 * "Mova ESTE vínculo para ESTA porta", e não "mova o que o cliente tiver".
 * Mesma razão da rota de desconexão: a identidade no caminho é o que impede uma
 * tela velha de mover um vínculo que nasceu depois dela.
 *
 * O domínio faz a movimentação numa transação — fecha a linha antiga, abre a
 * nova. Nunca um `UPDATE` de porta, que faria o passado mentir.
 */
const schema = z
  .object({
    targetCtoPortId: z.string().min(1),
    reason: z.string().max(CTO_CONNECTION_REASON_MAX_LENGTH).optional(),
  })
  .strict();

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return runApi(async () => {
    const csrfBlocked = assertSameOrigin(request);
    if (csrfBlocked) return csrfBlocked;

    const access = await requireCtoAccess(request);
    if (!access.ok) return access.response;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonError("Corpo da requisição inválido.", 400);
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return jsonError("Dados inválidos.", 400, parsed.error.flatten());
    }

    const target = await resolveConnectionTarget(
      access.session.companyId,
      (await context.params).id,
    );
    if (!target) {
      return jsonError("Vínculo não encontrado.", 404);
    }

    const key = parseIdempotencyKey(request);
    const outcome = await withIdempotency(
      idempotencyActor(access.session.companyId, access.session.id),
      "cto.move",
      key,
      { connectionId: (await context.params).id, ...parsed.data },
      async () => {
        const result = await moveCustomerToPort(
          {
            companyId: access.session.companyId,
            provenance: { source: "WEB", actorUserId: access.session.id },
          },
          {
            customerId: target.customerId,
            expectedConnectionId: (await context.params).id,
            targetCtoPortId: parsed.data.targetCtoPortId,
            reason: parsed.data.reason ?? null,
          },
        );
        return { status: 200, body: { move: result } };
      },
    );

    return jsonOk(outcome.body, outcome.status);
  });
}
