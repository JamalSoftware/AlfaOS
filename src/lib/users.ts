import { AccessProfile, type User } from "@prisma/client";
import { logAudit } from "./audit";
import { hashPassword } from "./password";
import { prisma } from "./prisma";

export interface PublicUser {
  id: string;
  companyId: string;
  name: string;
  email: string;
  profile: AccessProfile;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    companyId: user.companyId,
    name: user.name,
    email: user.email,
    profile: user.profile,
    active: user.active,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

export interface CreateCompanyUserInput {
  name: string;
  email: string;
  password: string;
  profile: AccessProfile;
}

export interface UpdateCompanyUserInput {
  name?: string;
  email?: string;
  password?: string;
  profile?: AccessProfile;
  active?: boolean;
}

/**
 * All user queries below are scoped by companyId. The companyId always
 * comes from the authenticated session context, never from client input.
 */

export async function listCompanyUsers(
  companyId: string,
): Promise<PublicUser[]> {
  const users = await prisma.user.findMany({
    where: { companyId },
    orderBy: { createdAt: "asc" },
  });
  return users.map(toPublicUser);
}

export async function getCompanyUser(
  companyId: string,
  userId: string,
): Promise<PublicUser | null> {
  const user = await prisma.user.findFirst({
    where: { id: userId, companyId },
  });
  return user ? toPublicUser(user) : null;
}

export async function createCompanyUser(
  companyId: string,
  input: CreateCompanyUserInput,
  actorId: string,
): Promise<PublicUser> {
  const passwordHash = await hashPassword(input.password);
  const user = await prisma.user.create({
    data: {
      companyId,
      name: input.name.trim(),
      email: input.email.toLowerCase().trim(),
      profile: input.profile,
      passwordHash,
    },
  });

  await logAudit({
    companyId,
    userId: actorId,
    action: "USER.CREATED",
    entity: "User",
    entityId: user.id,
    details: `Usuário criado: ${user.name} (${user.profile})`,
  });

  return toPublicUser(user);
}

export async function updateCompanyUser(
  companyId: string,
  userId: string,
  input: UpdateCompanyUserInput,
  actorId: string,
): Promise<PublicUser | null> {
  const existing = await prisma.user.findFirst({
    where: { id: userId, companyId },
  });
  if (!existing) {
    return null;
  }

  const data: Record<string, unknown> = {};
  if (input.name !== undefined) data.name = input.name.trim();
  if (input.email !== undefined)
    data.email = input.email.toLowerCase().trim();
  if (input.profile !== undefined) data.profile = input.profile;
  if (input.active !== undefined) data.active = input.active;
  if (input.password !== undefined && input.password.length > 0) {
    data.passwordHash = await hashPassword(input.password);
  }

  const updated = await prisma.user.update({
    where: { id: userId },
    data,
  });

  await logAudit({
    companyId,
    userId: actorId,
    action: "USER.UPDATED",
    entity: "User",
    entityId: userId,
    details: `Usuário atualizado: ${updated.name}`,
  });

  return toPublicUser(updated);
}

export async function ensureEmailAvailable(
  companyId: string,
  email: string,
  excludeUserId?: string,
): Promise<boolean> {
  const normalized = email.toLowerCase().trim();
  const existing = await prisma.user.findFirst({
    where: {
      email: normalized,
      ...(excludeUserId ? { id: { not: excludeUserId } } : {}),
    },
  });
  return !existing;
}
