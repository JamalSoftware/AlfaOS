"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

interface TypeRow {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  sortOrder: number;
}

const inputClass =
  "w-full rounded-lg border border-input-border px-3 py-2 text-sm text-fg focus:border-focus focus:outline-none focus:ring-2 focus:ring-focus-soft";

const labelClass = "mb-1 block text-sm font-medium text-fg-secondary";

export function ServiceOrderTypeManager({ types }: { types: TypeRow[] }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [sortOrder, setSortOrder] = useState("0");
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError("Informe o nome do tipo.");
      return;
    }
    setCreating(true);
    try {
      const res = await fetch("/api/service-order-types", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          description,
          sortOrder: Number(sortOrder) || 0,
        }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        setError(payload?.error ?? "Falha ao criar o tipo.");
        return;
      }
      setName("");
      setDescription("");
      setSortOrder("0");
      router.refresh();
    } catch {
      setError("Erro de conexão. Tente novamente.");
    } finally {
      setCreating(false);
    }
  }

  async function toggleActive(type: TypeRow) {
    setError(null);
    setPendingId(type.id);
    try {
      const res = await fetch(`/api/service-order-types/${type.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: !type.active }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        setError(payload?.error ?? "Falha ao atualizar o tipo.");
        return;
      }
      router.refresh();
    } catch {
      setError("Erro de conexão. Tente novamente.");
    } finally {
      setPendingId(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-border bg-surface p-6 shadow-sm">
        <h2 className="mb-4 text-base font-semibold text-fg">
          Novo tipo
        </h2>
        <form onSubmit={handleCreate} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_auto]">
            <div>
              <label htmlFor="name" className={labelClass}>
                Nome *
              </label>
              <input
                id="name"
                type="text"
                maxLength={60}
                value={name}
                onChange={(e) => setName(e.target.value)}
                className={inputClass}
                placeholder="Ex.: Instalação"
              />
            </div>
            <div className="sm:w-28">
              <label htmlFor="sortOrder" className={labelClass}>
                Ordem
              </label>
              <input
                id="sortOrder"
                type="number"
                min={0}
                max={9999}
                value={sortOrder}
                onChange={(e) => setSortOrder(e.target.value)}
                className={inputClass}
              />
            </div>
          </div>

          <div>
            <label htmlFor="description" className={labelClass}>
              Descrição
            </label>
            <input
              id="description"
              type="text"
              maxLength={500}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className={inputClass}
              placeholder="Opcional"
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

          <button
            type="submit"
            disabled={creating}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-fg transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60"
          >
            {creating ? "Criando..." : "Criar tipo"}
          </button>
        </form>
      </div>

      <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-left text-sm">
            <thead className="border-b border-border bg-surface-subtle text-xs uppercase tracking-wide text-fg-muted">
              <tr>
                <th className="px-4 py-3">Nome</th>
                <th className="px-4 py-3">Descrição</th>
                <th className="px-4 py-3">Ordem</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {types.map((type) => (
                <tr key={type.id} className="border-b border-border-subtle">
                  <td className="px-4 py-3 font-medium text-fg">
                    {type.name}
                  </td>
                  <td className="px-4 py-3 text-fg-muted">
                    {type.description ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-fg-muted">{type.sortOrder}</td>
                  <td className="px-4 py-3">
                    <span
                      className={
                        type.active
                          ? "rounded-full bg-success-bg px-2 py-0.5 text-xs font-semibold text-success-fg"
                          : "rounded-full bg-surface-muted px-2 py-0.5 text-xs font-semibold text-fg-muted"
                      }
                    >
                      {type.active ? "Ativo" : "Inativo"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      onClick={() => toggleActive(type)}
                      disabled={pendingId === type.id}
                      className="rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-fg-secondary transition-colors hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {pendingId === type.id
                        ? "..."
                        : type.active
                          ? "Desativar"
                          : "Reativar"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
