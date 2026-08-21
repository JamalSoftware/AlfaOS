import type { Metadata } from "next";
import { requirePageProfile } from "@/lib/guards";
import { prisma } from "@/lib/prisma";

export const metadata: Metadata = {
  title: "Configurações",
};

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);
}

export default async function SettingsPage() {
  const session = await requirePageProfile(["ADMIN"]);

  const company = await prisma.company.findUnique({
    where: { id: session.companyId },
  });

  if (!company) {
    return null;
  }

  const fields = [
    { label: "Nome da empresa", value: company.name },
    { label: "Documento", value: company.document ?? "—" },
    { label: "Cadastrada em", value: formatDate(company.createdAt) },
  ];

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">Configurações</h1>
        <p className="mt-1 text-sm text-slate-500">
          Configurações da sua empresa. Apenas administradores têm acesso.
        </p>
      </div>

      <div className="max-w-lg rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="mb-4 text-base font-semibold text-slate-900">
          Dados da empresa
        </h2>
        <dl className="space-y-4">
          {fields.map((field) => (
            <div
              key={field.label}
              className="flex items-start justify-between gap-4 border-b border-slate-100 pb-3 last:border-0"
            >
              <dt className="text-sm font-medium text-slate-500">
                {field.label}
              </dt>
              <dd className="text-right text-sm font-medium text-slate-900">
                {field.value}
              </dd>
            </div>
          ))}
        </dl>
        <p className="mt-4 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
          Mais opções de configuração serão adicionadas nas próximas versões.
        </p>
      </div>
    </div>
  );
}
