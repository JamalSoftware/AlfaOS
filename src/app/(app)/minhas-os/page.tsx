import type { Metadata } from "next";
import Link from "next/link";
import { requirePageProfile } from "@/lib/guards";
import {
  getTechnicianByUserId,
  listServiceOrdersForTechnician,
  SERVICE_ORDER_PRIORITY_LABELS,
} from "@/lib/service-orders";
import { EmptyState } from "@/components/EmptyState";
import { PriorityBadge, StatusBadge } from "@/components/OrderBadges";

export const metadata: Metadata = {
  title: "Minhas OS",
};

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function OrderCard({
  order,
}: {
  order: {
    id: string;
    externalNumber: string | null;
    type: string;
    subtype: string | null;
    description: string;
    priority: "LOW" | "NORMAL" | "HIGH" | "URGENT";
    status: "PENDING" | "ASSIGNED" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";
    scheduledAt: Date | null;
    customer: { name: string; city: string | null; state: string | null };
  };
}) {
  return (
    <Link
      href={`/ordens/${order.id}`}
      className="block rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition-colors hover:border-blue-300 hover:bg-blue-50/30"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-blue-600">
            OS {order.externalNumber ?? order.id.slice(0, 8)}
          </p>
          <p className="mt-1 truncate font-medium text-slate-900">{order.customer.name}</p>
          <p className="mt-1 line-clamp-2 text-sm text-slate-500">{order.description}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <PriorityBadge priority={order.priority} />
          <StatusBadge status={order.status} />
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between border-t border-slate-100 pt-3 text-xs text-slate-500">
        <span>
          {order.type}
          {order.subtype ? ` · ${order.subtype}` : ""}
        </span>
        <span>
          {order.scheduledAt
            ? `Agendada: ${formatDate(order.scheduledAt)}`
            : "Sem agendamento"}
        </span>
      </div>
    </Link>
  );
}

export default async function MyOrdersPage() {
  const session = await requirePageProfile(["TECHNICIAN"]);

  const technician = await getTechnicianByUserId(session.companyId, session.id);
  if (!technician) {
    return (
      <div>
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-slate-900">Minhas OS</h1>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
          <EmptyState
            title="Você ainda não está cadastrado como técnico"
            description="Sua empresa precisa vincular seu usuário a um técnico para receber OS."
          />
        </div>
      </div>
    );
  }

  const queue = await listServiceOrdersForTechnician(
    session.companyId,
    technician.id,
  );

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">Minhas OS</h1>
        <p className="mt-1 text-sm text-slate-500">
          Ordens atribuídas a você. Prioridade máxima {SERVICE_ORDER_PRIORITY_LABELS.URGENT}.
        </p>
      </div>

      <div className="mb-6 rounded-2xl border border-amber-200 bg-amber-50 p-4">
        <p className="text-sm text-amber-800">
          A execução da OS (iniciar atendimento e concluir) será habilitada na
          próxima versão do AlfaOS.
        </p>
      </div>

      <section className="mb-8">
        <h2 className="mb-3 text-base font-semibold text-slate-900">Hoje</h2>
        {queue.today.length === 0 ? (
          <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
            <EmptyState
              title="Nenhuma OS agendada para hoje"
              description="As OS agendadas para hoje aparecerão aqui."
            />
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {queue.today.map((order) => (
              <OrderCard key={order.id} order={order} />
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-base font-semibold text-slate-900">Próximas</h2>
        {queue.upcoming.length === 0 ? (
          <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
            <EmptyState
              title="Nenhuma OS próxima"
              description="Quando uma OS for atribuída a você, ela aparecerá aqui."
            />
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {queue.upcoming.map((order) => (
              <OrderCard key={order.id} order={order} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
