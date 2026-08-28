import { z } from "zod";
import { fieldOrderCommand } from "@/lib/field/command";
import { clientMutationId, fieldExpectedVersion } from "@/lib/field/route";
import { checkInServiceOrder } from "@/lib/service-order-work-events";

/**
 * `POST /api/field/v1/service-orders/:id/check-in`
 *
 * Registra a chegada do técnico ao local.
 *
 * Coordenada OPCIONAL: permissão negada, prédio sem sinal ou aparelho sem fix
 * produzem um check-in válido sem coordenada. A chegada é o fato operacional; a
 * coordenada é o detalhe. Recusar por falta de GPS deixaria o despachante sem a
 * informação que importa e ensinaria o técnico a não fazer check-in.
 *
 * A distância até o cliente é calculada NO SERVIDOR e devolvida como
 * informação. Não bloqueia nada nesta versão (PRD §167).
 */
const schema = z
  .object({
    expectedVersion: fieldExpectedVersion,
    latitude: z.number().optional().nullable(),
    longitude: z.number().optional().nullable(),
    accuracyMeters: z.number().nonnegative().optional().nullable(),
    clientMutationId,
  })
  .strict();

export const POST = fieldOrderCommand(
  "service-order.check-in",
  schema,
  async ({ principal, body, orderId }) => {
    const result = await checkInServiceOrder(
      principal.user.companyId,
      principal.user.id,
      orderId,
      {
        expectedOrderVersion: body.expectedVersion,
        latitude: body.latitude ?? null,
        longitude: body.longitude ?? null,
        accuracyMeters: body.accuracyMeters ?? null,
      },
    );

    return {
      status: 201,
      resourceId: result.id,
      body: {
        checkIn: {
          id: result.id,
          checkedInAt: result.checkedInAt.toISOString(),
          distanceMeters: result.distanceMeters,
          hasCoordinate: result.hasCoordinate,
        },
      },
    };
  },
);
