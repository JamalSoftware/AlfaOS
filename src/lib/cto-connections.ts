import type { Prisma } from "@prisma/client";
import { logAuditWithin } from "./audit";
import { isPortOfferable, isPortWithinCapacity } from "./cto";
import { badRequest, conflict, notFound } from "./errors";
import { prisma } from "./prisma";

/**
 * # `CTO-2.1` — o vínculo operacional cliente ↔ porta
 *
 * O domínio transacional de `CustomerNetworkConnection`. **Sem rota, sem tela,
 * sem Field**: nada aqui é alcançável por um usuário nesta fase. As decisões
 * que este arquivo implementa estão congeladas em
 * `docs/CTO-NETWORK-DISTRIBUTION.md` §24, e ele não reinterpreta nenhuma.
 *
 * ## As três operações, e o que cada uma NÃO faz
 *
 * ```text
 * CONNECT     cria linha ativa            · não toca administrativeState
 * DISCONNECT  preenche disconnectedAt     · nunca DELETE
 * MOVE        fecha antiga + abre nova    · nunca UPDATE de ctoPortId
 * ```
 *
 * ## Ocupação não é coluna
 *
 * Uma porta está ocupada quando existe linha aqui com `disconnectedAt IS NULL`.
 * Não há `OCCUPIED` gravável, não há `isOccupied`, não há contador. Conectar
 * **não** altera `CTOPort.administrativeState`: uma porta recém-conectada
 * continua `AVAILABLE`, e é a existência do vínculo que a torna ocupada.
 *
 * ## Duas dimensões independentes
 *
 * `administrativeState` e ocupação respondem perguntas diferentes e **não se
 * colapsam**. `AVAILABLE + ocupada` é o estado normal; `DAMAGED + ocupada` é
 * uma posição com defeito e cliente ainda ligado, que a decisão do dono tornou
 * legítima. Qualquer contagem que derive "danificadas" de um rótulo unificado
 * perde a segunda — ver §24.4 e `CTO-2.2`.
 */

// ---------------------------------------------------------------------------
// Procedência — a autoridade é do servidor, e o TIPO diz isso
// ---------------------------------------------------------------------------

/**
 * De onde veio a mutação, já autorizada.
 *
 * É um tipo **discriminado** de propósito: `FIELD` sem OS ou sem técnico não é
 * um objeto que exista, e `WEB` não tem onde pendurar um técnico inventado. A
 * alternativa — um objeto plano com tudo opcional — transformaria cada invariante
 * numa verificação que alguém precisa lembrar de escrever.
 *
 * **Nada aqui vem do payload.** `companyId`, `source`, `technicianId`,
 * `serviceOrderId` e os carimbos de tempo são derivados pelo servidor. Este
 * tipo é o contrato que torna isso estrutural em vez de disciplinar.
 *
 * A `CTO-2.4` é quem constrói a variante `FIELD`, depois de resolver sessão,
 * técnico corrente, OS `IN_PROGRESS`, posse e mesmo cliente. Este módulo recebe
 * o resultado e valida as invariantes **estruturais** — não repete a
 * autorização, que tem dono e é `loadInProgressOwnedOrder`.
 */
export type ConnectionProvenance =
  | { source: "WEB"; actorUserId: string }
  | {
      source: "FIELD";
      actorUserId: string;
      technicianId: string;
      serviceOrderId: string;
    };

/**
 * O contexto de uma operação. `companyId` vem da sessão, jamais do corpo.
 */
export interface ConnectionContext {
  companyId: string;
  provenance: ConnectionProvenance;
  /**
   * A autorização de quem chamou, executada **dentro** da transação.
   *
   * Este módulo não sabe o que ela verifica, e é isso que o mantém livre de uma
   * segunda cópia da posse. A `CTO-2.4` passa aqui o mesmo portão que evidência,
   * material, equipamento e assinatura usam — `loadInProgressOwnedOrder` mais
   * `claimOrderForChildMutation` —, e a `CTO-2.3` não passa nada: a operação
   * administrativa já foi autorizada pelo perfil, fora daqui.
   *
   * **Por que dentro da transação, e não antes dela.** Autorizada fora, a OS
   * poderia ser concluída no intervalo entre a conferência e a escrita, e o
   * `ServiceOrderEvent` nasceria depois do fechamento — evento numa OS que o
   * snapshot de conclusão já declarou encerrada. Aqui a reivindicação segura a
   * linha da OS até o commit, e o desfecho é 409 em vez de história inventada.
   *
   * Roda **antes de qualquer lock**, o que fixa a ordem
   * `ServiceOrder → Customer → CTO` para toda operação de campo. A ordem
   * inversa não existe: nada que trave `Customer` pede `ServiceOrder`
   * exclusivo depois — a origem `WEB` sequer toca OS.
   */
  authorizeWithin?: (tx: Tx) => Promise<void>;
}

/**
 * Teto do motivo livre de `DISCONNECT`/`MOVE`.
 *
 * Vive no domínio, e não numa das superfícies, porque as duas o aplicam: sem
 * isso a Web limitaria em 200 e o Field aceitaria o que quisesse, e o limite
 * deixaria de ser regra para virar hábito de uma tela.
 */
export const CTO_CONNECTION_REASON_MAX_LENGTH = 200;

export interface PublicNetworkConnection {
  id: string;
  customerId: string;
  ctoPortId: string;
  ctoId: string;
  portNumber: number;
  connectedAt: Date;
  disconnectedAt: Date | null;
  source: "FIELD" | "WEB";
  serviceOrderId: string | null;
  technicianId: string | null;
  reason: string | null;
}

type Tx = Prisma.TransactionClient;

/**
 * Rejeita uma procedência estruturalmente impossível.
 *
 * O tipo discriminado já impede a maioria em tempo de compilação; isto fecha o
 * que atravessa a fronteira do TypeScript — um JSON vindo de fora, um teste que
 * força o tipo, uma rota futura mal montada. Custa uma comparação e remove a
 * classe inteira de "WEB com técnico inventado".
 */
function assertProvenance(provenance: ConnectionProvenance): void {
  if (provenance.source === "FIELD") {
    if (!provenance.serviceOrderId || !provenance.technicianId) {
      throw badRequest(
        "Uma operação de campo exige a ordem de serviço e o técnico.",
      );
    }
    return;
  }
  const web = provenance as { technicianId?: unknown; serviceOrderId?: unknown };
  if (web.technicianId != null || web.serviceOrderId != null) {
    throw badRequest(
      "Uma operação administrativa não tem técnico nem ordem de serviço.",
    );
  }
}

/**
 * O vínculo ativo AGORA é o mesmo que quem chamou estava olhando?
 *
 * A comparação é feita DEPOIS do lock do cliente, então o que ela lê é o estado
 * autoritativo, e não uma fotografia. Recusar aqui é o que impede a operação de
 * acertar um vínculo que nasceu entre a leitura da tela e o clique.
 *
 * A mensagem não devolve o id correto: quem está com a tela velha precisa
 * recarregar, e entregar o id novo convidaria a repetir o comando sem olhar.
 */
function assertNotStale(currentId: string, expectedId: string): void {
  if (currentId !== expectedId) {
    throw conflict(
      "Este vínculo mudou desde que a tela foi carregada. Recarregue e tente de novo.",
    );
  }
}

function provenanceColumns(provenance: ConnectionProvenance) {
  return provenance.source === "FIELD"
    ? {
        source: "FIELD" as const,
        technicianId: provenance.technicianId,
        serviceOrderId: provenance.serviceOrderId,
      }
    : { source: "WEB" as const, technicianId: null, serviceOrderId: null };
}

// ---------------------------------------------------------------------------
// Locks — a ordem é Customer → CTOs por id
// ---------------------------------------------------------------------------

/**
 * Trava o cliente, e é sempre o PRIMEIRO lock.
 *
 * Sem ele, duas movimentações do mesmo cliente para CTOs diferentes travariam
 * caixas distintas e nenhuma veria a outra: as duas leriam "sem vínculo ativo",
 * as duas tentariam inserir, e quem responderia seria a unique parcial de
 * `customerId` — com uma delas já tendo fechado a linha antiga. O lock de
 * cliente é o que faz o par fechar-e-abrir ser atômico **entre operações**, e
 * não só dentro de uma.
 *
 * Tenant no predicado, como em todo o módulo: um `customerId` de outra empresa
 * não trava nada e cai em `notFound`.
 */
async function lockCustomer(
  tx: Tx,
  companyId: string,
  customerId: string,
): Promise<{ id: string }> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "customers"
    WHERE "id" = ${customerId} AND "companyId" = ${companyId}
    FOR UPDATE
  `;
  const row = rows[0];
  if (!row) {
    throw notFound("Cliente não encontrado.");
  }
  return row;
}

/**
 * Trava as CTOs envolvidas em ordem crescente de `id`.
 *
 * **A ordenação acontece ANTES de qualquer `FOR UPDATE`** — ordenar depois de
 * travar é o mesmo que não ordenar, lição literal da `DQ-2`, onde travar o
 * destino primeiro e só então ordenar o par produziu exatamente o defeito que a
 * ordenação existia para evitar.
 *
 * Não existe lock de `CTOPort`. A `CTO-1` escolheu deliberadamente travar a
 * CAIXA e não a linha da porta, e alteração de capacidade e de estado
 * administrativo serializam por ele; um segundo nível de lock teria de coexistir
 * com esse, que é precisamente a complexidade que se está evitando.
 */
async function lockCtos(
  tx: Tx,
  companyId: string,
  ctoIds: string[],
): Promise<Map<string, { id: string; capacity: number; active: boolean }>> {
  const ordered = Array.from(new Set(ctoIds)).sort();
  const found = new Map<
    string,
    { id: string; capacity: number; active: boolean }
  >();
  for (const ctoId of ordered) {
    const rows = await tx.$queryRaw<
      { id: string; capacity: number; active: boolean }[]
    >`
      SELECT "id", "capacity", "active" FROM "ctos"
      WHERE "id" = ${ctoId} AND "companyId" = ${companyId}
      FOR UPDATE
    `;
    const row = rows[0];
    if (!row) {
      throw notFound("CTO não encontrada.");
    }
    found.set(row.id, row);
  }
  return found;
}

// ---------------------------------------------------------------------------
// Resolução tenant-safe
// ---------------------------------------------------------------------------

/**
 * Resolve a porta pelo caminho `empresa → CTO → porta`, nunca por `portId` solto.
 *
 * `findUnique({ id: portId })` devolveria a porta de qualquer empresa, e a
 * verificação de tenant passaria a depender de quem chamou lembrar de fazê-la.
 * Aqui o `companyId` está no predicado e o `ctoId` também: uma porta que existe
 * mas pertence a outra caixa é tão inexistente quanto uma que não existe.
 */
async function resolvePort(tx: Tx, companyId: string, ctoPortId: string) {
  const port = await tx.cTOPort.findFirst({
    where: { id: ctoPortId, companyId },
    select: {
      id: true,
      ctoId: true,
      number: true,
      administrativeState: true,
      companyId: true,
    },
  });
  if (!port) {
    throw notFound("Porta não encontrada.");
  }
  return port;
}

async function activeOnPort(tx: Tx, companyId: string, ctoPortId: string) {
  return tx.customerNetworkConnection.findFirst({
    where: { companyId, ctoPortId, disconnectedAt: null },
  });
}

async function activeOfCustomer(tx: Tx, companyId: string, customerId: string) {
  return tx.customerNetworkConnection.findFirst({
    where: { companyId, customerId, disconnectedAt: null },
  });
}

// ---------------------------------------------------------------------------
// Violação de unique — a corrida que escapou da janela
// ---------------------------------------------------------------------------

/**
 * Traduz a violação dos índices parciais em erro de domínio.
 *
 * O pré-check dentro da transação resolve o caso comum; o índice resolve o caso
 * em que duas transações passam pelo pré-check antes de qualquer uma commitar.
 * **Depender só do pré-check é o erro clássico** — entre o `SELECT` e o
 * `INSERT` cabe outra transação inteira.
 *
 * O nome do índice não sai na resposta: ele diz o nome da tabela e da coluna a
 * quem não deveria conhecer nenhum dos dois.
 */
function translateUniqueViolation(error: unknown): never {
  const target = uniqueTargetOf(error);
  if (target?.includes("active_port")) {
    throw conflict("Esta porta já está ocupada por outro cliente.");
  }
  if (target?.includes("active_customer")) {
    throw conflict("Este cliente já está conectado a uma porta.");
  }
  throw error;
}

function uniqueTargetOf(error: unknown): string | null {
  const e = error as {
    code?: string;
    meta?: { target?: unknown };
    message?: string;
  };
  if (e?.code !== "P2002") return null;
  const target = e.meta?.target;
  if (typeof target === "string") return target;
  if (Array.isArray(target)) return target.join(",");
  // Índice parcial criado por SQL cru: o Prisma às vezes só traz o nome na
  // mensagem, e é o nome que distingue porta de cliente.
  return typeof e.message === "string" ? e.message : null;
}

// ---------------------------------------------------------------------------
// Projeção
// ---------------------------------------------------------------------------

function toPublic(
  row: {
    id: string;
    customerId: string;
    ctoPortId: string;
    connectedAt: Date;
    disconnectedAt: Date | null;
    source: "FIELD" | "WEB";
    serviceOrderId: string | null;
    technicianId: string | null;
    reason: string | null;
  },
  port: { ctoId: string; number: number },
): PublicNetworkConnection {
  return {
    id: row.id,
    customerId: row.customerId,
    ctoPortId: row.ctoPortId,
    ctoId: port.ctoId,
    portNumber: port.number,
    connectedAt: row.connectedAt,
    disconnectedAt: row.disconnectedAt,
    source: row.source,
    serviceOrderId: row.serviceOrderId,
    technicianId: row.technicianId,
    reason: row.reason,
  };
}

// ---------------------------------------------------------------------------
// Elegibilidade da porta de DESTINO
// ---------------------------------------------------------------------------

/**
 * A porta pode receber um cliente agora?
 *
 * Compõe a regra pura da `CTO-1` com o que só o banco sabe. `isPortOfferable`
 * responde faixa **e** `AVAILABLE`, e não conhece ocupação — de propósito: ela é
 * pura e a ocupação exige consulta. Ensiná-la a consultar transformaria um
 * predicado testável isoladamente numa função que precisa de transação.
 *
 * A CTO inativa é recusada **aqui**, e não na saída: `DISCONNECT` e a metade
 * "sair" de um `MOVE` continuam funcionando numa caixa desativada, senão
 * desativar uma CTO aprisionaria os clientes que estão nela.
 */
async function assertPortAcceptsConnection(
  tx: Tx,
  companyId: string,
  port: { id: string; number: number; administrativeState: "AVAILABLE" | "RESERVED" | "DAMAGED" },
  cto: { capacity: number; active: boolean },
): Promise<void> {
  if (!cto.active) {
    throw conflict(
      "Esta CTO está inativa e não pode receber novos clientes.",
    );
  }
  if (!isPortWithinCapacity(port, cto.capacity)) {
    throw conflict(
      `A porta ${port.number} está fora da capacidade atual da CTO ` +
        `(${cto.capacity} portas) e é apenas histórica.`,
    );
  }
  if (!isPortOfferable(port, cto.capacity)) {
    throw conflict(
      port.administrativeState === "RESERVED"
        ? `A porta ${port.number} está reservada.`
        : `A porta ${port.number} está marcada como danificada.`,
    );
  }
  if (await activeOnPort(tx, companyId, port.id)) {
    throw conflict("Esta porta já está ocupada por outro cliente.");
  }
}

// ---------------------------------------------------------------------------
// Auditoria e timeline
// ---------------------------------------------------------------------------

async function record(
  tx: Tx,
  ctx: ConnectionContext,
  action: "CONNECTED" | "DISCONNECTED" | "MOVED",
  connectionId: string,
  details: string,
  event: "CTO_PORT_CONNECTED" | "CTO_PORT_DISCONNECTED" | "CTO_PORT_MOVED",
  metadata: Record<string, unknown>,
): Promise<void> {
  /*
    Auditoria na MESMA transação da mutação.

    Fora dela, uma falha entre o commit e o log produziria a pior combinação
    possível: o vínculo mudou e não há registro de quem o mudou. `logAuditWithin`
    existe exatamente para isso e é o que o resto do projeto usa.
  */
  await logAuditWithin(tx, {
    companyId: ctx.companyId,
    userId: ctx.provenance.actorUserId,
    action: `CTO_CONNECTION.${action}`,
    entity: "CustomerNetworkConnection",
    entityId: connectionId,
    details,
  });

  /*
    `ServiceOrderEvent` SÓ quando a origem é o campo.

    O padrão do projeto discrimina, e não por acaso: a timeline guarda fatos da
    narrativa da visita — chegou, usou material, instalou equipamento, colheu
    assinatura —, enquanto edição incremental fica só na auditoria. Conectar um
    cliente durante um atendimento é da primeira classe.

    Origem `WEB` não tem visita. Criar um evento ali exigiria uma OS que não
    existe, e inventar uma para ter onde pendurar a linha seria fabricar
    história.
  */
  if (ctx.provenance.source === "FIELD") {
    await tx.serviceOrderEvent.create({
      data: {
        companyId: ctx.companyId,
        serviceOrderId: ctx.provenance.serviceOrderId,
        userId: ctx.provenance.actorUserId,
        event,
        metadata: metadata as Prisma.InputJsonValue,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// CONNECT
// ---------------------------------------------------------------------------

export interface ConnectInput {
  customerId: string;
  ctoPortId: string;
}

/**
 * Liga o cliente a uma porta.
 *
 * Não altera `CTOPort.administrativeState`: a porta continua `AVAILABLE`, e a
 * ocupação passa a existir porque existe a linha. Escrever um estado aqui
 * criaria o segundo lugar que precisa concordar com o vínculo — exatamente o
 * que a `CTO-0.1` recusou.
 */
export async function connectCustomerToPort(
  ctx: ConnectionContext,
  input: ConnectInput,
): Promise<PublicNetworkConnection> {
  assertProvenance(ctx.provenance);

  return prisma.$transaction(async (tx) => {
    await ctx.authorizeWithin?.(tx);
    await lockCustomer(tx, ctx.companyId, input.customerId);

    /*
      A porta é resolvida ANTES do lock da CTO, e é dela que sai o `ctoId`.

      Não é atalho: `lockCtos` precisa do id para travar, e travar "a CTO da
      porta" exigiria descobrir qual é. O que importa é que a leitura da porta
      que DECIDE — estado administrativo, faixa, ocupação — acontece depois do
      lock, logo abaixo.
    */
    const preview = await resolvePort(tx, ctx.companyId, input.ctoPortId);
    const ctos = await lockCtos(tx, ctx.companyId, [preview.ctoId]);
    const cto = ctos.get(preview.ctoId)!;

    const port = await resolvePort(tx, ctx.companyId, input.ctoPortId);
    if (port.ctoId !== preview.ctoId) {
      // A porta trocou de caixa entre as duas leituras — impossível hoje
      // (`ctoId` não é editável), e recusar é mais barato que confiar.
      throw conflict("A porta mudou durante a operação. Tente de novo.");
    }

    await assertPortAcceptsConnection(tx, ctx.companyId, port, cto);

    if (await activeOfCustomer(tx, ctx.companyId, input.customerId)) {
      throw conflict(
        "Este cliente já está conectado a uma porta. Use a movimentação.",
      );
    }

    const created = await tx.customerNetworkConnection
      .create({
        data: {
          companyId: ctx.companyId,
          customerId: input.customerId,
          ctoPortId: port.id,
          connectedAt: new Date(),
          ...provenanceColumns(ctx.provenance),
        },
      })
      .catch(translateUniqueViolation);

    await record(
      tx,
      ctx,
      "CONNECTED",
      created.id,
      `Cliente conectado na porta ${port.number}`,
      "CTO_PORT_CONNECTED",
      { ctoId: port.ctoId, ctoPortId: port.id, portNumber: port.number },
    );

    return toPublic(created, port);
  });
}

// ---------------------------------------------------------------------------
// DISCONNECT
// ---------------------------------------------------------------------------

export interface DisconnectInput {
  customerId: string;
  /**
   * QUAL vínculo se está encerrando. Obrigatório, e a obrigatoriedade é a regra.
   *
   * Sem ele a operação seria "desconecte o que este cliente tiver agora", e uma
   * tela desatualizada bastaria para o desastre: o operador vê o cliente na
   * porta A, outra pessoa o move para B, o primeiro clica em desconectar e o
   * servidor encerra B — um vínculo que ele nunca viu.
   *
   * Opcional seria pior que ausente: quem esquecesse de mandar reabriria o
   * buraco sem nenhum sinal.
   */
  expectedConnectionId: string;
  reason?: string | null;
}

/**
 * Encerra o vínculo ativo do cliente.
 *
 * **Nunca apaga, e nunca toca `ctoPortId`.** A linha permanece exatamente onde
 * está e ganha `disconnectedAt` — é assim que "esteve na porta 4 até ontem"
 * continua sendo verdade amanhã.
 *
 * Repetir a operação **não** fecha outra linha por acidente: sem vínculo ativo,
 * a resposta é `409` explícito. Um `200` mudo faria quem chamou acreditar que
 * desconectou agora, e a idempotência de replay HTTP é responsabilidade do
 * `withIdempotency` quando a rota nascer — não de um sucesso inventado aqui.
 *
 * A CTO **não** precisa estar ativa: desativar uma caixa não pode prender os
 * clientes que estão nela.
 */
export async function disconnectCustomer(
  ctx: ConnectionContext,
  input: DisconnectInput,
): Promise<PublicNetworkConnection> {
  assertProvenance(ctx.provenance);

  return prisma.$transaction(async (tx) => {
    await ctx.authorizeWithin?.(tx);
    await lockCustomer(tx, ctx.companyId, input.customerId);

    const current = await activeOfCustomer(tx, ctx.companyId, input.customerId);
    if (!current) {
      throw conflict("Este cliente não está conectado a nenhuma porta.");
    }
    assertNotStale(current.id, input.expectedConnectionId);

    const port = await resolvePort(tx, ctx.companyId, current.ctoPortId);
    await lockCtos(tx, ctx.companyId, [port.ctoId]);

    // Releitura DEPOIS do lock: entre a busca e a trava, outra transação pode
    // ter fechado esta mesma linha.
    const stillActive = await tx.customerNetworkConnection.findFirst({
      where: { id: current.id, companyId: ctx.companyId, disconnectedAt: null },
    });
    if (!stillActive) {
      throw conflict("Este vínculo já foi encerrado.");
    }

    const closed = await tx.customerNetworkConnection.update({
      where: { id: current.id },
      data: { disconnectedAt: new Date(), reason: input.reason ?? null },
    });

    await record(
      tx,
      ctx,
      "DISCONNECTED",
      closed.id,
      `Cliente desconectado da porta ${port.number}`,
      "CTO_PORT_DISCONNECTED",
      { ctoId: port.ctoId, ctoPortId: port.id, portNumber: port.number },
    );

    return toPublic(closed, port);
  });
}

// ---------------------------------------------------------------------------
// MOVE
// ---------------------------------------------------------------------------

export interface MoveInput {
  customerId: string;
  /** Qual vínculo se está movendo. Ver `DisconnectInput.expectedConnectionId`. */
  expectedConnectionId: string;
  targetCtoPortId: string;
  reason?: string | null;
}

export interface MoveResult {
  from: PublicNetworkConnection;
  to: PublicNetworkConnection;
}

/**
 * Move o cliente de porta.
 *
 * **Não é `UPDATE ctoPortId`.** É fechar o vínculo antigo e abrir um novo, na
 * mesma transação. Atualizar a linha existente seria mais curto e faria o
 * passado mentir: o histórico passaria a afirmar que o cliente sempre esteve na
 * porta nova.
 *
 * A ordem interna importa: **fechar antes de abrir**. A unique parcial de
 * `customerId` proíbe dois vínculos ativos do mesmo cliente, então inserir antes
 * de fechar violaria a constraint dentro da própria transação — o mesmo
 * aprendizado da `DQ-7.1`, onde a poda precisou vir antes do preenchimento.
 *
 * Origem pode estar numa CTO **inativa** (é o `MOVE-OUT`); o destino não pode.
 */
export async function moveCustomerToPort(
  ctx: ConnectionContext,
  input: MoveInput,
): Promise<MoveResult> {
  assertProvenance(ctx.provenance);

  return prisma.$transaction(async (tx) => {
    await ctx.authorizeWithin?.(tx);
    await lockCustomer(tx, ctx.companyId, input.customerId);

    const current = await activeOfCustomer(tx, ctx.companyId, input.customerId);
    if (!current) {
      throw conflict(
        "Este cliente não está conectado a nenhuma porta. Use a conexão.",
      );
    }
    assertNotStale(current.id, input.expectedConnectionId);

    const origin = await resolvePort(tx, ctx.companyId, current.ctoPortId);
    const target = await resolvePort(tx, ctx.companyId, input.targetCtoPortId);

    /*
      Mesma porta não é movimentação, e recusar vem ANTES de qualquer escrita.

      Um no-op silencioso gravaria auditoria de uma movimentação que não
      aconteceu — história inventada —, e um par fechar/abrir na mesma posição
      criaria duas linhas afirmando que o cliente saiu e voltou. Nenhum dos dois
      é verdade.
    */
    if (origin.id === target.id) {
      throw conflict("O cliente já está nesta porta.");
    }

    /*
      Os DOIS ids são conhecidos antes de qualquer `FOR UPDATE`, e `lockCtos`
      os ordena. Travar a origem e só então descobrir o destino reintroduziria
      a inversão de ordem que a `DQ-2` já pagou para aprender.
    */
    const ctos = await lockCtos(tx, ctx.companyId, [origin.ctoId, target.ctoId]);
    const targetCto = ctos.get(target.ctoId)!;

    // Releitura autoritativa depois dos locks.
    const freshTarget = await resolvePort(tx, ctx.companyId, target.id);
    const stillActive = await tx.customerNetworkConnection.findFirst({
      where: { id: current.id, companyId: ctx.companyId, disconnectedAt: null },
    });
    if (!stillActive) {
      throw conflict("Este vínculo já foi encerrado.");
    }

    await assertPortAcceptsConnection(
      tx,
      ctx.companyId,
      freshTarget,
      targetCto,
    );

    const closed = await tx.customerNetworkConnection.update({
      where: { id: current.id },
      data: { disconnectedAt: new Date(), reason: input.reason ?? null },
    });

    const created = await tx.customerNetworkConnection
      .create({
        data: {
          companyId: ctx.companyId,
          customerId: input.customerId,
          ctoPortId: freshTarget.id,
          connectedAt: new Date(),
          ...provenanceColumns(ctx.provenance),
        },
      })
      .catch(translateUniqueViolation);

    await record(
      tx,
      ctx,
      "MOVED",
      created.id,
      `Cliente movido da porta ${origin.number} para a porta ${freshTarget.number}`,
      "CTO_PORT_MOVED",
      {
        fromCtoId: origin.ctoId,
        fromCtoPortId: origin.id,
        fromPortNumber: origin.number,
        toCtoId: freshTarget.ctoId,
        toCtoPortId: freshTarget.id,
        toPortNumber: freshTarget.number,
      },
    );

    return {
      from: toPublic(closed, origin),
      to: toPublic(created, freshTarget),
    };
  });
}

// ---------------------------------------------------------------------------
// Leitura interna — sem rota, sem DTO de tela
// ---------------------------------------------------------------------------

/** O vínculo ativo do cliente, ou `null`. */
export async function findActiveConnectionForCustomer(
  companyId: string,
  customerId: string,
): Promise<PublicNetworkConnection | null> {
  const row = await prisma.customerNetworkConnection.findFirst({
    where: { companyId, customerId, disconnectedAt: null },
    include: { ctoPort: { select: { ctoId: true, number: true } } },
  });
  return row ? toPublic(row, row.ctoPort) : null;
}

/** O vínculo ativo de uma porta, ou `null`. */
export async function findActiveConnectionForPort(
  companyId: string,
  ctoPortId: string,
): Promise<PublicNetworkConnection | null> {
  const row = await prisma.customerNetworkConnection.findFirst({
    where: { companyId, ctoPortId, disconnectedAt: null },
    include: { ctoPort: { select: { ctoId: true, number: true } } },
  });
  return row ? toPublic(row, row.ctoPort) : null;
}

/**
 * Quais portas de uma CTO estão ocupadas agora.
 *
 * Uma consulta para a caixa inteira, e não uma por porta: a tela de detalhe tem
 * até 256 linhas, e perguntar porta a porta seria o `N+1` clássico. Devolve um
 * `Set` porque a pergunta é de pertinência.
 */
export async function findOccupiedPortIds(
  companyId: string,
  ctoId: string,
): Promise<Set<string>> {
  const rows = await prisma.customerNetworkConnection.findMany({
    where: { companyId, disconnectedAt: null, ctoPort: { ctoId } },
    select: { ctoPortId: true },
  });
  return new Set(rows.map((r) => r.ctoPortId));
}

/** A história do cliente, da mais recente para a mais antiga. */
export async function listConnectionHistory(
  companyId: string,
  customerId: string,
): Promise<PublicNetworkConnection[]> {
  const rows = await prisma.customerNetworkConnection.findMany({
    where: { companyId, customerId },
    include: { ctoPort: { select: { ctoId: true, number: true } } },
    orderBy: { connectedAt: "desc" },
  });
  return rows.map((r) => toPublic(r, r.ctoPort));
}
