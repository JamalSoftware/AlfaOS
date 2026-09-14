import type { Metadata } from "next";
import type { ERPProvider } from "@prisma/client";
import { requirePageProfile } from "@/lib/guards";
import { prisma } from "@/lib/prisma";
import { getCredentialStatus } from "@/lib/erp-credentials";
import { listCredentialStatus } from "@/lib/erp-credential-store";
import { TestConnectionButton } from "./TestConnectionButton";
import { IntegrationToggle } from "./IntegrationToggle";
import { ErpCredentialForm } from "./ErpCredentialForm";
import { ActiveProviderSwitch } from "./ActiveProviderSwitch";
import { isSgpActivationEnabled } from "@/lib/erp-provisioning";
import { isMockErpEnabled } from "@/integrations/mock-availability";
import { SgpProviderCard } from "./SgpProviderCard";

export const metadata: Metadata = {
  title: "Integrações",
};

function formatDate(date: Date | null): string {
  if (!date) return "—";
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function testStatusBadge(status: string | null) {
  if (status === "OK") {
    return (
      <span className="inline-flex items-center rounded-full bg-success-bg px-3 py-1 text-xs font-semibold text-success-fg">
        Sucesso
      </span>
    );
  }
  if (status === "ERROR") {
    return (
      <span className="inline-flex items-center rounded-full bg-danger-bg px-3 py-1 text-xs font-semibold text-danger-fg">
        Falha
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-surface-muted px-3 py-1 text-xs font-semibold text-fg-secondary">
      Nunca testado
    </span>
  );
}

/**
 * Nome de exibição por provider.
 *
 * Identidade técnica continua sendo o enum `ERPProvider`; isto é só o
 * rótulo que o operador lê.
 */
const PROVIDER_LABEL: Record<ERPProvider, string> = {
  MOCK: "Mock ERP",
  RECEITANET: "ReceitaNet",
  SGP: "SGP",
};

/**
 * Catálogo dos provedores que o AlfaOS suporta.
 *
 * **"Disponível no AlfaOS" não é "ativo nesta empresa".** A empresa usa UM, e o
 * bloco "ERP atual" diz qual. Este catálogo alimenta apenas a troca explícita —
 * ele lista opções, não estados.
 */
const PROVIDER_OPTIONS = (Object.keys(PROVIDER_LABEL) as ERPProvider[])
  /**
   * O SGP sai do seletor genérico de propósito.
   *
   * Ativá-lo exige Base URL, App e Token, e esse fluxo vive no card próprio —
   * com validação de SSRF, reteste no servidor e gravação transacional.
   * Oferecê-lo aqui daria ao ADMIN um caminho que só pode terminar em recusa.
   */
  .filter((value) => value !== "SGP")
  .map((value) => ({ value, label: PROVIDER_LABEL[value] }));

export default async function IntegrationsPage() {
  const session = await requirePageProfile(["ADMIN"]);

  const integration = await prisma.eRPIntegration.findUnique({
    where: { companyId: session.companyId },
  });

  const enabled = integration?.enabled ?? false;

  /*
    Em produção o Mock não existe (RC-OPS-03): sai das duas listas de escolha,
    e a linha `MOCK` — que continua sendo como uma empresa nova começa, antes
    de escolher o ERP de verdade — é apresentada pelo que ela é: nenhum ERP
    configurado. Anunciá-la como "Mock ERP · ATIVO" seria afirmar que a empresa
    usa um sistema que ela não tem.
  */
  const mockErp = isMockErpEnabled();
  const providerOptions = PROVIDER_OPTIONS.filter(
    (option) => mockErp || option.value !== "MOCK",
  );
  const semErpConfigurado =
    !mockErp && (integration?.provider ?? "MOCK") === "MOCK";
  /**
   * `getCredentialStatus` continua sendo consultado apenas para saber se a
   * criptografia está disponível no servidor — informação de ambiente, não
   * credencial. Os slots vêm do store operacional.
   */
  const credential = await getCredentialStatus(session.companyId);
  const slots = await listCredentialStatus(
    session.companyId,
    integration?.provider ?? "MOCK",
    ["CALLCENTER", "CHATBOT"],
  );
  const slotOf = (kind: "CALLCENTER" | "CHATBOT") =>
    slots.find((s) => s.kind === kind);

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-fg">Integrações</h1>
        <p className="mt-1 text-sm text-fg-muted">
          Conexão do AlfaOS com sistemas externos (ERPs).
        </p>
      </div>

      <div className="max-w-2xl rounded-2xl border border-border bg-surface p-6 shadow-sm">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div>
            {/*
              Rótulo DERIVADO do provider, não lido de `integration.name`.
              Aquela coluna só era escrita na criação, então uma troca de
              provider a deixava obsoleta e a tela anunciava o provedor
              errado. Derivar aqui torna a divergência impossível.
            */}
            <p className="text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
              ERP atual
            </p>
            {/*
              O selo fica FORA do `h2`. `integration-name` identifica o nome do
              provedor, e só ele — enfiar um estado ali faria o seletor passar a
              casar "ReceitaNetATIVO", que não é o nome de provedor nenhum.
            */}
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold text-fg" data-testid="integration-name">
                {semErpConfigurado
                  ? "Nenhum ERP configurado"
                  : PROVIDER_LABEL[integration?.provider ?? "MOCK"]}
              </h2>
              {!semErpConfigurado && (
                <span
                  className="inline-flex items-center rounded-full bg-primary-bg px-2 py-0.5 text-[11px] font-semibold text-primary-text"
                  data-testid="integration-active-badge"
                >
                  ATIVO
                </span>
              )}
            </div>
            {!semErpConfigurado && (
              <p className="mt-0.5 text-xs text-fg-muted">
                Provedor: {integration?.provider ?? "MOCK"}
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <span
              className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold ${
                enabled
                  ? "bg-success-bg text-success-fg"
                  : "bg-surface-muted text-fg-secondary"
              }`}
              data-testid="integration-enabled"
            >
              {enabled ? "Habilitada" : "Desabilitada"}
            </span>
            <IntegrationToggle enabled={enabled} />
          </div>
        </div>

        <dl className="mb-5 space-y-3 border-t border-border-subtle pt-4">
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <dt className="text-fg-muted">Último teste</dt>
            <dd className="font-medium text-fg">
              {formatDate(integration?.lastTestedAt ?? null)}
            </dd>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <dt className="text-fg-muted">Resultado do último teste</dt>
            <dd data-testid="integration-last-test">
              {testStatusBadge(integration?.lastTestStatus ?? null)}
            </dd>
          </div>
        </dl>

        <TestConnectionButton
          currentProvider={integration?.provider ?? "MOCK"}
          providers={providerOptions}
        />
        <p className="mt-3 text-xs text-fg-muted">
          O teste verifica a conectividade com o ERP. Ele{" "}
          <strong>não</strong> habilita a integração, <strong>não</strong>{" "}
          altera o ERP ativo e <strong>não</strong> apaga credencial. Habilitar
          e alterar são ações separadas e explícitas.
        </p>

        {/*
          Trocar o ERP ativo é a ÚNICA operação que escreve
          `ERPIntegration.provider`, e por isso tem controle próprio. Antes da
          `ERP-1` ela acontecia dentro do teste de conexão.
        */}
        <div className="mb-5 mt-5 border-t border-border-subtle pt-4">
          <ActiveProviderSwitch
            currentProvider={integration?.provider ?? "MOCK"}
            options={providerOptions}
            semErpAtual={semErpConfigurado}
          />
        </div>

        {/*
          Only the STATUS crosses to the client — provider, a boolean, the last
          four characters and a timestamp. The token itself never reaches this
          payload, so it is not in the page's HTML either.
        */}
        {/*
          Um bloco por API. Cada um endereça exclusivamente a sua credencial:
          gravar, testar ou remover uma NUNCA toca a outra — o isolamento é
          estrutural (uma linha por credencial), e a tela apenas o reflete.
        */}
        {(["CALLCENTER", "CHATBOT"] as const).map((kind) => (
          <div key={kind} className="mt-4 border-t border-border-subtle pt-4 first:mt-0 first:border-0 first:pt-0">
            <ErpCredentialForm
              initialStatus={{
                provider: integration?.provider ?? "MOCK",
                kind,
                configured: slotOf(kind)?.configured ?? false,
                last4: slotOf(kind)?.last4 ?? null,
                updatedAt: slotOf(kind)?.updatedAt?.toISOString() ?? null,
                encryptionAvailable: credential.encryptionAvailable,
              }}
            />
          </div>
        ))}
      </div>

      {/*
        Catálogo: o SGP é um provedor que o AlfaOS suporta. Ele só aparece como
        `ATIVO` depois da troca confirmada — "disponível no AlfaOS" não é "em uso
        nesta empresa".
      */}
      <SgpProviderCard
        isActive={integration?.provider === "SGP"}
        activationEnabled={isSgpActivationEnabled()}
      />

      <div className="mt-6 max-w-2xl rounded-2xl border border-border bg-surface p-6 shadow-sm">
        <h3 className="mb-2 text-sm font-semibold text-fg">
          ReceitaNet — o que está integrado
        </h3>
        <ul className="list-disc space-y-1 pl-5 text-sm text-fg-muted">
          <li>
            <strong>CallCenter</strong> — busca de clientes, detalhe,
            verificação de acesso e chamados abertos. Somente leitura.
          </li>
          <li>
            <strong>Chatbot</strong> — enriquecimento do cadastro e credencial
            PPPoE real do cliente. Somente leitura.
          </li>
        </ul>
        <p className="mt-3 text-xs text-fg-muted">
          Cada API tem credencial própria, com ciclo de vida independente:
          configurar, testar ou remover uma nunca afeta a outra. Nenhuma
          operação que altere dados no ReceitaNet está implementada.
        </p>
      </div>
    </div>
  );
}
