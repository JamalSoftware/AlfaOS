import { getWorkdayView } from "@/lib/time-clock";
import { fieldOk, runFieldApi } from "@/lib/field/response";
import { requireFieldPrincipal } from "@/lib/field/route";

export const dynamic = "force-dynamic";

/**
 * `GET /api/field/v1/time-clock/today`
 *
 * A jornada de HOJE de quem está autenticado.
 *
 * O `userId` sai do principal resolvido pelo token, nunca da requisição: não
 * existe parâmetro capaz de ler a jornada de um colega por esta rota.
 *
 * Devolve `state` e `allowedActions` porque **o servidor decide a transição**
 * (PRD §229). O aplicativo desenha o botão a partir desta lista; um cliente que
 * derivasse a transição sozinho seria uma segunda máquina de estados, e um APK
 * antigo continuaria oferecendo uma ação que o servidor já não aceita.
 *
 * O "dia" é o dia civil no fuso da EMPRESA, não em UTC — uma batida às 23h50 em
 * São Paulo pertence a hoje, não a amanhã.
 */
export async function GET(request: Request) {
  return runFieldApi(async () => {
    const principal = await requireFieldPrincipal(request);
    const workday = await getWorkdayView(
      principal.user.companyId,
      principal.user.id,
    );
    return fieldOk({ workday });
  });
}
