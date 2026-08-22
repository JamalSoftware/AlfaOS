import { AccessProfile } from "@prisma/client";
import { z } from "zod";
import { assertProfile, jsonError, jsonOk, runApi } from "@/lib/api";
import { assertSameOrigin } from "@/lib/csrf";
import { getSessionUser } from "@/lib/session";
import {
  getCompanyTechnician,
  updateCompanyTechnician,
} from "@/lib/technicians";

const VIEW_PROFILES = [AccessProfile.ADMIN, AccessProfile.DISPATCHER];

const updateTechnicianSchema = z
  .object({
    phone: z.string().max(30).optional().or(z.literal("")),
    active: z.boolean().optional(),
  })
  .strict();

export async function GET(
  request: Request,
  context: { params: { id: string } },
) {
  return runApi(async () => {
    const session = await getSessionUser(request);
    if (!session) {
      return jsonError("Não autenticado.", 401);
    }
    const denied = assertProfile(session.profile, VIEW_PROFILES);
    if (denied) return denied;

    const technician = await getCompanyTechnician(
      session.companyId,
      context.params.id,
    );
    if (!technician) {
      return jsonError("Técnico não encontrado.", 404);
    }
    return jsonOk({ technician });
  });
}

export async function PATCH(
  request: Request,
  context: { params: { id: string } },
) {
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

    const parsed = updateTechnicianSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError("Dados inválidos.", 400, parsed.error.flatten());
    }

    const technician = await updateCompanyTechnician(
      session.companyId,
      context.params.id,
      parsed.data,
      session.id,
    );
    return jsonOk({ technician });
  });
}
