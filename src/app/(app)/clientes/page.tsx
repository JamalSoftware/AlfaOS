import type { Metadata } from "next";
import Link from "next/link";
import { requirePageProfile } from "@/lib/guards";
import { listCompanyCustomers } from "@/lib/customers";
import { EmptyState } from "@/components/EmptyState";
import { Pagination } from "@/components/Pagination";

export const metadata: Metadata = {
  title: "Clientes",
};

interface PageProps {
  searchParams: { [key: string]: string | string[] | undefined };
}

export default async function CustomersPage({ searchParams }: PageProps) {
  const session = await requirePageProfile(["ADMIN", "DISPATCHER"]);

  const search = typeof searchParams.search === "string" ? searchParams.search : "";
  const activeRaw = typeof searchParams.active === "string" ? searchParams.active : "";
  const active = activeRaw === "true" ? true : activeRaw === "false" ? false : undefined;
  const page = Math.max(1, Number(searchParams.page ?? 1) || 1);
  const pageSize = 20;

  const result = await listCompanyCustomers(session.companyId, {
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
    return qs ? `/clientes?${qs}` : "/clientes";
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-fg">Clientes</h1>
          <p className="mt-1 text-sm text-fg-muted">
            Gerencie os clientes da sua empresa.
          </p>
        </div>
        <Link
          href="/clientes/novo"
          className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-fg transition-colors hover:bg-primary-hover"
        >
          Novo cliente
        </Link>
      </div>

      <form
        method="get"
        className="mb-4 flex flex-wrap items-center gap-3 rounded-2xl border border-border bg-surface p-4 shadow-sm"
      >
        <input
          type="search"
          name="search"
          defaultValue={search}
          placeholder="Buscar por nome, documento, e-mail ou telefone..."
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
        {result.customers.length === 0 ? (
          <EmptyState
            title="Nenhum cliente encontrado"
            description="Crie um cliente manualmente ou importe OS do Mock ERP para gerar clientes automaticamente."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-border text-sm">
              <thead className="bg-surface-subtle">
                <tr>
                  <th scope="col" className="px-5 py-3 text-left font-semibold text-fg-secondary">Nome</th>
                  <th scope="col" className="px-5 py-3 text-left font-semibold text-fg-secondary">Documento</th>
                  <th scope="col" className="px-5 py-3 text-left font-semibold text-fg-secondary">Telefone</th>
                  <th scope="col" className="px-5 py-3 text-left font-semibold text-fg-secondary">Cidade</th>
                  <th scope="col" className="px-5 py-3 text-left font-semibold text-fg-secondary">Status</th>
                  <th scope="col" className="px-5 py-3 text-right font-semibold text-fg-secondary">Ações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {result.customers.map((customer) => (
                  <tr key={customer.id} className="hover:bg-surface-subtle">
                    <td className="px-5 py-3 font-medium text-fg">{customer.name}</td>
                    <td className="px-5 py-3 text-fg-secondary">{customer.document ?? "—"}</td>
                    <td className="px-5 py-3 text-fg-secondary">{customer.phone ?? "—"}</td>
                    <td className="px-5 py-3 text-fg-secondary">
                      {customer.city ? `${customer.city}${customer.state ? `/${customer.state}` : ""}` : "—"}
                    </td>
                    <td className="px-5 py-3">
                      {customer.active ? (
                        <span className="inline-flex items-center rounded-full bg-success-bg px-2.5 py-0.5 text-xs font-semibold text-success-fg">Ativo</span>
                      ) : (
                        <span className="inline-flex items-center rounded-full bg-surface-muted px-2.5 py-0.5 text-xs font-semibold text-fg-secondary">Inativo</span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-right">
                      <Link
                        href={`/clientes/${customer.id}/editar`}
                        className="inline-block rounded-md border border-border px-3 py-1.5 text-xs font-semibold text-fg-secondary transition-colors hover:bg-surface-muted"
                      >
                        Editar
                      </Link>
                    </td>
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
