"use client";

import { useState } from "react";

/**
 * Acesso PPPoE dentro da OS.
 *
 * A senha NÃO chega nas props. O componente recebe apenas o usuário e um
 * booleano dizendo que existe senha gravada; o texto claro só é buscado quando
 * o operador clica, numa requisição própria, autenticada e auditada.
 *
 * Renderizar a senha na resposta inicial da página a colocaria no HTML servido
 * e no payload do Server Component — visível em "ver código-fonte", no cache do
 * browser e em qualquer proxy no caminho, para toda OS aberta, tenha alguém
 * precisado dela ou não.
 *
 * As duas variantes abaixo mudam SOMENTE apresentação. Quem pode revelar é
 * decidido no servidor por `revealConnectionPasswordForOrder`; `canReveal`
 * apenas evita oferecer um botão que a API sempre recusaria.
 */

type PppoeVariant = "admin" | "technician";

interface PppoeAccessPanelProps {
  orderId: string;
  connectionId: string;
  username: string;
  passwordConfigured: boolean;
  /**
   * `admin` é leitura administrativa: o estado da senha é declarado em texto
   * ("Configurada"), sem campo mascarado sugerindo que a senha já está ali.
   * `technician` é uso operacional em campo: campo mascarado, mostrar e copiar.
   *
   * Em NENHUMA das duas a senha é revelada automaticamente — as duas exigem a
   * mesma requisição explícita e auditada.
   */
  variant: PppoeVariant;
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
  variant,
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

  const isAdmin = variant === "admin";

  return (
    <div data-testid="pppoe-panel" data-variant={variant}>
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
        PPPoE
      </p>

      <div className="mt-3">
        <p className="text-xs font-medium text-slate-500">Usuário</p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <code
            data-testid="pppoe-username"
            className="min-w-0 flex-1 break-all rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-900"
          >
            {username}
          </code>
          <button
            type="button"
            data-testid="pppoe-copy-username"
            onClick={() => copy(username, "user")}
            className={buttonClass}
          >
            {copied === "user" ? "Copiado" : "Copiar"}
          </button>
        </div>
      </div>

      <div className="mt-4">
        <p className="text-xs font-medium text-slate-500">Senha</p>

        {!passwordConfigured ? (
          <p className="mt-1 text-sm text-amber-700">
            Não configurada para este cliente.
          </p>
        ) : (
          <>
            {/*
              Variante administrativa: o estado é DECLARADO. A tela do ADMIN
              existe para conferir que o acesso está cadastrado, não para
              consumir a credencial — um campo mascarado ali sugeriria que a
              senha veio junto com a página, e ela não vem.

              Quando o ADMIN de fato revela, o texto claro aparece no bloco
              abaixo: senão o valor não teria onde ser exibido após o clique.
            */}
            {isAdmin && password === null && (
              <p
                data-testid="pppoe-password-status"
                className="mt-1 text-sm font-medium text-slate-900"
              >
                Configurada
              </p>
            )}

            {(!isAdmin || password !== null) && (
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <code
                  data-testid="pppoe-password"
                  className="min-w-0 flex-1 break-all rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-900"
                >
                  {password ?? "••••••••••"}
                </code>
              </div>
            )}

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
                {/*
                  Copiar depende do MESMO reveal autorizado: o handler chama
                  `fetchPassword` e só copia se o servidor tiver devolvido a
                  senha. Não existe caminho em que a área de transferência
                  receba algo que a API recusou.
                */}
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
