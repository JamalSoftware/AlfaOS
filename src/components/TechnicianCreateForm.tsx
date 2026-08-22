"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

interface TechnicianCreateFormProps {
  candidates: { id: string; name: string; email: string }[];
}

export function TechnicianCreateForm({ candidates }: TechnicianCreateFormProps) {
  const router = useRouter();
  const [userId, setUserId] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!userId) {
      setError("Selecione um usuário.");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/technicians", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, phone }),
      });
      const payload = await res.json();
      if (!res.ok) {
        setError(payload?.error ?? "Falha ao vincular técnico.");
        return;
      }
      router.push("/tecnicos");
      router.refresh();
    } catch {
      setError("Erro de conexão. Tente novamente.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {candidates.length === 0 ? (
        <p className="text-sm text-slate-500">
          Não há usuários com perfil Técnico disponíveis para vínculo. Crie um
          usuário Técnico em Usuários antes de vincular.
        </p>
      ) : (
        <>
          <div>
            <label htmlFor="userId" className="mb-1 block text-sm font-medium text-slate-700">
              Usuário
            </label>
            <select
              id="userId"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100"
            >
              <option value="">Selecione um usuário...</option>
              {candidates.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.name} ({user.email})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="phone" className="mb-1 block text-sm font-medium text-slate-700">
              Telefone (opcional)
            </label>
            <input
              id="phone"
              type="text"
              maxLength={30}
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100"
              placeholder="(11) 99999-0000"
            />
          </div>

          {error && (
            <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? "Vinculando..." : "Vincular técnico"}
          </button>
        </>
      )}
    </form>
  );
}
