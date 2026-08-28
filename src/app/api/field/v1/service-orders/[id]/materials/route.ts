import { z } from "zod";
import { consumeInventoryForOrder } from "@/lib/inventory";
import { fieldOrderCommand } from "@/lib/field/command";
import { clientMutationId, fieldExpectedVersion } from "@/lib/field/route";

/**
 * `POST /api/field/v1/service-orders/:id/materials`
 *
 * Baixa material do estoque DO TÉCNICO contra esta OS.
 *
 * ## O aplicativo não decide saldo
 *
 * Ele envia item e quantidade; quem soma os movimentos, serializa a corrida e
 * recusa saldo insuficiente é o servidor. Uma verificação no cliente é
 * conveniência para evitar uma ida ao servidor — um APK antigo, um app
 * modificado ou uma requisição montada à mão passam por cima dela.
 *
 * ## Só consumo
 *
 * Não existe rota do Field para ENTRADA de estoque. Se existisse, o técnico
 * criaria o próprio saldo antes de baixá-lo e a validação não valeria nada.
 * Receber do almoxarifado é operação administrativa.
 */
const schema = z
  .object({
    expectedVersion: fieldExpectedVersion,
    itemId: z.string().min(1).max(50),
    quantity: z.number().finite().positive(),
    notes: z.string().max(300).optional().nullable(),
    clientMutationId,
  })
  .strict();

export const POST = fieldOrderCommand(
  "service-order.material.consume",
  schema,
  async ({ principal, body, orderId }) => {
    const result = await consumeInventoryForOrder(
      principal.user.companyId,
      principal.user.id,
      orderId,
      {
        itemId: body.itemId,
        quantity: body.quantity,
        expectedOrderVersion: body.expectedVersion,
        notes: body.notes ?? null,
      },
    );

    return {
      status: 201,
      resourceId: result.movementId,
      body: {
        material: {
          id: result.materialUsageId,
          itemCode: result.itemCode,
          itemName: result.itemName,
          quantity: result.quantity,
          unit: result.unit,
        },
        remainingBalance: result.remainingBalance,
      },
    };
  },
);
