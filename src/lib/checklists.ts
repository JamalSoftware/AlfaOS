import { Prisma } from "@prisma/client";
import type { ChecklistItemType, EvidenceCategory } from "@prisma/client";
import { prisma } from "./prisma";
import { logAudit } from "./audit";
import { badRequest, conflict, notFound } from "./errors";
import {
  claimOrderForChildMutation,
  loadInProgressOwnedOrder,
} from "./service-order-child-mutation";
import type { ExecutionTx } from "./service-orders";

/**
 * # Checklist dinâmico
 *
 * Configurável por `companyId` + `ServiceOrderType` (PRD §165). O AlfaOS é
 * multiempresa: uma empresa que instala câmera e outra que entrega carnê usam o
 * mesmo motor, e o que muda é a CONFIGURAÇÃO do tipo — nunca um `if` por tipo no
 * código, que viraria um arquivo impossível de alterar sem release (§164).
 *
 * ## A regra que é fácil desfazer sem perceber
 *
 * O checklist da OS é um SNAPSHOT, não uma referência. Se a OS apenas apontasse
 * para o template, editar o template mudaria retroativamente o checklist de toda
 * OS já iniciada — inclusive das concluídas. Uma OS fechada em março passaria a
 * exibir uma pergunta criada em agosto, sem resposta, e o relatório de
 * conformidade do passado mudaria sozinho.
 *
 * Por isso `snapshotChecklistForOrder` COPIA as perguntas no `start`, e nada
 * depois disso as altera.
 *
 * ## O app orienta; o backend autoriza
 *
 * O Flutter renderiza o que vem daqui e mostra pendências. Quem decide se a OS
 * pode fechar é `validateServiceOrderCompletion` — um APK antigo em campo, um
 * app modificado ou uma requisição montada à mão passam por cima da validação
 * do cliente (§166).
 */

export const CHECKLIST_LABEL_MAX = 200;
export const CHECKLIST_DESCRIPTION_MAX = 500;
export const CHECKLIST_TEXT_ANSWER_MAX = 2_000;
export const CHECKLIST_MAX_ITEMS = 60;

// ---------------------------------------------------------------------------
// Template — configuração da empresa
// ---------------------------------------------------------------------------

export interface ChecklistItemDefinition {
  label: string;
  description?: string | null;
  type: ChecklistItemType;
  required: boolean;
  options?: string[] | null;
  /** Só para `PHOTO`: qual categoria de evidência satisfaz o item. */
  evidenceCategory?: EvidenceCategory | null;
}

interface NormalizedChecklistItem {
  label: string;
  description: string | null;
  type: ChecklistItemType;
  required: boolean;
  sortOrder: number;
  options: string[] | null;
  evidenceCategory: EvidenceCategory | null;
}

function normalizeDefinition(
  definition: ChecklistItemDefinition,
  index: number,
): NormalizedChecklistItem {
  const label = definition.label.trim();
  if (!label) {
    throw badRequest("Todo item do checklist precisa de um rótulo.");
  }

  let options: string[] | null = null;
  if (definition.type === "SELECT") {
    options = (definition.options ?? [])
      .map((option) => option.trim())
      .filter((option) => option.length > 0);
    if (options.length < 2) {
      // Um "escolha uma" com zero ou uma opção não é uma escolha, e o app não
      // teria o que renderizar.
      throw badRequest(
        `O item "${label}" é de seleção e precisa de pelo menos duas opções.`,
      );
    }
  }

  if (definition.type === "PHOTO" && !definition.evidenceCategory) {
    // Sem categoria, um item de foto não tem como ser validado: a conclusão
    // não saberia QUAL evidência procurar, e o item viraria decorativo.
    throw badRequest(
      `O item "${label}" é de foto e precisa de uma categoria de evidência.`,
    );
  }

  return {
    label: label.slice(0, CHECKLIST_LABEL_MAX),
    description:
      definition.description?.trim().slice(0, CHECKLIST_DESCRIPTION_MAX) || null,
    type: definition.type,
    required: definition.required,
    sortOrder: index,
    options,
    evidenceCategory:
      definition.type === "PHOTO" ? (definition.evidenceCategory ?? null) : null,
  };
}

export interface PutChecklistTemplateInput {
  /** `null` = template padrão da empresa, usado quando o tipo não tem o seu. */
  serviceOrderTypeId: string | null;
  name: string;
  items: ChecklistItemDefinition[];
}

/**
 * Cria ou substitui o template de um tipo.
 *
 * Substituir REESCREVE os itens e incrementa `version`. As OS já iniciadas não
 * são tocadas — as perguntas delas viraram linhas próprias no `start`, e é
 * justamente essa separação que torna seguro editar um template a qualquer
 * momento.
 */
export async function putChecklistTemplate(
  companyId: string,
  actorUserId: string,
  input: PutChecklistTemplateInput,
): Promise<{ templateId: string; version: number; itemCount: number }> {
  const name = input.name.trim();
  if (!name) {
    throw badRequest("Nome do checklist é obrigatório.");
  }
  if (input.items.length === 0) {
    throw badRequest("Um checklist precisa de pelo menos um item.");
  }
  if (input.items.length > CHECKLIST_MAX_ITEMS) {
    throw badRequest(`Um checklist aceita no máximo ${CHECKLIST_MAX_ITEMS} itens.`);
  }

  const normalized = input.items.map(normalizeDefinition);

  const saved = await prisma.$transaction(async (tx) => {
    if (input.serviceOrderTypeId) {
      const type = await tx.serviceOrderType.findFirst({
        where: { id: input.serviceOrderTypeId, companyId },
        select: { id: true },
      });
      if (!type) {
        throw notFound("Tipo de OS não encontrado.");
      }
    }

    const existing = await tx.checklistTemplate.findFirst({
      where: { companyId, serviceOrderTypeId: input.serviceOrderTypeId },
    });

    const template = existing
      ? await tx.checklistTemplate.update({
          where: { id: existing.id },
          data: { name, active: true, version: { increment: 1 } },
        })
      : await tx.checklistTemplate.create({
          data: {
            companyId,
            serviceOrderTypeId: input.serviceOrderTypeId,
            name,
          },
        });

    if (existing) {
      await tx.checklistTemplateItem.deleteMany({
        where: { templateId: template.id, companyId },
      });
    }

    await tx.checklistTemplateItem.createMany({
      data: normalized.map((item) => ({
        companyId,
        templateId: template.id,
        label: item.label,
        description: item.description,
        type: item.type,
        required: item.required,
        sortOrder: item.sortOrder,
        options: (item.options ?? undefined) as Prisma.InputJsonValue | undefined,
        evidenceCategory: item.evidenceCategory,
      })),
    });

    return template;
  });

  await logAudit({
    companyId,
    userId: actorUserId,
    action: "CHECKLIST_TEMPLATE.SAVED",
    entity: "ChecklistTemplate",
    entityId: saved.id,
    details: `Checklist "${name}" salvo na versão ${saved.version} com ${normalized.length} itens`,
  });

  return {
    templateId: saved.id,
    version: saved.version,
    itemCount: normalized.length,
  };
}

/**
 * O template que se aplica a uma OS.
 *
 * Precedência: o template do TIPO da OS; na falta dele, o template PADRÃO da
 * empresa. O padrão existe porque OS importada não tem `typeId` — o provedor não
 * conhece o catálogo da empresa — e ficaria permanentemente sem checklist.
 */
export async function resolveApplicableTemplate(
  tx: ExecutionTx,
  companyId: string,
  serviceOrderTypeId: string | null,
) {
  if (serviceOrderTypeId) {
    const byType = await tx.checklistTemplate.findFirst({
      where: { companyId, serviceOrderTypeId, active: true },
      include: { items: { where: { active: true }, orderBy: { sortOrder: "asc" } } },
    });
    if (byType) return byType;
  }
  return tx.checklistTemplate.findFirst({
    where: { companyId, serviceOrderTypeId: null, active: true },
    include: { items: { where: { active: true }, orderBy: { sortOrder: "asc" } } },
  });
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

/**
 * Copia o checklist aplicável para dentro da OS, no `start`.
 *
 * Idempotente por construção: se já existe item para a OS, não faz nada. O
 * `start` já é arbitrado por compare-and-set, mas uma retomada de reserva de
 * idempotência pode reexecutar o handler, e duplicar o checklist deixaria a OS
 * com cada pergunta duas vezes.
 *
 * Sem template aplicável, a OS simplesmente não tem checklist — e a conclusão
 * dela não exige nenhum, porque a política também é opcional. É o que mantém
 * toda OS anterior à v0.10 concluindo como antes.
 */
export async function snapshotChecklistForOrder(
  tx: ExecutionTx,
  companyId: string,
  orderId: string,
  serviceOrderTypeId: string | null,
): Promise<{ templateId: string; version: number; itemCount: number } | null> {
  const already = await tx.serviceOrderChecklistItem.count({
    where: { serviceOrderId: orderId, companyId },
  });
  if (already > 0) return null;

  const template = await resolveApplicableTemplate(
    tx,
    companyId,
    serviceOrderTypeId,
  );
  if (!template || template.items.length === 0) return null;

  await tx.serviceOrderChecklistItem.createMany({
    data: template.items.map((item) => ({
      companyId,
      serviceOrderId: orderId,
      templateId: template.id,
      templateItemId: item.id,
      label: item.label,
      description: item.description,
      type: item.type,
      required: item.required,
      sortOrder: item.sortOrder,
      options: (item.options ?? undefined) as Prisma.InputJsonValue | undefined,
      evidenceCategory: item.evidenceCategory,
    })),
  });

  return {
    templateId: template.id,
    version: template.version,
    itemCount: template.items.length,
  };
}

// ---------------------------------------------------------------------------
// Leitura e resposta
// ---------------------------------------------------------------------------

export interface PublicChecklistItem {
  id: string;
  label: string;
  description: string | null;
  type: ChecklistItemType;
  required: boolean;
  sortOrder: number;
  options: string[] | null;
  evidenceCategory: EvidenceCategory | null;
  valueBoolean: boolean | null;
  valueText: string | null;
  valueNumber: string | null;
  answeredAt: Date | null;
}

function toPublicChecklistItem(row: {
  id: string;
  label: string;
  description: string | null;
  type: ChecklistItemType;
  required: boolean;
  sortOrder: number;
  options: Prisma.JsonValue;
  evidenceCategory: EvidenceCategory | null;
  valueBoolean: boolean | null;
  valueText: string | null;
  valueNumber: Prisma.Decimal | null;
  answeredAt: Date | null;
}): PublicChecklistItem {
  return {
    id: row.id,
    label: row.label,
    description: row.description,
    type: row.type,
    required: row.required,
    sortOrder: row.sortOrder,
    options: Array.isArray(row.options) ? (row.options as string[]) : null,
    evidenceCategory: row.evidenceCategory,
    valueBoolean: row.valueBoolean,
    valueText: row.valueText,
    valueNumber: row.valueNumber === null ? null : row.valueNumber.toString(),
    answeredAt: row.answeredAt,
  };
}

export async function getOrderChecklist(
  companyId: string,
  orderId: string,
): Promise<PublicChecklistItem[]> {
  const rows = await prisma.serviceOrderChecklistItem.findMany({
    where: { serviceOrderId: orderId, companyId },
    orderBy: { sortOrder: "asc" },
  });
  return rows.map(toPublicChecklistItem);
}

export interface AnswerChecklistInput {
  itemId: string;
  expectedOrderVersion: number;
  valueBoolean?: boolean | null;
  valueText?: string | null;
  valueNumber?: number | null;
}

/**
 * Grava a resposta de um item do checklist da OS.
 *
 * O valor é validado CONTRA O TIPO gravado no snapshot da própria OS, não
 * contra o template atual: é o snapshot que o técnico está respondendo.
 *
 * Itens `PHOTO` não são respondidos aqui. Eles são satisfeitos por uma
 * evidência na categoria configurada, e a conclusão consulta
 * `ServiceOrderEvidence` — guardar um "sim, tirei a foto" separado da foto
 * permitiria marcar o item sem a evidência existir.
 */
export async function answerChecklistItem(
  companyId: string,
  actorUserId: string,
  orderId: string,
  input: AnswerChecklistInput,
): Promise<PublicChecklistItem> {
  const updated = await prisma.$transaction(async (tx) => {
    await loadInProgressOwnedOrder(tx, companyId, actorUserId, orderId);

    const item = await tx.serviceOrderChecklistItem.findFirst({
      where: { id: input.itemId, serviceOrderId: orderId, companyId },
    });
    if (!item) {
      throw notFound("Item de checklist não encontrado.");
    }

    const data: Prisma.ServiceOrderChecklistItemUpdateInput = {
      valueBoolean: null,
      valueText: null,
      valueNumber: null,
      answeredAt: new Date(),
      answeredBy: { connect: { id: actorUserId } },
    };

    switch (item.type) {
      case "BOOLEAN": {
        if (typeof input.valueBoolean !== "boolean") {
          throw badRequest(`"${item.label}" espera sim ou não.`);
        }
        data.valueBoolean = input.valueBoolean;
        break;
      }
      case "TEXT": {
        const text = input.valueText?.trim() ?? "";
        if (!text) {
          throw badRequest(`"${item.label}" espera um texto.`);
        }
        data.valueText = text.slice(0, CHECKLIST_TEXT_ANSWER_MAX);
        break;
      }
      case "NUMBER": {
        if (
          typeof input.valueNumber !== "number" ||
          !Number.isFinite(input.valueNumber)
        ) {
          throw badRequest(`"${item.label}" espera um número.`);
        }
        data.valueNumber = new Prisma.Decimal(input.valueNumber);
        break;
      }
      case "SELECT": {
        const options = Array.isArray(item.options)
          ? (item.options as string[])
          : [];
        const chosen = input.valueText?.trim() ?? "";
        if (!options.includes(chosen)) {
          // A lista vem do snapshot da OS. Aceitar um valor fora dela deixaria
          // o relatório com respostas que nenhuma opção oferecia.
          throw badRequest(`"${chosen}" não é uma opção válida para "${item.label}".`);
        }
        data.valueText = chosen;
        break;
      }
      case "PHOTO": {
        throw badRequest(
          `"${item.label}" é satisfeito anexando a foto na categoria correspondente.`,
        );
      }
    }

    await claimOrderForChildMutation(
      tx,
      companyId,
      orderId,
      input.expectedOrderVersion,
    );

    return tx.serviceOrderChecklistItem.update({
      where: { id: item.id },
      data,
    });
  });

  await logAudit({
    companyId,
    userId: actorUserId,
    action: "SERVICE_ORDER.CHECKLIST_ANSWERED",
    entity: "ServiceOrderChecklistItem",
    entityId: updated.id,
    details: `Item "${updated.label}" respondido`,
  });

  return toPublicChecklistItem(updated);
}

// ---------------------------------------------------------------------------
// Pendências
// ---------------------------------------------------------------------------

export interface ChecklistPendency {
  itemId: string;
  label: string;
  type: ChecklistItemType;
  evidenceCategory: EvidenceCategory | null;
}

/**
 * Itens OBRIGATÓRIOS ainda não satisfeitos.
 *
 * Um item `PHOTO` é satisfeito por uma evidência na categoria dele; os demais,
 * por `answeredAt` preenchido. A consulta de evidência é feita uma vez para
 * todas as categorias exigidas, e não por item, para não multiplicar consultas
 * numa validação que roda em toda tentativa de conclusão.
 */
export async function pendingChecklistItems(
  tx: ExecutionTx,
  companyId: string,
  orderId: string,
): Promise<ChecklistPendency[]> {
  const required = await tx.serviceOrderChecklistItem.findMany({
    where: { serviceOrderId: orderId, companyId, required: true },
    orderBy: { sortOrder: "asc" },
  });
  if (required.length === 0) return [];

  const photoCategories = required
    .filter((item) => item.type === "PHOTO" && item.evidenceCategory)
    .map((item) => item.evidenceCategory as EvidenceCategory);

  const present = new Set<EvidenceCategory>();
  if (photoCategories.length > 0) {
    const evidences = await tx.serviceOrderEvidence.findMany({
      where: {
        serviceOrderId: orderId,
        companyId,
        category: { in: photoCategories },
      },
      select: { category: true },
      distinct: ["category"],
    });
    for (const evidence of evidences) present.add(evidence.category);
  }

  return required
    .filter((item) =>
      item.type === "PHOTO"
        ? !item.evidenceCategory || !present.has(item.evidenceCategory)
        : item.answeredAt === null,
    )
    .map((item) => ({
      itemId: item.id,
      label: item.label,
      type: item.type,
      evidenceCategory: item.evidenceCategory,
    }));
}
