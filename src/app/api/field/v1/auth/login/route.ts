import { MobilePlatform } from "@prisma/client";
import { z } from "zod";
import { loginField } from "@/lib/field/devices";
import { fieldOk, noStore, runFieldApi } from "@/lib/field/response";
import { readFieldBody } from "@/lib/field/route";

/**
 * `POST /api/field/v1/auth/login`
 *
 * A única rota do Field que não exige token — é onde ele nasce.
 *
 * **Sem `assertSameOrigin`, e isso é correto.** Same-Origin defende cookie, que
 * o navegador envia sozinho; um aplicativo nativo não tem origem e nunca terá
 * um `Origin` legítimo para apresentar. A proteção que substitui essa aqui é
 * outra: o token de resposta **não** vira cookie, então nenhum navegador vai
 * anexá-lo automaticamente a uma requisição forjada. Não existe CSRF contra
 * uma API que só lê `Authorization`.
 *
 * A defesa contra força bruta é a MESMA da web (`isLoginBlocked`,
 * `recordLoginAttempt`, custo constante de bcrypt), reusada dentro de
 * `loginField`.
 */

const loginSchema = z
  .object({
    email: z.string().email("E-mail inválido.").max(255),
    password: z.string().min(1, "Senha é obrigatória.").max(128),
    device: z
      .object({
        platform: z.nativeEnum(MobilePlatform),
        /**
         * Identificador de INSTALAÇÃO, gerado pelo app.
         *
         * Nunca IMEI, nunca Android ID, nunca número de telefone (PRD §155).
         * O formato é validado só para caber numa coluna e não carregar
         * caractere de controle — ele não autentica nada.
         */
        installationId: z
          .string()
          .min(8, "installationId inválido.")
          .max(200)
          .regex(/^[A-Za-z0-9._:-]+$/, "installationId inválido."),
        deviceName: z.string().max(120).nullish(),
        appVersion: z.string().max(40).nullish(),
        pushToken: z.string().max(512).nullish(),
      })
      .strict(),
  })
  .strict();

export async function POST(request: Request) {
  return runFieldApi(async () => {
    const body = await readFieldBody(request, loginSchema);

    const result = await loginField(
      request,
      { email: body.email, password: body.password },
      {
        platform: body.device.platform,
        installationId: body.device.installationId,
        deviceName: body.device.deviceName ?? null,
        appVersion: body.device.appVersion ?? null,
        pushToken: body.device.pushToken ?? null,
      },
    );

    /*
      O token viaja no CORPO, uma única vez, e nunca vira cookie.

      No corpo o aplicativo decide onde guardá-lo — e a decisão certa é o
      armazenamento seguro da plataforma, Keystore no Android (§8.9). Num
      cookie ele ficaria no armazenamento do cliente HTTP, fora desse cofre, e
      ainda reintroduziria a superfície de CSRF que este desenho elimina.

      `no-store` porque a resposta carrega segredo: nenhuma camada pode
      reexibi-la por navegação, retomada ou cache do próprio app.
    */
    return noStore(
      fieldOk({
        token: result.token,
        expiresAt: result.expiresAt.toISOString(),
        device: { id: result.deviceId },
        user: result.user,
        technician: result.technician,
        company: result.company,
      }),
    );
  });
}
