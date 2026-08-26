"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function IntegrationToggle({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleToggle() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/integrations", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !enabled }),
      });
      const payload = await res.json();
      if (!res.ok) {
        setError(payload?.error ?? "Falha ao alterar a integração.");
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
    <div>
      <button
        type="button"
        onClick={handleToggle}
        disabled={loading}
        className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
          enabled
            ? "border-danger-border text-danger-fg hover:bg-danger-bg"
            : "border-success-border text-success-fg hover:bg-success-bg"
        }`}
      >
        {loading ? "..." : enabled ? "Desabilitar" : "Habilitar"}
      </button>
      {error && <p className="mt-2 text-xs text-danger-fg">{error}</p>}
    </div>
  );
}
