"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

interface AssignTechnicianFormProps {
  orderId: string;
  /**
   * `version` da OS lida por esta renderização. Enviada no POST como
   * `expectedVersion` — é o que faz o lock otimista cobrir a janela entre o que
   * o despachante VIU na tela e o que ele clicou.
   *
   * Lida direto da prop, nunca copiada para `useState`: depois de um sucesso o
   * `router.refresh()` re-renderiza o Server Component e a prop chega
   * atualizada. Um snapshot em estado ficaria congelado na primeira montagem e
   * faria a próxima troca de técnico conflitar sozinha.
   */
  version: number;
  technicians: { id: string; name: string }[];
}

export function AssignTechnicianForm({
  orderId,
  version,
  technicians,
}: AssignTechnicianFormProps) {
  const router = useRouter();
  const [technicianId, setTechnicianId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!technicianId) {
      setError("Selecione um técnico.");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(`/api/service-orders/${orderId}/assign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ technicianId, expectedVersion: version }),
      });
      const payload = await res.json();
      if (!res.ok) {
        setError(payload?.error ?? "Falha ao atribuir a OS.");
        return;
      }
      setTechnicianId("");
      router.refresh();
    } catch {
      setError("Erro de conexão. Tente novamente.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div>
        <label
          htmlFor="technician"
          className="mb-1 block text-sm font-medium text-fg-secondary"
        >
          Técnico
        </label>
        <select
          id="technician"
          value={technicianId}
          onChange={(e) => setTechnicianId(e.target.value)}
          className="w-full rounded-lg border border-input-border px-3 py-2 text-sm text-fg focus:border-focus focus:outline-none focus:ring-2 focus:ring-focus-soft"
        >
          <option value="">Selecione um técnico...</option>
          {technicians.map((tech) => (
            <option key={tech.id} value={tech.id}>
              {tech.name}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-lg border border-danger-border bg-danger-bg px-3 py-2 text-sm text-danger-fg"
        >
          {error}
        </div>
      )}

      <button
        type="submit"
        disabled={loading}
        className="w-full rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-fg transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60"
      >
        {loading ? "Atribuindo..." : "Atribuir OS"}
      </button>
    </form>
  );
}
