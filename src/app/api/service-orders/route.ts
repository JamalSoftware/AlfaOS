import { AccessProfile, ServiceOrderPriority } from "@prisma/client";
import { z } from "zod";
import { assertProfile, jsonError, jsonOk, runApi } from "@/lib/api";
import { assertSameOrigin } from "@/lib/csrf";
import { getSessionUser } from "@/lib/session";
import {
  createManualServiceOrder,
  listCompanyServiceOrders,
} from "@/lib/service-orders";

const VIEW_PROFILES = [AccessProfile.ADMIN, AccessProfile.DISPATCHER];

const createServiceOrderSchema = z
  .object({
    customerId: z.string().min(1, "Cliente é obrigatório."),
    type: z.string().min(2, "Tipo é obrigatório.").max(100),
    subtype: z.string().max(100).optional().or(z.literal("")),
    description: z
      .string()
      .min(3, "Descrição deve ter ao menos 3 caracteres.")
      .max(2000),
    priority: z.nativeEnum(ServiceOrderPriority).default("NORMAL"),
    scheduledAt: z.string().datetime().optional().nullable(),
  })
  .strict();

const listQuerySchema = z.object({
  status: z.enum([
    "PENDING",
    "ASSIGNED",
    "IN_PROGRESS",
    "COMPLETED",
    "CANCELLED",
  ]).optional(),
  priority: z.nativeEnum(ServiceOrderPriority).optional(),
  technicianId: z.string().optional(),
  search: z.string().optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
});

export async function GET(request: Request) {
  return runApi(async () => {
    const session = await getSessionUser(request);
    if (!session) {
      return jsonError("Não autenticado.", 401);
    }
    const denied = assertProfile(session.profile, VIEW_PROFILES);
    if (denied) return denied;

    const url = new URL(request.url);
    const parsed = listQuerySchema.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) {
      return jsonError("Parâmetros inválidos.", 400);
    }

    const result = await listCompanyServiceOrders(session.companyId, {
      status: parsed.data.status,
      priority: parsed.data.priority,
      technicianId: parsed.data.technicianId,
      search: parsed.data.search,
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
    });
    return jsonOk(result);
  });
}

export async function POST(request: Request) {
  return runApi(async () => {
    const csrfBlocked = assertSameOrigin(request);
    if (csrfBlocked) {
      return csrfBlocked;
    }

    const session = await getSessionUser(request);
    if (!session) {
      return jsonError("Não autenticado.", 401);
    }
    const denied = assertProfile(session.profile, VIEW_PROFILES);
    if (denied) return denied;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonError("Corpo da requisição inválido.", 400);
    }

    const parsed = createServiceOrderSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError("Dados inválidos.", 400, parsed.error.flatten());
    }

    const order = await createManualServiceOrder(
      session.companyId,
      session.id,
      {
        customerId: parsed.data.customerId,
        type: parsed.data.type,
        subtype: parsed.data.subtype,
        description: parsed.data.description,
        priority: parsed.data.priority,
        scheduledAt: parsed.data.scheduledAt,
      },
    );
    return jsonOk({ serviceOrder: order }, 201);
  });
}
