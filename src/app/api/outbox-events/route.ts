import { AccessProfile } from "@prisma/client";
import { assertProfile, jsonError, jsonOk, runApi } from "@/lib/api";
import { getSessionUser } from "@/lib/session";
import { listCompanyFailedOutboxEvents } from "@/lib/mobile-devices";

/**
 * `GET /api/outbox-events`
 *
 * Eventos que esgotaram as tentativas e pararam.
 *
 * Existe porque "falha definitiva precisa ser observável **e recuperável**"
 * (PRD §157) — e até agora ela era só observável por quem abrisse o banco.
 * Sem uma forma de descobrir o id, `requeueFailedOutboxEvent` era inalcançável.
 *
 * Só `FAILED`, e só da empresa da sessão. `PENDING` e `PROCESSING` andam
 * sozinhos: agora que o lease recupera reivindicação abandonada, um evento
 * parado nesses estados é transitório por definição, e listá-los convidaria
 * alguém a intervir numa fila saudável.
 */
const ADMIN_ONLY = [AccessProfile.ADMIN];

/** Rota autenticada: nunca estática. Ver `/api/mobile-devices`. */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return runApi(async () => {
    const session = await getSessionUser(request);
    if (!session) {
      return jsonError("Não autenticado.", 401);
    }
    const denied = assertProfile(session.profile, ADMIN_ONLY);
    if (denied) return denied;

    const events = await listCompanyFailedOutboxEvents(session.companyId);
    return jsonOk({ events });
  });
}
