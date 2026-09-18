import type { Metadata } from "next";
import Link from "next/link";
import { AccessProfile } from "@prisma/client";
import { companyTimezone } from "@/lib/company-timezone";
import { formatCompanyDate } from "@/lib/company-datetime";
import { requirePageProfile } from "@/lib/guards";
import { listCompanyTechnicians } from "@/lib/technicians";
import { sliceEmptyState } from "@/lib/dashboard-slice-copy";
import { BackToDashboardLink } from "@/components/BackToDashboardLink";
import { EmptyState } from "@/components/EmptyState";
import { ListSliceBanner } from "@/components/ListSliceBanner";
import { Pagination } from "@/components/Pagination";

export const metadata: Metadata = {
  title: "Técnicos",
};

// "Vinculado em" no fuso da EMPRESA (`RC-1`, débito §12): sem `timeZone`, o
// `Intl` formata no fuso do processo — em produção, UTC.

interface PageProps {
  searchParams: { [key: string]: string | string[] | undefined };
}

export default async function TechniciansPage({ searchParams }: PageProps) {
  const session = await requirePageProfile(["ADMIN", "DISPATCHER"]);
  const timezone = await companyTimezone(session.companyId);
  // Only ADMIN can create technicians (POST /api/technicians).
  const isAdmin = session.profile === AccessProfile.ADMIN;

  const search = typeof searchParams.search === "string" ? searchParams.search : "";
  const activeRaw = typeof searchParams.active === "string" ? searchParams.active : "";
  const active = activeRaw === "true" ? true : activeRaw === "false" ? false : undefined;
  // Recorte do painel (DASH-1): só quem tem OS em atendimento agora.
  const inService = searchParams.emAtendimento === "true";
  const page = Math.max(1, Number(searchParams.page ?? 1) || 1);
  const pageSize = 20;

  const result = await listCompanyTechnicians(session.companyId, {
    search: search || undefined,
    active,
    inService,
    page,
    pageSize,
  });

  function buildHref(p: number, semRecorte = false): string {
    const params = new URLSearchParams();
    if (inService && !semRecorte) params.set("emAtendimento", "true");
    if (search) params.set("search", search);
    if (activeRaw) params.set("active", activeRaw);
    if (p > 1) params.set("page", String(p));
    const qs = params.toString();
    return qs ? `/tecnicos?${qs}` : "/tecnicos";
  }

  const empty = inService
    ? sliceEmptyState("tecnicos-em-atendimento", Boolean(search || activeRaw))
    : {
        title: "Nenhum técnico encontrado",
        description:
          "Vincule um usuário com perfil Técnico para começar a atribuir OS.",
      };
  const inServiceCounts = result.inServiceCounts;

  return (
    <div>
      {inService && <BackToDashboardLink />}
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

      {inService && (
        <ListSliceBanner
          sliceKey="tecnicos-em-atendimento"
          total={result.total}
          clearHref={buildHref(1, true)}
        />
      )}

      <form
        method="get"
        className="mb-4 flex flex-wrap items-center gap-3 rounded-2xl border border-border bg-surface p-4 shadow-sm"
      >
        {inService && <input type="hidden" name="emAtendimento" value="true" />}
        {/* RC-1D: `placeholder` não é rótulo — ele some ao digitar. */}
        <input
          type="search"
          name="search"
          aria-label="Buscar técnicos por nome"
          defaultValue={search}
          placeholder="Buscar por nome..."
          className="min-w-0 flex-1 rounded-lg border border-input-border px-3 py-2 text-sm text-fg focus:border-focus focus:outline-none focus:ring-2 focus:ring-focus-soft"
        />
        <select
          name="active"
          aria-label="Filtrar por situação do técnico"
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
          <EmptyState title={empty.title} description={empty.description} />
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-border text-sm">
              <thead className="bg-surface-subtle">
                <tr>
                  <th scope="col" className="px-5 py-3 text-left font-semibold text-fg-secondary">Nome</th>
                  {/*
                    No recorte, a razão de o técnico estar na lista vem logo
                    depois do nome. O status cadastral (Ativo/Inativo) continua
                    na sua coluna: um técnico inativo com OS iniciada antes da
                    desativação ainda está em atendimento, e a lista diz as duas
                    coisas sem misturá-las.
                  */}
                  {inServiceCounts && (
                    <th scope="col" className="px-5 py-3 text-left font-semibold text-fg-secondary">Em atendimento</th>
                  )}
                  <th scope="col" className="px-5 py-3 text-left font-semibold text-fg-secondary">E-mail</th>
                  <th scope="col" className="px-5 py-3 text-left font-semibold text-fg-secondary">Telefone</th>
                  <th scope="col" className="px-5 py-3 text-left font-semibold text-fg-secondary">
                    {inServiceCounts ? "Status cadastral" : "Status"}
                  </th>
                  <th scope="col" className="px-5 py-3 text-left font-semibold text-fg-secondary">Vinculado em</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {result.technicians.map((tech) => (
                  <tr key={tech.id} className="hover:bg-surface-subtle">
                    <td className="px-5 py-3 font-medium text-fg">{tech.name}</td>
                    {inServiceCounts && (
                      <td className="px-5 py-3 text-fg" data-testid="tech-in-service">
                        <span className="font-semibold tabular-nums">{inServiceCounts[tech.id] ?? 0}</span>{" "}
                        OS em atendimento
                      </td>
                    )}
                    <td className="px-5 py-3 text-fg-secondary">{tech.email}</td>
                    <td className="px-5 py-3 text-fg-secondary">{tech.phone ?? "—"}</td>
                    <td className="px-5 py-3">
                      {tech.active ? (
                        <span className="inline-flex items-center rounded-full bg-success-bg px-2.5 py-0.5 text-xs font-semibold text-success-fg">Ativo</span>
                      ) : (
                        <span className="inline-flex items-center rounded-full bg-surface-muted px-2.5 py-0.5 text-xs font-semibold text-fg-secondary">Inativo</span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-fg-muted">{formatCompanyDate(tech.createdAt, timezone)}</td>
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
