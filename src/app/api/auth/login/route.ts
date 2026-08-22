import { z } from "zod";
import { jsonError, jsonOk, runApi } from "@/lib/api";
import { logAudit } from "@/lib/audit";
import { createSessionToken } from "@/lib/auth";
import {
  LOGIN_WINDOW_SECONDS,
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_SECONDS,
} from "@/lib/constants";
import { assertSameOrigin } from "@/lib/csrf";
import { DUMMY_PASSWORD_HASH, verifyPassword } from "@/lib/password";
import { prisma } from "@/lib/prisma";
import {
  getClientIp,
  isLoginBlocked,
  recordLoginAttempt,
} from "@/lib/rate-limit";

const loginSchema = z.object({
  email: z.string().email("E-mail inválido.").max(255),
  password: z.string().min(1, "Senha é obrigatória.").max(128),
});

/**
 * Single message for every rejected login. Distinguishing "no such account",
 * "inactive account" and "wrong password" would let an anonymous caller
 * enumerate valid accounts. The real reason is only recorded in the audit log.
 */
const INVALID_CREDENTIALS = "Credenciais inválidas.";

const RATE_LIMITED_ACTION = "AUTH.RATE_LIMITED";

/**
 * Records `AUTH.RATE_LIMITED` only on the transition into the blocked state.
 *
 * A sustained flood would otherwise write one audit row per rejected request,
 * inflating `audit_logs` and pushing every real security event out of the
 * dashboard's "Atividade recente" panel (which reads the last 10 rows). One
 * row per user per window is enough to reconstruct the incident.
 */
async function logRateLimitOnce(user: {
  id: string;
  companyId: string;
}): Promise<void> {
  const since = new Date(Date.now() - LOGIN_WINDOW_SECONDS * 1000);
  const alreadyLogged = await prisma.auditLog.findFirst({
    where: {
      userId: user.id,
      action: RATE_LIMITED_ACTION,
      createdAt: { gte: since },
    },
    select: { id: true },
  });
  if (alreadyLogged) {
    return;
  }

  await logAudit({
    companyId: user.companyId,
    userId: user.id,
    action: RATE_LIMITED_ACTION,
    entity: "User",
    entityId: user.id,
    details: "Tentativas de login excedidas. Acesso temporariamente bloqueado.",
  });
}

export async function POST(request: Request) {
  return runApi(async () => {
    const csrfBlocked = assertSameOrigin(request);
    if (csrfBlocked) {
      return csrfBlocked;
    }

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

    const email = parsed.data.email.toLowerCase().trim();
    const ip = getClientIp(request);

    // Runs BEFORE the user lookup and before verifyPassword on purpose: the
    // bcrypt comparison below costs ~350ms of synchronous event-loop time, so
    // rejecting after it would leave the DoS wide open. Every ceiling
    // (e-mail, IP, global) is evaluated here.
    if (await isLoginBlocked(email, ip)) {
      const blockedUser = await prisma.user.findUnique({ where: { email } });
      if (blockedUser) {
        await logRateLimitOnce(blockedUser);
      }
      return jsonError(
        "Muitas tentativas de login. Tente novamente em alguns minutos.",
        429,
      );
    }

    const user = await prisma.user.findUnique({ where: { email } });

    // Always pay the bcrypt cost, even when the account does not exist, so the
    // response time does not reveal whether the e-mail is registered.
    const valid = await verifyPassword(
      parsed.data.password,
      user?.passwordHash ?? DUMMY_PASSWORD_HASH,
    );

    if (!user) {
      await recordLoginAttempt(email, ip, false);
      return jsonError(INVALID_CREDENTIALS, 401);
    }

    if (!user.active) {
      await recordLoginAttempt(email, ip, false);
      await logAudit({
        companyId: user.companyId,
        userId: user.id,
        action: "AUTH.LOGIN_BLOCKED",
        entity: "User",
        entityId: user.id,
        details: "Tentativa de login de usuário inativo.",
      });
      return jsonError(INVALID_CREDENTIALS, 401);
    }

    if (!valid) {
      await recordLoginAttempt(email, ip, false);
      await logAudit({
        companyId: user.companyId,
        userId: user.id,
        action: "AUTH.LOGIN_FAILED",
        entity: "User",
        entityId: user.id,
      });
      return jsonError(INVALID_CREDENTIALS, 401);
    }

    await recordLoginAttempt(email, ip, true);
    await logAudit({
      companyId: user.companyId,
      userId: user.id,
      action: "AUTH.LOGIN",
      entity: "User",
      entityId: user.id,
    });

    const token = await createSessionToken(user.id);

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
  });
}
