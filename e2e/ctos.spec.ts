import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { assertTestDatabase } from "./test-db-guard";

/**
 * # CTO-1 — fluxo real do ADMIN pela interface
 *
 * Pela UI de verdade, e não por chamada de API disfarçada de teste de tela: o
 * que este spec cobre é justamente o que os testes de rota não veem — a
 * capability escondendo o módulo, o menu, e a sequência que o operador segue.
 *
 * **Este spec liga e DESLIGA a capability.** A empresa semeada não a tem, e os
 * outros specs contam com isso; deixar ligada mudaria o menu que eles
 * inspecionam. O `afterAll` devolve o banco como o encontrou — inclusive as
 * CTOs criadas, que nenhum outro spec espera encontrar.
 */

const ADMIN_EMAIL = "admin@alfatelecom.local";
const DISPATCHER_EMAIL = "dispatcher@alfatelecom.local";
const PASSWORD = "AlfaOS@2026";

const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgresql://alfaos:alfaos_dev_password@localhost:5432/alfaos_test?schema=public";

const prisma = new PrismaClient({
  datasources: { db: { url: E2E_DATABASE_URL } },
});

async function companyId(): Promise<string> {
  const admin = await prisma.user.findUniqueOrThrow({
    where: { email: ADMIN_EMAIL },
  });
  return admin.companyId;
}

async function setCapability(enabled: boolean) {
  await prisma.company.update({
    where: { id: await companyId() },
    data: { ctoNetworkEnabled: enabled },
  });
}

test.beforeAll(async () => {
  await assertTestDatabase(E2E_DATABASE_URL, "E2E_DATABASE_URL");
});

test.afterAll(async () => {
  /*
    Limpeza por ESCOPO, não por padrão de nome.

    Apagar "o que parece de teste" é como uma suíte come dado real. Aqui o
    escopo é preciso: as CTOs desta empresa, que só este spec cria, e as portas
    delas — que precisam sair primeiro porque a FK é `Restrict`.
  */
  const company = await companyId();
  await prisma.cTOPort.deleteMany({ where: { companyId: company } });
  await prisma.cTO.deleteMany({ where: { companyId: company } });
  await prisma.auditLog.deleteMany({
    where: { companyId: company, action: { startsWith: "CTO." } },
  });
  await setCapability(false);
  await prisma.$disconnect();
});

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Senha").fill(PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

test("com a capability desligada o módulo não aparece nem responde", async ({
  page,
}) => {
  await setCapability(false);
  await login(page, ADMIN_EMAIL);

  // Não está no menu.
  await expect(
    page.getByRole("link", { name: "CTOs", exact: true }),
  ).toHaveCount(0);

  // E a proteção não é o menu: ir direto na URL também não entra.
  const res = await page.goto("/ctos");
  expect(res?.status()).toBe(404);
});

test("ADMIN cadastra, opera as portas, muda capacidade e inativa", async ({
  page,
}) => {
  await setCapability(true);
  await login(page, ADMIN_EMAIL);

  // O item aparece assim que a empresa tem o módulo.
  await page.getByRole("link", { name: "CTOs", exact: true }).click();
  await expect(page).toHaveURL(/\/ctos$/);

  // --- criar ---------------------------------------------------------------
  const nome = `E2E-A16-${Date.now()}`;
  await page.getByLabel("Nome").fill(nome);
  await page.getByLabel("Capacidade (portas)").fill("8");
  await page
    .getByLabel("Referência de endereço (opcional)")
    .fill("Poste em frente ao nº 340");
  await page.getByRole("button", { name: "Cadastrar CTO" }).click();

  await expect(page.getByRole("link", { name: nome })).toBeVisible();

  // --- abrir o detalhe -----------------------------------------------------
  await page.getByRole("link", { name: nome }).click();
  await expect(page.getByRole("heading", { name: nome })).toBeVisible();

  // As oito portas nasceram com a caixa.
  await expect(page.getByTestId("cto-port-row")).toHaveCount(8);
  await expect(page.getByTestId("cto-free")).toHaveText("8");

  // --- reservar, danificar, liberar ---------------------------------------
  const porta1 = page.getByTestId("cto-port-row").first();
  await porta1.getByRole("button", { name: "Reservar" }).click();
  await expect(page.getByTestId("cto-port-state-1")).toHaveText("Reservada");
  // Reservada sai da contagem de livres — não está livre, e nunca esteve
  // ocupada.
  await expect(page.getByTestId("cto-free")).toHaveText("7");

  await porta1.getByRole("button", { name: "Danificada" }).click();
  await expect(page.getByTestId("cto-port-state-1")).toHaveText("Danificada");

  await porta1.getByRole("button", { name: "Liberar" }).click();
  await expect(page.getByTestId("cto-port-state-1")).toHaveText("Livre");
  await expect(page.getByTestId("cto-free")).toHaveText("8");

  // --- aumentar capacidade -------------------------------------------------
  await page.getByLabel("Portas").fill("12");
  await page.getByRole("button", { name: "Alterar capacidade" }).click();
  await expect(page.getByTestId("cto-port-row")).toHaveCount(12);

  // --- redução recusada por porta reservada acima do limite ---------------
  const porta12 = page.getByTestId("cto-port-row").nth(11);
  await porta12.getByRole("button", { name: "Reservar" }).click();
  await expect(page.getByTestId("cto-port-state-12")).toHaveText("Reservada");

  await page.getByLabel("Portas").fill("8");
  await page.getByRole("button", { name: "Alterar capacidade" }).click();
  await expect(page.getByTestId("cto-error")).toContainText(
    "Não é possível reduzir a capacidade",
  );
  // A recusa é total: continuam 12 portas.
  await expect(page.getByTestId("cto-port-row")).toHaveCount(12);

  // --- liberar e reduzir ---------------------------------------------------
  await page.getByTestId("cto-port-row").nth(11).getByRole("button", {
    name: "Liberar",
  }).click();
  await expect(page.getByTestId("cto-port-state-12")).toHaveText("Livre");

  await page.getByLabel("Portas").fill("8");
  await page.getByRole("button", { name: "Alterar capacidade" }).click();

  /*
    Reduzir NÃO apaga porta: as doze linhas continuam na tela, e as quatro
    acima da capacidade aparecem marcadas. Se este spec esperasse 8 linhas,
    estaria pedindo o comportamento que a fase decidiu não ter.
  */
  await expect(page.getByTestId("cto-port-row")).toHaveCount(12);
  await expect(page.getByText("Fora da capacidade")).toHaveCount(4);

  // --- inativar ------------------------------------------------------------
  await page.getByRole("button", { name: "Inativar CTO" }).click();
  await expect(page.getByRole("button", { name: "Reativar CTO" })).toBeVisible();
});

test("DISPATCHER não alcança o módulo", async ({ page }) => {
  await setCapability(true);
  await login(page, DISPATCHER_EMAIL);

  await expect(
    page.getByRole("link", { name: "CTOs", exact: true }),
  ).toHaveCount(0);

  // A página é de ADMIN: o despachante é redirecionado, não entra.
  await page.goto("/ctos");
  await expect(page).not.toHaveURL(/\/ctos$/);
});
