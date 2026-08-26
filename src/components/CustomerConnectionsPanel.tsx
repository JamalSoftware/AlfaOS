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
  usernameSource: "MANUAL" | "RECEITANET_CALLCENTER" | "RECEITANET_CHATBOT";
  passwordSource:
    | "MANUAL"
    | "AUTO_DOCUMENT_LAST4"
    | "RECEITANET_CHATBOT";
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
  RECEITANET_CALLCENTER: "ReceitaNet (CallCenter)",
  RECEITANET_CHATBOT: "ReceitaNet (Chatbot)",
};

/**
 * Rótulos da senha, em ordem de confiança.
 *
 "Padrão da empresa" é explicitamente um palpite derivado do CPF, e o
 * operador precisa distingui-lo da credencial real que o Chatbot entrega —
 * é a diferença entre uma senha que provavelmente funciona e uma que o
 * provedor confirmou.
 */
const PASSWORD_SOURCE_LABEL: Record<ConnectionRow["passwordSource"], string> = {
  MANUAL: "Manual",
  AUTO_DOCUMENT_LAST4: "Padrão da empresa (CPF)",
  RECEITANET_CHATBOT: "ReceitaNet (real)",
};

const inputClass =
  "w-full rounded-lg border border-input-border px-3 py-2 text-sm text-fg focus:border-focus focus:outline-none focus:ring-2 focus:ring-focus-soft";

const labelClass = "mb-1 block text-sm font-medium text-fg-secondary";

/**
 * A conexão veio do provedor, ou foi digitada aqui?
 *
 * Muda o que a tela oferece. Numa conexão sincronizada, trocar a senha à
 * mão é EXCEÇÃO — resolve o caso em que o provedor está errado ou fora do
 * ar, e no resto do tempo só cria divergência entre o que o AlfaOS mostra e
 * o que autentica de verdade. Numa conexão manual, essas ações são o único
 * jeito de administrar, e continuam à mão.
 */
function veioDoProvedor(connection: ConnectionRow): boolean {
  return (
    connection.usernameSource !== "MANUAL" ||
    connection.passwordSource === "RECEITANET_CHATBOT"
  );
}

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
    <div className="rounded-2xl border border-border bg-surface p-6 shadow-sm">
      <h2 className="text-base font-semibold text-fg">
        Conexões de acesso
      </h2>
      <p className="mt-1 text-sm text-fg-muted">
        Credenciais PPPoE do cliente. A senha é armazenada criptografada e nunca
        é reexibida — para trocá-la, digite uma nova.
      </p>

      {connections.length > 0 && (
        <ul className="mt-4 space-y-3">
          {connections.map((connection) => (
            <li
              key={connection.id}
              className="rounded-xl border border-border p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-medium uppercase tracking-wide text-fg-muted">
                    {connection.type}
                  </p>
                  <p className="mt-0.5 truncate font-medium text-fg">
                    {connection.username}
                  </p>
                  <p className="mt-0.5 text-xs text-fg-muted">
                    Fonte do usuário:{" "}
                    {USERNAME_SOURCE_LABEL[connection.usernameSource]}
                  </p>
                  <p className="mt-1 text-sm">
                    Senha:{" "}
                    <span
                      className={
                        connection.passwordConfigured
                          ? "font-semibold text-success-fg"
                          : "font-semibold text-warning-fg"
                      }
                    >
                      {connection.passwordConfigured
                        ? "Configurada"
                        : "Não configurada"}
                    </span>
                  </p>
                  {connection.passwordConfigured && (
                    <p className="mt-0.5 text-xs text-fg-muted">
                      Origem da senha:{" "}
                      {PASSWORD_SOURCE_LABEL[connection.passwordSource]}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span
                    className={
                      connection.active
                        ? "rounded-full bg-success-bg px-2 py-0.5 text-xs font-semibold text-success-fg"
                        : "rounded-full bg-surface-muted px-2 py-0.5 text-xs font-semibold text-fg-muted"
                    }
                  >
                    {connection.active ? "Ativa" : "Inativa"}
                  </span>
                  {/*
                    Copiar o usuário é LEITURA e fica sempre à mão — é o que
                    o operador faz o tempo todo. As três abaixo alteram o
                    acesso do cliente.
                  */}
                  <button
                    type="button"
                    data-testid="copy-username"
                    onClick={() => copyUsername(connection)}
                    className="rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-fg-secondary transition-colors hover:bg-surface-muted"
                  >
                    {copiedId === connection.id ? "Copiado" : "Copiar usuário"}
                  </button>
                </div>
              </div>

              {/*
                Ações que mudam o acesso do cliente.

                Numa conexão sincronizada elas ficam recolhidas: o provedor é
                a fonte, e mexer à mão é o caso excepcional. Numa conexão
                manual continuam abertas, porque ali são o único jeito de
                administrar.

                `<details>` nativo em vez de accordion próprio — já vem com
                teclado, leitor de tela e estado, e não precisa de estado no
                React nem de uma linha de JavaScript.
              */}
              <details
                data-testid="connection-advanced"
                open={!veioDoProvedor(connection)}
                className="mt-3 border-t border-border-subtle pt-3"
              >
                <summary className="cursor-pointer list-none text-xs font-semibold text-fg-secondary marker:content-none">
                  Ações avançadas
                </summary>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    data-testid="replace-password"
                    onClick={() =>
                      setReplacingId(
                        replacingId === connection.id ? null : connection.id,
                      )
                    }
                    className="rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-fg-secondary transition-colors hover:bg-surface-muted"
                  >
                    {connection.passwordConfigured
                      ? "Trocar senha"
                      : "Definir senha"}
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
                    className="rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-fg-secondary transition-colors hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Restaurar padrão
                  </button>
                  <button
                    type="button"
                    data-testid="toggle-connection-active"
                    disabled={pendingId === connection.id}
                    onClick={() =>
                      patchConnection(connection.id, {
                        active: !connection.active,
                      })
                    }
                    className="rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-fg-secondary transition-colors hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {connection.active ? "Desativar" : "Reativar"}
                  </button>
                </div>
              </details>

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
                    className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-fg transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Salvar senha
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {/*
        Cadastro manual continua existindo — nem todo tenant terá ReceitaNet,
        e é o caminho de recuperação quando o provedor está fora. Mas quando
        já existe conexão sincronizada, criar outra à mão é excepcional e não
        precisa ocupar o fim da tela aberta.
      */}
      <details
        data-testid="new-connection"
        open={!connections.some(veioDoProvedor)}
        className="mt-5 border-t border-border-subtle pt-5"
      >
        <summary className="cursor-pointer list-none text-sm font-semibold text-fg marker:content-none">
          Nova conexão PPPoE
        </summary>
        <form onSubmit={handleCreate} className="mt-3">
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
            className="mt-3 rounded-lg border border-danger-border bg-danger-bg px-3 py-2 text-sm text-danger-fg"
          >
            {error}
          </div>
        )}
        {notice && (
          <p className="mt-3 text-sm text-success-fg">{notice}</p>
        )}

        <button
          type="submit"
          disabled={creating}
          className="mt-4 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-fg transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60"
        >
          {creating ? "Salvando..." : "Cadastrar conexão"}
        </button>
        </form>
      </details>
    </div>
  );
}
