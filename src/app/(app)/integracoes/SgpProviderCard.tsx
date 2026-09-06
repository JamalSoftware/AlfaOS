"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Configuração do SGP — teste candidato e ativação explícita.
 *
 * ## Por que o formulário guarda tudo em memória
 *
 * `Base URL`, `App` e `Token` vivem apenas no estado deste componente até a
 * ativação. Nada de `localStorage`, `sessionStorage` ou cookie: um token de ERP
 * guardado no navegador é um segredo publicado no aparelho de quem abriu a
 * página. Se o ADMIN sair antes de ativar, preenche de novo — o custo é um
 * formulário, e a alternativa é segredo persistido fora do cofre.
 *
 * ## Testar não ativa
 *
 * `TESTAR CONEXÃO` manda a configuração ao servidor, que monta um adapter em
 * memória e responde. **Nada é gravado.** `ATIVAR SGP` só aparece depois de um
 * teste bem-sucedido, e o servidor **reexecuta** o teste antes de trocar — o
 * resultado visto aqui não é aceito como prova.
 */
interface TestResult {
  ok: boolean;
  provider: string;
  latencyMs: number;
  message: string;
  reachable?: boolean;
  credentialValidated?: boolean;
}

export function SgpProviderCard({
  isActive,
  activationEnabled,
}: {
  isActive: boolean;
  /**
   * A ativação está liberada nesta instalação? Vem do SERVIDOR, e a tela é
   * consequência da regra — não a regra. Com `false`, o servidor recusa a
   * ativação de qualquer forma; esconder o botão evita que a pessoa descubra
   * isso depois de preencher o formulário inteiro.
   */
  activationEnabled: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [app, setApp] = useState("");
  const [token, setToken] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activated, setActivated] = useState(false);

  const filled = baseUrl.trim() && app.trim() && token.trim();

  async function call(action: "test" | "activate") {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/integrations/candidate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, provider: "SGP", baseUrl, app, token }),
      });
      const payload = await res.json();
      if (!res.ok) {
        setError(payload?.error ?? "Não foi possível concluir a operação.");
        return;
      }
      setResult(payload?.data?.result ?? null);
      if (action === "activate" && payload?.data?.activated) {
        setActivated(true);
        setConfirming(false);
        /**
         * O token sai da memória do formulário no instante em que passa a
         * viver cifrado no servidor. Deixá-lo no estado o manteria em memória
         * do navegador sem nenhuma razão.
         */
        setToken("");
        router.refresh();
      }
    } catch {
      setError("Erro de conexão. Tente novamente.");
    } finally {
      setLoading(false);
    }
  }

  const testedOk = result?.ok === true;

  return (
    <section
      className="mt-6 max-w-2xl rounded-2xl border border-border bg-surface p-6 shadow-sm"
      data-testid="provider-card-SGP"
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
            Provedor disponível
          </p>
          <h3 className="text-base font-semibold text-fg">SGP</h3>
        </div>
        {/*
          `ATIVO` só aparece quando o ERP da empresa É o SGP. Antes do switch
          confirmado ele é `DISPONÍVEL` — "suportado pelo AlfaOS" não é "em uso
          nesta empresa", e a tela não pode deixar a diferença ambígua.
        */}
        <span
          className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold ${
            isActive
              ? "bg-success-bg text-success-fg"
              : "bg-surface-muted text-fg-secondary"
          }`}
          data-testid="sgp-status"
        >
          {isActive ? "ATIVO" : activationEnabled ? "DISPONÍVEL" : "EM VALIDAÇÃO"}
        </span>
      </div>

      {/*
        O aviso vem ANTES do formulário, não depois do erro.

        Sem ele, a pessoa preenche Base URL, App e Token, testa com sucesso e
        só então descobre que ativar não é possível. Dizer antes é a diferença
        entre uma tela honesta e uma que desperdiça o trabalho de quem a usa.
      */}
      {!isActive && !activationEnabled && (
        <p
          data-testid="sgp-validation-notice"
          className="mb-4 rounded-lg border border-border bg-surface-muted px-3 py-2 text-sm text-fg-secondary"
        >
          Conexão SGP disponível para validação. A ativação operacional será
          liberada após a homologação com uma instalação real.
        </p>
      )}

      {isActive ? (
        <p className="text-sm text-fg-muted">
          O SGP é o ERP utilizado por esta empresa. Para configurar novamente,
          use o teste de conexão do ERP atual acima.
        </p>
      ) : !open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          data-testid="sgp-configure"
          className="rounded-lg border border-border px-4 py-2 text-sm font-semibold text-fg transition-colors hover:bg-surface-muted"
        >
          Configurar SGP
        </button>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-fg-muted">
            Os valores abaixo ficam apenas nesta tela até a ativação. Testar{" "}
            <strong>não</strong> altera o ERP em uso e <strong>não</strong>{" "}
            grava nada.
          </p>

          <div>
            <label
              htmlFor="sgp-base-url"
              className="mb-1 block text-sm font-medium text-fg-secondary"
            >
              Base URL
            </label>
            <input
              id="sgp-base-url"
              type="url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://sgp.suaempresa.net.br"
              data-testid="sgp-base-url"
              className="w-full rounded-lg border border-input-border px-3 py-2 text-sm text-fg focus:border-focus focus:outline-none focus:ring-2 focus:ring-focus-soft"
            />
          </div>

          <div>
            <label
              htmlFor="sgp-app"
              className="mb-1 block text-sm font-medium text-fg-secondary"
            >
              App
            </label>
            <input
              id="sgp-app"
              type="text"
              value={app}
              onChange={(e) => setApp(e.target.value)}
              placeholder="Nome da aplicação cadastrada no SGP"
              data-testid="sgp-app"
              className="w-full rounded-lg border border-input-border px-3 py-2 text-sm text-fg focus:border-focus focus:outline-none focus:ring-2 focus:ring-focus-soft"
            />
          </div>

          <div>
            <label
              htmlFor="sgp-token"
              className="mb-1 block text-sm font-medium text-fg-secondary"
            >
              Token
            </label>
            <input
              id="sgp-token"
              // `password` para o token não ficar legível na tela nem em captura.
              type="password"
              autoComplete="off"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              data-testid="sgp-token"
              className="w-full rounded-lg border border-input-border px-3 py-2 text-sm text-fg focus:border-focus focus:outline-none focus:ring-2 focus:ring-focus-soft"
            />
            <p className="mt-1 text-xs text-fg-muted">
              Gere um token somente leitura. Ele nunca é exibido de volta.
            </p>
          </div>

          <div className="flex flex-wrap gap-2 pt-1">
            <button
              type="button"
              onClick={() => call("test")}
              disabled={!filled || loading}
              data-testid="sgp-test"
              className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-fg transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loading ? "Testando..." : "Testar conexão"}
            </button>

            {/* `ATIVAR` só existe depois de um teste bem-sucedido — e só
                quando a ativação está liberada nesta instalação. */}
            {testedOk && !confirming && activationEnabled && (
              <button
                type="button"
                onClick={() => setConfirming(true)}
                disabled={loading}
                data-testid="sgp-activate"
                className="rounded-lg border border-border px-4 py-2 text-sm font-semibold text-fg transition-colors hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-60"
              >
                Ativar SGP
              </button>
            )}
          </div>

          {result && (
            <div
              data-testid="sgp-test-result"
              className={`rounded-lg border px-3 py-2 text-sm ${
                result.ok
                  ? "border-success-border bg-success-bg text-success-fg"
                  : "border-danger-border bg-danger-bg text-danger-fg"
              }`}
            >
              <p className="font-medium">
                {result.ok ? "Conexão OK" : "Falha na conexão"} (
                {result.latencyMs}ms)
              </p>
              <p className="mt-1">{result.message}</p>
              {result.ok && (
                <p className="mt-1 text-xs">
                  Teste de configuração candidata. O ERP em uso não mudou.
                </p>
              )}
            </div>
          )}

          {confirming && (
            <div
              role="alert"
              data-testid="sgp-confirm"
              className="rounded-lg border border-warning-border bg-warning-bg px-3 py-3 text-sm text-warning-fg"
            >
              <p className="font-medium">
                Alterar o ERP utilizado pela empresa para SGP?
              </p>
              <p className="mt-1 text-xs">
                A conexão será validada de novo no servidor antes da troca. As
                credenciais do provedor atual são preservadas.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => call("activate")}
                  disabled={loading}
                  data-testid="sgp-confirm-yes"
                  className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-fg transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {loading ? "Ativando..." : "Confirmar"}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  disabled={loading}
                  className="rounded-lg border border-border px-4 py-2 text-sm font-semibold text-fg transition-colors hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Cancelar
                </button>
              </div>
            </div>
          )}

          {activated && (
            <div
              data-testid="sgp-activated"
              className="rounded-lg border border-success-border bg-success-bg px-3 py-2 text-sm text-success-fg"
            >
              SGP ativado. É o ERP utilizado pela empresa a partir de agora.
            </div>
          )}

          {error && (
            <div
              data-testid="sgp-error"
              className="rounded-lg border border-danger-border bg-danger-bg px-3 py-2 text-sm text-danger-fg"
            >
              {error}
            </div>
          )}
        </div>
      )}

      <p className="mt-4 border-t border-border-subtle pt-3 text-xs text-fg-muted">
        Esta versão implementa apenas autenticação e teste de conexão. Busca de
        cliente, contratos, financeiro e ordens de serviço entram em fases
        próprias.
      </p>
    </section>
  );
}
