import { AccessProfile } from "@prisma/client";
import { assertProfile, jsonError, jsonOk, runApi } from "@/lib/api";
import { assertSameOrigin } from "@/lib/csrf";
import { getSessionUser } from "@/lib/session";
import { syncReceitaNetServiceOrdersForCustomer } from "@/lib/receitanet-order-sync";
import {
  enforceCapabilityLimit,
  ERP_CAPABILITIES,
} from "@/lib/capability-rate-limit";

/**
 * Sincroniza as Ordens de Serviço abertas de UM cliente no ReceitaNet.
 *
 * Escopada por cliente porque é o que a API do provider permite: `/v1/chamados`
 * exige `idCliente`, e não existe listagem global das OS da empresa — o suporte
 * confirmou (`docs/PRD.md` §141). A rota não tenta contornar isso.
 *
 * Ação explícita, disparada por gente. Nada de cron: numa primeira versão o
 * operador precisa ver o que a sincronização fez, e um agendamento esconderia
 * justamente o comportamento que ainda está sendo homologado.
 *
 * **ADMIN e DISPATCHER.** O técnico não dispara sincronização administrativa —
 * ele trabalha a OS depois que ela existe e lhe é atribuída, pelo fluxo normal.
 */
const STAFF_PROFILES = [AccessProfile.ADMIN, AccessProfile.DISPATCHER];

export async function POST(
  request: Request,
  context: { params: { id: string } },
) {
  return runApi(async () => {
    const csrfBlocked = assertSameOrigin(request);
    if (csrfBlocked) return csrfBlocked;

    const session = await getSessionUser(request);
    if (!session) {
      return jsonError("Não autenticado.", 401);
    }

    const denied = assertProfile(session.profile, STAFF_PROFILES);
    if (denied) return denied;

    /**
     * Teto DEPOIS da autorização.
     *
     * Consumido antes, uma sondagem anônima, de outro perfil ou de outra
     * empresa gastaria a cota de quem tem direito a ela — foi o achado RATE-01
     * da auditoria v0.7, e a ordem aqui é a mesma das outras cinco rotas.
     *
     * A capability é `erp-order-sync`, a mesma da sincronização em lote: é o
     * mesmo motor, uma chamada nossa vira várias no provider, e o teto mais
     * apertado do conjunto existe justamente por isso. Uma capability nova
     * daria a cada rota um balde próprio e dobraria o que o provedor recebe.
     */
    const limited = enforceCapabilityLimit(
      session.companyId,
      session.id,
      ERP_CAPABILITIES.ORDER_SYNC,
    );
    if (limited) return limited;

    /*
      `companyId` vem da SESSÃO, nunca do corpo. O `customerId` é resolvido sob
      ele lá dentro — um id de outra empresa recebe 404, não 403: 403
      confirmaria que aquele cliente existe.
    */
    const sync = await syncReceitaNetServiceOrdersForCustomer(
      session.companyId,
      session.id,
      context.params.id,
    );

    return jsonOk({ sync });
  });
}
