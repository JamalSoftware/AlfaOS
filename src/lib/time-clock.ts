import type {
  Prisma,
  TimeAdjustmentStatus,
  TimeAdjustmentType,
  TimeEntry,
  TimeEntryType,
} from "@prisma/client";
import { prisma } from "./prisma";
import { logAudit } from "./audit";
import { badRequest, conflict, forbidden, notFound } from "./errors";
import {
  allowedTransitions,
  assertTransitionAllowed,
  deriveWorkdayState,
  isValidSequence,
  resolveEffectiveTimeEntries,
  resolveTimezone,
  utcOffsetIn,
  workdayDateOf,
  type WorkdayState,
} from "./workday";

/**
 * # Jornada / ponto do funcionário
 *
 * Registra **jornada de trabalho**. Não confundir com o check-in da OS
 * (`service-order-work-events.ts`): as duas gravam "cheguei", com GPS, e param
 * de se parecer aí. O check-in é preso a uma `ServiceOrder`; a jornada é presa
 * à PESSOA e ao DIA (PRD §226).
 *
 * ## Três regras que sustentam o módulo
 *
 * 1. **O horário que vale é o do servidor.** O carimbo do aparelho é gravado
 *    como metadata e é útil por divergir (§227).
 * 2. **Marcação é imutável.** Não existe caminho de UPDATE para `TimeEntry`
 *    neste arquivo nem em nenhum outro. Correção cria linha nova (§229).
 * 3. **O estado é derivado da sequência.** Não há coluna de status (§226).
 */

export const ADJUSTMENT_REASON_MAX = 500;
export const ADJUSTMENT_NOTES_MAX = 1000;

/** Precisão pior que isto não é localização, é bairro. */
export const MAX_ACCEPTABLE_ACCURACY_METERS = 10_000;

export interface PunchInput {
  type: TimeEntryType;
  /** O que o APARELHO diz. Metadata — nunca vira `occurredAt`. */
  deviceOccurredAt?: Date | null;
  latitude?: number | null;
  longitude?: number | null;
  accuracyMeters?: number | null;
  mobileDeviceId?: string | null;
  technicianId?: string | null;
  source?: "FIELD_APP" | "WEB";
}

export interface PublicTimeEntry {
  id: string;
  type: TimeEntryType;
  source: string;
  occurredAt: Date;
  deviceOccurredAt: Date | null;
  latitude: number | null;
  longitude: number | null;
  accuracyMeters: number | null;
  fromAdjustment: boolean;
}

export interface WorkdayView {
  workdayId: string | null;
  date: string;
  timezone: string;
  /**
   * O deslocamento do fuso da EMPRESA neste dia, como `-03:00`.
   *
   * O nome IANA sozinho não serve ao aplicativo: resolver `America/Sao_Paulo`
   * exige a base de fusos, que o Dart não traz. Sem este campo o Flutter só
   * tinha o relógio do aparelho para montar "08:30 daquele dia" — e um celular
   * configurado noutro fuso mandava um instante diferente do que a pessoa
   * escolheu, sem nada na tela denunciar (§253, LOW-3).
   *
   * É o MESMO valor que o painel do gestor já usa, da MESMA função
   * (`utcOffsetIn`), pelo mesmo motivo: quem digita um horário está digitando
   * no fuso da empresa, não no do dispositivo que tem em mãos.
   *
   * Calculado para ESTE dia, e não para o fuso em abstrato — onde há horário
   * de verão o deslocamento muda ao longo do ano.
   */
  utcOffset: string;
  state: WorkdayState;
  allowedActions: readonly TimeEntryType[];
  entries: PublicTimeEntry[];
  /** Minutos efetivamente trabalhados, já descontando intervalos fechados. */
  workedMinutes: number;
  breakMinutes: number;
  /** O que não fecha na sequência do dia. Vazio é o caso normal. */
  inconsistencies: string[];
  pendingAdjustments: number;
}

function toPublicEntry(entry: {
  id: string;
  type: TimeEntryType;
  source: string;
  occurredAt: Date;
  deviceOccurredAt: Date | null;
  latitude: Prisma.Decimal | null;
  longitude: Prisma.Decimal | null;
  accuracyMeters: number | null;
}): PublicTimeEntry {
  return {
    id: entry.id,
    type: entry.type,
    source: entry.source,
    occurredAt: entry.occurredAt,
    deviceOccurredAt: entry.deviceOccurredAt,
    latitude: entry.latitude === null ? null : Number(entry.latitude),
    longitude: entry.longitude === null ? null : Number(entry.longitude),
    accuracyMeters: entry.accuracyMeters,
    fromAdjustment: entry.source === "ADJUSTMENT",
  };
}

/**
 * Coordenada válida, ou nada.
 *
 * Ausência **não bloqueia** a batida (PRD §228): uma jornada que não pode ser
 * registrada porque o prédio é de concreto transfere ao funcionário um problema
 * que não é dele. O que é recusado é coordenada IMPOSSÍVEL — aí o aparelho está
 * enviando lixo, e gravar lixo como evidência é pior que não ter evidência.
 */
function normalizePosition(input: PunchInput): {
  latitude: number | null;
  longitude: number | null;
  accuracyMeters: number | null;
} {
  const { latitude, longitude, accuracyMeters } = input;

  if (
    latitude === null ||
    latitude === undefined ||
    longitude === null ||
    longitude === undefined
  ) {
    return { latitude: null, longitude: null, accuracyMeters: null };
  }

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw badRequest("Coordenada inválida.");
  }
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    throw badRequest("Coordenada fora do intervalo válido.");
  }

  let accuracy: number | null = null;
  if (accuracyMeters !== null && accuracyMeters !== undefined) {
    if (!Number.isFinite(accuracyMeters) || accuracyMeters < 0) {
      throw badRequest("Precisão de GPS inválida.");
    }
    if (accuracyMeters > MAX_ACCEPTABLE_ACCURACY_METERS) {
      // Guardar a coordenada seria afirmar uma localização que ela não prova.
      return { latitude: null, longitude: null, accuracyMeters: null };
    }
    accuracy = Math.round(accuracyMeters);
  }

  return { latitude, longitude, accuracyMeters: accuracy };
}

/**
 * Abre (ou recupera) o dia e o **trava** para a transação.
 *
 * `FOR UPDATE` é o que torna a batida segura contra concorrência. Dois
 * `CLOCK_IN` simultâneos leem "sem marcação" os dois e inserem os dois — não há
 * `version` de agregado para o cliente mandar, e nem faria sentido exigir isso
 * de quem só tocou um botão. Travando esta linha, o segundo comando só lê a
 * sequência depois de o primeiro ter gravado, e aí a máquina de estados o
 * recusa.
 */
async function lockWorkday(
  tx: Prisma.TransactionClient,
  companyId: string,
  userId: string,
  date: Date,
  timezone: string,
): Promise<{ id: string }> {
  // `createMany ... skipDuplicates` em vez de `upsert`: duas transações
  // simultâneas no primeiro dia da pessoa colidiriam na unique, e aqui a
  // segunda simplesmente não insere nada.
  await tx.workday.createMany({
    data: [{ companyId, userId, date, timezone }],
    skipDuplicates: true,
  });

  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "workdays"
    WHERE "companyId" = ${companyId}
      AND "userId" = ${userId}
      AND "date" = ${date}
    FOR UPDATE
  `;
  const row = rows[0];
  if (!row) {
    // Só acontece se a linha sumir entre o insert e o lock, o que exigiria
    // exclusão concorrente — que nenhum caminho do produto faz.
    throw conflict("Não foi possível abrir a jornada. Tente de novo.");
  }
  return row;
}

/**
 * Trava um dia que JÁ existe, pelo id.
 *
 * Mesma linha, mesmo lock que `lockWorkday` — muda só o predicado, porque a
 * decisão de um ajuste chega com o `workdayId` na mão e não deve criar dia
 * nenhum. O que importa é que **todo caminho que escreve o dia passa por este
 * lock antes de ler os fatos**: sem isso, duas aprovações concorrentes leem o
 * mesmo estado e cada uma grava uma correção cega para a outra.
 *
 * A ordem é sempre a mesma — dia primeiro, depois a linha do pedido — e é ela
 * que mantém o módulo livre de deadlock entre bater ponto, pedir e decidir.
 */
async function lockWorkdayById(
  tx: Prisma.TransactionClient,
  companyId: string,
  workdayId: string,
): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "workdays"
    WHERE "id" = ${workdayId} AND "companyId" = ${companyId}
    FOR UPDATE
  `;
  if (!rows[0]) {
    throw notFound("Jornada não encontrada.");
  }
}

async function companyTimezone(
  tx: Prisma.TransactionClient,
  companyId: string,
): Promise<string> {
  const company = await tx.company.findUnique({
    where: { id: companyId },
    select: { timezone: true },
  });
  return resolveTimezone(company?.timezone);
}

/**
 * Registra uma marcação de ponto.
 *
 * `companyId` e `userId` vêm do PRINCIPAL autenticado — nunca do corpo. É a
 * mesma regra de tenant do resto do sistema, e aqui ela também é regra de
 * identidade: ninguém bate ponto por outra pessoa.
 */
export async function punchTimeClock(
  companyId: string,
  userId: string,
  input: PunchInput,
): Promise<{ entry: PublicTimeEntry; workday: WorkdayView }> {
  const position = normalizePosition(input);

  /*
    O instante é lido UMA vez, no servidor, e é o que vale.

    Lê-lo dentro da transação e de novo na projeção faria a marcação e o dia
    serem calculados sobre relógios diferentes — e uma batida à meia-noite
    poderia cair em dois dias distintos na mesma requisição.
  */
  const occurredAt = new Date();

  const created = await prisma.$transaction(async (tx) => {
    /*
      A pertinência é conferida AQUI, e não só em quem chama.

      As rotas derivam empresa e usuário do mesmo principal, então nenhum
      caminho de produção consegue desalinhá-los hoje. Sem esta conferência,
      porém, a função aceita o par (empresa B, usuário da A) e grava uma jornada
      atravessada — encontrado no ataque próprio a este módulo, e corrigido
      antes de existir a rota que o exploraria (uma tela de quiosque, um "bater
      por outra pessoa" no painel).

      É a mesma disciplina de `getMemberWorkdayView`, que já conferia.
    */
    const member = await tx.user.findFirst({
      where: { id: userId, companyId },
      select: { id: true },
    });
    if (!member) {
      throw notFound("Funcionário não encontrado.");
    }

    const timezone = await companyTimezone(tx, companyId);
    const date = workdayDateOf(occurredAt, timezone);
    const workday = await lockWorkday(tx, companyId, userId, date, timezone);

    /*
      A batida é governada pela sequência EFETIVA, nunca pelo histórico bruto.

      Uma correção aprovada supera a marcação antiga sem apagá-la, e a linha
      superada continua na tabela. Derivando o estado do bruto, o servidor
      mostrava a jornada encerrada e ainda assim aceitava um retorno de
      intervalo — porque a última linha POR HORÁRIO era um início de intervalo
      já superado. Espelho e escrita liam dias diferentes.

      Mesma função do espelho, mesma resposta.
    */
    const efetivas = await loadEffectiveEntries(tx, companyId, workday.id);

    assertTransitionAllowed(
      deriveWorkdayState(efetivas.map((e) => e.type)),
      input.type,
    );

    /*
      O técnico é resolvido no SERVIDOR.

      `technicianId` vindo do cliente nunca prova identidade — a regra é do
      CLAUDE.md e vale aqui igual. O chamador passa o que a sessão já provou;
      nada além disso entra.
    */
    return tx.timeEntry.create({
      data: {
        companyId,
        userId,
        workdayId: workday.id,
        technicianId: input.technicianId ?? null,
        mobileDeviceId: input.mobileDeviceId ?? null,
        type: input.type,
        source: input.source ?? "FIELD_APP",
        occurredAt,
        deviceOccurredAt: input.deviceOccurredAt ?? null,
        latitude: position.latitude,
        longitude: position.longitude,
        accuracyMeters: position.accuracyMeters,
      },
    });
  });

  /*
    Sem AuditLog por batida, e é deliberado.

    `TimeEntry` já É o histórico operacional imutável — auditar cada marcação
    duplicaria a mesma linha em duas tabelas e afogaria o AuditLog, que existe
    para ação ADMINISTRATIVA. O que ganha AuditLog é a decisão de ajuste, que é
    onde alguém exerce poder sobre o registro de outra pessoa (§229).
  */

  return {
    entry: toPublicEntry(created),
    workday: await getWorkdayView(companyId, userId, created.occurredAt),
  };
}

/**
 * Marcações SUPERADAS por uma correção aprovada.
 *
 * Corrigir o horário de uma marcação existente cria uma linha nova e deixa a
 * original intacta (§229) — que é a regra. Se as duas contassem, o dia teria
 * duas entradas e a sequência viraria impossível.
 *
 * A original não é apagada nem editada: ela sai da **visão efetiva**, e continua
 * no histórico para quem quiser reconstruir o que foi batido, o que foi pedido e
 * quem decidiu. É o que o PRD §229 chama de "o espelho calcula a visão efetiva
 * considerando marcações mais ajustes aprovados".
 */
async function supersededEntryIds(
  client: Prisma.TransactionClient,
  companyId: string,
  workdayIds: readonly string[],
): Promise<Set<string>> {
  if (workdayIds.length === 0) return new Set();
  const rows = await client.timeAdjustmentRequest.findMany({
    where: {
      companyId,
      status: "APPROVED",
      workdayId: { in: [...workdayIds] },
      targetEntryId: { not: null },
    },
    select: { targetEntryId: true },
  });
  return new Set(rows.map((r) => r.targetEntryId as string));
}

/**
 * As marcações efetivas de um dia, já em ordem.
 *
 * **É por aqui que passa toda leitura que decide alguma coisa** — estado, ação
 * permitida, sequência válida, espelho. Recebe o cliente para que a decisão de
 * um ajuste leia os fatos DENTRO da sua transação, depois do lock: ler pelo
 * cliente global veria um instantâneo de fora da transação, que é justamente o
 * que o lock existe para impedir.
 */
async function loadEffectiveEntries(
  client: Prisma.TransactionClient,
  companyId: string,
  workdayId: string,
): Promise<TimeEntry[]> {
  const [todas, superadas] = await Promise.all([
    client.timeEntry.findMany({ where: { workdayId, companyId } }),
    supersededEntryIds(client, companyId, [workdayId]),
  ]);
  return resolveEffectiveTimeEntries(todas, superadas);
}

/**
 * Espelho de um dia: marcações, estado, totais e inconsistências.
 *
 * **As horas são calculadas aqui, no servidor.** O aplicativo apresenta o que
 * recebe; um cálculo no cliente seria uma segunda contabilidade, e a que
 * divergisse primeiro seria a que ninguém revisou.
 */
export async function getWorkdayView(
  companyId: string,
  userId: string,
  instant: Date = new Date(),
): Promise<WorkdayView> {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { timezone: true },
  });
  const timezone = resolveTimezone(company?.timezone);
  const date = workdayDateOf(instant, timezone);

  const workday = await prisma.workday.findFirst({
    where: { companyId, userId, date },
    select: { id: true, timezone: true },
  });

  /*
    Meio-dia UTC como âncora do deslocamento.

    O deslocamento é do INSTANTE, não do fuso, então precisa de um instante — e
    ele tem de cair dentro do dia civil em qualquer fuso plausível. Meia-noite
    UTC cairia no dia anterior em toda a América, e o dia da virada de horário
    de verão devolveria o deslocamento errado. Meio-dia é o mesmo ponto de
    ancoragem que a página do gestor já usa.
  */
  const offsetAnchor = new Date(
    `${date.toISOString().slice(0, 10)}T12:00:00.000Z`,
  );

  if (!workday) {
    return {
      workdayId: null,
      date: date.toISOString().slice(0, 10),
      timezone,
      utcOffset: utcOffsetIn(offsetAnchor, timezone),
      state: "NOT_STARTED",
      allowedActions: allowedTransitions("NOT_STARTED"),
      entries: [],
      workedMinutes: 0,
      breakMinutes: 0,
      inconsistencies: [],
      pendingAdjustments: 0,
    };
  }

  const [entries, pendingAdjustments] = await Promise.all([
    loadEffectiveEntries(prisma, companyId, workday.id),
    prisma.timeAdjustmentRequest.count({
      where: { workdayId: workday.id, companyId, status: "PENDING" },
    }),
  ]);

  const totals = summarize(entries);

  return {
    workdayId: workday.id,
    date: date.toISOString().slice(0, 10),
    timezone: workday.timezone,
    // Do fuso GRAVADO no dia, não do atual da empresa: um dia antigo continua
    // sendo lido com o fuso sob o qual foi vivido.
    utcOffset: utcOffsetIn(offsetAnchor, resolveTimezone(workday.timezone)),
    state: totals.state,
    allowedActions: allowedTransitions(totals.state),
    entries: entries.map(toPublicEntry),
    workedMinutes: totals.workedMinutes,
    breakMinutes: totals.breakMinutes,
    inconsistencies: totals.inconsistencies,
    pendingAdjustments,
  };
}

/**
 * Percorre a sequência uma vez e devolve estado, totais e o que não fecha.
 *
 * Jornada aberta conta até AGORA — é o que o painel do gestor precisa mostrar
 * de quem ainda está trabalhando. Intervalo aberto não é somado a nada: ele
 * ainda não tem duração.
 */
function summarize(
  entries: readonly Pick<TimeEntry, "type" | "occurredAt">[],
): {
  state: WorkdayState;
  workedMinutes: number;
  breakMinutes: number;
  inconsistencies: string[];
} {
  const inconsistencies: string[] = [];
  let workedMs = 0;
  let breakMs = 0;
  let workingSince: Date | null = null;
  let breakSince: Date | null = null;

  for (const entry of entries) {
    switch (entry.type) {
      case "CLOCK_IN":
        workingSince = entry.occurredAt;
        break;
      case "BREAK_START":
        if (workingSince) {
          workedMs += entry.occurredAt.getTime() - workingSince.getTime();
          workingSince = null;
        }
        breakSince = entry.occurredAt;
        break;
      case "BREAK_END":
        if (breakSince) {
          breakMs += entry.occurredAt.getTime() - breakSince.getTime();
          breakSince = null;
        }
        workingSince = entry.occurredAt;
        break;
      case "CLOCK_OUT":
        if (workingSince) {
          workedMs += entry.occurredAt.getTime() - workingSince.getTime();
          workingSince = null;
        }
        break;
    }
  }

  const state = deriveWorkdayState(entries.map((e) => e.type));

  if (state === "WORKING" && workingSince) {
    workedMs += Date.now() - workingSince.getTime();
  }
  if (state === "ON_BREAK") {
    inconsistencies.push("Intervalo em aberto.");
  }
  if (state === "WORKING") {
    inconsistencies.push("Jornada em aberto.");
  }

  return {
    state,
    workedMinutes: Math.max(0, Math.round(workedMs / 60_000)),
    breakMinutes: Math.max(0, Math.round(breakMs / 60_000)),
    inconsistencies,
  };
}

export interface WorkdaySummary {
  date: string;
  state: WorkdayState;
  workedMinutes: number;
  breakMinutes: number;
  entryCount: number;
  pendingAdjustments: number;
}

/** Histórico do próprio funcionário, por intervalo de datas. */
export async function getWorkdayHistory(
  companyId: string,
  userId: string,
  from: Date,
  to: Date,
): Promise<WorkdaySummary[]> {
  const workdays = await prisma.workday.findMany({
    where: { companyId, userId, date: { gte: from, lte: to } },
    orderBy: { date: "desc" },
    select: {
      id: true,
      date: true,
      entries: {
        select: { id: true, type: true, occurredAt: true },
        orderBy: { occurredAt: "asc" },
      },
    },
  });

  const pending = await prisma.timeAdjustmentRequest.groupBy({
    by: ["workdayId"],
    where: {
      companyId,
      userId,
      status: "PENDING",
      workdayId: { in: workdays.map((w) => w.id) },
    },
    _count: { _all: true },
  });
  const pendingByWorkday = new Map(
    pending.map((p) => [p.workdayId, p._count._all]),
  );

  const superadas = await supersededEntryIds(
    prisma,
    companyId,
    workdays.map((w) => w.id),
  );

  return workdays.map((workday) => {
    const efetivas = resolveEffectiveTimeEntries(workday.entries, superadas);
    const totals = summarize(efetivas);
    return {
      date: workday.date.toISOString().slice(0, 10),
      state: totals.state,
      workedMinutes: totals.workedMinutes,
      breakMinutes: totals.breakMinutes,
      entryCount: efetivas.length,
      pendingAdjustments: pendingByWorkday.get(workday.id) ?? 0,
    };
  });
}

// ---------------------------------------------------------------------------
// Ajustes
// ---------------------------------------------------------------------------

export interface AdjustmentInput {
  requestedType: TimeAdjustmentType;
  requestedEntryType: TimeEntryType;
  requestedOccurredAt: Date;
  reason: string;
  notes?: string | null;
  targetEntryId?: string | null;
}

export interface PublicAdjustment {
  id: string;
  status: TimeAdjustmentStatus;
  /**
   * De QUEM e a jornada.
   *
   * Distinto de `requestedByName` desde que o gestor tambem pode abrir o
   * pedido: sem este campo, a fila mostraria o nome do ADMIN no lugar do
   * funcionario, e quem decide nao saberia sobre qual jornada esta decidindo.
   */
  userName: string;
  /**
   * De quem é a jornada, e quem abriu o pedido.
   *
   * Os NOMES servem para exibir; estes dois ids servem para DECIDIR. A fila do
   * gestor precisa saber se o pedido diante dele é aquele que ele mesmo abriu
   * para a própria jornada — o caso que `decideTimeAdjustment` recusa — e
   * comparar nomes seria comparar homônimos.
   *
   * São ids da MESMA empresa de quem lê (toda consulta filtra por `companyId`)
   * e não saem no DTO do Field, que monta o seu próprio objeto.
   */
  userId: string;
  requestedById: string;
  requestedType: TimeAdjustmentType;
  requestedEntryType: TimeEntryType;
  requestedOccurredAt: Date;
  reason: string;
  notes: string | null;
  targetEntryId: string | null;
  workdayDate: string;
  requestedByName: string;
  decidedByName: string | null;
  decidedAt: Date | null;
  decisionReason: string | null;
  createdAt: Date;
}

function trimTo(value: string | null | undefined, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, max) : null;
}

/**
 * Abre um pedido de correção.
 *
 * **O funcionário não edita a marcação** (§229). Ele descreve o que aconteceu,
 * e alguém com autoridade decide. O pedido é a prova: sem ele existiria uma
 * alteração sem motivo declarado e sem contraditório.
 */
export async function requestTimeAdjustment(
  companyId: string,
  userId: string,
  input: AdjustmentInput,
  requestedById?: string,
): Promise<PublicAdjustment> {
  /*
    Quem PEDE nem sempre é a pessoa da jornada.

    O técnico abre o pedido pelo Field, e aí os dois são o mesmo. O gestor abre
    pelo painel, em nome de quem esqueceu de bater — e aí o autor é ele. Um
    campo só para os dois casos mantém UMA fila e UM caminho de aprovação: o
    pedido do painel entra no mesmo `decideTimeAdjustment`, com a mesma
    validação de sequência e o mesmo lock. Um segundo caminho "administrativo"
    seria justamente o atalho que o §229 existe para não ter.

    O gestor continua não editando marcação nenhuma: ele PEDE, e a decisão é
    fato separado e auditável.
  */
  const author = requestedById ?? userId;
  const reason = trimTo(input.reason, ADJUSTMENT_REASON_MAX);
  if (!reason) {
    throw badRequest("Descreva o motivo da correção.");
  }
  if (Number.isNaN(input.requestedOccurredAt.getTime())) {
    throw badRequest("Horário solicitado inválido.");
  }
  if (input.requestedOccurredAt.getTime() > Date.now()) {
    // Corrigir o passado é o propósito; "corrigir" o futuro seria agendar uma
    // jornada que ninguém cumpriu ainda.
    throw badRequest("O horário solicitado não pode estar no futuro.");
  }

  const created = await prisma.$transaction(async (tx) => {
    /*
      Pertinência ANTES de abrir o dia — a mesma defesa em profundidade da
      batida, pelo mesmo motivo.

      As rotas derivam empresa e usuário do mesmo principal, então nenhum
      caminho de produção consegue desalinhá-los hoje. Sem esta conferência,
      porém, a função aceita o par (empresa B, usuário da A) e `lockWorkday`
      CRIA uma jornada atravessada antes de qualquer outra validação — dado
      cross-tenant nascido de um efeito colateral.
    */
    const member = await tx.user.findFirst({
      where: { id: userId, companyId },
      select: { id: true },
    });
    if (!member) {
      throw notFound("Funcionário não encontrado.");
    }

    /*
      E o AUTOR também é conferido, pelo mesmo motivo.

      Sem isto, um pedido da empresa A poderia nascer assinado por alguém da
      empresa B — dado cross-tenant gravado numa FK, que nenhuma leitura
      posterior desfaz.
    */
    if (author !== userId) {
      const requester = await tx.user.findFirst({
        where: { id: author, companyId },
        select: { id: true },
      });
      if (!requester) {
        throw notFound("Funcionário não encontrado.");
      }
    }

    const timezone = await companyTimezone(tx, companyId);
    const date = workdayDateOf(input.requestedOccurredAt, timezone);
    const workday = await lockWorkday(tx, companyId, userId, date, timezone);

    if (input.targetEntryId) {
      /*
        O alvo tem de ser DA PESSOA e DO DIA.

        Sem esta conferência, `targetEntryId` viraria ponteiro para qualquer
        linha da tabela: bastaria mandar o id da marcação de um colega para
        abrir um pedido sobre a jornada dele.
      */
      const target = await tx.timeEntry.findFirst({
        where: {
          id: input.targetEntryId,
          companyId,
          userId,
          workdayId: workday.id,
        },
        select: { id: true },
      });
      if (!target) {
        throw notFound("Marcação não encontrada nesta jornada.");
      }

      /*
        E tem de ser a versão VIGENTE.

        Corrigir de novo é legítimo — o sistema não pode ficar preso depois da
        primeira correção. O que não é legítimo é apontar para a versão já
        superada: aprovar isso daria ao mesmo fato duas versões efetivas. A
        recusa já aqui poupa o pedido de morrer na mesa do gestor, e a decisão
        confere de novo, sob lock, porque entre pedir e decidir o mundo anda.
      */
      const efetivas = await loadEffectiveEntries(tx, companyId, workday.id);
      if (!efetivas.some((e) => e.id === input.targetEntryId)) {
        throw conflict(
          "Esta marcação já foi corrigida. Peça a correção sobre a marcação que está valendo.",
        );
      }
    }

    return tx.timeAdjustmentRequest.create({
      data: {
        companyId,
        userId,
        workdayId: workday.id,
        targetEntryId: input.targetEntryId ?? null,
        requestedType: input.requestedType,
        requestedEntryType: input.requestedEntryType,
        requestedOccurredAt: input.requestedOccurredAt,
        reason,
        notes: trimTo(input.notes, ADJUSTMENT_NOTES_MAX),
        requestedById: author,
      },
      include: {
        workday: { select: { date: true } },
        user: { select: { name: true } },
        requestedBy: { select: { name: true } },
        decidedBy: { select: { name: true } },
      },
    });
  });

  return toPublicAdjustment(created);
}

function toPublicAdjustment(row: {
  id: string;
  status: TimeAdjustmentStatus;
  userId: string;
  requestedById: string;
  user: { name: string };
  requestedType: TimeAdjustmentType;
  requestedEntryType: TimeEntryType;
  requestedOccurredAt: Date;
  reason: string;
  notes: string | null;
  targetEntryId: string | null;
  decidedAt: Date | null;
  decisionReason: string | null;
  createdAt: Date;
  workday: { date: Date };
  requestedBy: { name: string };
  decidedBy: { name: string } | null;
}): PublicAdjustment {
  return {
    id: row.id,
    status: row.status,
    userId: row.userId,
    requestedById: row.requestedById,
    userName: row.user.name,
    requestedType: row.requestedType,
    requestedEntryType: row.requestedEntryType,
    requestedOccurredAt: row.requestedOccurredAt,
    reason: row.reason,
    notes: row.notes,
    targetEntryId: row.targetEntryId,
    workdayDate: row.workday.date.toISOString().slice(0, 10),
    requestedByName: row.requestedBy.name,
    decidedByName: row.decidedBy?.name ?? null,
    decidedAt: row.decidedAt,
    decisionReason: row.decisionReason,
    createdAt: row.createdAt,
  };
}

/** Pedidos do próprio funcionário. */
export async function listOwnAdjustments(
  companyId: string,
  userId: string,
  limit = 50,
): Promise<PublicAdjustment[]> {
  const rows = await prisma.timeAdjustmentRequest.findMany({
    where: { companyId, userId },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: {
      workday: { select: { date: true } },
      user: { select: { name: true } },
      requestedBy: { select: { name: true } },
      decidedBy: { select: { name: true } },
    },
  });
  return rows.map(toPublicAdjustment);
}

/** Fila do gestor. */
export async function listCompanyAdjustments(
  companyId: string,
  status: TimeAdjustmentStatus | null = "PENDING",
  limit = 100,
): Promise<PublicAdjustment[]> {
  const rows = await prisma.timeAdjustmentRequest.findMany({
    where: { companyId, ...(status ? { status } : {}) },
    orderBy: { createdAt: "asc" },
    take: limit,
    include: {
      workday: { select: { date: true } },
      user: { select: { name: true } },
      requestedBy: { select: { name: true } },
      decidedBy: { select: { name: true } },
    },
  });
  return rows.map(toPublicAdjustment);
}

/**
 * Decide um pedido.
 *
 * ## A aprovação NÃO edita a marcação original
 *
 * Ela cria uma marcação DERIVADA, com `source = ADJUSTMENT`, apontando para o
 * pedido. O espelho passa a somar a nova; a original continua lá, e o histórico
 * mostra o que foi batido, o que foi pedido, por quem e quem decidiu.
 *
 * Um `UPDATE` na linha original seria mais simples e destruiria exatamente o
 * que o registro existe para preservar (§229).
 */
export async function decideTimeAdjustment(
  companyId: string,
  deciderUserId: string,
  requestId: string,
  decision: "APPROVED" | "REJECTED",
  decisionReason?: string | null,
): Promise<PublicAdjustment> {
  const decided = await prisma.$transaction(async (tx) => {
    /*
      Quem DECIDE tem de ser da empresa — a mesma defesa em profundidade que
      `punchTimeClock` e `requestTimeAdjustment` já fazem.

      Nenhuma rota consegue desalinhar o par hoje: a rota de decisão tira
      empresa e decisor da MESMA sessão. Sem esta conferência, porém, a função
      aceita (empresa A, decisor da B) e grava um `decidedById` atravessado na
      linha da A — mais um `AuditLog` com o par trocado. Autoridade sobre o
      registro de jornada de outra pessoa é exatamente onde essa lacuna não
      pode ficar aberta esperando a primeira rota nova.

      404, e não 403: a resposta é indistinguível de "pedido inexistente", e um
      id sondado não aprende nada com ela.
    */
    const decider = await tx.user.findFirst({
      where: { id: deciderUserId, companyId },
      select: { id: true },
    });
    if (!decider) {
      throw notFound("Solicitação não encontrada.");
    }

    const head = await tx.timeAdjustmentRequest.findFirst({
      where: { id: requestId, companyId },
      select: { workdayId: true },
    });
    if (!head) {
      throw notFound("Solicitação não encontrada.");
    }

    /*
      TRAVA O DIA, e não só o pedido.

      `updateMany(status = PENDING)` arbitra duas decisões sobre o MESMO
      pedido — e só isso. O problema real são pedidos DIFERENTES sobre o mesmo
      dia: cada um reivindica a sua própria linha sem incomodar o outro, os dois
      leem o mesmo estado e os dois gravam, cegos um para o outro. Dois ajustes
      da mesma marcação viravam duas versões efetivas do mesmo fato.

      Travado o dia, a segunda decisão espera, relê o que a primeira deixou e
      decide sobre a realidade — aprovando, se a combinação fecha, e recusando
      se não fecha.

      O lock é o PRIMEIRO passo da escrita, aqui como na batida. Ordem única de
      aquisição é o que mantém o módulo livre de deadlock.
    */
    await lockWorkdayById(tx, companyId, head.workdayId);

    /*
      O pedido é relido JÁ SOB LOCK.

      A leitura de fora do lock serve para achar o dia, e mais nada: entre ela e
      o lock, outra decisão pode ter concluído. Reler aqui é o que garante que
      um pedido já decidido pare ANTES de qualquer escrita — sem isso, a
      aprovação em duplicata chegaria a tentar criar a segunda marcação derivada
      e bateria na unique de `adjustmentRequestId`, transformando um conflito
      previsível num erro de banco.
    */
    const request = await tx.timeAdjustmentRequest.findFirstOrThrow({
      where: { id: requestId, companyId },
      select: {
        id: true,
        userId: true,
        requestedById: true,
        workdayId: true,
        status: true,
        targetEntryId: true,
        requestedEntryType: true,
        requestedOccurredAt: true,
      },
    });
    if (request.status !== "PENDING") {
      throw conflict("Esta solicitação já foi decidida.");
    }

    /*
      NINGUÉM DECIDE O PEDIDO QUE ABRIU PARA A PRÓPRIA JORNADA.

      Abrir continua permitido: um ADMIN que esqueceu de bater precisa poder
      registrar o que houve, e proibir isso só o empurraria para o `UPDATE`
      direto na marcação — exatamente o que o módulo existe para impedir
      (§229). O que ele não pode é fechar o ciclo sozinho.

      A regra é a CONJUNÇÃO das duas condições, e as duas importam:

      - `requestedById === deciderUserId` sem a segunda seria proibir o gestor
        de aprovar a correção que ele mesmo abriu para um funcionário — que é o
        caminho normal do painel (§231) e não tem conflito de interesse: quem
        se beneficia é outra pessoa.
      - `userId === deciderUserId` sem a primeira seria proibir o ADMIN de
        decidir um pedido que um COLEGA abriu sobre a jornada dele. Aí já
        existe contraditório: duas pessoas participaram do fato.

      Juntas, elas descrevem o único caso em que uma pessoa é, ao mesmo tempo,
      autora, beneficiária e autoridade — e é só esse que a Fase 1 fecha.

      403, e não 404: o pedido existe, é da empresa e quem pediu tem todo o
      direito de vê-lo na fila. Esconder a existência aqui não protege nada e
      faria a tela mentir sobre um registro que ela acabou de listar.

      A checagem vem DEPOIS do lock e da releitura, e ANTES de qualquer
      escrita: nada de `TimeEntry` derivada, nada de `updateMany` no pedido e
      nada de `AuditLog` — a tentativa recusada não deixa rastro de decisão
      porque decisão nenhuma houve.
    */
    if (
      request.requestedById === deciderUserId &&
      request.userId === deciderUserId
    ) {
      throw forbidden(
        "Outra pessoa autorizada deve decidir esta correção de jornada.",
      );
    }

    if (decision === "APPROVED") {
      /*
        A correção não pode produzir um dia impossível.

        A batida entra sempre no FIM do dia, e validar contra o estado atual
        basta. A correção entra no MEIO: um `CLOCK_OUT` pedido para antes do
        `CLOCK_IN` gravaria um fato que a sequência não sustenta, e o espelho
        mostraria a pessoa "trabalhando" depois de ter saído.

        A conferência é sobre a sequência EFETIVA resultante, ordenada por
        horário — não sobre o histórico bruto e não sobre a ordem em que as
        linhas foram criadas.

        Somando o bruto, a segunda correção legítima do dia era recusada: a
        entrada antiga, já superada pela primeira aprovação, continuava contando
        e a sequência aparecia com duas entradas. Quem errasse duas marcações no
        mesmo dia só conseguia corrigir a primeira.
      */
      const efetivas = await loadEffectiveEntries(
        tx,
        companyId,
        request.workdayId,
      );

      /*
        O alvo precisa continuar VIGENTE.

        Se outra decisão já superou esta marcação, aprovar aqui daria ao mesmo
        fato duas versões efetivas — e nem sempre a gramática do dia denuncia
        isso: "a entrada era às 12h" e "aquilo era início de intervalo" produzem,
        cada uma, um dia perfeitamente legal. Quem impede é esta regra, não a
        sequência.

        A conferência do pedido é UX; esta, sob lock, é a autoridade.
      */
      if (
        request.targetEntryId &&
        !efetivas.some((e) => e.id === request.targetEntryId)
      ) {
        throw conflict(
          "Esta marcação já foi corrigida por outra solicitação. Reavalie o pedido.",
        );
      }

      const resulting = resolveEffectiveTimeEntries(
        [
          ...efetivas.filter((e) => e.id !== request.targetEntryId),
          {
            // Id sintético: a marcação ainda não existe, e só participa da
            // ordenação. Prefixo impossível para um cuid, para não colidir.
            id: `~novo-${request.id}`,
            type: request.requestedEntryType,
            occurredAt: request.requestedOccurredAt,
          },
        ],
        new Set<string>(),
      ).map((e) => e.type);

      if (!isValidSequence(resulting)) {
        throw badRequest(
          "Aprovar esta correção deixaria a jornada do dia inconsistente. " +
            "Confira o horário solicitado.",
        );
      }

      await tx.timeEntry.create({
        data: {
          companyId,
          userId: request.userId,
          workdayId: request.workdayId,
          type: request.requestedEntryType,
          source: "ADJUSTMENT",
          occurredAt: request.requestedOccurredAt,
          adjustmentRequestId: request.id,
        },
      });
    }

    /*
      A decisão é gravada por ÚLTIMO, e com o status no predicado.

      Por último porque a marcação derivada precisa nascer da realidade
      validada: marcar o pedido antes fazia a própria decisão em andamento
      aparecer como uma correção já aprovada, e o alvo dela era descartado do
      dia por causa dela mesma.

      Com o predicado porque o lock ordena, mas é este `updateMany` que diz que
      um pedido só é decidido UMA vez — a regra continua verdadeira mesmo que um
      caminho futuro chegue aqui sem passar pelo lock.
    */
    const claimed = await tx.timeAdjustmentRequest.updateMany({
      where: { id: request.id, companyId, status: "PENDING" },
      data: {
        status: decision,
        decidedById: deciderUserId,
        decidedAt: new Date(),
        decisionReason: trimTo(decisionReason, ADJUSTMENT_REASON_MAX),
      },
    });
    if (claimed.count !== 1) {
      throw conflict("Esta solicitação já foi decidida.");
    }

    return tx.timeAdjustmentRequest.findFirstOrThrow({
      where: { id: request.id, companyId },
      include: {
        workday: { select: { date: true } },
        user: { select: { name: true } },
        requestedBy: { select: { name: true } },
        decidedBy: { select: { name: true } },
      },
    });
  });

  /*
    ESTA ação é administrativa, e por isso ganha AuditLog.

    Batida não ganha (é o próprio histórico); decisão sobre a jornada de outra
    pessoa ganha, porque é exercício de autoridade sobre o registro alheio.
  */
  await logAudit({
    companyId,
    userId: deciderUserId,
    action:
      decision === "APPROVED"
        ? "TIME_ADJUSTMENT.APPROVED"
        : "TIME_ADJUSTMENT.REJECTED",
    entity: "TimeAdjustmentRequest",
    entityId: decided.id,
    details: `Solicitação de ${decided.requestedEntryType} em ${decided.workday.date
      .toISOString()
      .slice(0, 10)} ${decision === "APPROVED" ? "aprovada" : "rejeitada"}`,
  });

  return toPublicAdjustment(decided);
}

// ---------------------------------------------------------------------------
// Visão do gestor
// ---------------------------------------------------------------------------

export interface TeamMemberWorkday {
  userId: string;
  userName: string;
  technicianId: string | null;
  state: WorkdayState;
  lastEntryType: TimeEntryType | null;
  lastEntryAt: Date | null;
  workedMinutes: number;
  pendingAdjustments: number;
}

/**
 * Quem está trabalhando agora, na empresa inteira.
 *
 * `NOT_STARTED` inclui quem não abriu o dia — por isso a lista parte dos
 * USUÁRIOS ativos, e não das jornadas existentes. Uma consulta que partisse de
 * `Workday` mostraria só quem bateu, e "não iniciou" é justamente o estado que
 * o gestor precisa ver.
 */
export async function getTeamWorkday(
  companyId: string,
  instant: Date = new Date(),
): Promise<{ date: string; timezone: string; members: TeamMemberWorkday[] }> {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { timezone: true },
  });
  const timezone = resolveTimezone(company?.timezone);
  const date = workdayDateOf(instant, timezone);

  const users = await prisma.user.findMany({
    where: { companyId, active: true },
    select: {
      id: true,
      name: true,
      technicians: { select: { id: true }, take: 1 },
    },
    orderBy: { name: "asc" },
  });

  const workdays = await prisma.workday.findMany({
    where: { companyId, date },
    select: {
      id: true,
      userId: true,
      entries: {
        select: { id: true, type: true, occurredAt: true },
        orderBy: { occurredAt: "asc" },
      },
    },
  });
  const byUser = new Map(workdays.map((w) => [w.userId, w]));
  const superadas = await supersededEntryIds(
    prisma,
    companyId,
    workdays.map((w) => w.id),
  );

  const pending = await prisma.timeAdjustmentRequest.groupBy({
    by: ["userId"],
    where: { companyId, status: "PENDING" },
    _count: { _all: true },
  });
  const pendingByUser = new Map(pending.map((p) => [p.userId, p._count._all]));

  const members = users.map((user) => {
    const workday = byUser.get(user.id);
    const entries = resolveEffectiveTimeEntries(
      workday?.entries ?? [],
      superadas,
    );
    const totals = summarize(entries);
    const last = entries.at(-1) ?? null;

    return {
      userId: user.id,
      userName: user.name,
      technicianId: user.technicians[0]?.id ?? null,
      state: totals.state,
      lastEntryType: last?.type ?? null,
      lastEntryAt: last?.occurredAt ?? null,
      workedMinutes: totals.workedMinutes,
      pendingAdjustments: pendingByUser.get(user.id) ?? 0,
    };
  });

  return { date: date.toISOString().slice(0, 10), timezone, members };
}

/** Espelho de qualquer funcionário da empresa — para o gestor. */
export async function getMemberWorkdayView(
  companyId: string,
  targetUserId: string,
  instant: Date = new Date(),
): Promise<WorkdayView> {
  const member = await prisma.user.findFirst({
    where: { id: targetUserId, companyId },
    select: { id: true },
  });
  if (!member) {
    // 404, não 403: confirmar que o usuário existe noutra empresa seria
    // exatamente o que um id sondado não pode aprender.
    throw notFound("Funcionário não encontrado.");
  }
  return getWorkdayView(companyId, targetUserId, instant);
}
