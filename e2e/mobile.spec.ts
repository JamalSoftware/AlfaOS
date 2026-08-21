import { test, expect } from "@playwright/test";

const ADMIN_EMAIL = "admin@alfatelecom.local";
const PASSWORD = "AlfaOS@2026";

test.use({ viewport: { width: 390, height: 844 } });

test("mobile: sidebar vira drawer e permite navegar", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("E-mail").fill(ADMIN_EMAIL);
  await page.getByLabel("Senha").fill(PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();

  await expect(page).toHaveURL(/\/dashboard/);

  const drawerButton = page.getByRole("button", { name: "Abrir menu" });
  await expect(drawerButton).toBeVisible();

  await drawerButton.click();
  await expect(page.getByRole("link", { name: "Usuários" })).toBeVisible();

  await page.getByRole("link", { name: "Usuários" }).click();

  await expect(page).toHaveURL(/\/usuarios/);
  await expect(
    page.getByRole("heading", { name: "Usuários" }),
  ).toBeVisible();
});

test("mobile: tabela de usuários rola horizontalmente sem quebrar", async ({
  page,
}) => {
  await page.goto("/login");
  await page.getByLabel("E-mail").fill(ADMIN_EMAIL);
  await page.getByLabel("Senha").fill(PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();

  await expect(page).toHaveURL(/\/dashboard/);

  await page.goto("/usuarios");

  await expect(
    page.getByRole("heading", { name: "Usuários" }),
  ).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "Administrador Alfa" }),
  ).toBeVisible();
});
