import { NextResponse } from "next/server";
import type { AccessProfile } from "@prisma/client";
import { DomainError } from "./errors";

export function jsonOk(data: unknown, status = 200): NextResponse {
  return NextResponse.json({ ok: true, data }, { status });
}

export function jsonError(
  message: string,
  status: number,
  details?: unknown,
): NextResponse {
  return NextResponse.json(
    { ok: false, error: message, ...(details !== undefined ? { details } : {}) },
    { status },
  );
}

/**
 * Rejects a request when the session profile is not allowed.
 * Returns a 403 response or null (when allowed).
 */
export function assertProfile(
  profile: AccessProfile,
  allowed: AccessProfile[],
): NextResponse | null {
  if (!allowed.includes(profile)) {
    return jsonError("Acesso negado.", 403);
  }
  return null;
}

/**
 * Wraps API route handlers with centralized error handling.
 *
 * Internal errors are logged server-side (message only, no secrets, no
 * stack traces exposed to the client) and the client always receives a
 * generic 500 response. Never leaks SQL, Prisma internals or stack traces.
 */
export async function runApi(
  handler: () => Promise<Response>,
): Promise<Response> {
  try {
    return await handler();
  } catch (error) {
    if (error instanceof DomainError) {
      return jsonError(error.message, error.status);
    }
    const message =
      error instanceof Error ? error.message : "Erro desconhecido";
    console.error("[api:error]", message);
    return jsonError("Erro interno do servidor.", 500);
  }
}
