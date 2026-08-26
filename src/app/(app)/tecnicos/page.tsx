import type { Metadata } from "next";
import Link from "next/link";
import { AccessProfile } from "@prisma/client";
import { requirePageProfile } from "@/lib/guards";
import { listCompanyTechnicians } from "@/lib/technicians";
import { EmptyState } from "@/components/EmptyState";
import { Pagination } from "@/components/Pagination";

export const metadata: Metadata = {
  title: "Técnicos",
};

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);
}

interface PageProps {
  searchParams: { [key: string]: string | string[] | undefined };
}

export default async function TechniciansPage({ searchParams }: PageProps) {
  const session = await requirePageProfile(["ADMIN", "DISPATCHER"]);
  // Only ADMIN can create technicians (POST /api/technicians).
  const isAdmin = session.profile === AccessProfile.ADMIN;

  const search = typeof searchParams.search === "string" ? searchParams.search : "";
  const activeRaw = typeof searchParams.active === "string" ? searchParams.active : "";
  const active = activeRaw === "true" ? true : activeRaw === "false" ? false : undefined;
  const page = Math.max(1, Number(searchParams.page ?? 1) || 1);
  const pageSize = 20;

  const result = await listCompanyTechnicians(session.companyId, {
    search: search || undefined,
    active,
    page,
    pageSize,
  });

  function buildHref(p: number): string {
    const params = new URLSearchParams();
    if (search) params.set("search", search);
    if (activeRaw) params.set("active", activeRaw);
    if (p > 1) params.set("page", String(p));
    const qs = params.toString();
    return qs ? `/tecnicos?${qs}` : "/tecnicos";
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-fg">Técnicos</h1>
          <p className="mt-1 text-sm text-fg-muted">
            Vincule usuários com perfil Técnico da sua empresa.
          </p>
        </div>
        {isAdmin && (
          <Link
            href="/tecnicos/novo"
            className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-fg transition-colors hover:bg-primary-hover"
          >
            Novo técnico
          </Link>
        )}
      </div>

      <form
        method="get"
        className="mb-4 flex flex-wrap items-center gap-3 rounded-2xl border border-border bg-surface p-4 shadow-sm"
      >
        <input
          type="search"
          name="search"
          defaultValue={search}
          placeholder="Buscar por nome..."
          className="min-w-0 flex-1 rounded-lg border border-input-border px-3 py-2 text-sm text-fg focus:border-focus focus:outline-none focus:ring-2 focus:ring-focus-soft"
        />
        <select
          name="active"
          defaultValue={activeRaw}
          className="rounded-lg border border-input-border px-3 py-2 text-sm text-fg focus:border-focus focus:outline-none focus:ring-2 focus:ring-focus-soft"
        >
          <option value="">Todos os status</option>
          <option value="true">Ativos</option>
          <option value="false">Inativos</option>
        </select>
        <button
          type="submit"
          className="rounded-lg border border-border px-4 py-2 text-sm font-semibold text-fg-secondary transition-colors hover:bg-surface-muted"
        >
          Filtrar
        </button>
      </form>

      <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
        {result.technicians.length === 0 ? (
          <EmptyState
            title="Nenhum técnico encontrado"
            description="Vincule um usuário com perfil Técnico para começar a atribuir OS."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-border text-sm">
              <thead className="bg-surface-subtle">
                <tr>
                  <th scope="col" className="px-5 py-3 text-left font-semibold text-fg-secondary">Nome</th>
                  <th scope="col" className="px-5 py-3 text-left font-semibold text-fg-secondary">E-mail</th>
                  <th scope="col" className="px-5 py-3 text-left font-semibold text-fg-secondary">Telefone</th>
                  <th scope="col" className="px-5 py-3 text-left font-semibold text-fg-secondary">Status</th>
                  <th scope="col" className="px-5 py-3 text-left font-semibold text-fg-secondary">Vinculado em</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {result.technicians.map((tech) => (
                  <tr key={tech.id} className="hover:bg-surface-subtle">
                    <td className="px-5 py-3 font-medium text-fg">{tech.name}</td>
                    <td className="px-5 py-3 text-fg-secondary">{tech.email}</td>
                    <td className="px-5 py-3 text-fg-secondary">{tech.phone ?? "—"}</td>
                    <td className="px-5 py-3">
                      {tech.active ? (
                        <span className="inline-flex items-center rounded-full bg-success-bg px-2.5 py-0.5 text-xs font-semibold text-success-fg">Ativo</span>
                      ) : (
                        <span className="inline-flex items-center rounded-full bg-surface-muted px-2.5 py-0.5 text-xs font-semibold text-fg-secondary">Inativo</span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-fg-muted">{formatDate(tech.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Pagination
        page={result.page}
        pageSize={result.pageSize}
        total={result.total}
        buildHref={buildHref}
      />
    </div>
  );
}
