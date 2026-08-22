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
        className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-600 transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {loading ? "Sincronizando..." : "Sincronizar Mock ERP"}
      </button>
      {error && (
        <p role="alert" className="text-xs font-medium text-red-600">
          {error}
        </p>
      )}
      {message && <p className="text-xs font-medium text-emerald-600">{message}</p>}
    </div>
  );
}
