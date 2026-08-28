import { NextResponse } from "next/server";
import { DomainError } from "@/lib/errors";
import { CompletionBlockedError } from "@/lib/service-order-completion";
import {
  FieldError,
  fieldCodeForStatus,
  fieldErrorBody,
  fieldErrorStatus,
  type FieldErrorCode,
} from "./errors";

export function fieldOk(data: unknown, status = 200): NextResponse {
  return NextResponse.json({ ok: true, data }, { status });
}

export function fieldFail(
  code: FieldErrorCode,
  message: string,
  extra?: { retryAfterSeconds?: number },
): NextResponse {
  const response = NextResponse.json(
    { ok: false, error: fieldErrorBody(code, message) },
    { status: fieldErrorStatus(code) },
  );
  if (extra?.retryAfterSeconds !== undefined) {
    response.headers.set("Retry-After", String(extra.retryAfterSeconds));
  }
  return response;
}

/**
 * Envelope de erro das rotas do Field.
 *
 * Espelha o `runApi` da web e existe pelo mesmo motivo: nenhum handler decide
 * sozinho o que vaza numa falha. A diferença é a tradução para o código
 * estável — e o fato de um erro inesperado NUNCA carregar a mensagem original
 * para o aparelho. Stack trace, SQL e detalhe de Prisma ficam no log do
 * servidor; o app recebe `INTERNAL` e uma frase genérica.
 */
export async function runFieldApi(
  handler: () => Promise<Response>,
): Promise<Response> {
  try {
    return await handler();
  } catch (error) {
    /*
      Pendências de conclusão saem ESTRUTURADAS.

      É a única recusa cujo corpo carrega mais que uma frase, e por um motivo
      concreto: com uma lista de códigos o aplicativo leva o técnico direto ao
      item que falta; com um texto, ele procura (PRD §166). O `code` continua
      sendo `VALIDATION_ERROR`, então um aplicativo que ignore `pendencies` se
      comporta exatamente como antes — a lista é aditiva ao contrato.
    */
    if (error instanceof CompletionBlockedError) {
      return NextResponse.json(
        {
          ok: false,
          error: {
            ...fieldErrorBody("VALIDATION_ERROR", error.message),
            pendencies: error.pendencies,
          },
        },
        { status: fieldErrorStatus("VALIDATION_ERROR") },
      );
    }
    if (error instanceof FieldError) {
      return fieldFail(error.code, error.message);
    }
    if (error instanceof DomainError) {
      return fieldFail(fieldCodeForStatus(error.status), error.message);
    }
    const message = error instanceof Error ? error.message : "Erro desconhecido";
    console.error("[field:error]", message);
    return fieldFail("INTERNAL", "Erro interno do servidor.");
  }
}

/**
 * Resposta que não pode ser guardada em lugar nenhum.
 *
 * Usada onde o corpo carrega segredo revelado sob demanda. Mesmo tratamento
 * que a rota web de senha de conexão já aplica — repetido aqui porque o
 * cliente móvel tem uma camada de cache a mais que o navegador (a do próprio
 * app) e nenhuma delas pode reexibir o valor.
 */
export function noStore(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", "no-store, no-cache, must-revalidate");
  response.headers.set("Pragma", "no-cache");
  return response;
}
