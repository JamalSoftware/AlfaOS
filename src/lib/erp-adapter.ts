import type { ERPCredentialKind, ERPProvider } from "@prisma/client";
import { getERPAdapter } from "@/integrations";
import type { ERPIntegrationContract } from "@/integrations/contract";
import { IntegrationError } from "@/integrations/errors";
import { ReceitanetChatbotClient } from "@/integrations/receitanet/ChatbotClient";
import { getCredentialFor } from "./erp-credential-store";
import { prisma } from "./prisma";

/**
 * Resolve o cliente de ERP de uma empresa, já com a credencial correta.
 *
 * **`ERPCredential` é a única fonte operacional de credenciais.** As colunas
 * `credential*` de `ERPIntegration` continuam fisicamente no banco — removê-las
 * é migration destrutiva — mas nenhum caminho de produção as lê ou escreve. A
 * migração já moveu a credencial existente para `kind=CALLCENTER`.
 *
 * A credencial é obtida em UM lugar só. Nenhum adapter lê ciphertext, toca o
 * Prisma ou sabe como o segredo é guardado: recebe um token pronto e usa. O
 * token trafega em memória, nunca é logado, nunca entra em AuditLog, nunca
 * volta ao frontend.
 */

/**
 * Motivo pelo qual uma capability não está disponível.
 *
 * Existe para que a ausência de credencial do Chatbot não seja confundida com
 * falha: uma empresa que não configurou o Chatbot é um estado legítimo, e o
 * CallCenter dela tem de continuar funcionando normalmente.
 */
export type CapabilityUnavailableReason = "NOT_CONFIGURED" | "UNREADABLE";

export class CapabilityUnavailableError extends Error {
  readonly reason: CapabilityUnavailableReason;
  readonly kind: ERPCredentialKind;

  constructor(kind: ERPCredentialKind, reason: CapabilityUnavailableReason) {
    super(`${kind}:${reason}`);
    this.name = "CapabilityUnavailableError";
    this.kind = kind;
    this.reason = reason;
  }
}

/**
 * Lê a credencial de UMA API.
 *
 * **Nunca cai para a credencial da outra.** Um token de CallCenter enviado ao
 * Chatbot não autentica — e, se um dia autenticasse, seria pior: a empresa
 * teria concedido ao Chatbot um acesso que nunca configurou. Falta de
 * credencial é indisponibilidade daquela capability, não motivo para tentar
 * outra chave.
 */
async function requireCredential(
  companyId: string,
  provider: ERPProvider,
  kind: ERPCredentialKind,
): Promise<string> {
  let token: string | null;
  try {
    token = await getCredentialFor(companyId, provider, kind);
  } catch {
    /**
     * Lança quando existe credencial gravada que não decripta — chave ausente,
     * chave rotacionada, ou vínculo AAD quebrado. Do ponto de vista da
     * integração são a mesma coisa: não há credencial utilizável. A causa exata
     * fica no erro original, que NÃO é propagado, para não vazar detalhe de
     * armazenamento.
     */
    throw new CapabilityUnavailableError(kind, "UNREADABLE");
  }

  if (!token) {
    throw new CapabilityUnavailableError(kind, "NOT_CONFIGURED");
  }
  return token;
}

/**
 * Adapter do CallCenter — busca, detalhe, verificar-acesso e chamados.
 *
 * Usa exclusivamente a credencial `CALLCENTER`.
 */
export async function resolveCompanyAdapter(
  companyId: string,
  provider: ERPProvider,
): Promise<ERPIntegrationContract> {
  if (provider !== "RECEITANET") {
    return getERPAdapter(provider);
  }

  let token: string;
  try {
    token = await requireCredential(companyId, provider, "CALLCENTER");
  } catch (error) {
    if (error instanceof CapabilityUnavailableError) {
      throw new IntegrationError(
        "AUTHENTICATION_FAILED",
        provider,
        error.reason === "NOT_CONFIGURED"
          ? "credencial não configurada"
          : "credencial armazenada não pôde ser lida",
      );
    }
    throw error;
  }

  const integration = await prisma.eRPIntegration.findUnique({
    where: { companyId },
    select: { baseUrl: true },
  });

  return getERPAdapter(provider, {
    token,
    // `baseUrl` só sobrepõe quando a empresa configurou algo; o padrão é a URL
    // do `servers` do OpenAPI oficial.
    baseUrl: integration?.baseUrl ?? null,
  });
}

/**
 * Cliente do Chatbot — enriquecimento e credencial PPPoE real.
 *
 * Devolve `null` quando a empresa não configurou o Chatbot, em vez de lançar:
 * é o que garante o isolamento de falha exigido. Uma empresa sem Chatbot usa o
 * CallCenter normalmente, e o enriquecimento simplesmente não acontece.
 *
 * Lança apenas quando a credencial EXISTE e não pôde ser lida — aí há algo
 * quebrado que precisa aparecer, não um recurso opcional ausente.
 */
export async function resolveChatbotClient(
  companyId: string,
): Promise<ReceitanetChatbotClient | null> {
  let token: string;
  try {
    token = await requireCredential(companyId, "RECEITANET", "CHATBOT");
  } catch (error) {
    if (
      error instanceof CapabilityUnavailableError &&
      error.reason === "NOT_CONFIGURED"
    ) {
      return null;
    }
    if (error instanceof CapabilityUnavailableError) {
      throw new IntegrationError(
        "AUTHENTICATION_FAILED",
        "RECEITANET",
        "credencial do Chatbot não pôde ser lida",
      );
    }
    throw error;
  }

  return new ReceitanetChatbotClient({ token });
}
