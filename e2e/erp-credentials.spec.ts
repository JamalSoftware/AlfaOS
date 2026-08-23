import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { assertTestDatabase } from "./test-db-guard";

const ADMIN_EMAIL = "admin@alfatelecom.local";
const DISPATCHER_EMAIL = "dispatcher@alfatelecom.local";
const PASSWORD = "AlfaOS@2026";

/**
 * A recognizable token so the assertions below can prove it never appears in
 * the page HTML after being saved.
 */
const TOKEN = "e2e_secret_token_do_not_leak_ABCD";
const TOKEN_LAST4 = "ABCD";

const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgresql://alfaos:alfaos_dev_password@localhost:5432/alfaos_test?schema=public";

const prisma = new PrismaClient({
  datasources: { db: { url: E2E_DATABASE_URL } },
});

test.beforeAll(async () => {
  await assertTestDatabase(E2E_DATABASE_URL, "E2E_DATABASE_URL");
});

/** Leaves the seeded integration exactly as the other specs expect it. */
test.afterAll(async () => {
  const admin = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL } });
  if (admin) {
    await prisma.eRPIntegration.updateMany({
      where: { companyId: admin.companyId },
      data: {
        credentialCiphertext: null,
        credentialIv: null,
        credentialAuthTag: null,
        credentialLast4: null,
        credentialUpdatedAt: null,
      },
    });
    await prisma.auditLog.deleteMany({
      where: { action: { startsWith: "ERP_CREDENTIAL" } },
    });
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

test("ADMIN salva a credencial e o token nunca reaparece na tela", async ({
  page,
}) => {
  await login(page, ADMIN_EMAIL);
  await page.goto("/integracoes");

  await expect(page.getByTestId("erp-credential")).toBeVisible();
  await expect(page.getByTestId("credential-status")).toContainText(
    "Não configurada",
  );

  await page.getByTestId("credential-input").fill(TOKEN);
  await page.getByTestId("credential-save").click();

  await expect(page.getByTestId("credential-status")).toContainText(
    "Credencial configurada",
  );
  await expect(page.getByTestId("credential-masked")).toContainText(TOKEN_LAST4);
  // "Configured" is explicitly not "validated".
  await expect(page.getByTestId("credential-notice")).toContainText(
    "documentação oficial",
  );

  // The decisive assertion: the full token is nowhere in the rendered page.
  expect(await page.content()).not.toContain(TOKEN);

  // Nor after a full reload, where the HTML comes fresh from the server.
  await page.reload();
  await expect(page.getByTestId("credential-masked")).toContainText(TOKEN_LAST4);
  expect(await page.content()).not.toContain(TOKEN);

  // And the database holds ciphertext, not the token.
  const row = await prisma.eRPIntegration.findFirstOrThrow({
    where: { company: { users: { some: { email: ADMIN_EMAIL } } } },
  });
  expect(JSON.stringify(row)).not.toContain(TOKEN);
  expect(row.credentialCiphertext).not.toBeNull();
});

test("ADMIN substitui e remove a credencial", async ({ page }) => {
  await login(page, ADMIN_EMAIL);
  await page.goto("/integracoes");

  // Replace: the form is hidden until the admin asks for it.
  await page.getByTestId("credential-replace").click();
  await page.getByTestId("credential-input").fill("outro_token_totalmente_novo_WXYZ");
  await page.getByTestId("credential-save").click();
  await expect(page.getByTestId("credential-masked")).toContainText("WXYZ");

  page.once("dialog", (d) => d.accept());
  await page.getByTestId("credential-remove").click();
  await expect(page.getByTestId("credential-status")).toContainText(
    "Não configurada",
  );
});

test("DISPATCHER não acessa a tela de integrações", async ({ page }) => {
  await login(page, DISPATCHER_EMAIL);
  await page.goto("/integracoes");
  // The page is ADMIN-only; the credential form must not be reachable.
  await expect(page.getByTestId("erp-credential")).toHaveCount(0);
});
