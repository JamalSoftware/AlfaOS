import type { ConnectivityStatus, ERPProvider } from "@prisma/client";
import { prisma } from "./prisma";
import { logAudit } from "./audit";
import { notFound } from "./errors";
import { getERPAdapter } from "@/integrations";
import {
  supportsDiagnostics,
  withIntegrationTimeout,
  type ERPCustomerRef,
} from "@/integrations/diagnostics";
import {
  IntegrationError,
  isIntegrationError,
  type IntegrationErrorCode,
} from "@/integrations/errors";

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/**
 * What the UI renders. Deliberately narrow: no raw provider payload ever
 * reaches this far, so the screen cannot accidentally display a field nobody
 * validated.
 */
export interface CustomerDiagnostic {
  connectivityStatus: ConnectivityStatus;
  observedAt: Date;
  sourceUpdatedAt: Date | null;
  provider: ERPProvider;
}

/**
 * Result of a refresh attempt.
 *
 * `snapshot` is the last VALID observation and is present even when the
 * refresh itself failed — that is what lets the UI say "could not update; last
 * known: Online at 08:42" instead of collapsing to a wrong state.
 */
export interface DiagnosticRefreshResult {
  ok: boolean;
  snapshot: CustomerDiagnostic | null;
  /** Only set when `ok` is false. Safe to render. */
  errorCode?: IntegrationErrorCode;
  errorMessage?: string;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Last known diagnostic for a customer, or null if none was ever recorded.
 *
 * Tenant-filtered in SQL rather than reached through the customer relation, so
 * a mismatched company returns nothing instead of relying on FK navigation
 * being correct — same rule as every other child read in this codebase.
 */
export async function getCustomerDiagnostic(
  companyId: string,
  customerId: string,
): Promise<CustomerDiagnostic | null> {
  const snapshot = await prisma.customerDiagnosticSnapshot.findFirst({
    where: { companyId, customerId },
    orderBy: { observedAt: "desc" },
  });
  if (!snapshot) return null;
  return {
    connectivityStatus: snapshot.connectivityStatus,
    observedAt: snapshot.observedAt,
    sourceUpdatedAt: snapshot.sourceUpdatedAt,
    provider: snapshot.externalProvider,
  };
}

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

/**
 * Which provider this company's diagnostics come from.
 *
 * Read from the company's own integration row, never from the request: a
 * caller must not be able to pick which ERP answers for a tenant, and the
 * value is what the UI labels the result with. A company with no integration
 * configured has no provider, which is a "not supported" state rather than a
 * silent fallback to the mock — labelling mock data as if it came from a real
 * ERP is precisely the confusion this avoids.
 */
async function resolveProvider(companyId: string): Promise<ERPProvider | null> {
  const integration = await prisma.eRPIntegration.findFirst({
    where: { companyId },
    select: { provider: true, enabled: true },
  });
  if (!integration || !integration.enabled) return null;
  return integration.provider;
}

/**
 * Queries the provider and, ONLY on a valid answer, records it.
 *
 * The central invariant of this module: an integration failure is a statement
 * about the integration, never about the customer. Every failure path returns
 * `ok: false` with the previous snapshot untouched. Nothing here can write
 * OFFLINE as a consequence of an error — `OFFLINE` is only ever persisted when
 * a provider positively reported it.
 *
 * A failed refresh is therefore non-destructive by construction, which is what
 * makes it safe for the technician's screen to fall back to "last known".
 */
export async function refreshCustomerDiagnostic(
  companyId: string,
  actorUserId: string,
  customerId: string,
): Promise<DiagnosticRefreshResult> {
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, companyId },
    select: {
      id: true,
      name: true,
      document: true,
      externalId: true,
    },
  });
  if (!customer) {
    throw notFound("Cliente não encontrado.");
  }

  const provider = await resolveProvider(companyId);
  const previous = await getCustomerDiagnostic(companyId, customerId);

  if (!provider) {
    return {
      ok: false,
      snapshot: previous,
      errorCode: "NOT_SUPPORTED",
      errorMessage:
        "Nenhuma integração de ERP está habilitada para esta empresa.",
    };
  }

  const adapter = getERPAdapter(provider);
  if (!supportsDiagnostics(adapter)) {
    return {
      ok: false,
      snapshot: previous,
      errorCode: "NOT_SUPPORTED",
      errorMessage: new IntegrationError("NOT_SUPPORTED", provider).userMessage,
    };
  }

  const ref: ERPCustomerRef = {
    externalId: customer.externalId,
    document: customer.document,
    name: customer.name,
  };

  let observation;
  try {
    // The deadline lives here, not inside the adapter: applied at the call
    // site it binds every adapter, including ones written later that forget.
    observation = await withIntegrationTimeout(
      adapter.fetchCustomerConnectivity(ref),
      provider,
    );
  } catch (error) {
    const normalized = isIntegrationError(error)
      ? error
      : // An adapter that throws something unexpected is an adapter bug, not a
        // customer state. It is normalized here rather than propagated so a
        // stray provider error can never escape as a 500 carrying a URL or
        // token in its message.
        new IntegrationError(
          "INVALID_RESPONSE",
          provider,
          error instanceof Error ? error.message : String(error),
        );

    // Structured server-side observability. Never the payload, never secrets,
    // never the customer's document — provider, tenant, operation, outcome.
    console.warn(
      `[diagnostics] provider=${provider} company=${companyId} op=fetchCustomerConnectivity outcome=${normalized.code}`,
    );

    return {
      ok: false,
      // Preserved on purpose: the previous observation is still the best true
      // thing we know.
      snapshot: previous,
      errorCode: normalized.code,
      errorMessage: normalized.userMessage,
    };
  }

  const observedAt = new Date();

  /**
   * Stale-write protection.
   *
   * Two concurrent refreshes can return out of order. When the provider tells
   * us when the state changed, that is the only reliable way to order them, so
   * an older `sourceUpdatedAt` never overwrites a newer one. When it does not
   * (both null), there is nothing to order by and last-write-wins is honest —
   * inventing an ordering from our own receive time would be fabricating
   * precision the provider never gave us.
   */
  const existing = await prisma.customerDiagnosticSnapshot.findUnique({
    where: {
      companyId_customerId_externalProvider: {
        companyId,
        customerId,
        externalProvider: provider,
      },
    },
  });

  const wouldRegress =
    existing?.sourceUpdatedAt &&
    observation.sourceUpdatedAt &&
    observation.sourceUpdatedAt < existing.sourceUpdatedAt;

  if (wouldRegress) {
    return {
      ok: true,
      snapshot: {
        connectivityStatus: existing.connectivityStatus,
        observedAt: existing.observedAt,
        sourceUpdatedAt: existing.sourceUpdatedAt,
        provider,
      },
    };
  }

  const saved = await prisma.customerDiagnosticSnapshot.upsert({
    where: {
      companyId_customerId_externalProvider: {
        companyId,
        customerId,
        externalProvider: provider,
      },
    },
    create: {
      companyId,
      customerId,
      externalProvider: provider,
      connectivityStatus: observation.status,
      observedAt,
      sourceUpdatedAt: observation.sourceUpdatedAt,
    },
    update: {
      connectivityStatus: observation.status,
      observedAt,
      sourceUpdatedAt: observation.sourceUpdatedAt,
    },
  });

  // High-value event only: a manual refresh that actually produced a new
  // observation. Reads that merely render an existing snapshot are not audited
  // — auditing every page view would bury the events that matter in noise.
  // No document, no phone, no payload: provider, customer id and outcome.
  await logAudit({
    companyId,
    userId: actorUserId,
    action: "CUSTOMER_DIAGNOSTIC.REFRESHED",
    entity: "Customer",
    entityId: customerId,
    details: `Diagnóstico atualizado via ${provider}: ${observation.status}`,
  });

  return {
    ok: true,
    snapshot: {
      connectivityStatus: saved.connectivityStatus,
      observedAt: saved.observedAt,
      sourceUpdatedAt: saved.sourceUpdatedAt,
      provider: saved.externalProvider,
    },
  };
}

export const CONNECTIVITY_LABELS: Record<ConnectivityStatus, string> = {
  ONLINE: "Online",
  OFFLINE: "Offline",
  UNKNOWN: "Desconhecido",
};

export const PROVIDER_LABELS: Record<ERPProvider, string> = {
  MOCK: "Mock ERP",
  RECEITANET: "ReceitaNet",
};
