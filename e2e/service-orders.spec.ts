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

/**
 * Abre a OS pelo número do ERP, via busca.
 *
 * A listagem passou a identificar a OS pelo número OPERACIONAL (sequencial por
 * empresa, alocado no servidor), então o número externo não é mais clicável
 * diretamente. Ele continua existindo no registro e continua buscável — que é
 * exatamente o que este helper exercita.
 */
async function openOrderByExternalNumber(page: Page, externalNumber: string) {
  await page.goto(`/ordens?search=${externalNumber}`);
  const rows = page.locator("tbody tr");
  await expect(rows).toHaveCount(1);
  await rows.getByRole("link").click();
  await expect(page).toHaveURL(new RegExp("/ordens/[a-z0-9]+$"));
}

/** Rótulo operacional da OS aberta, ex.: "OS Nº 4". */
async function currentOrderLabel(page: Page): Promise<string> {
  return (await page.getByTestId("order-number").innerText()).trim();
}

test("sync do Mock ERP importa OS e não duplica em nova sync", async ({
  page,
}) => {
  await login(page, ADMIN_EMAIL);
  await expect(page).toHaveURL(/\/dashboard/);

  await syncERP(page);

  await expect(page.locator("tbody tr")).toHaveCount(3);
  /*
    A coluna Nº mostra o número OPERACIONAL, não o do ERP. As três linhas
    precisam ter um, e números distintos entre si.
  */
  const numberCells = await page
    .locator("tbody tr td:first-child")
    .allInnerTexts();
  expect(numberCells).toHaveLength(3);
  expect(
    numberCells.every((text) => /^Nº \d+$/.test(text.trim())),
  ).toBe(true);
  expect(new Set(numberCells.map((t) => t.trim())).size).toBe(3);

  // O número do ERP continua gravado e continua encontrável pela busca.
  for (const externalNumber of ["10001", "10002", "10003"]) {
    await page.goto(`/ordens?search=${externalNumber}`);
    await expect(page.locator("tbody tr")).toHaveCount(1);
  }
  await page.goto("/ordens");

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

  await openOrderByExternalNumber(page, "10001");
  const orderLabel = await currentOrderLabel(page);
  expect(orderLabel).toMatch(/^OS Nº \d+$/);
  await expect(page.getByText("Pendente").first()).toBeVisible();

  /*
    O número do ERP e a origem viraram DETALHE na v0.7.4: moram em seções
    recolhidas, e a tela abre com elas fechadas de propósito.

    Exigir `toBeVisible()` sobre conteúdo de um `<details>` fechado testaria o
    contrário do que o produto decidiu. O teste correto é o que um operador
    faz: confere que a seção está lá, abre, e então lê o conteúdo.
  */
  const integracao = page.getByTestId("integration-section");
  await expect(integracao).toBeVisible();
  await integracao.locator("summary").click();
  await expect(integracao.getByText("10001")).toBeVisible();

  const administrativos = page.getByTestId("admin-details-section");
  await expect(administrativos).toBeVisible();
  await administrativos.locator("summary").click();
  // Origem + provider: "Externa" sozinha nao diz de onde a OS veio.
  await expect(administrativos.getByText("Externa (ERP) · MOCK")).toBeVisible();
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
  await expect(
    page.getByRole("link", { name: new RegExp(`${orderLabel}\\b`) }),
  ).toBeVisible();

  await logout(page);
  await login(page, TECH2_EMAIL);
  await expect(page).toHaveURL(/\/minhas-os/);
  await expect(
    page.getByRole("link", { name: new RegExp(`${orderLabel}\\b`) }),
  ).toHaveCount(0);
  await page.goto(orderUrl);
  await expect(page.getByText("This page could not be found.")).toBeVisible();

  await logout(page);
  await login(page, ADMIN_EMAIL);
  await expect(page).toHaveURL(/\/dashboard/);
  await syncERP(page);
  await expect(page.locator("tbody tr")).toHaveCount(3);
  await openOrderByExternalNumber(page, "10001");
  // A reimportação não renumerou a OS: o número operacional é imutável.
  expect(await currentOrderLabel(page)).toBe(orderLabel);
  await expect(page.locator('span:text-is("Atribuída")')).toBeVisible();
  await expect(page.getByText("Tecnico Alfa").first()).toBeVisible();
});
