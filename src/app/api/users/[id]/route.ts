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

// `.strict()`: unknown fields are rejected instead of ignored, like every
// other write schema in the project. This is the route that creates/edits
// ADMIN accounts, so it gets the mass-assignment guard too.
const updateUserSchema = z
  .object({
    name: z.string().min(2).max(120).optional(),
    email: z.string().email("E-mail inválido.").max(255).optional(),
    password: z
      .string()
      .min(8, "Senha deve ter ao menos 8 caracteres.")
      .max(128)
      .optional(),
    profile: z.nativeEnum(AccessProfile).optional(),
    active: z.boolean().optional(),
  })
  .strict();

const SELF_PRIVILEGE_CHANGE =
  "Você não pode desativar ou alterar o próprio perfil de acesso.";

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

    // An ADMIN who deactivates or demotes themselves loses the session on the
    // very next request (`getSessionUserFromToken` rejects inactive users) and,
    // if they were the only ADMIN, locks the company out permanently — there is
    // no in-app recovery path. Renaming, changing own e-mail or own password
    // stay allowed; only the privilege-losing edits are refused. Sending the
    // unchanged `profile`/`active` (which the edit form always does) is a no-op
    // and passes.
    if (targetId === session.id) {
      const deactivatingSelf = parsed.data.active === false;
      const changingOwnProfile =
        parsed.data.profile !== undefined &&
        parsed.data.profile !== existing.profile;
      if (deactivatingSelf || changingOwnProfile) {
        return jsonError(SELF_PRIVILEGE_CHANGE, 403);
      }
    }

    if (parsed.data.email !== undefined) {
      const available = await ensureEmailAvailable(parsed.data.email, targetId);
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
