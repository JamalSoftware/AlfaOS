import { AccessProfile } from "@prisma/client";
import { assertProfile, jsonError, jsonOk, runApi } from "@/lib/api";
import { getSessionUser } from "@/lib/session";
import {
  getCompanyServiceOrder,
  getTechnicianByUserId,
} from "@/lib/service-orders";

const STAFF_PROFILES = [AccessProfile.ADMIN, AccessProfile.DISPATCHER];

export async function GET(
  request: Request,
  context: { params: { id: string } },
) {
  return runApi(async () => {
    const session = await getSessionUser(request);
    if (!session) {
      return jsonError("Não autenticado.", 401);
    }

    const isStaff = session.profile !== AccessProfile.TECHNICIAN;
    const denied = isStaff
      ? assertProfile(session.profile, STAFF_PROFILES)
      : null;
    if (denied) return denied;

    const order = await getCompanyServiceOrder(
      session.companyId,
      context.params.id,
    );
    if (!order) {
      return jsonError("Ordem de serviço não encontrada.", 404);
    }

    if (session.profile === AccessProfile.TECHNICIAN) {
      const technician = await getTechnicianByUserId(
        session.companyId,
        session.id,
      );
      if (!technician || technician.id !== order.technician?.id) {
        return jsonError("Ordem de serviço não encontrada.", 404);
      }
    }

    return jsonOk({ serviceOrder: order });
  });
}
