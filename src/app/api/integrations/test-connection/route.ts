import { AccessProfile, ERPProvider } from "@prisma/client";
import { z } from "zod";
import { jsonError, jsonOk, runApi } from "@/lib/api";
import { logAudit } from "@/lib/audit";
import { assertSameOrigin } from "@/lib/csrf";
import { prisma } from "@/lib/prisma";
import { getSessionUser } from "@/lib/session";
import { isIntegrationError } from "@/integrations/errors";
import { resolveChatbotClient, resolveCompanyAdapter } from "@/lib/erp-adapter";
import type { ERPConnectionResult } from "@/integrations/contract";
import { CLEARED_CREDENTIAL_FIELDS } from "@/lib/erp-credentials";
import {
  enforceCapabilityLimit,
  ERP_CAPABILITIES,
} from "@/lib/capability-rate-limit";

const schema = z.object({
  provider: z.nativeEnum(ERPProvider).optional(),
  /**
   * Qual API testar. Cada bloco da tela testa a SUA credencial: testar o
   * Chatbot com o token do CallCenter diria ao operador que está tudo bem
   * com uma credencial que ele nem configurou.
   */
  kind: z.enum(["CALLCENTER", "CHATBOT"]).optional(),
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

    /**
     * Testar a conexão é um clique deliberado, mas continua sendo uma
     * requisição ao provider por clique — e o botão é o mais fácil de repetir
     * quando algo não funciona. Teto depois da autorização.
     */
    const limited = enforceCapabilityLimit(
      session.companyId,
      session.id,
      ERP_CAPABILITIES.TEST_CONNECTION,
    );
    if (limited) return limited;

    let provider: ERPProvider = "MOCK";
    let kind: "CALLCENTER" | "CHATBOT" = "CALLCENTER";
    try {
      const body = await request.json();
      const parsed = schema.safeParse(body);
      if (parsed.success && parsed.data.provider) {
        provider = parsed.data.provider;
      }
      if (parsed.success && parsed.data.kind) {
        kind = parsed.data.kind;
      }
    } catch {
      // No body or invalid body: fall back to the configured default.
    }

    /**
     * Teste do Chatbot: caminho próprio, credencial própria.
     *
     * Usa `/empresa`, a menor chamada autenticada do contrato — não devolve
     * dado de cliente nem senha. Testar com `/clientes` exigiria um CPF real
     * e traria credencial em texto puro para uma operação que só precisa
     * saber se o token vale.
     *
     * Nunca cai para o token do CallCenter: se o Chatbot não está
     * configurado, a resposta é "não configurado", e não um teste que passa
     * usando outra chave.
     */
    if (kind === "CHATBOT") {
      let chatbotResult: ERPConnectionResult;
      let chatbotCode = "OK";
      try {
        const client = await resolveChatbotClient(session.companyId);
        if (!client) {
          chatbotCode = "NOT_CONFIGURED";
          chatbotResult = {
            ok: false,
            provider,
            latencyMs: 0,
            reachable: false,
            credentialValidated: false,
            message: "Credencial do Chatbot não configurada.",
          };
        } else {
          const started = Date.now();
          await client.verificarCredencial();
          chatbotResult = {
            ok: true,
            provider,
            latencyMs: Date.now() - started,
            reachable: true,
            credentialValidated: true,
            message: "Chatbot conectado.",
          };
        }
      } catch (error) {
        chatbotCode = isIntegrationError(error) ? error.code : "UNAVAILABLE";
        chatbotResult = {
          ok: false,
          provider,
          latencyMs: 0,
          // Um 401 prova que o serviço RESPONDEU: alcançável, credencial má.
          reachable: isIntegrationError(error) && error.code === "AUTHENTICATION_FAILED",
          credentialValidated: false,
          // Mensagem do catálogo, nunca corpo do provider.
          message: isIntegrationError(error)
            ? error.userMessage
            : "Não foi possível testar o Chatbot.",
        };
      }

      await logAudit({
        companyId: session.companyId,
        userId: session.id,
        action: "ERP.TEST_CONNECTION",
        entity: "ERPCredential",
        entityId: `${provider}:CHATBOT`,
        details: `Chatbot: ${chatbotResult.ok ? "conectado" : "falhou"}`,
      });

      /**
       * Resposta pública MÍNIMA: `ok`, um código do catálogo fechado e a
       * latência. Nunca o corpo do provider — a resposta do Chatbot contém
       * senha de cliente, login, telefone, CPF e coordenadas.
       *
       * `result.message` também é do catálogo (`userMessage`), nunca texto
       * vindo do provider.
       */
      return jsonOk({
        result: chatbotResult,
        code: chatbotCode,
        invalidatedCredential: false,
      });
    }

    /**
     * Resolver o adapter pode falhar por credencial ausente ou ilegível — o
     * ReceitaNet exige token. Isso é RESULTADO do teste, não erro da rota:
     * o operador clicou justamente para descobrir o estado da integração.
     */
    let result: ERPConnectionResult;
    let code = "OK";
    try {
      const adapter = await resolveCompanyAdapter(session.companyId, provider);
      result = await adapter.testConnection();
      if (!result.ok) code = "UNAVAILABLE";
    } catch (error) {
      code = isIntegrationError(error) ? error.code : "UNAVAILABLE";
      result = {
        ok: false,
        provider,
        latencyMs: 0,
        reachable: false,
        credentialValidated: false,
        message: isIntegrationError(error)
          ? error.userMessage
          : "Não foi possível iniciar a integração.",
      };
    }

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
      select: { id: true, provider: true },
    });
    const providerChanged =
      previous !== null && previous.provider !== provider;

    /**
     * O flag descreve o STORE OPERACIONAL, nao a coluna legada.
     *
     * Antes do cutover ele olhava `ERPIntegration.credentialCiphertext`. Com a
     * credencial morando em `ERPCredential`, continuar olhando a coluna antiga
     * faria a tela dizer que nada foi invalidado enquanto tokens reais eram
     * apagados -- um aviso que some justamente quando importa.
     */
    const invalidatedCredential =
      providerChanged &&
      (await prisma.eRPCredential.count({
        where: { companyId: session.companyId, provider: previous.provider },
      })) > 0;

    // A successful test is NOT an automatic activation. The integration
    // only becomes enabled through an explicit enable/disable action.
    const integration = await prisma.eRPIntegration.upsert({
      where: { companyId: session.companyId },
      update: {
        provider,
        /**
         * `name` acompanha o provider.
         *
         * Antes só o `create` o definia, então trocar de MOCK para RECEITANET
         * deixava a coluna dizendo “Mock ERP” para sempre — e a tela repetia
         * isso ao operador, que via um provedor e o nome de outro.
         */
        name: provider === "MOCK" ? "Mock ERP" : "ReceitaNet",
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

    /**
     * Troca de provider invalida as credenciais do provider ANTERIOR.
     *
     * O AAD liga o ciphertext a `(companyId, provider, kind)`, então depois
     * da troca ele deixa de decriptar para o provider novo. Deixar as linhas
     * no lugar faria o status reportar “configurada” para algo que nenhum
     * adapter conseguiria usar — foi exatamente o defeito corrigido na
     * v0.6.2, e ele precisa continuar corrigido agora que a credencial mora
     * noutra tabela.
     */
    if (providerChanged) {
      await prisma.eRPCredential.deleteMany({
        where: { companyId: session.companyId, provider: previous.provider },
      });
    }

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
      // Codigo do catalogo fechado, para a tela mostrar o motivo sem receber
      // nada do corpo do provider.
      code,
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
