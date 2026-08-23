import type { ConnectivityStatus } from "@prisma/client";
import { IntegrationError } from "./errors";

/**
 * Diagnostics capability — kept OUT of `ERPIntegrationContract` on purpose.
 *
 * The base contract is what every adapter must implement (identity, connection
 * test). Diagnostics is something a provider may or may not offer, so folding
 * it in would either force every adapter to stub it or grow the base interface
 * into a grab-bag of unrelated optional methods. A separate capability lets
 * `supportsDiagnostics()` answer "can this provider do it?" honestly, and lets
 * the ReceitaNet adapter declare the capability while refusing every call —
 * which is exactly its real state today.
 */

/** What the caller knows about the customer, in provider-neutral terms. */
export interface ERPCustomerRef {
  /** The provider's own id for this customer, when AlfaOS has one. */
  externalId: string | null;
  document: string | null;
  name: string;
}

/**
 * A provider's answer about connectivity, before it is persisted.
 *
 * `status` is the classification; `sourceUpdatedAt` is only set when the
 * provider actually reports when the state last changed. Adapters must not
 * invent it from the response time — that would make an ordering signal out of
 * a value that carries no ordering information.
 */
export interface ERPConnectivityObservation {
  status: ConnectivityStatus;
  sourceUpdatedAt: Date | null;
}

export interface ERPDiagnosticsCapability {
  /**
   * Reads the customer's current connectivity from the provider.
   *
   * Contract for implementors:
   *  - Return an observation ONLY when the payload is positive evidence of a
   *    state. Anything ambiguous is `UNKNOWN`, which is a real answer.
   *  - Throw `IntegrationError` for everything that is a failure of the
   *    integration rather than a statement about the customer. Never encode a
   *    failure as `OFFLINE`.
   *  - Never throw a raw provider error, a fetch error, or anything carrying a
   *    URL, header or token.
   */
  fetchCustomerConnectivity(
    ref: ERPCustomerRef,
  ): Promise<ERPConnectivityObservation>;
}

export function supportsDiagnostics(
  adapter: unknown,
): adapter is ERPDiagnosticsCapability {
  return (
    typeof adapter === "object" &&
    adapter !== null &&
    typeof (adapter as ERPDiagnosticsCapability).fetchCustomerConnectivity ===
      "function"
  );
}

/**
 * Default deadline for any single provider call, in milliseconds.
 *
 * 8s is well past a healthy ERP round trip and well short of the technician
 * giving up on the screen. It is deliberately OUR deadline, not the provider's:
 * no documented ReceitaNet SLA exists to derive it from, so inventing a
 * tighter number would be false precision and a looser one would let a hung
 * socket hold a request handler.
 */
export const DIAGNOSTIC_TIMEOUT_MS = 8_000;

/**
 * Bounds any capability call in time, whichever adapter implements it.
 *
 * Applied at the CALL SITE rather than inside each adapter so the guarantee is
 * structural: a future adapter cannot forget it, and an adapter that hangs
 * without ever touching the network (a bad `await`, a stalled stream) is
 * caught too. The losing promise is left to settle on its own — there is
 * nothing to cancel safely at this layer, and its result is discarded.
 */
export async function withIntegrationTimeout<T>(
  operation: Promise<T>,
  provider: string,
  timeoutMs: number = DIAGNOSTIC_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new IntegrationError(
                "TIMEOUT",
                provider,
                `sem resposta em ${timeoutMs}ms`,
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
