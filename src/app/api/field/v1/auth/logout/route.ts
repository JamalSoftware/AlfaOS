import { logoutField } from "@/lib/field/devices";
import { fieldOk, noStore, runFieldApi } from "@/lib/field/response";
import { requireFieldPrincipal } from "@/lib/field/route";

/**
 * `POST /api/field/v1/auth/logout`
 *
 * Invalida o token DESTE aparelho e preserva a linha do dispositivo — sair do
 * aplicativo não é perder o celular, e o histórico de qual instalação operou
 * qual OS continua existindo (§10).
 *
 * Sem corpo: qual aparelho encerrar é decidido pelo token apresentado, nunca
 * por um id no payload. Aceitar `deviceId` daria a qualquer técnico
 * autenticado uma forma de deslogar o aparelho de um colega.
 */
export async function POST(request: Request) {
  return runFieldApi(async () => {
    const principal = await requireFieldPrincipal(request);
    await logoutField(principal);
    return noStore(fieldOk({ loggedOut: true }));
  });
}
