export const SESSION_COOKIE_NAME =
  process.env.SESSION_COOKIE_NAME ?? "alfaos_session";

export const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;

export const SESSION_SECRET = process.env.AUTH_SECRET ?? "";
