import { AccessProfile } from "@prisma/client";
import { z } from "zod";
import { assertProfile, jsonError, jsonOk, runApi } from "@/lib/api";
import { assertSameOrigin } from "@/lib/csrf";
import { getSessionUser } from "@/lib/session";
import { expectedVersionSchema } from "@/lib/version";
import {
  EXECUTION_TEXT_MAX_LENGTH,
  updateServiceOrderExecution,
} from "@/lib/service-orders";

/** Only the owning technician writes the execution. Staff read it elsewhere. */
const TECHNICIAN_PROFILES = [AccessProfile.TECHNICIAN];

const executionText = z
  .string()
  .max(
    EXECUTION_TEXT_MAX_LENGTH,
    `Texto muito longo (máximo ${EXECUTION_TEXT_MAX_LENGTH} caracteres).`,
  )
  .nullable()
  .optional();

/**
 * `.strict()` is the mass-assignment defence, and it REJECTS rather than
 * strips: sending `companyId`, `serviceOrderId`, `status`, `technicianId`,
 * `version`, `createdAt` or `updatedAt` fails the request with 400 instead of
 * being quietly dropped. Silent stripping would let a caller believe it had
 * changed its own tenant or the order status and get a 200 back.
 *
 * `expectedVersion` is a control field, NOT data: it is the execution's
 * optimistic-lock token, deliberately separate from the three writable
 * columns, which is why `version` itself is refused above.
 */
const executionSchema = z
  .object({
    expectedVersion: expectedVersionSchema,
    diagnosis: executionText,
    workPerformed: executionText,
    notes: executionText,
  })
  .strict();

export async function PATCH(
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

    const parsed = executionSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError("Dados inválidos.", 400, parsed.error.flatten());
    }

    const { expectedVersion, ...fields } = parsed.data;

    const execution = await updateServiceOrderExecution(
      session.companyId,
      session.id,
      context.params.id,
      expectedVersion,
      fields,
    );
    return jsonOk({ execution });
  });
}
