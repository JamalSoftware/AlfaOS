import { AccessProfile, ERPProvider } from "@prisma/client";
import { z } from "zod";
import { jsonError, jsonOk, runApi } from "@/lib/api";
import { logAudit } from "@/lib/audit";
import { assertSameOrigin } from "@/lib/csrf";
import { prisma } from "@/lib/prisma";
import { getSessionUser } from "@/lib/session";
import { getERPAdapter } from "@/integrations";
import { CLEARED_CREDENTIAL_FIELDS } from "@/lib/erp-credentials";

const schema = z.object({
  provider: z.nativeEnum(ERPProvider).optional(),
});

export async function POST(request: Request) {
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

    /**
     * Trocar o provider invalida a credencial já gravada.
     *
     * O ciphertext é vinculado por AAD a `(companyId, provider)`, então depois
     * da troca ele deixa de decriptar. Antes da v0.5.1 os campos ficavam no
     * lugar e `getCredentialStatus` — que só verifica se o ciphertext existe —
     * continuava reportando "configurada" com o mesmo last4. O operador via uma
     * credencial aparentemente válida que nenhum adapter conseguiria usar.
     *
     * A limpeza é explícita: um segredo que não pode mais ser lido não é uma
     * credencial, é lixo que mente sobre o estado da integração.
     */
    const previous = await prisma.eRPIntegration.findUnique({
      where: { companyId: session.companyId },
      select: { id: true, provider: true, credentialCiphertext: true },
    });
    const providerChanged =
      previous !== null && previous.provider !== provider;
    const invalidatedCredential =
      providerChanged && previous.credentialCiphertext !== null;

    // A successful test is NOT an automatic activation. The integration
    // only becomes enabled through an explicit enable/disable action.
    const integration = await prisma.eRPIntegration.upsert({
      where: { companyId: session.companyId },
      update: {
        provider,
        lastTestedAt: new Date(),
        lastTestStatus: result.ok ? "OK" : "ERROR",
        ...(providerChanged ? CLEARED_CREDENTIAL_FIELDS : {}),
      },
      create: {
        companyId: session.companyId,
        provider,
        name: provider === "MOCK" ? "Mock ERP" : "ReceitaNet",
        enabled: false,
        lastTestedAt: new Date(),
        lastTestStatus: result.ok ? "OK" : "ERROR",
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

    if (invalidatedCredential) {
      // Registra provider antigo e novo — nunca token, ciphertext, iv,
      // authTag, last4 ou chave.
      await logAudit({
        companyId: session.companyId,
        userId: session.id,
        action: "ERP_CREDENTIAL_INVALIDATED",
        entity: "ERPIntegration",
        entityId: integration.id,
        details: `Credencial removida na troca de provider ${previous.provider} para ${provider}`,
      });
    }

    return jsonOk({
      result,
      // Booleano, para a tela poder avisar que é preciso reconfigurar. Não
      // carrega nada do segredo removido.
      invalidatedCredential,
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
