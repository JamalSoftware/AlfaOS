"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

interface ServiceOrderFormProps {
  customers: { id: string; name: string }[];
  types: { id: string; name: string }[];
}

const inputClass =
  "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100";

const labelClass = "mb-1 block text-sm font-medium text-slate-700";

export function ServiceOrderForm({
  customers,
  types,
}: ServiceOrderFormProps) {
  const router = useRouter();
  const [customerId, setCustomerId] = useState("");
  const [typeId, setTypeId] = useState("");
  const [subtype, setSubtype] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState("NORMAL");
  const [scheduledAt, setScheduledAt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!customerId) {
      setError("Selecione um cliente.");
      return;
    }
    if (!typeId) {
      setError("Selecione o tipo da OS.");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/service-orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerId,
          typeId,
          subtype,
          description,
          priority,
          scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : null,
        }),
      });
      const payload = await res.json();
      if (!res.ok) {
        setError(payload?.error ?? "Falha ao criar a OS.");
        return;
      }
      router.push(`/ordens/${payload.data.serviceOrder.id}`);
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
        <label htmlFor="customerId" className={labelClass}>Cliente *</label>
        <select
          id="customerId"
          value={customerId}
          onChange={(e) => setCustomerId(e.target.value)}
          className={inputClass}
        >
          <option value="">Selecione um cliente...</option>
          {customers.map((customer) => (
            <option key={customer.id} value={customer.id}>
              {customer.name}
            </option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="typeId" className={labelClass}>Tipo *</label>
          <select
            id="typeId"
            value={typeId}
            onChange={(e) => setTypeId(e.target.value)}
            className={inputClass}
            disabled={types.length === 0}
          >
            <option value="">
              {types.length === 0
                ? "Nenhum tipo cadastrado"
                : "Selecione o tipo..."}
            </option>
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          {types.length === 0 && (
            <p className="mt-1 text-xs text-amber-700">
              Um ADMIN precisa cadastrar tipos de OS em Configurações › Tipos de
              OS antes de abrir uma ordem.
            </p>
          )}
        </div>
        <div>
          <label htmlFor="subtype" className={labelClass}>Subtipo</label>
          <input
            id="subtype"
            type="text"
            maxLength={100}
            value={subtype}
            onChange={(e) => setSubtype(e.target.value)}
            className={inputClass}
            placeholder="Ex.: Internet lenta"
          />
        </div>
      </div>

      <div>
        <label htmlFor="description" className={labelClass}>Descrição *</label>
        <textarea
          id="description"
          required
          minLength={3}
          maxLength={2000}
          rows={4}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className={inputClass}
          placeholder="Detalhe o problema ou o serviço a ser executado."
        />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="priority" className={labelClass}>Prioridade</label>
          <select
            id="priority"
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
            className={inputClass}
          >
            <option value="LOW">Baixa</option>
            <option value="NORMAL">Normal</option>
            <option value="HIGH">Alta</option>
            <option value="URGENT">Urgente</option>
          </select>
        </div>
        <div>
          <label htmlFor="scheduledAt" className={labelClass}>Agendamento</label>
          <input
            id="scheduledAt"
            type="datetime-local"
            value={scheduledAt}
            onChange={(e) => setScheduledAt(e.target.value)}
            className={inputClass}
          />
        </div>
      </div>

      {error && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={loading}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loading ? "Criando..." : "Criar OS"}
        </button>
        <a
          href="/ordens"
          className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-600 transition-colors hover:bg-slate-100"
        >
          Cancelar
        </a>
      </div>
    </form>
  );
}
