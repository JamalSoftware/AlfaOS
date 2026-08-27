import { ERPProvider } from "@prisma/client";
import { isIntegrationError } from "@/integrations/errors";
import { supportsServiceTickets } from "@/integrations/service-tickets";
import { resolveCompanyAdapter } from "./erp-adapter";
import { logAudit } from "./audit";
import { badRequest, notFound } from "./errors";
import { prisma } from "./prisma";
import { importServiceOrderForCustomer } from "./service-orders";

/**
 * Sincronização de Ordens de Serviço do ReceitaNet, **por cliente conhecido**.
 *
 * ## O que esta versão deliberadamente NÃO é
 *
 * Não é descoberta global. O suporte do ReceitaNet confirmou que não existe
 * API pública para listar as OS da empresa — é limitação do provider, não
 * dívida do AlfaOS (`docs/PRD.md` §141). Varrer ids, chamar `/v1/chamados` sem
 * `idCliente` ou explorar rota não homologada continua proibido (§64).
 *
 * O caminho é sempre o mesmo, e começa dentro do AlfaOS:
 *
 * ```text
 * Customer conhecido → externalId do provider → POST /v1/chamados
 *   → até 10 chamados ABERTOS daquele cliente → ServiceOrder EXTERNAL
 * ```
 *
 * ## Direção única
 *
 * Leitura para dentro. Nada aqui abre, altera ou fecha chamado no ReceitaNet —
 * nenhuma rota mutante do provider é chamada. Depois de importada, **a
 * execução é do AlfaOS**: o provider é a origem do chamado, não a autoridade
 * sobre o atendimento (`docs/PRD.md` §121).
 */

/** Desfecho de uma sincronização. Nada do provider atravessa cru. */
export interface ReceitanetOrderSyncResult {
  /** Quantos chamados abertos o provider devolveu. */
  fetched: number;
  created: number;
  updated: number;
  /**
   * Já existiam e o provider não trouxe nada diferente.
   *
   * Separado de `updated` porque são desfechos distintos: "atualizada" diz que
   * o chamado mudou do lado de lá, "sem alteração" diz que a consulta
   * confirmou o que já estava gravado. Somar os dois fazia a tela relatar
   * atualização em toda sincronização, inclusive quando nenhuma linha foi
   * escrita (SYNC-03).
   */
  unchanged: number;
  /**
   * O provider devolveu exatamente o teto declarado.
   *
   * `/v1/chamados` limita a 10 e **não pagina**. Com 10 na resposta não há
   * como saber se são todos ou os dez primeiros de catorze — e afirmar
   * "sincronizado" nesse caso seria afirmar o que ninguém verificou.
   *
   * Com menos que o teto, a lista está aparentemente completa. É o mais forte
   * que se pode dizer: o provider também não promete ordenação estável.
   */
  possiblyTruncated: boolean;
}

/**
 * Rótulo do tipo para uma OS importada do ReceitaNet.
 *
 * O contrato declara `tipo` como inteiro e **não publica** o significado de
 * cada valor. Traduzir para "Instalação" ou "Manutenção" produziria uma tela
 * que parece informada e mente — e é o técnico que sairia para o endereço
 * errado com a expectativa errada.
 *
 * **O código cru NÃO é persistido.** O normalizador o expõe como `typeCode`, e
 * esta versão simplesmente não o usa: guardá-lo exigiria coluna ou metadata
 * novos para um valor sem semântica homologada, e dado que ninguém sabe ler
 * não fica melhor por estar salvo. Um mapeamento de verdade depende de o
 * ReceitaNet publicar a tabela, e a pergunta já está aberta com o suporte
 * (`docs/RECEITANET-HOMOLOGATION.md`).
 *
 * Uma versão anterior deste comentário afirmava que o código ia para o metadata
 * do evento. Não ia — a auditoria da v0.8 registrou a divergência (SYNC-02).
 */
const IMPORTED_TYPE_LABEL = "Chamado ReceitaNet";

export async function syncReceitaNetServiceOrdersForCustomer(
  companyId: string,
  actorUserId: string,
  customerId: string,
): Promise<ReceitanetOrderSyncResult> {
  /*
    Tenant em SQL, e o `companyId` vem SEMPRE da sessão de quem chama — nunca
    do corpo da requisição. É o que impede sincronizar o cliente de outra
    empresa anexando um id.
  */
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, companyId },
    select: { id: true, externalProvider: true, externalId: true },
  });
  if (!customer) {
    throw notFound("Cliente não encontrado.");
  }

  /*
    Sem vínculo com o ReceitaNet não há `idCliente` para consultar, e inventar
    um seria pedir chamados de outra pessoa. O erro nomeia o que falta, em vez
    de devolver uma lista vazia que o operador leria como "não há chamados".
  */
  if (
    customer.externalProvider !== ERPProvider.RECEITANET ||
    !customer.externalId
  ) {
    throw badRequest(
      "Este cliente não está vinculado ao ReceitaNet. Importe-o do ERP antes de sincronizar as ordens de serviço.",
    );
  }

  let adapter;
  try {
    adapter = await resolveCompanyAdapter(companyId, ERPProvider.RECEITANET);
  } catch (error) {
    // Credencial ausente e provider indisponível são coisas diferentes, e o
    // operador precisa saber qual das duas aconteceu.
    throw badRequest(
      isIntegrationError(error)
        ? error.userMessage
        : "Não foi possível iniciar a integração com o ReceitaNet.",
    );
  }

  if (!supportsServiceTickets(adapter)) {
    throw badRequest(
      "O provider configurado não suporta leitura de chamados.",
    );
  }

  /*
    Uma falha aqui é do PROVIDER, e a mensagem já vem do catálogo fechado de
    `IntegrationError` — nunca do corpo da resposta dele. Zero chamados NÃO
    entra por este caminho: `listOpenTickets` já trata `success:false` de
    `/v1/chamados` como lista vazia, que é o que o contrato significa ali.
  */
  let result;
  try {
    result = await adapter.listOpenTickets(customer.externalId);
  } catch (error) {
    throw badRequest(
      isIntegrationError(error)
        ? error.userMessage
        : "Não foi possível consultar os chamados no ReceitaNet.",
    );
  }

  let created = 0;
  let updated = 0;
  let unchanged = 0;

  for (const ticket of result.tickets) {
    const outcome = await importServiceOrderForCustomer(
      companyId,
      actorUserId,
      customer.id,
      {
        externalProvider: ERPProvider.RECEITANET,
        // `idSuporte` — identidade TÉCNICA do chamado no provider. Nunca vira
        // número local: esse continua sendo alocado pelo AlfaOS.
        externalId: ticket.externalId,
        // `numero` — o número que o cliente e o atendente do provedor citam.
        externalNumber: ticket.externalNumber ?? undefined,
        type: IMPORTED_TYPE_LABEL,
        /*
          `descricao` é texto do provider e fica como texto. React escapa na
          renderização; nada de `dangerouslySetInnerHTML`.

          O "Contato:" que às vezes aparece no corpo NÃO é promovido a
          `Customer.phone`: é o contato daquele atendimento, não o telefone
          mestre do cadastro, e a homologação mostrou que a convenção não é
          confiável.
        */
        description: ticket.description?.trim() || "Chamado sem descrição.",
        priority: "NORMAL",
        /*
          `data_previsao` NÃO vira `scheduledAt`.

          `scheduledAt` é compromisso combinado com o cliente, e alimenta
          agenda e despacho. Previsão do provider é outra coisa, chega como
          texto não homologado, e transformá-la em agendamento faria o quadro
          exibir horários que ninguém marcou.

          Como o `tipo`, ela também NÃO é persistida — o normalizador a expõe
          em `forecast` e esta versão não a usa. O comentário anterior dizia que
          ficava no metadata do evento, e não ficava (SYNC-02).
        */
        scheduledAt: null,
      },
    );
    if (outcome.created) created += 1;
    else if (outcome.changed) updated += 1;
    else unchanged += 1;
  }

  /*
    Auditoria com CONTAGEM, não com conteúdo. Descrição do chamado, telefone
    de contato e resposta bruta do provider não entram aqui — o AuditLog é
    consultado por gente que investiga acesso, não por quem precisa do texto.
  */
  await logAudit({
    companyId,
    userId: actorUserId,
    action: "SERVICE_ORDER.RECEITANET_SYNC",
    entity: "Customer",
    entityId: customer.id,
    details: `Sync ReceitaNet: ${result.tickets.length} recebidos, ${created} criadas, ${updated} atualizadas, ${unchanged} sem alteração`,
  });

  return {
    fetched: result.tickets.length,
    created,
    updated,
    unchanged,
    possiblyTruncated:
      result.cap !== null && result.tickets.length >= result.cap,
  };
}
