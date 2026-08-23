"use client";

import { useState } from "react";

/**
 * Only domain fields. Labels are derived here rather than carried in the
 * payload so the server-rendered snapshot and the one returned by a refresh
 * render identically — an earlier version passed labels from the page and got
 * a blank badge after every refresh, because the API returns domain data.
 */
export interface DiagnosticView {
  connectivityStatus: "ONLINE" | "OFFLINE" | "UNKNOWN";
  observedAt: string;
  provider: string;
}

const STATUS_STYLES: Record<string, string> = {
  ONLINE: "bg-emerald-100 text-emerald-800",
  OFFLINE: "bg-red-100 text-red-800",
  UNKNOWN: "bg-slate-100 text-slate-700",
};

const STATUS_LABELS: Record<string, string> = {
  ONLINE: "Online",
  OFFLINE: "Offline",
  UNKNOWN: "Desconhecido",
};

/** Mock data must never be presented as if it came from a real ERP. */
const PROVIDER_LABELS: Record<string, string> = {
  MOCK: "Mock ERP",
  RECEITANET: "ReceitaNet",
};

function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? STATUS_LABELS.UNKNOWN;
}

function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

function formatTime(iso: string): string {
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

/**
 * "Diagnóstico do cliente" — read-only view of the last known connectivity,
 * plus a manual refresh.
 *
 * The whole point of the layout is the distinction the domain enforces:
 * "what we know about the customer" and "could we reach the ERP just now" are
 * shown as two separate things. A failed refresh renders a warning ABOVE the
 * preserved snapshot; it never rewrites the status badge. A technician must
 * never read "Offline" because our integration was down.
 */
export function CustomerDiagnosticPanel({
  orderId,
  initialDiagnostic,
}: {
  orderId: string;
  initialDiagnostic: DiagnosticView | null;
}) {
  const [diagnostic, setDiagnostic] = useState(initialDiagnostic);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function refresh() {
    // Guards the keyboard path too, not just the disabled attribute.
    if (loading) return;
    setLoading(true);
    setFailure(null);
    try {
      const res = await fetch(`/api/service-orders/${orderId}/diagnostic`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        setFailure("Não foi possível consultar o sistema externo.");
        return;
      }
      const data = payload?.data;
      // The snapshot comes back even on failure — assign it either way so a
      // first-ever successful read still populates the panel.
      if (data?.diagnostic) setDiagnostic(data.diagnostic);
      if (!data?.ok) {
        setFailure(data?.errorMessage ?? "Não foi possível atualizar o diagnóstico.");
      }
    } catch {
      setFailure("Não foi possível consultar o sistema externo.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
      data-testid="diagnostic-panel"
    >
      <h2 className="mb-3 text-base font-semibold text-slate-900">
        Diagnóstico do cliente
      </h2>

      {failure && (
        <div
          role="alert"
          data-testid="diagnostic-failure"
          className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
        >
          {failure}
          {diagnostic && (
            <span className="mt-1 block">
              Último estado conhecido: {statusLabel(diagnostic.connectivityStatus)} em{" "}
              {formatTime(diagnostic.observedAt)}.
            </span>
          )}
        </div>
      )}

      {diagnostic ? (
        <dl className="space-y-2 text-sm">
          <div className="flex items-center justify-between gap-3">
            <dt className="text-slate-500">Conectividade</dt>
            <dd>
              <span
                data-testid="diagnostic-status"
                className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
                  STATUS_STYLES[diagnostic.connectivityStatus] ??
                  STATUS_STYLES.UNKNOWN
                }`}
              >
                {statusLabel(diagnostic.connectivityStatus)}
              </span>
            </dd>
          </div>
          <div className="flex items-center justify-between gap-3">
            <dt className="text-slate-500">Última atualização</dt>
            <dd
              data-testid="diagnostic-observed-at"
              className="font-medium text-slate-900"
            >
              {formatTime(diagnostic.observedAt)}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-3">
            <dt className="text-slate-500">Fonte</dt>
            {/* The provider label is what the SERVER resolved, so mock data is
                never presented as if it came from a real ERP. */}
            <dd className="font-medium text-slate-900">
              {providerLabel(diagnostic.provider)}
            </dd>
          </div>
        </dl>
      ) : (
        !failure && (
          <p className="text-sm text-slate-500">
            Nenhum diagnóstico registrado para este cliente.
          </p>
        )
      )}

      <button
        type="button"
        onClick={() => void refresh()}
        disabled={loading}
        data-testid="diagnostic-refresh"
        className="mt-4 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {loading ? "Atualizando..." : "Atualizar diagnóstico"}
      </button>
    </div>
  );
}
