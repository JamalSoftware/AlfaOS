import type { Metadata } from "next";
import { requirePageProfile } from "@/lib/guards";
import { prisma } from "@/lib/prisma";
import { getCredentialStatus } from "@/lib/erp-credentials";
import { TestConnectionButton } from "./TestConnectionButton";
import { IntegrationToggle } from "./IntegrationToggle";
import { ErpCredentialForm } from "./ErpCredentialForm";

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
      <span className="inline-flex items-center rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">
        Sucesso
      </span>
    );
  }
  if (status === "ERROR") {
    return (
      <span className="inline-flex items-center rounded-full bg-red-50 px-3 py-1 text-xs font-semibold text-red-700">
        Falha
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">
      Nunca testado
    </span>
  );
}

export default async function IntegrationsPage() {
  const session = await requirePageProfile(["ADMIN"]);

  const integration = await prisma.eRPIntegration.findUnique({
    where: { companyId: session.companyId },
  });

  const enabled = integration?.enabled ?? false;
  const credential = await getCredentialStatus(session.companyId);

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">Integrações</h1>
        <p className="mt-1 text-sm text-slate-500">
          Conexão do AlfaOS com sistemas externos (ERPs).
        </p>
      </div>

      <div className="max-w-2xl rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              {integration?.name ?? "Mock ERP"}
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Provedor: {integration?.provider ?? "MOCK"}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <span
              className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold ${
                enabled
                  ? "bg-emerald-50 text-emerald-700"
                  : "bg-slate-100 text-slate-600"
              }`}
              data-testid="integration-enabled"
            >
              {enabled ? "Habilitada" : "Desabilitada"}
            </span>
            <IntegrationToggle enabled={enabled} />
          </div>
        </div>

        <dl className="mb-5 space-y-3 border-t border-slate-100 pt-4">
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <dt className="text-slate-500">Último teste</dt>
            <dd className="font-medium text-slate-900">
              {formatDate(integration?.lastTestedAt ?? null)}
            </dd>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <dt className="text-slate-500">Resultado do último teste</dt>
            <dd data-testid="integration-last-test">
              {testStatusBadge(integration?.lastTestStatus ?? null)}
            </dd>
          </div>
        </dl>

        <TestConnectionButton currentProvider={integration?.provider ?? "MOCK"} />
        <p className="mb-5 mt-3 text-xs text-slate-500">
          O teste de conexão verifica a conectividade com o ERP, mas não
          habilita a integração. A habilitação é uma ação separada e explícita.
        </p>

        {/*
          Only the STATUS crosses to the client — provider, a boolean, the last
          four characters and a timestamp. The token itself never reaches this
          payload, so it is not in the page's HTML either.
        */}
        <ErpCredentialForm
          initialStatus={{
            provider: credential.provider,
            configured: credential.configured,
            last4: credential.last4,
            updatedAt: credential.updatedAt?.toISOString() ?? null,
            encryptionAvailable: credential.encryptionAvailable,
          }}
        />
      </div>

      <div className="mt-6 max-w-2xl rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h3 className="mb-2 text-sm font-semibold text-slate-900">
          ReceitaNet (futuro)
        </h3>
        <p className="text-sm text-slate-500">
          A integração real com o ERP ReceitaNet será implementada após o
          recebimento da documentação oficial da API. O AlfaOS já possui a
          arquitetura desacoplada (contrato de integração + adapters) pronta
          para recebê-la.
        </p>
      </div>
    </div>
  );
}
