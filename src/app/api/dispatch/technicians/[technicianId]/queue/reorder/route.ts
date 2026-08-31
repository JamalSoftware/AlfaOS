import { AccessProfile } from "@prisma/client";
import { z } from "zod";
import { assertProfile, jsonError, jsonOk, runApi } from "@/lib/api";
import { assertSameOrigin } from "@/lib/csrf";
import {
  idempotencyActor,
  parseIdempotencyKey,
  withIdempotency,
} from "@/lib/field/idempotency";
import { getSessionUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { moveOrderToPosition } from "@/lib/dispatch-queue-service";
import { getDispatchQueueView } from "@/lib/dispatch-queue-view";
import { expectedVersionSchema } from "@/lib/version";

const STAFF_PROFILES = [AccessProfile.ADMIN, AccessProfile.DISPATCHER];

/**
 * `POST /api/dispatch/technicians/:technicianId/queue/reorder`
 *
 * Move uma OS para uma posição absoluta na fila do técnico (PRD §316).
 *
 * ## Alvo absoluto, nunca delta
 *
 * Não existe `moveUp` nem `moveDown` na API. "Subir uma posição" aplicada duas
 * vezes sobe **duas**, e retry de rede transformaria uma correção em duas
 * (PRD §318). A UI futura calcula o `targetPosition` a partir do gesto —
 * arrastar e as setas produzem o MESMO comando.
 *
 * ## `expectedQueueVersion` é obrigatório
 *
 * Diferente da primitiva interna, que aceita ausência: aqui há sempre uma
 * leitura de tela por trás. Sem o token, dois despachantes sobre a mesma fila
 * gravariam um por cima do outro sem que ninguém percebesse — e o CAS da
 * `ServiceOrder` não cobre isso, porque reordenar escreve N linhas e ele
 * responde por uma.
 *
 * ## A precedência não é violável, mas o pedido é ACOMODADO
 *
 * Uma `NORMAL` pedindo a posição 1 vai para o topo da banda dela, não para o
 * topo da fila — e a resposta traz a fila resultante, com a posição efetiva.
 * Recusar faria o cartão voltar sozinho na tela, que se lê como travamento
 * (PRD §204, §320).
 */
const schema = z
  .object({
    serviceOrderId: z.string().min(1, "OS é obrigatória."),
    /**
     * 1-based, como o usuário vê. Fora da faixa sofre clamp no domínio, e não
     * erro: "mover para o fim" digitado como 99 numa fila de 6 é intenção
     * clara.
     */
    targetPosition: z.number().int().min(1).max(10_000),
    expectedQueueVersion: expectedVersionSchema,
  })
  .strict();

export async function POST(
  request: Request,
  context: { params: { technicianId: string } },
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

    // A chave é lida DEPOIS do corpo, como na rota administrativa da Jornada:
    // quem monta a requisição aqui é um formulário, e o operador precisa ver
    // "dados inválidos" quando os dados estão inválidos.
    const key = parseIdempotencyKey(request);
    const technicianId = context.params.technicianId;

    const outcome = await withIdempotency(
      idempotencyActor(session.companyId, session.id),
      // Operação PRÓPRIA: compartilhar o nome com outro comando faria duas
      // chaves iguais de telas diferentes colidirem, e a segunda receberia o
      // desfecho guardado da primeira.
      "dispatch.queue-reorder",
      key,
      { technicianId, ...parsed.data },
      async () => {
        await prisma.$transaction((tx) =>
          moveOrderToPosition(tx, {
            companyId: session.companyId,
            technicianId,
            serviceOrderId: parsed.data.serviceOrderId,
            targetPosition: parsed.data.targetPosition,
            expectedQueueVersion: parsed.data.expectedQueueVersion,
          }),
        );

        /*
          Devolve a fila inteira, e não `204`.

          Uma renumeração muda N linhas: com `204` a tela teria de fazer um
          `GET` imediato, e entre os dois cabe outra mutação — ela pintaria um
          estado que nunca foi resultado de nada.
        */
        const queue = await getDispatchQueueView(
          session.companyId,
          technicianId,
        );
        return { status: 200, body: { queue } };
      },
    );

    return jsonOk(outcome.body, outcome.status);
  });
}
