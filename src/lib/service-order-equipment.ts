import { prisma } from "./prisma";
import { logAudit } from "./audit";
import { badRequest, conflict, isUniqueConstraintError, notFound } from "./errors";
import {
  claimOrderForChildMutation,
  loadInProgressOwnedOrder,
} from "./service-order-child-mutation";

/**
 * # Equipamento instalado no cliente
 *
 * Não confundir com custódia de ferramenta (PRD §210–§223), que não existe
 * nesta versão. Aqui o equipamento SAI da empresa e fica na casa do cliente —
 * e a pergunta que este registro existe para responder é "de quem é esta ONU e
 * quem a colocou aqui", três anos depois (§181).
 *
 * A leitura por QR/código de barras é P0 do Field (§180) e continua permitida:
 * a decisão de NÃO exigir QR (§222) alcança ferramenta e patrimônio cedido ao
 * técnico, e não este caso. Aqui o código já vem de fábrica; na ferramenta,
 * alguém teria de criá-lo e colá-lo. O scanner é conveniência de digitação — o
 * servidor valida o mesmo, venha o serial da câmera ou do teclado.
 */

export const EQUIPMENT_TYPE_MAX = 60;
export const EQUIPMENT_TEXT_MAX = 120;
export const EQUIPMENT_NOTES_MAX = 500;
export const EQUIPMENT_MAX_PER_ORDER = 20;

/**
 * Normaliza serial e MAC para comparação.
 *
 * Maiúsculas e sem separadores: `a1:b2:c3:d4:e5:f6`, `A1-B2-C3-D4-E5-F6` e
 * `a1b2c3d4e5f6` são o MESMO endereço, e a unique do banco compara texto. Sem
 * normalizar, a proteção contra duplicidade seria contornada por quem digitasse
 * com outro separador — que é a variação mais provável entre dois técnicos.
 */
export function normalizeHardwareId(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim().toUpperCase().replace(/[\s:.-]/g, "");
  return cleaned.length > 0 ? cleaned.slice(0, EQUIPMENT_TEXT_MAX) : null;
}

/** MAC-48 depois de normalizado: 12 dígitos hexadecimais. */
const MAC_PATTERN = /^[0-9A-F]{12}$/;

export interface EquipmentInput {
  expectedOrderVersion: number;
  equipmentType: string;
  manufacturer?: string | null;
  model?: string | null;
  serial?: string | null;
  macAddress?: string | null;
  notes?: string | null;
}

export interface PublicEquipment {
  id: string;
  equipmentType: string;
  manufacturer: string | null;
  model: string | null;
  serial: string | null;
  macAddress: string | null;
  notes: string | null;
  createdAt: Date;
}

function toPublicEquipment(row: {
  id: string;
  equipmentType: string;
  manufacturer: string | null;
  model: string | null;
  serial: string | null;
  macAddress: string | null;
  notes: string | null;
  createdAt: Date;
}): PublicEquipment {
  return {
    id: row.id,
    equipmentType: row.equipmentType,
    manufacturer: row.manufacturer,
    model: row.model,
    serial: row.serial,
    macAddress: row.macAddress,
    notes: row.notes,
    createdAt: row.createdAt,
  };
}

function trimTo(value: string | null | undefined, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, max) : null;
}

/**
 * Registra um equipamento instalado durante o atendimento.
 *
 * ## Duplicidade é decidida no servidor
 *
 * `serial` e `macAddress` são únicos por empresa, garantido pelo BANCO. Conferir
 * antes de inserir não bastaria: dois técnicos instalando ao mesmo tempo leriam
 * "não existe" e os dois inseririam. A unique é o árbitro; a consulta prévia
 * existe só para produzir uma mensagem melhor no caso comum.
 *
 * Digitar o serial de uma ONU agachado dentro de um armário é a origem mais
 * comum de equipamento vinculado ao cliente errado (§180) — e o sintoma disso é
 * exatamente o mesmo serial aparecendo em dois clientes.
 */
export async function addServiceOrderEquipment(
  companyId: string,
  actorUserId: string,
  orderId: string,
  input: EquipmentInput,
): Promise<PublicEquipment> {
  const equipmentType = trimTo(input.equipmentType, EQUIPMENT_TYPE_MAX);
  if (!equipmentType) {
    throw badRequest("Informe o tipo do equipamento.");
  }

  const serial = normalizeHardwareId(input.serial);
  const macAddress = normalizeHardwareId(input.macAddress);

  if (macAddress && !MAC_PATTERN.test(macAddress)) {
    throw badRequest("Endereço MAC inválido.");
  }
  if (!serial && !macAddress) {
    // Um equipamento sem nenhum identificador não responde a pergunta que o
    // registro existe para responder, e não pode ser conferido depois.
    throw badRequest("Informe ao menos o número de série ou o endereço MAC.");
  }

  const created = await prisma.$transaction(async (tx) => {
    const { order } = await loadInProgressOwnedOrder(
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

    const existing = await tx.serviceOrderEquipment.count({
      where: { serviceOrderId: order.id, companyId },
    });
    if (existing >= EQUIPMENT_MAX_PER_ORDER) {
      throw badRequest(
        `Limite de ${EQUIPMENT_MAX_PER_ORDER} equipamentos por OS atingido.`,
      );
    }

    try {
      return await tx.serviceOrderEquipment.create({
        data: {
          companyId,
          serviceOrderId: order.id,
          customerId: order.customerId,
          equipmentType,
          manufacturer: trimTo(input.manufacturer, EQUIPMENT_TEXT_MAX),
          model: trimTo(input.model, EQUIPMENT_TEXT_MAX),
          serial,
          macAddress,
          notes: trimTo(input.notes, EQUIPMENT_NOTES_MAX),
          installedByUserId: actorUserId,
        },
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      throw conflict(
        "Já existe um equipamento cadastrado com este número de série ou MAC.",
      );
    }
  });

  await logAudit({
    companyId,
    userId: actorUserId,
    action: "SERVICE_ORDER.EQUIPMENT_INSTALLED",
    entity: "ServiceOrderEquipment",
    entityId: created.id,
    details: `Equipamento ${created.equipmentType} instalado${created.serial ? ` (série ${created.serial})` : ""}`,
  });

  return toPublicEquipment(created);
}

export async function removeServiceOrderEquipment(
  companyId: string,
  actorUserId: string,
  orderId: string,
  equipmentId: string,
  expectedOrderVersion: number,
): Promise<void> {
  const removed = await prisma.$transaction(async (tx) => {
    await loadInProgressOwnedOrder(tx, companyId, actorUserId, orderId);

    const equipment = await tx.serviceOrderEquipment.findFirst({
      where: { id: equipmentId, serviceOrderId: orderId, companyId },
    });
    if (!equipment) {
      throw notFound("Equipamento não encontrado.");
    }

    await claimOrderForChildMutation(
      tx,
      companyId,
      orderId,
      expectedOrderVersion,
    );

    await tx.serviceOrderEquipment.delete({ where: { id: equipment.id } });
    return equipment;
  });

  await logAudit({
    companyId,
    userId: actorUserId,
    action: "SERVICE_ORDER.EQUIPMENT_REMOVED",
    entity: "ServiceOrderEquipment",
    entityId: removed.id,
    details: `Equipamento ${removed.equipmentType} removido da OS`,
  });
}

export async function listServiceOrderEquipment(
  companyId: string,
  orderId: string,
): Promise<PublicEquipment[]> {
  const rows = await prisma.serviceOrderEquipment.findMany({
    where: { serviceOrderId: orderId, companyId },
    orderBy: { createdAt: "asc" },
  });
  return rows.map(toPublicEquipment);
}
