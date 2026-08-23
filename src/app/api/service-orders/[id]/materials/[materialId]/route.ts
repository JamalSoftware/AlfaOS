import { AccessProfile, MaterialUnit } from "@prisma/client";
import { z } from "zod";
import { assertProfile, jsonError, jsonOk, runApi } from "@/lib/api";
import { assertSameOrigin } from "@/lib/csrf";
import { getSessionUser } from "@/lib/session";
import { expectedVersionSchema } from "@/lib/version";
import {
  MATERIAL_DESCRIPTION_MAX,
  MATERIAL_QUANTITY_MAX,
  removeMaterial,
  updateMaterial,
} from "@/lib/service-order-closing";

const TECHNICIAN_PROFILES = [AccessProfile.TECHNICIAN];

const updateSchema = z
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

const deleteSchema = z
  .object({ expectedOrderVersion: expectedVersionSchema })
  .strict();

type Ctx = { params: { id: string; materialId: string } };

async function guard(request: Request) {
  const csrfBlocked = assertSameOrigin(request);
  if (csrfBlocked) return { error: csrfBlocked };
  const session = await getSessionUser(request);
  if (!session) {
    return { error: jsonError("Não autenticado.", 401) };
  }
  const denied = assertProfile(session.profile, TECHNICIAN_PROFILES);
  if (denied) return { error: denied };
  return { session };
}

export async function PATCH(request: Request, context: Ctx) {
  return runApi(async () => {
    const g = await guard(request);
    if (g.error) return g.error;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonError("Corpo da requisição inválido.", 400);
    }
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError("Dados inválidos.", 400, parsed.error.flatten());
    }

    const { expectedOrderVersion, ...fields } = parsed.data;
    const material = await updateMaterial(
      g.session.companyId,
      g.session.id,
      context.params.id,
      context.params.materialId,
      fields,
      expectedOrderVersion,
    );
    return jsonOk({ material });
  });
}

export async function DELETE(request: Request, context: Ctx) {
  return runApi(async () => {
    const g = await guard(request);
    if (g.error) return g.error;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonError("Corpo da requisição inválido.", 400);
    }
    const parsed = deleteSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError("Dados inválidos.", 400, parsed.error.flatten());
    }

    await removeMaterial(
      g.session.companyId,
      g.session.id,
      context.params.id,
      context.params.materialId,
      parsed.data.expectedOrderVersion,
    );
    return jsonOk({ removed: true });
  });
}
