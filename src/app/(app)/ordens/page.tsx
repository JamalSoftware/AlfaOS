import type { Metadata } from "next";
import Link from "next/link";
import { AccessProfile } from "@prisma/client";
import { companyTimezone } from "@/lib/company-timezone";
import { requirePageProfile } from "@/lib/guards";
import {
  listCompanyServiceOrders,
  SERVICE_ORDER_PRIORITY_LABELS,
  SERVICE_ORDER_STATUS_LABELS,
} from "@/lib/service-orders";
import {
  TIME_DEPENDENT_SLICES,
  companySliceClock,
  parseServiceOrderSlice,
} from "@/lib/service-order-slices";
import { formatCompanyDateTime } from "@/lib/company-datetime";
import { sliceEmptyState } from "@/lib/dashboard-slice-copy";
import { listActiveTechnicianOptions } from "@/lib/technicians";
import { PriorityBadge, StatusBadge } from "@/components/OrderBadges";
import { BackToDashboardLink } from "@/components/BackToDashboardLink";
import { EmptyState } from "@/components/EmptyState";
import { ListSliceBanner } from "@/components/ListSliceBanner";
import { Pagination } from "@/components/Pagination";
import { SyncERPButton } from "@/components/SyncERPButton";
import { isMockErpEnabled } from "@/integrations/mock-availability";

export const metadata: Metadata = {
  title: "Ordens de Serviço",
};

/*
  Data no fuso da EMPRESA — `RC-1`, débito §12 ("datas gerais no fuso do
  servidor"). Sem `timeZone`, o `Intl` formata no fuso do PROCESSO, que em
  produção é UTC. O fuso é obrigatório na assinatura: quem esquecer não compila,
  em vez de cair no relógio do servidor em silêncio.
*/
function formatDate(date: Date | null, timezone: string): string {
  if (!date) return "—";
  return formatCompanyDateTime(date, timezone);
}

interface PageProps {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

export default async function OrdersPage({ searchParams: searchParamsPromise }: PageProps) {
  const searchParams = await searchParamsPromise;
  const session = await requirePageProfile(["ADMIN", "DISPATCHER"]);
  const timezone = await companyTimezone(session.companyId);
  const isAdmin = session.profile === AccessProfile.ADMIN;

  const search = typeof searchParams.search === "string" ? searchParams.search : "";
  const status = typeof searchParams.status === "string" ? searchParams.status : "";
  const priority = typeof searchParams.priority === "string" ? searchParams.priority : "";
  const technicianId = typeof searchParams.technicianId === "string" ? searchParams.technicianId : "";
  /*
    Recorte do painel operacional (DASH-1): "abertas", "atrasadas", "hoje" e,
    desde a DASH-1a, "pendentes". Valor fora da lista é descartado, e a listagem
    abre sem recorte — nunca um recorte adivinhado a partir do que o cliente
    escreveu.
  */
  const slice = parseServiceOrderSlice(searchParams.recorte);
  const page = Math.max(1, Number(searchParams.page ?? 1) || 1);
  const pageSize = 20;

  /*
    Nos recortes que dependem do relógio, a página lê o relógio da empresa UMA
    vez e o usa para as duas coisas: filtrar e mostrar "Agendada para". Se a
    listagem lesse o fuso por conta própria, o filtro e a hora na tela seriam
    duas leituras que poderiam discordar.
  */
  const clock =
    slice && TIME_DEPENDENT_SLICES.has(slice)
      ? await companySliceClock(session.companyId)
      : null;
  const showScheduledAt = clock !== null;

  const [result, technicians] = await Promise.all([
    listCompanyServiceOrders(session.companyId, {
      search: search || undefined,
      status: (["PENDING", "ASSIGNED", "IN_PROGRESS", "COMPLETED", "CANCELLED"] as const).includes(status as never) ? (status as "PENDING") : undefined,
      priority: (["LOW", "NORMAL", "HIGH", "URGENT"] as const).includes(priority as never) ? (priority as "NORMAL") : undefined,
      technicianId: technicianId || undefined,
      slice: slice ?? undefined,
      clock: clock ?? undefined,
      page,
      pageSize,
    }),
    listActiveTechnicianOptions(session.companyId),
  ]);

  const hasOtherFilters = Boolean(search || status || priority || technicianId);
  const mockErp = isMockErpEnabled();
  const empty = slice
    ? sliceEmptyState(slice, hasOtherFilters)
    : {
        title: "Nenhuma OS encontrada",
        // Em produção não há Mock a sincronizar (RC-OPS-03), e a frase
        // apontaria para um botão que não existe.
        description: mockErp
          ? "Crie uma OS manualmente ou sincronize o Mock ERP para importar OS pendentes."
          : "Crie uma OS manualmente.",
      };

  function buildHref(p: number, semRecorte = false): string {
    const params = new URLSearchParams();
    if (slice && !semRecorte) params.set("recorte", slice);
    if (search) params.set("search", search);
    if (status) params.set("status", status);
    if (priority) params.set("priority", priority);
    if (technicianId) params.set("technicianId", technicianId);
    if (p > 1) params.set("page", String(p));
    const qs = params.toString();
    return qs ? `/ordens?${qs}` : "/ordens";
  }

  const selectClass =
    "rounded-lg border border-input-border px-3 py-2 text-sm text-fg focus:border-focus focus:outline-none focus:ring-2 focus:ring-focus-soft";

  return (
    <div>
      {slice && <BackToDashboardLink />}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-fg">Ordens de Serviço</h1>
          <p className="mt-1 text-sm text-fg-muted">
            Acompanhe, atribua e sincronize as OS da sua empresa.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isAdmin && mockErp && <SyncERPButton />}
          <Link
            href="/ordens/novo"
            className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-fg transition-colors hover:bg-primary-hover"
          >
            Nova OS
          </Link>
        </div>
      </div>

      {slice && (
        <ListSliceBanner
          sliceKey={slice}
          total={result.total}
          clearHref={buildHref(1, true)}
        />
      )}

      <form
        method="get"
        className="mb-4 flex flex-wrap items-center gap-3 rounded-2xl border border-border bg-surface p-4 shadow-sm"
      >
        {/* O recorte sobrevive a "Filtrar": os filtros da tela se somam a ele. */}
        {slice && <input type="hidden" name="recorte" value={slice} />}
        {/*
          RC-1D: `placeholder` não é rótulo. Ele some ao digitar, e o leitor de
          tela anuncia "campo de edição" e nada mais.
        */}
        <input
          type="search"
          name="search"
          aria-label="Buscar ordens de serviço por número, cliente, tipo ou descrição"
          defaultValue={search}
          placeholder="Buscar por nº, cliente, tipo ou descrição..."
          className="min-w-0 flex-1 rounded-lg border border-input-border px-3 py-2 text-sm text-fg focus:border-focus focus:outline-none focus:ring-2 focus:ring-focus-soft"
        />
        <select name="status" aria-label="Filtrar por status" defaultValue={status} className={selectClass}>
          <option value="">Todos os status</option>
          {Object.entries(SERVICE_ORDER_STATUS_LABELS).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
        <select name="priority" aria-label="Filtrar por prioridade" defaultValue={priority} className={selectClass}>
          <option value="">Todas as prioridades</option>
          {Object.entries(SERVICE_ORDER_PRIORITY_LABELS).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
        <select name="technicianId" aria-label="Filtrar por técnico" defaultValue={technicianId} className={selectClass}>
          <option value="">Todos os técnicos</option>
          {technicians.map((tech) => (
            <option key={tech.id} value={tech.id}>{tech.name}</option>
          ))}
        </select>
        <button
          type="submit"
          className="rounded-lg border border-border px-4 py-2 text-sm font-semibold text-fg-secondary transition-colors hover:bg-surface-muted"
        >
          Filtrar
        </button>
      </form>

      <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
        {result.serviceOrders.length === 0 ? (
          <EmptyState title={empty.title} description={empty.description} />
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-border text-sm">
              <thead className="bg-surface-subtle">
                <tr>
                  {/*
                    Número OPERACIONAL. Antes esta coluna mostrava
                    `externalNumber ?? id.slice(0, 8)` — ou seja, um prefixo de
                    cuid para toda OS criada no AlfaOS.
                  */}
                  <th scope="col" className="px-5 py-3 text-left font-semibold text-fg-secondary">Nº</th>
                  <th scope="col" className="px-5 py-3 text-left font-semibold text-fg-secondary">Cliente</th>
                  <th scope="col" className="px-5 py-3 text-left font-semibold text-fg-secondary">Tipo</th>
                  <th scope="col" className="px-5 py-3 text-left font-semibold text-fg-secondary">Prioridade</th>
                  <th scope="col" className="px-5 py-3 text-left font-semibold text-fg-secondary">Status</th>
                  <th scope="col" className="px-5 py-3 text-left font-semibold text-fg-secondary">Técnico</th>
                  {/*
                    Em "atrasadas" e "de hoje" a razão de a OS estar na lista é
                    o agendamento, então é ele que a coluna mostra — no fuso da
                    empresa, o mesmo relógio que decidiu o recorte.
                  */}
                  <th scope="col" className="px-5 py-3 text-left font-semibold text-fg-secondary">
                    {showScheduledAt ? "Agendada para" : "Criada em"}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {result.serviceOrders.map((order) => (
                  <tr key={order.id} className="hover:bg-surface-subtle">
                    <td className="px-5 py-3">
                      <Link
                        href={`/ordens/${order.id}`}
                        className="font-semibold text-primary-text hover:text-primary-text-hover"
                      >
                        {`Nº ${order.number}`}
                      </Link>
                    </td>
                    <td className="px-5 py-3 text-fg">{order.customer.name}</td>
                    <td className="px-5 py-3 text-fg-secondary">
                      {order.type}
                      {order.subtype ? ` · ${order.subtype}` : ""}
                    </td>
                    <td className="px-5 py-3"><PriorityBadge priority={order.priority} /></td>
                    <td className="px-5 py-3"><StatusBadge status={order.status} /></td>
                    <td className="px-5 py-3 text-fg-secondary">{order.technician?.name ?? "—"}</td>
                    {clock ? (
                      <td className="px-5 py-3 text-fg-secondary tabular-nums" data-testid="order-scheduled-at">
                        {order.scheduledAt
                          ? formatCompanyDateTime(order.scheduledAt, clock.timezone)
                          : "—"}
                      </td>
                    ) : (
                      <td className="px-5 py-3 text-fg-muted">{formatDate(order.createdAt, timezone)}</td>
                    )}
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
