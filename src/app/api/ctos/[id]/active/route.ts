import { z } from "zod";
import { jsonError, jsonOk, runApi } from "@/lib/api";
import { assertSameOrigin } from "@/lib/csrf";
import { setCtoActive } from "@/lib/cto";
import { requireCtoAccess } from "@/lib/cto-access";

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
  context: { params: { id: string } },
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

    const cto = await setCtoActive(
      access.session.companyId,
      access.session.id,
      context.params.id,
      parsed.data.active,
    );
    return jsonOk({ cto });
  });
}
