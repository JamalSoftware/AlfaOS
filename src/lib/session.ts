import { cookies } from "next/headers";
import type { AccessProfile } from "@prisma/client";
import { verifySessionToken } from "./auth";
import { SESSION_COOKIE_NAME } from "./constants";
import { prisma } from "./prisma";

export interface SessionUser {
  id: string;
  companyId: string;
  name: string;
  email: string;
  profile: AccessProfile;
  active: boolean;
}

export function getUserFromPayload(payload: {
  id: string;
  companyId: string;
  name: string;
  email: string;
  profile: AccessProfile;
  active: boolean;
}): SessionUser {
  return {
    id: payload.id,
    companyId: payload.companyId,
    name: payload.name,
    email: payload.email,
    profile: payload.profile,
    active: payload.active,
  };
}

function getTokenFromRequest(request: Request): string | null {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) {
    return null;
  }
  const entry = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE_NAME}=`));
  if (!entry) {
    return null;
  }
  return decodeURIComponent(entry.slice(SESSION_COOKIE_NAME.length + 1));
}

/**
 * Resolves the authenticated session user.
 *
 * - In API route handlers, pass the incoming `request` so the session token
 *   is read from the request Cookie header. This keeps the function
 *   deterministic and easy to test without a request scope.
 * - In server components/pages, call without arguments so the session is
 *   read from the request scope via `next/headers`.
 */
export async function getSessionUser(
  request?: Request,
): Promise<SessionUser | null> {
  let token: string | null = null;
  if (request) {
    token = getTokenFromRequest(request);
  } else {
    // Next 15: `cookies()` é assíncrona (`SEC-003`). O acesso síncrono ainda
    // funciona como compatibilidade temporária, com aviso, e sai no 16 — então
    // o `await` é o que mantém a leitura da sessão estável entre versões.
    token = (await cookies()).get(SESSION_COOKIE_NAME)?.value ?? null;
  }

  if (!token) {
    return null;
  }

  return getSessionUserFromToken(token);
}

export async function getSessionUserFromToken(
  token: string,
): Promise<SessionUser | null> {
  const claims = await verifySessionToken(token);
  if (!claims) {
    return null;
  }

  const user = await prisma.user.findUnique({
    where: { id: claims.userId },
    include: { company: true },
  });

  if (!user || !user.active || !user.company) {
    return null;
  }

  return getUserFromPayload({
    id: user.id,
    companyId: user.companyId,
    name: user.name,
    email: user.email,
    profile: user.profile,
    active: user.active,
  });
}
