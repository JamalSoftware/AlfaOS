import type { Metadata } from "next";
import { requirePageSession } from "@/lib/guards";
import { prisma } from "@/lib/prisma";

export const metadata: Metadata = {
  title: "Perfil",
};

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);
}

export default async function ProfilePage() {
  const session = await requirePageSession();

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
    { label: "Perfil de acesso", value: user.profile },
    { label: "Membro desde", value: formatDate(user.createdAt) },
  ];

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">Perfil</h1>
        <p className="mt-1 text-sm text-slate-500">
          Suas informações de acesso.
        </p>
      </div>

      <div className="max-w-lg rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
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
      </div>
    </div>
  );
}
