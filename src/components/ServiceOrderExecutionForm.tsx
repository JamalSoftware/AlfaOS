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
  "w-full rounded-lg border border-input-border px-3 py-2 text-sm text-fg focus:border-focus focus:outline-none focus:ring-2 focus:ring-focus-soft";

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
          className="mb-1 block text-sm font-medium text-fg-secondary"
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
          className="mb-1 block text-sm font-medium text-fg-secondary"
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
          className="mb-1 block text-sm font-medium text-fg-secondary"
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
          className="rounded-lg border border-danger-border bg-danger-bg px-3 py-2 text-sm text-danger-fg"
        >
          {error}
        </div>
      )}

      {saved && !error && (
        <div
          role="status"
          className="rounded-lg border border-success-border bg-success-bg px-3 py-2 text-sm text-success-fg"
        >
          Execução salva.
        </div>
      )}

      <button
        type="submit"
        disabled={loading}
        className="w-full rounded-xl bg-primary px-4 py-3.5 text-base font-bold uppercase tracking-wide text-primary-fg shadow-sm transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60"
      >
        {loading ? "Salvando..." : "Salvar execução"}
      </button>
    </form>
  );
}
