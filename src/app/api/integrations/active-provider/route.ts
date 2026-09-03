import { AccessProfile, ERPProvider } from "@prisma/client";
import { z } from "zod";
import { jsonError, jsonOk, runApi } from "@/lib/api";
import { assertSameOrigin } from "@/lib/csrf";
import {
  getActiveIntegration,
  switchActiveErpProvider,
} from "@/lib/erp-integration";
import { getSessionUser } from "@/lib/session";

/**
 * Trocar o ERP ativo da empresa. **A única rota que escreve
 * `ERPIntegration.provider`.**
 *
 * Existe separada de propósito: salvar credencial, testar conexão e trocar de
 * ERP são três ações diferentes e não compartilham efeito colateral. Até a
 * `ERP-1` a troca acontecia dentro de `test-connection`, e um clique de
 * diagnóstico mudava o sistema com que a operação inteira fala.
 *
 * `companyId` vem **sempre** da sessão. O corpo carrega apenas o provider de
 * destino, e o schema é `.strict()`: um `companyId` enviado pelo cliente é
 * **recusado**, não descartado em silêncio — quem o envia está confuso ou
 * sondando, e um 200 que o ignorasse sugeriria que foi aceito.
 */
const switchSchema = z
  .object({
    provider: z.nativeEnum(ERPProvider),
  })
  .strict();

export async function POST(request: Request) {
  return runApi(async () => {
    const csrfBlocked = assertSameOrigin(request);
    if (csrfBlocked) return csrfBlocked;

    const session = await getSessionUser(request);
    if (!session) {
      return jsonError("Não autenticado.", 401);
    }
    /**
     * Só ADMIN. Trocar o ERP ativo redireciona todo o atendimento da empresa
     * para outro sistema — não é operação de despacho nem de campo.
     */
    if (session.profile !== AccessProfile.ADMIN) {
      return jsonError("Acesso negado. Requer perfil ADMIN.", 403);
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonError("Corpo da requisição inválido.", 400);
    }

    const parsed = switchSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError("Dados inválidos.", 400);
    }

    // `DomainError` — provider igual ao atual, integração ausente, credencial
    // faltando, corrida — já vira resposta HTTP em `runApi`.
    const change = await switchActiveErpProvider({
      companyId: session.companyId,
      actorUserId: session.id,
      provider: parsed.data.provider,
    });

    const integration = await getActiveIntegration(session.companyId);

    return jsonOk({
      fromProvider: change.fromProvider,
      toProvider: change.toProvider,
      integration,
    });
  });
}
