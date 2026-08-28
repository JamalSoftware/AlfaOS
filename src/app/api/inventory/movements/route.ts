import { AccessProfile } from "@prisma/client";
import { z } from "zod";
import { assertProfile, jsonError, jsonOk, runApi } from "@/lib/api";
import { assertSameOrigin } from "@/lib/csrf";
import { getSessionUser } from "@/lib/session";
import { receiveStock, returnStock } from "@/lib/inventory";

/**
 * `POST /api/inventory/movements`
 *
 * Entrega de material ao técnico e devolução ao almoxarifado.
 *
 * ## Por que isto NÃO existe no Field
 *
 * Se o aplicativo do técnico pudesse emitir entrada de estoque, ele criaria o
 * próprio saldo antes de baixá-lo — e a validação de saldo do consumo não
 * valeria absolutamente nada. Entrada é ato de quem entrega, não de quem
 * recebe.
 *
 * ## Dois tipos, e só dois
 *
 * `WAREHOUSE_TO_TECHNICIAN` e `TECHNICIAN_TO_WAREHOUSE`. Ajuste de inventário,
 * transferência entre técnicos, extravio e descarte pertencem à custódia de
 * patrimônio (PRD §210–§223), que não entra nesta versão — e entrarão como
 * valores do MESMO enum, nunca como um segundo motor.
 *
 * A devolução valida saldo: um técnico não devolve o que não tem, e aceitar
 * isso deixaria o ledger com saldo negativo sem nenhum movimento que o
 * explique.
 */
const MANAGE_PROFILES = [AccessProfile.ADMIN];

const schema = z
  .object({
    type: z.enum(["WAREHOUSE_TO_TECHNICIAN", "TECHNICIAN_TO_WAREHOUSE"]),
    itemId: z.string().min(1).max(50),
    technicianId: z.string().min(1).max(50),
    quantity: z.number().finite().positive(),
    notes: z.string().max(300).optional().nullable(),
  })
  .strict();

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

    const input = {
      itemId: parsed.data.itemId,
      technicianId: parsed.data.technicianId,
      quantity: parsed.data.quantity,
      notes: parsed.data.notes ?? null,
    };

    // O serviço valida que item e técnico são da MESMA empresa da sessão antes
    // de mover qualquer coisa.
    const movement =
      parsed.data.type === "WAREHOUSE_TO_TECHNICIAN"
        ? await receiveStock(session.companyId, session.id, input)
        : await returnStock(session.companyId, session.id, input);

    return jsonOk({ movement }, 201);
  });
}
