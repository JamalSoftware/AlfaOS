import { AccessProfile } from "@prisma/client";
import { z } from "zod";
import { jsonError, jsonOk, runApi } from "@/lib/api";
import { assertSameOrigin } from "@/lib/csrf";
import { getSessionUser } from "@/lib/session";
import {
  createCompanyUser,
  ensureEmailAvailable,
  listCompanyUsers,
} from "@/lib/users";

const createUserSchema = z.object({
  name: z.string().min(2, "Nome deve ter ao menos 2 caracteres.").max(120),
  email: z.string().email("E-mail inválido.").max(255),
  password: z
    .string()
    .min(8, "Senha deve ter ao menos 8 caracteres.")
    .max(128),
  profile: z.nativeEnum(AccessProfile),
});

export async function GET(request: Request) {
  return runApi(async () => {
    const session = await getSessionUser(request);
    if (!session) {
      return jsonError("Não autenticado.", 401);
    }
    if (session.profile !== AccessProfile.ADMIN) {
      return jsonError("Acesso negado. Requer perfil ADMIN.", 403);
    }

    const users = await listCompanyUsers(session.companyId);
    return jsonOk({ users });
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
    if (session.profile !== AccessProfile.ADMIN) {
      return jsonError("Acesso negado. Requer perfil ADMIN.", 403);
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonError("Corpo da requisição inválido.", 400);
    }

    const parsed = createUserSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError("Dados inválidos.", 400, parsed.error.flatten());
    }

    const { name, email, password, profile } = parsed.data;

    const available = await ensureEmailAvailable(session.companyId, email);
    if (!available) {
      return jsonError("Já existe um usuário com este e-mail.", 409);
    }

    const user = await createCompanyUser(
      session.companyId,
      { name, email, password, profile },
      session.id,
    );

    return jsonOk({ user }, 201);
  });
}
