import { AccessProfile } from "@prisma/client";
import { z } from "zod";
import { assertProfile, jsonError, jsonOk, runApi } from "@/lib/api";
import { assertSameOrigin } from "@/lib/csrf";
import { getSessionUser } from "@/lib/session";
import { isIntegrationError } from "@/integrations/errors";
import { searchErpCustomers } from "@/lib/erp-customer-lookup";

/**
 * Busca administrativa de cliente no ERP.
 *
 * **TECHNICIAN não entra aqui.** Um técnico tem acesso ao cliente da OS dele,
 * não à base inteira da empresa — dar-lhe busca global seria exatamente o
 * oráculo que a rota de diagnóstico foi desenhada para evitar
 * (`docs/ERP-INTEGRATIONS.md` §7).
 */
const LOOKUP_PROFILES = [AccessProfile.ADMIN, AccessProfile.DISPATCHER];

/**
 * POST, não GET.
 *
 * Os filtros são dado pessoal — nome, CPF/CNPJ e telefone. Numa query string
 * eles entrariam em log de servidor, proxy, histórico do navegador e cabeçalho
 * Referer. O corpo não vai para nenhum desses lugares.
 */
const searchSchema = z
  .object({
    name: z.string().max(120).optional(),
    document: z.string().max(20).optional(),
    phone: z.string().max(20).optional(),
  })
  .strict()
  .refine(
    (v) => Boolean(v.name?.trim() || v.document?.trim() || v.phone?.trim()),
    { message: "Informe ao menos um filtro." },
  );

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

    const parsed = searchSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError("Informe ao menos um filtro de busca.", 400);
    }

    try {
      // `companyId` vem da sessão. Não existe campo de empresa no schema.
      const result = await searchErpCustomers(session.companyId, {
        name: parsed.data.name,
        document: parsed.data.document,
        phone: parsed.data.phone,
      });
      return jsonOk(result);
    } catch (error) {
      if (isIntegrationError(error)) {
        /**
         * 200 com `ok:false` no corpo seria mentira; 5xx faria o AlfaOS
         * reportar falha PRÓPRIA pela indisponibilidade alheia. 502 diz o que
         * de fato aconteceu: o upstream não cooperou.
         *
         * `userMessage` é a única string renderizável e nunca contém URL,
         * header, token ou stack.
         */
        return jsonError(error.userMessage, 502);
      }
      throw error;
    }
  });
}
