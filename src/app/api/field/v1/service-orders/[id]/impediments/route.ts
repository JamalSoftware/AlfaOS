import { z } from "zod";
import { fieldOrderCommand } from "@/lib/field/command";
import { clientMutationId, fieldExpectedVersion } from "@/lib/field/route";
import { recordImpediment } from "@/lib/service-order-work-events";

/**
 * `POST /api/field/v1/service-orders/:id/impediments`
 *
 * "Não consegui executar" (PRD §169).
 *
 * **Não muda o status da OS.** Ela continua `IN_PROGRESS`, e quem decide
 * reagendar ou cancelar é a operação, pelos comandos que já existem. Fechar a
 * OS aqui seria a conclusão falsa que o impedimento existe para tornar
 * desnecessária.
 *
 * Sem esta ação, o técnico que não conseguiu entrar tem duas saídas: concluir
 * uma OS que não executou, ou deixá-la aberta sem explicação. A primeira
 * corrompe o histórico e o indicador de qualidade; a segunda deixa o
 * despachante cego.
 */
const schema = z
  .object({
    expectedVersion: fieldExpectedVersion,
    reason: z.enum([
      "CUSTOMER_ABSENT",
      "CUSTOMER_NOT_ANSWERING",
      "NO_ACCESS",
      "MISSING_MATERIAL",
      "EXTERNAL_NETWORK_ISSUE",
      "WEATHER",
      "NEED_SECOND_TECHNICIAN",
      "NEED_SPECIAL_EQUIPMENT",
      "SAFETY_RISK",
      "OTHER",
    ]),
    notes: z.string().max(500).optional().nullable(),
    clientMutationId,
  })
  .strict();

export const POST = fieldOrderCommand(
  "service-order.impediment",
  schema,
  async ({ principal, body, orderId }) => {
    const impediment = await recordImpediment(
      principal.user.companyId,
      principal.user.id,
      orderId,
      {
        expectedOrderVersion: body.expectedVersion,
        reason: body.reason,
        notes: body.notes ?? null,
      },
    );

    return {
      status: 201,
      resourceId: impediment.id,
      body: {
        impediment: {
          id: impediment.id,
          reason: body.reason,
          reportedAt: impediment.reportedAt.toISOString(),
        },
      },
    };
  },
);
