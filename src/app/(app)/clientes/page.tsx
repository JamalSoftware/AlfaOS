import type { Metadata } from "next";
import Link from "next/link";
import { AccessProfile } from "@prisma/client";
import { requirePageProfile } from "@/lib/guards";
import {
  listCompanyCustomers,
  type CustomerListConnectivity,
} from "@/lib/customers";
import {
  CONNECTIVITY_PRESENTATION,
  connectivityAge,
} from "@/lib/connectivity-presentation";
import { sliceEmptyState } from "@/lib/dashboard-slice-copy";
import { BackToDashboardLink } from "@/components/BackToDashboardLink";
import { EmptyState } from "@/components/EmptyState";
import { ListSliceBanner } from "@/components/ListSliceBanner";
import { Pagination } from "@/components/Pagination";
import { isMockErpEnabled } from "@/integrations/mock-availability";

export const metadata: Metadata = {
  title: "Clientes",
};

interface PageProps {
  searchParams: { [key: string]: string | string[] | undefined };
}

const CONNECTIVITY_BADGE_CLASS = {
  danger: "border-danger-border bg-danger-bg text-danger-fg",
  success: "border-success-border bg-success-bg text-success-fg",
  neutral: "border-border bg-surface-muted text-fg-secondary",
} as const;

/**
 * A leitura que pôs o cliente no recorte: o estado, com glifo e rótulo da
 * tabela de apresentação da §370 (a mesma do mapa e da OS), e a idade dela.
 * O estado vem do dado, não é presumido pela URL — se um dia a leitura
 * divergisse do recorte, a célula diria a verdade.
 */
function ConnectivityCell({
  reading,
  now,
}: {
  reading: CustomerListConnectivity | undefined;
  now: Date;
}) {
  if (!reading) {
    return <td className="px-5 py-3 text-fg-muted" data-testid="customer-connectivity">—</td>;
  }
  const apresentacao = CONNECTIVITY_PRESENTATION[reading.status];
  const idade = connectivityAge(reading.observedAt.toISOString(), now);
  return (
    <td className="px-5 py-3" data-testid="customer-connectivity">
      <span
        className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${CONNECTIVITY_BADGE_CLASS[apresentacao.tone]}`}
      >
        {apresentacao.glyph && (
          <span aria-hidden="true">{apresentacao.glyph}</span>
        )}
        {apresentacao.label}
      </span>
      {idade && (
        <span className="ml-2 whitespace-nowrap text-xs text-fg-muted" data-testid="customer-connectivity-age">
          {`Leitura ${idade}`}
        </span>
      )}
    </td>
  );
}

export default async function CustomersPage({ searchParams }: PageProps) {
  const session = await requirePageProfile(["ADMIN", "DISPATCHER"]);

  const search = typeof searchParams.search === "string" ? searchParams.search : "";
  const activeRaw = typeof searchParams.active === "string" ? searchParams.active : "";
  const active = activeRaw === "true" ? true : activeRaw === "false" ? false : undefined;
  /*
    Recorte do painel (DASH-1): clientes cuja última leitura é OFFLINE.

    Só para `ADMIN`, e quem decide é o servidor. A conectividade da carteira
    inteira é `ADMIN` no Mapa Operacional (camada de clientes, resumo por
    caixa — PRD §376); um parâmetro de URL não pode ser a porta que a estende
    ao `DISPATCHER`. Para ele o parâmetro é ignorado e a lista abre sem recorte.
  */
  const offlineOnly =
    session.profile === AccessProfile.ADMIN &&
    searchParams.conectividade === "OFFLINE";
  const page = Math.max(1, Number(searchParams.page ?? 1) || 1);
  const pageSize = 20;

  const result = await listCompanyCustomers(session.companyId, {
    search: search || undefined,
    active,
    connectivity: offlineOnly ? "OFFLINE" : undefined,
    page,
    pageSize,
  });

  function buildHref(p: number, semRecorte = false): string {
    const params = new URLSearchParams();
    if (offlineOnly && !semRecorte) params.set("conectividade", "OFFLINE");
    if (search) params.set("search", search);
    if (activeRaw) params.set("active", activeRaw);
    if (p > 1) params.set("page", String(p));
    const qs = params.toString();
    return qs ? `/clientes?${qs}` : "/clientes";
  }

  /*
    O cartão abre com `active=true` — o recorte é de clientes ativos. Esse
    `active` veio do painel, não de um filtro escolhido; só conta como "outro
    filtro" para o estado vazio quando destoa disso ou há busca.
  */
  const empty = offlineOnly
    ? sliceEmptyState(
        "clientes-offline",
        Boolean(search) || (activeRaw !== "" && activeRaw !== "true"),
      )
    : {
        title: "Nenhum cliente encontrado",
        // Em produção não há Mock de onde importar (RC-OPS-03).
        description: isMockErpEnabled()
          ? "Crie um cliente manualmente ou importe OS do Mock ERP para gerar clientes automaticamente."
          : "Crie um cliente manualmente.",
      };
  const connectivity = result.connectivity;
  const now = new Date();

  return (
    <div>
      {offlineOnly && <BackToDashboardLink />}
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

      {offlineOnly && (
        <ListSliceBanner
          sliceKey="clientes-offline"
          total={result.total}
          clearHref={buildHref(1, true)}
        />
      )}

      <form
        method="get"
        className="mb-4 flex flex-wrap items-center gap-3 rounded-2xl border border-border bg-surface p-4 shadow-sm"
      >
        {offlineOnly && <input type="hidden" name="conectividade" value="OFFLINE" />}
        {/* RC-1D: `placeholder` não é rótulo — ele some ao digitar. */}
        <input
          type="search"
          name="search"
          aria-label="Buscar clientes por nome, documento, e-mail, telefone ou endereço"
          defaultValue={search}
          placeholder="Buscar por nome, documento, e-mail, telefone ou endereço..."
          className="min-w-0 flex-1 rounded-lg border border-input-border px-3 py-2 text-sm text-fg focus:border-focus focus:outline-none focus:ring-2 focus:ring-focus-soft"
        />
        <select
          name="active"
          aria-label="Filtrar por situação cadastral"
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
          <EmptyState title={empty.title} description={empty.description} />
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-border text-sm">
              <thead className="bg-surface-subtle">
                <tr>
                  <th scope="col" className="px-5 py-3 text-left font-semibold text-fg-secondary">Nome</th>
                  {/*
                    Conectividade e status cadastral são perguntas diferentes:
                    "a última leitura diz que o cliente está fora do ar" e "o
                    cadastro está ativo". No recorte as duas aparecem, cada uma
                    com o seu nome — nunca um "Offline" no lugar de "Ativo".
                  */}
                  {connectivity && (
                    <th scope="col" className="px-5 py-3 text-left font-semibold text-fg-secondary">Conectividade</th>
                  )}
                  <th scope="col" className="px-5 py-3 text-left font-semibold text-fg-secondary">Documento</th>
                  <th scope="col" className="px-5 py-3 text-left font-semibold text-fg-secondary">Telefone</th>
                  <th scope="col" className="px-5 py-3 text-left font-semibold text-fg-secondary">Cidade</th>
                  <th scope="col" className="px-5 py-3 text-left font-semibold text-fg-secondary">
                    {connectivity ? "Status cadastral" : "Status"}
                  </th>
                  <th scope="col" className="px-5 py-3 text-right font-semibold text-fg-secondary">Ações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {result.customers.map((customer) => (
                  <tr key={customer.id} className="hover:bg-surface-subtle">
                    <td className="px-5 py-3 font-medium text-fg">{customer.name}</td>
                    {connectivity && (
                      <ConnectivityCell reading={connectivity[customer.id]} now={now} />
                    )}
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
