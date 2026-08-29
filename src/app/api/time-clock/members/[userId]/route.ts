import { AccessProfile } from "@prisma/client";
import { assertProfile, jsonError, jsonOk, runApi } from "@/lib/api";
import { getSessionUser } from "@/lib/session";
import { getMemberWorkdayView } from "@/lib/time-clock";

/**
 * `GET /api/time-clock/members/:userId`
 *
 * Espelho de um dia de um funcionário — visão do gestor (PRD §230).
 *
 * **Só ADMIN.** Este é o recorte mais detalhado que existe: marcações uma a
 * uma, com horário e coordenada. O DISPATCHER tem `/api/time-clock/team`, que
 * responde "quem está trabalhando" sem entregar a jornada minuto a minuto — e
 * é o que o despacho precisa. Minimização é requisito (§233).
 *
 * O `companyId` sai da SESSÃO: um `userId` de outra empresa devolve 404, não
 * 403 — confirmar que o id existe noutra empresa é exatamente o que uma sonda
 * não pode aprender.
 */
const ADMIN_ONLY = [AccessProfile.ADMIN];

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: { userId: string } },
) {
  return runApi(async () => {
    const session = await getSessionUser(request);
    if (!session) {
      return jsonError("Não autenticado.", 401);
    }
    const denied = assertProfile(session.profile, ADMIN_ONLY);
    if (denied) return denied;

    const url = new URL(request.url);
    const raw = url.searchParams.get("date");
    let instant = new Date();
    if (raw) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        return jsonError("Data inválida. Use AAAA-MM-DD.", 400);
      }
      // Meio-dia UTC: escolhido para que o dia civil da empresa resolva para a
      // data pedida em qualquer fuso brasileiro, sem cair na véspera.
      instant = new Date(`${raw}T12:00:00.000Z`);
      if (Number.isNaN(instant.getTime())) {
        return jsonError("Data inválida.", 400);
      }
    }

    const workday = await getMemberWorkdayView(
      session.companyId,
      context.params.userId,
      instant,
    );
    return jsonOk({ workday });
  });
}
