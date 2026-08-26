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

/**
 * Máscara da senha. Quatro caracteres, SEMPRE.
 *
 * O comprimento é fixo de propósito e não tem relação nenhuma com a senha
 * real: derivá-lo do valor verdadeiro vazaria quantos caracteres ela tem —
 * informação que estreita um ataque de força bruta sem que ninguém precise
 * revelar nada.
 *
 * Isto é APRESENTAÇÃO. A senha não chega ao componente no render inicial;
 * o que chega é `passwordConfigured`, um booleano.
 */
const PASSWORD_MASK = "••••";

interface PppoeAccessPanelProps {
  orderId: string;
  connectionId: string;
  username: string;
  passwordConfigured: boolean;
  /**
   * Muda o que a tela oferece, não o que ela sabe.
   *
   * As duas variantes mostram a mesma máscara e exigem a MESMA requisição
   * explícita e auditada para ver o texto claro. Em nenhuma delas a senha
   * chega junto com a página.
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
    "rounded-lg border border-input-border px-3 py-2 text-sm font-semibold text-fg-secondary transition-colors hover:bg-surface-subtle disabled:cursor-not-allowed disabled:opacity-60";


  return (
    <div data-testid="pppoe-panel" data-variant={variant}>
      <p className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
        PPPoE
      </p>

      <div className="mt-3">
        <p className="text-xs font-medium text-fg-muted">Usuário</p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <code
            data-testid="pppoe-username"
            className="min-w-0 flex-1 break-all rounded-lg bg-surface-subtle px-3 py-2 text-sm text-fg"
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
        <p className="text-xs font-medium text-fg-muted">Senha</p>

        {!passwordConfigured ? (
          <p className="mt-1 text-sm text-warning-fg">
            Não configurada para este cliente.
          </p>
        ) : (
          <>
            {/*
              Máscara nas duas variantes.

              O ADMIN antes lia “Configurada” em texto. A máscara comunica a
              mesma coisa e ainda deixa claro ONDE o valor vai aparecer
              depois do clique — e continua sendo só apresentação: o que o
              componente recebe é um booleano.
            */}
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <code
                data-testid="pppoe-password"
                className="min-w-0 flex-1 break-all rounded-lg bg-surface-subtle px-3 py-2 text-sm text-fg"
              >
                {password ?? PASSWORD_MASK}
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
                    data-testid="pppoe-hide"
                    // Descarta o texto claro do estado do client assim que
                    // ele deixa de ser necessário.
                    onClick={() => setPassword(null)}
                    className={buttonClass}
                  >
                    Ocultar senha
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
              <p className="mt-2 text-sm text-fg-muted">
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
          className="mt-3 rounded-lg border border-danger-border bg-danger-bg px-3 py-2 text-sm text-danger-fg"
        >
          {error}
        </div>
      )}
    </div>
  );
}
