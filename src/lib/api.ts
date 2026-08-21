import { NextResponse } from "next/server";

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
