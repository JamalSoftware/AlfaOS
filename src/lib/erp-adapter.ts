import type { ERPProvider } from "@prisma/client";
import { getERPAdapter } from "@/integrations";
import type { ERPIntegrationContract } from "@/integrations/contract";
import { IntegrationError } from "@/integrations/errors";
import { getCredential } from "./erp-credentials";
import { prisma } from "./prisma";

/**
 * Resolve o adapter de ERP de uma empresa, já com a credencial que o provider
 * exige.
 *
 * Existe para que a credencial seja obtida em UM lugar só, sempre via
 * `ERPCredentialService`. Nenhum adapter lê ciphertext, toca o Prisma ou sabe
 * como o segredo é armazenado — ele recebe um token pronto e usa. É o que
 * permitirá, quando houver credenciais por API (v0.6+), mudar só esta função.
 *
 * O token é passado em memória, direto para o cliente HTTP. Nunca é logado,
 * nunca entra em AuditLog, nunca volta ao frontend.
 */
export async function resolveCompanyAdapter(
  companyId: string,
  provider: ERPProvider,
): Promise<ERPIntegrationContract> {
  if (provider !== "RECEITANET") {
    return getERPAdapter(provider);
  }

  let token: string | null;
  try {
    // O provider pedido acompanha a leitura: a credencial só serve se foi
    // gravada para ELE. Ver `getCredential`.
    token = await getCredential(companyId, provider);
  } catch {
    /**
     * `getCredential` lança quando existe credencial gravada que não decripta
     * — chave ausente, chave rotacionada ou vínculo AAD quebrado por troca de
     * provider. Todos são, do ponto de vista da integração, a mesma coisa: não
     * há credencial utilizável. A causa exata fica no erro original, que NÃO é
     * propagado justamente para não vazar detalhe de armazenamento.
     */
    throw new IntegrationError(
      "AUTHENTICATION_FAILED",
      provider,
      "credencial armazenada não pôde ser lida",
    );
  }

  if (!token) {
    throw new IntegrationError(
      "AUTHENTICATION_FAILED",
      provider,
      "credencial não configurada",
    );
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
