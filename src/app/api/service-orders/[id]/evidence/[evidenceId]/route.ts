import { AccessProfile } from "@prisma/client";
import { z } from "zod";
import { assertProfile, jsonError, jsonOk, runApi } from "@/lib/api";
import { assertSameOrigin } from "@/lib/csrf";
import { getSessionUser } from "@/lib/session";
import { expectedVersionSchema } from "@/lib/version";
import { removeEvidence } from "@/lib/service-order-closing";

const TECHNICIAN_PROFILES = [AccessProfile.TECHNICIAN];

const deleteSchema = z
  .object({ expectedOrderVersion: expectedVersionSchema })
  .strict();

export async function DELETE(
  request: Request,
  context: { params: { id: string; evidenceId: string } },
) {
  return runApi(async () => {
    const csrfBlocked = assertSameOrigin(request);
    if (csrfBlocked) return csrfBlocked;

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
    const parsed = deleteSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError("Dados inválidos.", 400, parsed.error.flatten());
    }

    await removeEvidence(
      session.companyId,
      session.id,
      context.params.id,
      context.params.evidenceId,
      parsed.data.expectedOrderVersion,
    );
    return jsonOk({ removed: true });
  });
}
