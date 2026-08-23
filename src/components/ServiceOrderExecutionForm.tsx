"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

interface ServiceOrderExecutionFormProps {
  orderId: string;
  /** Version of the execution as read by this render of the Server Component. */
  version: number;
  initialDiagnosis: string | null;
  initialWorkPerformed: string | null;
  initialNotes: string | null;
  maxLength: number;
}

const FIELD_CLASS =
  "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100";

export function ServiceOrderExecutionForm({
  orderId,
  version,
  initialDiagnosis,
  initialWorkPerformed,
  initialNotes,
  maxLength,
}: ServiceOrderExecutionFormProps) {
  const router = useRouter();

  /**
   * Field values live in local state and are NEVER reset by this component —
   * not on error, not on success. A technician standing in a customer's
   * hallway on a bad connection must not lose a paragraph of diagnosis
   * because a request timed out or came back 409.
   */
  const [diagnosis, setDiagnosis] = useState(initialDiagnosis ?? "");
  const [workPerformed, setWorkPerformed] = useState(
    initialWorkPerformed ?? "",
  );
  const [notes, setNotes] = useState(initialNotes ?? "");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  /**
   * Version returned by our own last successful save.
   *
   * The prop alone is not enough here: `router.refresh()` is asynchronous, so
   * a technician who saves twice in quick succession would send the pre-save
   * version on the second attempt and 409 against themself. Versions are
   * monotonic per execution row, so "whichever is larger" is unambiguous —
   * that keeps a genuinely newer server value (someone else's write, arriving
   * via refresh) winning over our stale local one.
   */
  const [savedVersion, setSavedVersion] = useState<number | null>(null);
  const currentVersion =
    savedVersion !== null && savedVersion > version ? savedVersion : version;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (loading) return;

    setError(null);
    setSaved(false);
    setLoading(true);
    try {
      const res = await fetch(`/api/service-orders/${orderId}/execution`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedVersion: currentVersion,
          diagnosis,
          workPerformed,
          notes,
        }),
      });
      const payload = await res.json();
      if (!res.ok) {
        setError(payload?.error ?? "Falha ao salvar a execução.");
        return;
      }
      const nextVersion = payload?.data?.execution?.version;
      if (typeof nextVersion === "number") {
        setSavedVersion(nextVersion);
      }
      setSaved(true);
      router.refresh();
    } catch {
      setError("Erro de conexão. Tente novamente.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label
          htmlFor="diagnosis"
          className="mb-1 block text-sm font-medium text-slate-700"
        >
          Diagnóstico
        </label>
        <textarea
          id="diagnosis"
          rows={4}
          maxLength={maxLength}
          value={diagnosis}
          onChange={(e) => setDiagnosis(e.target.value)}
          className={FIELD_CLASS}
          placeholder="O que foi identificado no local."
        />
      </div>

      <div>
        <label
          htmlFor="workPerformed"
          className="mb-1 block text-sm font-medium text-slate-700"
        >
          Serviço realizado
        </label>
        <textarea
          id="workPerformed"
          rows={4}
          maxLength={maxLength}
          value={workPerformed}
          onChange={(e) => setWorkPerformed(e.target.value)}
          className={FIELD_CLASS}
          placeholder="O que foi executado no atendimento."
        />
      </div>

      <div>
        <label
          htmlFor="notes"
          className="mb-1 block text-sm font-medium text-slate-700"
        >
          Observações
        </label>
        <textarea
          id="notes"
          rows={3}
          maxLength={maxLength}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          className={FIELD_CLASS}
          placeholder="Informações adicionais."
        />
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {error}
        </div>
      )}

      {saved && !error && (
        <div
          role="status"
          className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700"
        >
          Execução salva.
        </div>
      )}

      <button
        type="submit"
        disabled={loading}
        className="w-full rounded-xl bg-blue-600 px-4 py-3.5 text-base font-bold uppercase tracking-wide text-white shadow-sm transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {loading ? "Salvando..." : "Salvar execução"}
      </button>
    </form>
  );
}
