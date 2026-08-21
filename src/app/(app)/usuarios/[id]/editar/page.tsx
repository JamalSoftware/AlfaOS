import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePageProfile } from "@/lib/guards";
import { getCompanyUser } from "@/lib/users";
import { EditUserForm } from "./EditUserForm";

export const metadata: Metadata = {
  title: "Editar usuário",
};

export default async function EditUserPage({
  params,
}: {
  params: { id: string };
}) {
  const session = await requirePageProfile(["ADMIN"]);
  const user = await getCompanyUser(session.companyId, params.id);

  if (!user) {
    notFound();
  }

  return (
    <div>
      <div className="mb-6">
        <Link
          href="/usuarios"
          className="text-sm font-medium text-blue-600 hover:text-blue-700"
        >
          ← Voltar para usuários
        </Link>
        <h1 className="mt-2 text-2xl font-bold text-slate-900">
          Editar usuário
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Altere as informações de {user.name}.
        </p>
      </div>

      <div className="max-w-lg rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <EditUserForm
          user={{
            id: user.id,
            name: user.name,
            email: user.email,
            profile: user.profile,
            active: user.active,
          }}
        />
      </div>
    </div>
  );
}
