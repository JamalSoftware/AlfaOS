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
}: {
  currentProvider: string;
}) {
  const router = useRouter();
  const [provider, setProvider] = useState(currentProvider);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [invalidated, setInvalidated] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleTest() {
    setLoading(true);
    setResult(null);
    setInvalidated(false);
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
      setInvalidated(payload?.data?.invalidatedCredential === true);
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
        className="mb-1 block text-sm font-medium text-slate-700"
      >
        Provedor
      </label>
      <select
        id="provider"
        value={provider}
        onChange={(e) => setProvider(e.target.value)}
        className="mb-3 w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100"
      >
        <option value="MOCK">Mock ERP</option>
        <option value="RECEITANET">ReceitaNet</option>
      </select>
      {provider !== currentProvider && (
        <p className="mb-3 text-xs text-amber-700">
          Trocar o provedor apaga a credencial configurada — ela é vinculada ao
          provedor e deixa de ser utilizável. Será necessário configurar o token
          novamente.
        </p>
      )}

      <button
        type="button"
        onClick={handleTest}
        disabled={loading}
        className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {loading ? "Testando..." : "Testar conexão"}
      </button>

      {result && (
        <div
          className={`mt-4 rounded-lg border px-3 py-2 text-sm ${
            result.ok
              ? "border-emerald-200 bg-emerald-50 text-emerald-700"
              : "border-red-200 bg-red-50 text-red-700"
          }`}
        >
          <p className="font-medium">
            {result.ok ? "Conexão OK" : "Falha na conexão"} (
            {result.provider}, {result.latencyMs}ms)
          </p>
          <p className="mt-1">{result.message}</p>
        </div>
      )}

      {invalidated && (
        <div
          role="alert"
          className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
        >
          A credencial anterior foi removida porque o provedor mudou. Configure
          um novo token para este provedor antes de usar a integração.
        </div>
      )}

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}
    </div>
  );
}
