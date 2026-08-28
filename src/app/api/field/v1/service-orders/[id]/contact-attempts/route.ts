import { z } from "zod";
import { fieldOrderCommand } from "@/lib/field/command";
import { clientMutationId, fieldExpectedVersion } from "@/lib/field/route";
import { recordContactAttempt } from "@/lib/service-order-work-events";

/**
 * `POST /api/field/v1/service-orders/:id/contact-attempts`
 *
 * Registra uma tentativa de falar com o cliente.
 *
 * Estruturado, e não texto livre: "liguei e não atendeu" numa observação não é
 * consultável, não vira métrica e não sustenta uma cobrança contestada — que é
 * exatamente quando alguém vai procurar esse dado (PRD §168).
 *
 * `notes` é observação curta. **Não é transcrição.** Registrar que houve uma
 * ligação é dado operacional; registrar o que foi dito é outra categoria de
 * coisa, com outras obrigações de LGPD (§113).
 */
const schema = z
  .object({
    expectedVersion: fieldExpectedVersion,
    channel: z.enum(["PHONE_CALL", "WHATSAPP", "SMS", "OTHER"]),
    result: z.enum([
      "ANSWERED",
      "NO_ANSWER",
      "BUSY",
      "INVALID_NUMBER",
      "CUSTOMER_REQUESTED_LATER",
    ]),
    notes: z.string().max(500).optional().nullable(),
    clientMutationId,
  })
  .strict();

export const POST = fieldOrderCommand(
  "service-order.contact-attempt",
  schema,
  async ({ principal, body, orderId }) => {
    const attempt = await recordContactAttempt(
      principal.user.companyId,
      principal.user.id,
      orderId,
      {
        expectedOrderVersion: body.expectedVersion,
        channel: body.channel,
        result: body.result,
        notes: body.notes ?? null,
      },
    );

    return {
      status: 201,
      resourceId: attempt.id,
      body: {
        contactAttempt: {
          id: attempt.id,
          attemptedAt: attempt.attemptedAt.toISOString(),
          channel: body.channel,
          result: body.result,
        },
      },
    };
  },
);
