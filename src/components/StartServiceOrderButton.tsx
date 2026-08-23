"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

interface StartServiceOrderButtonProps {
  orderId: string;
  /**
   * `version` da OS lida por ESTA renderização, enviada como
   * `expectedVersion`. Lida direto da prop (nunca copiada para `useState`):
   * depois de um sucesso o `router.refresh()` re-renderiza o Server Component
   * e a prop chega atualizada — mesmo padrão do `AssignTechnicianForm`.
   */
  version: number;
}

export function StartServiceOrderButton({
  orderId,
  version,
}: StartServiceOrderButtonProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleStart() {
    // Guard against a second click landing while the first request is in
    // flight. The button is disabled below too; this covers the keyboard and
    // any race the disabled attribute does not.
    if (loading) return;

    if (!window.confirm("Deseja iniciar esta Ordem de Serviço?")) {
      return;
    }

    setError(null);
    setLoading(true);
    try {
      const res = await fetch(`/api/service-orders/${orderId}/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedVersion: version }),
      });
      const payload = await res.json();
      if (!res.ok) {
        setError(payload?.error ?? "Falha ao iniciar o atendimento.");
        return;
      }
      router.refresh();
    } catch {
      setError("Erro de conexão. Tente novamente.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-3">
      {error && (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {error}
        </div>
      )}
      <button
        type="button"
        onClick={handleStart}
        disabled={loading}
        className="w-full rounded-xl bg-blue-600 px-4 py-4 text-base font-bold uppercase tracking-wide text-white shadow-sm transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {loading ? "Iniciando..." : "Iniciar atendimento"}
      </button>
    </div>
  );
}
