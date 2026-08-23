import { AccessProfile } from "@prisma/client";
import { z } from "zod";
import { assertProfile, jsonError, jsonOk, runApi } from "@/lib/api";
import { assertSameOrigin } from "@/lib/csrf";
import { getSessionUser } from "@/lib/session";
import { getCompanyCustomer } from "@/lib/customers";
import {
  CONNECTION_PASSWORD_MAX_LENGTH,
  CONNECTION_PASSWORD_MIN_LENGTH,
  CONNECTION_USERNAME_MAX_LENGTH,
  createCustomerConnection,
  listCustomerConnections,
} from "@/lib/customer-connections";

const VIEW_PROFILES = [AccessProfile.ADMIN, AccessProfile.DISPATCHER];
/** Somente ADMIN grava credencial de acesso do cliente. */
const MANAGE_PROFILES = [AccessProfile.ADMIN];

/**
 * Whitelist explícita e `.strict()`.
 *
 * Não existe campo `companyId`, `customerId` nem `type`: a empresa vem da
 * sessão, o cliente vem da rota e o tipo é PPPOE nesta versão. Enviar qualquer
 * um deles resulta em 400, não em silêncio.
 */
const createConnectionSchema = z
  .object({
    username: z
      .string()
      .min(1, "Usuário é obrigatório.")
      .max(CONNECTION_USERNAME_MAX_LENGTH),
    password: z
      .string()
      .min(CONNECTION_PASSWORD_MIN_LENGTH)
      .max(CONNECTION_PASSWORD_MAX_LENGTH)
      .optional(),
  })
  .strict();

export async function GET(
  request: Request,
  context: { params: { id: string } },
) {
  return runApi(async () => {
    const session = await getSessionUser(request);
    if (!session) {
      return jsonError("Não autenticado.", 401);
    }
    const denied = assertProfile(session.profile, VIEW_PROFILES);
    if (denied) return denied;

    const customer = await getCompanyCustomer(
      session.companyId,
      context.params.id,
    );
    if (!customer) {
      return jsonError("Cliente não encontrado.", 404);
    }

    // Shape público: username e um booleano. Nunca a senha.
    const connections = await listCustomerConnections(
      session.companyId,
      context.params.id,
    );
    return jsonOk({ connections });
  });
}

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
    const denied = assertProfile(session.profile, MANAGE_PROFILES);
    if (denied) return denied;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonError("Corpo da requisição inválido.", 400);
    }

    const parsed = createConnectionSchema.safeParse(body);
    if (!parsed.success) {
      // `parsed.error.flatten()` carrega apenas nomes de campos e mensagens de
      // validação — nunca os valores enviados, que incluiriam a senha.
      return jsonError("Dados inválidos.", 400, {
        fields: Object.keys(parsed.error.flatten().fieldErrors),
      });
    }

    const connection = await createCustomerConnection(
      session.companyId,
      session.id,
      {
        customerId: context.params.id,
        username: parsed.data.username,
        password: parsed.data.password ?? null,
      },
    );
    return jsonOk({ connection }, 201);
  });
}
