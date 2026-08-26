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
        <p className="text-sm text-fg-muted">
          Não há usuários com perfil Técnico disponíveis para vínculo. Crie um
          usuário Técnico em Usuários antes de vincular.
        </p>
      ) : (
        <>
          <div>
            <label htmlFor="userId" className="mb-1 block text-sm font-medium text-fg-secondary">
              Usuário
            </label>
            <select
              id="userId"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              className="w-full rounded-lg border border-input-border px-3 py-2 text-sm text-fg focus:border-focus focus:outline-none focus:ring-2 focus:ring-focus-soft"
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
            <label htmlFor="phone" className="mb-1 block text-sm font-medium text-fg-secondary">
              Telefone (opcional)
            </label>
            <input
              id="phone"
              type="text"
              maxLength={30}
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="w-full rounded-lg border border-input-border px-3 py-2 text-sm text-fg focus:border-focus focus:outline-none focus:ring-2 focus:ring-focus-soft"
              placeholder="(11) 99999-0000"
            />
          </div>

          {error && (
            <div role="alert" className="rounded-lg border border-danger-border bg-danger-bg px-3 py-2 text-sm text-danger-fg">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-fg transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? "Vinculando..." : "Vincular técnico"}
          </button>
        </>
      )}
    </form>
  );
}
