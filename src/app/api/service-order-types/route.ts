import { AccessProfile } from "@prisma/client";
import { z } from "zod";
import { assertProfile, jsonError, jsonOk, runApi } from "@/lib/api";
import { assertSameOrigin } from "@/lib/csrf";
import { getSessionUser } from "@/lib/session";
import {
  createServiceOrderType,
  listCompanyServiceOrderTypes,
  TYPE_DESCRIPTION_MAX_LENGTH,
  TYPE_NAME_MAX_LENGTH,
} from "@/lib/service-order-types";

/** Despachante precisa ler o catálogo para abrir OS; só ADMIN mantém. */
const VIEW_PROFILES = [AccessProfile.ADMIN, AccessProfile.DISPATCHER];
const MANAGE_PROFILES = [AccessProfile.ADMIN];

const createTypeSchema = z
  .object({
    name: z.string().min(1, "Nome é obrigatório.").max(TYPE_NAME_MAX_LENGTH),
    description: z
      .string()
      .max(TYPE_DESCRIPTION_MAX_LENGTH)
      .optional()
      .or(z.literal("")),
    sortOrder: z.number().int().min(0).max(9999).optional(),
  })
  .strict();

export async function GET(request: Request) {
  return runApi(async () => {
    const session = await getSessionUser(request);
    if (!session) {
      return jsonError("Não autenticado.", 401);
    }
    const denied = assertProfile(session.profile, VIEW_PROFILES);
    if (denied) return denied;

    const url = new URL(request.url);
    const includeInactive = url.searchParams.get("includeInactive") === "true";

    const types = await listCompanyServiceOrderTypes(session.companyId, {
      includeInactive,
    });
    return jsonOk({ types });
  });
}

export async function POST(request: Request) {
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

    const parsed = createTypeSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError("Dados inválidos.", 400, parsed.error.flatten());
    }

    // `companyId` vem da sessão. O schema é strict e não tem o campo, então
    // não há caminho pelo qual o cliente escolha a empresa do tipo.
    const type = await createServiceOrderType(session.companyId, session.id, {
      name: parsed.data.name,
      description: parsed.data.description || null,
      sortOrder: parsed.data.sortOrder,
    });
    return jsonOk({ type }, 201);
  });
}
