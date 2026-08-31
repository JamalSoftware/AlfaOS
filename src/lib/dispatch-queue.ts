import type { ServiceOrderPriority } from "@prisma/client";

/**
 * # Fila operacional de OS — primitivas de domínio
 *
 * PRD Parte XII (§308–§332) e `docs/DISPATCH-QUEUE.md`.
 *
 * Este arquivo é **puro**: nenhuma consulta, nenhuma transação, nenhuma
 * escrita. É de propósito — a precedência e a normalização são as duas regras
 * que a fila inteira depende, e regra que precisa de banco para ser testada
 * acaba testada de menos.
 *
 * O serviço que persiste (`DQ-2`) consome estas funções; elas não o conhecem.
 */

/**
 * A precedência operacional, e a **única** autoridade sobre ela.
 *
 * ```text
 * URGENT  >  HIGH  >  NORMAL  >  LOW
 * ```
 *
 * ## Por que um mapa explícito, e não `ORDER BY priority`
 *
 * Em Postgres um `enum` ordena pela **ordem de declaração**. Hoje o enum está
 * declarado `LOW, NORMAL, HIGH, URGENT`, então `ORDER BY priority DESC`
 * devolve a ordem certa — por coincidência estrutural, não por regra escrita
 * (PRD §310).
 *
 * Isso significa que reordenar as linhas do enum no `schema.prisma`
 * reordenaria, em silêncio, a fila de todos os técnicos de todas as empresas.
 * Nenhum teste de produto falharia; o schema não parece um lugar onde se muda
 * comportamento operacional.
 *
 * Com o mapa, a precedência é **dado do domínio** e o schema volta a ser só
 * armazenamento.
 *
 * ## A orientação: menor número vem primeiro
 *
 * `URGENT = 0` para que o comparador seja `rank(a) - rank(b)`, que é como todo
 * comparador se escreve. A constante anterior (`SERVICE_ORDER_PRIORITY_ORDER`,
 * removida nesta fase) usava a orientação inversa — `URGENT: 3` — e obrigaria
 * cada consumidor a lembrar de ordenar descendente. É a mesma orientação que o
 * ranking do Field já usa (`attention_ranking.dart`).
 */
export const DISPATCH_BAND: Record<ServiceOrderPriority, number> = {
  URGENT: 0,
  HIGH: 1,
  NORMAL: 2,
  LOW: 3,
};

/** A banda de precedência de uma prioridade. Menor vem primeiro. */
export function dispatchRank(priority: ServiceOrderPriority): number {
  return DISPATCH_BAND[priority];
}

/**
 * Comparador de precedência. Negativo se `a` deve ser atendida antes de `b`.
 *
 * **Não desempata.** Duas OS da mesma banda devolvem `0`, e é justamente esse
 * empate que a ordenação estável preserva em [normalizeQueue] — é ele que faz
 * a sequência escolhida pelo despachante sobreviver.
 */
export function compareByDispatchBand(
  a: ServiceOrderPriority,
  b: ServiceOrderPriority,
): number {
  return dispatchRank(a) - dispatchRank(b);
}

/** O que a normalização precisa saber de cada OS na fila. */
export interface QueueMember {
  serviceOrderId: string;
  priority: ServiceOrderPriority;
  /** Posição atual. A normalização a lê para ordenar, e a reescreve na saída. */
  position: number;
}

/**
 * A intenção do despachante: **uma** OS, **um** destino absoluto.
 *
 * Alvo absoluto, nunca delta. "Subir uma posição" aplicada duas vezes sobe
 * duas — retry de rede e duplo clique transformariam uma correção em duas
 * (PRD §318). `targetPosition` aplicada duas vezes produz o mesmo estado.
 */
export interface DispatchIntent {
  serviceOrderId: string;
  /** 1-based, como o usuário vê. Fora da faixa sofre clamp, não erro. */
  targetPosition: number;
}

/**
 * Normaliza a fila: aplica a intenção, respeita a precedência e renumera.
 *
 * ## O algoritmo
 *
 * ```text
 * 1. ordenar pela posição atual
 * 2. aplicar a intenção, se houver
 * 3. ordenação ESTÁVEL por banda de precedência
 * 4. reescrever position = 1..N
 * ```
 *
 * O passo 3 é o que sustenta a invariante `I-12` (urgente precede normal)
 * **sem validar nada**: uma `NORMAL` que o despachante tentou pôr na posição 1
 * termina no topo da banda dela, e as urgentes continuam à frente.
 *
 * ## Acomodar, não recusar
 *
 * A operação nunca é rejeitada por violar precedência — ela é acomodada, e o
 * chamador devolve a fila resultante para a tela mostrar onde a OS realmente
 * foi. Recusar seria pior: o despachante arrastou, o cartão voltou sozinho, e
 * ele não sabe por quê (PRD §204: "falhar precisa ser visível").
 *
 * Quem quiser uma `NORMAL` na frente de uma `URGENT` tem o caminho honesto:
 * mudar a prioridade dela, que fica registrado e auditado (PRD §320).
 *
 * ## Por que `I-12` depende deste passo
 *
 * A decisão `D-11` escolheu posição **global** em vez de posição por banda. Em
 * troca, `I-12` deixou de ser garantida pelo banco e passou a ser invariante
 * de aplicação — reestabelecida aqui, e em nenhum outro lugar. É a única
 * invariante desta capability que o Postgres não defende sozinho, e por isso
 * ela tem teste de concorrência com prova de reversão.
 *
 * @returns uma lista NOVA, com `position` 1..N contígua. A entrada não é
 * mutada: o chamador ainda precisa dela para calcular o que mudou.
 */
export function normalizeQueue(
  members: readonly QueueMember[],
  intent?: DispatchIntent,
): QueueMember[] {
  const ordered = [...members].sort(
    (a, b) =>
      a.position - b.position ||
      // Desempate que nunca empata. Sem ele, duas linhas com a mesma posição
      // — possível durante um reorder de duas fases — deixariam a saída
      // dependente da ordem em que o banco devolveu as linhas.
      (a.serviceOrderId < b.serviceOrderId
        ? -1
        : a.serviceOrderId > b.serviceOrderId
          ? 1
          : 0),
  );

  if (intent) {
    const from = ordered.findIndex(
      (m) => m.serviceOrderId === intent.serviceOrderId,
    );
    // Intenção sobre OS que não está na fila é ignorada, não é erro: a OS pode
    // ter sido concluída ou reatribuída entre a leitura da tela e o comando, e
    // o CAS da fila já recusa o caso em que isso importa.
    if (from !== -1) {
      const [moved] = ordered.splice(from, 1);
      // Clamp em vez de 400. "Mover para o fim" digitado como 99 numa fila de
      // 6 é intenção clara; transformar isso em erro seria pedantismo contra
      // quem está despachando.
      const to = Math.min(Math.max(intent.targetPosition - 1, 0), ordered.length);
      ordered.splice(to, 0, moved);
    }
  }

  /*
    `Array.prototype.sort` é ESTÁVEL desde o ES2019 — garantido pela
    especificação, não detalhe de motor. É disso que depende o passo 3: a
    ordem relativa dentro da mesma banda é exatamente a sequência que o
    despachante montou, e um sort instável a embaralharia a cada leitura.
  */
  const byBand = ordered.sort((a, b) =>
    compareByDispatchBand(a.priority, b.priority),
  );

  return byBand.map((member, index) => ({
    ...member,
    position: index + 1,
  }));
}

/**
 * Onde uma OS entra ao ser atribuída: **fim da própria banda**.
 *
 * Resolve `D-04`, `D-05` e a política de inserção da PRD §317, com uma regra
 * só para os três casos (nova atribuição, promoção e rebaixamento).
 *
 * É a única política que **não altera a ordem relativa de nenhuma outra OS**.
 * Chegar depois não é ser mais importante: uma `URGENT` nova entra atrás das
 * urgentes que o despachante já ordenou, e quem quiser outra posição tem a
 * reordenação para dizê-lo.
 *
 * @returns a posição 1-based em que inserir, para consumo como
 * `DispatchIntent.targetPosition`.
 */
export function appendPositionForBand(
  members: readonly QueueMember[],
  priority: ServiceOrderPriority,
): number {
  const band = dispatchRank(priority);
  // Quantas já estão na mesma banda ou em banda mais forte: a nova entra
  // logo depois de todas elas.
  const ahead = members.filter((m) => dispatchRank(m.priority) <= band).length;
  return ahead + 1;
}
