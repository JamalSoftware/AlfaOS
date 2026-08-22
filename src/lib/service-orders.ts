import type {
  ServiceOrderPriority,
  ServiceOrderStatus,
} from "@prisma/client";
import { ServiceOrderSource } from "@prisma/client";
import { logAudit } from "./audit";
import { badRequest, conflict, notFound } from "./errors";
import { prisma } from "./prisma";

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

  const existing = await prisma.serviceOrder.findUnique({
    where: uniqueKey,
  });

  if (existing) {
    const updated = await prisma.serviceOrder.update({
      where: { id: existing.id },
      data: {
        externalNumber: input.externalNumber?.trim() || null,
        type: input.type.trim(),
        subtype: input.subtype?.trim() || null,
        description: input.description.trim(),
        scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null,
      },
    });
    return {
      serviceOrder: await withRelations(companyId, updated.id),
      created: false,
    };
  }

  const order = await prisma.$transaction(async (tx) => {
    const created = await tx.serviceOrder.create({
      data: {
        companyId,
        externalProvider: input.externalProvider,
        externalId: input.externalId,
        externalNumber: input.externalNumber?.trim() || null,
        customerId: customer.id,
        type: input.type.trim(),
        subtype: input.subtype?.trim() || null,
        description: input.description.trim(),
        priority: input.priority,
        status: "PENDING",
        source: ServiceOrderSource.IMPORTED,
        scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null,
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

export async function assignTechnician(
  companyId: string,
  actorId: string,
  orderId: string,
  technicianId: string,
): Promise<PublicServiceOrder> {
  await prisma.$transaction(async (tx) => {
    const os = await tx.serviceOrder.findFirst({
      where: { id: orderId, companyId },
    });
    if (!os) {
      throw notFound("Ordem de serviço não encontrada.");
    }

    const technician = await tx.technician.findFirst({
      where: { id: technicianId, companyId },
      include: { user: { select: { name: true } } },
    });
    if (!technician) {
      throw notFound("Técnico não encontrado nesta empresa.");
    }
    if (!technician.active) {
      throw badRequest("Somente técnicos ativos podem receber OS.");
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

    const result = await tx.serviceOrder.updateMany({
      where: { id: os.id, updatedAt: os.updatedAt },
      data: {
        technicianId: technician.id,
        status: "ASSIGNED",
        assignedAt: wasAssigned ? os.assignedAt : new Date(),
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

    return os.id;
  });

  await logAudit({
    companyId,
    userId: actorId,
    action: "SERVICE_ORDER.ASSIGNED",
    entity: "ServiceOrder",
    entityId: orderId,
    details: `OS atribuída/trocada para o técnico ${orderId.slice(0, 8)}`,
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
