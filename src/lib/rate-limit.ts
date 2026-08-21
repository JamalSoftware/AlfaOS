import {
  LOGIN_MAX_FAILED_ATTEMPTS,
  LOGIN_MAX_FAILED_ATTEMPTS_BY_IP,
  LOGIN_WINDOW_SECONDS,
} from "./constants";
import { prisma } from "./prisma";

/**
 * Rate limiting for the login endpoint.
 *
 * Uses PostgreSQL as the backing store so the protection works across
 * multiple instances. It considers:
 *   - the email/identifier;
 *   - the client IP;
 *   - a sliding time window.
 *
 * Legitimate users are never permanently blocked: the counter resets once
 * the window passes. Passwords are never stored — only the outcome flag.
 */

export function getClientIp(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return request.headers.get("x-real-ip");
}

function windowStart(): Date {
  return new Date(Date.now() - LOGIN_WINDOW_SECONDS * 1000);
}

export async function countRecentFailures(
  email: string,
  ip: string | null,
): Promise<{ byEmail: number; byIp: number }> {
  const since = windowStart();

  const [byEmail, byIp] = await Promise.all([
    prisma.loginAttempt.count({
      where: { email, success: false, createdAt: { gte: since } },
    }),
    ip
      ? prisma.loginAttempt.count({
          where: { ip, success: false, createdAt: { gte: since } },
        })
      : Promise.resolve(0),
  ]);

  return { byEmail, byIp };
}

export async function isLoginBlocked(
  email: string,
  ip: string | null,
): Promise<boolean> {
  const counts = await countRecentFailures(email, ip);
  return (
    counts.byEmail >= LOGIN_MAX_FAILED_ATTEMPTS ||
    counts.byIp >= LOGIN_MAX_FAILED_ATTEMPTS_BY_IP
  );
}

export async function recordLoginAttempt(
  email: string,
  ip: string | null,
  success: boolean,
): Promise<void> {
  await prisma.loginAttempt.create({
    data: { email, ip, success },
  });

  // Opportunistic cleanup: prune attempts older than two windows.
  const pruneBefore = new Date(Date.now() - LOGIN_WINDOW_SECONDS * 2 * 1000);
  await prisma.loginAttempt.deleteMany({
    where: { createdAt: { lt: pruneBefore } },
  });
}

export { LOGIN_MAX_FAILED_ATTEMPTS };
