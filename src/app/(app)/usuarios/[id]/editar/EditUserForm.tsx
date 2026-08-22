"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const PROFILES = [
  { value: "ADMIN", label: "Administrador" },
  { value: "DISPATCHER", label: "Despachante" },
  { value: "TECHNICIAN", label: "Técnico" },
];

interface EditUserFormProps {
  user: {
    id: string;
    name: string;
    email: string;
    profile: string;
    active: boolean;
  };
  /**
   * True when the admin is editing their own account. Perfil/status are then
   * locked: deactivating or demoting yourself drops your session on the next
   * request and, for a company's only ADMIN, locks everyone out for good.
   * The API refuses the same edits (403) — this only avoids a dead end.
   */
  isSelf?: boolean;
}

export function EditUserForm({ user, isSelf = false }: EditUserFormProps) {
  const router = useRouter();
  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email);
  const [profile, setProfile] = useState(user.profile);
  const [active, setActive] = useState(user.active);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const body: Record<string, string | boolean> = { name, email, profile, active };
    if (password.length > 0) {
      body.password = password;
    }

    try {
      const res = await fetch(`/api/users/${user.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const payload = await res.json();

      if (!res.ok) {
        setError(payload?.error ?? "Falha ao atualizar usuário.");
        return;
      }

      router.push("/usuarios");
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
          htmlFor="name"
          className="mb-1 block text-sm font-medium text-slate-700"
        >
          Nome
        </label>
        <input
          id="name"
          type="text"
          required
          minLength={2}
          maxLength={120}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100"
        />
      </div>

      <div>
        <label
          htmlFor="email"
          className="mb-1 block text-sm font-medium text-slate-700"
        >
          E-mail
        </label>
        <input
          id="email"
          type="email"
          required
          maxLength={255}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100"
        />
      </div>

      <div>
        <label
          htmlFor="profile"
          className="mb-1 block text-sm font-medium text-slate-700"
        >
          Perfil de acesso
        </label>
        <select
          id="profile"
          value={profile}
          disabled={isSelf}
          onChange={(e) => setProfile(e.target.value)}
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500"
        >
          {PROFILES.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label
          htmlFor="password"
          className="mb-1 block text-sm font-medium text-slate-700"
        >
          Nova senha{" "}
          <span className="font-normal text-slate-400">(opcional)</span>
        </label>
        <input
          id="password"
          type="password"
          minLength={8}
          maxLength={128}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100"
          placeholder="Deixe em branco para manter a atual"
        />
      </div>

      <label
        className={`flex items-center gap-3 rounded-lg border border-slate-200 px-3 py-2.5 ${
          isSelf ? "cursor-not-allowed bg-slate-50" : "cursor-pointer"
        }`}
      >
        <input
          type="checkbox"
          checked={active}
          disabled={isSelf}
          onChange={(e) => setActive(e.target.checked)}
          className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-100 disabled:cursor-not-allowed"
        />
        <span className="text-sm font-medium text-slate-700">
          Usuário ativo
        </span>
      </label>

      {isSelf && (
        <p className="text-xs text-slate-500">
          Perfil de acesso e status não podem ser alterados na própria conta.
          Peça a outro administrador da empresa.
        </p>
      )}

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
        {loading ? "Salvando..." : "Salvar alterações"}
      </button>
    </form>
  );
}
