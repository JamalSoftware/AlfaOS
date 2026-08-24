import type { Metadata } from "next";
import Link from "next/link";
import { requirePageProfile } from "@/lib/guards";
import {
  formatServiceOrderNumber,
  getTechnicianByUserId,
  listRecentCompletedForTechnician,
  listServiceOrdersForTechnician,
  SERVICE_ORDER_PRIORITY_LABELS,
  TECHNICIAN_COMPLETED_WINDOW_DAYS,
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
    number: number;
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
          <p
            data-testid="order-number"
            className="text-sm font-semibold text-blue-600"
          >
            {formatServiceOrderNumber(order)}
          </p>
          <p className="mt-1 truncate font-medium text-slate-900">{order.customer.name}</p>
          {order.customer.city && (
            <p className="mt-0.5 truncate text-sm text-slate-500">
              {order.customer.city}
              {order.customer.state ? `/${order.customer.state}` : ""}
            </p>
          )}
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

  /**
   * Duas consultas separadas de propósito: a fila operacional continua sendo
   * só ASSIGNED + IN_PROGRESS. Concluídas entram numa seção própria, limitada
   * em período e quantidade, para não empurrar o trabalho de hoje para fora
   * da primeira tela do celular.
   */
  const [queue, completed] = await Promise.all([
    listServiceOrdersForTechnician(session.companyId, technician.id),
    listRecentCompletedForTechnician(session.companyId, technician.id),
  ]);

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">Minhas OS</h1>
        <p className="mt-1 text-sm text-slate-500">
          Ordens atribuídas a você. Prioridade máxima {SERVICE_ORDER_PRIORITY_LABELS.URGENT}.
        </p>
      </div>

      {/*
        Deactivated technician: the queue stays fully readable — including an
        order already in progress — and only the write actions on the detail
        screen are refused. Nothing recorded is hidden or rolled back.
      */}
      {technician.executionIssue && (
        <div
          role="alert"
          className="mb-6 rounded-2xl border border-amber-200 bg-amber-50 p-4"
        >
          <p className="text-sm text-amber-800">{technician.executionIssue}</p>
        </div>
      )}

      {/*
        "Em atendimento" comes FIRST. It is the order the technician is
        physically working on; everything else is planning.
      */}
      {queue.inProgress.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-3 text-base font-semibold text-slate-900">
            Em atendimento
          </h2>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {queue.inProgress.map((order) => (
              <OrderCard key={order.id} order={order} />
            ))}
          </div>
        </section>
      )}

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

      <section className="mb-8">
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

      {/*
        Antes da v0.5.1 uma OS concluída simplesmente sumia: continuava
        acessível por URL direta, mas nenhuma tela levava até ela. O técnico
        perdia de vista o próprio trabalho do dia assim que finalizava.

        A consulta é escopada em SQL por empresa + técnico, então esta seção
        nunca mostra atendimento de outro técnico nem de outra empresa.
      */}
      <section>
        <h2 className="mb-3 text-base font-semibold text-slate-900">
          Concluídas recentes
        </h2>
        {completed.length === 0 ? (
          <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
            <EmptyState
              title="Nenhuma OS concluída nos últimos dias"
              description={`Seus atendimentos finalizados nos últimos ${TECHNICIAN_COMPLETED_WINDOW_DAYS} dias aparecerão aqui.`}
            />
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {completed.map((order) => (
                <OrderCard key={order.id} order={order} />
              ))}
            </div>
            <p className="mt-3 text-xs text-slate-500">
              Últimos {TECHNICIAN_COMPLETED_WINDOW_DAYS} dias. Para o histórico
              completo, fale com o despachante.
            </p>
          </>
        )}
      </section>
    </div>
  );
}
