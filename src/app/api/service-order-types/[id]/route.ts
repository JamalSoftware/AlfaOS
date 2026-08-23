import { AccessProfile } from "@prisma/client";
import { z } from "zod";
import { assertProfile, jsonError, jsonOk, runApi } from "@/lib/api";
import { assertSameOrigin } from "@/lib/csrf";
import { getSessionUser } from "@/lib/session";
import {
  TYPE_DESCRIPTION_MAX_LENGTH,
  TYPE_NAME_MAX_LENGTH,
  updateServiceOrderType,
} from "@/lib/service-order-types";

const MANAGE_PROFILES = [AccessProfile.ADMIN];

/**
 * Whitelist explícita. Não há campo de empresa, nem de vínculo com OS: o tenant
 * vem da sessão e um tipo nunca troca de dono.
 */
const updateTypeSchema = z
  .object({
    name: z.string().min(1).max(TYPE_NAME_MAX_LENGTH).optional(),
    description: z
      .string()
      .max(TYPE_DESCRIPTION_MAX_LENGTH)
      .optional()
      .or(z.literal("")),
    active: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(9999).optional(),
  })
  .strict();

export async function PATCH(
  request: Request,
  context: { params: { id: string } },
) {
  return runApi(async () => {
    const csrfBlocked = assertSameOrigin(request);
    if (csrfBlocked) {
      return csrfBlocked;
    }

    const session = await getSessionUser(request);
    if (!session) {
      return jsonError("Não autenticado.", 401);
    }
    const denied = assertProfile(session.profile, MANAGE_PROFILES);
    if (denied) return denied;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonError("Corpo da requisição inválido.", 400);
    }

    const parsed = updateTypeSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError("Dados inválidos.", 400, parsed.error.flatten());
    }

    // Tipo de outra empresa cai em 404, não 403: 403 confirmaria que o id
    // existe em algum lugar.
    const type = await updateServiceOrderType(
      session.companyId,
      context.params.id,
      session.id,
      {
        name: parsed.data.name,
        description:
          parsed.data.description === undefined
            ? undefined
            : parsed.data.description || null,
        active: parsed.data.active,
        sortOrder: parsed.data.sortOrder,
      },
    );
    return jsonOk({ type });
  });
}
