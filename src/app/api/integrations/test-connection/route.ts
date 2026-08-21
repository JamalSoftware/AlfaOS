import { AccessProfile, ERPProvider } from "@prisma/client";
import { z } from "zod";
import { jsonError, jsonOk } from "@/lib/api";
import { logAudit } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { getSessionUser } from "@/lib/session";
import { getERPAdapter } from "@/integrations";

const schema = z.object({
  provider: z.nativeEnum(ERPProvider).optional(),
});

export async function POST(request: Request) {
  const session = await getSessionUser(request);
  if (!session) {
    return jsonError("Não autenticado.", 401);
  }
  if (session.profile !== AccessProfile.ADMIN) {
    return jsonError("Acesso negado. Requer perfil ADMIN.", 403);
  }

  let provider: ERPProvider = "MOCK";
  try {
    const body = await request.json();
    const parsed = schema.safeParse(body);
    if (parsed.success && parsed.data.provider) {
      provider = parsed.data.provider;
    }
  } catch {
    // No body or invalid body: fall back to the configured default.
  }

  const adapter = getERPAdapter(provider);
  const result = await adapter.testConnection();

  const integration = await prisma.eRPIntegration.upsert({
    where: { companyId: session.companyId },
    update: {
      provider,
      lastTestedAt: new Date(),
      lastTestStatus: result.ok ? "OK" : "ERROR",
    },
    create: {
      companyId: session.companyId,
      provider,
      name: provider === "MOCK" ? "Mock ERP" : "ReceitaNet",
      enabled: result.ok,
    },
  });

  await logAudit({
    companyId: session.companyId,
    userId: session.id,
    action: "ERP.TEST_CONNECTION",
    entity: "ERPIntegration",
    entityId: integration.id,
    details: `Provider ${provider}: ${result.ok ? "conectado" : "falhou"}`,
  });

  return jsonOk({
    result,
    integration: {
      id: integration.id,
      provider: integration.provider,
      enabled: integration.enabled,
      lastTestedAt: integration.lastTestedAt,
      lastTestStatus: integration.lastTestStatus,
    },
  });
}
