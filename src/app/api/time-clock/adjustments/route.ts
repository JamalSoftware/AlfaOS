import { AccessProfile, TimeAdjustmentStatus } from "@prisma/client";
import { assertProfile, jsonError, jsonOk, runApi } from "@/lib/api";
import { getSessionUser } from "@/lib/session";
import { listCompanyAdjustments } from "@/lib/time-clock";

/**
 * `GET /api/time-clock/adjustments?status=`
 *
 * Fila de correções de jornada da empresa (PRD §231).
 *
 * **Só ADMIN.** Decidir correção é autoridade sobre o registro de jornada de
 * outra pessoa — mesma família de administrar usuário e credencial de ERP. O
 * DISPATCHER vê quem está trabalhando (`/api/time-clock/team`), que é o que o
 * despacho precisa; julgar a jornada não é despacho.
 *
 * Sem `status` devolve a fila PENDENTE, que é o que o gestor abre a tela para
 * ver. O histórico decidido continua consultável — pedido rejeitado nunca é
 * apagado (§229).
 */
const ADMIN_ONLY = [AccessProfile.ADMIN];

export const dynamic = "force-dynamic";

function parseStatus(raw: string | null): TimeAdjustmentStatus | null {
  if (!raw || raw === "PENDING") return TimeAdjustmentStatus.PENDING;
  if (raw === "ALL") return null;
  if (
    raw === TimeAdjustmentStatus.APPROVED ||
    raw === TimeAdjustmentStatus.REJECTED
  ) {
    return raw;
  }
  return TimeAdjustmentStatus.PENDING;
}

export async function GET(request: Request) {
  return runApi(async () => {
    const session = await getSessionUser(request);
    if (!session) {
      return jsonError("Não autenticado.", 401);
    }
    const denied = assertProfile(session.profile, ADMIN_ONLY);
    if (denied) return denied;

    const status = parseStatus(new URL(request.url).searchParams.get("status"));
    const adjustments = await listCompanyAdjustments(session.companyId, status);

    return jsonOk({
      adjustments: adjustments.map((a) => ({
        id: a.id,
        status: a.status,
        // De QUEM e a jornada. Distinto de `requestedByName` desde que o gestor
        // tambem abre correcao: sem isto a fila mostraria o nome de quem
        // digitou o pedido no lugar do funcionario julgado.
        userName: a.userName,
        requestedType: a.requestedType,
        requestedEntryType: a.requestedEntryType,
        requestedOccurredAt: a.requestedOccurredAt.toISOString(),
        reason: a.reason,
        notes: a.notes,
        workdayDate: a.workdayDate,
        requestedByName: a.requestedByName,
        decidedByName: a.decidedByName,
        decidedAt: a.decidedAt?.toISOString() ?? null,
        decisionReason: a.decisionReason,
        createdAt: a.createdAt.toISOString(),
      })),
    });
  });
}
