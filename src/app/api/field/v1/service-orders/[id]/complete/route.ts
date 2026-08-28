import { z } from "zod";
import { fieldOrderCommand } from "@/lib/field/command";
import { clientMutationId, fieldExpectedVersion } from "@/lib/field/route";
import { completeServiceOrder } from "@/lib/service-order-closing";

/**
 * `POST /api/field/v1/service-orders/:id/complete`
 *
 * `IN_PROGRESS → COMPLETED`, executado pelo técnico dono.
 *
 * **Nenhuma regra de negócio vive aqui.** A rota autentica, desduplica e chama
 * `completeServiceOrder` — o MESMO serviço que a rota da web chama. Validação
 * de pendências, dupla verificação otimista, transação, snapshot de fechamento,
 * evento de timeline e auditoria acontecem lá dentro, uma vez só.
 *
 * ## Dois `expectedVersion`, e são mesmo dois
 *
 * - `expectedVersion` é o da OS: arbitra `concluir × concluir` e
 *   `concluir × mutação-filha`, já que toda escrita filha incrementa a mesma
 *   versão.
 * - `expectedExecutionVersion` é o da EXECUÇÃO: sem ele, um técnico numa
 *   segunda tela salvaria texto novo um milissegundo antes do fechamento, e a
 *   OS seria selada em torno de um conteúdo que o autor do fechamento nunca
 *   revisou.
 *
 * Colapsá-los num só faria um despachante mexendo na OS invalidar o parágrafo
 * que o técnico está digitando.
 *
 * ## Pendências voltam estruturadas
 *
 * Uma recusa por requisitos não atendidos sai com `code: VALIDATION_ERROR` e um
 * campo `pendencies` — lista de códigos estáveis que o aplicativo usa para levar
 * o técnico direto ao item que falta (PRD §166). Ver `runFieldApi`.
 *
 * ## Idempotência e CAS não se substituem
 *
 * A `Idempotency-Key` responde "isto já aconteceu?" — a internet voltou e o
 * aplicativo reenviou a conclusão que estava na fila local. O `expectedVersion`
 * responde "o mundo ainda é o que eu vi?" — alguém mexeu na OS enquanto o
 * técnico estava sem rede. A primeira evita uma segunda conclusão; a segunda
 * evita selar uma OS que mudou.
 */
const schema = z
  .object({
    expectedVersion: fieldExpectedVersion,
    expectedExecutionVersion: fieldExpectedVersion,
    clientMutationId,
  })
  .strict();

export const POST = fieldOrderCommand(
  "service-order.complete",
  schema,
  async ({ principal, body, orderId }) => {
    await completeServiceOrder(
      principal.user.companyId,
      principal.user.id,
      orderId,
      {
        expectedOrderVersion: body.expectedVersion,
        expectedExecutionVersion: body.expectedExecutionVersion,
      },
    );

    /*
      Corpo MÍNIMO, e vindo do que acabou de acontecer — não de uma releitura.

      Reler depois do commit reabriria a autorização (a consulta filtra por
      posse) e devolveria 404 se a OS fosse reatribuída no intervalo: o
      aplicativo receberia "não encontrado" para uma operação que ACONTECEU, e
      marcaria como falha algo que deu certo. Foi o defeito START-01 da v0.9.
    */
    return {
      body: {
        serviceOrder: {
          id: orderId,
          status: "COMPLETED" as const,
        },
      },
    };
  },
);
