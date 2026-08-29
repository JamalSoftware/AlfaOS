import type { z } from "zod";
import { assertCanExecute, type FieldPrincipal } from "./auth";
import { parseIdempotencyKey, withIdempotency } from "./idempotency";
import { fieldOk, runFieldApi } from "./response";
import { readFieldBody, requireFieldPrincipal } from "./route";

/**
 * # Comando mutante do Field
 *
 * Todo comando da v0.10 executa a MESMA sequência, e a ordem dela é uma
 * propriedade de segurança, não estilo:
 *
 * ```text
 * autenticar  →  elegibilidade  →  Idempotency-Key  →  corpo  →  dedup  →  domínio
 * ```
 *
 * - **elegibilidade antes da desduplicação** para que um técnico inelegível não
 *   consiga sequer RESERVAR uma chave. Invertido, ele gravaria uma reserva que
 *   depois bloquearia a chave legítima do próprio aparelho.
 * - **chave antes do corpo** para que uma requisição sem cabeçalho seja
 *   recusada antes de qualquer trabalho.
 * - **domínio por último**, e é ele quem valida posse, estado e CAS.
 *
 * A v0.9 escrevia essa sequência à mão em cada rota, o que estava certo quando
 * eram quatro. São dezesseis agora, e a décima sexta é a que erraria a ordem.
 * Aqui ela existe uma vez.
 *
 * **Nenhuma regra de negócio vive neste arquivo nem nas rotas que o usam.** A
 * rota autentica, desduplica e chama o serviço — o mesmo serviço que a web
 * chama. Reimplementar qualquer transição para o Field criaria duas verdades, e
 * a segunda a divergir seria a que ninguém revisou.
 */

export interface FieldCommandResult<T> {
  /** Padrão 200. `201` quando o comando cria recurso novo. */
  status?: number;
  body: T;
  resourceId?: string | null;
}

export interface FieldCommandContext<B> {
  principal: FieldPrincipal;
  body: B;
  /** `params.id` da rota — a OS. Nunca vem do corpo. */
  orderId: string;
}

/**
 * Monta o handler de um comando mutante sobre uma OS.
 *
 * `clientMutationId` é DELIBERADAMENTE excluído da impressão digital da
 * idempotência e apenas ecoado na resposta — mesma escolha que a rota `start`
 * já fazia. Ele correlaciona a fila local do aplicativo (PRD §159); incluí-lo
 * faria uma retentativa que regenerou o correlacionador ser lida como "mesma
 * chave, conteúdo diferente" e receber `IDEMPOTENCY_CONFLICT` — travando
 * exatamente a operação que o aplicativo precisa reenviar.
 */
export interface FieldPlainCommandContext<B> {
  principal: FieldPrincipal;
  body: B;
}

/**
 * Comando mutante que NÃO é sobre uma OS.
 *
 * Mesma sequência do `fieldOrderCommand` — autenticar, elegibilidade, chave,
 * corpo, dedup, domínio —, sem o `orderId`. Nasceu com a jornada (PRD §226):
 * bater ponto é comando do FUNCIONÁRIO, não de um atendimento, e forçá-lo a
 * carregar um id de OS falso só para reusar o wrapper seria mentir sobre o que
 * a operação é.
 *
 * A impressão digital da idempotência não tem âncora de recurso, então ela é o
 * corpo mais a operação. Para a batida isso basta: o que a torna única é o
 * `Idempotency-Key` que o aplicativo cria **no toque** (§232).
 */
export function fieldCommand<S extends z.ZodTypeAny, T>(
  operation: string,
  schema: S,
  handler: (
    context: FieldPlainCommandContext<z.infer<S>>,
  ) => Promise<FieldCommandResult<T>>,
) {
  return async (request: Request) =>
    runFieldApi(async () => {
      const principal = await requireFieldPrincipal(request);
      assertCanExecute(principal);

      const key = parseIdempotencyKey(request);
      const body = (await readFieldBody(request, schema)) as z.infer<S> & {
        clientMutationId?: string;
      };

      const { clientMutationId, ...fingerprintBody } = body;

      const outcome = await withIdempotency(
        principal,
        operation,
        key,
        fingerprintBody,
        async () => {
          const result = await handler({ principal, body });
          return {
            status: result.status ?? 200,
            resourceId: result.resourceId ?? null,
            body: {
              ...(result.body as Record<string, unknown>),
              ...(clientMutationId ? { clientMutationId } : {}),
            } as T,
          };
        },
      );

      return fieldOk(outcome.body, outcome.status);
    });
}

export function fieldOrderCommand<S extends z.ZodTypeAny, T>(
  operation: string,
  schema: S,
  handler: (
    context: FieldCommandContext<z.infer<S>>,
  ) => Promise<FieldCommandResult<T>>,
) {
  return async (request: Request, context: { params: { id: string } }) =>
    runFieldApi(async () => {
      const principal = await requireFieldPrincipal(request);
      assertCanExecute(principal);

      const key = parseIdempotencyKey(request);
      const body = (await readFieldBody(request, schema)) as z.infer<S> & {
        clientMutationId?: string;
      };
      const orderId = context.params.id;

      const { clientMutationId, ...fingerprintBody } = body;

      const outcome = await withIdempotency(
        principal,
        operation,
        key,
        { orderId, ...fingerprintBody },
        async () => {
          const result = await handler({ principal, body, orderId });
          return {
            status: result.status ?? 200,
            resourceId: result.resourceId ?? orderId,
            body: {
              ...(result.body as Record<string, unknown>),
              ...(clientMutationId ? { clientMutationId } : {}),
            } as T,
          };
        },
      );

      return fieldOk(outcome.body, outcome.status);
    });
}
