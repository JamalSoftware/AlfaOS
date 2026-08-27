import { fieldOk, runFieldApi } from "@/lib/field/response";
import { requireFieldPrincipal } from "@/lib/field/route";
import {
  FIELD_MAX_PAGE_SIZE,
  listFieldServiceOrders,
  type FieldOrderScope,
} from "@/lib/field/service-orders";

/**
 * Rota autenticada por Bearer: nunca estática.
 *
 * O Next já a marcaria como dinâmica ao ver a leitura de `headers`, mas por
 * exceção — que o envelope de erro do Field captura e registra como falha no
 * build. Declarar a intenção evita o ruído e, mais importante, não deixa o
 * comportamento de uma rota que carrega dado de cliente depender de inferência.
 */
export const dynamic = "force-dynamic";

/**
 * `GET /api/field/v1/service-orders`
 *
 * A fila do técnico que está com o aparelho. **Só dele.**
 *
 * Não existe `?technicianId=`. O dono é derivado do token no servidor
 * (`token → MobileDevice → User → Technician`), e um parâmetro com esse nome
 * seria simplesmente ignorado — a autorização não passa por nada que o cliente
 * escreva. É a mesma escolha de `resolveActingTechnician` na web.
 *
 * ## Paginação
 *
 * Cursor, não offset. A fila muda enquanto o técnico trabalha, e com `skip` uma
 * OS nova entre duas páginas empurra um item para trás — o técnico veria a
 * mesma OS duas vezes e perderia outra sem nunca saber.
 */

const SCOPES: FieldOrderScope[] = ["active", "completed"];

function parseScope(raw: string | null): FieldOrderScope {
  return SCOPES.includes(raw as FieldOrderScope)
    ? (raw as FieldOrderScope)
    : "active";
}

function parseLimit(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return undefined;
  return Math.min(n, FIELD_MAX_PAGE_SIZE);
}

/** Cursor é um id nosso; formato inválido vira "sem cursor", não erro. */
function parseCursor(raw: string | null): string | null {
  if (!raw) return null;
  return /^[A-Za-z0-9_-]{10,64}$/.test(raw) ? raw : null;
}

export async function GET(request: Request) {
  return runFieldApi(async () => {
    const principal = await requireFieldPrincipal(request);
    const url = new URL(request.url);

    const page = await listFieldServiceOrders(
      principal.user.companyId,
      principal.technician.id,
      {
        scope: parseScope(url.searchParams.get("scope")),
        cursor: parseCursor(url.searchParams.get("cursor")),
        limit: parseLimit(url.searchParams.get("limit")),
      },
    );

    return fieldOk(page);
  });
}
