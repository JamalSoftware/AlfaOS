import { AccessProfile } from "@prisma/client";
import { assertProfile, jsonError, jsonOk, runApi } from "@/lib/api";
import { assertSameOrigin } from "@/lib/csrf";
import { getSessionUser } from "@/lib/session";
import { revokeDevice } from "@/lib/field/devices";

/**
 * `POST /api/mobile-devices/:id/revoke`
 *
 * O caminho do celular perdido, agora alcançável pela aplicação.
 *
 * Modelado como AÇÃO explícita, e não como `PATCH { status }`: revogar é um
 * evento — auditado, irreversível pelo próprio técnico, e com um efeito
 * colateral (o `pushToken` some junto, senão o aparelho perdido continuaria
 * recebendo prévia de OS na tela bloqueada). Um endpoint genérico de status
 * teria de decidir quem pode escrever o quê em cada valor do enum.
 *
 * `POST` também porque é mutante e portanto passa pela proteção Same-Origin da
 * web — esta rota é da superfície administrativa, com cookie, não da Field API.
 *
 * Revogar duas vezes é seguro: `revokeDevice` filtra por `revokedAt: null`, e a
 * segunda chamada não casa nenhuma linha. Responde 404, que é o mesmo desfecho
 * de um id inexistente ou de outra empresa — e é assim de propósito: um ADMIN
 * não descobre por este endpoint quais aparelhos existem fora da sua empresa.
 */
const ADMIN_ONLY = [AccessProfile.ADMIN];

export async function POST(
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
    const denied = assertProfile(session.profile, ADMIN_ONLY);
    if (denied) return denied;

    // `companyId` da SESSÃO. O id do aparelho é o único valor aceito do
    // cliente, e ele é filtrado pela empresa dentro do serviço.
    const revoked = await revokeDevice(
      session.companyId,
      session.id,
      context.params.id,
    );

    if (!revoked) {
      return jsonError("Dispositivo não encontrado.", 404);
    }
    return jsonOk({ revoked: true });
  });
}
