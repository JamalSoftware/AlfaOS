import { AccessProfile, MaterialUnit } from "@prisma/client";
import { z } from "zod";
import { assertProfile, jsonError, jsonOk, runApi } from "@/lib/api";
import { assertSameOrigin } from "@/lib/csrf";
import { getSessionUser } from "@/lib/session";
import { expectedVersionSchema } from "@/lib/version";
import {
  addMaterial,
  MATERIAL_DESCRIPTION_MAX,
  MATERIAL_QUANTITY_MAX,
} from "@/lib/service-order-closing";

const TECHNICIAN_PROFILES = [AccessProfile.TECHNICIAN];

/**
 * `.strict()` rejects rather than strips, so a caller that tries to set
 * `companyId`, `serviceOrderId`, `createdByUserId` or `status` gets a 400
 * instead of a 200 that quietly ignored the field.
 *
 * `quantity` is bounded on both ends: positive (a negative or zero amount of
 * material is not a real entry) and under the Decimal(10,3) ceiling, so an
 * oversized number is a client error rather than a driver error.
 */
const materialSchema = z
  .object({
    description: z.string().trim().min(1).max(MATERIAL_DESCRIPTION_MAX),
    quantity: z
      .number()
      .positive("Quantidade deve ser maior que zero.")
      .max(MATERIAL_QUANTITY_MAX, "Quantidade fora da faixa suportada."),
    unit: z.nativeEnum(MaterialUnit),
    expectedOrderVersion: expectedVersionSchema,
  })
  .strict();

export async function POST(
  request: Request,
  context: { params: { id: string } },
) {
  return runApi(async () => {
    const csrfBlocked = assertSameOrigin(request);
    if (csrfBlocked) return csrfBlocked;

    const session = await getSessionUser(request);
    if (!session) {
      return jsonError("Não autenticado.", 401);
    }
    const denied = assertProfile(session.profile, TECHNICIAN_PROFILES);
    if (denied) return denied;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonError("Corpo da requisição inválido.", 400);
    }

    const parsed = materialSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError("Dados inválidos.", 400, parsed.error.flatten());
    }

    const { expectedOrderVersion, ...fields } = parsed.data;
    const material = await addMaterial(
      session.companyId,
      session.id,
      context.params.id,
      fields,
      expectedOrderVersion,
    );
    return jsonOk({ material }, 201);
  });
}
