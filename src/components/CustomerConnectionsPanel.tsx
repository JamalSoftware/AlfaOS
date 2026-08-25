"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Painel administrativo de conexões do cliente.
 *
 * A senha entra, nunca sai. Não existe estado, prop nem requisição neste
 * componente que traga a senha gravada de volta — o servidor não expõe nenhuma
 * rota capaz disso. O que se vê é "Configurada" ou "Não configurada".
 */

interface ConnectionRow {
  id: string;
  type: string;
  username: string;
  passwordConfigured: boolean;
  usernameSource: "MANUAL" | "RECEITANET";
  passwordSource: "MANUAL" | "AUTO_DOCUMENT_LAST4";
  active: boolean;
}

/**
 * Rótulos de procedência.
 *
 * Não é enfeite: é o que diz ao operador se “Restaurar padrão” vai
 * descartar uma senha que alguém definiu para aquele cliente.
 */
const USERNAME_SOURCE_LABEL: Record<ConnectionRow["usernameSource"], string> = {
  MANUAL: "Manual",
  RECEITANET: "ReceitaNet",
};

const PASSWORD_SOURCE_LABEL: Record<ConnectionRow["passwordSource"], string> = {
  MANUAL: "Manual",
  AUTO_DOCUMENT_LAST4: "Padrão da empresa",
};

const inputClass =
  "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100";

const labelClass = "mb-1 block text-sm font-medium text-slate-700";

export function CustomerConnectionsPanel({
  customerId,
  connections,
}: {
  customerId: string;
  connections: ConnectionRow[];
}) {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [replacingId, setReplacingId] = useState<string | null>(null);
  const [replacement, setReplacement] = useState("");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  /** Copia o USUÁRIO. A senha tem o seu próprio fluxo, na OS do técnico. */
  async function copyUsername(connection: ConnectionRow) {
    try {
      await navigator.clipboard.writeText(connection.username);
      setCopiedId(connection.id);
      window.setTimeout(() => setCopiedId(null), 2000);
    } catch {
      setError("Não foi possível copiar. Copie manualmente.");
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    if (!username.trim()) {
      setError("Informe o usuário da conexão.");
      return;
    }
    setCreating(true);
    try {
      const res = await fetch(`/api/customers/${customerId}/connections`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username,
          ...(password ? { password } : {}),
        }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        setError(payload?.error ?? "Falha ao cadastrar a conexão.");
        return;
      }
      // Limpa imediatamente: nada de senha viva no estado do componente depois
      // que a requisição terminou.
      setUsername("");
      setPassword("");
      setNotice("Conexão cadastrada.");
      router.refresh();
    } catch {
      setError("Erro de conexão. Tente novamente.");
    } finally {
      setCreating(false);
    }
  }

  async function patchConnection(id: string, body: Record<string, unknown>) {
    setError(null);
    setNotice(null);
    setPendingId(id);
    try {
      const res = await fetch(
        `/api/customers/${customerId}/connections/${id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        setError(payload?.error ?? "Falha ao atualizar a conexão.");
        return false;
      }
      router.refresh();
      return true;
    } catch {
      setError("Erro de conexão. Tente novamente.");
      return false;
    } finally {
      setPendingId(null);
    }
  }

  async function handleReplace(id: string) {
    if (!replacement) {
      setError("Informe a nova senha.");
      return;
    }
    const ok = await patchConnection(id, { password: replacement });
    if (ok) {
      setReplacement("");
      setReplacingId(null);
      setNotice("Senha substituída.");
    }
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 className="text-base font-semibold text-slate-900">
        Conexões de acesso
      </h2>
      <p className="mt-1 text-sm text-slate-500">
        Credenciais PPPoE do cliente. A senha é armazenada criptografada e nunca
        é reexibida — para trocá-la, digite uma nova.
      </p>

      {connections.length > 0 && (
        <ul className="mt-4 space-y-3">
          {connections.map((connection) => (
            <li
              key={connection.id}
              className="rounded-xl border border-slate-200 p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                    {connection.type}
                  </p>
                  <p className="mt-0.5 truncate font-medium text-slate-900">
                    {connection.username}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    Fonte do usuário:{" "}
                    {USERNAME_SOURCE_LABEL[connection.usernameSource]}
                  </p>
                  <p className="mt-1 text-sm">
                    Senha:{" "}
                    <span
                      className={
                        connection.passwordConfigured
                          ? "font-semibold text-emerald-700"
                          : "font-semibold text-amber-700"
                      }
                    >
                      {connection.passwordConfigured
                        ? "Configurada"
                        : "Não configurada"}
                    </span>
                  </p>
                  {connection.passwordConfigured && (
                    <p className="mt-0.5 text-xs text-slate-500">
                      Origem da senha:{" "}
                      {PASSWORD_SOURCE_LABEL[connection.passwordSource]}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span
                    className={
                      connection.active
                        ? "rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700"
                        : "rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-500"
                    }
                  >
                    {connection.active ? "Ativa" : "Inativa"}
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      setReplacingId(
                        replacingId === connection.id ? null : connection.id,
                      )
                    }
                    className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 transition-colors hover:bg-slate-100"
                  >
                    {connection.passwordConfigured
                      ? "Trocar senha"
                      : "Definir senha"}
                  </button>
                  <button
                    type="button"
                    data-testid="copy-username"
                    onClick={() => copyUsername(connection)}
                    className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 transition-colors hover:bg-slate-100"
                  >
                    {copiedId === connection.id ? "Copiado" : "Copiar usuário"}
                  </button>
                  <button
                    type="button"
                    data-testid="restore-default-password"
                    disabled={pendingId === connection.id}
                    onClick={() =>
                      patchConnection(connection.id, {
                        restoreDefaultPassword: true,
                      })
                    }
                    className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Restaurar padrão
                  </button>
                  <button
                    type="button"
                    disabled={pendingId === connection.id}
                    onClick={() =>
                      patchConnection(connection.id, {
                        active: !connection.active,
                      })
                    }
                    className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {connection.active ? "Desativar" : "Reativar"}
                  </button>
                </div>
              </div>

              {replacingId === connection.id && (
                <div className="mt-3 flex flex-wrap items-end gap-2">
                  <div className="min-w-[200px] flex-1">
                    <label
                      htmlFor={`replace-${connection.id}`}
                      className={labelClass}
                    >
                      Nova senha
                    </label>
                    <input
                      id={`replace-${connection.id}`}
                      type="password"
                      autoComplete="new-password"
                      maxLength={256}
                      value={replacement}
                      onChange={(e) => setReplacement(e.target.value)}
                      className={inputClass}
                    />
                  </div>
                  <button
                    type="button"
                    disabled={pendingId === connection.id}
                    onClick={() => handleReplace(connection.id)}
                    className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Salvar senha
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <form
        onSubmit={handleCreate}
        className="mt-5 border-t border-slate-100 pt-5"
      >
        <h3 className="mb-3 text-sm font-semibold text-slate-900">
          Nova conexão PPPoE
        </h3>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="connectionUsername" className={labelClass}>
              Usuário *
            </label>
            <input
              id="connectionUsername"
              type="text"
              maxLength={120}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className={inputClass}
              placeholder="usuario@provedor"
            />
          </div>
          <div>
            <label htmlFor="connectionPassword" className={labelClass}>
              Senha
            </label>
            <input
              id="connectionPassword"
              type="password"
              autoComplete="new-password"
              maxLength={256}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={inputClass}
              placeholder="Opcional agora"
            />
          </div>
        </div>

        {error && (
          <div
            role="alert"
            className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
          >
            {error}
          </div>
        )}
        {notice && (
          <p className="mt-3 text-sm text-emerald-700">{notice}</p>
        )}

        <button
          type="submit"
          disabled={creating}
          className="mt-4 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {creating ? "Salvando..." : "Cadastrar conexão"}
        </button>
      </form>
    </div>
  );
}
