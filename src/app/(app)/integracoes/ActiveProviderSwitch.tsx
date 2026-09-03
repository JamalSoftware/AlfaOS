"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Trocar o ERP ativo da empresa.
 *
 * Controle **separado** do teste de conexão, e é essa separação que a `ERP-1`
 * entrega: até então a troca era efeito colateral de "testar conexão", e um
 * clique de diagnóstico redirecionava todo o atendimento para outro sistema.
 *
 * A confirmação é simples e explícita — nomeia origem e destino. Não se pede
 * que o operador digite segredo: confirmar uma troca não é provar posse de
 * credencial, e transformar o token em senha de confirmação o faria trafegar
 * numa operação que não precisa dele.
 */
export function ActiveProviderSwitch({
  currentProvider,
  options,
}: {
  currentProvider: string;
  options: { value: string; label: string }[];
}) {
  const router = useRouter();
  const [target, setTarget] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const alternatives = options.filter((o) => o.value !== currentProvider);
  const targetLabel = options.find((o) => o.value === target)?.label ?? target;
  const currentLabel =
    options.find((o) => o.value === currentProvider)?.label ?? currentProvider;

  async function handleSwitch() {
    setLoading(true);
    setError(null);
    setDone(null);
    try {
      const res = await fetch("/api/integrations/active-provider", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: target }),
      });
      const payload = await res.json();
      if (!res.ok) {
        setError(payload?.error ?? "Não foi possível alterar o ERP ativo.");
        return;
      }
      setDone(targetLabel);
      setConfirming(false);
      setTarget("");
      router.refresh();
    } catch {
      setError("Erro de conexão. Tente novamente.");
    } finally {
      setLoading(false);
    }
  }

  if (alternatives.length === 0) {
    return (
      <p className="text-xs text-fg-muted" data-testid="switch-unavailable">
        Nenhum outro provedor disponível para esta empresa.
      </p>
    );
  }

  return (
    <div data-testid="active-provider-switch">
      <label
        htmlFor="switch-target"
        className="mb-1 block text-sm font-medium text-fg-secondary"
      >
        Alterar ERP ativo para
      </label>
      <select
        id="switch-target"
        value={target}
        onChange={(e) => {
          setTarget(e.target.value);
          setConfirming(false);
          setDone(null);
        }}
        data-testid="switch-target"
        className="mb-3 w-full max-w-xs rounded-lg border border-input-border px-3 py-2 text-sm text-fg focus:border-focus focus:outline-none focus:ring-2 focus:ring-focus-soft"
      >
        <option value="">Selecione…</option>
        {alternatives.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>

      {!confirming ? (
        <button
          type="button"
          disabled={!target || loading}
          onClick={() => setConfirming(true)}
          data-testid="switch-start"
          className="rounded-lg border border-border px-4 py-2 text-sm font-semibold text-fg transition-colors hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-60"
        >
          Alterar ERP ativo
        </button>
      ) : (
        <div
          role="alert"
          data-testid="switch-confirm"
          className="rounded-lg border border-warning-border bg-warning-bg px-3 py-3 text-sm text-warning-fg"
        >
          <p className="font-medium">
            Você está alterando o ERP utilizado pela empresa de {currentLabel}{" "}
            para {targetLabel}.
          </p>
          <p className="mt-1 text-xs">
            As credenciais de {currentLabel} são preservadas — voltar não exige
            configurar o token de novo.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={handleSwitch}
              disabled={loading}
              data-testid="switch-confirm-yes"
              className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-fg transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loading ? "Alterando..." : "Confirmar"}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={loading}
              className="rounded-lg border border-border px-4 py-2 text-sm font-semibold text-fg transition-colors hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-60"
            >
              Cancelar
            </button>
          </div>
        </div>
      )}

      {done && (
        <div
          data-testid="switch-done"
          className="mt-3 rounded-lg border border-success-border bg-success-bg px-3 py-2 text-sm text-success-fg"
        >
          ERP ativo alterado para {done}.
        </div>
      )}

      {error && (
        <div
          data-testid="switch-error"
          className="mt-3 rounded-lg border border-danger-border bg-danger-bg px-3 py-2 text-sm text-danger-fg"
        >
          {error}
        </div>
      )}
    </div>
  );
}
