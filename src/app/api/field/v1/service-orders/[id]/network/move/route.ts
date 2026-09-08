import { z } from "zod";
import { CTO_CONNECTION_REASON_MAX_LENGTH } from "@/lib/cto-connections";
import { fieldOrderCommand } from "@/lib/field/command";
import {
  assertFieldCtoEnabled,
  fieldMoveCustomer,
  toFieldConnectionResult,
} from "@/lib/field/cto";
import { clientMutationId, fieldExpectedVersion } from "@/lib/field/route";

/**
 * `POST /api/field/v1/service-orders/:id/network/move`
 *
 * Move o cliente da OS para outra porta.
 *
 * **Uma requisição, não duas.** O aplicativo não desconecta e conecta em
 * seguida: o par abriria uma janela em que o cliente não está em porta nenhuma,
 * e nenhum dos dois lados poderia desfazer o outro se a rede caísse no meio. O
 * domínio fecha e abre na mesma transação, e é essa a diferença que a auditoria
 * enxerga — as duas formas produzem duas linhas, mas só uma registra `MOVED`.
 *
 * A caixa de **origem** pode estar inativa: isso é o `MOVE-OUT`, e é como um
 * cliente sai de uma caixa que a empresa desativou. A de **destino** não pode.
 */
const schema = z
  .object({
    expectedVersion: fieldExpectedVersion,
    expectedConnectionId: z.string().min(1).max(60),
    targetCtoPortId: z.string().min(1).max(60),
    reason: z.string().max(CTO_CONNECTION_REASON_MAX_LENGTH).optional(),
    clientMutationId,
  })
  .strict();

export const POST = fieldOrderCommand(
  "service-order.network.move",
  schema,
  async ({ principal, body, orderId }) => {
    const moved = await fieldMoveCustomer(
      { principal, orderId, expectedVersion: body.expectedVersion },
      {
        expectedConnectionId: body.expectedConnectionId,
        targetCtoPortId: body.targetCtoPortId,
        reason: body.reason ?? null,
      },
    );

    return {
      status: 200,
      resourceId: moved.to.id,
      body: {
        connection: toFieldConnectionResult(moved.to),
        previous: toFieldConnectionResult(moved.from),
      },
    };
  },
  { precondition: assertFieldCtoEnabled },
);
