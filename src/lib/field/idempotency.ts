import { createHash } from "node:crypto";
import { isUniqueConstraintError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { FieldError } from "./errors";
import type { FieldPrincipal } from "./auth";

/**
 * # Idempotência dos comandos do Field
 *
 * O caso concreto (PRD §160): a internet volta e o aplicativo reenvia
 * `COMPLETE_ORDER` três vezes, porque não sabe se as duas primeiras chegaram.
 * O resultado precisa ser **uma** conclusão.
 *
 * ## A chave é entrada não confiável
 *
 * Ela vem do dispositivo e evita duplicação — ela **não** prova autorização.
 * Por isso o escopo único é `(empresa, usuário, operação, chave)`:
 *
 * - **empresa e usuário** para que reapresentar a chave de outra pessoa não
 *   devolva o resultado dela. Sem isso a tabela viraria um oráculo: eu chuto
 *   chaves e leio a resposta que o servidor guardou para um colega.
 * - **operação** para que a mesma chave usada em dois comandos diferentes não
 *   colida. A chave é gerada no aparelho, no momento da ação; um app com bug
 *   que reaproveite uma não deve ganhar o desfecho do outro comando.
 *
 * Posse e tenancy são verificadas **antes** desta camada, nunca no lugar dela
 * (`docs/SECURITY.md` §8.9).
 *
 * ## Só o sucesso é memorizado
 *
 * Falha não fica guardada. Um 409 de hoje não pode transformar a mesma chave
 * num 409 permanente amanhã, quando a causa já passou — o técnico ficaria com
 * uma operação impossível de reenviar e nenhuma forma de destravá-la a não ser
 * reinstalar o aplicativo. Comando que falha é reexecutável; comando que deu
 * certo é reproduzido.
 */

/** Uma janela larga o bastante para cobrir um dia de campo sem rede. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/** Marca de "em execução": nenhum desfecho HTTP real usa 0. */
const IN_FLIGHT = 0;

export const FIELD_IDEMPOTENCY_HEADER = "Idempotency-Key";

/** Limites de forma. A chave é um identificador, não um campo de texto. */
const KEY_MIN = 8;
const KEY_MAX = 200;

/**
 * Aceita a chave, ou recusa com 400.
 *
 * O formato é validado porque uma chave vazia, gigante ou com quebra de linha
 * é sintoma de app montando a requisição errado — e uma chave que o servidor
 * aceita mas não distingue é pior que nenhuma: dá a impressão de proteção.
 */
export function parseIdempotencyKey(request: Request): string {
  const raw = request.headers.get(FIELD_IDEMPOTENCY_HEADER);
  if (!raw) {
    throw new FieldError(
      "VALIDATION_ERROR",
      `Cabeçalho ${FIELD_IDEMPOTENCY_HEADER} é obrigatório.`,
    );
  }
  const key = raw.trim();
  if (
    key.length < KEY_MIN ||
    key.length > KEY_MAX ||
    !/^[A-Za-z0-9._:-]+$/.test(key)
  ) {
    throw new FieldError(
      "VALIDATION_ERROR",
      `Cabeçalho ${FIELD_IDEMPOTENCY_HEADER} inválido.`,
    );
  }
  return key;
}

/**
 * JSON canônico: chaves ordenadas, em qualquer profundidade.
 *
 * Sem isto, `{"a":1,"b":2}` e `{"b":2,"a":1}` produziriam impressões digitais
 * diferentes, e uma retentativa do mesmo comando — com as chaves em outra
 * ordem por causa de serialização — seria lida como "mesma chave, payload
 * diferente" e recusada como conflito. O aplicativo ficaria sem conseguir
 * reenviar exatamente o que precisa reenviar.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, canonicalize(v)]));
  }
  return value;
}

export function fingerprintOf(payload: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(payload) ?? null))
    .digest("hex");
}

export interface IdempotentOutcome<T> {
  status: number;
  body: T;
  resourceId?: string | null;
}

interface StoredRecord {
  fingerprint: string;
  status: number;
  response: unknown;
}

function decide<T>(
  record: StoredRecord,
  fingerprint: string,
): IdempotentOutcome<T> {
  if (record.fingerprint !== fingerprint) {
    throw new FieldError(
      "IDEMPOTENCY_CONFLICT",
      "Esta chave de idempotência já foi usada com outro conteúdo.",
    );
  }
  if (record.status === IN_FLIGHT) {
    /*
      A primeira requisição ainda não terminou.

      É CONFLICT, e não um erro transitório, porque a orientação certa para o
      aplicativo é a mesma dos dois casos: recarregar o estado e olhar. Quando
      a vencedora commitar, o estado já refletirá a mutação — reenviar às cegas
      não acrescentaria nada.
    */
    throw new FieldError(
      "CONFLICT",
      "Esta operação já está em andamento. Recarregue e verifique.",
    );
  }
  return { status: record.status, body: record.response as T };
}

/**
 * Executa `handler` no máximo uma vez por `(empresa, usuário, operação, chave)`.
 *
 * A reserva é gravada ANTES de executar, e é o banco quem arbitra a corrida: a
 * unique `(companyId, userId, operation, key)` deixa exatamente uma requisição
 * criar a linha. Verificar-e-depois-inserir deixaria duas passarem pela
 * verificação no mesmo instante e executarem as duas.
 */
export async function withIdempotency<T>(
  principal: FieldPrincipal,
  operation: string,
  key: string,
  payload: unknown,
  handler: () => Promise<IdempotentOutcome<T>>,
  now: Date = new Date(),
): Promise<IdempotentOutcome<T>> {
  const fingerprint = fingerprintOf(payload);
  const scope = {
    companyId: principal.user.companyId,
    userId: principal.user.id,
    operation,
    key,
  };

  const existing = await prisma.idempotencyRecord.findUnique({
    where: { companyId_userId_operation_key: scope },
  });
  if (existing) {
    if (existing.expiresAt > now) {
      return decide<T>(existing, fingerprint);
    }
    // Expirada: a janela passou e a chave volta a ser reutilizável. Apagar em
    // vez de reaproveitar a linha mantém a corrida arbitrada por um único
    // mecanismo — o INSERT abaixo.
    await prisma.idempotencyRecord
      .delete({ where: { id: existing.id } })
      .catch(() => undefined);
  }

  let reservationId: string;
  try {
    const reservation = await prisma.idempotencyRecord.create({
      data: {
        ...scope,
        fingerprint,
        status: IN_FLIGHT,
        response: {},
        expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS),
      },
    });
    reservationId = reservation.id;
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    // Perdemos a corrida. Quem ganhou é a autoridade sobre o desfecho.
    const winner = await prisma.idempotencyRecord.findUnique({
      where: { companyId_userId_operation_key: scope },
    });
    if (!winner) {
      throw new FieldError(
        "CONFLICT",
        "Esta operação já está em andamento. Recarregue e verifique.",
      );
    }
    return decide<T>(winner, fingerprint);
  }

  try {
    const outcome = await handler();
    await prisma.idempotencyRecord.update({
      where: { id: reservationId },
      data: {
        status: outcome.status,
        response: outcome.body as never,
        resourceId: outcome.resourceId ?? null,
      },
    });
    return outcome;
  } catch (error) {
    /*
      Falhou: a reserva sai da frente.

      Guardar o erro transformaria uma recusa temporária — a OS ainda não
      estava atribuída, o técnico ainda não era elegível — em recusa
      permanente para aquela chave. O aparelho ficaria com uma operação na
      fila local que nunca mais teria como ser aceita.
    */
    await prisma.idempotencyRecord
      .delete({ where: { id: reservationId } })
      .catch(() => undefined);
    throw error;
  }
}
