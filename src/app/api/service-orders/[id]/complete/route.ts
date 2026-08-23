import { AccessProfile } from "@prisma/client";
import { z } from "zod";
import { assertProfile, jsonError, jsonOk, runApi } from "@/lib/api";
import { assertSameOrigin } from "@/lib/csrf";
import { getSessionUser } from "@/lib/session";
import { expectedVersionSchema } from "@/lib/version";
import { completeServiceOrder } from "@/lib/service-order-closing";
import { getCompanyServiceOrder } from "@/lib/service-orders";

/** Closing is the owning technician's action, same rationale as `/start`. */
const TECHNICIAN_PROFILES = [AccessProfile.TECHNICIAN];

/**
 * Both versions are REQUIRED and both are checked.
 *
 * The order version alone would let a close seal execution text that another
 * tab saved a moment earlier; the execution version alone would let it seal an
 * order that just gained a photo. Closing is the one operation that must agree
 * with everything it is sealing, so it names both.
 */
const completeSchema = z
  .object({
    expectedOrderVersion: expectedVersionSchema,
    expectedExecutionVersion: expectedVersionSchema,
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

    const parsed = completeSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError("Dados inválidos.", 400, parsed.error.flatten());
    }

    await completeServiceOrder(
      session.companyId,
      session.id,
      context.params.id,
      parsed.data,
    );

    const serviceOrder = await getCompanyServiceOrder(
      session.companyId,
      context.params.id,
    );
    return jsonOk({ serviceOrder });
  });
}
