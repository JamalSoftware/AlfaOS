import { z } from "zod";
import { startServiceOrder } from "@/lib/service-orders";
import { assertCanExecute } from "@/lib/field/auth";
import { fieldOk, runFieldApi } from "@/lib/field/response";
import {
  clientMutationId,
  fieldExpectedVersion,
  readFieldBody,
  requireFieldPrincipal,
} from "@/lib/field/route";
import { parseIdempotencyKey, withIdempotency } from "@/lib/field/idempotency";

/**
 * `POST /api/field/v1/service-orders/:id/start`
 *
 * ASSIGNED → IN_PROGRESS.
 *
 * **Nenhuma regra de negócio vive aqui.** A rota autentica, desduplica e
 * chama `startServiceOrder` — exatamente o mesmo serviço que a rota da web
 * chama. Máquina de estados, posse, elegibilidade, compare-and-set, evento de
 * timeline e auditoria acontecem lá dentro, uma vez só.
 *
 * Reimplementar a transição para o Field criaria duas verdades sobre quando uma
 * OS pode começar, e a segunda a divergir seria a que ninguém revisou.
 *
 * ## As duas proteções, e por que são duas
 *
 * - **`Idempotency-Key`** cobre a REPETIÇÃO: a internet voltou e o aplicativo
 *   reenviou a operação que estava na fila local. Sem ela, a segunda tentativa
 *   receberia um 409 ("já está em atendimento") que o app leria como falha,
 *   quando na verdade deu certo da primeira vez.
 * - **`expectedVersion`** cobre a DIVERGÊNCIA: alguém mexeu na OS enquanto o
 *   técnico estava sem rede. Aí o 409 é a resposta certa e `conflict: true`
 *   manda o app recarregar em vez de reenviar.
 *
 * Uma não substitui a outra. A primeira responde "isto já aconteceu?"; a
 * segunda, "o mundo ainda é o que eu vi?".
 */

const startSchema = z
  .object({
    expectedVersion: fieldExpectedVersion,
    clientMutationId,
  })
  .strict();

export async function POST(
  request: Request,
  context: { params: { id: string } },
) {
  return runFieldApi(async () => {
    const principal = await requireFieldPrincipal(request);
    // Elegibilidade antes de qualquer escrita — e antes da desduplicação, para
    // que um técnico inelegível não consiga sequer reservar uma chave.
    assertCanExecute(principal);

    const key = parseIdempotencyKey(request);
    const body = await readFieldBody(request, startSchema);
    const orderId = context.params.id;

    const outcome = await withIdempotency(
      principal,
      "service-order.start",
      key,
      { orderId, expectedVersion: body.expectedVersion },
      async () => {
        const result = await startServiceOrder(
          principal.user.companyId,
          principal.user.id,
          orderId,
          body.expectedVersion,
        );

        /*
          A resposta sai do RESULTADO da mutação, não de uma releitura.

          Antes havia um `getFieldServiceOrder` aqui, e ele abria uma janela
          real: a transação commitava, o despachante reatribuía a OS a outro
          técnico, e a releitura — que filtra por posse — devolvia 404. O
          aplicativo recebia "não encontrado" para uma operação que **tinha
          acontecido**, e a fila local marcaria como falha algo que deu certo.

          Reler também reabria a autorização depois do commit, o que é o erro
          conceitual por trás disso: quem já foi autorizado a executar não
          precisa ser autorizado de novo para saber o que executou.

          O corpo é MÍNIMO de propósito (PRD §41 da tarefa de hardening): o que
          mudou e o token do próximo compare-and-set. Nada de cliente, endereço
          ou conexão — o aplicativo já tem o detalhe, e projetar o
          `PublicServiceOrder` inteiro traria `customer.document`, o CPF, de
          volta para o cache de um aparelho que anda pela rua.
        */
        const os = result.serviceOrder;

        return {
          status: 200,
          resourceId: orderId,
          body: {
            serviceOrder: {
              id: os.id,
              number: os.number,
              status: os.status,
              priority: os.priority,
              startedAt: os.startedAt?.toISOString() ?? null,
              updatedAt: os.updatedAt.toISOString(),
              version: os.version,
            },
            execution: {
              id: result.execution.id,
              diagnosis: result.execution.diagnosis,
              workPerformed: result.execution.workPerformed,
              notes: result.execution.notes,
              version: result.execution.version,
            },
            ...(body.clientMutationId
              ? { clientMutationId: body.clientMutationId }
              : {}),
          },
        };
      },
    );

    return fieldOk(outcome.body, outcome.status);
  });
}
