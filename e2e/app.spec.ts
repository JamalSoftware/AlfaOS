import { test, expect, type Page } from "@playwright/test";

const ADMIN_EMAIL = "admin@alfatelecom.local";
const TECH_EMAIL = "tech@alfatelecom.local";
const PASSWORD = "AlfaOS@2026";

async function login(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Senha").fill(password);
  await page.getByRole("button", { name: "Entrar" }).click();
}

test("admin faz login e acessa o dashboard", async ({ page }) => {
  await login(page, ADMIN_EMAIL, PASSWORD);

  await expect(page).toHaveURL(/\/dashboard/);
  await expect(
    page.getByRole("heading", { name: "Dashboard" }),
  ).toBeVisible();
  await expect(
    page.getByText("Bem-vindo(a), Administrador Alfa"),
  ).toBeVisible();
});

test("técnico não acessa área administrativa", async ({ page }) => {
  await login(page, TECH_EMAIL, PASSWORD);

  await expect(page).toHaveURL(/\/minhas-os/);
  await expect(
    page.getByRole("heading", { name: /Minhas OS/ }),
  ).toBeVisible();

  await page.goto("/usuarios");
  await expect(page).toHaveURL(/\/minhas-os/);
});

test("admin cria usuário da própria empresa", async ({ page }) => {
  const email = `e2e-${Date.now()}@alfatelecom.local`;

  await login(page, ADMIN_EMAIL, PASSWORD);
  await expect(page).toHaveURL(/\/dashboard/);

  await page.goto("/usuarios/novo");
  await page.getByLabel("Nome").fill("Usuário E2E");
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Senha inicial").fill("E2eSenha@123");
  await page.getByLabel("Perfil de acesso").selectOption("TECHNICIAN");
  await page.getByRole("button", { name: "Criar usuário" }).click();

  await expect(page).toHaveURL(/\/usuarios$/);
  await expect(page.getByText(email)).toBeVisible();
});

test("logout invalida a sessão", async ({ page }) => {
  await login(page, ADMIN_EMAIL, PASSWORD);
  await expect(page).toHaveURL(/\/dashboard/);

  await page.getByRole("button", { name: "Sair" }).click();

  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByLabel("E-mail")).toBeVisible();
});

test("administrador acessa integrações e altera estado", async ({ page }) => {
  await login(page, ADMIN_EMAIL, PASSWORD);
  await expect(page).toHaveURL(/\/dashboard/);

  await page.goto("/integracoes");
  await expect(
    page.getByRole("heading", { name: "Integrações" }),
  ).toBeVisible();

  const status = page.getByTestId("integration-enabled");
  const toggle = page.getByRole("button", {
    name: /Habilitar|Desabilitar/,
  });

  const initiallyEnabled = (await status.textContent())?.trim() === "Habilitada";
  await toggle.click();
  await expect(status).toHaveText(initiallyEnabled ? "Desabilitada" : "Habilitada");

  // Restore the original state so subsequent tests are not affected.
  await toggle.click();
  await expect(status).toHaveText(initiallyEnabled ? "Habilitada" : "Desabilitada");
});
