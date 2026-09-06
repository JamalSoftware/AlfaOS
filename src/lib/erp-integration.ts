import { Prisma, type ERPProvider } from "@prisma/client";
import { isIntegrationError } from "@/integrations/errors";
import { logAuditWithin } from "./audit";
import { assertProviderUsableAfterSwitch } from "./erp-adapter";
import { badRequest, conflict, notFound } from "./errors";
import {
  assertProviderActivationAllowed,
  requiresCandidateConfiguration,
} from "./erp-provisioning";
import { prisma } from "./prisma";

/**
 * # O ERP ATIVO de uma empresa
 *
 * ## A regra
 *
 * ```text
 * Company
 *    └── ERPIntegration 0..1
 *           └── provider   ← o ERP ativo
 * ```
 *
 * Cada empresa tem **zero ou um** ERP ativo. O AlfaOS suporta vários *tipos* de
 * ERP globalmente; cada empresa usa um. `ERPIntegration.companyId @unique` é o
 * que torna isso invariante de banco em vez de convenção — não há campo
 * separado de "provider principal" porque, com uma integração só, o provider
 * dela **é** o provider ativo. Uma segunda memória do mesmo fato divergiria no
 * dia em que alguém escrevesse numa e esquecesse da outra.
 *
 * ## Três ações que NÃO compartilham efeito
 *
 * ```text
 * SALVAR CREDENCIAL   grava segredo. Não ativa provider.
 * TESTAR CONEXÃO      consulta. Não altera o ERP ativo. Não apaga nada.
 * ALTERAR ERP ATIVO   esta função. Só ela troca o provider.
 * ```
 *
 * Antes desta fase a troca acontecia **dentro** do teste de conexão: clicar em
 * "testar conexão" com outro provider trocava o ERP da empresa e apagava as
 * credenciais do anterior. Testar deixara de ser uma consulta.
 */

/** A integração ativa da empresa, ou `null` quando não há ERP configurado. */
export async function getActiveIntegration(companyId: string) {
  return prisma.eRPIntegration.findUnique({
    where: { companyId },
    select: {
      id: true,
      provider: true,
      enabled: true,
      baseUrl: true,
      lastTestedAt: true,
      lastTestStatus: true,
    },
  });
}

/**
 * Troca o ERP ativo da empresa. É a ÚNICA operação que escreve
 * `ERPIntegration.provider`.
 *
 * ## Precondições, e por que são genéricas
 *
 * A exigência de credencial **não** é codificada por provider. Ela é: *"o
 * provider de destino ficará utilizável DEPOIS da troca?"* — e quem responde é
 * `assertProviderUsableAfterSwitch`, que falha com `AUTHENTICATION_FAILED`
 * quando falta o segredo. O MockERP passa porque não precisa de token; o
 * ReceitaNet só passa com credencial gravada; um provider futuro herda a regra
 * sem que ninguém precise voltar aqui.
 *
 * **"Depois da troca" é o detalhe que importa.** A precondição avalia o adapter
 * SEM as sobreposições gravadas, porque elas pertencem ao provider que está
 * saindo e esta função as limpa. Avaliá-las bloquearia o rollback — ver a nota
 * naquela função.
 *
 * ## O que ela NÃO faz
 *
 * **Não apaga a credencial do provider anterior.** Credencial armazenada não
 * significa ERP ativo: as linhas do provider antigo continuam cifradas e
 * ociosas, isoladas pelo AAD `(companyId, provider, kind)`, e simplesmente não
 * são consultadas. É isso que preserva o rollback — voltar não exige
 * recadastrar token sob pressão.
 *
 * **Não reescreve identidade externa.** `Customer.externalProvider` e
 * `ServiceOrder.externalProvider` registram DE ONDE o dado veio, não qual ERP
 * está ativo agora. Uma OS importada do ReceitaNet continua ReceitaNet depois
 * da troca; converter apagaria a informação de qual sistema originou cada
 * atendimento.
 *
 * ## Concorrência
 *
 * Duas trocas simultâneas a partir do mesmo estado (`A→B` e `A→C`) não podem
 * deixar estado híbrido nem auditoria mentirosa. O `updateMany` é um
 * compare-and-set sobre o provider LIDO: quem chega em segundo encontra
 * `count === 0` e recebe 409, sem gravar auditoria de uma troca que não fez.
 * Nenhuma coluna `version` foi acrescentada — o próprio provider é o token de
 * comparação, e ele já está no schema.
 */
export async function switchActiveErpProvider(params: {
  companyId: string;
  actorUserId: string;
  provider: ERPProvider;
}): Promise<{ fromProvider: ERPProvider; toProvider: ERPProvider }> {
  const { companyId, actorUserId, provider } = params;

  const current = await prisma.eRPIntegration.findUnique({
    where: { companyId },
    select: { id: true, provider: true },
  });
  if (!current) {
    throw notFound("Integração ERP não configurada para esta empresa.");
  }

  /**
   * Trocar para o provider que já está ativo é recusado, e não tratado como
   * no-op silencioso: um 200 gravaria `ERP.ACTIVE_PROVIDER_CHANGED` para uma
   * troca que não aconteceu, e a auditoria passaria a conter eventos que a
   * operação nunca viveu.
   */
  if (current.provider === provider) {
    throw badRequest(`O ERP ativo desta empresa já é ${provider}.`);
  }

  /**
   * Provider que exige configuração própria não entra por aqui.
   *
   * O SGP precisa de `baseUrl`, `app` e token, e ativá-lo é o fluxo de
   * `activateErpProviderWithConfiguration` — que valida a URL contra SSRF,
   * retesta no servidor e grava tudo numa transação. Deixar esta rota tentar
   * produziria uma recusa por credencial ausente com mensagem confusa, ou —
   * pior — ativaria o SGP reaproveitando `baseUrl` de outro provider.
   */
  if (requiresCandidateConfiguration(provider)) {
    throw badRequest(
      `Ativar ${provider} exige informar Base URL, App e Token na tela do provedor.`,
    );
  }

  /*
    A trava de release, TAMBÉM aqui.

    Esta função e `activateErpProviderWithConfiguration` são as duas únicas que
    escrevem `ERPIntegration.provider`. A trava vivia só na outra, e o SGP era
    barrado aqui por `requiresCandidateConfiguration` — um predicado que existe
    por OUTRA razão. Duas proteções que só coincidem por acidente: um provider
    futuro que precise de trava e não de configuração candidata passaria direto,
    e ninguém saberia que aquele `if` acima virou controle de release.

    Depois do bloco anterior, e não antes, para não trocar a mensagem que o SGP
    já recebe hoje — a resposta continua sendo "informe Base URL, App e Token",
    que é o que a pessoa precisa fazer.

    Apontado pela auditoria independente, que também mostrou que o comentário
    de `assertProviderActivationAllowed` prometia exatamente esta cobertura e
    não a tinha.
  */
  assertProviderActivationAllowed(provider);

  try {
    await assertProviderUsableAfterSwitch(companyId, provider);
  } catch (error) {
    if (isIntegrationError(error)) {
      throw badRequest(
        `Não é possível ativar ${provider}: ${error.userMessage}`,
      );
    }
    throw error;
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.eRPIntegration.updateMany({
      // Tenant E estado esperado. O `companyId` vem da sessão de quem chamou, e
      // o `provider` é o que foi lido acima — juntos, impedem tanto alcançar
      // outra empresa quanto sobrescrever uma troca concorrente.
      where: { companyId, provider: current.provider },
      data: {
        provider,
        /**
         * `baseUrl` e `config` pertenciam ao provider ANTERIOR, e são limpos.
         *
         * `resolveCompanyAdapter` usa `baseUrl` como SOBREPOSIÇÃO do host, e
         * sair do SGP sem limpar deixaria o host dele numa linha que passou a
         * descrever outro ERP.
         *
         * **O token não vazaria por isso** — o `ReceitanetCallCenterClient` tem
         * allowlist EXATA de host e recusa qualquer outro antes de qualquer
         * requisição. O que acontecia sem esta limpeza era pior de diagnosticar
         * do que perigoso: voltar para o ReceitaNet **falhava**, e falhava com
         * "não foi possível autenticar" — mandando o operador trocar um token
         * que estava perfeito, quando o problema era um host herdado. Limpar é
         * o que torna o rollback possível.
         *
         * Um provider que precise de configuração própria não chega aqui (ver
         * a recusa acima), então nunca se limpa algo que este caminho deveria
         * ter preenchido.
         */
        baseUrl: null,
        // `JsonNull` e não `null`: Prisma distingue "apagar o campo" de "gravar
        // o valor JSON null", e só o primeiro é o que se quer aqui.
        config: Prisma.JsonNull,
      },
    });

    if (updated.count === 0) {
      throw conflict(
        "O ERP ativo foi alterado por outra operação. Recarregue e tente novamente.",
      );
    }

    await logAuditWithin(tx, {
      companyId,
      userId: actorUserId,
      action: "ERP.ACTIVE_PROVIDER_CHANGED",
      entity: "ERPIntegration",
      entityId: current.id,
      // Origem e destino, e nada mais. Nunca token, ciphertext, IV, tag, last4
      // ou qualquer campo de credencial.
      details: `ERP ativo alterado de ${current.provider} para ${provider}`,
    });

    return { fromProvider: current.provider, toProvider: provider };
  });
}
