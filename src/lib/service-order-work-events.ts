import type {
  ContactAttemptChannel,
  ContactAttemptResult,
  ImpedimentReason,
} from "@prisma/client";
import { prisma } from "./prisma";
import { logAudit } from "./audit";
import { badRequest, conflict, isUniqueConstraintError } from "./errors";
import {
  assertValidAccuracy,
  assertValidCoordinate,
  distanceInMeters,
  type Coordinate,
} from "./geo";
import {
  claimOrderForChildMutation,
  loadInProgressOwnedOrder,
} from "./service-order-child-mutation";

/**
 * # Eventos auxiliares do trabalho em campo
 *
 * > A máquina de estados oficial não muda (PRD §167).
 *
 * `PENDING → ASSIGNED → IN_PROGRESS → COMPLETED`, e nada aqui acrescenta um
 * estado principal. Cada estado novo multiplicaria as transições que precisam
 * ser validadas, testadas e auditadas.
 *
 * O que o campo precisa registrar são FATOS que não alteram o estado da OS:
 * chegada, tentativa de contato e impedimento. Eles alimentam tempo
 * operacional e explicam o que aconteceu — sem nunca fechar nem cancelar nada.
 */

export const WORK_EVENT_NOTES_MAX = 500;

// ---------------------------------------------------------------------------
// Check-in
// ---------------------------------------------------------------------------

export interface CheckInInput {
  expectedOrderVersion: number;
  latitude?: number | null;
  longitude?: number | null;
  accuracyMeters?: number | null;
}

export interface CheckInResult {
  id: string;
  checkedInAt: Date;
  /** Distância até o ponto do cliente. `null` quando falta uma das pontas. */
  distanceMeters: number | null;
  hasCoordinate: boolean;
}

/**
 * Registra a chegada do técnico ao local.
 *
 * ## Não confirma a localização do cliente
 *
 * Esta é a fronteira que a §8 da tarefa manda manter, e ela é fácil de apagar
 * sem perceber: seria "conveniente" marcar `CustomerLocation.verified` ao
 * receber um check-in com GPS. Seria também falso. O check-in diz onde o
 * APARELHO estava quando o técnico declarou que chegou; verificar é dizer que
 * uma pessoa conferiu que aquele é o ponto de instalação. Derivar um do outro
 * produziria uma base inteira de coordenadas "verificadas" que ninguém
 * verificou — e faria isso em silêncio, em toda OS.
 *
 * ## Não bloqueia por distância
 *
 * `distanceMeters` é gravado como INFORMAÇÃO. GPS de celular erra dezenas de
 * metros em área urbana densa e falha dentro de prédio — exatamente onde o
 * atendimento acontece. Bloquear o trabalho por uma coordenada imprecisa
 * impediria atendimento real para prevenir uma fraude hipotética (§167). Uma
 * política de proximidade por empresa é trabalho futuro, e continuará sendo
 * decisão do servidor.
 *
 * ## Sem GPS continua valendo
 *
 * Permissão negada, prédio sem sinal ou aparelho sem fix produzem
 * `source = UNAVAILABLE` e um check-in sem coordenada. A chegada é o fato
 * operacional; a coordenada é o detalhe. Recusar o check-in por falta de GPS
 * deixaria o despachante sem a informação que importa.
 */
export async function checkInServiceOrder(
  companyId: string,
  actorUserId: string,
  orderId: string,
  input: CheckInInput,
): Promise<CheckInResult> {
  const accuracyMeters = assertValidAccuracy(input.accuracyMeters);
  let observed: Coordinate | null = null;
  if (
    input.latitude !== null &&
    input.latitude !== undefined &&
    input.longitude !== null &&
    input.longitude !== undefined
  ) {
    observed = assertValidCoordinate(input.latitude, input.longitude);
  }

  const result = await prisma.$transaction(async (tx) => {
    const { technician, order } = await loadInProgressOwnedOrder(
      tx,
      companyId,
      actorUserId,
      orderId,
    );

    const existing = await tx.serviceOrderCheckIn.findFirst({
      where: { serviceOrderId: order.id, companyId },
      select: { id: true },
    });
    if (existing) {
      throw conflict("O check-in desta OS já foi registrado.");
    }

    await claimOrderForChildMutation(
      tx,
      companyId,
      orderId,
      input.expectedOrderVersion,
    );

    let distanceMeters: number | null = null;
    if (observed) {
      const location = await tx.customerLocation.findFirst({
        where: { customerId: order.customerId, companyId },
        select: { latitude: true, longitude: true },
      });
      if (location) {
        distanceMeters = distanceInMeters(observed, {
          latitude: Number(location.latitude),
          longitude: Number(location.longitude),
        });
      }
    }

    let checkIn;
    try {
      checkIn = await tx.serviceOrderCheckIn.create({
        data: {
          companyId,
          serviceOrderId: order.id,
          technicianId: technician.id,
          latitude: observed?.latitude ?? null,
          longitude: observed?.longitude ?? null,
          accuracyMeters,
          // A origem descreve o que aconteceu com o GPS, não o que o app
          // preferia ter enviado.
          source: observed ? "DEVICE_GPS" : "UNAVAILABLE",
          distanceMeters,
        },
      });
    } catch (error) {
      // A unique em `serviceOrderId` é o árbitro final de dois check-ins
      // simultâneos — a leitura acima é conveniência, não a proteção.
      if (!isUniqueConstraintError(error)) throw error;
      throw conflict("O check-in desta OS já foi registrado.");
    }

    await tx.serviceOrderEvent.create({
      data: {
        companyId,
        serviceOrderId: order.id,
        userId: actorUserId,
        event: "CHECKED_IN",
        metadata: {
          technicianId: technician.id,
          hasCoordinate: observed !== null,
          accuracyMeters,
          distanceMeters,
        },
      },
    });

    return {
      id: checkIn.id,
      checkedInAt: checkIn.checkedInAt,
      distanceMeters,
      hasCoordinate: observed !== null,
    };
  });

  await logAudit({
    companyId,
    userId: actorUserId,
    action: "SERVICE_ORDER.CHECKED_IN",
    entity: "ServiceOrderCheckIn",
    entityId: result.id,
    details: result.hasCoordinate
      ? `Check-in com GPS${result.distanceMeters !== null ? ` a ${result.distanceMeters} m do ponto cadastrado` : ""}`
      : "Check-in sem coordenada disponível",
  });

  return result;
}

// ---------------------------------------------------------------------------
// Tentativa de contato
// ---------------------------------------------------------------------------

export interface ContactAttemptInput {
  expectedOrderVersion: number;
  channel: ContactAttemptChannel;
  result: ContactAttemptResult;
  notes?: string | null;
}

/**
 * Registra que o técnico tentou falar com o cliente.
 *
 * Estruturado, e não texto livre: "liguei e não atendeu" numa caixa de
 * observação não é consultável, não vira métrica e não sustenta uma cobrança
 * contestada — que é exatamente o momento em que alguém vai procurar esse dado
 * (§168).
 *
 * `notes` é uma observação curta, NUNCA a transcrição da conversa. Registrar
 * que houve uma ligação é dado operacional; registrar o que foi dito é outra
 * categoria de coisa, com outras obrigações de LGPD (§113).
 */
export async function recordContactAttempt(
  companyId: string,
  actorUserId: string,
  orderId: string,
  input: ContactAttemptInput,
): Promise<{ id: string; attemptedAt: Date }> {
  const notes = input.notes?.trim().slice(0, WORK_EVENT_NOTES_MAX) || null;

  const created = await prisma.$transaction(async (tx) => {
    const { technician, order } = await loadInProgressOwnedOrder(
      tx,
      companyId,
      actorUserId,
      orderId,
    );

    await claimOrderForChildMutation(
      tx,
      companyId,
      orderId,
      input.expectedOrderVersion,
    );

    const attempt = await tx.serviceOrderContactAttempt.create({
      data: {
        companyId,
        serviceOrderId: order.id,
        technicianId: technician.id,
        channel: input.channel,
        result: input.result,
        notes,
      },
    });

    await tx.serviceOrderEvent.create({
      data: {
        companyId,
        serviceOrderId: order.id,
        userId: actorUserId,
        event: "CONTACT_ATTEMPTED",
        metadata: {
          technicianId: technician.id,
          channel: input.channel,
          result: input.result,
        },
      },
    });

    return attempt;
  });

  await logAudit({
    companyId,
    userId: actorUserId,
    action: "SERVICE_ORDER.CONTACT_ATTEMPTED",
    entity: "ServiceOrderContactAttempt",
    entityId: created.id,
    details: `Tentativa de contato (${input.channel} → ${input.result})`,
  });

  return { id: created.id, attemptedAt: created.attemptedAt };
}

// ---------------------------------------------------------------------------
// Impedimento
// ---------------------------------------------------------------------------

export interface ImpedimentInput {
  expectedOrderVersion: number;
  reason: ImpedimentReason;
  notes?: string | null;
}

/**
 * Registra que o atendimento não pôde ser executado.
 *
 * > Impedimento não é conclusão falsa (§169).
 *
 * Sem esta ação o técnico que não conseguiu entrar tem duas saídas: concluir
 * uma OS que não executou, ou deixá-la aberta sem explicação. A primeira
 * corrompe o histórico e o indicador de qualidade; a segunda deixa o
 * despachante cego.
 *
 * **Não muda o status da OS.** Ela continua `IN_PROGRESS`, e quem decide
 * reagendar ou cancelar é a operação, pelos comandos que já existem. Fechar a
 * OS aqui seria justamente a conclusão falsa que o impedimento existe para
 * tornar desnecessária.
 */
export async function recordImpediment(
  companyId: string,
  actorUserId: string,
  orderId: string,
  input: ImpedimentInput,
): Promise<{ id: string; reportedAt: Date }> {
  const notes = input.notes?.trim() || null;
  if (input.reason === "OTHER" && !notes) {
    throw badRequest("Descreva o impedimento.");
  }

  const created = await prisma.$transaction(async (tx) => {
    const { technician, order } = await loadInProgressOwnedOrder(
      tx,
      companyId,
      actorUserId,
      orderId,
    );

    await claimOrderForChildMutation(
      tx,
      companyId,
      orderId,
      input.expectedOrderVersion,
    );

    const impediment = await tx.serviceOrderImpediment.create({
      data: {
        companyId,
        serviceOrderId: order.id,
        technicianId: technician.id,
        reason: input.reason,
        notes: notes?.slice(0, WORK_EVENT_NOTES_MAX) ?? null,
      },
    });

    await tx.serviceOrderEvent.create({
      data: {
        companyId,
        serviceOrderId: order.id,
        userId: actorUserId,
        event: "IMPEDIMENT_REPORTED",
        metadata: { technicianId: technician.id, reason: input.reason },
      },
    });

    return impediment;
  });

  await logAudit({
    companyId,
    userId: actorUserId,
    action: "SERVICE_ORDER.IMPEDIMENT_REPORTED",
    entity: "ServiceOrderImpediment",
    entityId: created.id,
    details: `Impedimento registrado (${input.reason})`,
  });

  return { id: created.id, reportedAt: created.reportedAt };
}
