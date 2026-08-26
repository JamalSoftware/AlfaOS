import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { allocateServiceOrderNumber } from "../src/lib/service-order-number";
import { assertTestDatabase } from "./test-db-guard";

const ADMIN_EMAIL = "admin@alfatelecom.local";
/**
 * Dois técnicos DEDICADOS a este arquivo.
 *
 * Não uso `tech@`/`tech2@` do seed: eles podem não ter registro `Technician`
 * ainda (quem os vincula é `service-orders.spec.ts`, que roda depois), e
 * vinculá-los aqui os removeria da lista de candidatos daquele arquivo.
 */
const TECH_EMAIL = "tech-types@alfatelecom.local";
const OTHER_TECH_EMAIL = "tech-types-2@alfatelecom.local";
const PASSWORD = "AlfaOS@2026";

/**
 * Este arquivo cria uma OS pela interface, então precisa remover tudo que criou
 * no `afterAll`. `service-orders.spec.ts` roda logo depois e afirma que o sync
 * importa exatamente 3 OS — uma linha manual sobrevivente quebraria aquela
 * contagem.
 */
const TYPE_NAME = "Vistoria E2E";
/**
 * Tipo EXCLUSIVO do teste de desativação.
 *
 * Antes ele reaproveitava o tipo que o teste anterior criava pela interface.
 * Funcionava enquanto o vizinho passasse; quando o vizinho falhou, este falhou
 * junto — por um motivo que nada tinha a ver com o que ele verifica. A
 * auditoria da v0.7.x registrou a cascata. Estado próprio elimina a classe.
 */
const TYPE_TOGGLE = "Vistoria E2E (desativação)";
const ORDER_DESCRIPTION = "OS interna criada pelo E2E de tipos.";
const TOGGLE_ORDER_DESCRIPTION = "OS do E2E de desativação de tipo.";
const CUSTOMER_NAME = "Cliente Tipos E2E";
const COMPLETED_DESCRIPTION = "Atendimento concluído do E2E de tipos.";

const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgresql://alfaos:alfaos_dev_password@localhost:5432/alfaos_test?schema=public";

const prisma = new PrismaClient({
  datasources: { db: { url: E2E_DATABASE_URL } },
});

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
      name: "Tecnico Tipos",
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
  // Segundo técnico, sem nenhuma OS concluída: é o controle negativo.
  const otherUser = await prisma.user.upsert({
    where: { email: OTHER_TECH_EMAIL },
    update: { active: true },
    create: {
      companyId: seeded.companyId,
      name: "Tecnico Tipos 2",
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

  // Uma OS já concluída, para a seção "Concluídas recentes" ter o que mostrar
  // sem depender de o técnico executar um atendimento inteiro aqui.
  await prisma.serviceOrder.create({
    data: {
      companyId: techUser.companyId,
      number: await allocateServiceOrderNumber(prisma, techUser.companyId),
      customerId: customer.id,
      technicianId: technician.id,
      type: "Instalação",
      description: COMPLETED_DESCRIPTION,
      status: "COMPLETED",
      completedAt: new Date(),
    },
  });
});

test.afterAll(async () => {
  const orders = await prisma.serviceOrder.findMany({
    where: {
      description: {
        in: [ORDER_DESCRIPTION, COMPLETED_DESCRIPTION, TOGGLE_ORDER_DESCRIPTION],
      },
    },
    select: { id: true },
  });
  const ids = orders.map((o) => o.id);
  if (ids.length > 0) {
    await prisma.serviceOrderEvent.deleteMany({
      where: { serviceOrderId: { in: ids } },
    });
    await prisma.serviceOrder.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.customer.deleteMany({ where: { name: CUSTOMER_NAME } });
  // Depois das OS: o vínculo typeId é onDelete Restrict.
  await prisma.serviceOrderType.deleteMany({
    where: { name: { in: [TYPE_NAME, TYPE_TOGGLE] } },
  });
  const emails = [TECH_EMAIL, OTHER_TECH_EMAIL];
  await prisma.technician.deleteMany({
    where: { user: { email: { in: emails } } },
  });
  await prisma.user.deleteMany({ where: { email: { in: emails } } });
  await prisma.$disconnect();
});

test("ADMIN cria tipo, abre OS interna com ele e vê a origem no detalhe", async ({
  page,
}) => {
  await login(page, ADMIN_EMAIL);
  await expect(page).toHaveURL(/\/dashboard/);

  await page.goto("/tipos-os");
  await page.getByLabel("Nome *").fill(TYPE_NAME);
  await page.getByRole("button", { name: "Criar tipo" }).click();
  await expect(page.getByRole("cell", { name: TYPE_NAME })).toBeVisible();

  await page.goto("/ordens/novo");
  await page.getByLabel("Cliente *").selectOption({ label: CUSTOMER_NAME });
  await page.getByLabel("Tipo *").selectOption({ label: TYPE_NAME });
  await page.getByLabel("Descrição *").fill(ORDER_DESCRIPTION);
  await page.getByRole("button", { name: "Criar OS" }).click();

  await expect(page).toHaveURL(/\/ordens\/[a-z0-9]+$/);
  // O rótulo do tipo foi copiado do catálogo e continua na visão principal.
  await expect(page.getByText(TYPE_NAME).first()).toBeVisible();

  /*
    A origem é INTERNAL porque a OS nasceu aqui — não porque falta id externo.

    Ela mora em "Detalhes administrativos" desde a v0.7.4, recolhida. Abrir a
    seção é parte do teste: é o que o operador faz, e é o que prova que o dado
    continua alcançável depois da compactação.
  */
  const administrativos = page.getByTestId("admin-details-section");
  await expect(administrativos).toBeVisible();
  await administrativos.locator("summary").click();
  await expect(administrativos.getByText("Interna (AlfaOS)")).toBeVisible();
});

test("tipo desativado sai do formulário de nova OS sem afetar a OS já criada", async ({
  page,
}) => {
  /*
    Estado PRÓPRIO, criado aqui — o teste roda sozinho.

    O tipo e a OS que ele precisa são dele, e não sobras do teste anterior.
    Criados pelo Prisma porque o que está sob teste é DESATIVAR um tipo, não
    cadastrá-lo: cadastrar pela interface já é o teste de cima.
  */
  const customer = await prisma.customer.findFirstOrThrow({
    where: { name: CUSTOMER_NAME },
  });
  const tipo = await prisma.serviceOrderType.create({
    data: { companyId: customer.companyId, name: TYPE_TOGGLE, sortOrder: 90 },
  });
  await prisma.serviceOrder.create({
    data: {
      companyId: customer.companyId,
      number: await allocateServiceOrderNumber(prisma, customer.companyId),
      customerId: customer.id,
      typeId: tipo.id,
      // Rótulo copiado, como faz a criação real: é ele que sobrevive à
      // desativação do catálogo.
      type: TYPE_TOGGLE,
      description: TOGGLE_ORDER_DESCRIPTION,
      status: "PENDING",
    },
  });

  await login(page, ADMIN_EMAIL);
  // Espera a navegacao do login terminar: sem isso o goto abaixo corre contra
  // o redirect e pode aterrissar de volta em /login.
  await expect(page).toHaveURL(/\/dashboard/);

  await page.goto("/tipos-os");
  // `filter({ hasText })` e nao `getByRole("row", { name })`: o nome
  // acessivel de um <tr> sem aria-label nao e derivado das celulas de forma
  // confiavel, e o seletor por role simplesmente nunca casava.
  const row = page.locator("tbody tr").filter({ hasText: TYPE_TOGGLE });
  await row.getByRole("button", { name: "Desativar" }).click();
  await expect(row.getByRole("button", { name: "Reativar" })).toBeVisible();

  await page.goto("/ordens/novo");
  await expect(
    page.getByLabel("Tipo *").getByRole("option", { name: TYPE_TOGGLE }),
  ).toHaveCount(0);

  // A OS que já usava o tipo continua exibindo o rótulo original.
  await page.goto(`/ordens?search=${encodeURIComponent(TOGGLE_ORDER_DESCRIPTION)}`);
  await expect(page.getByText(TYPE_TOGGLE).first()).toBeVisible();
});

test("técnico vê as próprias OS concluídas recentes", async ({ page }) => {
  await login(page, TECH_EMAIL);
  await expect(page).toHaveURL(/\/minhas-os/);

  await expect(
    page.getByRole("heading", { name: "Concluídas recentes" }),
  ).toBeVisible();
  await expect(page.getByText(COMPLETED_DESCRIPTION)).toBeVisible();

  // O card leva à OS concluída, que antes só era alcançável por URL direta.
  await page.getByText(COMPLETED_DESCRIPTION).click();
  await expect(page).toHaveURL(/\/ordens\/[a-z0-9]+$/);
  // testid, e nao o texto: "Atendimento concluido" aparece tambem na timeline.
  await expect(page.getByTestId("completed-banner")).toBeVisible();
});

test("técnico não vê concluída de outro técnico", async ({ page }) => {
  await login(page, OTHER_TECH_EMAIL);
  await expect(page).toHaveURL(/\/minhas-os/);

  await expect(
    page.getByRole("heading", { name: "Concluídas recentes" }),
  ).toBeVisible();
  await expect(page.getByText(COMPLETED_DESCRIPTION)).toHaveCount(0);
});
