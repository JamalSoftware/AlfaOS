import { AccessProfile, ServiceOrderPriority } from "@prisma/client";
import { z } from "zod";
import { assertProfile, jsonError, jsonOk, runApi } from "@/lib/api";
import { assertSameOrigin } from "@/lib/csrf";
import {
  idempotencyActor,
  parseIdempotencyKey,
  withIdempotency,
} from "@/lib/field/idempotency";
import { getSessionUser } from "@/lib/session";
import { changeServiceOrderPriority } from "@/lib/service-orders";
import { getDispatchQueueView } from "@/lib/dispatch-queue-view";
import { expectedVersionSchema } from "@/lib/version";

const STAFF_PROFILES = [AccessProfile.ADMIN, AccessProfile.DISPATCHER];

/**
 * `POST /api/service-orders/:id/priority`
 *
 * Altera a prioridade de uma OS (PRD §315).
 *
 * ## Fecha uma lacuna, não só a fila
 *
 * Até aqui `priority` era gravada na criação e **nunca mais mudava**: não havia
 * `PATCH`, e marcar como urgente uma OS já criada era impossível (PRD §310).
 * Esta rota é a primeira forma de fazê-lo — e é ação explícita, não um `PATCH`
 * genérico que aceitasse `{ priority }` junto de qualquer outro campo, que é
 * como `status` ou `companyId` entram de carona (PRD §20).
 *
 * ## Os quatro valores, não dois
 *
 * O domínio tem `LOW`, `NORMAL`, `HIGH` e `URGENT`, e OS reais já foram
 * gravadas com os quatro. A ação rápida `Normal ↔ Urgente` que a tela vai
 * oferecer é atalho de UI (`D-02`); a API aceita o enum inteiro, ou não haveria
 * como tirar uma OS de um `HIGH` legado.
 *
 * ## DOIS agregados, DOIS compare-and-set
 *
 * A operação escreve a `ServiceOrder` **e** reposiciona a fila. Um
 * `expectedVersion` só não protege os dois: o despachante pode ter lido a OS
 * agora e a fila há dez minutos.
 *
 * ```text
 * expectedVersion        a OS mudou desde que você leu?
 * expectedQueueVersion   a FILA mudou desde que você leu?
 * ```
 *
 * O segundo é exigido pelo domínio **só quando a OS está numa fila** — uma OS
 * ainda sem técnico muda de prioridade normalmente, e não haveria versão de
 * fila a comparar. Por isso ele é opcional no schema e obrigatório na regra:
 * quem decide é quem sabe se há fila.
 *
 * ## Sem `targetPosition`, vai para o FIM da banda nova
 *
 * Promover não é o mesmo que pedir o primeiro lugar. É a única política que não
 * altera a ordem relativa de nenhuma outra OS (`D-04`, `D-05`); quem quiser
 * outra posição manda `targetPosition` ou usa a reordenação.
 */
const schema = z
  .object({
    priority: z.nativeEnum(ServiceOrderPriority),
    expectedVersion: expectedVersionSchema,
    expectedQueueVersion: expectedVersionSchema.optional(),
    targetPosition: z.number().int().min(1).max(10_000).optional(),
  })
  .strict();

export async function POST(
  request: Request,
  context: { params: { id: string } },
) {
  return runApi(async () => {
    const csrfBlocked = assertSameOrigin(request);
    if (csrfBlocked) return csrfBlocked;

    const session = await getSessionUser(request);
    if (!session) {
      return jsonError("Não autenticado.", 401);
    }
    const denied = assertProfile(session.profile, STAFF_PROFILES);
    if (denied) return denied;

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

    const key = parseIdempotencyKey(request);
    const orderId = context.params.id;

    const outcome = await withIdempotency(
      idempotencyActor(session.companyId, session.id),
      "service-order.priority-change",
      key,
      { orderId, ...parsed.data },
      async () => {
        const result = await changeServiceOrderPriority(
          session.companyId,
          session.id,
          orderId,
          {
            priority: parsed.data.priority,
            expectedVersion: parsed.data.expectedVersion,
            expectedQueueVersion: parsed.data.expectedQueueVersion,
            targetPosition: parsed.data.targetPosition,
          },
        );

        /*
          A fila resultante volta na resposta quando existe fila.

          Uma OS sem técnico não tem fila, e inventar uma resposta vazia ali
          faria a tela achar que a fila do ninguém ficou vazia. `queue: null` é
          a resposta honesta.
        */
        const queue = result.technicianId
          ? await getDispatchQueueView(session.companyId, result.technicianId)
          : null;

        return { status: 200, body: { changed: result.changed, queue } };
      },
    );

    return jsonOk(outcome.body, outcome.status);
  });
}
