import { z } from "zod";
import { correctCustomerLocation } from "@/lib/customer-locations";
import { fieldOrderCommand } from "@/lib/field/command";
import { clientMutationId } from "@/lib/field/route";

/**
 * `POST /api/field/v1/service-orders/:id/location/correct`
 *
 * Corrige endereço e/ou coordenada do cliente, com motivo obrigatório.
 *
 * ## `source` é uma lista de dois
 *
 * O aplicativo só pode alegar `TECHNICIAN_GPS` (usou a posição do aparelho) ou
 * `MANUAL` (o técnico digitou). `IMPORTED` e `GEOCODED` descrevem processos
 * automáticos do servidor — aceitá-las do cliente deixaria o aplicativo alegar
 * uma procedência que ele não tem, e a precedência da §197 passaria a depender
 * do que o aparelho diz sobre si mesmo.
 *
 * ## `expectedVersion` aceita `null`
 *
 * `null` significa "eu vi que este cliente NÃO tem localização", e é o
 * compare-and-set da criação. Sem esse caso explícito, dois aparelhos criando o
 * ponto ao mesmo tempo dependeriam só da unique e o perdedor receberia erro de
 * banco em vez de um conflito legível.
 */
const schema = z
  .object({
    expectedVersion: z.number().int().min(0).nullable(),
    reason: z.enum([
      "INCORRECT_ADDRESS",
      "INCORRECT_LOCATION",
      "CUSTOMER_MOVED",
      "INCOMPLETE_REGISTRATION",
      "OTHER",
    ]),
    note: z.string().max(500).optional().nullable(),
    latitude: z.number().optional().nullable(),
    longitude: z.number().optional().nullable(),
    accuracyMeters: z.number().nonnegative().optional().nullable(),
    source: z.enum(["TECHNICIAN_GPS", "MANUAL"]).optional(),
    reference: z.string().max(300).optional().nullable(),
    address: z
      .object({
        address: z.string().max(200).nullable().optional(),
        number: z.string().max(20).nullable().optional(),
        complement: z.string().max(120).nullable().optional(),
        district: z.string().max(120).nullable().optional(),
        city: z.string().max(120).nullable().optional(),
        state: z.string().max(2).nullable().optional(),
        zipCode: z.string().max(12).nullable().optional(),
      })
      .strict()
      .optional(),
    clientMutationId,
  })
  .strict();

export const POST = fieldOrderCommand(
  "service-order.location.correct",
  schema,
  async ({ principal, body, orderId }) => {
    const result = await correctCustomerLocation(
      principal.user.companyId,
      principal.user.id,
      orderId,
      {
        expectedVersion: body.expectedVersion,
        reason: body.reason,
        note: body.note ?? null,
        latitude: body.latitude ?? null,
        longitude: body.longitude ?? null,
        accuracyMeters: body.accuracyMeters ?? null,
        source: body.source,
        reference: body.reference ?? null,
        address: body.address,
      },
    );

    return {
      body: {
        kind: result.kind,
        address: result.address,
        location: result.location
          ? {
              latitude: result.location.latitude,
              longitude: result.location.longitude,
              accuracyMeters: result.location.accuracyMeters,
              source: result.location.source,
              verified: result.location.verified,
              reference: result.location.reference,
              version: result.location.version,
            }
          : null,
      },
    };
  },
);
