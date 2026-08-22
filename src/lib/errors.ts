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
