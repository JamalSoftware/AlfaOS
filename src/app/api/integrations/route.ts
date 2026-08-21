import { AccessProfile } from "@prisma/client";
import { z } from "zod";
import { jsonError, jsonOk, runApi } from "@/lib/api";
import { logAudit } from "@/lib/audit";
import { assertSameOrigin } from "@/lib/csrf";
import { prisma } from "@/lib/prisma";
import { getSessionUser } from "@/lib/session";

const updateSchema = z.object({
  enabled: z.boolean(),
});

export async function PATCH(request: Request) {
  return runApi(async () => {
    const csrfBlocked = assertSameOrigin(request);
    if (csrfBlocked) {
      return csrfBlocked;
    }

    const session = await getSessionUser(request);
    if (!session) {
      return jsonError("Não autenticado.", 401);
    }
    if (session.profile !== AccessProfile.ADMIN) {
      return jsonError("Acesso negado. Requer perfil ADMIN.", 403);
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonError("Corpo da requisição inválido.", 400);
    }

    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError("Dados inválidos.", 400);
    }

    const { enabled } = parsed.data;

    const integration = await prisma.eRPIntegration.upsert({
      where: { companyId: session.companyId },
      update: { enabled },
      create: {
        companyId: session.companyId,
        provider: "MOCK",
        name: "Mock ERP",
        enabled,
      },
    });

    await logAudit({
      companyId: session.companyId,
      userId: session.id,
      action: enabled ? "ERP.ENABLED" : "ERP.DISABLED",
      entity: "ERPIntegration",
      entityId: integration.id,
    });

    return jsonOk({
      integration: {
        id: integration.id,
        provider: integration.provider,
        enabled: integration.enabled,
        lastTestedAt: integration.lastTestedAt,
        lastTestStatus: integration.lastTestStatus,
      },
    });
  });
}
