import { z } from "zod";
import { jsonError, jsonOk, runApi } from "@/lib/api";
import { assertSameOrigin } from "@/lib/csrf";
import { disconnectCustomer } from "@/lib/cto-connections";
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
 * `POST /api/cto-connections/:id/disconnect`
 *
 * ## O id no caminho É a guarda de obsolescência
 *
 * A operação não é "desconecte o que este cliente tiver agora" — é "encerre
 * ESTE vínculo". A diferença decide um desastre real: o operador vê o cliente
 * na porta A, outra pessoa o move para B, e o primeiro clica em desconectar na
 * tela velha. Com a identidade na URL o servidor recusa; sem ela, encerraria B,
 * que ninguém viu.
 *
 * A comparação é do domínio e acontece **depois** de travar o cliente, então
 * ela lê o estado autoritativo e não uma fotografia. A resolução aqui em cima
 * serve só para responder `404` a um id de outra empresa antes de qualquer
 * trabalho.
 */
const schema = z
  .object({
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
      "cto.disconnect",
      key,
      { connectionId: (await context.params).id, ...parsed.data },
      async () => {
        const connection = await disconnectCustomer(
          {
            companyId: access.session.companyId,
            provenance: { source: "WEB", actorUserId: access.session.id },
          },
          {
            customerId: target.customerId,
            expectedConnectionId: (await context.params).id,
            reason: parsed.data.reason ?? null,
          },
        );
        return { status: 200, body: { connection } };
      },
    );

    return jsonOk(outcome.body, outcome.status);
  });
}
