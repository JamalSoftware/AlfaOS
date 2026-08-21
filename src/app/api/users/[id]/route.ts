import { AccessProfile } from "@prisma/client";
import { z } from "zod";
import { jsonError, jsonOk, runApi } from "@/lib/api";
import { assertSameOrigin } from "@/lib/csrf";
import { getSessionUser } from "@/lib/session";
import {
  ensureEmailAvailable,
  getCompanyUser,
  updateCompanyUser,
} from "@/lib/users";

const updateUserSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  email: z.string().email("E-mail inválido.").max(255).optional(),
  password: z
    .string()
    .min(8, "Senha deve ter ao menos 8 caracteres.")
    .max(128)
    .optional(),
  profile: z.nativeEnum(AccessProfile).optional(),
  active: z.boolean().optional(),
});

function assertAdmin(profile: AccessProfile) {
  if (profile !== AccessProfile.ADMIN) {
    return jsonError("Acesso negado. Requer perfil ADMIN.", 403);
  }
  return null;
}

export async function GET(
  request: Request,
  context: { params: { id: string } },
) {
  return runApi(async () => {
    const session = await getSessionUser(request);
    if (!session) {
      return jsonError("Não autenticado.", 401);
    }
    const denied = assertAdmin(session.profile);
    if (denied) return denied;

    const user = await getCompanyUser(session.companyId, context.params.id);
    if (!user) {
      return jsonError("Usuário não encontrado.", 404);
    }
    return jsonOk({ user });
  });
}

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
    const denied = assertAdmin(session.profile);
    if (denied) return denied;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonError("Corpo da requisição inválido.", 400);
    }

    const parsed = updateUserSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError("Dados inválidos.", 400, parsed.error.flatten());
    }

    const targetId = context.params.id;

    const existing = await getCompanyUser(session.companyId, targetId);
    if (!existing) {
      return jsonError("Usuário não encontrado.", 404);
    }

    if (parsed.data.email !== undefined) {
      const available = await ensureEmailAvailable(
        session.companyId,
        parsed.data.email,
        targetId,
      );
      if (!available) {
        return jsonError("Já existe um usuário com este e-mail.", 409);
      }
    }

    const updated = await updateCompanyUser(
      session.companyId,
      targetId,
      parsed.data,
      session.id,
    );

    if (!updated) {
      return jsonError("Usuário não encontrado.", 404);
    }
    return jsonOk({ user: updated });
  });
}
