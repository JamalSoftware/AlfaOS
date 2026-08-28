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

/**
 * QUAL unique estourou.
 *
 * Uma tabela com mais de uma unique produz o mesmo `P2002` para todas, e a
 * mensagem ao técnico muda conforme a coluna: "serial já cadastrado" e "esta
 * foto já identifica outro equipamento" são problemas diferentes com saídas
 * diferentes. O `meta.target` do Prisma traz as colunas do índice violado.
 */
export function uniqueTargetIncludes(error: unknown, column: string): boolean {
  if (!isUniqueConstraintError(error)) return false;
  const target = (error as { meta?: { target?: unknown } }).meta?.target;
  if (Array.isArray(target)) {
    return target.some((c) => String(c).includes(column));
  }
  // Alguns conectores devolvem o NOME do índice em vez das colunas.
  return typeof target === "string" && target.includes(column);
}
