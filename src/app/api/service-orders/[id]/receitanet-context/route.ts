import { AccessProfile } from "@prisma/client";
import { assertProfile, jsonError, jsonOk, runApi } from "@/lib/api";
import { getSessionUser } from "@/lib/session";
import { getCompanyServiceOrder } from "@/lib/service-orders";
import { loadErpOperationalContext } from "@/lib/erp-operational-context";

/**
 * Contexto operacional do cliente no ERP, escopado por ORDEM DE SERVIÇO.
 *
 * A OS é a superfície de autorização pelo mesmo motivo do diagnóstico: uma rota
 * `/customers/:id/...` daria a qualquer usuário autenticado um oráculo sobre a
 * base inteira — sondar ids e observar 200 contra 404 enumera a carteira. Vindo
 * pela OS, a resposta só existe para um cliente que o chamador já podia ver.
 *
 * **TECHNICIAN não entra aqui.** O bloco carrega valor em aberto, faturas e
 * promessa de pagamento; o técnico em campo não precisa disso para executar o
 * atendimento, e levar dado financeiro para o celular dele amplia a superfície
 * sem ganho operacional. Ele continua com o que lhe serve: acesso PPPoE,
 * endereço, telefone e a descrição da OS.
 *
 * Somente leitura. Nada aqui abre, altera ou fecha chamado no ReceitaNet.
 */

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

    const denied = assertProfile(session.profile, STAFF_PROFILES);
    if (denied) return denied;

    const order = await getCompanyServiceOrder(session.companyId, context.params.id);
    if (!order) {
      return jsonError("Ordem de serviço não encontrada.", 404);
    }

    /**
     * O `customerId` vem da OS, resolvida sob a empresa da sessão — nunca do
     * request. É o que impede pedir o contexto de um cliente arbitrário
     * anexando um id ao corpo.
     */
    const result = await loadErpOperationalContext(
      session.companyId,
      order.customer.id,
    );

    /**
     * 200 mesmo quando o provider falha: a REQUISIÇÃO funcionou. O corpo
     * carrega o motivo, e a tela mostra "não foi possível consultar" em vez de
     * um erro genérico que o operador leria como problema do AlfaOS.
     */
    return jsonOk({ context: result });
  });
}
