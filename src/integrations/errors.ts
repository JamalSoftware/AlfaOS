/**
 * Normalized integration failures.
 *
 * The domain must never see a provider's HTTP status. `401`, `429` and a
 * socket timeout are three different operational situations, and each ERP
 * spells them differently — so adapters translate at their own boundary and
 * everything above works with this closed set.
 *
 * The single most important consequence: NONE of these is a customer state.
 * An integration failure says something about US (or about the provider), not
 * about whether the customer's link is up. Turning any of them into OFFLINE
 * would dispatch a technician over an expired token.
 */
export type IntegrationErrorCode =
  /** Credentials rejected or missing. Operator action needed. */
  | "AUTHENTICATION_FAILED"
  /** Provider unreachable, 5xx, connection refused, DNS failure. */
  | "UPSTREAM_UNAVAILABLE"
  /** Provider explicitly throttled us. */
  | "RATE_LIMITED"
  /** This provider does not implement this capability at all. */
  | "NOT_SUPPORTED"
  /** Provider answered, but the payload could not be trusted or parsed. */
  | "INVALID_RESPONSE"
  /** Provider answered clearly that it does not know this customer. */
  | "CUSTOMER_NOT_FOUND"
  /** Our own deadline elapsed before the provider answered. */
  | "TIMEOUT";

/**
 * Operator-facing messages. Deliberately vague about internals: they are
 * rendered in the UI, so they must not leak a URL, a header, a token or a
 * provider stack trace.
 */
const MESSAGES: Record<IntegrationErrorCode, string> = {
  AUTHENTICATION_FAILED:
    "Não foi possível autenticar no sistema externo. Verifique a configuração da integração.",
  UPSTREAM_UNAVAILABLE: "O sistema externo não está respondendo no momento.",
  RATE_LIMITED:
    "O sistema externo recusou a consulta por excesso de requisições. Tente novamente em instantes.",
  NOT_SUPPORTED: "Este provedor não oferece consulta de diagnóstico.",
  INVALID_RESPONSE: "O sistema externo respondeu em formato inesperado.",
  CUSTOMER_NOT_FOUND: "Cliente não localizado no sistema externo.",
  TIMEOUT: "A consulta ao sistema externo excedeu o tempo limite.",
};

export class IntegrationError extends Error {
  readonly code: IntegrationErrorCode;
  readonly provider: string;

  constructor(code: IntegrationErrorCode, provider: string, detail?: string) {
    // `detail` is for server logs only — it is never the message shown to a
    // user, precisely so an adapter can be verbose without risking a leak.
    super(detail ? `${code}: ${detail}` : code);
    this.name = "IntegrationError";
    this.code = code;
    this.provider = provider;
  }

  /** Safe to render. Never contains provider internals. */
  get userMessage(): string {
    return MESSAGES[this.code];
  }
}

export function isIntegrationError(error: unknown): error is IntegrationError {
  return error instanceof IntegrationError;
}
