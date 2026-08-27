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
import { getFieldServiceOrder } from "@/lib/field/service-orders";

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
          Reprojeta para o DTO do Field.

          `startServiceOrder` devolve o `PublicServiceOrder` da web, que carrega
          `customer.document` — o CPF. Devolvê-lo ao aplicativo colocaria CPF no
          cache de um aparelho que anda pela rua, por uma tela que não usa o
          campo. A releitura custa uma consulta e elimina a classe inteira de
          vazamento por reaproveitamento de DTO.
        */
        const serviceOrder = await getFieldServiceOrder(
          principal.user.companyId,
          principal.technician.id,
          orderId,
        );

        return {
          status: 200,
          resourceId: orderId,
          body: {
            serviceOrder,
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
