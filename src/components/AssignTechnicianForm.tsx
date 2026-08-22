"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

interface AssignTechnicianFormProps {
  orderId: string;
  technicians: { id: string; name: string }[];
}

export function AssignTechnicianForm({
  orderId,
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
        body: JSON.stringify({ technicianId }),
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
          className="mb-1 block text-sm font-medium text-slate-700"
        >
          Técnico
        </label>
        <select
          id="technician"
          value={technicianId}
          onChange={(e) => setTechnicianId(e.target.value)}
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100"
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
          className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {error}
        </div>
      )}

      <button
        type="submit"
        disabled={loading}
        className="w-full rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {loading ? "Atribuindo..." : "Atribuir OS"}
      </button>
    </form>
  );
}
