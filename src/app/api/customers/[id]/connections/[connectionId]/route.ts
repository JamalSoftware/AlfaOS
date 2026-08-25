import { AccessProfile } from "@prisma/client";
import { z } from "zod";
import { assertProfile, jsonError, jsonOk, runApi } from "@/lib/api";
import { assertSameOrigin } from "@/lib/csrf";
import { getSessionUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import {
  CONNECTION_PASSWORD_MAX_LENGTH,
  CONNECTION_PASSWORD_MIN_LENGTH,
  CONNECTION_USERNAME_MAX_LENGTH,
  updateCustomerConnection,
} from "@/lib/customer-connections";
import { restoreDefaultPassword } from "@/lib/pppoe-provisioning";

const MANAGE_PROFILES = [AccessProfile.ADMIN];

/**
 * `password` presente SUBSTITUI a senha. Não existe caminho de leitura: nenhuma
 * rota devolve a senha para preencher formulário, por desenho.
 */
const updateConnectionSchema = z
  .object({
    username: z.string().min(1).max(CONNECTION_USERNAME_MAX_LENGTH).optional(),
    password: z
      .string()
      .min(CONNECTION_PASSWORD_MIN_LENGTH)
      .max(CONNECTION_PASSWORD_MAX_LENGTH)
      .optional(),
    active: z.boolean().optional(),
    /**
     * Restaura a senha padrão da empresa. `literal(true)` e não `boolean`:
     * `false` não significa nada aqui, e aceitá-lo criaria um segundo jeito
     * de dizer “não faça nada”.
     *
     * `usernameSource` e `passwordSource` NÃO entram neste schema de
     * propósito. Quem decide a procedência é o servidor que aplicou a
     * regra — aceitá-la do cliente deixaria marcar uma senha digitada como
     * automática e, com isso, autorizá-la a ser sobrescrita depois.
     */
    restoreDefaultPassword: z.literal(true).optional(),
  })
  .strict()
  .refine(
    (v) => !(v.restoreDefaultPassword && v.password !== undefined),
    // As duas juntas são uma contradição: uma define a senha, a outra a
    // recalcula. Aplicar as duas na ordem errada gravaria a que o operador
    // não quis.
    { message: "Não é possível definir e restaurar a senha na mesma requisição." },
  );

export async function PATCH(
  request: Request,
  context: { params: { id: string; connectionId: string } },
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
    const denied = assertProfile(session.profile, MANAGE_PROFILES);
    if (denied) return denied;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonError("Corpo da requisição inválido.", 400);
    }

    const parsed = updateConnectionSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError("Dados inválidos.", 400, {
        fields: Object.keys(parsed.error.flatten().fieldErrors),
      });
    }

    /**
     * A conexão precisa pertencer ao cliente da rota E à empresa da sessão.
     * Sem esta checagem, um ADMIN poderia alterar a conexão de qualquer cliente
     * da própria empresa passando o id do cliente errado na URL — e o
     * `connectionId` sozinho não diria nada sobre isso.
     *
     * Divergência resulta em 404, não 403: 403 confirmaria que o id existe.
     */
    const owned = await prisma.customerConnection.findFirst({
      where: {
        id: context.params.connectionId,
        companyId: session.companyId,
        customerId: context.params.id,
      },
      select: { id: true },
    });
    if (!owned) {
      return jsonError("Conexão não encontrada.", 404);
    }

    if (parsed.data.restoreDefaultPassword) {
      const restored = await restoreDefaultPassword(
        session.companyId,
        context.params.connectionId,
        session.id,
      );
      if (!restored.applied) {
        /**
         * Motivo em código, não em texto livre: a tela traduz. E `NOT_FOUND`
         * vira 404 pelo mesmo motivo da checagem de posse acima — não
         * confirmar a existência de um id que a empresa não enxerga.
         */
        if (restored.reason === "NOT_FOUND") {
          return jsonError("Conexão não encontrada.", 404);
        }
        return jsonError(
          restored.reason === "NO_POLICY"
            ? "A empresa não tem política de senha padrão configurada."
            : "O cliente não tem CPF válido para derivar a senha padrão.",
          400,
        );
      }
    }

    const connection = await updateCustomerConnection(
      session.companyId,
      context.params.connectionId,
      session.id,
      {
        username: parsed.data.username,
        password: parsed.data.password,
        /**
         * Senha digitada é sempre MANUAL — é exatamente a marca que impede
         * a política da empresa de sobrescrevê-la numa importação futura.
         */
        ...(parsed.data.password !== undefined ? { passwordSource: "MANUAL" as const } : {}),
        /** Usuário digitado idem: deixa de acompanhar o provider. */
        ...(parsed.data.username !== undefined ? { usernameSource: "MANUAL" as const } : {}),
        active: parsed.data.active,
      },
    );
    return jsonOk({ connection });
  });
}
