import { z } from "zod";
import { fieldCommand } from "@/lib/field/command";
import { clientMutationId } from "@/lib/field/route";
import {
  ADJUSTMENT_NOTES_MAX,
  ADJUSTMENT_REASON_MAX,
  listOwnAdjustments,
  requestTimeAdjustment,
} from "@/lib/time-clock";
import { fieldOk, runFieldApi } from "@/lib/field/response";
import { requireFieldPrincipal } from "@/lib/field/route";

export const dynamic = "force-dynamic";

/**
 * `GET /api/field/v1/time-clock/adjustments`
 *
 * Os pedidos de correção do próprio funcionário, com o desfecho de cada um.
 *
 * Pedido rejeitado aparece aqui: ele não é apagado (PRD §229). Quem pediu
 * precisa ver que foi recusado e por quê — sumir com a recusa seria decidir
 * sem contraditório.
 */
export async function GET(request: Request) {
  return runFieldApi(async () => {
    const principal = await requireFieldPrincipal(request);
    const adjustments = await listOwnAdjustments(
      principal.user.companyId,
      principal.user.id,
    );
    return fieldOk({
      adjustments: adjustments.map((a) => ({
        id: a.id,
        status: a.status,
        requestedType: a.requestedType,
        requestedEntryType: a.requestedEntryType,
        requestedOccurredAt: a.requestedOccurredAt.toISOString(),
        reason: a.reason,
        workdayDate: a.workdayDate,
        decidedAt: a.decidedAt?.toISOString() ?? null,
        decisionReason: a.decisionReason,
        createdAt: a.createdAt.toISOString(),
      })),
    });
  });
}

/**
 * `POST /api/field/v1/time-clock/adjustments`
 *
 * Abre um pedido de correção de jornada.
 *
 * **O funcionário não edita a marcação** (PRD §229). Ele descreve o que
 * aconteceu e alguém com autoridade decide. O pedido é a prova: sem ele
 * existiria uma alteração sem motivo declarado e sem contraditório — que é
 * exatamente o que uma fiscalização, ou uma discussão entre as duas partes,
 * precisa reconstruir.
 *
 * `targetEntryId` é opcional porque o caso mais comum é o esquecimento: não há
 * marcação para apontar. Quando vem, o servidor confere que ela é DA PESSOA e
 * DO DIA — sem isso o campo viraria ponteiro para a jornada de um colega.
 */
const schema = z
  .object({
    requestedType: z.enum(["MISSING_ENTRY", "WRONG_TIME", "BREAK", "OTHER"]),
    requestedEntryType: z.enum([
      "CLOCK_IN",
      "BREAK_START",
      "BREAK_END",
      "CLOCK_OUT",
    ]),
    requestedOccurredAt: z.string().datetime(),
    reason: z.string().min(1).max(ADJUSTMENT_REASON_MAX),
    notes: z.string().max(ADJUSTMENT_NOTES_MAX).optional().nullable(),
    targetEntryId: z.string().min(1).max(60).optional().nullable(),
    clientMutationId,
  })
  .strict();

export const POST = fieldCommand(
  "time-clock.adjustment",
  schema,
  async ({ principal, body }) => {
    const adjustment = await requestTimeAdjustment(
      principal.user.companyId,
      principal.user.id,
      {
        requestedType: body.requestedType,
        requestedEntryType: body.requestedEntryType,
        requestedOccurredAt: new Date(body.requestedOccurredAt),
        reason: body.reason,
        notes: body.notes ?? null,
        targetEntryId: body.targetEntryId ?? null,
      },
    );

    return {
      status: 201,
      resourceId: adjustment.id,
      body: {
        adjustment: {
          id: adjustment.id,
          status: adjustment.status,
          requestedEntryType: adjustment.requestedEntryType,
          requestedOccurredAt: adjustment.requestedOccurredAt.toISOString(),
          workdayDate: adjustment.workdayDate,
        },
      },
    };
  },
);
