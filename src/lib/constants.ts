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
