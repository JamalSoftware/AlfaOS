import type { Metadata } from "next";
import Link from "next/link";
import { AccessProfile } from "@prisma/client";
import { requirePageProfile } from "@/lib/guards";
import {
  listCompanyServiceOrders,
  SERVICE_ORDER_PRIORITY_LABELS,
  SERVICE_ORDER_STATUS_LABELS,
} from "@/lib/service-orders";
import { listActiveTechnicianOptions } from "@/lib/technicians";
import { PriorityBadge, StatusBadge } from "@/components/OrderBadges";
import { EmptyState } from "@/components/EmptyState";
import { Pagination } from "@/components/Pagination";
import { SyncERPButton } from "@/components/SyncERPButton";

export const metadata: Metadata = {
  title: "Ordens de Serviço",
};

function formatDate(date: Date | null): string {
  if (!date) return "—";
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

interface PageProps {
  searchParams: { [key: string]: string | string[] | undefined };
}

export default async function OrdersPage({ searchParams }: PageProps) {
  const session = await requirePageProfile(["ADMIN", "DISPATCHER"]);
  const isAdmin = session.profile === AccessProfile.ADMIN;

  const search = typeof searchParams.search === "string" ? searchParams.search : "";
  const status = typeof searchParams.status === "string" ? searchParams.status : "";
  const priority = typeof searchParams.priority === "string" ? searchParams.priority : "";
  const technicianId = typeof searchParams.technicianId === "string" ? searchParams.technicianId : "";
  const page = Math.max(1, Number(searchParams.page ?? 1) || 1);
  const pageSize = 20;

  const [result, technicians] = await Promise.all([
    listCompanyServiceOrders(session.companyId, {
      search: search || undefined,
      status: (["PENDING", "ASSIGNED", "IN_PROGRESS", "COMPLETED", "CANCELLED"] as const).includes(status as never) ? (status as "PENDING") : undefined,
      priority: (["LOW", "NORMAL", "HIGH", "URGENT"] as const).includes(priority as never) ? (priority as "NORMAL") : undefined,
      technicianId: technicianId || undefined,
      page,
      pageSize,
    }),
    listActiveTechnicianOptions(session.companyId),
  ]);

  function buildHref(p: number): string {
    const params = new URLSearchParams();
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
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-fg">Ordens de Serviço</h1>
          <p className="mt-1 text-sm text-fg-muted">
            Acompanhe, atribua e sincronize as OS da sua empresa.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isAdmin && <SyncERPButton />}
          <Link
            href="/ordens/novo"
            className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-fg transition-colors hover:bg-primary-hover"
          >
            Nova OS
          </Link>
        </div>
      </div>

      <form
        method="get"
        className="mb-4 flex flex-wrap items-center gap-3 rounded-2xl border border-border bg-surface p-4 shadow-sm"
      >
        <input
          type="search"
          name="search"
          defaultValue={search}
          placeholder="Buscar por nº, cliente, tipo ou descrição..."
          className="min-w-0 flex-1 rounded-lg border border-input-border px-3 py-2 text-sm text-fg focus:border-focus focus:outline-none focus:ring-2 focus:ring-focus-soft"
        />
        <select name="status" defaultValue={status} className={selectClass}>
          <option value="">Todos os status</option>
          {Object.entries(SERVICE_ORDER_STATUS_LABELS).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
        <select name="priority" defaultValue={priority} className={selectClass}>
          <option value="">Todas as prioridades</option>
          {Object.entries(SERVICE_ORDER_PRIORITY_LABELS).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
        <select name="technicianId" defaultValue={technicianId} className={selectClass}>
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
          <EmptyState
            title="Nenhuma OS encontrada"
            description="Crie uma OS manualmente ou sincronize o Mock ERP para importar OS pendentes."
          />
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
                  <th scope="col" className="px-5 py-3 text-left font-semibold text-fg-secondary">Criada em</th>
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
                    <td className="px-5 py-3 text-fg-muted">{formatDate(order.createdAt)}</td>
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
