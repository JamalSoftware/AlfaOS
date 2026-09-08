import { z } from "zod";
import { CTO_CONNECTION_REASON_MAX_LENGTH } from "@/lib/cto-connections";
import { fieldOrderCommand } from "@/lib/field/command";
import {
  assertFieldCtoEnabled,
  fieldDisconnectCustomer,
  toFieldConnectionResult,
} from "@/lib/field/cto";
import {
  clientMutationId,
  fieldExpectedVersion,
  fieldResourceId,
} from "@/lib/field/route";

/**
 * `POST /api/field/v1/service-orders/:id/network/disconnect`
 *
 * Encerra o vínculo do cliente da OS. **Nunca apaga**: a linha ganha
 * `disconnectedAt` e continua contando que o cliente esteve ali.
 *
 * ## `expectedConnectionId` é obrigatório
 *
 * Sem ele a operação seria *desconecte o que este cliente tiver agora*, e uma
 * tela desatualizada bastaria para o estrago: o técnico vê o cliente na porta A,
 * o despacho o move para B, o técnico toca em desconectar e o servidor encerra
 * B — um vínculo que ele nunca viu. Opcional seria pior que ausente, porque
 * quem esquecesse de mandar reabriria o buraco sem nenhum sinal.
 *
 * O vínculo **não** vai no caminho. Ele não é filho da OS: pertence ao cliente,
 * e a OS é procedência, não posse (`serviceOrderId` é `SET NULL`). Pendurá-lo
 * na rota sugeriria uma propriedade que o modelo não tem.
 *
 * A CTO **não** precisa estar ativa: desativar uma caixa não pode prender quem
 * está dentro dela.
 */
const schema = z
  .object({
    expectedVersion: fieldExpectedVersion,
    expectedConnectionId: fieldResourceId,
    reason: z.string().max(CTO_CONNECTION_REASON_MAX_LENGTH).optional(),
    clientMutationId,
  })
  .strict();

export const POST = fieldOrderCommand(
  "service-order.network.disconnect",
  schema,
  async ({ principal, body, orderId }) => {
    const closed = await fieldDisconnectCustomer(
      { principal, orderId, expectedVersion: body.expectedVersion },
      {
        expectedConnectionId: body.expectedConnectionId,
        reason: body.reason ?? null,
      },
    );

    return {
      status: 200,
      resourceId: closed.id,
      body: {
        connection: null,
        previous: toFieldConnectionResult(closed),
      },
    };
  },
  { precondition: assertFieldCtoEnabled },
);
