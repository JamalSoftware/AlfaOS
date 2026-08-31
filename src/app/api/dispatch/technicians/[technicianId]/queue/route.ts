import { AccessProfile } from "@prisma/client";
import { assertProfile, jsonError, jsonOk, runApi } from "@/lib/api";
import { getSessionUser } from "@/lib/session";
import { getDispatchQueueView } from "@/lib/dispatch-queue-view";

const STAFF_PROFILES = [AccessProfile.ADMIN, AccessProfile.DISPATCHER];

/**
 * `GET /api/dispatch/technicians/:technicianId/queue`
 *
 * A fila operacional autoritativa de um técnico (PRD §325, `docs/DISPATCH-QUEUE.md`).
 *
 * ## É o backend que responde "em que ordem"
 *
 * A tela apresenta — agrupa, rotula, numera — e **nunca reordena**. `queued` já
 * chega ordenado por `position` crescente, 1..N, e `queueVersion` volta como
 * `expectedQueueVersion` na mutação seguinte: é ele que transforma "reordenar
 * sobre uma tela de dez minutos atrás" em 409 em vez de sobrescrita silenciosa.
 *
 * ## `inProgress` é coleção, e não vem da fila
 *
 * Vem de `ServiceOrder.status`, que continua sendo a fonte de verdade do que
 * está em atendimento (PRD §321). E é uma lista porque o AlfaOS permite mais de
 * uma `IN_PROGRESS` por técnico — escolher uma como "a verdadeira" esconderia
 * trabalho que existe.
 *
 * ## Leitura pura
 *
 * Não cria fila. Abrir a tela de um técnico não pode escrever no banco, e um
 * técnico só olhado não passa a ter fila. Sem fila ainda, a resposta é uma fila
 * vazia com `queueVersion: 0`.
 *
 * ## Papéis e tenant
 *
 * ADMIN e DISPATCHER — os perfis que de fato existem em `AccessProfile`. O
 * técnico não lê a fila da equipe por aqui; a leitura dele será a superfície
 * do Field, em fase própria.
 *
 * `companyId` sai da SESSÃO. `technicianId` vem da rota e é conferido contra
 * ela dentro do domínio: de outra empresa devolve **404**, nunca 403.
 */
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: { technicianId: string } },
) {
  return runApi(async () => {
    const session = await getSessionUser(request);
    if (!session) {
      return jsonError("Não autenticado.", 401);
    }
    const denied = assertProfile(session.profile, STAFF_PROFILES);
    if (denied) return denied;

    const queue = await getDispatchQueueView(
      session.companyId,
      context.params.technicianId,
    );
    return jsonOk({ queue });
  });
}
