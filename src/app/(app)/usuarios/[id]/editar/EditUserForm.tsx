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
          className="mb-1 block text-sm font-medium text-fg-secondary"
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
          className="w-full rounded-lg border border-input-border px-3 py-2 text-sm text-fg focus:border-focus focus:outline-none focus:ring-2 focus:ring-focus-soft"
        />
      </div>

      <div>
        <label
          htmlFor="email"
          className="mb-1 block text-sm font-medium text-fg-secondary"
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
          className="w-full rounded-lg border border-input-border px-3 py-2 text-sm text-fg focus:border-focus focus:outline-none focus:ring-2 focus:ring-focus-soft"
        />
      </div>

      <div>
        <label
          htmlFor="profile"
          className="mb-1 block text-sm font-medium text-fg-secondary"
        >
          Perfil de acesso
        </label>
        <select
          id="profile"
          value={profile}
          disabled={isSelf}
          onChange={(e) => setProfile(e.target.value)}
          className="w-full rounded-lg border border-input-border px-3 py-2 text-sm text-fg focus:border-focus focus:outline-none focus:ring-2 focus:ring-focus-soft disabled:cursor-not-allowed disabled:bg-surface-muted disabled:text-fg-muted"
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
          className="mb-1 block text-sm font-medium text-fg-secondary"
        >
          Nova senha{" "}
          <span className="font-normal text-fg-muted">(opcional)</span>
        </label>
        <input
          id="password"
          type="password"
          minLength={8}
          maxLength={128}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded-lg border border-input-border px-3 py-2 text-sm text-fg focus:border-focus focus:outline-none focus:ring-2 focus:ring-focus-soft"
          placeholder="Deixe em branco para manter a atual"
        />
      </div>

      <label
        className={`flex items-center gap-3 rounded-lg border border-border px-3 py-2.5 ${
          isSelf ? "cursor-not-allowed bg-surface-subtle" : "cursor-pointer"
        }`}
      >
        <input
          type="checkbox"
          checked={active}
          disabled={isSelf}
          onChange={(e) => setActive(e.target.checked)}
          className="h-4 w-4 rounded border-input-border text-primary-text focus:ring-focus-soft disabled:cursor-not-allowed"
        />
        <span className="text-sm font-medium text-fg-secondary">
          Usuário ativo
        </span>
      </label>

      {isSelf && (
        <p className="text-xs text-fg-muted">
          Perfil de acesso e status não podem ser alterados na própria conta.
          Peça a outro administrador da empresa.
        </p>
      )}

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
        {loading ? "Salvando..." : "Salvar alterações"}
      </button>
    </form>
  );
}
