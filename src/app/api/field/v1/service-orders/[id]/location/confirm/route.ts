import { z } from "zod";
import { confirmCustomerLocation } from "@/lib/customer-locations";
import { fieldOrderCommand } from "@/lib/field/command";
import { clientMutationId, fieldExpectedVersion } from "@/lib/field/route";

/**
 * `POST /api/field/v1/service-orders/:id/location/confirm`
 *
 * O técnico confirma que a localização cadastrada do cliente está correta.
 *
 * `expectedVersion` aqui é o da LOCALIZAÇÃO, não o da OS. São objetos
 * diferentes com locks próprios: um despachante mexendo na OS não pode
 * invalidar a confirmação que o técnico está enviando, e confirmar a
 * localização não pode invalidar a foto que está subindo.
 *
 * A coordenada do aparelho é OPCIONAL e entra como observação. Ela é gravada no
 * histórico junto da distância calculada no servidor — não vira a localização
 * do cliente, que continua onde estava. Mover o ponto é `correct`, que é outra
 * ação e exige motivo.
 */
const schema = z
  .object({
    expectedVersion: fieldExpectedVersion,
    observedLatitude: z.number().optional().nullable(),
    observedLongitude: z.number().optional().nullable(),
    observedAccuracyMeters: z.number().nonnegative().optional().nullable(),
    clientMutationId,
  })
  .strict();

export const POST = fieldOrderCommand(
  "service-order.location.confirm",
  schema,
  async ({ principal, body, orderId }) => {
    const result = await confirmCustomerLocation(
      principal.user.companyId,
      principal.user.id,
      orderId,
      {
        expectedVersion: body.expectedVersion,
        observedLatitude: body.observedLatitude ?? null,
        observedLongitude: body.observedLongitude ?? null,
        observedAccuracyMeters: body.observedAccuracyMeters ?? null,
      },
    );

    return {
      body: {
        location: {
          latitude: result.location.latitude,
          longitude: result.location.longitude,
          accuracyMeters: result.location.accuracyMeters,
          source: result.location.source,
          verified: result.location.verified,
          reference: result.location.reference,
          version: result.location.version,
        },
        distanceMeters: result.distanceMeters,
      },
    };
  },
);
