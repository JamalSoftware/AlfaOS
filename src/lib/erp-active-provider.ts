import type { ERPProvider } from "@prisma/client";
import { prisma } from "./prisma";

/**
 * # Qual ERP está ATIVO agora (`SEC-008`)
 *
 * ## O achado
 *
 * A revisão de segurança independente encontrou uma leitura operacional
 * escolhendo o adapter por `Customer.externalProvider` — e esse campo é
 * **histórico, não seleção**. A regra do produto é explícita: uma OS importada
 * do ReceitaNet continua ReceitaNet depois da troca de ERP, porque o campo
 * registra DE ONDE o dado veio. Nenhum registro é convertido.
 *
 * A consequência é que uma empresa que migrou para outro ERP continuava
 * mandando dado operacional de cliente para o provider **desativado**, usando
 * a credencial que a troca preserva de propósito (ociosa, cifrada, guardada
 * para permitir rollback). O dado ia para o sistema de onde a empresa saiu.
 *
 * ## Uma autoridade, e por que ela é um módulo à parte
 *
 * A pergunta *"qual ERP está ativo?"* tinha **quatro** implementações — o
 * diagnóstico, a busca de cliente, a sincronização e o contexto operacional —
 * e a quarta estava errada. Quatro cópias de uma regra de autorização é uma
 * cópia que alguém esquece de conferir.
 *
 * Este arquivo importa **só o Prisma**, de propósito. Pôr a função em
 * `erp-integration.ts` arrastaria `erp-provisioning` e, com ele,
 * `safe-outbound-url` e `node:dns`, para dentro de todo módulo que precisasse
 * responder a pergunta — e o projeto já pagou por isso uma vez, quando um
 * componente de cliente alcançou `node:crypto` e derrubou a tela de login
 * inteira (`DQ-4`).
 *
 * ## O que esta função NÃO faz
 *
 * Não apaga nem converte identidade externa (`SEC-008`/§33): `externalProvider`
 * e `externalId` continuam onde estão, e a credencial do provider anterior
 * continua cifrada e ociosa. O que muda é só uma coisa — **chamada ao vivo não
 * sai para provider desativado**.
 */

/**
 * O provider ativo da empresa, ou `null` quando não há ERP configurado ou a
 * integração está desabilitada.
 *
 * `null` é um estado legítimo, não um erro: empresa sem ERP é o caso comum, e
 * quem chama decide se isso é "nada a mostrar" ou "operação indisponível".
 */
export async function resolveActiveErpProvider(
  companyId: string,
): Promise<ERPProvider | null> {
  const integration = await prisma.eRPIntegration.findFirst({
    where: { companyId },
    select: { provider: true, enabled: true },
  });
  if (!integration || !integration.enabled) return null;
  return integration.provider;
}

/**
 * O provider está ativo E é o que este registro histórico aponta?
 *
 * É a pergunta que uma leitura operacional precisa fazer antes de chamar o
 * ERP: o `externalId` guardado só tem significado DENTRO do provider que o
 * emitiu, então consultar um id do ReceitaNet num SGP ativo não devolveria a
 * pessoa errada — devolveria coisa nenhuma, depois de vazar a consulta para
 * fora. Divergência entre o histórico e o ativo significa *este cliente não
 * está vinculado ao ERP atual*, e o lugar de resolver isso é reimportando o
 * cliente, não chamando o sistema antigo.
 */
export function matchesActiveProvider(
  active: ERPProvider | null,
  historical: string | null,
): boolean {
  return active !== null && historical === active;
}
