"use client";

import { useState } from "react";

/**
 * Acesso PPPoE dentro da OS.
 *
 * A senha NÃO chega nas props. O componente recebe apenas o usuário e um
 * booleano dizendo que existe senha gravada; o texto claro só é buscado quando
 * o técnico clica, numa requisição própria, autenticada e auditada.
 *
 * Renderizar a senha na resposta inicial da página a colocaria no HTML servido
 * e no payload do Server Component — visível em "ver código-fonte", no cache do
 * browser e em qualquer proxy no caminho, para toda OS aberta, tenha o técnico
 * precisado dela ou não.
 */

interface PppoeAccessPanelProps {
  orderId: string;
  connectionId: string;
  username: string;
  passwordConfigured: boolean;
  /**
   * Falso quando o perfil ou o estado da OS não autorizam revelar. O servidor
   * recusa de qualquer forma — isto só evita oferecer um botão que sempre
   * falharia.
   */
  canReveal: boolean;
  /** Motivo exibido quando `canReveal` é falso. */
  revealBlockedReason?: string | null;
}

export function PppoeAccessPanel({
  orderId,
  connectionId,
  username,
  passwordConfigured,
  canReveal,
  revealBlockedReason,
}: PppoeAccessPanelProps) {
  const [password, setPassword] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<"user" | "password" | null>(null);

  async function fetchPassword(): Promise<string | null> {
    if (password !== null) return password;
    setError(null);
    setLoading(true);
    try {
      const res = await fetch(
        `/api/service-orders/${orderId}/connection-password`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ connectionId }),
        },
      );
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        setError(payload?.error ?? "Não foi possível revelar a senha.");
        return null;
      }
      const value = payload?.data?.password ?? null;
      setPassword(value);
      return value;
    } catch {
      setError("Erro de conexão. Tente novamente.");
      return null;
    } finally {
      setLoading(false);
    }
  }

  async function copy(value: string, what: "user" | "password") {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(what);
      window.setTimeout(() => setCopied(null), 2000);
    } catch {
      setError("Não foi possível copiar. Copie manualmente.");
    }
  }

  const buttonClass =
    "rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60";

  return (
    <div
      data-testid="pppoe-panel"
      className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
    >
      <h2 className="text-base font-semibold text-slate-900">Acesso PPPoE</h2>

      <div className="mt-4">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
          Usuário
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <code
            data-testid="pppoe-username"
            className="min-w-0 flex-1 break-all rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-900"
          >
            {username}
          </code>
          <button
            type="button"
            onClick={() => copy(username, "user")}
            className={buttonClass}
          >
            {copied === "user" ? "Copiado" : "Copiar"}
          </button>
        </div>
      </div>

      <div className="mt-4">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
          Senha
        </p>

        {!passwordConfigured ? (
          <p className="mt-1 text-sm text-amber-700">
            Não configurada para este cliente.
          </p>
        ) : (
          <>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <code
                data-testid="pppoe-password"
                className="min-w-0 flex-1 break-all rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-900"
              >
                {password ?? "••••••••••"}
              </code>
            </div>

            {canReveal ? (
              <div className="mt-2 flex flex-wrap gap-2">
                {password === null ? (
                  <button
                    type="button"
                    data-testid="pppoe-reveal"
                    disabled={loading}
                    onClick={fetchPassword}
                    className={buttonClass}
                  >
                    {loading ? "Revelando..." : "Mostrar senha"}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => setPassword(null)}
                    className={buttonClass}
                  >
                    Ocultar
                  </button>
                )}
                <button
                  type="button"
                  data-testid="pppoe-copy-password"
                  disabled={loading}
                  onClick={async () => {
                    const value = await fetchPassword();
                    if (value) await copy(value, "password");
                  }}
                  className={buttonClass}
                >
                  {copied === "password" ? "Copiada" : "Copiar senha"}
                </button>
              </div>
            ) : (
              <p className="mt-2 text-sm text-slate-500">
                {revealBlockedReason ??
                  "Você não pode revelar a senha neste atendimento."}
              </p>
            )}
          </>
        )}
      </div>

      {error && (
        <div
          role="alert"
          className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {error}
        </div>
      )}
    </div>
  );
}
