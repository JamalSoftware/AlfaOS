import type { ERPProvider, Prisma } from "@prisma/client";
import { getERPAdapter } from "@/integrations";
import type { ERPConnectionResult } from "@/integrations/contract";
import type { FetchLike } from "@/integrations/sgp/SgpClient";
import { logAuditWithin } from "./audit";
import {
  credentialLast4,
  encryptCredential,
  type EncryptedCredential,
} from "./erp-credential-cipher";
import { normalizeCredentialToken } from "./erp-credential-store";
import { badRequest, conflict, notFound } from "./errors";
import { prisma } from "./prisma";
import {
  assertSafeOutboundUrl,
  outboundUrlMessage,
  UnsafeOutboundUrlError,
} from "./safe-outbound-url";

/**
 * # Configuração CANDIDATA e ativação de um ERP
 *
 * A regra do produto não muda: **uma empresa tem ZERO OU UM ERP ativo.** Este
 * módulo é o que permite preparar o próximo sem violar isso.
 *
 * ## O problema que ele resolve
 *
 * Para ativar o SGP é preciso saber que a credencial funciona. Mas testar exige
 * `baseUrl`, `app` e `token`, e a empresa ainda está no ReceitaNet. Sem uma
 * noção de candidato, restariam dois caminhos, e os dois são ruins:
 *
 * - gravar a configuração do SGP em `ERPIntegration.baseUrl`/`config` só para
 *   testar — **corromperia a configuração do ERP que está atendendo**;
 * - criar uma segunda `ERPIntegration` — quebraria a regra de um ERP ativo.
 *
 * ## A saída: candidato NÃO é persistido
 *
 * `testCandidateConnection` recebe a configuração pelo corpo da requisição,
 * monta um adapter **em memória**, testa e devolve o resultado. Nada é gravado:
 * nem integração, nem credencial, nem `lastTestedAt`.
 *
 * O token candidato existe apenas durante aquela requisição. Se o ADMIN sair da
 * página antes de ativar, preenche de novo — simplicidade escolhida sobre
 * staging permanente (`docs/ERP-SGP.md`, plano da `SGP-1`).
 */

/**
 * Costura de TESTE, e só isso.
 *
 * `fetchImpl` é o mesmo ponto de injeção que `ERPAdapterConfig` já publica —
 * aqui ele só sobe um nível, para o teste exercitar 200/401/timeout sem tocar a
 * rede. `dnsResolver` existe pela mesma razão do lado do SSRF: um nome de
 * exemplo não resolve em DNS real, e depender disso faria a suíte precisar de
 * internet.
 *
 * Em produção os dois ficam `undefined` e valem os padrões reais.
 */
export interface CandidateSeams {
  fetchImpl?: FetchLike;
  dnsResolver?: (hostname: string) => Promise<{ address: string }[]>;
}

/** Configuração que um provider precisa além da credencial. */
export interface CandidateConfiguration {
  baseUrl: string;
  app: string;
  token: string;
}

/**
 * Providers cuja ativação exige configuração candidata.
 *
 * Derivado do que o adapter EXIGE para ser construído, não de uma lista
 * paralela: o `SgpClient` recusa sem `baseUrl`, `app` e `token`, então o SGP
 * está aqui. `MOCK` não precisa de nada e o `RECEITANET` usa credencial já
 * gravada pelo fluxo próprio dele.
 */
export function requiresCandidateConfiguration(provider: ERPProvider): boolean {
  return provider === "SGP";
}

/**
 * Valida a configuração candidata e devolve a `baseUrl` normalizada.
 *
 * A validação de SSRF acontece **antes de qualquer requisição** — é ela que
 * impede o servidor do AlfaOS de bater na própria infraestrutura por causa de
 * um endereço digitado no formulário. Ver `safe-outbound-url.ts`.
 */
async function validateCandidate(
  provider: ERPProvider,
  candidate: CandidateConfiguration,
  dnsResolver?: CandidateSeams["dnsResolver"],
): Promise<CandidateConfiguration> {
  if (!requiresCandidateConfiguration(provider)) {
    throw badRequest(
      `O provedor ${provider} não recebe configuração de Base URL e App.`,
    );
  }
  if (!candidate.app.trim()) {
    throw badRequest("Informe o App cadastrado no SGP.");
  }
  if (!candidate.token.trim()) {
    throw badRequest("Informe o Token gerado no SGP.");
  }

  let safe;
  try {
    safe = dnsResolver
      ? await assertSafeOutboundUrl(candidate.baseUrl, dnsResolver)
      : await assertSafeOutboundUrl(candidate.baseUrl);
  } catch (error) {
    if (error instanceof UnsafeOutboundUrlError) {
      // Mensagem do catálogo: nunca revela o IP resolvido nem topologia.
      throw badRequest(outboundUrlMessage(error.reason));
    }
    throw error;
  }

  return {
    baseUrl: safe.origin,
    app: candidate.app.trim(),
    token: normalizeCredentialToken(candidate.token),
  };
}

/**
 * Testa uma configuração candidata. **Não persiste nada.**
 *
 * Devolve o resultado sanitizado do `testConnection` do adapter — que por
 * contrato nunca lança e nunca carrega corpo do provider, URL ou token.
 */
export async function testCandidateConnection(params: {
  provider: ERPProvider;
  candidate: CandidateConfiguration;
} & CandidateSeams): Promise<ERPConnectionResult> {
  const candidate = await validateCandidate(
    params.provider,
    params.candidate,
    params.dnsResolver,
  );

  const adapter = getERPAdapter(params.provider, {
    baseUrl: candidate.baseUrl,
    app: candidate.app,
    token: candidate.token,
    fetchImpl: params.fetchImpl,
  });

  return adapter.testConnection();
}

/**
 * Ativa um provider que exige configuração, de forma ATÔMICA.
 *
 * ## O servidor reexecuta o teste
 *
 * O resultado que o browser viu **não é aceito como prova**. Entre o clique em
 * "testar" e o clique em "confirmar" o token pode ter sido revogado, o host
 * pode ter mudado, e — mais importante — o corpo da confirmação é
 * reenviável: sem reteste, um POST forjado ativaria o SGP com credencial que
 * nunca funcionou. A ativação testa de novo, no servidor, com a configuração
 * que vai de fato ser gravada.
 *
 * Teste falhou → **nada é trocado.**
 *
 * ## Atomicidade real, não aparente
 *
 * A cifragem acontece FORA da transação, e isso é o que a torna possível:
 * `encryptCredential` é pura e falha por chave ausente antes de qualquer
 * escrita. Só as escritas entram na transação — integração, credencial e
 * `AuditLog` —, e por isso não existe estado em que `provider = SGP` conviva
 * com credencial ausente.
 *
 * ## Concorrência
 *
 * Mesmo compare-and-set da `ERP-1`: o `updateMany` compara o provider **lido**.
 * Duas ativações simultâneas a partir do mesmo estado deixam uma vencer; a
 * outra recebe 409 sem gravar auditoria de uma troca que não fez.
 */
export async function activateErpProviderWithConfiguration(params: {
  companyId: string;
  actorUserId: string;
  provider: ERPProvider;
  candidate: CandidateConfiguration;
} & CandidateSeams): Promise<{
  fromProvider: ERPProvider;
  toProvider: ERPProvider;
  result: ERPConnectionResult;
}> {
  const { companyId, actorUserId, provider } = params;
  const candidate = await validateCandidate(
    provider,
    params.candidate,
    params.dnsResolver,
  );

  const current = await prisma.eRPIntegration.findUnique({
    where: { companyId },
    select: { id: true, provider: true },
  });
  if (!current) {
    throw notFound("Integração ERP não configurada para esta empresa.");
  }
  if (current.provider === provider) {
    /**
     * Recusado, e não no-op: um 200 gravaria `ERP.ACTIVE_PROVIDER_CHANGED` para
     * uma troca que não aconteceu. Reconfigurar o provider JÁ ativo é outra
     * operação, e não existe nesta fase.
     */
    throw badRequest(`O ERP ativo desta empresa já é ${provider}.`);
  }

  // Reteste no servidor. Antes de qualquer escrita.
  const adapter = getERPAdapter(provider, {
    baseUrl: candidate.baseUrl,
    app: candidate.app,
    token: candidate.token,
    fetchImpl: params.fetchImpl,
  });
  const result = await adapter.testConnection();
  if (!result.ok) {
    throw badRequest(
      `A conexão com ${provider} não foi validada: ${result.message}`,
    );
  }

  /**
   * Cifra ANTES da transação. Chave ausente lança aqui, e nada é gravado —
   * nunca existe um `provider = SGP` sem a credencial dele.
   */
  const encrypted: EncryptedCredential = encryptCredential(candidate.token, {
    companyId,
    provider,
    kind: "PUBLIC_API",
  });
  const last4 = credentialLast4(candidate.token);

  const change = await prisma.$transaction(async (tx) => {
    const updated = await tx.eRPIntegration.updateMany({
      where: { companyId, provider: current.provider },
      data: {
        provider,
        baseUrl: candidate.baseUrl,
        /**
         * `app` é configuração, não segredo. Substitui o `config` inteiro em
         * vez de mesclar: o que estava lá pertencia ao provider ANTERIOR, e
         * misturar deixaria resto de configuração alheia numa linha que agora
         * descreve outro ERP.
         */
        config: { app: candidate.app } satisfies Prisma.InputJsonValue,
        /**
         * O teste que acabou de passar É o último teste desta integração — ela
         * nasce ativa com saúde observada, não herdada.
         */
        lastTestedAt: new Date(),
        lastTestStatus: "OK",
      },
    });

    if (updated.count === 0) {
      throw conflict(
        "O ERP ativo foi alterado por outra operação. Recarregue e tente novamente.",
      );
    }

    await tx.eRPCredential.upsert({
      where: {
        companyId_provider_kind: { companyId, provider, kind: "PUBLIC_API" },
      },
      create: {
        companyId,
        provider,
        kind: "PUBLIC_API",
        credentialCiphertext: encrypted.ciphertext,
        credentialIv: encrypted.iv,
        credentialAuthTag: encrypted.authTag,
        credentialLast4: last4,
        aadVersion: "v2",
        credentialUpdatedAt: new Date(),
      },
      update: {
        credentialCiphertext: encrypted.ciphertext,
        credentialIv: encrypted.iv,
        credentialAuthTag: encrypted.authTag,
        credentialLast4: last4,
        aadVersion: "v2",
        credentialUpdatedAt: new Date(),
      },
    });

    await logAuditWithin(tx, {
      companyId,
      userId: actorUserId,
      action: "ERP.ACTIVE_PROVIDER_CHANGED",
      entity: "ERPIntegration",
      entityId: current.id,
      /**
       * Origem e destino. Nunca token, ciphertext, IV, tag, `last4` nem o
       * `app` — que não é segredo, mas também não precisa estar aqui.
       */
      details: `ERP ativo alterado de ${current.provider} para ${provider}`,
    });

    return { fromProvider: current.provider, toProvider: provider };
  });

  /**
   * As credenciais do provider ANTERIOR permanecem, cifradas e ociosas. É o
   * invariante da `ERP-1`: credencial armazenada não significa ERP ativo, e
   * preservá-la é o que mantém o rollback possível.
   */
  return { ...change, result };
}
