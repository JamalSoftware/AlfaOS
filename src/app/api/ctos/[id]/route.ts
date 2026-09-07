import { z } from "zod";
import { jsonError, jsonOk, runApi } from "@/lib/api";
import { assertSameOrigin } from "@/lib/csrf";
import {
  CTO_ADDRESS_REFERENCE_MAX_LENGTH,
  CTO_CODE_MAX_LENGTH,
  CTO_NAME_MAX_LENGTH,
  CTO_NOTES_MAX_LENGTH,
  getCto,
  updateCto,
} from "@/lib/cto";
import { requireCtoAccess } from "@/lib/cto-access";

/**
 * Só o que é DESCRITIVO da caixa.
 *
 * Capacidade, ativação e estado de porta não entram aqui: são ações, e o
 * projeto não tem endpoint genérico de mudança de estado — cada operação é
 * explícita, com auditoria própria. Um `PATCH` que aceitasse `{ capacity }` ao
 * lado de `{ notes }` transformaria "corrigir uma observação" e "criar oito
 * portas" na mesma requisição.
 *
 * `code` está no schema **para ser recusado** quando difere do gravado. Se ele
 * simplesmente não existisse aqui, um formulário que reenvia o objeto inteiro
 * teria o código descartado em silêncio — e quem mandou acreditaria que gravou.
 */
const updateCtoSchema = z
  .object({
    name: z.string().min(1).max(CTO_NAME_MAX_LENGTH).optional(),
    code: z.string().max(CTO_CODE_MAX_LENGTH).nullish(),
    latitude: z.number().finite().nullish(),
    longitude: z.number().finite().nullish(),
    addressReference: z
      .string()
      .max(CTO_ADDRESS_REFERENCE_MAX_LENGTH)
      .nullish(),
    notes: z.string().max(CTO_NOTES_MAX_LENGTH).nullish(),
  })
  .strict();

export async function GET(
  request: Request,
  context: { params: { id: string } },
) {
  return runApi(async () => {
    const access = await requireCtoAccess(request);
    if (!access.ok) return access.response;

    const cto = await getCto(access.session.companyId, context.params.id);
    if (!cto) {
      // 404 e não 403: id de outra empresa não pode ser distinguido de id
      // inexistente, senão a resposta de erro vira um oráculo de existência.
      return jsonError("CTO não encontrada.", 404);
    }
    return jsonOk({ cto });
  });
}

export async function PATCH(
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

    const parsed = updateCtoSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError("Dados inválidos.", 400, parsed.error.flatten());
    }

    // `undefined` e `null` significam coisas diferentes aqui: ausente é "não
    // mexa", nulo é "limpe". Repassar a chave só quando ela veio no corpo é o
    // que preserva essa distinção — `parsed.data` já a perde para quem
    // desestrutura sem cuidado.
    const raw = body as Record<string, unknown>;
    const cto = await updateCto(
      access.session.companyId,
      access.session.id,
      context.params.id,
      {
        ...("name" in raw ? { name: parsed.data.name } : {}),
        ...("code" in raw ? { code: parsed.data.code ?? null } : {}),
        ...("latitude" in raw || "longitude" in raw
          ? {
              latitude: parsed.data.latitude ?? null,
              longitude: parsed.data.longitude ?? null,
            }
          : {}),
        ...("addressReference" in raw
          ? { addressReference: parsed.data.addressReference ?? null }
          : {}),
        ...("notes" in raw ? { notes: parsed.data.notes ?? null } : {}),
      },
    );
    return jsonOk({ cto });
  });
}
