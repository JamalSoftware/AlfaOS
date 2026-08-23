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
  })
  .strict();

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

    const connection = await updateCustomerConnection(
      session.companyId,
      context.params.connectionId,
      session.id,
      {
        username: parsed.data.username,
        password: parsed.data.password,
        active: parsed.data.active,
      },
    );
    return jsonOk({ connection });
  });
}
