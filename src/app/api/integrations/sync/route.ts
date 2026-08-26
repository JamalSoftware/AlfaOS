import { AccessProfile } from "@prisma/client";
import { assertProfile, jsonError, jsonOk, runApi } from "@/lib/api";
import { assertSameOrigin } from "@/lib/csrf";
import { getSessionUser } from "@/lib/session";
import { syncServiceOrdersFromERP } from "@/lib/erp-sync";
import {
  enforceCapabilityLimit,
  ERP_CAPABILITIES,
} from "@/lib/capability-rate-limit";

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

    /**
     * Sincronizar é a operação em lote: uma chamada nossa vira várias lá.
     * O teto é o mais apertado do conjunto justamente por isso. Depois da
     * autorização.
     */
    const limited = enforceCapabilityLimit(
      session.companyId,
      session.id,
      ERP_CAPABILITIES.ORDER_SYNC,
    );
    if (limited) return limited;

    const sync = await syncServiceOrdersFromERP(session.companyId, session.id);
    return jsonOk({ sync });
  });
}
