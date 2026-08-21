import type { Metadata } from "next";
import Link from "next/link";
import { requirePageProfile } from "@/lib/guards";
import { PROFILE_LABELS } from "@/lib/navigation";
import { listCompanyUsers } from "@/lib/users";
import { UserToggleButton } from "@/components/UserToggleButton";

export const metadata: Metadata = {
  title: "Usuários",
};

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);
}

export default async function UsersPage() {
  const session = await requirePageProfile(["ADMIN"]);
  const users = await listCompanyUsers(session.companyId);

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Usuários</h1>
          <p className="mt-1 text-sm text-slate-500">
            Gerencie os usuários da sua empresa.
          </p>
        </div>
        <Link
          href="/usuarios/novo"
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700"
        >
          Novo usuário
        </Link>
      </div>

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th
                  scope="col"
                  className="px-5 py-3 text-left font-semibold text-slate-600"
                >
                  Nome
                </th>
                <th
                  scope="col"
                  className="px-5 py-3 text-left font-semibold text-slate-600"
                >
                  E-mail
                </th>
                <th
                  scope="col"
                  className="px-5 py-3 text-left font-semibold text-slate-600"
                >
                  Perfil
                </th>
                <th
                  scope="col"
                  className="px-5 py-3 text-left font-semibold text-slate-600"
                >
                  Status
                </th>
                <th
                  scope="col"
                  className="px-5 py-3 text-left font-semibold text-slate-600"
                >
                  Criado em
                </th>
                <th
                  scope="col"
                  className="px-5 py-3 text-right font-semibold text-slate-600"
                >
                  Ações
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {users.map((user) => (
                <tr key={user.id} className="hover:bg-slate-50">
                  <td className="px-5 py-3 font-medium text-slate-900">
                    {user.name}
                  </td>
                  <td className="px-5 py-3 text-slate-600">{user.email}</td>
                  <td className="px-5 py-3">
                    <span className="inline-flex items-center rounded-full bg-blue-50 px-2.5 py-0.5 text-xs font-semibold text-blue-700">
                      {PROFILE_LABELS[user.profile]}
                    </span>
                  </td>
                  <td className="px-5 py-3">
                    {user.active ? (
                      <span className="inline-flex items-center rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-700">
                        Ativo
                      </span>
                    ) : (
                      <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-600">
                        Inativo
                      </span>
                    )}
                  </td>
                  <td className="px-5 py-3 text-slate-500">
                    {formatDate(user.createdAt)}
                  </td>
                  <td className="px-5 py-3 text-right">
                    <UserToggleButton
                      user={{
                        id: user.id,
                        name: user.name,
                        email: user.email,
                        profile: user.profile,
                        active: user.active,
                      }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
