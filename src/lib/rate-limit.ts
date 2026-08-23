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
 * Every dimension is *attributable*: a counter only ever blocks the identifier
 * that produced the failures. There is deliberately NO deployment-wide counter
 * — see `isLoginBlocked` and docs/SECURITY.md §2.2.
 *
 * Legitimate users are never permanently blocked: the counter resets once
 * the window passes. Passwords are never stored — only the outcome flag.
 */

/** Value used when no client IP can be established. Never rate-limited on. */
export const UNKNOWN_CLIENT_IP = "unknown";

export interface ClientIp {
  /** Resolved address, or UNKNOWN_CLIENT_IP when undeterminable. */
  value: string;
  /**
   * True only when `value` really identifies a single client. The per-IP
   * limit is applied (and the value persisted) only in that case.
   */
  trusted: boolean;
}

/**
 * Number of trusted reverse proxies in front of the app (`TRUSTED_PROXY_HOPS`,
 * default 0). Read per call so deployments — and tests — can change it without
 * reloading the module.
 */
function trustedProxyHops(): number {
  const parsed = Number.parseInt(process.env.TRUSTED_PROXY_HOPS ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }
  return parsed;
}

function isIpv4(value: string): boolean {
  const parts = value.split(".");
  return (
    parts.length === 4 &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  );
}

function isIpv6(value: string): boolean {
  const address = value.split("%")[0] ?? "";
  if (!address.includes(":")) return false;

  const halves = address.split("::");
  if (halves.length > 2) return false;

  const parseGroups = (chunk: string): string[] | null => {
    if (chunk === "") return [];
    const groups = chunk.split(":");
    return groups.some((group) => group === "") ? null : groups;
  };

  const head = parseGroups(halves[0] ?? "");
  const tail = halves.length === 2 ? parseGroups(halves[1] ?? "") : [];
  if (!head || !tail) return false;

  const groups = [...head, ...tail];
  const last = groups[groups.length - 1];
  const hasEmbeddedIpv4 = last !== undefined && last.includes(".");
  if (hasEmbeddedIpv4 && !isIpv4(last)) return false;

  const hexGroups = hasEmbeddedIpv4 ? groups.slice(0, -1) : groups;
  if (!hexGroups.every((group) => /^[0-9a-fA-F]{1,4}$/.test(group))) {
    return false;
  }

  // An embedded IPv4 literal occupies two 16-bit groups.
  const size = groups.length + (hasEmbeddedIpv4 ? 1 : 0);
  // "::" must stand for at least one omitted group.
  return halves.length === 2 ? size <= 7 : size === 8;
}

/**
 * Accepts an address only if it really looks like an IP. Also tolerates the
 * `[v6]:port` / `v4:port` shapes some proxies emit.
 */
function normalizeIp(raw: string): string | null {
  let value = raw.trim();
  if (value === "") return null;

  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(value);
  if (bracketed) {
    value = bracketed[1] ?? "";
  } else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(value)) {
    value = value.split(":")[0] ?? "";
  }

  if (isIpv4(value) || isIpv6(value)) {
    return value.toLowerCase();
  }
  return null;
}

/**
 * IP of the actual TCP connection, when the runtime exposes it.
 *
 * Limitation: the Next.js 14 App Router does not give route handlers access to
 * the socket. `NextRequest.ip` is only populated when the hosting adapter fills
 * it in (e.g. Vercel), and it is never client-settable. On a self-hosted
 * `next start` there is no reliable connection IP at all — hence the sentinel.
 */
function connectionIp(request: Request): string | null {
  const candidate = (request as Request & { ip?: unknown }).ip;
  return typeof candidate === "string" ? normalizeIp(candidate) : null;
}

/**
 * Resolves the client IP used for rate limiting.
 *
 * `x-forwarded-for` is attacker-controlled unless a reverse proxy we trust
 * rewrote it, so it is only read when `TRUSTED_PROXY_HOPS >= 1`:
 *   - 0 (default) → the header is ignored entirely.
 *   - N           → each trusted proxy appends the peer it received the request
 *                   from, so the outermost one wrote the real client address at
 *                   `chain[chain.length - N]` (Express `trust proxy = N`
 *                   semantics). Everything to its left is client-supplied and
 *                   is never selected.
 *
 * When nothing can be established the sentinel is returned with
 * `trusted: false` and the per-IP limit is skipped — an undifferentiated
 * fallback bucket must never become a global login kill switch. The per-e-mail
 * limit still applies. See docs/SECURITY.md.
 */
export function getClientIp(request: Request): ClientIp {
  const hops = trustedProxyHops();

  if (hops > 0) {
    const forwarded = request.headers.get("x-forwarded-for");
    if (forwarded) {
      const chain = forwarded
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry !== "");
      const index = chain.length - hops;
      if (index >= 0) {
        const candidate = normalizeIp(chain[index] ?? "");
        if (candidate) {
          return { value: candidate, trusted: true };
        }
      }
    }
  }

  const connection = connectionIp(request);
  if (connection) {
    return { value: connection, trusted: true };
  }

  return { value: UNKNOWN_CLIENT_IP, trusted: false };
}

/** Only a trusted, differentiated address may drive the per-IP limit. */
function limitableIp(ip: ClientIp | null): string | null {
  return ip && ip.trusted ? ip.value : null;
}

function windowStart(): Date {
  return new Date(Date.now() - LOGIN_WINDOW_SECONDS * 1000);
}

export async function countRecentFailures(
  email: string,
  ip: ClientIp | null,
): Promise<{ byEmail: number; byIp: number }> {
  const since = windowStart();
  const trackedIp = limitableIp(ip);

  const [byEmail, byIp] = await Promise.all([
    prisma.loginAttempt.count({
      where: { email, success: false, createdAt: { gte: since } },
    }),
    trackedIp
      ? prisma.loginAttempt.count({
          where: { ip: trackedIp, success: false, createdAt: { gte: since } },
        })
      : Promise.resolve(0),
  ]);

  return { byEmail, byIp };
}

/**
 * Decides whether the request must be rejected *before* any password hashing.
 *
 * Two ceilings, both *attributable* — each one only ever blocks the identifier
 * that actually produced the failures:
 *   - per e-mail (default 5): classic per-account brute force.
 *   - per IP (default 20): one noisy client spraying many accounts. Applies
 *     only when a trusted client IP could be established, so it is inert on a
 *     self-hosted deployment without `TRUSTED_PROXY_HOPS`.
 *
 * There is intentionally NO deployment-wide counter. A ceiling on "all recent
 * failures regardless of e-mail and IP" is reachable by any anonymous caller —
 * a fresh random e-mail per request needs no valid account and never touches
 * the per-e-mail counter — and once tripped it denies login to every tenant for
 * a whole window. Blocked requests are also free (they never reach
 * `recordLoginAttempt`), so the attacker can hold the block open indefinitely
 * at negligible cost. That is a kill switch, not a rate limit.
 *
 * The CPU-exhaustion risk that motivated the global ceiling is handled at its
 * real source instead: `src/lib/password.ts` caps concurrent bcrypt work and
 * applies bounded back-pressure. See docs/SECURITY.md §2.2.
 *
 * Callers MUST still run this before `verifyPassword`: an attributable block
 * should not pay for hashing it already knows it will discard.
 */
export async function isLoginBlocked(
  email: string,
  ip: ClientIp | null,
): Promise<boolean> {
  const counts = await countRecentFailures(email, ip);
  return (
    counts.byEmail >= LOGIN_MAX_FAILED_ATTEMPTS ||
    counts.byIp >= LOGIN_MAX_FAILED_ATTEMPTS_BY_IP
  );
}

export async function recordLoginAttempt(
  email: string,
  ip: ClientIp | null,
  success: boolean,
): Promise<void> {
  await prisma.loginAttempt.create({
    // The sentinel is stored as NULL so the table never accumulates a single
    // undifferentiated bucket that a future counter could block on.
    data: { email, ip: limitableIp(ip), success },
  });

  // Opportunistic cleanup: prune attempts older than two windows.
  const pruneBefore = new Date(Date.now() - LOGIN_WINDOW_SECONDS * 2 * 1000);
  await prisma.loginAttempt.deleteMany({
    where: { createdAt: { lt: pruneBefore } },
  });
}

export { LOGIN_MAX_FAILED_ATTEMPTS, LOGIN_MAX_FAILED_ATTEMPTS_BY_IP };
