import type { ServiceOrderType } from "@prisma/client";
import { logAudit } from "./audit";
import { badRequest, conflict, isUniqueConstraintError, notFound } from "./errors";
import { prisma } from "./prisma";

/**
 * Catálogo de tipos de OS por empresa — fundação mínima (PRD §125).
 *
 * O escopo é deliberadamente pequeno: nome, descrição, ativo e ordem. Checklist,
 * obrigatoriedade de foto/assinatura, materiais por tipo e campos personalizados
 * NÃO entram aqui. Cada um deles muda como a OS conclui — ou seja, mexe na
 * máquina de estados e no fechamento, que são superfície crítica — e nenhum
 * deles tem ainda um cliente real usando tipos configuráveis para validar o
 * desenho.
 */

export const TYPE_NAME_MAX_LENGTH = 60;
export const TYPE_DESCRIPTION_MAX_LENGTH = 500;

export interface PublicServiceOrderType {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ServiceOrderTypeOption {
  id: string;
  name: string;
}

export interface CreateServiceOrderTypeInput {
  name: string;
  description?: string | null;
  sortOrder?: number;
}

export interface UpdateServiceOrderTypeInput {
  name?: string;
  description?: string | null;
  active?: boolean;
  sortOrder?: number;
}

export function toPublicServiceOrderType(
  type: ServiceOrderType,
): PublicServiceOrderType {
  return {
    id: type.id,
    name: type.name,
    description: type.description,
    active: type.active,
    sortOrder: type.sortOrder,
    createdAt: type.createdAt,
    updatedAt: type.updatedAt,
  };
}

/**
 * Forma canônica do nome: sem espaços nas pontas e sem espaços internos
 * repetidos.
 *
 * "Troca  de   ONU" e "Troca de ONU" são o mesmo tipo para um operador, e sem
 * normalizar os dois entrariam no catálogo como itens distintos que ninguém
 * consegue distinguir na tela.
 */
function normalizeName(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

function assertValidName(name: string): void {
  if (name.length === 0) {
    throw badRequest("Informe o nome do tipo de OS.");
  }
  if (name.length > TYPE_NAME_MAX_LENGTH) {
    throw badRequest(
      `Nome do tipo deve ter no máximo ${TYPE_NAME_MAX_LENGTH} caracteres.`,
    );
  }
}

function normalizeDescription(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  if (trimmed.length > TYPE_DESCRIPTION_MAX_LENGTH) {
    throw badRequest(
      `Descrição deve ter no máximo ${TYPE_DESCRIPTION_MAX_LENGTH} caracteres.`,
    );
  }
  return trimmed;
}

function normalizeSortOrder(raw: number | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!Number.isInteger(raw) || raw < 0 || raw > 9999) {
    throw badRequest("Ordem deve ser um inteiro entre 0 e 9999.");
  }
  return raw;
}

/**
 * Recusa um nome que já existe na empresa ignorando maiúsculas/minúsculas.
 *
 * A unique constraint do banco é case-sensitive, então ela sozinha deixaria
 * passar "Instalação" e "instalação". Esta checagem cobre o caso normal; a
 * constraint continua sendo o árbitro de corrida entre dois writers
 * simultâneos, e o `catch` de P2002 traduz esse desfecho para o mesmo 409.
 */
async function assertNameAvailable(
  companyId: string,
  name: string,
  exceptId?: string,
): Promise<void> {
  const clash = await prisma.serviceOrderType.findFirst({
    where: {
      companyId,
      name: { equals: name, mode: "insensitive" },
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    select: { id: true },
  });
  if (clash) {
    throw conflict(`Já existe um tipo de OS chamado "${name}".`);
  }
}

export async function listCompanyServiceOrderTypes(
  companyId: string,
  options: { includeInactive?: boolean } = {},
): Promise<PublicServiceOrderType[]> {
  const types = await prisma.serviceOrderType.findMany({
    where: {
      companyId,
      ...(options.includeInactive ? {} : { active: true }),
    },
    orderBy: [{ active: "desc" }, { sortOrder: "asc" }, { name: "asc" }],
  });
  return types.map(toPublicServiceOrderType);
}

/**
 * Opções para o formulário de nova OS: somente tipos ativos da própria empresa.
 */
export async function listServiceOrderTypeOptions(
  companyId: string,
): Promise<ServiceOrderTypeOption[]> {
  return prisma.serviceOrderType.findMany({
    where: { companyId, active: true },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    select: { id: true, name: true },
  });
}

/**
 * Resolve o tipo escolhido no momento de criar uma OS.
 *
 * Devolve o rótulo para ser gravado em `ServiceOrder.type`. O rótulo é copiado,
 * não referenciado: é o que mantém a OS histórica legível depois que o tipo é
 * renomeado ou desativado.
 *
 * Um tipo inativo é recusado na criação — mas isso não invalida nenhuma OS que
 * já o utilizou.
 */
export async function resolveServiceOrderTypeForCreation(
  companyId: string,
  typeId: string,
): Promise<{ id: string; label: string }> {
  const type = await prisma.serviceOrderType.findFirst({
    where: { id: typeId, companyId },
    select: { id: true, name: true, active: true },
  });
  if (!type) {
    throw notFound("Tipo de OS não encontrado nesta empresa.");
  }
  if (!type.active) {
    throw badRequest(
      `O tipo "${type.name}" está desativado e não pode ser usado em novas OS.`,
    );
  }
  return { id: type.id, label: type.name };
}

export async function createServiceOrderType(
  companyId: string,
  actorId: string,
  input: CreateServiceOrderTypeInput,
): Promise<PublicServiceOrderType> {
  const name = normalizeName(input.name);
  assertValidName(name);
  const description = normalizeDescription(input.description);
  const sortOrder = normalizeSortOrder(input.sortOrder) ?? 0;

  await assertNameAvailable(companyId, name);

  let created: ServiceOrderType;
  try {
    created = await prisma.serviceOrderType.create({
      data: { companyId, name, description, sortOrder },
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw conflict(`Já existe um tipo de OS chamado "${name}".`);
    }
    throw error;
  }

  await logAudit({
    companyId,
    userId: actorId,
    action: "SERVICE_ORDER_TYPE.CREATED",
    entity: "ServiceOrderType",
    entityId: created.id,
    details: `Tipo de OS criado: ${created.name}`,
  });

  return toPublicServiceOrderType(created);
}

export async function updateServiceOrderType(
  companyId: string,
  typeId: string,
  actorId: string,
  input: UpdateServiceOrderTypeInput,
): Promise<PublicServiceOrderType> {
  const existing = await prisma.serviceOrderType.findFirst({
    where: { id: typeId, companyId },
  });
  if (!existing) {
    throw notFound("Tipo de OS não encontrado.");
  }

  const data: {
    name?: string;
    description?: string | null;
    active?: boolean;
    sortOrder?: number;
  } = {};

  if (input.name !== undefined) {
    const name = normalizeName(input.name);
    assertValidName(name);
    if (name.toLowerCase() !== existing.name.toLowerCase()) {
      await assertNameAvailable(companyId, name, typeId);
    }
    data.name = name;
  }
  if (input.description !== undefined) {
    data.description = normalizeDescription(input.description);
  }
  if (input.active !== undefined) data.active = input.active;
  const sortOrder = normalizeSortOrder(input.sortOrder);
  if (sortOrder !== undefined) data.sortOrder = sortOrder;

  let updated: ServiceOrderType;
  try {
    updated = await prisma.serviceOrderType.update({
      where: { id: typeId },
      data,
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw conflict("Já existe um tipo de OS com esse nome.");
    }
    throw error;
  }

  /**
   * Renomear ou desativar NUNCA reescreve `ServiceOrder.type` das OS
   * existentes. O rótulo gravado é o que estava valendo no dia do atendimento,
   * e reescrevê-lo falsificaria o histórico.
   */
  const changed = Object.keys(data);
  await logAudit({
    companyId,
    userId: actorId,
    action: "SERVICE_ORDER_TYPE.UPDATED",
    entity: "ServiceOrderType",
    entityId: typeId,
    details: `Tipo de OS atualizado: ${updated.name} (${changed.join(", ") || "sem alteração"})`,
  });

  return toPublicServiceOrderType(updated);
}
