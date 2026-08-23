import { validateEnv } from "./env";

const env = validateEnv();

export const NODE_ENV = env.nodeEnv;

export const SESSION_COOKIE_NAME =
  process.env.SESSION_COOKIE_NAME ?? "alfaos_session";

export const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;

export const SESSION_SECRET = env.authSecret;

export const LOGIN_MAX_FAILED_ATTEMPTS = Number(
  process.env.LOGIN_MAX_FAILED_ATTEMPTS ?? 5,
);

export const LOGIN_WINDOW_SECONDS = Number(
  process.env.LOGIN_WINDOW_SECONDS ?? 900,
);

export const LOGIN_MAX_FAILED_ATTEMPTS_BY_IP = Number(
  process.env.LOGIN_MAX_FAILED_ATTEMPTS_BY_IP ?? 20,
);

/**
 * `LOGIN_MAX_FAILED_ATTEMPTS_GLOBAL` used to live here: a ceiling on ALL recent
 * failed logins regardless of e-mail and IP. It was removed in
 * v0.2.2-pre-v03-hardening because it was reachable by any anonymous caller
 * (a fresh random e-mail per request needs no valid account) and, once tripped,
 * denied login to every tenant for a whole window — an authentication kill
 * switch, not a rate limit.
 *
 * The CPU-exhaustion risk it was meant to cover is now handled at its source by
 * the bcrypt admission gate in `src/lib/password.ts`
 * (`BCRYPT_MAX_CONCURRENCY` / `BCRYPT_MAX_QUEUE`). The environment variable is
 * no longer read anywhere; leaving it set in a `.env` has no effect.
 * See docs/SECURITY.md §2.2.
 */
