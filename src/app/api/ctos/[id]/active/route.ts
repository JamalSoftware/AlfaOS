import { z } from "zod";
import { jsonError, jsonOk, runApi } from "@/lib/api";
import { assertSameOrigin } from "@/lib/csrf";
import { setCtoActive } from "@/lib/cto";
import { requireCtoAccess } from "@/lib/cto-access";
import { getOperationalCtoDetail } from "@/lib/cto-read-model";

/**
 * `POST /api/ctos/:id/active`
 *
 * Inativar e reativar. **Não existe DELETE**, e a ausência é a regra `N-13`
 * expressa em superfície: uma CTO com histórico nunca é apagada, e o schema
 * reforça isso com `Restrict` em `CTO → CTOPort`.
 *
 * Inativar não some com nada — nem com a caixa, nem com as portas. Ela deixa de
 * receber vínculo novo, o que a `CTO-2` vai aplicar.
 */
const activeSchema = z.object({ active: z.boolean() }).strict();

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return runApi(async () => {
    const csrfBlocked = assertSameOrigin(request);
    if (csrfBlocked) return csrfBlocked;

    const access = await requireCtoAccess(request);
    if (!access.ok) return access.response;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonError("Corpo da requisição inválido.", 400);
    }

    const parsed = activeSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError("Dados inválidos.", 400, parsed.error.flatten());
    }

    await setCtoActive(
      access.session.companyId,
      access.session.id,
      (await context.params).id,
      parsed.data.active,
    );
    /*
      A resposta de toda mutação passa pelo MESMO read model da leitura.

      As funções de domínio da `CTO-1` devolvem o detalhe administrativo, sem
      ocupação — e a tela substitui o estado inteiro pela resposta. Devolver a
      forma menor faria `occupied` e `activeConnection` sumirem depois de
      salvar, e o defeito só apareceria quando a `CTO-2.3` os exibisse: um
      selo que desaparece ao clicar em salvar.
    */
    const detail = await getOperationalCtoDetail(
      access.session.companyId,
      (await context.params).id,
    );
    return jsonOk({ cto: detail });
  });
}
