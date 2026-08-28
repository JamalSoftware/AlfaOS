import { z } from "zod";
import { getFieldExecutionBundle } from "@/lib/field/execution";
import { assertCanExecute } from "@/lib/field/auth";
import { parseIdempotencyKey, withIdempotency } from "@/lib/field/idempotency";
import { fieldOk, runFieldApi } from "@/lib/field/response";
import {
  clientMutationId,
  fieldExpectedVersion,
  readFieldBody,
  requireFieldPrincipal,
} from "@/lib/field/route";
import {
  EXECUTION_TEXT_MAX_LENGTH,
  updateServiceOrderExecution,
} from "@/lib/service-orders";

/** Rota autenticada por Bearer: nunca estática. Ver `notifications/route.ts`. */
export const dynamic = "force-dynamic";

/**
 * `GET /api/field/v1/service-orders/:id/execution`
 *
 * Tudo que a tela de execução mostra, numa leitura só.
 *
 * Leitura NÃO exige `assertCanExecute`: um técnico desativado continua
 * consultando o que já tinha e só perde a capacidade de mexer. É a mesma porta
 * que o resto do Field usa desde a v0.9 — leitura e escrita têm regras
 * diferentes de propósito.
 */
export async function GET(
  request: Request,
  context: { params: { id: string } },
) {
  return runFieldApi(async () => {
    const principal = await requireFieldPrincipal(request);
    const bundle = await getFieldExecutionBundle(
      principal.user.companyId,
      principal.technician.id,
      context.params.id,
    );
    return fieldOk(bundle);
  });
}

/**
 * `POST /api/field/v1/service-orders/:id/execution`
 *
 * Salva diagnóstico, serviço realizado e observações.
 *
 * ## Sem isto o Field não conclui NADA
 *
 * `validateServiceOrderCompletion` exige diagnóstico e serviço realizado desde
 * a v0.4, e são os únicos requisitos que valem para toda OS, com ou sem
 * política. Sem uma rota que os preencha, o aplicativo montaria a tela inteira,
 * anexaria foto, baixaria material, colheria assinatura — e receberia
 * `EXECUTION_DIAGNOSIS_REQUIRED` para sempre. A lacuna apareceu ao montar a
 * seção "Observações" da tela de execução.
 *
 * ## `expectedVersion` aqui é o da EXECUÇÃO
 *
 * Não o da OS, e a diferença é a razão de as duas linhas terem locks separados:
 * um despachante tocando a OS não pode invalidar o parágrafo que o técnico está
 * digitando, e salvar o parágrafo não pode invalidar uma foto em envio.
 *
 * Nenhum dos três campos é obrigatório AQUI — só no fechamento. Durante o
 * atendimento o técnico salva o que tem até agora, possivelmente várias vezes.
 */
const reportSchema = z
  .object({
    expectedVersion: fieldExpectedVersion,
    diagnosis: z.string().max(EXECUTION_TEXT_MAX_LENGTH).nullable().optional(),
    workPerformed: z
      .string()
      .max(EXECUTION_TEXT_MAX_LENGTH)
      .nullable()
      .optional(),
    notes: z.string().max(EXECUTION_TEXT_MAX_LENGTH).nullable().optional(),
    clientMutationId,
  })
  .strict();

export async function POST(
  request: Request,
  context: { params: { id: string } },
) {
  return runFieldApi(async () => {
    const principal = await requireFieldPrincipal(request);
    assertCanExecute(principal);

    const key = parseIdempotencyKey(request);
    const body = await readFieldBody(request, reportSchema);
    const orderId = context.params.id;

    const outcome = await withIdempotency(
      principal,
      "service-order.execution.save",
      key,
      {
        orderId,
        expectedVersion: body.expectedVersion,
        diagnosis: body.diagnosis ?? null,
        workPerformed: body.workPerformed ?? null,
        notes: body.notes ?? null,
      },
      async () => {
        const execution = await updateServiceOrderExecution(
          principal.user.companyId,
          principal.user.id,
          orderId,
          body.expectedVersion,
          {
            diagnosis: body.diagnosis,
            workPerformed: body.workPerformed,
            notes: body.notes,
          },
        );

        return {
          status: 200,
          resourceId: execution.id,
          body: {
            execution: {
              id: execution.id,
              diagnosis: execution.diagnosis,
              workPerformed: execution.workPerformed,
              notes: execution.notes,
              version: execution.version,
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
