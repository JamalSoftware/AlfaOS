/**
 * DomainError
 *
 * Business-rule errors with an HTTP status. Thrown by service layers so
 * API routes can translate them into proper HTTP responses without leaking
 * internal details. `runApi` converts them into structured JSON errors.
 */
export class DomainError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "DomainError";
    this.status = status;
  }
}

export function notFound(message: string): DomainError {
  return new DomainError(404, message);
}

export function badRequest(message: string): DomainError {
  return new DomainError(400, message);
}

export function conflict(message: string): DomainError {
  return new DomainError(409, message);
}

export function forbidden(message: string): DomainError {
  return new DomainError(403, message);
}

/**
 * 503 — a operação é legítima, mas um pré-requisito de infraestrutura falhou.
 *
 * Distinto de 500: não houve erro de programação nem estado inválido; algo de
 * que a operação depende está indisponível, e uma nova tentativa pode
 * funcionar.
 */
export function serviceUnavailable(message: string): DomainError {
  return new DomainError(503, message);
}

/**
 * True for Prisma's "Unique constraint failed" (P2002). Used by writes that
 * let the database arbitrate a race instead of checking-then-inserting.
 */
export function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}
