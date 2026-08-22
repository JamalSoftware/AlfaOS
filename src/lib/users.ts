import { AccessProfile, type User } from "@prisma/client";
import { logAudit } from "./audit";
import { conflict } from "./errors";
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

  // Would this write strip the company of an active ADMIN? Only then is the
  // "last administrator" check worth running — an edit that does not remove
  // admin rights must never be refused, not even in a company that somehow
  // already has no active ADMIN.
  const removesActiveAdmin =
    existing.profile === AccessProfile.ADMIN &&
    existing.active &&
    (input.active === false ||
      (input.profile !== undefined && input.profile !== AccessProfile.ADMIN));

  const updated = await prisma.$transaction(async (tx) => {
    const user = await tx.user.update({ where: { id: userId }, data });

    if (removesActiveAdmin) {
      // Counted after the update so it sees this transaction's own write:
      // whatever is left is exactly what the company would be left with.
      const remainingAdmins = await tx.user.count({
        where: { companyId, profile: AccessProfile.ADMIN, active: true },
      });
      if (remainingAdmins === 0) {
        // Rolls the update back. Without this, a company can be left with no
        // one able to manage users, and there is no in-app recovery path.
        throw conflict(
          "Não é possível remover o último administrador ativo da empresa.",
        );
      }
    }

    return user;
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

/**
 * E-mail uniqueness is intentionally global, not per company: login takes only
 * e-mail + password (there is no company selector), so the address must resolve
 * to exactly one account. Hence no `companyId` scope here — it would contradict
 * `User.email @unique` in the schema.
 */
export async function ensureEmailAvailable(
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
