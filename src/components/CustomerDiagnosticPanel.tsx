"use client";

import { useState } from "react";
import { StatusPill, type StatusTone } from "./StatusPill";

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
  /**
   * Código cru de tecnologia do provider.
   *
   * Renderizado como código, sem tradução: o OpenAPI CallCenter declara
   * `tecnologia` como inteiro e não documenta o que cada valor significa.
   * Exibir "Fibra" sem base seria informação inventada numa tela que o
   * técnico usa para decidir o que fazer.
   */
  technology?: string | null;
  serverMaintenance?: boolean | null;
}

/**
 * Tom por estado de conectividade.
 *
 * UNKNOWN tem tom PRÓPRIO e neutro, nunca o de OFFLINE: erro de integração
 * não é cliente sem sinal. Confundir os dois manda o técnico investigar um
 * problema de rede que não existe.
 */
const STATUS_TONES: Record<string, StatusTone> = {
  ONLINE: "success",
  OFFLINE: "danger",
  UNKNOWN: "neutral",
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
      className="rounded-2xl border border-border bg-surface p-5 shadow-sm"
      data-testid="diagnostic-panel"
    >
      <h2 className="mb-3 text-base font-semibold text-fg">
        Diagnóstico do cliente
      </h2>

      {failure && (
        <div
          role="alert"
          data-testid="diagnostic-failure"
          className="mb-3 rounded-lg border border-warning-border bg-warning-bg px-3 py-2 text-sm text-warning-fg"
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
            <dt className="text-fg-muted">Conectividade</dt>
            <dd>
              <StatusPill
                data-testid="diagnostic-status"
                tone={
                  STATUS_TONES[diagnostic.connectivityStatus] ??
                  STATUS_TONES.UNKNOWN
                }
                label={statusLabel(diagnostic.connectivityStatus)}
              />
            </dd>
          </div>
          <div className="flex items-center justify-between gap-3">
            <dt className="text-fg-muted">Última atualização</dt>
            <dd
              data-testid="diagnostic-observed-at"
              className="font-medium text-fg"
            >
              {formatTime(diagnostic.observedAt)}
            </dd>
          </div>
          {diagnostic.technology != null && (
            <div className="flex items-center justify-between gap-3">
              <dt className="text-fg-muted">Tecnologia</dt>
              <dd
                data-testid="diagnostic-technology"
                className="font-medium text-fg"
              >
                {/* Código do provider, sem tradução — ver DiagnosticView. */}
                código {diagnostic.technology}
              </dd>
            </div>
          )}
          {diagnostic.serverMaintenance != null && (
            <div className="flex items-center justify-between gap-3">
              <dt className="text-fg-muted">Servidor</dt>
              <dd
                data-testid="diagnostic-maintenance"
                className={
                  diagnostic.serverMaintenance
                    ? "font-semibold text-warning-fg"
                    : "font-medium text-fg"
                }
              >
                {diagnostic.serverMaintenance
                  ? "Em manutenção"
                  : "Sem manutenção informada"}
              </dd>
            </div>
          )}
          <div className="flex items-center justify-between gap-3">
            <dt className="text-fg-muted">Fonte</dt>
            {/* The provider label is what the SERVER resolved, so mock data is
                never presented as if it came from a real ERP. */}
            <dd className="font-medium text-fg">
              {providerLabel(diagnostic.provider)}
            </dd>
          </div>
        </dl>
      ) : (
        !failure && (
          <p className="text-sm text-fg-muted">
            Nenhum diagnóstico registrado para este cliente.
          </p>
        )
      )}

      <button
        type="button"
        onClick={() => void refresh()}
        disabled={loading}
        data-testid="diagnostic-refresh"
        className="mt-4 w-full rounded-lg border border-input-border px-3 py-2.5 text-sm font-semibold text-fg-secondary transition-colors hover:bg-surface-subtle disabled:cursor-not-allowed disabled:opacity-60"
      >
        {loading ? "Atualizando..." : "Atualizar diagnóstico"}
      </button>
    </div>
  );
}
