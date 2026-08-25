import { AccessProfile } from "@prisma/client";
import { z } from "zod";
import { assertProfile, jsonError, jsonOk, runApi } from "@/lib/api";
import { assertSameOrigin } from "@/lib/csrf";
import { getSessionUser } from "@/lib/session";
import { isIntegrationError } from "@/integrations/errors";
import { importErpCustomer } from "@/lib/erp-customer-lookup";

const LOOKUP_PROFILES = [AccessProfile.ADMIN, AccessProfile.DISPATCHER];

/**
 * Só o identificador do provider.
 *
 * Nada de `companyId`, nada de campos do cliente: a empresa vem da sessão e os
 * dados vêm do ERP, relidos no servidor. Aceitar nome ou documento do corpo
 * deixaria o cliente HTTP escrever no cadastro sob a aparência de importação.
 */
const importSchema = z
  .object({ externalId: z.string().min(1).max(64) })
  .strict();

export async function POST(request: Request) {
  return runApi(async () => {
    const csrfBlocked = assertSameOrigin(request);
    if (csrfBlocked) {
      return csrfBlocked;
    }

    const session = await getSessionUser(request);
    if (!session) {
      return jsonError("Não autenticado.", 401);
    }
    const denied = assertProfile(session.profile, LOOKUP_PROFILES);
    if (denied) return denied;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonError("Corpo da requisição inválido.", 400);
    }

    const parsed = importSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError("Dados inválidos.", 400);
    }

    try {
      const result = await importErpCustomer(
        session.companyId,
        session.id,
        parsed.data.externalId,
      );
      /**
       * A resposta carrega o `customerId` local e o desfecho, para que a tela
       * possa dizer se vinculou ou criou. O `detail` bruto do provider NÃO sai
       * daqui — o formulário só precisa saber qual Customer usar.
       */
      return jsonOk({
        customerId: result.customerId,
        outcome: result.outcome,
        name: result.detail.name,
        /**
         * Desfecho do enriquecimento, para a tela poder avisar.
         *
         * Só `outcome` e `code` — ambos de catálogo fechado. Nada de
         * `contractIds`, corpo ou mensagem do provedor: importar com o
         * Chatbot fora do ar é um aviso ao operador, não um dump.
         */
        enrichment: {
          outcome: result.enrichment.outcome,
          ...(result.enrichment.code ? { code: result.enrichment.code } : {}),
        },
      });
    } catch (error) {
      if (isIntegrationError(error)) {
        return jsonError(error.userMessage, 502);
      }
      throw error;
    }
  });
}
