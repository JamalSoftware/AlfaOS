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
          <h1 className="text-2xl font-bold text-fg">Usuários</h1>
          <p className="mt-1 text-sm text-fg-muted">
            Gerencie os usuários da sua empresa.
          </p>
        </div>
        <Link
          href="/usuarios/novo"
          className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-fg transition-colors hover:bg-primary-hover"
        >
          Novo usuário
        </Link>
      </div>

      <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-border text-sm">
            <thead className="bg-surface-subtle">
              <tr>
                <th
                  scope="col"
                  className="px-5 py-3 text-left font-semibold text-fg-secondary"
                >
                  Nome
                </th>
                <th
                  scope="col"
                  className="px-5 py-3 text-left font-semibold text-fg-secondary"
                >
                  E-mail
                </th>
                <th
                  scope="col"
                  className="px-5 py-3 text-left font-semibold text-fg-secondary"
                >
                  Perfil
                </th>
                <th
                  scope="col"
                  className="px-5 py-3 text-left font-semibold text-fg-secondary"
                >
                  Status
                </th>
                <th
                  scope="col"
                  className="px-5 py-3 text-left font-semibold text-fg-secondary"
                >
                  Criado em
                </th>
                <th
                  scope="col"
                  className="px-5 py-3 text-right font-semibold text-fg-secondary"
                >
                  Ações
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {users.map((user) => (
                <tr key={user.id} className="hover:bg-surface-subtle">
                  <td className="px-5 py-3 font-medium text-fg">
                    {user.name}
                  </td>
                  <td className="px-5 py-3 text-fg-secondary">{user.email}</td>
                  <td className="px-5 py-3">
                    <span className="inline-flex items-center rounded-full bg-info-bg px-2.5 py-0.5 text-xs font-semibold text-primary-text">
                      {PROFILE_LABELS[user.profile]}
                    </span>
                  </td>
                  <td className="px-5 py-3">
                    {user.active ? (
                      <span className="inline-flex items-center rounded-full bg-success-bg px-2.5 py-0.5 text-xs font-semibold text-success-fg">
                        Ativo
                      </span>
                    ) : (
                      <span className="inline-flex items-center rounded-full bg-surface-muted px-2.5 py-0.5 text-xs font-semibold text-fg-secondary">
                        Inativo
                      </span>
                    )}
                  </td>
                  <td className="px-5 py-3 text-fg-muted">
                    {formatDate(user.createdAt)}
                  </td>
                  <td className="px-5 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <Link
                        href={`/usuarios/${user.id}/editar`}
                        className="rounded-md border border-border px-3 py-1.5 text-xs font-semibold text-fg-secondary transition-colors hover:bg-surface-muted"
                      >
                        Editar
                      </Link>
                      <UserToggleButton
                        user={{
                          id: user.id,
                          name: user.name,
                          email: user.email,
                          profile: user.profile,
                          active: user.active,
                        }}
                        disabledReason={
                          user.id === session.id
                            ? "Você não pode desativar a própria conta."
                            : undefined
                        }
                      />
                    </div>
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
