import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { assertTestDatabase } from "./test-db-guard";

const ADMIN_EMAIL = "admin@alfatelecom.local";
const PASSWORD = "AlfaOS@2026";

/** Dedicated to this file — never the seeded technician (see beforeAll). */
const OWNER_EMAIL = "tech-diag@alfatelecom.local";
const OTHER_EMAIL = "tech-diag-other@alfatelecom.local";

/**
 * Like the closing spec, this file creates its OWN orders and users directly
 * in the test database and removes them afterwards. The suite shares one
 * seeded database across files and does not reset between them, so adding rows
 * through the UI would break `service-orders.spec.ts`'s "sync imports exactly
 * 3" assertion, and linking the seeded technician would remove it from the
 * candidates dropdown that spec relies on.
 *
 * Every scenario runs against MockERP — no network, no external service.
 */
const ONLINE_ORDER = "20001"; // customer id ends in -ONLINE
const FAILING_ORDER = "20002"; // customer id ends in -FAIL (upstream down)
const FOREIGN_ORDER = "20003"; // assigned to the OTHER technician

const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgresql://alfaos:alfaos_dev_password@localhost:5432/alfaos_test?schema=public";

const prisma = new PrismaClient({
  datasources: { db: { url: E2E_DATABASE_URL } },
});

const orderUrls: Record<string, string> = {};

test.beforeAll(async () => {
  await assertTestDatabase(E2E_DATABASE_URL, "E2E_DATABASE_URL");

  const seeded = await prisma.user.findUniqueOrThrow({
    where: { email: "tech@alfatelecom.local" },
  });

  async function makeTechnician(email: string, name: string) {
    const user = await prisma.user.upsert({
      where: { email },
      update: { active: true },
      create: {
        companyId: seeded.companyId,
        name,
        email,
        profile: "TECHNICIAN",
        passwordHash: seeded.passwordHash,
      },
    });
    const technician = await prisma.technician.upsert({
      where: { userId: user.id },
      update: { active: true },
      create: { companyId: user.companyId, userId: user.id },
    });
    return { user, technician };
  }

  const owner = await makeTechnician(OWNER_EMAIL, "Tecnico Diagnostico");
  const other = await makeTechnician(OTHER_EMAIL, "Tecnico Diag Outro");

  // Ids are unique per scenario and carry the mock's behaviour suffix, so they
  // never collide with the `MOCK-CUST-*` customers that `service-orders.spec.ts`
  // creates through the ERP sync.
  const scenarios: [string, string, string][] = [
    [ONLINE_ORDER, "DIAG-20001-ONLINE", "Cliente Diag Online"],
    [FAILING_ORDER, "DIAG-20002-FAIL", "Cliente Diag Falha"],
    [FOREIGN_ORDER, "DIAG-20003-ONLINE", "Cliente Diag Alheio"],
  ];

  for (const [externalNumber, custExternalId, custName] of scenarios) {
    const customer = await prisma.customer.create({
      data: {
        companyId: seeded.companyId,
        name: custName,
        externalProvider: "MOCK",
        externalId: custExternalId,
        city: "Belo Horizonte",
        state: "MG",
      },
    });
    const created = await prisma.serviceOrder.create({
      data: {
        companyId: seeded.companyId,
        customerId: customer.id,
        technicianId:
          externalNumber === FOREIGN_ORDER
            ? other.technician.id
            : owner.technician.id,
        externalNumber,
        type: "Suporte",
        description: `OS de diagnóstico ${externalNumber}.`,
        status: "ASSIGNED",
        assignedAt: new Date(),
      },
    });
    orderUrls[externalNumber] = `/ordens/${created.id}`;
  }
});

test.afterAll(async () => {
  const orders = await prisma.serviceOrder.findMany({
    where: {
      externalNumber: { in: [ONLINE_ORDER, FAILING_ORDER, FOREIGN_ORDER] },
    },
    select: { id: true, customerId: true },
  });
  const ids = orders.map((o) => o.id);
  const customerIds = orders.map((o) => o.customerId);

  if (ids.length > 0) {
    await prisma.serviceOrderEvent.deleteMany({
      where: { serviceOrderId: { in: ids } },
    });
    await prisma.serviceOrder.deleteMany({ where: { id: { in: ids } } });
  }
  if (customerIds.length > 0) {
    await prisma.customerDiagnosticSnapshot.deleteMany({
      where: { customerId: { in: customerIds } },
    });
    await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
  }
  for (const email of [OWNER_EMAIL, OTHER_EMAIL]) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      await prisma.auditLog.deleteMany({ where: { userId: user.id } });
      await prisma.technician.deleteMany({ where: { userId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
  await prisma.$disconnect();
});

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Senha").fill(PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

// ---------------------------------------------------------------------------
// E2E 1 — staff sees the panel and a refresh produces a real observation
// ---------------------------------------------------------------------------

test("ADMIN abre a OS, vê o painel de diagnóstico e atualiza", async ({ page }) => {
  await login(page, ADMIN_EMAIL);
  await page.goto(orderUrls[ONLINE_ORDER]);

  await expect(page.getByTestId("diagnostic-panel")).toBeVisible();
  // Nothing observed yet for this brand-new customer.
  await expect(
    page.getByText("Nenhum diagnóstico registrado para este cliente."),
  ).toBeVisible();

  await page.getByTestId("diagnostic-refresh").click();

  await expect(page.getByTestId("diagnostic-status")).toHaveText("Online");
  await expect(page.getByTestId("diagnostic-observed-at")).toBeVisible();
  // The label is what the server resolved — mock data is never shown as
  // ReceitaNet.
  await expect(page.getByText("Mock ERP")).toBeVisible();
});

// ---------------------------------------------------------------------------
// E2E 2 — technician sees and refreshes the diagnostic on their own order
// ---------------------------------------------------------------------------

test("técnico dono visualiza e atualiza o diagnóstico da própria OS", async ({
  page,
}) => {
  await login(page, OWNER_EMAIL);
  await page.goto(orderUrls[ONLINE_ORDER]);

  await expect(page.getByTestId("diagnostic-panel")).toBeVisible();
  await page.getByTestId("diagnostic-refresh").click();
  await expect(page.getByTestId("diagnostic-status")).toHaveText("Online");

  // Survives a reload — it is a persisted snapshot, not screen state.
  await page.reload();
  await expect(page.getByTestId("diagnostic-status")).toHaveText("Online");
});

// ---------------------------------------------------------------------------
// E2E 3 — provider down: page keeps working, snapshot preserved
// ---------------------------------------------------------------------------

test("provider indisponível: página segue funcional e último estado é preservado", async ({
  page,
}) => {
  const failingUrl = orderUrls[FAILING_ORDER];

  // Seed a valid observation first, by pointing this customer at the healthy
  // mock id, so there is a "last known" state to protect.
  const order = await prisma.serviceOrder.findFirstOrThrow({
    where: { externalNumber: FAILING_ORDER },
  });
  await prisma.customerDiagnosticSnapshot.create({
    data: {
      companyId: order.companyId,
      customerId: order.customerId,
      externalProvider: "MOCK",
      connectivityStatus: "ONLINE",
      observedAt: new Date(),
    },
  });

  await login(page, OWNER_EMAIL);
  await page.goto(failingUrl);
  await expect(page.getByTestId("diagnostic-status")).toHaveText("Online");

  // This customer's externalId maps to the mock's upstream-failure branch.
  await page.getByTestId("diagnostic-refresh").click();

  await expect(page.getByTestId("diagnostic-failure")).toBeVisible();
  await expect(page.getByTestId("diagnostic-failure")).toContainText(
    "Último estado conhecido",
  );
  // The critical assertion: the failure did NOT turn the customer OFFLINE.
  await expect(page.getByTestId("diagnostic-status")).toHaveText("Online");

  // And the rest of the order screen is untouched by the ERP outage.
  await expect(
    page.getByRole("button", { name: "Iniciar atendimento" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: /OS 20002/ })).toBeVisible();
});

// ---------------------------------------------------------------------------
// E2E 4 — a technician cannot reach another technician's order
// ---------------------------------------------------------------------------

test("técnico não acessa a OS (nem o diagnóstico) de outro técnico", async ({
  page,
}) => {
  await login(page, OWNER_EMAIL);
  await page.goto(orderUrls[FOREIGN_ORDER]);

  // The order itself is already 404 for a non-owner, so the diagnostic panel
  // is unreachable by construction.
  await expect(page.getByTestId("diagnostic-panel")).toHaveCount(0);
  await expect(page.getByText("This page could not be found.")).toBeVisible();
});
