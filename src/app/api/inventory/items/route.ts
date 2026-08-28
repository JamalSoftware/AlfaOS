import { AccessProfile } from "@prisma/client";
import { z } from "zod";
import { assertProfile, jsonError, jsonOk, runApi } from "@/lib/api";
import { assertSameOrigin } from "@/lib/csrf";
import { getSessionUser } from "@/lib/session";
import { createInventoryItem, listInventoryItems } from "@/lib/inventory";

/**
 * Catálogo de itens de estoque da empresa.
 *
 * O catálogo diz o QUE existe. Ele não guarda saldo: saldo é derivado dos
 * movimentos (`InventoryMovement`), e uma coluna de quantidade aqui viraria, na
 * primeira divergência, a resposta que ninguém consegue explicar (PRD §181).
 */
/** Rota de sessão: nunca estática. Ver `field/v1/notifications/route.ts`. */
export const dynamic = "force-dynamic";

const VIEW_PROFILES = [AccessProfile.ADMIN, AccessProfile.DISPATCHER];
const MANAGE_PROFILES = [AccessProfile.ADMIN];

const schema = z
  .object({
    code: z.string().min(1).max(40),
    name: z.string().min(1).max(120),
    unit: z.enum(["UNIT", "METER", "KILOGRAM", "LITER"]),
  })
  .strict();

export async function GET(request: Request) {
  return runApi(async () => {
    const session = await getSessionUser(request);
    if (!session) return jsonError("Não autenticado.", 401);
    const denied = assertProfile(session.profile, VIEW_PROFILES);
    if (denied) return denied;

    const items = await listInventoryItems(session.companyId);
    return jsonOk({ items });
  });
}

export async function POST(request: Request) {
  return runApi(async () => {
    const csrfBlocked = assertSameOrigin(request);
    if (csrfBlocked) return csrfBlocked;

    const session = await getSessionUser(request);
    if (!session) return jsonError("Não autenticado.", 401);
    const denied = assertProfile(session.profile, MANAGE_PROFILES);
    if (denied) return denied;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonError("Corpo da requisição inválido.", 400);
    }

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return jsonError("Dados inválidos.", 400, parsed.error.flatten());
    }

    const item = await createInventoryItem(
      session.companyId,
      session.id,
      parsed.data,
    );
    return jsonOk({ item }, 201);
  });
}
