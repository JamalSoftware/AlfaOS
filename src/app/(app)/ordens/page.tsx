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
    "rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100";

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Ordens de Serviço</h1>
          <p className="mt-1 text-sm text-slate-500">
            Acompanhe, atribua e sincronize as OS da sua empresa.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isAdmin && <SyncERPButton />}
          <Link
            href="/ordens/novo"
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700"
          >
            Nova OS
          </Link>
        </div>
      </div>

      <form
        method="get"
        className="mb-4 flex flex-wrap items-center gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
      >
        <input
          type="search"
          name="search"
          defaultValue={search}
          placeholder="Buscar por nº, cliente, tipo ou descrição..."
          className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100"
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
          className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-600 transition-colors hover:bg-slate-100"
        >
          Filtrar
        </button>
      </form>

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        {result.serviceOrders.length === 0 ? (
          <EmptyState
            title="Nenhuma OS encontrada"
            description="Crie uma OS manualmente ou sincronize o Mock ERP para importar OS pendentes."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th scope="col" className="px-5 py-3 text-left font-semibold text-slate-600">Nº</th>
                  <th scope="col" className="px-5 py-3 text-left font-semibold text-slate-600">Cliente</th>
                  <th scope="col" className="px-5 py-3 text-left font-semibold text-slate-600">Tipo</th>
                  <th scope="col" className="px-5 py-3 text-left font-semibold text-slate-600">Prioridade</th>
                  <th scope="col" className="px-5 py-3 text-left font-semibold text-slate-600">Status</th>
                  <th scope="col" className="px-5 py-3 text-left font-semibold text-slate-600">Técnico</th>
                  <th scope="col" className="px-5 py-3 text-left font-semibold text-slate-600">Criada em</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {result.serviceOrders.map((order) => (
                  <tr key={order.id} className="hover:bg-slate-50">
                    <td className="px-5 py-3">
                      <Link
                        href={`/ordens/${order.id}`}
                        className="font-semibold text-blue-600 hover:text-blue-700"
                      >
                        {order.externalNumber ?? order.id.slice(0, 8)}
                      </Link>
                    </td>
                    <td className="px-5 py-3 text-slate-900">{order.customer.name}</td>
                    <td className="px-5 py-3 text-slate-600">
                      {order.type}
                      {order.subtype ? ` · ${order.subtype}` : ""}
                    </td>
                    <td className="px-5 py-3"><PriorityBadge priority={order.priority} /></td>
                    <td className="px-5 py-3"><StatusBadge status={order.status} /></td>
                    <td className="px-5 py-3 text-slate-600">{order.technician?.name ?? "—"}</td>
                    <td className="px-5 py-3 text-slate-500">{formatDate(order.createdAt)}</td>
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
