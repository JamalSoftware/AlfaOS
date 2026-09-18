import type { Metadata } from "next";
import { companyTimezone } from "@/lib/company-timezone";
import { formatCompanyDate } from "@/lib/company-datetime";
import { requirePageSession } from "@/lib/guards";
import { PROFILE_LABELS } from "@/lib/navigation";
import { prisma } from "@/lib/prisma";

export const metadata: Metadata = {
  title: "Perfil",
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

export default async function ProfilePage() {
  const session = await requirePageSession();
  const timezone = await companyTimezone(session.companyId);

  const user = await prisma.user.findUnique({
    where: { id: session.id },
    include: { company: true },
  });

  if (!user) {
    return null;
  }

  const fields = [
    { label: "Nome", value: user.name },
    { label: "E-mail", value: user.email },
    { label: "Empresa", value: user.company.name },
    // O NOME do perfil, não o código do enum (RC-1D) — a mesma tabela da
    // listagem de usuários e do menu.
    { label: "Perfil de acesso", value: PROFILE_LABELS[user.profile] },
    { label: "Membro desde", value: formatDate(user.createdAt, timezone) },
  ];

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-fg">Perfil</h1>
        <p className="mt-1 text-sm text-fg-muted">
          Suas informações de acesso.
        </p>
      </div>

      <div className="max-w-lg rounded-2xl border border-border bg-surface p-6 shadow-sm">
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
      </div>
    </div>
  );
}
