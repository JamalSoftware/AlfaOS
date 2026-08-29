import { AccessProfile } from "@prisma/client";
import { assertProfile, jsonError, jsonOk, runApi } from "@/lib/api";
import { getSessionUser } from "@/lib/session";
import { getTeamWorkday } from "@/lib/time-clock";

/**
 * `GET /api/time-clock/team`
 *
 * Quem está trabalhando agora, na empresa da sessão (PRD §231).
 *
 * ## Por que o DISPATCHER entra aqui
 *
 * Saber quem está em jornada é insumo direto do despacho: mandar OS para quem
 * está em intervalo, de folga ou já encerrou é o erro que esta tela existe para
 * evitar. Negar a lista ao despachante o obrigaria a perguntar por WhatsApp — e
 * a decidir com informação pior.
 *
 * ## E por que ele NÃO decide ajuste
 *
 * Decidir correção de jornada é autoridade sobre o registro de outra pessoa, da
 * mesma família de administrar usuário e credencial — no AlfaOS isso é do ADMIN
 * (ver `mobile-devices`). O DISPATCHER vê o estado do dia; quem julga a
 * jornada é quem responde pela conta.
 *
 * O espelho completo de um funcionário também não vem por aqui: esta rota
 * devolve estado e minutos do dia, que é o necessário para despachar.
 * Minimização é requisito, não estilo (§233).
 */
const TEAM_VIEW_PROFILES = [AccessProfile.ADMIN, AccessProfile.DISPATCHER];

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return runApi(async () => {
    const session = await getSessionUser(request);
    if (!session) {
      return jsonError("Não autenticado.", 401);
    }
    const denied = assertProfile(session.profile, TEAM_VIEW_PROFILES);
    if (denied) return denied;

    // `companyId` da SESSÃO. Nenhum parâmetro atravessa empresa.
    const team = await getTeamWorkday(session.companyId);
    return jsonOk(team);
  });
}
