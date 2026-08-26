"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export type CredentialKindView = "CALLCENTER" | "CHATBOT";

export interface CredentialStatusView {
  provider: string;
  /** Qual API esta credencial abre. Cada bloco cuida só da sua. */
  kind: CredentialKindView;
  configured: boolean;
  last4: string | null;
  updatedAt: string | null;
  encryptionAvailable: boolean;
}

const KIND_LABEL: Record<CredentialKindView, string> = {
  CALLCENTER: "ReceitaNet CallCenter",
  CHATBOT: "ReceitaNet Chatbot",
};

const KIND_HINT: Record<CredentialKindView, string> = {
  CALLCENTER: "Busca de clientes, detalhe, verificar acesso e chamados.",
  CHATBOT: "Enriquecimento do cadastro e credencial PPPoE real do cliente.",
};

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
  const [busy, setBusy] = useState<null | "save" | "remove" | "test">(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /**
   * Resultado do teste DESTE bloco.
   *
   * Estado local por instância, e não um campo compartilhado da integração:
   * é o que impede o sucesso do CallCenter de fazer o Chatbot parecer
   * testado — os dois usam credenciais diferentes e podem falhar em
   * momentos diferentes.
   */
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    code: string;
    latencyMs: number;
    at: string;
  } | null>(null);

  async function testConnection() {
    if (busy) return;
    setBusy("test");
    setError(null);
    setNotice(null);
    // Resultado anterior sai da tela: um resultado velho sob um clique novo
    // é lido como resposta nova.
    setTestResult(null);
    try {
      const res = await fetch("/api/integrations/test-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        /**
         * A API é endereçada explicitamente. Este botão testa ESTA
         * credencial e nenhuma outra — sem fallback para o token do bloco
         * vizinho.
         */
        body: JSON.stringify({ provider: status.provider, kind: status.kind }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        setError(payload?.error ?? "Não foi possível testar a conexão.");
        return;
      }
      const result = payload?.data?.result;
      setTestResult({
        ok: result?.ok === true,
        code: payload?.data?.code ?? (result?.ok ? "OK" : "UNAVAILABLE"),
        latencyMs: typeof result?.latencyMs === "number" ? result.latencyMs : 0,
        at: new Date().toISOString(),
      });
    } catch {
      setError("Erro de conexão. Tente novamente.");
    } finally {
      setBusy(null);
    }
  }

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
        // A API é endereçada explicitamente: gravar uma credencial nunca
        // pode tocar a outra.
        body: JSON.stringify({ kind: status.kind, token }),
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
      setStatus((prev) => ({
        ...prev,
        configured: payload.data.credential.configured,
        last4: payload.data.credential.last4,
        updatedAt: payload.data.credential.updatedAt,
      }));
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
        body: JSON.stringify({ kind: status.kind }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        setError(payload?.error ?? "Não foi possível remover a credencial.");
        return;
      }
      // A resposta do DELETE traz o status das DUAS credenciais; este bloco
      // cuida exclusivamente da sua.
      const mine = payload.data.credentials?.find(
        (c: { kind: string }) => c.kind === status.kind,
      );
      setStatus((prev) => ({
        ...prev,
        configured: mine?.configured ?? false,
        last4: mine?.last4 ?? null,
        updatedAt: mine?.updatedAt ?? null,
      }));
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
      className="border-t border-border-subtle pt-5"
      data-testid={`erp-credential-${status.kind}`}
    >
      <h3 className="text-sm font-semibold text-fg">
        {KIND_LABEL[status.kind]}
      </h3>
      <p className="mt-0.5 text-xs text-fg-muted">{KIND_HINT[status.kind]}</p>
      <p className="mt-0.5 text-xs text-fg-muted">
        Credencial usada para autenticar no ERP desta empresa. Armazenada
        criptografada; não é possível exibi-la novamente depois de salva.
      </p>

      {!status.encryptionAvailable && (
        <div
          role="alert"
          data-testid="credential-encryption-unavailable"
          className="mt-3 rounded-lg border border-danger-border bg-danger-bg px-3 py-2 text-sm text-danger-fg"
        >
          Criptografia de credenciais indisponível no servidor. Configure
          ERP_CREDENTIAL_ENCRYPTION_KEY para salvar credenciais.
        </div>
      )}

      {error && (
        <div
          role="alert"
          data-testid="credential-error"
          className="mt-3 rounded-lg border border-danger-border bg-danger-bg px-3 py-2 text-sm text-danger-fg"
        >
          {error}
        </div>
      )}
      {notice && !error && (
        <div
          data-testid="credential-notice"
          className="mt-3 rounded-lg border border-success-border bg-success-bg px-3 py-2 text-sm text-success-fg"
        >
          {notice}
        </div>
      )}

      <dl className="mt-4 space-y-2 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <dt className="text-fg-muted">Status</dt>
          <dd data-testid="credential-status" className="font-medium">
            {status.configured ? (
              <span className="rounded-full bg-success-bg px-3 py-1 text-xs font-semibold text-success-fg">
                Credencial configurada
              </span>
            ) : (
              <span className="rounded-full bg-surface-muted px-3 py-1 text-xs font-semibold text-fg-secondary">
                Não configurada
              </span>
            )}
          </dd>
        </div>
        {status.configured && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <dt className="text-fg-muted">Token</dt>
              {/* The only fragment ever shown. */}
              <dd
                data-testid="credential-masked"
                className="font-mono text-fg"
              >
                ••••••••••{status.last4 ?? ""}
              </dd>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <dt className="text-fg-muted">Atualizada em</dt>
              <dd data-testid="credential-updated-at" className="font-medium text-fg">
                {formatDate(status.updatedAt)}
              </dd>
            </div>
          </>
        )}
      </dl>

      {/*
        “Credencial configurada” não é “conexão validada”. Agora existe um
        teste por credencial, então a tela mostra o resultado REAL desta API
        em vez de repetir a ressalva genérica.
      */}
      {status.configured && !testResult && (
        <p className="mt-3 text-xs text-fg-muted">
          Credencial configurada não significa conexão validada. Use “Testar
          conexão” para validar esta credencial.
        </p>
      )}

      {testResult && (
        <div
          data-testid="credential-test-result"
          className={`mt-3 rounded-lg border px-3 py-2 text-sm ${
            testResult.ok
              ? "border-success-border bg-success-bg text-success-fg"
              : "border-warning-border bg-warning-bg text-warning-fg"
          }`}
        >
          <p className="font-semibold">
            {testResult.ok
              ? `Conexão OK — ${testResult.latencyMs} ms`
              : `Falha — ${testResult.code}`}
          </p>
          <p className="mt-0.5 text-xs opacity-80">
            Último teste: {formatDate(testResult.at)}
          </p>
        </div>
      )}

      {editing ? (
        <form onSubmit={save} className="mt-4 space-y-3">
          <div>
            <label
              htmlFor="erp-token"
              className="mb-1 block text-sm font-medium text-fg-secondary"
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
              className="w-full rounded-lg border border-input-border px-3 py-2.5 font-mono text-sm text-fg focus:border-focus focus:outline-none"
            />
          </div>
          <div className="flex flex-wrap gap-3">
            <button
              type="submit"
              disabled={busy !== null || !status.encryptionAvailable}
              data-testid="credential-save"
              className="rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-fg disabled:cursor-not-allowed disabled:opacity-60"
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
                className="rounded-lg border border-input-border px-4 py-2.5 text-sm font-semibold text-fg-secondary disabled:opacity-60"
              >
                Cancelar
              </button>
            )}
          </div>
        </form>
      ) : (
        <div className="mt-4 flex flex-wrap gap-3">
          {/*
            Teste POR credencial. O botão genérico do topo prova o provider;
            este prova ESTA API — que é o que precisa ser demonstrado
            separadamente, já que cada uma tem token próprio.
          */}
          <button
            type="button"
            onClick={() => void testConnection()}
            disabled={busy !== null || !status.configured}
            data-testid="credential-test"
            className="rounded-lg border border-input-border px-4 py-2.5 text-sm font-semibold text-fg-secondary disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy === "test" ? "Testando..." : "Testar conexão"}
          </button>
          <button
            type="button"
            onClick={() => setEditing(true)}
            disabled={busy !== null}
            data-testid="credential-replace"
            className="rounded-lg border border-input-border px-4 py-2.5 text-sm font-semibold text-fg-secondary disabled:opacity-60"
          >
            Substituir
          </button>
          <button
            type="button"
            onClick={() => void remove()}
            disabled={busy !== null}
            data-testid="credential-remove"
            className="rounded-lg border border-danger-border px-4 py-2.5 text-sm font-semibold text-danger-fg disabled:opacity-60"
          >
            {busy === "remove" ? "Removendo..." : "Remover"}
          </button>
        </div>
      )}
    </div>
  );
}
