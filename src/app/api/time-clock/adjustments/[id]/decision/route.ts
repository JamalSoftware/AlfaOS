import { AccessProfile } from "@prisma/client";
import { z } from "zod";
import { assertProfile, jsonError, jsonOk, runApi } from "@/lib/api";
import { assertSameOrigin } from "@/lib/csrf";
import { getSessionUser } from "@/lib/session";
import { ADJUSTMENT_REASON_MAX, decideTimeAdjustment } from "@/lib/time-clock";

/**
 * `POST /api/time-clock/adjustments/:id/decision`
 *
 * Aprova ou rejeita um pedido de correção de jornada (PRD §229).
 *
 * ## O que a aprovação faz — e o que ela NÃO faz
 *
 * Ela **não edita** a marcação original. Cria uma marcação derivada, com
 * `source = ADJUSTMENT`, apontando para este pedido. O espelho passa a somar a
 * nova; a original continua lá, e o histórico mostra o que foi batido, o que
 * foi pedido, por quem e quem decidiu.
 *
 * Um `UPDATE` na linha original seria mais simples e destruiria exatamente o
 * que o registro existe para preservar.
 *
 * ## Rejeitar também é decisão
 *
 * O pedido rejeitado permanece, com motivo e autor. Sumir com a recusa seria
 * decidir sem deixar contraditório — e quem pediu precisa poder ver por quê.
 *
 * **Só ADMIN**, e a ação é auditada.
 */
const ADMIN_ONLY = [AccessProfile.ADMIN];

const schema = z
  .object({
    decision: z.enum(["APPROVED", "REJECTED"]),
    decisionReason: z.string().max(ADJUSTMENT_REASON_MAX).optional().nullable(),
  })
  .strict();

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: { id: string } },
) {
  return runApi(async () => {
    const csrfBlocked = assertSameOrigin(request);
    if (csrfBlocked) {
      return csrfBlocked;
    }

    const session = await getSessionUser(request);
    if (!session) {
      return jsonError("Não autenticado.", 401);
    }
    const denied = assertProfile(session.profile, ADMIN_ONLY);
    if (denied) return denied;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonError("Corpo inválido.", 400);
    }

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return jsonError("Dados inválidos.", 400);
    }

    // `companyId` da SESSÃO: um id de pedido de outra empresa devolve 404, não
    // uma decisão aplicada onde ela não podia chegar.
    const adjustment = await decideTimeAdjustment(
      session.companyId,
      session.id,
      context.params.id,
      parsed.data.decision,
      parsed.data.decisionReason ?? null,
    );

    return jsonOk({
      adjustment: {
        id: adjustment.id,
        status: adjustment.status,
        decidedAt: adjustment.decidedAt?.toISOString() ?? null,
        decidedByName: adjustment.decidedByName,
        decisionReason: adjustment.decisionReason,
      },
    });
  });
}
