import bcrypt from "bcryptjs";
import type { AccessProfile } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { createSessionToken } from "@/lib/auth";

export const TEST_PASSWORD = "TestPassword@123";
const PASSWORD_HASH = bcrypt.hashSync(TEST_PASSWORD, 10);

const COOKIE_NAME = "alfaos_session";

export async function resetDatabase(): Promise<void> {
  await prisma.serviceOrderEvidence.deleteMany();
  await prisma.serviceOrderMaterialUsage.deleteMany();
  await prisma.serviceOrderSignature.deleteMany();
  await prisma.serviceOrderExecution.deleteMany();
  await prisma.serviceOrderEvent.deleteMany();
  await prisma.serviceOrder.deleteMany();
  await prisma.technician.deleteMany();
  await prisma.customer.deleteMany();
  await prisma.loginAttempt.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.eRPIntegration.deleteMany();
  await prisma.user.deleteMany();
  await prisma.company.deleteMany();
}

export interface TestFixture {
  companyA: { id: string };
  companyB: { id: string };
  adminA: { id: string };
  dispatcherA: { id: string };
  techA: { id: string };
  techB: { id: string };
  inactiveA: { id: string };
  adminB: { id: string };
}

export async function seedTestData(): Promise<TestFixture> {
  await resetDatabase();

  const companyA = await prisma.company.create({
    data: { name: "Alfa Telecom", document: "12.345.678/0001-90" },
  });
  const companyB = await prisma.company.create({
    data: { name: "Empresa Teste B", document: "98.765.432/0001-01" },
  });

  const createUser = (
    companyId: string,
    name: string,
    email: string,
    profile: AccessProfile,
    active = true,
  ) =>
    prisma.user.create({
      data: {
        companyId,
        name,
        email,
        profile,
        active,
        passwordHash: PASSWORD_HASH,
      },
    });

  const adminA = await createUser(
    companyA.id,
    "Administrador Alfa",
    "admin@alfa.test",
    "ADMIN",
  );
  const dispatcherA = await createUser(
    companyA.id,
    "Despachante Alfa",
    "dispatcher@alfa.test",
    "DISPATCHER",
  );
  const techA = await createUser(
    companyA.id,
    "Tecnico Alfa",
    "tech@alfa.test",
    "TECHNICIAN",
  );
  const techB = await createUser(
    companyA.id,
    "Tecnico Beta",
    "tech2@alfa.test",
    "TECHNICIAN",
  );
  const inactiveA = await createUser(
    companyA.id,
    "Inativo Alfa",
    "inactive@alfa.test",
    "ADMIN",
    false,
  );
  const adminB = await createUser(
    companyB.id,
    "Administrador Empresa B",
    "admin@companyb.test",
    "ADMIN",
  );

  return {
    companyA: { id: companyA.id },
    companyB: { id: companyB.id },
    adminA: { id: adminA.id },
    dispatcherA: { id: dispatcherA.id },
    techA: { id: techA.id },
    techB: { id: techB.id },
    inactiveA: { id: inactiveA.id },
    adminB: { id: adminB.id },
  };
}

export async function createTokenFor(userId: string): Promise<string> {
  return createSessionToken(userId);
}

export function apiRequest(
  url: string,
  options: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
  token?: string,
): Request {
  const { method = "GET", body, headers = {} } = options;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  if (token) {
    headers["Cookie"] = `${COOKIE_NAME}=${encodeURIComponent(token)}`;
  }
  return new Request(`http://localhost${url}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}
