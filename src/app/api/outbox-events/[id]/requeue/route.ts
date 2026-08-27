import { AccessProfile } from "@prisma/client";
import { assertProfile, jsonError, jsonOk, runApi } from "@/lib/api";
import { logAudit } from "@/lib/audit";
import { assertSameOrigin } from "@/lib/csrf";
import { getSessionUser } from "@/lib/session";
import { requeueFailedOutboxEvent } from "@/lib/outbox";

/**
 * `POST /api/outbox-events/:id/requeue`
 *
 * Devolve um evento `FAILED` para a fila, depois de corrigida a causa.
 *
 * **Não aceita corpo.** Nada do evento é editável por aqui: nem o tipo, nem o
 * agregado, nem o payload. Um endpoint de requeue que aceitasse payload seria
 * um endpoint de injeção de evento com outro nome — alguém poderia mandar o
 * worker processar um agregado de outra empresa.
 *
 * Só sai de `FAILED`. Um evento `PENDING` já está na fila, e um `PROCESSING`
 * pertence a um worker (ou ao lease que vai expirar) — reenfileirá-los à mão
 * criaria a duplicação que o lease existe para evitar.
 */
const ADMIN_ONLY = [AccessProfile.ADMIN];

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

    const requeued = await requeueFailedOutboxEvent(
      session.companyId,
      context.params.id,
    );

    if (!requeued) {
      // Mesmo 404 para inexistente, de outra empresa e em estado não
      // reenfileirável: nenhuma das três distinções ajuda quem opera, e a
      // primeira ajudaria quem sonda.
      return jsonError("Evento não encontrado ou não reenfileirável.", 404);
    }

    await logAudit({
      companyId: session.companyId,
      userId: session.id,
      action: "OUTBOX.REQUEUED",
      entity: "OutboxEvent",
      entityId: context.params.id,
      details: "Evento reenfileirado manualmente.",
    });

    return jsonOk({ requeued: true });
  });
}
