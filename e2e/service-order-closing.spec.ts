import { test, expect, type Page } from "@playwright/test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { allocateServiceOrderNumber } from "../src/lib/service-order-number";
import { assertTestDatabase } from "./test-db-guard";

const ADMIN_EMAIL = "admin@alfatelecom.local";
/** Dedicated to this file — see the `beforeAll` note. */
const TECH_EMAIL = "tech-closing@alfatelecom.local";
const PASSWORD = "AlfaOS@2026";

/**
 * Closing an order is permanent, so this file must not touch the orders the
 * other specs rely on (10001 in `service-orders.spec.ts`, 10002/10003 in
 * `technician-execution.spec.ts`). The suite shares one seeded database and
 * does not reset between files.
 *
 * It therefore creates its OWN orders (10004/10005) directly in the test
 * database and deletes them afterwards. Creating them through the UI instead
 * would leave extra rows in `/ordens` while it runs, which would break the
 * "sync imports exactly 3" assertion in `service-orders.spec.ts`.
 */
const DESKTOP_ORDER = "10004";
const MOBILE_ORDER = "10005";

const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgresql://alfaos:alfaos_dev_password@localhost:5432/alfaos_test?schema=public";

const prisma = new PrismaClient({
  datasources: { db: { url: E2E_DATABASE_URL } },
});

/**
 * Direct detail URLs, captured when the orders are created.
 *
 * Navigating by id instead of clicking through `/ordens` keeps these tests
 * about the closing behaviour rather than about the list rendering, and
 * removes a whole class of "clicked the wrong row" flakiness.
 */
const orderUrls: Record<string, string> = {};
/**
 * Número OPERACIONAL de cada OS, indexado pelo número externo da fixture.
 *
 * A tela passou a identificar a OS por `OS Nº <number>` — sequencial por
 * empresa e alocado no servidor. O número externo continua existindo no
 * registro, mas não é mais o que aparece no card nem no cabeçalho, então a
 * asserção precisa do valor real alocado no `beforeAll`.
 */
const orderNumbers: Record<string, number> = {};

/** Rótulo operacional, com fronteira de palavra: `Nº 1` não casa com `Nº 12`. */
function osLabel(externalNumber: string): RegExp {
  return new RegExp(`OS Nº ${orderNumbers[externalNumber]}\\b`);
}

test.beforeAll(async () => {
  // Same guard as every other destructive path in the suite: never operate on
  // anything but a `_test` database.
  await assertTestDatabase(E2E_DATABASE_URL, "E2E_DATABASE_URL");

  // A DEDICATED user + technician, not the seeded `tech@alfatelecom.local`.
  // Linking the seeded one here would remove it from the "candidates" dropdown
  // and break `service-orders.spec.ts`, which links it through the UI itself.
  // The password hash is copied from the seeded technician so the same
  // credentials work without knowing the hashing parameters.
  const seeded = await prisma.user.findUniqueOrThrow({
    where: { email: "tech@alfatelecom.local" },
  });
  const techUser = await prisma.user.upsert({
    where: { email: TECH_EMAIL },
    update: { active: true },
    create: {
      companyId: seeded.companyId,
      name: "Tecnico Fechamento",
      email: TECH_EMAIL,
      profile: "TECHNICIAN",
      passwordHash: seeded.passwordHash,
    },
  });
  const technician = await prisma.technician.upsert({
    where: { userId: techUser.id },
    update: { active: true },
    create: { companyId: techUser.companyId, userId: techUser.id },
  });
  const customer = await prisma.customer.create({
    data: {
      companyId: techUser.companyId,
      name: "Cliente Fechamento E2E",
      city: "Belo Horizonte",
      state: "MG",
    },
  });

  for (const externalNumber of [DESKTOP_ORDER, MOBILE_ORDER]) {
    const created = await prisma.serviceOrder.create({
      data: {
        companyId: techUser.companyId,
        number: await allocateServiceOrderNumber(prisma, techUser.companyId),
        customerId: customer.id,
        technicianId: technician.id,
        externalNumber,
        type: "Instalação",
        description: `OS de fechamento ${externalNumber}.`,
        status: "ASSIGNED",
        assignedAt: new Date(),
      },
    });
    orderUrls[externalNumber] = `/ordens/${created.id}`;
    orderNumbers[externalNumber] = created.number;
  }
});

test.afterAll(async () => {
  // Restore the row count the other specs expect.
  const orders = await prisma.serviceOrder.findMany({
    where: { externalNumber: { in: [DESKTOP_ORDER, MOBILE_ORDER] } },
    select: { id: true, customerId: true },
  });
  const ids = orders.map((o) => o.id);

  // Delete the real files too. These tests drive the running app, so uploads
  // land in the app's own storage root — deleting only the rows would leave
  // orphaned bytes on disk after every run.
  if (ids.length > 0) {
    const [evidenceKeys, signatureKeys] = await Promise.all([
      prisma.serviceOrderEvidence.findMany({
        where: { serviceOrderId: { in: ids } },
        select: { storageKey: true },
      }),
      prisma.serviceOrderSignature.findMany({
        where: { serviceOrderId: { in: ids } },
        select: { storageKey: true },
      }),
    ]);
    const storageRoot = path.resolve(
      __dirname,
      "..",
      process.env.STORAGE_ROOT ?? ".storage",
    );
    const orderDirs = new Set<string>();
    for (const { storageKey } of [...evidenceKeys, ...signatureKeys]) {
      await fs
        .rm(path.resolve(storageRoot, storageKey), { force: true })
        .catch(() => undefined);
      // Key shape is `<companyId>/<orderId>/<file>`.
      orderDirs.add(path.resolve(storageRoot, path.dirname(storageKey)));
    }
    // Drop the now-empty per-order directories.
    for (const dir of Array.from(orderDirs)) {
      await fs.rmdir(dir).catch(() => undefined);
    }
  }

  if (ids.length > 0) {
    await prisma.serviceOrderEvidence.deleteMany({
      where: { serviceOrderId: { in: ids } },
    });
    await prisma.serviceOrderMaterialUsage.deleteMany({
      where: { serviceOrderId: { in: ids } },
    });
    await prisma.serviceOrderSignature.deleteMany({
      where: { serviceOrderId: { in: ids } },
    });
    await prisma.serviceOrderExecution.deleteMany({
      where: { serviceOrderId: { in: ids } },
    });
    await prisma.serviceOrderEvent.deleteMany({
      where: { serviceOrderId: { in: ids } },
    });
    await prisma.serviceOrder.deleteMany({ where: { id: { in: ids } } });
    await prisma.customer.deleteMany({
      where: { name: "Cliente Fechamento E2E" },
    });
  }
  // Remove the dedicated technician/user too, so a rerun starts clean and the
  // seeded fixtures are exactly as the other specs expect.
  const techUser = await prisma.user.findUnique({
    where: { email: TECH_EMAIL },
  });
  if (techUser) {
    await prisma.auditLog.deleteMany({ where: { userId: techUser.id } });
    await prisma.technician.deleteMany({ where: { userId: techUser.id } });
    await prisma.user.delete({ where: { id: techUser.id } });
  }
  await prisma.$disconnect();
});

const DIAGNOSIS = "Atenuação alta no ponto de entrada.";
/** Must not contain MATERIAL_NAME — both render on the closed page, and a
 *  substring match would make the assertions ambiguous under strict mode. */
const WORK_PERFORMED = "Fusão refeita e potência reajustada.";
const MATERIAL_NAME = "Conector SC/APC";
const SIGNER_NAME = "Maria Cliente";

/** Minimal valid PNG bytes, enough to pass magic-number sniffing. */
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(256, 7),
]);

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Senha").fill(PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

async function logout(page: Page) {
  await page.getByRole("button", { name: "Sair" }).click();
  await expect(page).toHaveURL(/\/login/);
}

/** Technician opens the order from Minhas OS and starts it. */
async function openAndStart(page: Page, orderNumber: string) {
  await page.goto("/minhas-os");
  await expect(page.getByRole("heading", { name: "Minhas OS" })).toBeVisible();
  await page.getByRole("link", { name: osLabel(orderNumber) }).click();
  await expect(page.getByRole("heading", { name: osLabel(orderNumber) })).toBeVisible();

  const start = page.getByRole("button", { name: "Iniciar atendimento" });
  if (await start.isVisible()) {
    page.once("dialog", (d) => d.accept());
    await start.click();
  }
  await expect(page.getByText("Status: Em atendimento")).toBeVisible();
}

async function fillExecution(page: Page) {
  await page.getByLabel("Diagnóstico").fill(DIAGNOSIS);
  await page.getByLabel("Serviço realizado").fill(WORK_PERFORMED);
  await page.getByRole("button", { name: "Salvar execução" }).click();
  await expect(page.getByText("Execução salva.")).toBeVisible();
}

async function addPhoto(page: Page) {
  await page.getByLabel("Adicionar foto").setInputFiles({
    name: "evidencia.png",
    mimeType: "image/png",
    buffer: PNG_BYTES,
  });
  await expect(page.getByText("Foto adicionada.")).toBeVisible();
}

async function addMaterial(page: Page) {
  await page.getByLabel("Material", { exact: true }).fill(MATERIAL_NAME);
  await page.getByLabel("Quantidade").fill("2");
  await page.getByRole("button", { name: "Adicionar material" }).click();
  await expect(page.getByText("Material adicionado.")).toBeVisible();
}

async function signAndSave(page: Page) {
  await page.getByLabel("Nome de quem assina").fill(SIGNER_NAME);
  const canvas = page.getByTestId("signature-canvas");
  // Mouse coordinates are viewport-relative: on a tall desktop page the canvas
  // sits below the fold and the strokes would land on whatever is there
  // instead. Scrolling it into view first is what makes the drawing land.
  await canvas.scrollIntoViewIfNeeded();
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + 60);
  await page.mouse.down();
  await page.mouse.move(box.x + 120, box.y + 100, { steps: 8 });
  await page.mouse.move(box.x + 200, box.y + 40, { steps: 8 });
  await page.mouse.up();
  await page.getByRole("button", { name: "Salvar assinatura" }).click();
  await expect(page.getByText("Assinatura salva.")).toBeVisible();
}

async function completeOrder(page: Page) {
  page.once("dialog", (d) => d.accept());
  await page.getByTestId("complete-order").click();
  await expect(page.getByTestId("completed-banner")).toBeVisible();
}

// ---------------------------------------------------------------------------
// E2E 1 + 2 — full closing flow, then persistence across a reload
// ---------------------------------------------------------------------------

test("técnico executa, anexa evidência, material, assinatura e finaliza a OS", async ({
  page,
}) => {
  await login(page, TECH_EMAIL);
  await openAndStart(page, DESKTOP_ORDER);

  await fillExecution(page);
  await addPhoto(page);
  await addMaterial(page);
  await signAndSave(page);

  await completeOrder(page);

  // E2E 2 — everything survives a reload.
  await page.reload();
  await expect(page.getByTestId("completed-banner")).toBeVisible();
  await expect(page.getByText(DIAGNOSIS)).toBeVisible();
  await expect(page.getByText(WORK_PERFORMED)).toBeVisible();
  await expect(page.getByText(MATERIAL_NAME)).toBeVisible();
  await expect(page.getByText(SIGNER_NAME).first()).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Evidências" }),
  ).toBeVisible();
  await expect(page.getByText("Atendimento concluído").first()).toBeVisible();
});

// ---------------------------------------------------------------------------
// E2E 3 — immutability
// ---------------------------------------------------------------------------

test("OS concluída sai da fila operacional e aparece em Concluídas recentes", async ({
  page,
}) => {
  await login(page, TECH_EMAIL);
  await page.goto("/minhas-os");
  await expect(page.getByRole("heading", { name: "Minhas OS" })).toBeVisible();

  const card = page.getByRole("link", {
    name: osLabel(DESKTOP_ORDER),
  });

  /**
   * Até a v0.5.1 a asserção aqui era `toHaveCount(0)`: a OS concluída
   * simplesmente sumia da tela. Continuava acessível por URL direta, mas
   * nenhuma navegação levava até ela, e o técnico perdia de vista o próprio
   * trabalho do dia.
   *
   * O comportamento correto passou a ser: fora das seções operacionais,
   * dentro de "Concluídas recentes".
   */
  for (const heading of ["Em atendimento", "Hoje", "Próximas"]) {
    const section = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: heading, exact: true }) });
    await expect(section.getByRole("link", { name: osLabel(DESKTOP_ORDER) })).toHaveCount(0);
  }

  const completed = page
    .locator("section")
    .filter({
      has: page.getByRole("heading", {
        name: "Concluídas recentes",
        exact: true,
      }),
    });
  await expect(completed.getByRole("link", { name: osLabel(DESKTOP_ORDER) })).toHaveCount(1);

  // Controle positivo do escopo: o card leva à OS certa.
  await card.first().click();
  await expect(page.getByTestId("completed-banner")).toBeVisible();
});

test("técnico abre a OS concluída pela URL e não encontra controles de escrita", async ({
  page,
}) => {
  await login(page, TECH_EMAIL);
  await page.goto(orderUrls[DESKTOP_ORDER]);
  await expect(page.getByTestId("completed-banner")).toBeVisible();

  await expect(page.getByTestId("complete-order")).toHaveCount(0);
  await expect(page.getByLabel("Adicionar foto")).toHaveCount(0);
  await expect(page.getByLabel("Material")).toHaveCount(0);
  await expect(page.getByTestId("signature-canvas")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Salvar execução" }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Remover" })).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// E2E 4 — staff read-only
// ---------------------------------------------------------------------------

test("ADMIN visualiza o fechamento em modo somente leitura", async ({ page }) => {
  await login(page, ADMIN_EMAIL);
  await page.goto(orderUrls[DESKTOP_ORDER]);

  await expect(page.getByTestId("completed-banner")).toBeVisible();
  await expect(page.getByText(DIAGNOSIS)).toBeVisible();
  await expect(page.getByText(WORK_PERFORMED)).toBeVisible();
  await expect(page.getByText(MATERIAL_NAME)).toBeVisible();
  await expect(page.getByText(SIGNER_NAME).first()).toBeVisible();
  await expect(page.getByText("Atendimento concluído").first()).toBeVisible();

  // No write affordance anywhere for staff.
  await expect(page.getByTestId("complete-order")).toHaveCount(0);
  await expect(page.getByLabel("Adicionar foto")).toHaveCount(0);
  await expect(page.getByTestId("signature-canvas")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Salvar execução" }),
  ).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// E2E 5 — mobile
// ---------------------------------------------------------------------------

test.describe("Fechamento — mobile 390x844", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("fluxo completo cabe na tela e é utilizável", async ({ page }) => {
    await login(page, TECH_EMAIL);
    await expectNoHorizontalOverflow(page, "minhas-os");

    await openAndStart(page, MOBILE_ORDER);
    await expectNoHorizontalOverflow(page, "detalhe iniciado");

    await fillExecution(page);
    await addPhoto(page);
    await expectNoHorizontalOverflow(page, "após evidência");

    await addMaterial(page);
    await expectNoHorizontalOverflow(page, "após material");

    await signAndSave(page);
    await expectNoHorizontalOverflow(page, "após assinatura");

    const complete = page.getByTestId("complete-order");
    await complete.scrollIntoViewIfNeeded();
    await expect(complete).toBeInViewport();
    await completeOrder(page);
    await expectNoHorizontalOverflow(page, "concluída");
  });
});

async function expectNoHorizontalOverflow(page: Page, label: string) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(
    scrollWidth,
    `${label}: página rola horizontalmente (${scrollWidth}px em ${clientWidth}px)`,
  ).toBeLessThanOrEqual(clientWidth + 1);
}
