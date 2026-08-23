import type {
  ServiceOrder,
  ServiceOrderPriority,
  ServiceOrderStatus,
} from "@prisma/client";
import { ServiceOrderOrigin } from "@prisma/client";
import { logAudit } from "./audit";
import {
  badRequest,
  conflict,
  forbidden,
  isUniqueConstraintError,
  notFound,
} from "./errors";
import { prisma } from "./prisma";
import { resolveServiceOrderTypeForCreation } from "./service-order-types";
import {
  technicianAssignmentIssue,
  technicianExecutionIssue,
} from "./technicians";

// ---------------------------------------------------------------------------
// Centralized labels (single source of truth for the UI).
// ---------------------------------------------------------------------------

export const SERVICE_ORDER_STATUS_LABELS: Record<ServiceOrderStatus, string> = {
  PENDING: "Pendente",
  ASSIGNED: "Atribuída",
  IN_PROGRESS: "Em atendimento",
  COMPLETED: "Concluída",
  CANCELLED: "Cancelada",
};

export const SERVICE_ORDER_PRIORITY_LABELS: Record<
  ServiceOrderPriority,
  string
> = {
  LOW: "Baixa",
  NORMAL: "Normal",
  HIGH: "Alta",
  URGENT: "Urgente",
};

/**
 * Rótulos de ORIGEM — onde a OS nasceu (PRD §122).
 *
 * Não confundir com `externalProvider`: uma OS INTERNAL pode ganhar vínculo
 * externo depois e continua INTERNAL. A origem é gravada na criação e nunca
 * derivada dos campos externos.
 */
export const SERVICE_ORDER_ORIGIN_LABELS: Record<ServiceOrderOrigin, string> = {
  INTERNAL: "Interna (AlfaOS)",
  EXTERNAL: "Externa (ERP)",
};

export const SERVICE_ORDER_PRIORITY_ORDER: Record<
  ServiceOrderPriority,
  number
> = {
  URGENT: 3,
  HIGH: 2,
  NORMAL: 1,
  LOW: 0,
};

export const ACTIVE_SERVICE_ORDER_STATUSES: ServiceOrderStatus[] = [
  "PENDING",
  "ASSIGNED",
  "IN_PROGRESS",
];

/**
 * Allowed state transitions. Anything not listed here is an illegal
 * transition and is rejected by the central service.
 */
export const ALLOWED_STATUS_TRANSITIONS: Record<
  ServiceOrderStatus,
  ServiceOrderStatus[]
> = {
  PENDING: ["ASSIGNED", "CANCELLED"],
  ASSIGNED: ["ASSIGNED", "IN_PROGRESS", "CANCELLED"],
  IN_PROGRESS: ["COMPLETED", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
};

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export interface ServiceOrderCustomerInfo {
  id: string;
  name: string;
  document: string | null;
  phone: string | null;
  city: string | null;
  state: string | null;
}

export interface ServiceOrderTechnicianInfo {
  id: string;
  name: string;
}

export interface PublicServiceOrder {
  id: string;
  externalNumber: string | null;
  type: string;
  subtype: string | null;
  description: string;
  priority: ServiceOrderPriority;
  status: ServiceOrderStatus;
  origin: ServiceOrderOrigin;
  externalProvider: string | null;
  scheduledAt: Date | null;
  assignedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  /**
   * Optimistic-lock token, exposed so the client can send it back as
   * `expectedVersion` on the next write. Without it the lock only covers the
   * window between two in-flight requests, never the window between what the
   * operator READ on screen and what they later clicked.
   */
  version: number;
  customer: ServiceOrderCustomerInfo;
  technician: ServiceOrderTechnicianInfo | null;
}

export interface ServiceOrderEventInfo {
  id: string;
  event: string;
  metadata: unknown;
  userName: string | null;
  createdAt: Date;
}

/**
 * Public shape of a `ServiceOrderExecution`. `version` travels to the client
 * so the next save can send it back as `expectedVersion` — the execution has
 * its OWN lock, separate from the order's.
 */
export interface ServiceOrderExecutionInfo {
  id: string;
  diagnosis: string | null;
  workPerformed: string | null;
  notes: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ServiceOrderDetail extends PublicServiceOrder {
  events: ServiceOrderEventInfo[];
  /** Null until the technician starts the order. */
  execution: ServiceOrderExecutionInfo | null;
}

export interface ServiceOrderListResult {
  serviceOrders: PublicServiceOrder[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ListServiceOrdersParams {
  status?: ServiceOrderStatus;
  priority?: ServiceOrderPriority;
  technicianId?: string;
  search?: string;
  page?: number;
  pageSize?: number;
}

const ORDER_INCLUDE = {
  customer: {
    select: {
      id: true,
      name: true,
      document: true,
      phone: true,
      city: true,
      state: true,
    },
  },
  technician: {
    select: { id: true, user: { select: { name: true } } },
  },
} as const;

export function toPublicServiceOrder(order: {
  id: string;
  externalNumber: string | null;
  type: string;
  subtype: string | null;
  description: string;
  priority: ServiceOrderPriority;
  status: ServiceOrderStatus;
  origin: ServiceOrderOrigin;
  externalProvider: string | null;
  scheduledAt: Date | null;
  assignedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
  customer: {
    id: string;
    name: string;
    document: string | null;
    phone: string | null;
    city: string | null;
    state: string | null;
  };
  technician: { id: string; user: { name: string } } | null;
}): PublicServiceOrder {
  return {
    id: order.id,
    externalNumber: order.externalNumber,
    type: order.type,
    subtype: order.subtype,
    description: order.description,
    priority: order.priority,
    status: order.status,
    origin: order.origin,
    externalProvider: order.externalProvider,
    scheduledAt: order.scheduledAt,
    assignedAt: order.assignedAt,
    startedAt: order.startedAt,
    completedAt: order.completedAt,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    version: order.version,
    customer: order.customer,
    technician: order.technician
      ? { id: order.technician.id, name: order.technician.user.name }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Manual creation
// ---------------------------------------------------------------------------

export interface CreateManualServiceOrderInput {
  customerId: string;
  /** Tipo do catálogo da própria empresa. O rótulo é copiado para `type`. */
  typeId: string;
  subtype?: string;
  description: string;
  priority: ServiceOrderPriority;
  scheduledAt?: string | null;
}

export async function createManualServiceOrder(
  companyId: string,
  actorId: string,
  input: CreateManualServiceOrderInput,
): Promise<PublicServiceOrder> {
  const customer = await prisma.customer.findFirst({
    where: { id: input.customerId, companyId },
  });
  if (!customer) {
    throw notFound("Cliente não encontrado nesta empresa.");
  }

  const type = await resolveServiceOrderTypeForCreation(companyId, input.typeId);

  const order = await prisma.$transaction(async (tx) => {
    const created = await tx.serviceOrder.create({
      data: {
        companyId,
        customerId: input.customerId,
        typeId: type.id,
        // Rótulo copiado, não referenciado: preserva o histórico quando o tipo
        // for renomeado ou desativado.
        type: type.label,
        subtype: input.subtype?.trim() || null,
        description: input.description.trim(),
        priority: input.priority,
        status: "PENDING",
        // Gravada explicitamente. Uma OS criada aqui é INTERNAL mesmo que ganhe
        // vínculo com ERP depois — a origem nunca é derivada dos campos
        // externos (PRD §122).
        origin: ServiceOrderOrigin.INTERNAL,
        scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null,
      },
    });

    await tx.serviceOrderEvent.create({
      data: {
        companyId,
        serviceOrderId: created.id,
        userId: actorId,
        event: "SERVICE_ORDER_CREATED",
        metadata: {
          type: created.type,
          typeId: created.typeId,
          priority: created.priority,
          origin: ServiceOrderOrigin.INTERNAL,
        },
      },
    });

    return created;
  });

  await logAudit({
    companyId,
    userId: actorId,
    action: "SERVICE_ORDER.CREATED",
    entity: "ServiceOrder",
    entityId: order.id,
    details: `OS criada manualmente: ${order.type} (${input.priority})`,
  });

  return withRelations(companyId, order.id);
}

// ---------------------------------------------------------------------------
// Import from ERP (idempotent by company + provider + externalId)
// ---------------------------------------------------------------------------

export interface ERPOrderCustomerInput {
  externalId: string;
  name: string;
  document?: string;
  phone?: string;
  email?: string;
  address?: string;
  number?: string;
  complement?: string;
  district?: string;
  city?: string;
  state?: string;
  zipCode?: string;
}

export interface ImportServiceOrderInput {
  externalProvider: string;
  externalId: string;
  externalNumber?: string;
  type: string;
  subtype?: string;
  description: string;
  priority: ServiceOrderPriority;
  scheduledAt?: string | null;
  customer: ERPOrderCustomerInput;
}

export interface ImportServiceOrderResult {
  serviceOrder: PublicServiceOrder;
  created: boolean;
}

/**
 * Idempotent import:
 * - 1st sync creates the customer + OS (PENDING, IMPORTED).
 * - Later syncs update only external fields (description, scheduling,
 *   contact) and never overwrite technicianId, status, assignedAt or the
 *   internal timeline.
 */
export async function importServiceOrder(
  companyId: string,
  actorId: string,
  input: ImportServiceOrderInput,
): Promise<ImportServiceOrderResult> {
  const customer = await prisma.customer.upsert({
    where: {
      companyId_externalProvider_externalId: {
        companyId,
        externalProvider: input.externalProvider,
        externalId: input.customer.externalId,
      },
    },
    create: {
      companyId,
      externalProvider: input.externalProvider,
      externalId: input.customer.externalId,
      name: input.customer.name.trim(),
      document: input.customer.document?.trim() || null,
      phone: input.customer.phone?.trim() || null,
      email: input.customer.email?.trim().toLowerCase() || null,
      address: input.customer.address?.trim() || null,
      number: input.customer.number?.trim() || null,
      complement: input.customer.complement?.trim() || null,
      district: input.customer.district?.trim() || null,
      city: input.customer.city?.trim() || null,
      state: input.customer.state?.trim().toUpperCase() || null,
      zipCode: input.customer.zipCode?.trim() || null,
    },
    update: {
      name: input.customer.name.trim(),
      phone: input.customer.phone?.trim() || null,
      email: input.customer.email?.trim().toLowerCase() || null,
      address: input.customer.address?.trim() || null,
      city: input.customer.city?.trim() || null,
      state: input.customer.state?.trim().toUpperCase() || null,
    },
  });

  const uniqueKey = {
    companyId_externalProvider_externalId: {
      companyId,
      externalProvider: input.externalProvider,
      externalId: input.externalId,
    },
  };

  // Fields refreshed on every re-import. Never touches status, technicianId,
  // assignedAt or the timeline.
  const externalData = {
    externalNumber: input.externalNumber?.trim() || null,
    type: input.type.trim(),
    subtype: input.subtype?.trim() || null,
    description: input.description.trim(),
    scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null,
  };

  // A re-import is a real modification of the row, so it bumps `version` too.
  // Otherwise an assignment holding a read from before the sync would still
  // pass its compare-and-set and write over fields it never saw.
  const externalUpdate = {
    ...externalData,
    version: { increment: 1 },
  };

  const existing = await prisma.serviceOrder.findUnique({
    where: uniqueKey,
  });

  if (existing) {
    const updated = await prisma.serviceOrder.update({
      where: { id: existing.id },
      data: externalUpdate,
    });
    return {
      serviceOrder: await withRelations(companyId, updated.id),
      created: false,
    };
  }

  /**
   * Creation is racy by nature: two concurrent syncs of the same externalId
   * both see "not found". The insert + timeline event run in one transaction
   * and the unique index (companyId, externalProvider, externalId) is the
   * arbiter — the loser's transaction rolls back whole (no orphan event) and
   * is retried as an update, so there is no duplicate row and no duplicate
   * SERVICE_ORDER_IMPORTED event.
   */
  let order: ServiceOrder;
  try {
    order = await prisma.$transaction(async (tx) => {
      const created = await tx.serviceOrder.create({
        data: {
          companyId,
          externalProvider: input.externalProvider,
          externalId: input.externalId,
          customerId: customer.id,
          priority: input.priority,
          status: "PENDING",
          // Nasceu em sistema externo. O CHECK do banco garante que
          // externalProvider e externalId acompanham.
          origin: ServiceOrderOrigin.EXTERNAL,
          ...externalData,
        },
      });

      await tx.serviceOrderEvent.create({
        data: {
          companyId,
          serviceOrderId: created.id,
          userId: actorId,
          event: "SERVICE_ORDER_IMPORTED",
          metadata: {
            externalNumber: created.externalNumber,
            type: created.type,
            priority: created.priority,
            origin: ServiceOrderOrigin.EXTERNAL,
            externalProvider: input.externalProvider,
          },
        },
      });

      return created;
    });
  } catch (error) {
    if (!isUniqueConstraintError(error)) {
      throw error;
    }
    const updated = await prisma.serviceOrder.update({
      where: uniqueKey,
      data: externalUpdate,
    });
    return {
      serviceOrder: await withRelations(companyId, updated.id),
      created: false,
    };
  }

  await logAudit({
    companyId,
    userId: actorId,
    action: "SERVICE_ORDER.IMPORTED",
    entity: "ServiceOrder",
    entityId: order.id,
    details: `OS importada do ERP (${input.externalProvider}) #${input.externalNumber ?? input.externalId}`,
  });

  return {
    serviceOrder: await withRelations(companyId, order.id),
    created: true,
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function listCompanyServiceOrders(
  companyId: string,
  params: ListServiceOrdersParams = {},
): Promise<ServiceOrderListResult> {
  const page = Math.max(1, params.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, params.pageSize ?? 20));

  const where: Record<string, unknown> = { companyId };
  if (params.status) where.status = params.status;
  if (params.priority) where.priority = params.priority;
  if (params.technicianId) where.technicianId = params.technicianId;
  if (params.search) {
    where.OR = [
      { externalNumber: { contains: params.search, mode: "insensitive" } },
      { type: { contains: params.search, mode: "insensitive" } },
      { description: { contains: params.search, mode: "insensitive" } },
      {
        customer: {
          name: { contains: params.search, mode: "insensitive" },
        },
      },
    ];
  }

  const [serviceOrders, total] = await Promise.all([
    prisma.serviceOrder.findMany({
      where,
      include: ORDER_INCLUDE,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.serviceOrder.count({ where }),
  ]);

  return {
    serviceOrders: serviceOrders.map(toPublicServiceOrder),
    total,
    page,
    pageSize,
  };
}

export async function getCompanyServiceOrder(
  companyId: string,
  orderId: string,
): Promise<ServiceOrderDetail | null> {
  const order = await prisma.serviceOrder.findFirst({
    where: { id: orderId, companyId },
    include: {
      ...ORDER_INCLUDE,
      events: {
        orderBy: { createdAt: "asc" },
        include: { user: { select: { name: true } } },
      },
    },
  });
  if (!order) {
    return null;
  }

  const events: ServiceOrderEventInfo[] = order.events.map((event) => ({
    id: event.id,
    event: event.event,
    metadata: event.metadata,
    userName: event.user?.name ?? null,
    createdAt: event.createdAt,
  }));

  return {
    ...toPublicServiceOrder(order),
    events,
    execution: await getCompanyServiceOrderExecution(companyId, order.id),
  };
}

/**
 * The execution of one order, tenant-filtered in SQL on BOTH ends.
 *
 * Deliberately a second query rather than an `include` on the order above.
 * Prisma cannot attach a `where` to a to-one relation include, so an
 * `include` would reach the row purely by FK navigation and the `companyId`
 * check would degrade to an application-level `if`. Here the predicate is
 * `serviceOrderId AND companyId`, so a row whose tenant does not match the
 * caller's session is not filtered out after the fact — it is never read.
 *
 * The cost is one indexed point lookup on a detail screen, and it does not
 * introduce an N+1: no listing includes the execution.
 */
export async function getCompanyServiceOrderExecution(
  companyId: string,
  orderId: string,
): Promise<ServiceOrderExecutionInfo | null> {
  const execution = await prisma.serviceOrderExecution.findFirst({
    where: { serviceOrderId: orderId, companyId },
    select: {
      id: true,
      diagnosis: true,
      workPerformed: true,
      notes: true,
      version: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  return execution;
}

async function withRelations(
  companyId: string,
  orderId: string,
): Promise<PublicServiceOrder> {
  const order = await prisma.serviceOrder.findFirst({
    where: { id: orderId, companyId },
    include: ORDER_INCLUDE,
  });
  if (!order) {
    throw notFound("Ordem de serviço não encontrada.");
  }
  return toPublicServiceOrder(order);
}

// ---------------------------------------------------------------------------
// Assignment (assign + change) with optimistic locking
// ---------------------------------------------------------------------------

/**
 * Assigns (or changes) the technician of an order.
 *
 * `expectedVersion` is the `version` the CALLER read — the one it had on screen
 * when the operator decided. When given, it becomes the compare-and-set
 * predicate, so a decision taken over a stale read is refused with 409 instead
 * of silently overwriting whoever wrote first. When omitted, the predicate is
 * the version re-read inside the transaction: the pre-existing behaviour, kept
 * intact for callers that do not participate in the end-to-end lock.
 */
export async function assignTechnician(
  companyId: string,
  actorId: string,
  orderId: string,
  technicianId: string,
  expectedVersion?: number,
): Promise<PublicServiceOrder> {
  const assigned = await prisma.$transaction(async (tx) => {
    const os = await tx.serviceOrder.findFirst({
      where: { id: orderId, companyId },
    });
    if (!os) {
      throw notFound("Ordem de serviço não encontrada.");
    }

    const technician = await tx.technician.findFirst({
      where: { id: technicianId, companyId },
      include: {
        user: {
          select: {
            name: true,
            companyId: true,
            active: true,
            profile: true,
          },
        },
      },
    });
    if (!technician) {
      throw notFound("Técnico não encontrado nesta empresa.");
    }

    // Assignability is more than `Technician.active`: the linked User must also
    // exist, be active, still hold the TECHNICIAN profile and belong to this
    // company. Same rule the dropdown uses (`listActiveTechnicianOptions`), so
    // the UI never offers an option this would reject. Existing assignments are
    // untouched — this only gates NEW ones.
    const issue = technicianAssignmentIssue(companyId, technician);
    if (issue) {
      throw badRequest(issue);
    }

    const allowed = ALLOWED_STATUS_TRANSITIONS[os.status];
    if (!allowed.includes("ASSIGNED")) {
      throw conflict(
        `Não é possível atribuir uma OS no estado ${os.status}.`,
      );
    }

    if (os.technicianId === technicianId) {
      throw conflict("A OS já está atribuída a este técnico.");
    }

    const wasAssigned = os.status === "ASSIGNED" && os.technicianId !== null;
    const event = wasAssigned ? "TECHNICIAN_CHANGED" : "TECHNICIAN_ASSIGNED";

    // Optimistic lock on an explicit version counter.
    //
    // This used to compare `updatedAt`. Prisma maps DateTime to Postgres
    // `timestamp(3)`, so two writes landing in the same millisecond both
    // satisfied the predicate and the second silently overwrote the first — a
    // lost update, and exactly the case the old test tolerated. `version` is a
    // monotonic integer bumped on every write, so the compare-and-set is
    // decided by identity, never by clock resolution.
    //
    // Postgres serialises the two UPDATEs on the row lock: the loser re-checks
    // the predicate against the winner's committed row, sees a bumped version,
    // matches nothing and gets a deterministic 409.
    //
    // Which version is compared decides HOW WIDE the protected window is:
    //
    // - `expectedVersion` (client-supplied): covers read-to-write. Dispatchers
    //   A and B both load the order at version N; A assigns Tech1 (N+1); B,
    //   still holding N, is refused instead of overwriting A's decision.
    // - `os.version` (re-read here): covers only request-to-request. A caller
    //   that does not send its version is, by definition, saying "assign
    //   whatever the current state is" — that path is preserved verbatim.
    //
    // Either way the predicate is an exact match, so a stale token can never
    // win: it matches zero rows. (A stale caller naming the technician that is
    // already assigned trips the equality rule above first — still a 409, just
    // a more specific message.)
    const lockVersion = expectedVersion ?? os.version;

    const result = await tx.serviceOrder.updateMany({
      where: { id: os.id, version: lockVersion },
      data: {
        technicianId: technician.id,
        status: "ASSIGNED",
        assignedAt: wasAssigned ? os.assignedAt : new Date(),
        version: { increment: 1 },
      },
    });

    if (result.count !== 1) {
      throw conflict(
        "A OS foi modificada por outra requisição. Recarregue e tente novamente.",
      );
    }

    const previousTechnician = wasAssigned
      ? os.technicianId
        ? await tx.technician.findFirst({
            where: { id: os.technicianId },
            include: { user: { select: { name: true } } },
          })
        : null
      : null;

    await tx.serviceOrderEvent.create({
      data: {
        companyId,
        serviceOrderId: os.id,
        userId: actorId,
        event,
        metadata: {
          technicianId: technician.id,
          technicianName: technician.user.name,
          previousTechnicianId: previousTechnician?.id ?? null,
          previousTechnicianName: previousTechnician?.user.name ?? null,
        },
      },
    });

    return { id: technician.id, name: technician.user.name };
  });

  await logAudit({
    companyId,
    userId: actorId,
    action: "SERVICE_ORDER.ASSIGNED",
    entity: "ServiceOrder",
    entityId: orderId,
    details: `OS atribuída/trocada para o técnico ${assigned.name}`,
  });

  return withRelations(companyId, orderId);
}

// ---------------------------------------------------------------------------
// Technician-facing queries
// ---------------------------------------------------------------------------

/**
 * Janela e teto do histórico recente do técnico.
 *
 * A fila operacional (`listServiceOrdersForTechnician`) continua contendo
 * SOMENTE ASSIGNED e IN_PROGRESS — misturar concluídas ali empurraria o
 * trabalho de hoje para baixo da tela em poucos dias. O histórico é uma
 * consulta separada, limitada em período e quantidade para não virar uma
 * listagem sem fim no celular.
 */
export const TECHNICIAN_COMPLETED_WINDOW_DAYS = 30;
export const TECHNICIAN_COMPLETED_LIMIT = 20;

/**
 * OS concluídas recentemente pelo próprio técnico.
 *
 * O escopo é fechado em SQL por `companyId` + `technicianId`: um técnico não
 * alcança o histórico de outro nem o de outra empresa, e o `technicianId` vem
 * sempre de `getTechnicianByUserId`, nunca do cliente.
 */
export async function listRecentCompletedForTechnician(
  companyId: string,
  technicianId: string,
): Promise<PublicServiceOrder[]> {
  const since = new Date();
  since.setDate(since.getDate() - TECHNICIAN_COMPLETED_WINDOW_DAYS);

  const orders = await prisma.serviceOrder.findMany({
    where: {
      companyId,
      technicianId,
      status: "COMPLETED",
      completedAt: { gte: since },
    },
    include: ORDER_INCLUDE,
    orderBy: { completedAt: "desc" },
    take: TECHNICIAN_COMPLETED_LIMIT,
  });

  return orders.map(toPublicServiceOrder);
}

export interface TechnicianWorkQueue {
  /**
   * Orders the technician already started. Kept in its own bucket — and
   * rendered first — because an order in progress is the one thing the
   * technician is doing RIGHT NOW; burying it inside "today" (or, when it has
   * no schedule, inside "upcoming") made the app's most urgent item the
   * hardest to find.
   */
  inProgress: PublicServiceOrder[];
  today: PublicServiceOrder[];
  upcoming: PublicServiceOrder[];
}

export interface TechnicianContext {
  id: string;
  active: boolean;
  /**
   * Why this technician may not WRITE (start an order, save an execution), or
   * null when they may. Reads are never gated by it: a deactivated technician
   * still opens "Minhas OS" and still sees the order they already started —
   * nothing already recorded is hidden or altered. The pages use this to
   * replace the action controls with the reason instead of rendering a button
   * the API would refuse.
   *
   * Derived from the same single rule as assignment
   * (`technicianEligibilityReason`), so the screen and the service layer can
   * never disagree about who may act.
   */
  executionIssue: string | null;
}

export async function getTechnicianByUserId(
  companyId: string,
  userId: string,
): Promise<TechnicianContext | null> {
  const technician = await prisma.technician.findFirst({
    where: { userId, companyId },
    select: {
      id: true,
      active: true,
      companyId: true,
      user: {
        select: { companyId: true, active: true, profile: true },
      },
    },
  });
  if (!technician) {
    return null;
  }
  return {
    id: technician.id,
    active: technician.active,
    executionIssue: technicianExecutionIssue(companyId, technician),
  };
}

export async function listServiceOrdersForTechnician(
  companyId: string,
  technicianId: string,
): Promise<TechnicianWorkQueue> {
  const where = {
    companyId,
    technicianId,
    status: { in: ["ASSIGNED", "IN_PROGRESS"] as ServiceOrderStatus[] },
  };

  const orders = await prisma.serviceOrder.findMany({
    where,
    include: ORDER_INCLUDE,
    orderBy: [{ priority: "desc" }, { scheduledAt: "asc" }],
  });

  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfDay = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
  );

  const inProgress: typeof orders = [];
  const today: typeof orders = [];
  const upcoming: typeof orders = [];

  for (const order of orders) {
    // Status wins over schedule: a started order belongs to "em atendimento"
    // regardless of when it was booked for.
    if (order.status === "IN_PROGRESS") {
      inProgress.push(order);
      continue;
    }
    const scheduled = order.scheduledAt
      ? new Date(order.scheduledAt)
      : null;
    if (scheduled && scheduled >= startOfDay && scheduled < endOfDay) {
      today.push(order);
    } else {
      upcoming.push(order);
    }
  }

  return {
    inProgress: inProgress.map(toPublicServiceOrder),
    today: today.map(toPublicServiceOrder),
    upcoming: upcoming.map(toPublicServiceOrder),
  };
}

// ---------------------------------------------------------------------------
// Technician execution (v0.3): start + diagnosis/work/notes
// ---------------------------------------------------------------------------

/** Cap on each free-text execution field. Guards against unbounded writes. */
export const EXECUTION_TEXT_MAX_LENGTH = 10_000;

export interface StartServiceOrderResult {
  serviceOrder: PublicServiceOrder;
  execution: ServiceOrderExecutionInfo;
}

export interface UpdateServiceOrderExecutionInput {
  diagnosis?: string | null;
  workPerformed?: string | null;
  notes?: string | null;
}

export const EXECUTION_EDITABLE_FIELDS = [
  "diagnosis",
  "workPerformed",
  "notes",
] as const;

export type ExecutionEditableField = (typeof EXECUTION_EDITABLE_FIELDS)[number];

export type ExecutionTx = Parameters<
  Parameters<typeof prisma.$transaction>[0]
>[0];

/**
 * Resolves WHICH technician is acting, from the session user alone.
 *
 * `technicianId` is never accepted from the client: ownership is derived
 * server-side as `session.user.id + companyId -> Technician`. A client that
 * sends someone else's technician id therefore cannot change who it is.
 *
 * A session user with no technician row cannot own any order, so the caller
 * gets the same 404 an unknown order would produce — no signal about whether
 * the order exists.
 */
export async function resolveActingTechnician(
  tx: ExecutionTx,
  companyId: string,
  actorUserId: string,
) {
  const technician = await tx.technician.findFirst({
    where: { userId: actorUserId, companyId },
    include: {
      user: {
        select: {
          name: true,
          companyId: true,
          active: true,
          profile: true,
        },
      },
    },
  });
  if (!technician) {
    throw notFound("Ordem de serviço não encontrada.");
  }

  // Same eligibility rule as assignment, phrased for the technician. WRITES
  // only: an inactive technician keeps read access to what they already have.
  const issue = technicianExecutionIssue(companyId, technician);
  if (issue) {
    throw forbidden(issue);
  }

  return technician;
}

/**
 * Loads the order and proves the acting technician owns it.
 *
 * A non-owner gets 404, never 403. 403 would confirm that the order exists and
 * belongs to a colleague, which is exactly the fact a technician probing ids
 * should not be able to learn. Same choice already made by
 * `GET /api/service-orders/[id]`.
 */
export async function loadOwnedServiceOrder(
  tx: ExecutionTx,
  companyId: string,
  technicianId: string,
  orderId: string,
) {
  const order = await tx.serviceOrder.findFirst({
    where: { id: orderId, companyId },
  });
  if (!order) {
    throw notFound("Ordem de serviço não encontrada.");
  }
  if (order.technicianId !== technicianId) {
    throw notFound("Ordem de serviço não encontrada.");
  }
  return order;
}

function toExecutionInfo(execution: {
  id: string;
  diagnosis: string | null;
  workPerformed: string | null;
  notes: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}): ServiceOrderExecutionInfo {
  return {
    id: execution.id,
    diagnosis: execution.diagnosis,
    workPerformed: execution.workPerformed,
    notes: execution.notes,
    version: execution.version,
    createdAt: execution.createdAt,
    updatedAt: execution.updatedAt,
  };
}

/**
 * ASSIGNED -> IN_PROGRESS, performed by the owning technician.
 *
 * Modelled as an explicit ACTION, not as a generic "set status" endpoint. A
 * generic status mutation would have to trust the caller for the target state
 * and would need its own matrix of who-may-set-what; starting an order is one
 * business event with one actor, one side effect (`startedAt`), one artefact
 * (the execution row) and one timeline entry, so it is expressed as one
 * function.
 *
 * `expectedVersion` is REQUIRED here, unlike `assignTechnician` where it is
 * optional for backwards compatibility. This flow is new — there is no legacy
 * caller to protect — so the end-to-end lock is mandatory from day one.
 *
 * IDEMPOTENCY (double-click / retry). The chosen contract is a predictable
 * ERROR, never a silent second start:
 *
 *  - Sequential repeat (the first click already committed): the order now
 *    reads IN_PROGRESS, and `ALLOWED_STATUS_TRANSITIONS.IN_PROGRESS` does not
 *    contain IN_PROGRESS, so the transition guard rejects with a specific 409
 *    "já está em atendimento".
 *  - Genuinely simultaneous requests (both read ASSIGNED): both pass the
 *    guard, and the compare-and-set arbitrates — Postgres serialises the two
 *    UPDATEs on the row lock, exactly one matches `version: expectedVersion`,
 *    the loser matches zero rows and gets the generic 409.
 *
 * Either way the outcome is identical and safe: one `startedAt`, one
 * execution row, one `OS_STARTED` event. The execution INSERT is only reached
 * by the compare-and-set winner, and `serviceOrderId @unique` is the last-resort
 * arbiter — a duplicate would abort the whole transaction rather than leave a
 * started order with two executions.
 */
export async function startServiceOrder(
  companyId: string,
  actorUserId: string,
  orderId: string,
  expectedVersion: number,
): Promise<StartServiceOrderResult> {
  const started = await prisma.$transaction(async (tx) => {
    const technician = await resolveActingTechnician(
      tx,
      companyId,
      actorUserId,
    );
    const os = await loadOwnedServiceOrder(
      tx,
      companyId,
      technician.id,
      orderId,
    );

    // The state machine is the single authority on what may follow what.
    // PENDING lists only ASSIGNED/CANCELLED, so an unassigned order cannot be
    // started; COMPLETED and CANCELLED list nothing, so terminal orders cannot
    // be restarted.
    const allowed = ALLOWED_STATUS_TRANSITIONS[os.status];
    if (!allowed.includes("IN_PROGRESS")) {
      throw conflict(
        os.status === "IN_PROGRESS"
          ? "Esta OS já está em atendimento."
          : `Não é possível iniciar uma OS no estado ${SERVICE_ORDER_STATUS_LABELS[os.status]}.`,
      );
    }

    const startedAt = new Date();
    const result = await tx.serviceOrder.updateMany({
      where: { id: os.id, version: expectedVersion },
      data: {
        status: "IN_PROGRESS",
        startedAt,
        version: { increment: 1 },
      },
    });
    if (result.count !== 1) {
      throw conflict(
        "A OS foi modificada por outra requisição. Recarregue e tente novamente.",
      );
    }

    const execution = await tx.serviceOrderExecution.create({
      data: {
        companyId,
        serviceOrderId: os.id,
      },
    });

    await tx.serviceOrderEvent.create({
      data: {
        companyId,
        serviceOrderId: os.id,
        userId: actorUserId,
        event: "OS_STARTED",
        // Who started it is recorded here (and in the audit log) rather than
        // denormalized onto a `startedBy` column: IN_PROGRESS only transitions
        // to COMPLETED/CANCELLED, so the assignee cannot change after the
        // start and the fact can never drift out of sync with the order.
        metadata: {
          technicianId: technician.id,
          technicianName: technician.user.name,
          startedAt: startedAt.toISOString(),
        },
      },
    });

    return { execution, technicianName: technician.user.name };
  });

  await logAudit({
    companyId,
    userId: actorUserId,
    action: "SERVICE_ORDER.STARTED",
    entity: "ServiceOrder",
    entityId: orderId,
    details: `Atendimento iniciado pelo técnico ${started.technicianName}`,
  });

  return {
    serviceOrder: await withRelations(companyId, orderId),
    execution: toExecutionInfo(started.execution),
  };
}

/**
 * Saves diagnosis / work performed / notes on an order in progress.
 *
 * `expectedVersion` is the version of the EXECUTION, not of the order. The two
 * rows change for different reasons and must not share a lock: a dispatcher
 * touching the order should not invalidate the paragraph a technician is
 * halfway through typing, and vice versa.
 *
 * None of the three fields is required. "Serviço realizado" only becomes
 * mandatory at closing time (v0.4) — during execution a technician saves
 * whatever they have so far, possibly several times.
 */
export async function updateServiceOrderExecution(
  companyId: string,
  actorUserId: string,
  orderId: string,
  expectedVersion: number,
  input: UpdateServiceOrderExecutionInput,
): Promise<ServiceOrderExecutionInfo> {
  const result = await prisma.$transaction(async (tx) => {
    const technician = await resolveActingTechnician(
      tx,
      companyId,
      actorUserId,
    );
    const os = await loadOwnedServiceOrder(
      tx,
      companyId,
      technician.id,
      orderId,
    );

    if (os.status !== "IN_PROGRESS") {
      throw conflict(
        "Só é possível registrar a execução de uma OS em atendimento.",
      );
    }

    // Tenant filter on both ends, in SQL. The order was already scoped by
    // companyId, but the execution is fetched by its own tenant predicate too
    // rather than by FK navigation alone.
    const execution = await tx.serviceOrderExecution.findFirst({
      where: { serviceOrderId: os.id, companyId },
    });
    if (!execution) {
      throw notFound("Execução não encontrada para esta OS.");
    }

    // Explicit stale-token check before anything else, so a stale save is
    // refused even when its payload happens to change nothing. The
    // compare-and-set below remains the real arbiter for concurrent writers.
    if (execution.version !== expectedVersion) {
      throw conflict(
        "A execução foi modificada por outra requisição. Recarregue e tente novamente.",
      );
    }

    const data: Record<string, string | null> = {};
    const changedFields: ExecutionEditableField[] = [];
    for (const field of EXECUTION_EDITABLE_FIELDS) {
      const incoming = input[field];
      if (incoming === undefined) {
        continue;
      }
      // Empty text and "not filled in" are the same thing for a free-text
      // field, so both normalize to NULL and neither counts as a change when
      // the stored value is already absent.
      const normalized = incoming === null ? null : incoming.trim() || null;
      data[field] = normalized;
      if (normalized !== execution[field]) {
        changedFields.push(field);
      }
    }

    const updated = await tx.serviceOrderExecution.updateMany({
      where: { id: execution.id, version: expectedVersion },
      data: { ...data, version: { increment: 1 } },
    });
    if (updated.count !== 1) {
      throw conflict(
        "A execução foi modificada por outra requisição. Recarregue e tente novamente.",
      );
    }

    const fresh = await tx.serviceOrderExecution.findUniqueOrThrow({
      where: { id: execution.id },
    });

    // No ServiceOrderEvent here on purpose. The timeline records milestones
    // (created, assigned, started); a technician may save the same three
    // fields many times while working, and one event per save would drown the
    // real events in noise. The audit log carries the per-save record instead.
    return { fresh, changedFields };
  });

  if (result.changedFields.length > 0) {
    await logAudit({
      companyId,
      userId: actorUserId,
      action: "SERVICE_ORDER.EXECUTION_UPDATED",
      entity: "ServiceOrderExecution",
      entityId: result.fresh.id,
      // Field NAMES only, never their content. The audit log is an
      // administrative trail read by people who are not the technician; it
      // records that a diagnosis changed, not what the diagnosis says.
      details: `Execução da OS atualizada (campos: ${result.changedFields.join(", ")})`,
    });
  }

  return toExecutionInfo(result.fresh);
}
