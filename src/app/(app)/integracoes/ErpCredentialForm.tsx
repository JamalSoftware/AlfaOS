"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export interface CredentialStatusView {
  provider: string;
  configured: boolean;
  last4: string | null;
  updatedAt: string | null;
  encryptionAvailable: boolean;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

/**
 * Token / API Key management for the company's ERP integration.
 *
 * The plaintext token lives in this component's state ONLY between typing and
 * a successful save, and is cleared the moment the request returns. It is
 * never placed in server props, never rendered back, and never part of the
 * page's HTML — after saving, the only trace is the masked last four
 * characters, which come from the server.
 *
 * The field is `type="password"` with autoComplete off so browsers and
 * password managers do not retain it either.
 */
export function ErpCredentialForm({
  initialStatus,
}: {
  initialStatus: CredentialStatusView;
}) {
  const router = useRouter();
  const [status, setStatus] = useState(initialStatus);
  const [token, setToken] = useState("");
  const [editing, setEditing] = useState(!initialStatus.configured);
  const [busy, setBusy] = useState<null | "save" | "remove">(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!token) {
      setError("Informe o token.");
      return;
    }
    setBusy("save");
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/integrations/credential", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        setError(payload?.error ?? "Não foi possível salvar a credencial.");
        return;
      }
      // Cleared immediately on success: from here on the component holds no
      // secret material at all.
      setToken("");
      setEditing(false);
      setStatus(payload.data.credential);
      setNotice(
        "Credencial salva. A conexão poderá ser validada quando a integração " +
          "ReceitaNet estiver configurada com documentação oficial.",
      );
      router.refresh();
    } catch {
      setError("Erro de conexão. Tente novamente.");
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (busy) return;
    if (!window.confirm("Remover a credencial configurada?")) return;
    setBusy("remove");
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/integrations/credential", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        setError(payload?.error ?? "Não foi possível remover a credencial.");
        return;
      }
      setStatus(payload.data.credential);
      setToken("");
      setEditing(true);
      setNotice("Credencial removida.");
      router.refresh();
    } catch {
      setError("Erro de conexão. Tente novamente.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div
      className="border-t border-slate-100 pt-5"
      data-testid="erp-credential"
    >
      <h3 className="text-sm font-semibold text-slate-900">Token / API Key</h3>
      <p className="mt-0.5 text-xs text-slate-500">
        Credencial usada para autenticar no ERP desta empresa. Armazenada
        criptografada; não é possível exibi-la novamente depois de salva.
      </p>

      {!status.encryptionAvailable && (
        <div
          role="alert"
          data-testid="credential-encryption-unavailable"
          className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          Criptografia de credenciais indisponível no servidor. Configure
          ERP_CREDENTIAL_ENCRYPTION_KEY para salvar credenciais.
        </div>
      )}

      {error && (
        <div
          role="alert"
          data-testid="credential-error"
          className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {error}
        </div>
      )}
      {notice && !error && (
        <div
          data-testid="credential-notice"
          className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700"
        >
          {notice}
        </div>
      )}

      <dl className="mt-4 space-y-2 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <dt className="text-slate-500">Status</dt>
          <dd data-testid="credential-status" className="font-medium">
            {status.configured ? (
              <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">
                Credencial configurada
              </span>
            ) : (
              <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">
                Não configurada
              </span>
            )}
          </dd>
        </div>
        {status.configured && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <dt className="text-slate-500">Token</dt>
              {/* The only fragment ever shown. */}
              <dd
                data-testid="credential-masked"
                className="font-mono text-slate-900"
              >
                ••••••••••{status.last4 ?? ""}
              </dd>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <dt className="text-slate-500">Atualizada em</dt>
              <dd data-testid="credential-updated-at" className="font-medium text-slate-900">
                {formatDate(status.updatedAt)}
              </dd>
            </div>
          </>
        )}
      </dl>

      {/*
        "Credencial configurada" is not "conexão validada". With no official
        ReceitaNet documentation there is no endpoint to verify against, so the
        UI states the distinction rather than implying the integration works.
      */}
      {status.configured && (
        <p className="mt-3 text-xs text-slate-500">
          Credencial configurada não significa conexão validada. A validação
          dependerá da documentação oficial da API do provedor.
        </p>
      )}

      {editing ? (
        <form onSubmit={save} className="mt-4 space-y-3">
          <div>
            <label
              htmlFor="erp-token"
              className="mb-1 block text-sm font-medium text-slate-700"
            >
              {status.configured ? "Novo token" : "Token"}
            </label>
            <input
              id="erp-token"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              disabled={busy !== null}
              data-testid="credential-input"
              className="w-full rounded-lg border border-slate-300 px-3 py-2.5 font-mono text-sm text-slate-900 focus:border-blue-500 focus:outline-none"
            />
          </div>
          <div className="flex flex-wrap gap-3">
            <button
              type="submit"
              disabled={busy !== null || !status.encryptionAvailable}
              data-testid="credential-save"
              className="rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy === "save" ? "Salvando..." : "Salvar"}
            </button>
            {status.configured && (
              <button
                type="button"
                onClick={() => {
                  setToken("");
                  setEditing(false);
                  setError(null);
                }}
                disabled={busy !== null}
                className="rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-700 disabled:opacity-60"
              >
                Cancelar
              </button>
            )}
          </div>
        </form>
      ) : (
        <div className="mt-4 flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => setEditing(true)}
            disabled={busy !== null}
            data-testid="credential-replace"
            className="rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-700 disabled:opacity-60"
          >
            Substituir
          </button>
          <button
            type="button"
            onClick={() => void remove()}
            disabled={busy !== null}
            data-testid="credential-remove"
            className="rounded-lg border border-red-200 px-4 py-2.5 text-sm font-semibold text-red-600 disabled:opacity-60"
          >
            {busy === "remove" ? "Removendo..." : "Remover"}
          </button>
        </div>
      )}
    </div>
  );
}
