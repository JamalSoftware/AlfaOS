import { CtoPortAdministrativeState } from "@prisma/client";
import { z } from "zod";
import { jsonError, jsonOk, runApi } from "@/lib/api";
import { assertSameOrigin } from "@/lib/csrf";
import { setPortAdministrativeState } from "@/lib/cto";
import { requireCtoAccess } from "@/lib/cto-access";

/**
 * `POST /api/ctos/:id/ports/:portId/state`
 *
 * Marca a posição como disponível, reservada ou danificada.
 *
 * **`OCCUPIED` não é aceitável, e não por omissão do schema:** ele não existe no
 * enum do Prisma. A ocupação é derivada da existência de vínculo ativo e nunca
 * gravada — este endpoint não tem como criar um estado que o banco não sabe
 * representar. Um `zod` que apenas o omitisse deixaria a proibição dependendo
 * de alguém lembrar dela.
 *
 * O `ctoId` do caminho **participa do predicado**. Sem ele, o id de uma porta de
 * outra caixa da mesma empresa seria aceito — não é cross-tenant, mas é escrever
 * num recurso diferente do que a URL diz.
 */
const stateSchema = z
  .object({
    administrativeState: z.nativeEnum(CtoPortAdministrativeState),
  })
  .strict();

export async function POST(
  request: Request,
  context: { params: { id: string; portId: string } },
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

    const parsed = stateSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError("Dados inválidos.", 400, parsed.error.flatten());
    }

    const cto = await setPortAdministrativeState(
      access.session.companyId,
      access.session.id,
      context.params.id,
      context.params.portId,
      parsed.data.administrativeState,
    );
    return jsonOk({ cto });
  });
}
