import { test, expect, type Page } from "@playwright/test";

const ADMIN_EMAIL = "admin@alfatelecom.local";
const TECH_EMAIL = "tech@alfatelecom.local";
const TECH2_EMAIL = "tech2@alfatelecom.local";
const PASSWORD = "AlfaOS@2026";

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Senha").fill(PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
}

async function logout(page: Page) {
  await page.getByRole("button", { name: "Sair" }).click();
  await expect(page).toHaveURL(/\/login/);
}

async function syncERP(page: Page) {
  await page.goto("/ordens");
  await page.getByRole("button", { name: "Sincronizar Mock ERP" }).click();
  await expect(page.getByText(/Sincronizado:/)).toBeVisible();
}

test("sync do Mock ERP importa OS e não duplica em nova sync", async ({
  page,
}) => {
  await login(page, ADMIN_EMAIL);
  await expect(page).toHaveURL(/\/dashboard/);

  await syncERP(page);

  await expect(page.getByText("10001")).toBeVisible();
  await expect(page.getByText("10002")).toBeVisible();
  await expect(page.getByText("10003")).toBeVisible();
  await expect(page.locator("tbody tr")).toHaveCount(3);

  await page.getByRole("button", { name: "Sincronizar Mock ERP" }).click();
  await expect(page.getByText(/0 criadas, 3 atualizadas/)).toBeVisible();
  await expect(page.locator("tbody tr")).toHaveCount(3);
});

test("critério de aceite: sync, atribuição e ownership do técnico", async ({
  page,
}) => {
  await login(page, ADMIN_EMAIL);
  await expect(page).toHaveURL(/\/dashboard/);

  await syncERP(page);

  await page.getByRole("link", { name: "10001" }).click();
  await expect(page.getByRole("heading", { name: /OS 10001/ })).toBeVisible();
  await expect(page.getByText("Pendente").first()).toBeVisible();
  // Origem + provider: "Externa" sozinha nao diz de onde a OS veio.
  await expect(page.getByText("Externa (ERP) · MOCK")).toBeVisible();
  const orderUrl = page.url();

  await page.goto("/tecnicos/novo");
  await page.getByLabel("Usuário").selectOption({
    label: "Tecnico Alfa (tech@alfatelecom.local)",
  });
  await page.getByRole("button", { name: "Vincular técnico" }).click();
  await expect(page).toHaveURL(/\/tecnicos$/);
  await expect(page.getByText("Tecnico Alfa")).toBeVisible();

  await page.goto(orderUrl);
  await page.getByLabel("Técnico").selectOption({ label: "Tecnico Alfa" });
  await page.getByRole("button", { name: "Atribuir OS" }).click();
  await expect(page.locator('span:text-is("Atribuída")')).toBeVisible();
  await expect(page.getByText("Técnico atribuído")).toBeVisible();

  await logout(page);
  await login(page, TECH_EMAIL);
  await expect(page).toHaveURL(/\/minhas-os/);
  await expect(page.getByRole("heading", { name: "Minhas OS" })).toBeVisible();
  await expect(page.getByRole("link", { name: /OS 10001/ })).toBeVisible();

  await logout(page);
  await login(page, TECH2_EMAIL);
  await expect(page).toHaveURL(/\/minhas-os/);
  await expect(page.getByRole("link", { name: /OS 10001/ })).toHaveCount(0);
  await page.goto(orderUrl);
  await expect(page.getByText("This page could not be found.")).toBeVisible();

  await logout(page);
  await login(page, ADMIN_EMAIL);
  await expect(page).toHaveURL(/\/dashboard/);
  await syncERP(page);
  await expect(page.locator("tbody tr")).toHaveCount(3);
  await page.getByRole("link", { name: "10001" }).click();
  await expect(page.locator('span:text-is("Atribuída")')).toBeVisible();
  await expect(page.getByText("Tecnico Alfa").first()).toBeVisible();
});
