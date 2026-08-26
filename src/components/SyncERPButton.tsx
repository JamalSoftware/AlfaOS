"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

interface SyncResult {
  provider: string;
  fetched: number;
  created: number;
  updated: number;
}

export function SyncERPButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSync() {
    setLoading(true);
    setMessage(null);
    setError(null);
    try {
      const res = await fetch("/api/integrations/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const payload = await res.json();
      if (!res.ok) {
        setError(payload?.error ?? "Falha ao sincronizar.");
        return;
      }
      const sync: SyncResult = payload.data.sync;
      setMessage(
        `Sincronizado: ${sync.fetched} recebidas, ${sync.created} criadas, ${sync.updated} atualizadas.`,
      );
      router.refresh();
    } catch {
      setError("Erro de conexão. Tente novamente.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <button
        type="button"
        onClick={handleSync}
        disabled={loading}
        className="rounded-lg border border-border bg-surface px-4 py-2 text-sm font-semibold text-fg-secondary transition-colors hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-60"
      >
        {loading ? "Sincronizando..." : "Sincronizar Mock ERP"}
      </button>
      {error && (
        <p role="alert" className="text-xs font-medium text-danger-fg">
          {error}
        </p>
      )}
      {message && <p className="text-xs font-medium text-success-fg">{message}</p>}
    </div>
  );
}
