"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

interface CustomerFormProps {
  mode: "create" | "edit";
  customer?: {
    id: string;
    name: string;
    document: string | null;
    phone: string | null;
    secondaryPhone: string | null;
    email: string | null;
    address: string | null;
    number: string | null;
    complement: string | null;
    district: string | null;
    city: string | null;
    state: string | null;
    zipCode: string | null;
    active: boolean;
  };
  backHref: string;
}

const inputClass =
  "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100";

const labelClass = "mb-1 block text-sm font-medium text-slate-700";

function optional(value: string | null | undefined): string {
  return value ?? "";
}

export function CustomerForm({ mode, customer, backHref }: CustomerFormProps) {
  const router = useRouter();
  const [form, setForm] = useState({
    name: optional(customer?.name),
    document: optional(customer?.document),
    phone: optional(customer?.phone),
    secondaryPhone: optional(customer?.secondaryPhone),
    email: optional(customer?.email),
    address: optional(customer?.address),
    number: optional(customer?.number),
    complement: optional(customer?.complement),
    district: optional(customer?.district),
    city: optional(customer?.city),
    state: optional(customer?.state),
    zipCode: optional(customer?.zipCode),
    active: customer?.active ?? true,
  });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function setField(field: string, value: string | boolean) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const body = { ...form, active: form.active };
      const res = await fetch(
        mode === "create" ? "/api/customers" : `/api/customers/${customer!.id}`,
        {
          method: mode === "create" ? "POST" : "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const payload = await res.json();
      if (!res.ok) {
        setError(payload?.error ?? "Falha ao salvar cliente.");
        return;
      }
      router.push(backHref);
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
        <label htmlFor="name" className={labelClass}>Nome *</label>
        <input
          id="name"
          type="text"
          required
          minLength={2}
          maxLength={200}
          value={form.name}
          onChange={(e) => setField("name", e.target.value)}
          className={inputClass}
          placeholder="Nome do cliente"
        />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="document" className={labelClass}>Documento (CPF/CNPJ)</label>
          <input
            id="document"
            type="text"
            maxLength={30}
            value={form.document}
            onChange={(e) => setField("document", e.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="email" className={labelClass}>E-mail</label>
          <input
            id="email"
            type="email"
            maxLength={255}
            value={form.email}
            onChange={(e) => setField("email", e.target.value)}
            className={inputClass}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="phone" className={labelClass}>Telefone</label>
          <input
            id="phone"
            type="text"
            maxLength={30}
            value={form.phone}
            onChange={(e) => setField("phone", e.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="secondaryPhone" className={labelClass}>Telefone alternativo</label>
          <input
            id="secondaryPhone"
            type="text"
            maxLength={30}
            value={form.secondaryPhone}
            onChange={(e) => setField("secondaryPhone", e.target.value)}
            className={inputClass}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="sm:col-span-2">
          <label htmlFor="address" className={labelClass}>Endereço</label>
          <input
            id="address"
            type="text"
            maxLength={200}
            value={form.address}
            onChange={(e) => setField("address", e.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="number" className={labelClass}>Número</label>
          <input
            id="number"
            type="text"
            maxLength={20}
            value={form.number}
            onChange={(e) => setField("number", e.target.value)}
            className={inputClass}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="complement" className={labelClass}>Complemento</label>
          <input
            id="complement"
            type="text"
            maxLength={100}
            value={form.complement}
            onChange={(e) => setField("complement", e.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="district" className={labelClass}>Bairro</label>
          <input
            id="district"
            type="text"
            maxLength={100}
            value={form.district}
            onChange={(e) => setField("district", e.target.value)}
            className={inputClass}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div>
          <label htmlFor="city" className={labelClass}>Cidade</label>
          <input
            id="city"
            type="text"
            maxLength={100}
            value={form.city}
            onChange={(e) => setField("city", e.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="state" className={labelClass}>UF</label>
          <input
            id="state"
            type="text"
            maxLength={2}
            value={form.state}
            onChange={(e) => setField("state", e.target.value)}
            className={inputClass}
            placeholder="SP"
          />
        </div>
        <div>
          <label htmlFor="zipCode" className={labelClass}>CEP</label>
          <input
            id="zipCode"
            type="text"
            maxLength={15}
            value={form.zipCode}
            onChange={(e) => setField("zipCode", e.target.value)}
            className={inputClass}
          />
        </div>
      </div>

      {mode === "edit" && (
        <div>
          <label htmlFor="active" className={labelClass}>Status</label>
          <select
            id="active"
            value={form.active ? "true" : "false"}
            onChange={(e) => setField("active", e.target.value === "true")}
            className={inputClass}
          >
            <option value="true">Ativo</option>
            <option value="false">Inativo</option>
          </select>
        </div>
      )}

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
          {loading ? "Salvando..." : mode === "create" ? "Criar cliente" : "Salvar alterações"}
        </button>
        <a
          href={backHref}
          className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-600 transition-colors hover:bg-slate-100"
        >
          Cancelar
        </a>
      </div>
    </form>
  );
}
