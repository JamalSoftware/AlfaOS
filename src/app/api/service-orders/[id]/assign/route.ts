import { AccessProfile } from "@prisma/client";
import { z } from "zod";
import { assertProfile, jsonError, jsonOk, runApi } from "@/lib/api";
import { assertSameOrigin } from "@/lib/csrf";
import { getSessionUser } from "@/lib/session";
import { expectedVersionSchema } from "@/lib/version";
import { assignTechnician } from "@/lib/service-orders";

const STAFF_PROFILES = [AccessProfile.ADMIN, AccessProfile.DISPATCHER];

const assignSchema = z
  .object({
    technicianId: z.string().min(1, "Técnico é obrigatório."),
    /**
     * `version` da OS que o cliente leu (vem no `GET /api/service-orders/[id]`).
     * Quando enviada, vira o predicado do compare-and-set: atribuir sobre uma
     * leitura obsoleta é recusado com 409 em vez de sobrescrever quem chegou
     * antes. Opcional de propósito — sem ela o comportamento antigo (relê a
     * versão corrente e aceita) é preservado, então nenhum chamador existente
     * quebra.
     */
    expectedVersion: expectedVersionSchema.optional(),
  })
  .strict();

export async function POST(
  request: Request,
  context: { params: { id: string } },
) {
  return runApi(async () => {
    const csrfBlocked = assertSameOrigin(request);
    if (csrfBlocked) {
      return csrfBlocked;
    }

    const session = await getSessionUser(request);
    if (!session) {
      return jsonError("Não autenticado.", 401);
    }
    const denied = assertProfile(session.profile, STAFF_PROFILES);
    if (denied) return denied;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonError("Corpo da requisição inválido.", 400);
    }

    const parsed = assignSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError("Dados inválidos.", 400, parsed.error.flatten());
    }

    const order = await assignTechnician(
      session.companyId,
      session.id,
      context.params.id,
      parsed.data.technicianId,
      parsed.data.expectedVersion,
    );
    return jsonOk({ serviceOrder: order });
  });
}
