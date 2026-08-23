import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { assertTestDatabase } from "./test-db-guard";

const ADMIN_EMAIL = "admin@alfatelecom.local";
/**
 * Técnicos dedicados a este arquivo, pelo mesmo motivo dos outros specs: os
 * técnicos do seed são vinculados pela interface em `service-orders.spec.ts`,
 * e mexer neles aqui quebraria aquele arquivo.
 */
const TECH_EMAIL = "tech-pppoe@alfatelecom.local";
const OTHER_TECH_EMAIL = "tech-pppoe-2@alfatelecom.local";
const PASSWORD = "AlfaOS@2026";

const CUSTOMER_NAME = "Cliente PPPoE E2E";
const CONNECTION_USERNAME = "pppoe-e2e@provedor";
/** Valor distintivo: procurado literalmente dentro do HTML servido. */
const CONNECTION_PASSWORD = "Sen#aPPPoE-E2E-Zq7W";
const ORDER_DESCRIPTION = "OS do E2E de acesso PPPoE.";

const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgresql://alfaos:alfaos_dev_password@localhost:5432/alfaos_test?schema=public";

const prisma = new PrismaClient({
  datasources: { db: { url: E2E_DATABASE_URL } },
});

let customerId = "";
let orderUrl = "";
let customerEditUrl = "";

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Senha").fill(PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
}

test.beforeAll(async () => {
  await assertTestDatabase(E2E_DATABASE_URL, "E2E_DATABASE_URL");

  const seeded = await prisma.user.findUniqueOrThrow({
    where: { email: "tech@alfatelecom.local" },
  });

  const techUser = await prisma.user.upsert({
    where: { email: TECH_EMAIL },
    update: { active: true },
    create: {
      companyId: seeded.companyId,
      name: "Tecnico PPPoE",
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

  const otherUser = await prisma.user.upsert({
    where: { email: OTHER_TECH_EMAIL },
    update: { active: true },
    create: {
      companyId: seeded.companyId,
      name: "Tecnico PPPoE 2",
      email: OTHER_TECH_EMAIL,
      profile: "TECHNICIAN",
      passwordHash: seeded.passwordHash,
    },
  });
  await prisma.technician.upsert({
    where: { userId: otherUser.id },
    update: { active: true },
    create: { companyId: otherUser.companyId, userId: otherUser.id },
  });

  const customer = await prisma.customer.create({
    data: { companyId: techUser.companyId, name: CUSTOMER_NAME },
  });
  customerId = customer.id;
  customerEditUrl = `/clientes/${customer.id}/editar`;

  const order = await prisma.serviceOrder.create({
    data: {
      companyId: techUser.companyId,
      customerId: customer.id,
      technicianId: technician.id,
      type: "Manutenção",
      description: ORDER_DESCRIPTION,
      status: "ASSIGNED",
      assignedAt: new Date(),
    },
  });
  orderUrl = `/ordens/${order.id}`;
});

test.afterAll(async () => {
  const orders = await prisma.serviceOrder.findMany({
    where: { description: ORDER_DESCRIPTION },
    select: { id: true },
  });
  const ids = orders.map((o) => o.id);
  if (ids.length > 0) {
    await prisma.serviceOrderEvent.deleteMany({
      where: { serviceOrderId: { in: ids } },
    });
    await prisma.serviceOrder.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.customerConnection.deleteMany({ where: { customerId } });
  await prisma.customer.deleteMany({ where: { name: CUSTOMER_NAME } });
  const emails = [TECH_EMAIL, OTHER_TECH_EMAIL];
  await prisma.technician.deleteMany({
    where: { user: { email: { in: emails } } },
  });
  await prisma.user.deleteMany({ where: { email: { in: emails } } });
  await prisma.$disconnect();
});

test("ADMIN cadastra a conexão e a senha nunca reaparece na tela", async ({
  page,
}) => {
  await login(page, ADMIN_EMAIL);
  await expect(page).toHaveURL(/\/dashboard/);

  await page.goto(customerEditUrl);
  await page.getByLabel("Usuário *").fill(CONNECTION_USERNAME);
  await page.getByLabel("Senha", { exact: true }).fill(CONNECTION_PASSWORD);
  await page.getByRole("button", { name: "Cadastrar conexão" }).click();

  await expect(page.getByText("Senha: Configurada")).toBeVisible();
  await expect(page.getByText(CONNECTION_USERNAME)).toBeVisible();

  // A senha não pode voltar nem no HTML nem em nenhum input, agora...
  expect(await page.content()).not.toContain(CONNECTION_PASSWORD);

  // ...nem depois de recarregar, que é quando um "preencher o formulário com o
  // valor atual" descuidado apareceria.
  await page.reload();
  await expect(page.getByText("Senha: Configurada")).toBeVisible();
  expect(await page.content()).not.toContain(CONNECTION_PASSWORD);
});

test("a senha não está no HTML inicial da OS e só aparece após o clique", async ({
  page,
}) => {
  await login(page, TECH_EMAIL);
  await expect(page).toHaveURL(/\/minhas-os/);

  await page.goto(orderUrl);
  await expect(page.getByTestId("pppoe-panel")).toBeVisible();
  await expect(page.getByTestId("pppoe-username")).toHaveText(
    CONNECTION_USERNAME,
  );

  /**
   * O ponto central desta versão: a resposta inicial da OS não carrega o texto
   * claro. `page.content()` é o DOM servido e hidratado — se a senha estivesse
   * em props de Server Component, ela apareceria aqui.
   */
  expect(await page.content()).not.toContain(CONNECTION_PASSWORD);
  await expect(page.getByTestId("pppoe-password")).toHaveText("••••••••••");

  await page.getByTestId("pppoe-reveal").click();
  await expect(page.getByTestId("pppoe-password")).toHaveText(
    CONNECTION_PASSWORD,
  );

  // Ocultar tira do DOM de novo.
  await page.getByRole("button", { name: "Ocultar" }).click();
  await expect(page.getByTestId("pppoe-password")).toHaveText("••••••••••");
  expect(await page.content()).not.toContain(CONNECTION_PASSWORD);
});

test("técnico de outro atendimento não alcança a OS nem a senha", async ({
  page,
}) => {
  await login(page, OTHER_TECH_EMAIL);
  await expect(page).toHaveURL(/\/minhas-os/);

  await page.goto(orderUrl);
  await expect(page.getByText("This page could not be found.")).toBeVisible();
  expect(await page.content()).not.toContain(CONNECTION_PASSWORD);
});

test("após concluir a OS o técnico deixa de poder revelar", async ({ page }) => {
  await prisma.serviceOrder.updateMany({
    where: { description: ORDER_DESCRIPTION },
    data: { status: "COMPLETED", completedAt: new Date() },
  });

  await login(page, TECH_EMAIL);
  // Espera o redirect do login terminar: sem isso o goto corre contra ele e
  // aterrissa de volta em /minhas-os.
  await expect(page).toHaveURL(/\/minhas-os/);
  await page.goto(orderUrl);

  await expect(page.getByTestId("pppoe-panel")).toBeVisible();
  // O usuário continua visível — é a SENHA que deixa de ser revelável.
  await expect(page.getByTestId("pppoe-username")).toHaveText(
    CONNECTION_USERNAME,
  );
  await expect(page.getByTestId("pppoe-reveal")).toHaveCount(0);
  await expect(
    page.getByText(
      "A senha só pode ser revelada enquanto o atendimento estiver em andamento.",
    ),
  ).toBeVisible();
  expect(await page.content()).not.toContain(CONNECTION_PASSWORD);

  // Devolve o estado para não interferir em nada que rode depois.
  await prisma.serviceOrder.updateMany({
    where: { description: ORDER_DESCRIPTION },
    data: { status: "ASSIGNED", completedAt: null },
  });
});
