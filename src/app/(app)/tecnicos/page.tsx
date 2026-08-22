import type { Metadata } from "next";
import Link from "next/link";
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
          <h1 className="text-2xl font-bold text-slate-900">Técnicos</h1>
          <p className="mt-1 text-sm text-slate-500">
            Vincule usuários com perfil Técnico da sua empresa.
          </p>
        </div>
        <Link
          href="/tecnicos/novo"
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700"
        >
          Novo técnico
        </Link>
      </div>

      <form
        method="get"
        className="mb-4 flex flex-wrap items-center gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
      >
        <input
          type="search"
          name="search"
          defaultValue={search}
          placeholder="Buscar por nome..."
          className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100"
        />
        <select
          name="active"
          defaultValue={activeRaw}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100"
        >
          <option value="">Todos os status</option>
          <option value="true">Ativos</option>
          <option value="false">Inativos</option>
        </select>
        <button
          type="submit"
          className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-600 transition-colors hover:bg-slate-100"
        >
          Filtrar
        </button>
      </form>

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        {result.technicians.length === 0 ? (
          <EmptyState
            title="Nenhum técnico encontrado"
            description="Vincule um usuário com perfil Técnico para começar a atribuir OS."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th scope="col" className="px-5 py-3 text-left font-semibold text-slate-600">Nome</th>
                  <th scope="col" className="px-5 py-3 text-left font-semibold text-slate-600">E-mail</th>
                  <th scope="col" className="px-5 py-3 text-left font-semibold text-slate-600">Telefone</th>
                  <th scope="col" className="px-5 py-3 text-left font-semibold text-slate-600">Status</th>
                  <th scope="col" className="px-5 py-3 text-left font-semibold text-slate-600">Vinculado em</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {result.technicians.map((tech) => (
                  <tr key={tech.id} className="hover:bg-slate-50">
                    <td className="px-5 py-3 font-medium text-slate-900">{tech.name}</td>
                    <td className="px-5 py-3 text-slate-600">{tech.email}</td>
                    <td className="px-5 py-3 text-slate-600">{tech.phone ?? "—"}</td>
                    <td className="px-5 py-3">
                      {tech.active ? (
                        <span className="inline-flex items-center rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-700">Ativo</span>
                      ) : (
                        <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-600">Inativo</span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-slate-500">{formatDate(tech.createdAt)}</td>
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
