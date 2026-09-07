import { z } from "zod";
import { jsonError, jsonOk, runApi } from "@/lib/api";
import { assertSameOrigin } from "@/lib/csrf";
import {
  CTO_CAPACITY_MAX,
  CTO_CAPACITY_MIN,
  changeCtoCapacity,
} from "@/lib/cto";
import { requireCtoAccess } from "@/lib/cto-access";
import { getOperationalCtoDetail } from "@/lib/cto-read-model";

/**
 * `POST /api/ctos/:id/capacity`
 *
 * Ação explícita, e não um campo dentro do `PATCH` da CTO. Alterar capacidade
 * cria ou aposenta posições: é a operação com mais consequência da fase, e
 * misturá-la à edição de observações a esconderia dentro de um formulário
 * genérico. Mesma disciplina que `POST /api/service-orders/:id/priority` já
 * segue.
 *
 * Aumentar e reduzir usam a MESMA rota porque são a mesma decisão — "quantas
 * posições esta caixa oferece?" —, e o serviço decide o que fazer comparando
 * com o valor travado dentro da transação, nunca com um valor lido antes.
 */
const capacitySchema = z
  .object({ capacity: z.number().int().min(CTO_CAPACITY_MIN).max(CTO_CAPACITY_MAX) })
  .strict();

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

    const parsed = capacitySchema.safeParse(body);
    if (!parsed.success) {
      return jsonError("Dados inválidos.", 400, parsed.error.flatten());
    }

    await changeCtoCapacity(
      access.session.companyId,
      access.session.id,
      context.params.id,
      parsed.data.capacity,
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
      context.params.id,
    );
    return jsonOk({ cto: detail });
  });
}
