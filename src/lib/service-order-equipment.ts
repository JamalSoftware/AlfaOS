import { prisma } from "./prisma";
import { logAudit } from "./audit";
import {
  badRequest,
  conflict,
  isUniqueConstraintError,
  notFound,
  uniqueTargetIncludes,
} from "./errors";
import { FieldError } from "./field/errors";
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

  /**
   * Evidência da etiqueta do equipamento. **Obrigatória.**
   *
   * Substituiu a exigência de série ou MAC digitados (v0.10.1). A foto tem de
   * ser da MESMA OS e da categoria `EQUIPMENT_LABEL`; um id de outra ordem, de
   * outra empresa, ou de uma foto de categoria qualquer, é recusado.
   */
  labelEvidenceId: string;
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
  /** Foto da etiqueta que identifica este equipamento. */
  labelEvidenceId: string | null;
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
  labelEvidenceId: string | null;
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
    labelEvidenceId: row.labelEvidenceId,
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
 *
 * ## A identificação passou a ser a FOTO (v0.10.1)
 *
 * Por causa exatamente desse erro, série e MAC deixaram de ser obrigatórios e a
 * foto da etiqueta passou a ser exigida no lugar. A câmera lê o adesivo sem
 * transcrever errado; quem precisar do texto o extrai depois, no escritório,
 * com a imagem na tela.
 *
 * As uniques por empresa continuam valendo para o que FOR preenchido — no
 * Postgres, várias linhas com `NULL` convivem numa unique —, e o técnico segue
 * livre para digitar quando for mais rápido.
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

  /*
    Série e MAC são OPCIONAIS. A identificação vive na foto da etiqueta.

    A regra antiga — "informe ao menos um dos dois" — mandava o técnico
    transcrever à mão, agachado dentro de um armário, o mesmo adesivo que a
    câmera lê sem errar. Trocar digitação por foto reduz o erro na origem; a
    transcrição, quando alguém precisar dela, é feita no escritório com a
    imagem na tela.

    O MAC só é validado quando VEM ALGUMA COISA: campo vazio é ausência, não
    valor inválido, e recusar "" com "Endereço MAC inválido" seria mentir sobre
    o que aconteceu.
  */
  if (macAddress && !MAC_PATTERN.test(macAddress)) {
    throw badRequest("Endereço MAC inválido.");
  }

  // Um instante só para a transação inteira: ler o relógio duas vezes deixaria
  // a etiqueta expirar no meio da própria conferência.
  const now = new Date();

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

    /*
      A foto é conferida DENTRO da transação, contra a OS que está sendo
      escrita.

      Ler o id sem amarrá-lo à ordem e à empresa transformaria o campo num
      ponteiro para qualquer linha da tabela: bastaria mandar o id da etiqueta
      de outro cliente para produzir um equipamento "identificado" por uma foto
      que não é dele. `serviceOrderId` e `companyId` no `where` são o que
      fecham isso — e a categoria é o que impede apontar para a foto do teste
      de velocidade e chamar de etiqueta.
    */
    const label = await tx.serviceOrderEvidence.findFirst({
      where: {
        id: input.labelEvidenceId,
        serviceOrderId: order.id,
        companyId,
        category: "EQUIPMENT_LABEL",
      },
      select: { id: true, status: true, expiresAt: true },
    });
    if (!label) {
      throw badRequest(
        "Anexe a foto da etiqueta do equipamento antes de registrá-lo.",
      );
    }

    /*
      Já promovida significa JÁ USADA.

      Uma etiqueta só sai de `TEMPORARY` quando um equipamento passa a existir
      apontando para ela. Reapresentá-la é tentar identificar um segundo
      aparelho com a prova do primeiro — e aí não haveria como saber, olhando a
      foto, de qual dos dois ela é.
    */
    if (label.status !== "TEMPORARY") {
      throw conflict("Esta foto de etiqueta já identifica outro equipamento.");
    }
    if (label.expiresAt !== null && label.expiresAt.getTime() <= now.getTime()) {
      throw new FieldError(
        "LABEL_EXPIRED",
        "A foto da etiqueta expirou. Fotografe a etiqueta de novo.",
      );
    }

    const existing = await tx.serviceOrderEquipment.count({
      where: { serviceOrderId: order.id, companyId },
    });
    if (existing >= EQUIPMENT_MAX_PER_ORDER) {
      throw badRequest(
        `Limite de ${EQUIPMENT_MAX_PER_ORDER} equipamentos por OS atingido.`,
      );
    }

    let equipment;
    try {
      equipment = await tx.serviceOrderEquipment.create({
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
          labelEvidenceId: label.id,
        },
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      /*
        Duas uniques podem estourar aqui, e a mensagem tem de dizer qual.

        No caminho do Field, quem separa duas tentativas simultâneas é o
        compare-and-set da versão da OS, antes de chegar a esta linha — medido:
        a segunda leva 409 mesmo sem a unique. A unique em `labelEvidenceId` é
        a rede embaixo dela, e vale para qualquer escrita, inclusive as que
        ainda não existem.
      */
      throw conflict(
        uniqueTargetIncludes(error, "labelEvidenceId")
          ? "Esta foto de etiqueta já identifica outro equipamento."
          : "Já existe um equipamento cadastrado com este número de série ou MAC.",
      );
    }

    /*
      PROMOÇÃO — na mesma transação da criação.

      A foto deixa de ser arquivo recebido e passa a ser evidência da OS no
      mesmo commit em que o equipamento nasce. Fora da transação existiria uma
      janela em que o equipamento já existe apontando para uma prova que a
      política de conclusão ainda ignora.

      `updateMany` com `status: TEMPORARY` no filtro, e não `update`: se algo
      tiver promovido esta linha no intervalo, a contagem volta zero e a
      transação inteira é abortada. Nenhum estado intermediário sobrevive.
    */
    const promoted = await tx.serviceOrderEvidence.updateMany({
      where: { id: label.id, companyId, status: "TEMPORARY" },
      data: { status: "COMMITTED", expiresAt: null },
    });
    if (promoted.count !== 1) {
      throw conflict("Esta foto de etiqueta já identifica outro equipamento.");
    }

    /*
      Entra na TIMELINE, e não só no AuditLog.

      Instalar equipamento é fato operacional, não ação administrativa: é o que
      responde "de quem é esta ONU e quem a colocou aqui" três anos depois
      (PRD §181), e quem faz essa pergunta lê a linha do tempo da OS, não a
      auditoria.

      Evidência fotográfica NÃO ganha evento por foto, de propósito: são até
      dez por OS, e dez entradas de "foto anexada" afogariam os fatos que
      importam. Elas continuam no AuditLog, e a contagem entra no evento de
      conclusão — que foi a escolha da v0.4 e continua certa.
    */
    await tx.serviceOrderEvent.create({
      data: {
        companyId,
        serviceOrderId: order.id,
        userId: actorUserId,
        event: "EQUIPMENT_INSTALLED",
        metadata: {
          equipmentType: equipment.equipmentType,
          // Identificadores, nunca dado de pessoa.
          serial: equipment.serial,
          macAddress: equipment.macAddress,
        },
      },
    });

    return equipment;
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
