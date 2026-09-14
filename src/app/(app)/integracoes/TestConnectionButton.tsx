"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface TestResult {
  ok: boolean;
  provider: string;
  latencyMs: number;
  message: string;
}

export function TestConnectionButton({
  currentProvider,
  providers,
}: {
  currentProvider: string;
  /**
   * Os provedores oferecidos, decididos no SERVIDOR. Em produção o Mock não
   * está entre eles (RC-OPS-03) — e a lista não pode ser montada aqui, porque
   * o ambiente que importa é o do servidor, não o do navegador.
   */
  providers: { value: string; label: string }[];
}) {
  const router = useRouter();
  const [provider, setProvider] = useState(
    providers.some((p) => p.value === currentProvider)
      ? currentProvider
      : (providers[0]?.value ?? currentProvider),
  );
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [candidate, setCandidate] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleTest() {
    setLoading(true);
    setResult(null);
    setCandidate(false);
    setError(null);
    try {
      const res = await fetch("/api/integrations/test-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider }),
      });
      const payload = await res.json();
      if (!res.ok) {
        setError(payload?.error ?? "Falha ao testar conexão.");
        return;
      }
      setResult(payload?.data?.result ?? null);
      setCandidate(payload?.data?.testedActiveProvider === false);
      router.refresh();
    } catch {
      setError("Erro de conexão. Tente novamente.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <label
        htmlFor="provider"
        className="mb-1 block text-sm font-medium text-fg-secondary"
      >
        Provedor
      </label>
      <select
        id="provider"
        value={provider}
        onChange={(e) => setProvider(e.target.value)}
        className="mb-3 w-full max-w-xs rounded-lg border border-input-border px-3 py-2 text-sm text-fg focus:border-focus focus:outline-none focus:ring-2 focus:ring-focus-soft"
      >
        {providers.map((p) => (
          <option key={p.value} value={p.value}>
            {p.label}
          </option>
        ))}
      </select>
      {provider !== currentProvider && (
        <p className="mb-3 text-xs text-fg-muted" data-testid="test-candidate-hint">
          Diagnóstico de um provedor candidato. Testar <strong>não</strong>{" "}
          altera o ERP ativo da empresa e não apaga credencial nenhuma.
        </p>
      )}

      <button
        type="button"
        onClick={handleTest}
        disabled={loading}
        className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-fg transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60"
      >
        {loading ? "Testando..." : "Testar conexão"}
      </button>

      {result && (
        <div
          className={`mt-4 rounded-lg border px-3 py-2 text-sm ${
            result.ok
              ? "border-success-border bg-success-bg text-success-fg"
              : "border-danger-border bg-danger-bg text-danger-fg"
          }`}
        >
          <p className="font-medium">
            {result.ok ? "Conexão OK" : "Falha na conexão"} (
            {result.provider}, {result.latencyMs}ms)
          </p>
          <p className="mt-1">{result.message}</p>
        </div>
      )}

      {candidate && (
        <div
          role="status"
          data-testid="test-candidate-result"
          className="mt-4 rounded-lg border border-border bg-surface-muted px-3 py-2 text-sm text-fg-secondary"
        >
          Resultado de um provedor candidato. O ERP ativo da empresa continua o
          mesmo — trocá-lo é uma ação separada.
        </div>
      )}

      {error && (
        <div className="mt-4 rounded-lg border border-danger-border bg-danger-bg px-3 py-2 text-sm text-danger-fg">
          {error}
        </div>
      )}
    </div>
  );
}
