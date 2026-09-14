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
 * ## A posição do aparelho é OBRIGATÓRIA (RC-1C)
 *
 * É contra ela que o servidor mede a distância até o ponto cadastrado, e acima
 * de `LOCATION_CONFIRM_MAX_DISTANCE_M` (100 m) a confirmação é recusada com
 * `400` — a saída é `correct`. Sem GPS, também `400`: confirmar sem medir é o
 * defeito que a fase fechou.
 *
 * O schema continua aceitando `null`/ausente e o domínio recusa com a mensagem
 * certa — forma aqui, regra no domínio. Um `.min()` no zod devolveria o
 * "Dados inválidos" genérico a um técnico que só está sem sinal.
 *
 * A coordenada do aparelho não vira a localização do cliente, que continua onde
 * estava; ela fica registrada junto da distância. E a distância **nunca** vem do
 * corpo: um campo `distanceMeters` é recusado pelo `.strict()`.
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
