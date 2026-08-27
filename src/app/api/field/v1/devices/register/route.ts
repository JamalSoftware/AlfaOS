import { z } from "zod";
import { registerDevice } from "@/lib/field/devices";
import { fieldOk, noStore, runFieldApi } from "@/lib/field/response";
import { readFieldBody, requireFieldPrincipal } from "@/lib/field/route";

/**
 * `POST /api/field/v1/devices/register`
 *
 * Atualiza os metadados do aparelho já autenticado — na prática, é por onde o
 * token de push chega e **rotaciona**. O registro no provider acontece depois
 * do login (quando o usuário concede a permissão de notificação) e muda
 * sozinho ao longo da vida da instalação, então precisa de rota própria em vez
 * de ficar preso ao login.
 *
 * ## O que o app NÃO decide
 *
 * `companyId`, `userId`, `technicianId` e `installationId` não existem no
 * schema — o corpo é `.strict()`, então enviá-los é **400**, não um campo
 * ignorado em silêncio. Todos os quatro vêm do token: quem é o aparelho já foi
 * decidido no login, e aceitar qualquer um deles aqui abriria registro de
 * dispositivo no tenant de outra pessoa.
 *
 * `platform` também fica de fora: uma instalação não troca de sistema
 * operacional. Permitir a troca só daria a um app modificado uma forma de
 * mentir sobre o que é.
 */

const registerSchema = z
  .object({
    appVersion: z.string().max(40).nullish(),
    deviceName: z.string().max(120).nullish(),
    /**
     * Token do provider de push. `null` explícito **apaga** — é como o app
     * avisa que a permissão foi revogada no aparelho e que não adianta mais
     * tentar entregar ali.
     */
    pushToken: z.string().max(512).nullish(),
  })
  .strict();

export async function POST(request: Request) {
  return runFieldApi(async () => {
    const principal = await requireFieldPrincipal(request);
    const body = await readFieldBody(request, registerSchema);

    const result = await registerDevice(principal, {
      appVersion: body.appVersion === undefined ? undefined : body.appVersion,
      deviceName: body.deviceName === undefined ? undefined : body.deviceName,
      pushToken: body.pushToken === undefined ? undefined : body.pushToken,
    });

    // `no-store`: o corpo é trivial, mas a requisição carregou um token de
    // push. Nada nesta troca precisa sobreviver em cache.
    return noStore(fieldOk({ device: { id: result.deviceId } }));
  });
}
