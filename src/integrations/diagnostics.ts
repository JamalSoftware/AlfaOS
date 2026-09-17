import type { ConnectivityStatus } from "@prisma/client";
import { IntegrationError } from "./errors";

/**
 * Diagnostics capability — kept OUT of `ERPIntegrationContract` on purpose.
 *
 * The base contract is what every adapter must implement (identity, connection
 * test). Diagnostics is something a provider may or may not offer, so folding
 * it in would either force every adapter to stub it or grow the base interface
 * into a grab-bag of unrelated optional methods. A separate capability lets
 * `supportsDiagnostics()` answer "can this provider do it?" honestly, and lets
 * the ReceitaNet adapter declare the capability while refusing every call —
 * which is exactly its real state today.
 */

/** What the caller knows about the customer, in provider-neutral terms. */
export interface ERPCustomerRef {
  /** The provider's own id for this customer, when AlfaOS has one. */
  externalId: string | null;
  document: string | null;
  name: string;
}

/**
 * A provider's answer about connectivity, before it is persisted.
 *
 * `status` is the classification; `sourceUpdatedAt` is only set when the
 * provider actually reports when the state last changed. Adapters must not
 * invent it from the response time — that would make an ordering signal out of
 * a value that carries no ordering information.
 */
export interface ERPConnectivityObservation {
  status: ConnectivityStatus;
  sourceUpdatedAt: Date | null;
  /**
   * Contexto adicional que alguns providers oferecem junto do estado.
   *
   * OPCIONAIS de propósito, e por duas razões: nem todo provider os tem, e
   * eles NUNCA podem custar o estado. Um adapter que falhe ao buscá-los
   * ainda deve devolver o `status` — perder ONLINE/OFFLINE por causa de um
   * detalhe secundário seria trocar o essencial pelo acessório.
   */
  technology?: string | null;
  serverMaintenance?: boolean | null;
}

/**
 * O que acompanha TODA verificação de conectividade (`RC-1F-A`, decisão do dono).
 *
 * O prazo da verificação é contrato do provider, não gentileza de um adapter:
 * quem cronometra a verificação (`runWithDiagnosticDeadline`) cria o sinal, e
 * o sinal aborta quando o prazo vence. Antes ele só existia dentro do adapter
 * ReceitaNet, e um adapter novo que falasse HTTP podia esquecê-lo — o ciclo
 * pegaria o próximo cliente com a requisição anterior ainda em voo, e a
 * concorrência configurada deixaria de ser o limite real de requisições.
 *
 * Um objeto, e não o sinal solto, para o contrato poder crescer sem mudar a
 * assinatura de todo adapter de novo.
 */
export interface ERPDiagnosticsRequestContext {
  /**
   * Aborta quando o prazo da verificação vence. Adapter que faz I/O DEVE
   * repassá-lo a TODA operação externa da verificação — inclusive às leituras
   * acessórias —, para que nada dela fique em voo depois do prazo.
   */
  readonly signal: AbortSignal;
}

export interface ERPDiagnosticsCapability {
  /**
   * Reads the customer's current connectivity from the provider.
   *
   * Contract for implementors:
   *  - Return an observation ONLY when the payload is positive evidence of a
   *    state. Anything ambiguous is `UNKNOWN`, which is a real answer.
   *  - Throw `IntegrationError` for everything that is a failure of the
   *    integration rather than a statement about the customer. Never encode a
   *    failure as `OFFLINE`.
   *  - Never throw a raw provider error, a fetch error, or anything carrying a
   *    URL, header or token.
   *  - Pass `context.signal` to every external operation of the check. When
   *    it aborts, give up: reject with `TIMEOUT` — or, if the essential state
   *    was already read, return it without the optional extras.
   */
  fetchCustomerConnectivity(
    ref: ERPCustomerRef,
    context: ERPDiagnosticsRequestContext,
  ): Promise<ERPConnectivityObservation>;
}

export function supportsDiagnostics(
  adapter: unknown,
): adapter is ERPDiagnosticsCapability {
  return (
    typeof adapter === "object" &&
    adapter !== null &&
    typeof (adapter as ERPDiagnosticsCapability).fetchCustomerConnectivity ===
      "function"
  );
}

/**
 * Default deadline for any single provider call, in milliseconds.
 *
 * 8s is well past a healthy ERP round trip and well short of the technician
 * giving up on the screen. It is deliberately OUR deadline, not the provider's:
 * no documented ReceitaNet SLA exists to derive it from, so inventing a
 * tighter number would be false precision and a looser one would let a hung
 * socket hold a request handler.
 */
export const DIAGNOSTIC_TIMEOUT_MS = 8_000;

/**
 * Executa uma verificação de conectividade sob prazo, e o prazo CANCELA.
 *
 * É o dono do contexto de `ERPDiagnosticsRequestContext`: cria o sinal, o
 * entrega à operação e o aborta quando o prazo vence. Aplicado no ponto de
 * chamada, como `withIntegrationTimeout`, para a garantia não depender de o
 * adapter lembrar de ter um relógio próprio.
 *
 * Vencido o prazo, duas coisas, nesta ordem:
 *
 * 1. o sinal aborta — um adapter que o honra encerra o que está em voo e
 *    responde na hora: `TIMEOUT`, ou o estado que já tinha lido sem os extras;
 * 2. na volta seguinte do event loop, quem ainda não respondeu recebe
 *    `TIMEOUT` — um adapter que ignora o sinal não segura o chamador.
 *
 * O passo 2 espera um `setImmediate`, e não nada, porque a resposta de quem
 * honrou o sinal chega por uma cadeia de microtarefas: rejeitar no mesmo
 * instante do aborto descartaria um ONLINE obtido dentro do prazo por causa de
 * uma leitura acessória que o próprio prazo cortou.
 *
 * Terminada a operação, o sinal é abortado de qualquer forma: nada que ela
 * tenha deixado para trás continua em voo.
 */
export async function runWithDiagnosticDeadline<T>(
  provider: string,
  operation: (context: ERPDiagnosticsRequestContext) => Promise<T>,
  timeoutMs: number = DIAGNOSTIC_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  let relogio: ReturnType<typeof setTimeout> | undefined;
  let tolerancia: ReturnType<typeof setImmediate> | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      relogio = setTimeout(() => {
        controller.abort();
        tolerancia = setImmediate(() =>
          reject(
            new IntegrationError("TIMEOUT", provider, `sem resposta em ${timeoutMs}ms`),
          ),
        );
      }, timeoutMs);
      Promise.resolve()
        .then(() => operation({ signal: controller.signal }))
        .then(resolve, reject);
    });
  } finally {
    if (relogio) clearTimeout(relogio);
    if (tolerancia) clearImmediate(tolerancia);
    controller.abort();
  }
}

/**
 * Bounds any capability call in time, whichever adapter implements it.
 *
 * Applied at the CALL SITE rather than inside each adapter so the guarantee is
 * structural: a future adapter cannot forget it, and an adapter that hangs
 * without ever touching the network (a bad `await`, a stalled stream) is
 * caught too. The losing promise is left to settle on its own — there is
 * nothing to cancel safely at this layer, and its result is discarded.
 */
export async function withIntegrationTimeout<T>(
  operation: Promise<T>,
  provider: string,
  timeoutMs: number = DIAGNOSTIC_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new IntegrationError(
                "TIMEOUT",
                provider,
                `sem resposta em ${timeoutMs}ms`,
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
