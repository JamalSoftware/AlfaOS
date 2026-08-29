import bcrypt from "bcryptjs";
import type { AccessProfile } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { createSessionToken } from "@/lib/auth";
import { allocateServiceOrderNumber } from "@/lib/service-order-number";
import { issueFieldToken } from "@/lib/field/auth";
import { assertTestDatabase } from "../../e2e/test-db-guard";

export const TEST_PASSWORD = "TestPassword@123";
const PASSWORD_HASH = bcrypt.hashSync(TEST_PASSWORD, 10);

const COOKIE_NAME = "alfaos_session";

/**
 * The exact `DATABASE_URL` value `resetDatabase()` has already verified, or
 * `undefined` if it has not run yet in this process.
 *
 * `resetDatabase()` runs in `beforeEach` for nearly every test — over 200
 * times across the suite. Re-validating on every call would mean 200+ extra
 * Prisma connections just to check a value that cannot change mid-run
 * (`setup.ts` sets it once per worker, before any test file's imports
 * resolve). Caching after the first success keeps the guarantee that matters
 * — the very first destructive call in this process always validates before
 * touching anything — without paying for it 200 more times.
 */
let verifiedDatabaseUrl: string | undefined;

export async function resetDatabase(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl !== verifiedDatabaseUrl) {
    // Guard FIRST, before the first deleteMany ever runs. No silent fallback:
    // if TEST_DATABASE_URL is misconfigured and DATABASE_URL ends up pointing
    // at `alfaos_dev` (or anywhere not ending in `_test`), this throws instead
    // of truncating whatever `prisma` happens to be connected to.
    await assertTestDatabase(databaseUrl, "DATABASE_URL (Vitest)");
    verifiedDatabaseUrl = databaseUrl;
  }

  await prisma.customerDiagnosticSnapshot.deleteMany();
  /*
    Jornada, de baixo para cima.

    A marcação derivada aponta para o pedido que a criou, e o pedido aponta para
    a marcação-alvo — as duas com `Restrict`. Por isso o pedido é desarmado
    ANTES: sem isso, apagar `time_entries` esbarra na FK do efeito, e apagar
    `time_adjustment_requests` esbarra na do alvo. Zerar os dois ponteiros
    primeiro rompe o ciclo sem precisar de ordem mágica.
  */
  await prisma.timeAdjustmentRequest.updateMany({
    data: { targetEntryId: null },
  });
  await prisma.timeEntry.deleteMany();
  await prisma.timeAdjustmentRequest.deleteMany();
  await prisma.workday.deleteMany();
  // Equipamento antes de evidência: desde a v0.10.1 ele aponta para a foto da
  // etiqueta com `Restrict`, e apagar a foto primeiro viola a FK.
  await prisma.serviceOrderEquipment.deleteMany();
  await prisma.serviceOrderEvidence.deleteMany();
  /*
    Execução em campo (v0.10). A ORDEM aqui não é estética: vários destes
    vínculos são `onDelete: Restrict` de propósito — apagar um técnico não pode
    apagar em silêncio o movimento de estoque que ele fez. O reset precisa
    desmontar de baixo para cima, e um `deleteMany` fora de ordem falha com
    violação de FK em vez de mascarar o problema.

    `ServiceOrderMaterialUsage` sai antes de `InventoryMovement` porque aponta
    para ele; `InventoryMovement` antes de `InventoryItem`, `Technician` e
    `ServiceOrder` pelo mesmo motivo.
  */
  await prisma.serviceOrderMaterialUsage.deleteMany();
  await prisma.inventoryMovement.deleteMany();
  await prisma.inventoryItem.deleteMany();
  await prisma.serviceOrderSignature.deleteMany();
  await prisma.serviceOrderCompletion.deleteMany();
  await prisma.serviceOrderCheckIn.deleteMany();
  await prisma.serviceOrderContactAttempt.deleteMany();
  await prisma.serviceOrderImpediment.deleteMany();
  await prisma.serviceOrderChecklistItem.deleteMany();
  await prisma.customerLocationHistory.deleteMany();
  await prisma.customerLocation.deleteMany();
  await prisma.serviceOrderExecution.deleteMany();
  await prisma.serviceOrderEvent.deleteMany();
  await prisma.serviceOrder.deleteMany();
  // Fundação Field. Antes de technician/user/company: as FKs cascateiam, mas
  // apagar explicitamente mantém o reset legível e independente da ordem das
  // regras de exclusão.
  await prisma.mobileDevice.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.idempotencyRecord.deleteMany();
  await prisma.outboxEvent.deleteMany();
  // Depois das OS: o vínculo é onDelete Restrict de propósito.
  await prisma.checklistTemplateItem.deleteMany();
  await prisma.checklistTemplate.deleteMany();
  await prisma.serviceOrderCompletionPolicy.deleteMany();
  await prisma.serviceOrderType.deleteMany();
  await prisma.technician.deleteMany();
  await prisma.customerConnection.deleteMany();
  await prisma.customer.deleteMany();
  await prisma.loginAttempt.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.eRPCredential.deleteMany();
  await prisma.eRPIntegration.deleteMany();
  await prisma.user.deleteMany();
  await prisma.company.deleteMany();
}

/**
 * Número operacional para uma OS criada DIRETAMENTE pela fixture.
 *
 * Usa o alocador de produção de propósito. Uma fixture com numeração própria
 * (`count + 1`, contador local) testaria uma sequência que a aplicação não
 * usa, e mascararia justamente o defeito que este campo existe para evitar.
 *
 * `resetDatabase` apaga as empresas, e `service_order_counters` é
 * `onDelete: Cascade` — então cada teste começa com a sequência em 1.
 */
export function allocateTestServiceOrderNumber(
  companyId: string,
): Promise<number> {
  return allocateServiceOrderNumber(prisma, companyId);
}

export interface TestFixture {
  companyA: { id: string };
  companyB: { id: string };
  /** Tipo de OS da empresa A. Criar OS manual exige um tipo da própria empresa. */
  typeA: { id: string };
  /** Tipo da empresa B — existe para provar que A não consegue usá-lo. */
  typeB: { id: string };
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

  const typeA = await prisma.serviceOrderType.create({
    data: { companyId: companyA.id, name: "Instalação", sortOrder: 1 },
  });
  const typeB = await prisma.serviceOrderType.create({
    data: { companyId: companyB.id, name: "Instalação", sortOrder: 1 },
  });

  return {
    companyA: { id: companyA.id },
    companyB: { id: companyB.id },
    typeA: { id: typeA.id },
    typeB: { id: typeB.id },
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

/**
 * Requisição do FIELD.
 *
 * Deliberadamente NÃO tem parâmetro de cookie. O Field só lê
 * `Authorization: Bearer`, e um helper capaz de mandar cookie facilitaria
 * escrever um teste que passa por um caminho que a produção não tem.
 */
export function fieldRequest(
  url: string,
  options: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
    /** Bearer token do Field. */
    token?: string;
    idempotencyKey?: string;
  } = {},
): Request {
  const { method = "GET", body, headers = {}, token, idempotencyKey } = options;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  if (idempotencyKey) {
    headers["Idempotency-Key"] = idempotencyKey;
  }
  return new Request(`http://localhost${url}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

/**
 * Registra um dispositivo Field já autenticado, sem passar pelo login.
 *
 * Existe para os testes que querem exercitar OUTRA coisa (posse, conflito,
 * idempotência) sem repetir o fluxo de credencial em cada arquivo. O token
 * devolvido é real e passa pela mesma verificação da produção — o atalho é só
 * na criação da linha, nunca na validação.
 */
export async function registerTestDevice(
  userId: string,
  options: { installationId?: string; pushToken?: string | null } = {},
): Promise<{ token: string; deviceId: string }> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { companyId: true },
  });
  const technician = await prisma.technician.findFirst({
    where: { userId, companyId: user.companyId },
    select: { id: true },
  });

  const issued = issueFieldToken();
  const device = await prisma.mobileDevice.create({
    data: {
      companyId: user.companyId,
      userId,
      technicianId: technician?.id ?? null,
      platform: "ANDROID",
      installationId: options.installationId ?? `inst-${userId.slice(-8)}`,
      appVersion: "0.9.0",
      pushToken: options.pushToken ?? null,
      tokenHash: issued.tokenHash,
      tokenIssuedAt: new Date(),
      tokenExpiresAt: issued.expiresAt,
    },
    select: { id: true },
  });

  return { token: issued.token, deviceId: device.id };
}
