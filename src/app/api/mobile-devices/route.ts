import { AccessProfile } from "@prisma/client";
import { assertProfile, jsonError, jsonOk, runApi } from "@/lib/api";
import { getSessionUser } from "@/lib/session";
import { listCompanyMobileDevices } from "@/lib/mobile-devices";

/**
 * `GET /api/mobile-devices`
 *
 * Aparelhos do Field registrados na empresa da sessão.
 *
 * **Só ADMIN.** A lista diz quais celulares têm acesso operacional à carteira
 * de OS da empresa, e revogar é a ação que a acompanha — é decisão de quem
 * responde pela conta, não de quem despacha o dia. O DISPATCHER não é
 * rebaixado por desconfiança: revogar aparelho é administração de acesso, e no
 * AlfaOS isso já é do ADMIN (usuários, credenciais de ERP).
 *
 * O TECHNICIAN não entra: ele não tem por que ver os aparelhos dos colegas, e
 * dar-lhe esta lista seria justamente o tipo de dado de "outros técnicos" que
 * os DTOs do Field excluem.
 */
const ADMIN_ONLY = [AccessProfile.ADMIN];

/**
 * Rota autenticada: nunca estática.
 *
 * O Next já a marcaria como dinâmica ao ver a leitura de `headers`, mas por
 * exceção — que o envelope de erro captura e registra como falha no build.
 * Declarar a intenção evita o ruído e não deixa o comportamento de uma rota
 * que lista aparelhos de uma empresa depender de inferência.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return runApi(async () => {
    const session = await getSessionUser(request);
    if (!session) {
      return jsonError("Não autenticado.", 401);
    }
    const denied = assertProfile(session.profile, ADMIN_ONLY);
    if (denied) return denied;

    const devices = await listCompanyMobileDevices(session.companyId);
    return jsonOk({ devices });
  });
}
