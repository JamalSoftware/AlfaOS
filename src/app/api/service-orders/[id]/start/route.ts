import { AccessProfile } from "@prisma/client";
import { z } from "zod";
import { assertProfile, jsonError, jsonOk, runApi } from "@/lib/api";
import { assertSameOrigin } from "@/lib/csrf";
import { getSessionUser } from "@/lib/session";
import { startServiceOrder } from "@/lib/service-orders";

/**
 * Starting an order is a TECHNICIAN-only action.
 *
 * ADMIN/DISPATCHER deliberately cannot start work on someone else's behalf.
 * `startedAt` is the field the whole SLA story is later built on, and the PRD
 * puts "iniciar atendimento" in the technician's job description (§7 Perfis,
 * §29 v0.3), not the dispatcher's. Letting the back office stamp it would make
 * the timestamp mean "someone said the technician arrived" instead of "the
 * technician arrived", and there is no way to tell the two apart afterwards.
 * Staff keep full read access to the order and its execution.
 */
const TECHNICIAN_PROFILES = [AccessProfile.TECHNICIAN];

const startSchema = z
  .object({
    /**
     * `version` da OS que o cliente leu. Obrigatória: este fluxo é novo, não
     * há chamador legado para preservar, então o lock fim-a-fim vale desde o
     * primeiro dia. Sem ela não há como distinguir "iniciar a OS que eu vi" de
     * "iniciar seja lá o que a OS for agora".
     */
    expectedVersion: z.number().int().min(0),
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
    const denied = assertProfile(session.profile, TECHNICIAN_PROFILES);
    if (denied) return denied;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonError("Corpo da requisição inválido.", 400);
    }

    const parsed = startSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError("Dados inválidos.", 400, parsed.error.flatten());
    }

    const result = await startServiceOrder(
      session.companyId,
      session.id,
      context.params.id,
      parsed.data.expectedVersion,
    );
    return jsonOk({
      serviceOrder: result.serviceOrder,
      execution: result.execution,
    });
  });
}
