import { z } from "zod";
import { jsonError, jsonOk, runApi } from "@/lib/api";
import { assertSameOrigin } from "@/lib/csrf";
import {
  CTO_ADDRESS_REFERENCE_MAX_LENGTH,
  CTO_CODE_MAX_LENGTH,
  CTO_CAPACITY_MAX,
  CTO_CAPACITY_MIN,
  CTO_NAME_MAX_LENGTH,
  CTO_NOTES_MAX_LENGTH,
  createCto,
  listCompanyCtos,
} from "@/lib/cto";
import { requireCtoAccess } from "@/lib/cto-access";

/**
 * Nenhum campo de tenant, e o schema é `.strict()`.
 *
 * As duas coisas juntas: sem o campo não há o que ler, e com `strict` um
 * `companyId` enviado assim mesmo é REJEITADO em vez de descartado em silêncio.
 * A diferença importa — descartar deixa quem tentou achando que funcionou, e
 * some com o sinal de que alguém está tentando.
 *
 * `id`, `createdAt`, `updatedAt`, `active` e `photoStorageKey` também não estão
 * aqui, pelo mesmo motivo.
 */
const createCtoSchema = z
  .object({
    name: z.string().min(1, "Nome é obrigatório.").max(CTO_NAME_MAX_LENGTH),
    code: z.string().max(CTO_CODE_MAX_LENGTH).nullish(),
    capacity: z.number().int().min(CTO_CAPACITY_MIN).max(CTO_CAPACITY_MAX),
    latitude: z.number().min(-90).max(90).nullish(),
    longitude: z.number().min(-180).max(180).nullish(),
    addressReference: z
      .string()
      .max(CTO_ADDRESS_REFERENCE_MAX_LENGTH)
      .nullish(),
    notes: z.string().max(CTO_NOTES_MAX_LENGTH).nullish(),
  })
  .strict();

export async function GET(request: Request) {
  return runApi(async () => {
    const access = await requireCtoAccess(request);
    if (!access.ok) return access.response;

    const url = new URL(request.url);
    const includeInactive = url.searchParams.get("includeInactive") === "true";

    const ctos = await listCompanyCtos(access.session.companyId, {
      includeInactive,
    });
    return jsonOk({ ctos });
  });
}

export async function POST(request: Request) {
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

    const parsed = createCtoSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError("Dados inválidos.", 400, parsed.error.flatten());
    }

    const cto = await createCto(access.session.companyId, access.session.id, {
      name: parsed.data.name,
      code: parsed.data.code ?? null,
      capacity: parsed.data.capacity,
      latitude: parsed.data.latitude ?? null,
      longitude: parsed.data.longitude ?? null,
      addressReference: parsed.data.addressReference ?? null,
      notes: parsed.data.notes ?? null,
    });
    return jsonOk({ cto }, 201);
  });
}
