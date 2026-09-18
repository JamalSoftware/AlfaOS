import type { Metadata } from "next";
import { companyTimezone } from "@/lib/company-timezone";
import { formatCompanyDate } from "@/lib/company-datetime";
import { requirePageProfile } from "@/lib/guards";
import { prisma } from "@/lib/prisma";

export const metadata: Metadata = {
  title: "Configurações",
};

/*
  Data no fuso da EMPRESA — `RC-1`, débito §12 ("datas gerais no fuso do
  servidor"). Sem `timeZone`, o `Intl` formata no fuso do PROCESSO, que em
  produção é UTC. O fuso é obrigatório na assinatura: quem esquecer não compila,
  em vez de cair no relógio do servidor em silêncio.
*/
function formatDate(date: Date, timezone: string): string {
  return formatCompanyDate(date, timezone);
}

export default async function SettingsPage() {
  const session = await requirePageProfile(["ADMIN"]);
  const timezone = await companyTimezone(session.companyId);

  const company = await prisma.company.findUnique({
    where: { id: session.companyId },
  });

  if (!company) {
    return null;
  }

  const fields = [
    { label: "Nome da empresa", value: company.name },
    { label: "Documento", value: company.document ?? "—" },
    { label: "Cadastrada em", value: formatDate(company.createdAt, timezone) },
  ];

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-fg">Configurações</h1>
        <p className="mt-1 text-sm text-fg-muted">
          Configurações da sua empresa. Apenas administradores têm acesso.
        </p>
      </div>

      <div className="max-w-lg rounded-2xl border border-border bg-surface p-6 shadow-sm">
        <h2 className="mb-4 text-base font-semibold text-fg">
          Dados da empresa
        </h2>
        <dl className="space-y-4">
          {fields.map((field) => (
            <div
              key={field.label}
              className="flex items-start justify-between gap-4 border-b border-border-subtle pb-3 last:border-0"
            >
              <dt className="text-sm font-medium text-fg-muted">
                {field.label}
              </dt>
              <dd className="text-right text-sm font-medium text-fg">
                {field.value}
              </dd>
            </div>
          ))}
        </dl>
        {/*
          RC-1D: aqui prometia-se "mais opções nas próximas versões" — uma
          promessa sem data numa tela de produto. O que a tela pode dizer é o
          que é verdade hoje: estes dados são somente leitura, e quem os altera
          é o suporte.
        */}
        <p className="mt-4 rounded-lg bg-surface-subtle px-3 py-2 text-xs text-fg-muted">
          Estes dados são somente leitura. Para corrigir o nome ou o documento
          da empresa, fale com o suporte do AlfaOS.
        </p>
      </div>
    </div>
  );
}
