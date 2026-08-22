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
 * Ceiling on ALL recent failed logins, regardless of e-mail or IP.
 *
 * Last line of defence against an anonymous flood that evades both other
 * limits (a fresh random e-mail per request keeps the per-e-mail counter at 0,
 * and the per-IP counter is inert whenever no trusted client IP can be
 * established — the default on self-hosted `next start`). Without it every
 * such request pays a full bcrypt (cost 12, ~350ms of *synchronous* CPU in
 * `bcryptjs`), which saturates the Node event loop for every tenant.
 *
 * Default 200 = 10x the per-IP limit and 40x the per-e-mail limit, i.e. 200
 * failed logins across the whole deployment inside LOGIN_WINDOW_SECONDS
 * (900s). See docs/SECURITY.md §2.2 for the trade-off analysis.
 */
export const LOGIN_MAX_FAILED_ATTEMPTS_GLOBAL = Number(
  process.env.LOGIN_MAX_FAILED_ATTEMPTS_GLOBAL ?? 200,
);
