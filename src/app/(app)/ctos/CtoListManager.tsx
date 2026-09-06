"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

interface CtoRow {
  id: string;
  name: string;
  code: string | null;
  capacity: number;
  active: boolean;
  addressReference: string | null;
}

const inputClass =
  "w-full rounded-lg border border-input-border px-3 py-2 text-sm text-fg focus:border-focus focus:outline-none focus:ring-2 focus:ring-focus-soft";

const labelClass = "mb-1 block text-sm font-medium text-fg-secondary";

export function CtoListManager({ ctos }: { ctos: CtoRow[] }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [capacity, setCapacity] = useState("8");
  const [addressReference, setAddressReference] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError("Informe o nome da CTO.");
      return;
    }
    const parsedCapacity = Number(capacity);
    if (!Number.isInteger(parsedCapacity) || parsedCapacity < 1) {
      setError("Capacidade deve ser um número inteiro maior que zero.");
      return;
    }
    setCreating(true);
    try {
      const res = await fetch("/api/ctos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          // Vazio vira `null`: string em branco não é um código, e gravá-la
          // faria "sem código" e "código vazio" virarem estados diferentes.
          code: code.trim() ? code.trim() : null,
          capacity: parsedCapacity,
          addressReference: addressReference.trim()
            ? addressReference.trim()
            : null,
        }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        setError(payload?.error ?? "Falha ao cadastrar a CTO.");
        return;
      }
      setName("");
      setCode("");
      setCapacity("8");
      setAddressReference("");
      router.refresh();
    } catch {
      setError("Erro de conexão. Tente novamente.");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="space-y-6">
      <form
        onSubmit={handleCreate}
        className="rounded-2xl border border-border bg-surface p-5 shadow-sm"
        data-testid="cto-create-form"
      >
        <h2 className="mb-4 text-base font-semibold text-fg">Nova CTO</h2>
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className={labelClass} htmlFor="cto-name">
              Nome
            </label>
            <input
              id="cto-name"
              className={inputClass}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="ex.: A16"
              maxLength={60}
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="cto-code">
              Código (opcional)
            </label>
            <input
              id="cto-code"
              className={inputClass}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              maxLength={40}
            />
            <p className="mt-1 text-xs text-fg-muted">
              Não pode ser alterado depois de cadastrado.
            </p>
          </div>
          <div>
            <label className={labelClass} htmlFor="cto-capacity">
              Capacidade (portas)
            </label>
            <input
              id="cto-capacity"
              type="number"
              min={1}
              max={256}
              className={inputClass}
              value={capacity}
              onChange={(e) => setCapacity(e.target.value)}
            />
            <p className="mt-1 text-xs text-fg-muted">
              As portas são criadas automaticamente, numeradas de 1 até a
              capacidade.
            </p>
          </div>
          <div>
            <label className={labelClass} htmlFor="cto-address">
              Referência de endereço (opcional)
            </label>
            <input
              id="cto-address"
              className={inputClass}
              value={addressReference}
              onChange={(e) => setAddressReference(e.target.value)}
              placeholder="ex.: Poste em frente ao nº 340"
              maxLength={200}
            />
          </div>
        </div>

        {error && (
          <p className="mt-4 text-sm text-danger-text" role="alert">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={creating}
          className="mt-4 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-fg transition-colors hover:bg-primary-hover disabled:opacity-60"
        >
          {creating ? "Cadastrando..." : "Cadastrar CTO"}
        </button>
      </form>

      {ctos.length > 0 && (
        <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-surface-muted">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-fg-secondary">
                    Nome
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-fg-secondary">
                    Código
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-fg-secondary">
                    Capacidade
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-fg-secondary">
                    Referência
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-fg-secondary">
                    Situação
                  </th>
                </tr>
              </thead>
              <tbody>
                {ctos.map((cto) => (
                  <tr
                    key={cto.id}
                    className="border-b border-border last:border-0"
                    data-testid="cto-row"
                  >
                    <td className="px-4 py-3">
                      <Link
                        href={`/ctos/${cto.id}`}
                        className="font-medium text-primary-text hover:underline"
                      >
                        {cto.name}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-fg-secondary">
                      {cto.code ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-fg-secondary">
                      {cto.capacity} portas
                    </td>
                    <td className="px-4 py-3 text-fg-secondary">
                      {cto.addressReference ?? "—"}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={
                          cto.active
                            ? "rounded-full bg-success-bg px-2 py-0.5 text-xs font-medium text-success-text"
                            : "rounded-full bg-surface-muted px-2 py-0.5 text-xs font-medium text-fg-muted"
                        }
                      >
                        {cto.active ? "Ativa" : "Inativa"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
