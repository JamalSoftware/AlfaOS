import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AccessProfile } from "@prisma/client";
import { requirePageProfile } from "@/lib/guards";
import {
  listCustomerConnections,
  REVEALABLE_ORDER_STATUSES,
} from "@/lib/customer-connections";
import { PppoeAccessPanel } from "@/components/PppoeAccessPanel";
import {
  EXECUTION_TEXT_MAX_LENGTH,
  getCompanyServiceOrder,
  getTechnicianByUserId,
  SERVICE_ORDER_PRIORITY_LABELS,
  SERVICE_ORDER_ORIGIN_LABELS,
  SERVICE_ORDER_STATUS_LABELS,
} from "@/lib/service-orders";
import { listActiveTechnicianOptions } from "@/lib/technicians";
import { PriorityBadge, StatusBadge } from "@/components/OrderBadges";
import { getServiceOrderClosingBundle } from "@/lib/service-order-closing";
import { getCustomerDiagnostic } from "@/lib/customer-diagnostics";
import { CustomerDiagnosticPanel } from "@/components/CustomerDiagnosticPanel";
import { AssignTechnicianForm } from "@/components/AssignTechnicianForm";
import { ServiceOrderExecutionForm } from "@/components/ServiceOrderExecutionForm";
import { StartServiceOrderButton } from "@/components/StartServiceOrderButton";
import { ServiceOrderClosingPanel } from "@/components/ServiceOrderClosingPanel";
import { ServiceOrderClosingReadOnly } from "@/components/ServiceOrderClosingReadOnly";

export const metadata: Metadata = {
  title: "Detalhes da OS",
};

const EVENT_LABELS: Record<string, string> = {
  SERVICE_ORDER_CREATED: "OS criada",
  SERVICE_ORDER_IMPORTED: "OS importada do ERP",
  TECHNICIAN_ASSIGNED: "Técnico atribuído",
  TECHNICIAN_CHANGED: "Técnico alterado",
  SERVICE_ORDER_STATUS_CHANGED: "Status alterado",
  OS_STARTED: "Atendimento iniciado",
  OS_COMPLETED: "Atendimento concluído",
};

/** Elapsed time between start and close, shown on a closed order. */
function formatDuration(start: Date | null, end: Date | null): string | null {
  if (!start || !end) return null;
  const ms = end.getTime() - start.getTime();
  if (ms < 0) return null;
  const totalMinutes = Math.round(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} min`;
  return `${hours}h ${String(minutes).padStart(2, "0")}min`;
}

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

function formatTime(date: Date | null): string {
  if (!date) return "—";
  return new Intl.DateTimeFormat("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/** Read-only rendering of the execution, for staff and for closed states. */
function ExecutionReadOnly({
  execution,
}: {
  execution: {
    diagnosis: string | null;
    workPerformed: string | null;
    notes: string | null;
  };
}) {
  const blocks = [
    { label: "Diagnóstico", value: execution.diagnosis },
    { label: "Serviço realizado", value: execution.workPerformed },
    { label: "Observações", value: execution.notes },
  ];
  return (
    <dl className="space-y-4">
      {blocks.map((block) => (
        <div key={block.label}>
          <dt className="text-xs font-medium text-slate-500">{block.label}</dt>
          <dd className="mt-0.5 whitespace-pre-wrap break-words text-sm text-slate-900">
            {block.value ?? "—"}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export default async function OrderDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const session = await requirePageProfile([
    "ADMIN",
    "DISPATCHER",
    "TECHNICIAN",
  ]);

  const order = await getCompanyServiceOrder(session.companyId, params.id);
  if (!order) {
    notFound();
  }

  let isOwnerTechnician = false;
  /**
   * Non-null when the viewer is the owning technician but is not allowed to
   * WRITE (deactivated technician profile, for instance). The page still
   * renders everything — the reason simply replaces the action controls.
   */
  let executionIssue: string | null = null;
  if (session.profile === AccessProfile.TECHNICIAN) {
    const technician = await getTechnicianByUserId(session.companyId, session.id);
    if (!technician || technician.id !== order.technician?.id) {
      notFound();
    }
    isOwnerTechnician = true;
    executionIssue = technician.executionIssue;
  }

  const isStaff = !isOwnerTechnician;

  /**
   * Conexão de acesso do cliente desta OS.
   *
   * `listCustomerConnections` devolve o shape público — usuário e um booleano.
   * A senha NUNCA entra nas props do Server Component: ela só existe numa
   * resposta separada, disparada por clique.
   */
  const connections =
    session.profile === AccessProfile.DISPATCHER
      ? []
      : await listCustomerConnections(session.companyId, order.customer.id);
  const pppoeConnection = connections.find((c) => c.active) ?? null;

  const orderAllowsReveal = (
    REVEALABLE_ORDER_STATUSES as readonly string[]
  ).includes(order.status);
  // ADMIN mantém a capacidade administrativa; o técnico dono só enquanto o
  // atendimento está em curso.
  const canRevealPassword =
    session.profile === AccessProfile.ADMIN ||
    (isOwnerTechnician && orderAllowsReveal);
  const revealBlockedReason =
    isOwnerTechnician && !orderAllowsReveal
      ? "A senha só pode ser revelada enquanto o atendimento estiver em andamento."
      : null;
  const technicians = isStaff
    ? await listActiveTechnicianOptions(session.companyId)
    : [];

  const infoRows = [
    { label: "Nº externo", value: order.externalNumber ?? "—" },
    { label: "Tipo", value: order.subtype ? `${order.type} · ${order.subtype}` : order.type },
    { label: "Prioridade", value: SERVICE_ORDER_PRIORITY_LABELS[order.priority] },
    { label: "Status", value: SERVICE_ORDER_STATUS_LABELS[order.status] },
    {
      label: "Origem",
      // O provider acompanha a origem porque "Externa" sozinha não diz de onde.
      value:
        order.origin === "EXTERNAL" && order.externalProvider
          ? `${SERVICE_ORDER_ORIGIN_LABELS[order.origin]} · ${order.externalProvider}`
          : SERVICE_ORDER_ORIGIN_LABELS[order.origin],
    },
    { label: "Agendamento", value: formatDate(order.scheduledAt) },
    { label: "Atribuída em", value: formatDate(order.assignedAt) },
    { label: "Iniciada em", value: formatDate(order.startedAt) },
    ...(order.completedAt
      ? [{ label: "Concluída em", value: formatDate(order.completedAt) }]
      : []),
    { label: "Criada em", value: formatDate(order.createdAt) },
  ];

  const canStart = isOwnerTechnician && order.status === "ASSIGNED";
  const isExecuting = isOwnerTechnician && order.status === "IN_PROGRESS";
  // Staff never get an editable execution — only the technician who is doing
  // the work writes it. Everyone else reads.
  const showExecutionReadOnly = !isExecuting && order.execution !== null;

  const closing = await getServiceOrderClosingBundle(
    session.companyId,
    order.id,
  );
  const showClosingPanel = isExecuting && !executionIssue;
  // Once closed, or for staff, the same data renders without any control that
  // could mutate it.
  const showClosingReadOnly =
    order.status === "COMPLETED" ||
    (!isExecuting && order.status !== "PENDING" && order.status !== "ASSIGNED");
  /**
   * Mirrors the server rule in `completeServiceOrder`: the report needs a
   * diagnosis and a description of the work. Photos, materials and signature
   * stay optional in v0.4 — which of them a given order requires is a per-type
   * checklist policy that does not exist yet.
   */
  const canComplete = Boolean(
    order.execution?.diagnosis?.trim() && order.execution?.workPerformed?.trim(),
  );

  const durationLabel = formatDuration(order.startedAt, order.completedAt);

  /**
   * Read-only, and read OUTSIDE any critical path: a diagnostic that is
   * missing or stale must never stop the order from rendering, starting or
   * closing. `getCustomerDiagnostic` only reads a local snapshot — it makes no
   * external call — so this cannot block the page on an ERP outage.
   */
  const diagnosticSnapshot = await getCustomerDiagnostic(
    session.companyId,
    order.customer.id,
  );
  // Domain fields only — the panel derives its own labels, so the
  // server-rendered snapshot and a refreshed one render identically.
  const diagnosticView = diagnosticSnapshot
    ? {
        connectivityStatus: diagnosticSnapshot.connectivityStatus,
        observedAt: diagnosticSnapshot.observedAt.toISOString(),
        provider: diagnosticSnapshot.provider,
      }
    : null;

  return (
    <div>
      <div className="mb-6">
        <Link
          href={isOwnerTechnician ? "/minhas-os" : "/ordens"}
          className="text-sm font-medium text-blue-600 hover:text-blue-700"
        >
          ← Voltar
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold text-slate-900">
            OS {order.externalNumber ?? order.id.slice(0, 8)}
          </h1>
          <StatusBadge status={order.status} />
          <PriorityBadge priority={order.priority} />
        </div>
        <p className="mt-1 text-sm text-slate-500">{order.description}</p>
      </div>

      {/*
        The technician's action lives ABOVE the grid, not in the sidebar.
        On mobile the grid stacks, so anything in the right column lands after
        Informações + Cliente + Timeline — the primary action of the whole
        screen would be the last thing on the page.
      */}
      {isOwnerTechnician && executionIssue && (
        <div
          role="alert"
          className="mb-6 rounded-2xl border border-amber-200 bg-amber-50 p-4"
        >
          <p className="text-sm text-amber-800">{executionIssue}</p>
        </div>
      )}

      {canStart && !executionIssue && (
        <div className="mb-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <StartServiceOrderButton
            orderId={order.id}
            /*
              A versão que ESTA renderização leu, enviada como
              `expectedVersion`: iniciar sobre uma leitura obsoleta é recusado
              com 409 em vez de sobrescrever.
            */
            version={order.version}
          />
        </div>
      )}

      {isExecuting && (
        <div className="mb-6 rounded-2xl border border-blue-200 bg-blue-50 p-4">
          <p className="text-sm font-semibold text-blue-900">
            Status: Em atendimento
          </p>
          <p className="mt-0.5 text-sm text-blue-800">
            Iniciado às {formatTime(order.startedAt)}
          </p>
        </div>
      )}

      {order.status === "COMPLETED" && (
        <div
          data-testid="completed-banner"
          className="mb-6 rounded-2xl border border-emerald-200 bg-emerald-50 p-4"
        >
          <p className="text-sm font-semibold text-emerald-900">
            Atendimento concluído
          </p>
          <p className="mt-0.5 text-sm text-emerald-800">
            {formatTime(order.startedAt)} → {formatTime(order.completedAt)}
            {durationLabel ? ` · ${durationLabel}` : ""}
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="mb-4 text-base font-semibold text-slate-900">Informações</h2>
            <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {infoRows.map((row) => (
                <div key={row.label}>
                  <dt className="text-xs font-medium text-slate-500">{row.label}</dt>
                  <dd className="mt-0.5 text-sm text-slate-900">{row.value}</dd>
                </div>
              ))}
            </dl>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="mb-1 text-base font-semibold text-slate-900">Cliente</h2>
            <p className="text-sm text-slate-900">{order.customer.name}</p>
            <dl className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <dt className="text-xs font-medium text-slate-500">Documento</dt>
                <dd className="mt-0.5 text-sm text-slate-900">{order.customer.document ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-slate-500">Telefone</dt>
                <dd className="mt-0.5 text-sm text-slate-900">{order.customer.phone ?? "—"}</dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-xs font-medium text-slate-500">Cidade</dt>
                <dd className="mt-0.5 text-sm text-slate-900">
                  {order.customer.city ? `${order.customer.city}${order.customer.state ? `/${order.customer.state}` : ""}` : "—"}
                </dd>
              </div>
            </dl>
          </div>

          {/*
            Same panel for staff and for the owning technician: both read, only
            the manual refresh writes, and the route authorizes identically for
            either. There is no editing affordance for anyone — v0.5 diagnostics
            are read-only against the ERP.
          */}
          <CustomerDiagnosticPanel
            orderId={order.id}
            initialDiagnostic={diagnosticView}
          />

          {pppoeConnection && (
            <PppoeAccessPanel
              orderId={order.id}
              connectionId={pppoeConnection.id}
              username={pppoeConnection.username}
              passwordConfigured={pppoeConnection.passwordConfigured}
              canReveal={canRevealPassword}
              revealBlockedReason={revealBlockedReason}
            />
          )}

          {isExecuting && order.execution && (
            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <h2 className="mb-4 text-base font-semibold text-slate-900">
                Execução
              </h2>
              {executionIssue ? (
                <ExecutionReadOnly execution={order.execution} />
              ) : (
                <ServiceOrderExecutionForm
                  orderId={order.id}
                  /*
                    Versão da EXECUÇÃO (não da OS): o lock cobre o texto que o
                    técnico está editando, não mudanças alheias na OS.
                  */
                  version={order.execution.version}
                  initialDiagnosis={order.execution.diagnosis}
                  initialWorkPerformed={order.execution.workPerformed}
                  initialNotes={order.execution.notes}
                  maxLength={EXECUTION_TEXT_MAX_LENGTH}
                />
              )}
            </div>
          )}

          {showExecutionReadOnly && order.execution && (
            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <h2 className="mb-4 text-base font-semibold text-slate-900">
                Execução
              </h2>
              <ExecutionReadOnly execution={order.execution} />
            </div>
          )}

          {/*
            Closing workspace: only the owning technician, only while the order
            is in progress, only when writes are allowed. Everyone else — staff,
            and the technician once the order is COMPLETED — gets the read-only
            rendering below, which has no editing affordance at all.
          */}
          {showClosingPanel && order.execution ? (
            <ServiceOrderClosingPanel
              orderId={order.id}
              initialOrderVersion={order.version}
              executionVersion={order.execution.version}
              evidences={closing.evidences}
              materials={closing.materials}
              signature={closing.signature}
              canComplete={canComplete}
              blockedReason={executionIssue}
            />
          ) : (
            showClosingReadOnly && (
              <ServiceOrderClosingReadOnly
                orderId={order.id}
                evidences={closing.evidences}
                materials={closing.materials}
                signature={closing.signature}
              />
            )
          )}

          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="mb-4 text-base font-semibold text-slate-900">Timeline</h2>
            {order.events.length === 0 ? (
              <p className="text-sm text-slate-500">Nenhum evento registrado.</p>
            ) : (
              <ol className="relative ml-3 space-y-6 border-l border-slate-200 pl-6">
                {order.events.map((event) => (
                  <li key={event.id} className="relative">
                    <span className="absolute -left-[31px] flex h-3 w-3 items-center justify-center rounded-full border-2 border-blue-500 bg-white" />
                    <p className="text-sm font-medium text-slate-900">
                      {EVENT_LABELS[event.event] ?? event.event}
                    </p>
                    <p className="text-xs text-slate-500">
                      {event.userName ?? "Sistema"} · {formatDate(event.createdAt)}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>

        <div className="space-y-4">
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="mb-3 text-base font-semibold text-slate-900">Técnico</h2>
            {order.technician ? (
              <div>
                <p className="text-sm font-medium text-slate-900">{order.technician.name}</p>
                {!isStaff && (
                  <p className="mt-1 text-xs text-slate-500">Esta OS está atribuída a você.</p>
                )}
              </div>
            ) : (
              <p className="text-sm text-slate-500">Nenhum técnico atribuído.</p>
            )}
          </div>

          {isStaff && (
            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <h2 className="mb-3 text-base font-semibold text-slate-900">
                {order.status === "PENDING" ? "Atribuir técnico" : "Trocar técnico"}
              </h2>
              {order.status !== "PENDING" && order.status !== "ASSIGNED" ? (
                <p className="text-sm text-slate-500">
                  Não é possível atribuir uma OS no estado {SERVICE_ORDER_STATUS_LABELS[order.status]}.
                </p>
              ) : (
                <AssignTechnicianForm
                  orderId={order.id}
                  /**
                   * A versão que ESTA renderização leu. Vai junto no POST como
                   * `expectedVersion`, fechando o lock de ponta a ponta: se a
                   * OS mudou depois desta tela ter sido montada, a atribuição é
                   * recusada com 409 em vez de sobrescrever. `router.refresh()`
                   * re-renderiza este Server Component e atualiza a prop.
                   */
                  version={order.version}
                  technicians={technicians}
                />
              )}
            </div>
          )}

          {isExecuting && (
            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
              <p className="text-sm text-amber-800">
                O fechamento da OS (fotos, materiais e assinatura) será
                habilitado na próxima versão do AlfaOS.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
