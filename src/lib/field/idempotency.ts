import { createHash } from "node:crypto";
import { isUniqueConstraintError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { FieldError } from "./errors";

/**
 * Quem ancora o escopo da chave.
 *
 * Tipado pelo que a função REALMENTE usa — empresa e pessoa — e não por
 * `FieldPrincipal`. `FieldPrincipal` satisfaz esta forma estruturalmente, então
 * nenhuma rota do Field mudou; o que a abertura acrescenta é a sessão da WEB,
 * que precisa da mesma proteção e não tem principal de Field nenhum.
 *
 * Amarrar a idempotência ao tipo do Field obrigaria o painel a ter a sua
 * própria — e duas tabelas de idempotência com regras próprias de lease,
 * expiração e tomada é exatamente o que o §253 (LOW-2) não pede: ele pede a
 * MESMA proteção, não uma parecida.
 */
export interface IdempotencyActor {
  user: { id: string; companyId: string };
}

/** Ator a partir de uma sessão da web, que não tem `FieldPrincipal`. */
export function idempotencyActor(
  companyId: string,
  userId: string,
): IdempotencyActor {
  return { user: { id: userId, companyId } };
}

/**
 * # Idempotência dos comandos mutantes
 *
 * Nasceu para o Field e serve aos DOIS clientes. O painel usa a mesma tabela,
 * o mesmo lease e a mesma arbitragem pelo banco: o navegador também reenvia —
 * duplo clique, `retry` depois de um timeout, aba recarregada no meio do POST.
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

/**
 * Quanto tempo uma reserva `IN_FLIGHT` segura a chave.
 *
 * A reserva é gravada ANTES de executar, para que a unique arbitre a corrida.
 * O preço disso é que um processo morto no meio deixa a linha `IN_FLIGHT` — e,
 * sem prazo, toda retentativa daquela chave recebia CONFLICT até a expiração
 * de 24 h. Uma queda de processo travava a operação do técnico por um dia.
 *
 * Dois minutos: bem acima de qualquer comando do Field (todos são uma
 * transação curta no mesmo banco) e curto o bastante para o aplicativo se
 * recuperar dentro da mesma visita.
 */
export const IDEMPOTENCY_LEASE_MS = 2 * 60 * 1000;

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
  id: string;
  fingerprint: string;
  status: number;
  response: unknown;
  leaseExpiresAt: Date | null;
  createdAt: Date;
}

/** A reserva ainda está viva, ou o processo que a criou sumiu? */
function leaseIsLive(record: StoredRecord, now: Date): boolean {
  const deadline =
    record.leaseExpiresAt ??
    // Linha criada antes desta coluna existir: a idade sai de `createdAt`, que
    // é o instante da reserva. Sem backfill, e sem reserva antiga eterna.
    new Date(record.createdAt.getTime() + IDEMPOTENCY_LEASE_MS);
  return deadline > now;
}

const inProgress = () =>
  new FieldError(
    "CONFLICT",
    "Esta operação já está em andamento. Recarregue e verifique.",
  );

/**
 * O que fazer diante de um registro existente.
 *
 * `replay` devolve o desfecho guardado. `takeover` significa que a reserva foi
 * abandonada e esta requisição pode assumi-la — sujeito a ganhar a corrida da
 * própria tomada.
 */
type Decision<T> =
  | { kind: "replay"; outcome: IdempotentOutcome<T> }
  | { kind: "takeover"; recordId: string };

function decide<T>(
  record: StoredRecord,
  fingerprint: string,
  now: Date,
): Decision<T> {
  if (record.fingerprint !== fingerprint) {
    throw new FieldError(
      "IDEMPOTENCY_CONFLICT",
      "Esta chave de idempotência já foi usada com outro conteúdo.",
    );
  }
  if (record.status !== IN_FLIGHT) {
    return {
      kind: "replay",
      outcome: { status: record.status, body: record.response as T },
    };
  }
  if (leaseIsLive(record, now)) {
    /*
      A primeira requisição ainda está rodando.

      É CONFLICT, e não erro transitório, porque a orientação certa para o
      aplicativo é recarregar e olhar: quando a vencedora commitar, o estado já
      refletirá a mutação, e reenviar às cegas não acrescentaria nada.
    */
    throw inProgress();
  }
  /*
    Reserva abandonada.

    Quem a criou morreu sem gravar o desfecho. A operação PODE ter commitado
    mesmo assim — a reserva é gravada antes de executar, então há uma janela
    entre o commit do domínio e a gravação do resultado aqui.

    Por isso a tomada RE-EXECUTA o handler em vez de fingir sucesso. Quem
    garante que a mutação não aconteça duas vezes não é esta camada: é o
    domínio. A máquina de estados recusa `ASSIGNED → IN_PROGRESS` numa OS que
    já está em atendimento, e o compare-and-set recusa uma versão que já andou.
    O desfecho de uma tomada depois de um commit é um 409 honesto, não uma
    segunda execução.
  */
  return { kind: "takeover", recordId: record.id };
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
  principal: IdempotencyActor,
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

  /**
   * Assume uma reserva abandonada — se ganharmos a corrida da tomada.
   *
   * O predicado repete a condição de abandono, então duas requisições que
   * enxergam o mesmo lease vencido não assumem as duas: o banco serializa e a
   * perdedora casa zero linhas.
   */
  const tryTakeover = async (recordId: string): Promise<boolean> => {
    const legacyCutoff = new Date(now.getTime() - IDEMPOTENCY_LEASE_MS);
    const taken = await prisma.idempotencyRecord.updateMany({
      where: {
        id: recordId,
        status: IN_FLIGHT,
        OR: [
          { leaseExpiresAt: { lte: now } },
          { leaseExpiresAt: null, createdAt: { lte: legacyCutoff } },
        ],
      },
      data: { leaseExpiresAt: new Date(now.getTime() + IDEMPOTENCY_LEASE_MS) },
    });
    return taken.count === 1;
  };

  const existing = await prisma.idempotencyRecord.findUnique({
    where: { companyId_userId_operation_key: scope },
  });

  let reservationId: string | null = null;

  if (existing) {
    if (existing.expiresAt > now) {
      const decision = decide<T>(existing, fingerprint, now);
      if (decision.kind === "replay") return decision.outcome;
      if (!(await tryTakeover(decision.recordId))) {
        // Outra requisição assumiu primeiro. Ela é a dona agora.
        throw inProgress();
      }
      reservationId = decision.recordId;
    } else {
      // Expirada: a janela passou e a chave volta a ser reutilizável. Apagar em
      // vez de reaproveitar a linha mantém a corrida arbitrada por um único
      // mecanismo — o INSERT abaixo.
      await prisma.idempotencyRecord
        .delete({ where: { id: existing.id } })
        .catch(() => undefined);
    }
  }

  if (reservationId === null) {
    try {
      const reservation = await prisma.idempotencyRecord.create({
        data: {
          ...scope,
          fingerprint,
          status: IN_FLIGHT,
          response: {},
          leaseExpiresAt: new Date(now.getTime() + IDEMPOTENCY_LEASE_MS),
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
      if (!winner) throw inProgress();
      const decision = decide<T>(winner, fingerprint, now);
      if (decision.kind === "replay") return decision.outcome;
      if (!(await tryTakeover(decision.recordId))) throw inProgress();
      reservationId = decision.recordId;
    }
  }

  try {
    const outcome = await handler();
    await prisma.idempotencyRecord.update({
      where: { id: reservationId },
      data: {
        status: outcome.status,
        response: outcome.body as never,
        resourceId: outcome.resourceId ?? null,
        // Concluída: não há mais reserva a expirar.
        leaseExpiresAt: null,
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
