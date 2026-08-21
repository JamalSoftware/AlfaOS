import { jsonError } from "./api";

export const STATE_CHANGING_METHODS = ["POST", "PUT", "PATCH", "DELETE"];

function getOrigin(request: Request): string | null {
  return request.headers.get("origin");
}

/**
 * Same-Origin check for state-changing requests.
 *
 * The app uses a SameSite=Lax session cookie. Browsers always send the
 * `Origin` header on cross-origin state-changing requests, and SameSite=Lax
 * already blocks the cookie on cross-site POST. This check is defense in
 * depth: when an `Origin` header is present it must match the request host.
 *
 * Requests without an `Origin` header (same-origin navigation, curl,
 * server-to-server) are allowed and rely on SameSite + the session cookie.
 */
export function assertSameOrigin(request: Request): Response | null {
  const origin = getOrigin(request);
  if (!origin) {
    return null;
  }

  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return jsonError("Origem inválida.", 403);
  }

  let requestHost: string;
  try {
    requestHost = new URL(request.url).host;
  } catch {
    return jsonError("Requisição inválida.", 400);
  }

  if (originHost !== requestHost) {
    return jsonError("Origem não permitida.", 403);
  }

  return null;
}

export function isStateChangingMethod(method: string): boolean {
  return STATE_CHANGING_METHODS.includes(method.toUpperCase());
}
