import type {
  ServiceOrder,
  ServiceOrderPriority,
  ServiceOrderStatus,
} from "@prisma/client";
import { ServiceOrderSource } from "@prisma/client";
import { logAudit } from "./audit";
import {
  badRequest,
  conflict,
  isUniqueConstraintError,
  notFound,
} from "./errors";
import { prisma } from "./prisma";
import { technicianAssignmentIssue } from "./technicians";

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

export const SERVICE_ORDER_SOURCE_LABELS: Record<ServiceOrderSource, string> = {
  MANUAL: "Manual",
  IMPORTED: "Importada do ERP",
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
  source: ServiceOrderSource;
  scheduledAt: Date | null;
  assignedAt: Date | null;
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

export interface ServiceOrderDetail extends PublicServiceOrder {
  events: ServiceOrderEventInfo[];
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
  source: ServiceOrderSource;
  scheduledAt: Date | null;
  assignedAt: Date | null;
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
    source: order.source,
    scheduledAt: order.scheduledAt,
    assignedAt: order.assignedAt,
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
  type: string;
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

  const order = await prisma.$transaction(async (tx) => {
    const created = await tx.serviceOrder.create({
      data: {
        companyId,
        customerId: input.customerId,
        type: input.type.trim(),
        subtype: input.subtype?.trim() || null,
        description: input.description.trim(),
        priority: input.priority,
        status: "PENDING",
        source: ServiceOrderSource.MANUAL,
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
          priority: created.priority,
          source: "MANUAL",
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
          source: ServiceOrderSource.IMPORTED,
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
            source: input.externalProvider,
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
  };
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

export interface TechnicianWorkQueue {
  today: PublicServiceOrder[];
  upcoming: PublicServiceOrder[];
}

export async function getTechnicianByUserId(
  companyId: string,
  userId: string,
): Promise<{ id: string; active: boolean } | null> {
  const technician = await prisma.technician.findFirst({
    where: { userId, companyId },
    select: { id: true, active: true },
  });
  return technician;
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

  const today: typeof orders = [];
  const upcoming: typeof orders = [];

  for (const order of orders) {
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
    today: today.map(toPublicServiceOrder),
    upcoming: upcoming.map(toPublicServiceOrder),
  };
}
