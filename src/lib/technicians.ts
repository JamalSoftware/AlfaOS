import { AccessProfile } from "@prisma/client";
import { logAudit } from "./audit";
import { badRequest, conflict, notFound } from "./errors";
import { prisma } from "./prisma";

export interface PublicTechnician {
  id: string;
  userId: string;
  name: string;
  email: string;
  phone: string | null;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface TechnicianListResult {
  technicians: PublicTechnician[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ListTechniciansParams {
  search?: string;
  active?: boolean;
  page?: number;
  pageSize?: number;
}

function toPublicTechnician(technician: {
  id: string;
  userId: string;
  phone: string | null;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
  user: { name: string; email: string };
}): PublicTechnician {
  return {
    id: technician.id,
    userId: technician.userId,
    name: technician.user.name,
    email: technician.user.email,
    phone: technician.phone,
    active: technician.active,
    createdAt: technician.createdAt,
    updatedAt: technician.updatedAt,
  };
}

export async function listCompanyTechnicians(
  companyId: string,
  params: ListTechniciansParams = {},
): Promise<TechnicianListResult> {
  const page = Math.max(1, params.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, params.pageSize ?? 20));

  const where: Record<string, unknown> = { companyId };
  if (params.active !== undefined) where.active = params.active;
  if (params.search) {
    where.user = {
      name: { contains: params.search, mode: "insensitive" },
    };
  }

  const [technicians, total] = await Promise.all([
    prisma.technician.findMany({
      where,
      include: { user: { select: { name: true, email: true } } },
      orderBy: { createdAt: "asc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.technician.count({ where }),
  ]);

  return {
    technicians: technicians.map(toPublicTechnician),
    total,
    page,
    pageSize,
  };
}

export async function getCompanyTechnician(
  companyId: string,
  technicianId: string,
): Promise<PublicTechnician | null> {
  const technician = await prisma.technician.findFirst({
    where: { id: technicianId, companyId },
    include: { user: { select: { name: true, email: true } } },
  });
  return technician ? toPublicTechnician(technician) : null;
}

export interface TechnicianCandidate {
  id: string;
  name: string;
  email: string;
}

/**
 * Lightweight list of active technicians (for filter dropdowns).
 */
export async function listActiveTechnicianOptions(
  companyId: string,
): Promise<{ id: string; name: string }[]> {
  const technicians = await prisma.technician.findMany({
    where: { companyId, active: true },
    include: { user: { select: { name: true } } },
    orderBy: { createdAt: "asc" },
  });
  return technicians.map((tech) => ({
    id: tech.id,
    name: tech.user.name,
  }));
}

/**
 * Users eligible to become technicians: active TECHNICIAN profile users of
 * the company that are not yet linked to a technician record.
 */
export async function listTechnicianCandidates(
  companyId: string,
): Promise<TechnicianCandidate[]> {
  const linked = await prisma.technician.findMany({
    where: { companyId },
    select: { userId: true },
  });
  const linkedIds = linked.map((tech) => tech.userId);

  const users = await prisma.user.findMany({
    where: {
      companyId,
      profile: AccessProfile.TECHNICIAN,
      active: true,
      ...(linkedIds.length > 0 ? { id: { notIn: linkedIds } } : {}),
    },
    orderBy: { name: "asc" },
    select: { id: true, name: true, email: true },
  });

  return users;
}

export async function createCompanyTechnician(
  companyId: string,
  userId: string,
  phone: string | undefined,
  actorId: string,
): Promise<PublicTechnician> {
  const user = await prisma.user.findFirst({
    where: { id: userId, companyId },
  });
  if (!user) {
    throw notFound("Usuário não encontrado nesta empresa.");
  }
  if (user.profile !== AccessProfile.TECHNICIAN) {
    throw badRequest("Somente usuários com perfil Técnico podem ser técnicos.");
  }
  if (!user.active) {
    throw badRequest("O usuário deve estar ativo para ser vinculado como técnico.");
  }

  const existing = await prisma.technician.findFirst({
    where: { userId },
  });
  if (existing) {
    throw conflict("Este usuário já está vinculado como técnico.");
  }

  const technician = await prisma.technician.create({
    data: {
      companyId,
      userId,
      phone: phone?.trim() || null,
    },
    include: { user: { select: { name: true, email: true } } },
  });

  await logAudit({
    companyId,
    userId: actorId,
    action: "TECHNICIAN.CREATED",
    entity: "Technician",
    entityId: technician.id,
    details: `Técnico criado: ${technician.user.name}`,
  });

  return toPublicTechnician(technician);
}

export async function updateCompanyTechnician(
  companyId: string,
  technicianId: string,
  input: { phone?: string; active?: boolean },
  actorId: string,
): Promise<PublicTechnician> {
  const existing = await prisma.technician.findFirst({
    where: { id: technicianId, companyId },
  });
  if (!existing) {
    throw notFound("Técnico não encontrado.");
  }

  const data: Record<string, unknown> = {};
  if (input.phone !== undefined) data.phone = input.phone?.trim() || null;
  if (input.active !== undefined) data.active = input.active;

  const updated = await prisma.technician.update({
    where: { id: technicianId },
    data,
    include: { user: { select: { name: true, email: true } } },
  });

  await logAudit({
    companyId,
    userId: actorId,
    action: "TECHNICIAN.UPDATED",
    entity: "Technician",
    entityId: technicianId,
    details: `Técnico atualizado: ${updated.user.name}`,
  });

  return toPublicTechnician(updated);
}
