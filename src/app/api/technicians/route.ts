import { AccessProfile } from "@prisma/client";
import { z } from "zod";
import { assertProfile, jsonError, jsonOk, runApi } from "@/lib/api";
import { assertSameOrigin } from "@/lib/csrf";
import { getSessionUser } from "@/lib/session";
import {
  createCompanyTechnician,
  listCompanyTechnicians,
} from "@/lib/technicians";

const TECHNICIAN_VIEW_PROFILES = [
  AccessProfile.ADMIN,
  AccessProfile.DISPATCHER,
];

const createTechnicianSchema = z
  .object({
    userId: z.string().min(1, "Usuário é obrigatório."),
    phone: z.string().max(30).optional().or(z.literal("")),
  })
  .strict();

const listQuerySchema = z.object({
  search: z.string().optional(),
  active: z.enum(["true", "false"]).optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
});

export async function GET(request: Request) {
  return runApi(async () => {
    const session = await getSessionUser(request);
    if (!session) {
      return jsonError("Não autenticado.", 401);
    }
    const denied = assertProfile(session.profile, TECHNICIAN_VIEW_PROFILES);
    if (denied) return denied;

    const url = new URL(request.url);
    const parsed = listQuerySchema.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) {
      return jsonError("Parâmetros inválidos.", 400);
    }

    const result = await listCompanyTechnicians(session.companyId, {
      search: parsed.data.search,
      active:
        parsed.data.active === undefined
          ? undefined
          : parsed.data.active === "true",
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
    const denied = assertProfile(session.profile, [AccessProfile.ADMIN]);
    if (denied) return denied;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonError("Corpo da requisição inválido.", 400);
    }

    const parsed = createTechnicianSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError("Dados inválidos.", 400, parsed.error.flatten());
    }

    const technician = await createCompanyTechnician(
      session.companyId,
      parsed.data.userId,
      parsed.data.phone,
      session.id,
    );
    return jsonOk({ technician }, 201);
  });
}
