import { z } from "zod";
import { jsonError, jsonOk } from "@/lib/api";
import { logAudit } from "@/lib/audit";
import { createSessionToken } from "@/lib/auth";
import { SESSION_COOKIE_NAME, SESSION_MAX_AGE_SECONDS } from "@/lib/constants";
import { verifyPassword } from "@/lib/password";
import { prisma } from "@/lib/prisma";

const loginSchema = z.object({
  email: z.string().email("E-mail inválido.").max(255),
  password: z.string().min(1, "Senha é obrigatória.").max(128),
});

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("Corpo da requisição inválido.", 400);
  }

  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError("Dados de login inválidos.", 400);
  }

  const { email, password } = parsed.data;

  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase().trim() },
  });

  if (!user) {
    return jsonError("Credenciais inválidas.", 401);
  }

  if (!user.active) {
    await logAudit({
      companyId: user.companyId,
      userId: user.id,
      action: "AUTH.LOGIN_BLOCKED",
      entity: "User",
      entityId: user.id,
      details: "Tentativa de login de usuário inativo.",
    });
    return jsonError("Usuário inativo. Contate o administrador.", 401);
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    await logAudit({
      companyId: user.companyId,
      userId: user.id,
      action: "AUTH.LOGIN_FAILED",
      entity: "User",
      entityId: user.id,
    });
    return jsonError("Credenciais inválidas.", 401);
  }

  const token = await createSessionToken(user.id);

  await logAudit({
    companyId: user.companyId,
    userId: user.id,
    action: "AUTH.LOGIN",
    entity: "User",
    entityId: user.id,
  });

  const response = jsonOk({
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      profile: user.profile,
      companyId: user.companyId,
    },
  });

  response.cookies.set({
    name: SESSION_COOKIE_NAME,
    value: token,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });

  return response;
}
