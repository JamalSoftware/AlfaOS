import { conflict } from "./errors";
import {
  loadOwnedServiceOrder,
  resolveActingTechnician,
  type ExecutionTx,
} from "./service-orders";

/**
 * # Preâmbulo compartilhado das mutações-filhas da OS
 *
 * Toda escrita que pendura algo numa OS — evidência, material, equipamento,
 * assinatura, resposta de checklist, impedimento — passa por estas duas
 * funções, nesta ordem, dentro da mesma transação da escrita.
 *
 * Estava dentro de `service-order-closing.ts` desde a v0.4. Foi extraído na
 * v0.10 porque deixou de ser "o preâmbulo do fechamento" e passou a ser o
 * preâmbulo de sete comandos em quatro arquivos. Copiá-lo seria criar sete
 * versões da mesma regra de posse, e a primeira a divergir seria a que ninguém
 * revisou.
 */

/**
 * Prova quem está agindo, prova que ele é dono da OS, e recusa qualquer coisa
 * que não esteja em andamento.
 *
 * A mensagem distingue "já concluída" de "nunca começou" porque as duas exigem
 * ações diferentes do técnico, e um erro genérico o deixaria tentando de novo
 * um comando que nunca vai passar.
 */
export async function loadInProgressOwnedOrder(
  tx: ExecutionTx,
  companyId: string,
  actorUserId: string,
  orderId: string,
) {
  const technician = await resolveActingTechnician(tx, companyId, actorUserId);
  const order = await loadOwnedServiceOrder(
    tx,
    companyId,
    technician.id,
    orderId,
  );
  if (order.status !== "IN_PROGRESS") {
    throw conflict(
      order.status === "COMPLETED"
        ? "Esta OS já foi concluída e não pode mais ser alterada."
        : "Só é possível alterar o atendimento de uma OS em andamento.",
    );
  }
  return { technician, order };
}

/**
 * Reivindica a OS para uma mutação de um dos seus filhos.
 *
 * Compare-and-set em `status = IN_PROGRESS AND version = expectedOrderVersion`,
 * incrementando a versão.
 *
 * Esse único UPDATE é o que torna `mutação-filha × conclusão` determinístico.
 * Os dois disputam o MESMO lock de linha: quem commitar primeiro incrementa a
 * versão, e o predicado do perdedor deixa de casar — então ele recebe 409 em
 * vez de anexar uma foto a uma OS que acabou de fechar. Conferir
 * `status === "IN_PROGRESS"` em código de aplicação antes do insert NÃO faz
 * isso: entre a conferência e o insert, a OS fecha.
 *
 * Também é o que dá ao aplicativo um `version` novo a cada escrita, que é o
 * token do próximo compare-and-set.
 */
export async function claimOrderForChildMutation(
  tx: ExecutionTx,
  companyId: string,
  orderId: string,
  expectedOrderVersion: number,
): Promise<void> {
  const claimed = await tx.serviceOrder.updateMany({
    where: {
      id: orderId,
      companyId,
      status: "IN_PROGRESS",
      version: expectedOrderVersion,
    },
    data: { version: { increment: 1 } },
  });
  if (claimed.count !== 1) {
    throw conflict(
      "A OS foi modificada ou finalizada por outra requisição. Recarregue e tente novamente.",
    );
  }
}
