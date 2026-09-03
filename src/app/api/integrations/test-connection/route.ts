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

    /**
     * Sem `provider` no corpo, testa-se o ERP **ativo** da empresa.
     *
     * Antes o padrão era `MOCK` fixo, o que só não enganava porque a rota
     * gravava o provider testado logo em seguida — testar "sem dizer qual"
     * acabava transformando a empresa em MOCK. Com a escrita removida, o padrão
     * precisa ser o provider que de fato está atendendo.
     *
     * `MOCK` continua sendo o último recurso, para a empresa que ainda não
     * configurou ERP nenhum: ali o teste é uma sonda, e não persiste nada.
     */
    const activeBefore = await prisma.eRPIntegration.findUnique({
      where: { companyId: session.companyId },
      select: { provider: true },
    });

    let provider: ERPProvider = activeBefore?.provider ?? "MOCK";
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
     * ## Testar é CONSULTAR — `ERP-1`
     *
     * Esta rota **não** troca o ERP ativo e **não** apaga credencial. Até a
     * `ERP-1` ela fazia as duas coisas: um `upsert` que gravava `provider`, e um
     * `deleteMany` sobre as `ERPCredential` do provider anterior.
     *
     * O efeito prático era grave em dois sentidos. Testar o provider candidato
     * **ativava** aquele ERP na empresa sem ninguém pedir — a operação inteira
     * passava a falar com outro sistema por causa de um clique de diagnóstico.
     * E o segredo do provider anterior era destruído em silêncio, eliminando o
     * rollback: voltar exigia recadastrar token sob pressão.
     *
     * Trocar o ERP ativo agora é `POST /api/integrations/active-provider`, com
     * confirmação e auditoria próprias (`switchActiveErpProvider`).
     *
     * ## O que ainda é gravado, e só isso
     *
     * `lastTestedAt`/`lastTestStatus` descrevem a saúde da integração **ativa**.
     * Quando o teste é de um provider CANDIDATO, nada é persistido: escrever o
     * resultado dele na linha da empresa faria a tela anunciar a saúde de um ERP
     * que não está atendendo ninguém.
     *
     * Não há coluna para saúde de candidato, e não se inventa uma aqui — exigir
     * "último teste bem-sucedido" antes da troca fica para a `SGP-1`, quando
     * existir uma segunda implementação real para exercitá-la.
     */
    const testedActiveProvider =
      activeBefore !== null && activeBefore.provider === provider;

    const integration = testedActiveProvider
      ? await prisma.eRPIntegration.update({
          where: { companyId: session.companyId },
          data: {
            lastTestedAt: new Date(),
            lastTestStatus: result.ok ? "OK" : "ERROR",
          },
        })
      : await prisma.eRPIntegration.findUnique({
          where: { companyId: session.companyId },
        });

    await logAudit({
      companyId: session.companyId,
      userId: session.id,
      action: "ERP.TEST_CONNECTION",
      entity: "ERPIntegration",
      entityId: integration?.id ?? null,
      /**
       * O evento nomeia o provider testado e diz se ele era o ATIVO. Sem isso,
       * um teste de candidato ficaria indistinguível de um teste do ERP em uso —
       * e poderia ser lido como se a empresa tivesse trocado de ERP. Trocar tem
       * evento próprio: `ERP.ACTIVE_PROVIDER_CHANGED`.
       */
      details: `Provider ${provider}${testedActiveProvider ? " (ativo)" : " (candidato)"}: ${result.ok ? "conectado" : "falhou"}`,
    });

    return jsonOk({
      result,
      // Codigo do catalogo fechado, para a tela mostrar o motivo sem receber
      // nada do corpo do provider.
      code,
      /**
       * Testar um provider candidato não ativa nada. A tela usa este campo para
       * dizer ao operador que o resultado é de um diagnóstico, e que trocar o
       * ERP continua sendo uma ação separada.
       */
      testedActiveProvider,
      activeProvider: activeBefore?.provider ?? null,
      integration: integration
        ? {
            id: integration.id,
            provider: integration.provider,
            enabled: integration.enabled,
            lastTestedAt: integration.lastTestedAt,
            lastTestStatus: integration.lastTestStatus,
          }
        : null,
    });
  });
}
