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
import { formatBrazilianPhone } from "@/integrations/service-tickets";
import {
  EXECUTION_TEXT_MAX_LENGTH,
  formatServiceOrderNumber,
  getCompanyServiceOrder,
  getTechnicianByUserId,
  SERVICE_ORDER_ORIGIN_LABELS,
  SERVICE_ORDER_STATUS_LABELS,
} from "@/lib/service-orders";
import { listActiveTechnicianOptions } from "@/lib/technicians";
import { PriorityBadge, StatusBadge } from "@/components/OrderBadges";
import { getServiceOrderClosingBundle } from "@/lib/service-order-closing";
import { getCustomerDiagnostic } from "@/lib/customer-diagnostics";
import { CustomerDiagnosticPanel } from "@/components/CustomerDiagnosticPanel";
import { ReceitanetContextPanel } from "@/components/ReceitanetContextPanel";
import { AssignTechnicianForm } from "@/components/AssignTechnicianForm";
import { ServiceOrderExecutionForm } from "@/components/ServiceOrderExecutionForm";
import { StartServiceOrderButton } from "@/components/StartServiceOrderButton";
import { ServiceOrderClosingPanel } from "@/components/ServiceOrderClosingPanel";
import { ServiceOrderClosingReadOnly } from "@/components/ServiceOrderClosingReadOnly";

export const metadata: Metadata = {
  title: "Detalhes da OS",
};

/** Card padrão da tela. Extraído só para não repetir a mesma classe 8 vezes. */
function Card({
  title,
  children,
  action,
}: {
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-slate-900">{title}</h2>
        {action}
      </div>
      {children}
    </div>
  );
}

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
   * Predicado EXPLICITO para o bloco do ERP, e nao `isStaff`.
   *
   * `isStaff` e derivado por negacao (`!isOwnerTechnician`) e hoje coincide,
   * porque um tecnico nao-dono ja levou 404 acima. Mas o bloco alcanca dado
   * financeiro do cliente, e um gate desses nao pode depender de uma coincidencia
   * que a proxima mudanca de fluxo desfaz em silencio. Aqui a regra e a mesma
   * que a rota aplica, escrita do mesmo jeito.
   */
  const canSeeErpContext =
    session.profile === AccessProfile.ADMIN ||
    session.profile === AccessProfile.DISPATCHER;

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
  /**
   * TODAS as conexões ativas, não a primeira.
   *
   * `CustomerConnection` sempre foi uma coleção (PRD §132) e o serviço de
   * revelação já valida o `connectionId` recebido contra o cliente DA OS e
   * contra `active` — mostrar mais de uma não abre superfície nenhuma. O que
   * a versão anterior fazia era esconder da tela conexões que a API já
   * autorizava, deixando o técnico sem o acesso que ele tinha direito de ver.
   *
   * Inativas continuam fora: o reveal as recusa, e listá-las só ofereceria uma
   * ação que sempre falha.
   */
  const pppoeConnections = connections.filter((c) => c.active);

  /**
   * Quem vê a seção de acesso do cliente.
   *
   * Espelha exatamente quem teve `connections` carregada acima — DISPATCHER
   * não recebe nem o `username`. Escrito como predicado próprio para que a
   * regra fique legível numa linha, e não implícita num array vazio.
   */
  const showCustomerAccess =
    session.profile === AccessProfile.ADMIN || isOwnerTechnician;
  /**
   * Atalho para o cadastro do cliente, onde a conexão é criada e editada.
   *
   * Só para ADMIN: `/clientes/[id]/editar` já exige ADMIN ou DISPATCHER, e o
   * cadastro/edição da CONEXÃO dentro dela é restrito a ADMIN pela API
   * (`/api/customers/[id]/connections`). Oferecer o link a quem a API recusa
   * seria a mesma falha de UI corrigida na v0.5.1 no botão de revelar.
   */
  const canManageConnections = session.profile === AccessProfile.ADMIN;

  const orderAllowsReveal = (
    REVEALABLE_ORDER_STATUSES as readonly string[]
  ).includes(order.status);
  /**
   * ADMIN mantém a capacidade administrativa; o técnico dono precisa do
   * atendimento em curso E de estar operacionalmente elegível.
   *
   * `executionIssue` já é o resultado de `technicianExecutionIssue` (calculado
   * em `getTechnicianByUserId`) — a MESMA função que o serviço de reveal
   * consulta. Reutilizá-lo aqui alinha as duas pontas sem reescrever a regra
   * no frontend: se a elegibilidade mudar, muda nos dois lugares de uma vez.
   *
   * A UI não é o controle de segurança — `revealConnectionPasswordForOrder`
   * continua sendo a autoridade final e recusa com 403 mesmo que esta tela
   * ofereça a ação. O que esta linha evita é oferecer um botão que o servidor
   * sempre vai negar.
   */
  const canRevealPassword =
    session.profile === AccessProfile.ADMIN ||
    (isOwnerTechnician && orderAllowsReveal && executionIssue === null);
  /**
   * Elegibilidade antes de status, na mesma ordem em que o servidor avalia:
   * um técnico inativo numa OS concluída ouve que seu perfil está inativo, e
   * não que o atendimento terminou.
   */
  const revealBlockedReason = isOwnerTechnician
    ? (executionIssue ??
      (orderAllowsReveal
        ? null
        : "A senha só pode ser revelada enquanto o atendimento estiver em andamento."))
    : null;
  const technicians = isStaff
    ? await listActiveTechnicianOptions(session.companyId)
    : [];

  /*
    Tipo, prioridade e status saíram daqui: subiram para o cabeçalho, junto do
    número. Repeti-los nesta tabela faria o operador ler a mesma informação
    duas vezes para encontrar a que só existe aqui.
  */
  const infoRows = [
    { label: "Nº no ERP", value: order.externalNumber ?? "—" },
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
        technology: diagnosticSnapshot.technology,
        serverMaintenance: diagnosticSnapshot.serverMaintenance,
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
        {/*
          Identificação OPERACIONAL no topo. O `id` técnico não aparece aqui:
          ele continua sendo a chave e o valor da URL, mas "OS cmt7prb4" não é
          dizível ao telefone nem anotável numa ficha. Quem precisa do id para
          diagnóstico o encontra em "Detalhes", no fim da página.
        */}
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1
            data-testid="order-number"
            className="text-2xl font-bold text-slate-900"
          >
            {formatServiceOrderNumber(order)}
          </h1>
          <StatusBadge status={order.status} />
          <PriorityBadge priority={order.priority} />
        </div>
        <p className="mt-1 text-sm font-medium text-slate-700">
          {order.type}
          {order.subtype ? ` · ${order.subtype}` : ""}
        </p>
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
        {/*
          Hierarquia da tela: Cliente → Técnico → Acesso do cliente →
          Diagnóstico → Execução/Fechamento → Detalhes → Timeline.

          A ordem segue o que o técnico faz em campo: identifica o cliente,
          confere de quem é o atendimento, pega o acesso, olha o diagnóstico e
          só então registra o serviço. Datas e identificadores foram para o fim
          — são consulta, não fluxo.
        */}
        <div className="space-y-4 lg:col-span-2">
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="mb-1 text-base font-semibold text-slate-900">Cliente</h2>
            <p className="text-sm text-slate-900">{order.customer.name}</p>
            <dl className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <dt className="text-xs font-medium text-slate-500">Documento</dt>
                <dd className="mt-0.5 text-sm text-slate-900">{order.customer.document ?? "—"}</dd>
              </div>
              {/*
                Telefone é o que faz o técnico conseguir chegar. Um travessão
                solto no lugar dele é ambíguo: o operador não sabe se o campo
                está vazio no cadastro ou se a tela deixou de carregar. Dizer
                "Não informado" nomeia o problema e aponta para o conserto.

                O telefone alternativo só aparece quando existe — uma linha
                permanentemente vazia treina o olho a ignorar a região.
              */}
              <div>
                <dt className="text-xs font-medium text-slate-500">Telefone</dt>
                <dd className="mt-0.5 text-sm text-slate-900">
                  {order.customer.phone ? (
                    formatBrazilianPhone(order.customer.phone) ?? order.customer.phone
                  ) : (
                    <span className="text-slate-500">Não informado</span>
                  )}
                </dd>
              </div>
              {order.customer.secondaryPhone && (
                <div>
                  <dt className="text-xs font-medium text-slate-500">
                    Telefone alternativo
                  </dt>
                  <dd className="mt-0.5 text-sm text-slate-900">
                    {formatBrazilianPhone(order.customer.secondaryPhone) ??
                      order.customer.secondaryPhone}
                  </dd>
                </div>
              )}
              <div className="sm:col-span-2">
                <dt className="text-xs font-medium text-slate-500">Cidade</dt>
                <dd className="mt-0.5 text-sm text-slate-900">
                  {order.customer.city ? `${order.customer.city}${order.customer.state ? `/${order.customer.state}` : ""}` : "—"}
                </dd>
              </div>
            </dl>
          </div>

          <Card title="Técnico">
            {order.technician ? (
              <div>
                <p className="text-sm font-medium text-slate-900">
                  {order.technician.name}
                </p>
                {!isStaff && (
                  <p className="mt-1 text-xs text-slate-500">
                    Esta OS está atribuída a você.
                  </p>
                )}
              </div>
            ) : (
              <p className="text-sm text-slate-500">Nenhum técnico atribuído.</p>
            )}
          </Card>

          {/*
            Acesso do cliente.

            DISPATCHER nunca chega aqui: `connections` é `[]` para esse perfil,
            então o card inteiro não é renderizado — nem o usuário PPPoE, que
            também é dado de acesso do cliente.
          */}
          {showCustomerAccess && (
            <Card
              title="Acesso do cliente"
              action={
                canManageConnections ? (
                  <Link
                    href={`/clientes/${order.customer.id}/editar`}
                    className="text-sm font-medium text-blue-600 hover:text-blue-700"
                  >
                    Gerenciar acesso
                  </Link>
                ) : null
              }
            >
              {pppoeConnections.length === 0 ? (
                <p
                  data-testid="pppoe-not-configured"
                  className="text-sm text-slate-500"
                >
                  Acesso PPPoE não configurado.
                </p>
              ) : (
                <div className="space-y-6">
                  {pppoeConnections.map((connection) => (
                    <PppoeAccessPanel
                      key={connection.id}
                      orderId={order.id}
                      connectionId={connection.id}
                      username={connection.username}
                      passwordConfigured={connection.passwordConfigured}
                      variant={isOwnerTechnician ? "technician" : "admin"}
                      canReveal={canRevealPassword}
                      revealBlockedReason={revealBlockedReason}
                    />
                  ))}
                </div>
              )}
            </Card>
          )}

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

          {/*
            Contexto operacional do ERP: contrato, plano e chamados abertos.

            Somente ADMIN/DISPATCHER. O bloco alcanca dado financeiro do
            cliente, e o tecnico em campo nao precisa dele para executar o
            atendimento -- a rota tambem recusa TECHNICIAN, entao esconder aqui
            e consequencia do controle, nao o controle.
          */}
          {canSeeErpContext && <ReceitanetContextPanel orderId={order.id} />}

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

          <Card title="Detalhes">
            <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {infoRows.map((row) => (
                <div key={row.label}>
                  <dt className="text-xs font-medium text-slate-500">{row.label}</dt>
                  <dd className="mt-0.5 text-sm text-slate-900">{row.value}</dd>
                </div>
              ))}
            </dl>
            {/*
              O id técnico fica AQUI, no fim de "Detalhes", e não no cabeçalho:
              ele é o que se cola num chamado de suporte ou numa consulta ao
              banco, não o que se diz ao telefone. A identificação operacional
              é "OS Nº X", no topo da página.
            */}
            <div className="mt-4 border-t border-slate-100 pt-3">
              <dt className="text-xs font-medium text-slate-500">
                ID técnico (diagnóstico)
              </dt>
              <dd className="mt-0.5 break-all font-mono text-xs text-slate-500">
                {order.id}
              </dd>
            </div>
          </Card>

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

        {/*
          A coluna lateral guarda AÇÕES administrativas. O card informativo
          "Técnico" subiu para a coluna principal: no celular o grid empilha, e
          na lateral ele caía depois da Timeline — ou seja, o técnico da OS era
          a última coisa da página.
        */}
        <div className="space-y-4">
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
