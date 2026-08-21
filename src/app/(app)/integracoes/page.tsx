import type { Metadata } from "next";
import { requirePageProfile } from "@/lib/guards";
import { prisma } from "@/lib/prisma";
import { TestConnectionButton } from "./TestConnectionButton";

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

export default async function IntegrationsPage() {
  const session = await requirePageProfile(["ADMIN"]);

  const integration = await prisma.eRPIntegration.findUnique({
    where: { companyId: session.companyId },
  });

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">Integrações</h1>
        <p className="mt-1 text-sm text-slate-500">
          Conexão do AlfaOS com sistemas externos (ERPs).
        </p>
      </div>

      <div className="max-w-2xl rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="mb-5 flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              {integration?.name ?? "Mock ERP"}
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Provedor: {integration?.provider ?? "MOCK"}
            </p>
          </div>
          <span
            className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold ${
              integration?.enabled
                ? "bg-emerald-50 text-emerald-700"
                : "bg-slate-100 text-slate-600"
            }`}
          >
            {integration?.enabled ? "Ativa" : "Inativa"}
          </span>
        </div>

        <dl className="mb-5 space-y-3 border-t border-slate-100 pt-4">
          <div className="flex justify-between text-sm">
            <dt className="text-slate-500">Último teste</dt>
            <dd className="font-medium text-slate-900">
              {formatDate(integration?.lastTestedAt ?? null)}
            </dd>
          </div>
          <div className="flex justify-between text-sm">
            <dt className="text-slate-500">Status do último teste</dt>
            <dd className="font-medium text-slate-900">
              {integration?.lastTestStatus ?? "Nunca testado"}
            </dd>
          </div>
        </dl>

        <TestConnectionButton />
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
