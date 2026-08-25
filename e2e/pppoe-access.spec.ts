import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { allocateServiceOrderNumber } from "../src/lib/service-order-number";
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

/** Dois telefones distintos: o teste prova que os DOIS chegam à tela. */
const CUSTOMER_PHONE = "11987654321";
const CUSTOMER_SECONDARY_PHONE = "1133224455";

/**
 * Cliente do estado VAZIO: sem telefone alternativo, sem senha PPPoE.
 * Existe para provar o que a tela faz na ausência do dado — o caso que
 * uma fixture completa nunca exercita.
 */
const SPARSE_CUSTOMER_NAME = "Cliente PPPoE E2E Sem Contato";
const SPARSE_ORDER_DESCRIPTION = "OS do E2E de acesso PPPoE sem contato.";
let sparseCustomerId = "";
let sparseOrderUrl = "";

const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgresql://alfaos:alfaos_dev_password@localhost:5432/alfaos_test?schema=public";

const prisma = new PrismaClient({
  datasources: { db: { url: E2E_DATABASE_URL } },
});

let customerId = "";
let orderUrl = "";
/** Número OPERACIONAL alocado à OS desta fixture. */
let orderNumber = 0;
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
    data: {
      companyId: techUser.companyId,
      name: CUSTOMER_NAME,
      phone: CUSTOMER_PHONE,
      secondaryPhone: CUSTOMER_SECONDARY_PHONE,
    },
  });
  customerId = customer.id;
  customerEditUrl = `/clientes/${customer.id}/editar`;

  const order = await prisma.serviceOrder.create({
    data: {
      companyId: techUser.companyId,
      number: await allocateServiceOrderNumber(prisma, techUser.companyId),
      customerId: customer.id,
      technicianId: technician.id,
      type: "Manutenção",
      description: ORDER_DESCRIPTION,
      status: "ASSIGNED",
      assignedAt: new Date(),
    },
  });
  orderUrl = `/ordens/${order.id}`;
  orderNumber = order.number;

  // Só o telefone principal; o alternativo fica ausente de propósito.
  const sparseCustomer = await prisma.customer.create({
    data: {
      companyId: techUser.companyId,
      name: SPARSE_CUSTOMER_NAME,
      phone: CUSTOMER_PHONE,
    },
  });
  sparseCustomerId = sparseCustomer.id;

  /**
   * Conexão COM usuário e SEM senha. É um estado legítimo do cadastro —
   * o login veio do ERP, a senha ainda não — e a tela precisa dizer isso
   * em vez de mascarar um valor que não existe.
   */
  await prisma.customerConnection.create({
    data: {
      companyId: techUser.companyId,
      customerId: sparseCustomer.id,
      username: "pppoe-sem-senha@provedor",
    },
  });

  const sparseOrder = await prisma.serviceOrder.create({
    data: {
      companyId: techUser.companyId,
      number: await allocateServiceOrderNumber(prisma, techUser.companyId),
      customerId: sparseCustomer.id,
      technicianId: technician.id,
      type: "Manutenção",
      description: SPARSE_ORDER_DESCRIPTION,
      status: "ASSIGNED",
      assignedAt: new Date(),
    },
  });
  sparseOrderUrl = `/ordens/${sparseOrder.id}`;
});

test.afterAll(async () => {
  const orders = await prisma.serviceOrder.findMany({
    where: {
      description: { in: [ORDER_DESCRIPTION, SPARSE_ORDER_DESCRIPTION] },
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
  await prisma.customerConnection.deleteMany({
    where: { customerId: { in: [customerId, sparseCustomerId] } },
  });
  await prisma.customer.deleteMany({
    where: { name: { in: [CUSTOMER_NAME, SPARSE_CUSTOMER_NAME] } },
  });
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

test("ADMIN vê a seção Acesso do cliente com usuário e estado da senha", async ({
  page,
}) => {
  await login(page, ADMIN_EMAIL);
  await expect(page).toHaveURL(/\/dashboard/);

  await page.goto(orderUrl);

  // Cabeçalho operacional, não o cuid.
  await expect(page.getByTestId("order-number")).toHaveText(
    new RegExp(`OS Nº ${orderNumber}\\b`),
  );

  const panel = page.getByTestId("pppoe-panel");
  await expect(panel).toHaveAttribute("data-variant", "admin");
  await expect(page.getByRole("heading", { name: "Acesso do cliente" })).toBeVisible();
  await expect(page.getByTestId("pppoe-username")).toHaveText(
    CONNECTION_USERNAME,
  );
  /**
   * Mascara, nao o texto claro. E o comprimento e FIXO: derivá-lo da senha
   * real vazaria quantos caracteres ela tem — informacao que estreita forca
   * bruta sem ninguem revelar nada.
   */
  await expect(page.getByTestId("pppoe-password")).toHaveText("••••");
  await expect(page.getByTestId("pppoe-password")).not.toHaveText(
    CONNECTION_PASSWORD,
  );

  // Nada de texto claro no HTML servido, exatamente como na tela do técnico.
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
  await expect(page.getByTestId("pppoe-password")).toHaveText("••••");

  await page.getByTestId("pppoe-reveal").click();
  await expect(page.getByTestId("pppoe-password")).toHaveText(
    CONNECTION_PASSWORD,
  );

  // Ocultar tira do DOM de novo.
  await page.getByRole("button", { name: "Ocultar" }).click();
  await expect(page.getByTestId("pppoe-password")).toHaveText("••••");
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

/**
 * Regressão de UI-1 (auditoria final da v0.5.1).
 *
 * O servidor já recusava o técnico inelegível com 403 desde `9d744ac`, mas o
 * predicado da tela ignorava `executionIssue` e seguia oferecendo o botão. A
 * ação era oferecida e sempre falhava.
 *
 * Este teste fixa as duas metades: o painel continua visível (o técnico ainda
 * enxerga a OS e o usuário PPPoE, decisão de design), a ação some, e nenhuma
 * requisição de revelação chega a sair por esse controle.
 */
for (const status of ["ASSIGNED", "IN_PROGRESS"] as const) {
  test(`técnico DESATIVADO não recebe ação de revelar com a OS em ${status}`, async ({
    page,
  }) => {
    await prisma.serviceOrder.updateMany({
      where: { description: ORDER_DESCRIPTION },
      data: { status },
    });
    await prisma.technician.updateMany({
      where: { user: { email: TECH_EMAIL } },
      data: { active: false },
    });

    // Qualquer chamada ao endpoint de revelação, saia de onde sair.
    const revealCalls: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes("/connection-password")) {
        revealCalls.push(`${req.method()} ${req.url()}`);
      }
    });

    try {
      await login(page, TECH_EMAIL);
      await expect(page).toHaveURL(/\/minhas-os/);
      await page.goto(orderUrl);

      // O painel PERMANECE visível — o design não esconde a OS do técnico.
      await expect(page.getByTestId("pppoe-panel")).toBeVisible();
      await expect(page.getByTestId("pppoe-username")).toHaveText(
        CONNECTION_USERNAME,
      );

      // As duas ações somem: "Mostrar senha" e "Copiar senha".
      await expect(page.getByTestId("pppoe-reveal")).toHaveCount(0);
      await expect(page.getByTestId("pppoe-copy-password")).toHaveCount(0);

      /**
       * O motivo é o da ELEGIBILIDADE, não o do status — e a asserção é
       * ESCOPADA ao painel: a mesma frase já aparece no alerta de execução da
       * página, e um seletor solto casaria os dois.
       */
      await expect(
        page
          .getByTestId("pppoe-panel")
          .getByText("Seu perfil técnico está inativo."),
      ).toBeVisible();

      // Nem o HTML servido nem nenhuma requisição carregaram a senha.
      expect(await page.content()).not.toContain(CONNECTION_PASSWORD);
      expect(revealCalls).toEqual([]);

      // Controle positivo: reativado, a ação volta — a asserção acima não
      // estava passando por vazio.
      await prisma.technician.updateMany({
        where: { user: { email: TECH_EMAIL } },
        data: { active: true },
      });
      await page.reload();
      await expect(page.getByTestId("pppoe-reveal")).toBeVisible();
    } finally {
      await prisma.technician.updateMany({
        where: { user: { email: TECH_EMAIL } },
        data: { active: true },
      });
      await prisma.serviceOrder.updateMany({
        where: { description: ORDER_DESCRIPTION },
        data: { status: "ASSIGNED" },
      });
    }
  });
}

/**
 * A mascara nao pode contar o tamanho da senha.
 *
 * `CONNECTION_PASSWORD` tem comprimento proprio; a mascara tem quatro
 * caracteres sempre. Se um dia alguem a derivar do valor real, este teste
 * quebra.
 */
test("a mascara tem comprimento fixo, independente da senha real", async ({
  page,
}) => {
  await login(page, TECH_EMAIL);
  await expect(page).toHaveURL(/\/minhas-os/);
  await page.goto(orderUrl);

  const mascara = page.getByTestId("pppoe-password");
  await expect(mascara).toHaveText("••••");

  const texto = (await mascara.textContent()) ?? "";
  expect(texto.length).toBe(4);
  expect(texto.length).not.toBe(CONNECTION_PASSWORD.length);
  expect(await page.content()).not.toContain(CONNECTION_PASSWORD);
});

/**
 * Revelar e ocultar: o texto claro entra so depois da acao explicita e sai
 * do estado do client quando deixa de ser necessario.
 */
test("ocultar a senha devolve a mascara", async ({ page }) => {
  await login(page, TECH_EMAIL);
  await expect(page).toHaveURL(/\/minhas-os/);
  await page.goto(orderUrl);

  await expect(page.getByTestId("pppoe-password")).toHaveText("••••");

  await page.getByTestId("pppoe-reveal").click();
  await expect(page.getByTestId("pppoe-password")).toHaveText(
    CONNECTION_PASSWORD,
  );

  await page.getByTestId("pppoe-hide").click();
  await expect(page.getByTestId("pppoe-password")).toHaveText("••••");
});

/**
 * O toast de copia nao pode carregar a senha. Ele aparece na tela e pode
 * ficar visivel por cima do ombro de qualquer um.
 */
test("copiar a senha nao expoe o valor no rotulo", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await login(page, TECH_EMAIL);
  await expect(page).toHaveURL(/\/minhas-os/);
  await page.goto(orderUrl);

  await page.getByTestId("pppoe-copy-password").click();
  await expect(page.getByTestId("pppoe-copy-password")).toHaveText("Copiada");

  // O rotulo confirma a acao sem repetir o segredo.
  const rotulo = (await page.getByTestId("pppoe-copy-password").textContent()) ?? "";
  expect(rotulo).not.toContain(CONNECTION_PASSWORD);
});

/**
 * Os dois telefones, em campos separados.
 *
 * Quem está em campo liga para o número que atende. Concatenar os dois num
 * campo só produz um texto que ninguém consegue tocar para discar, e perde
 * qual é qual.
 */
test("o técnico vê os DOIS telefones do cliente, cada um discável", async ({
  page,
}) => {
  await login(page, TECH_EMAIL);
  await expect(page).toHaveURL(/\/minhas-os/);
  await page.goto(orderUrl);

  const principal = page.getByTestId("customer-phone");
  const alternativo = page.getByTestId("customer-secondary-phone");

  await expect(principal).toBeVisible();
  await expect(alternativo).toBeVisible();

  // Campos independentes: cada um discando o SEU número.
  await expect(principal).toHaveAttribute("href", `tel:${CUSTOMER_PHONE}`);
  await expect(alternativo).toHaveAttribute(
    "href",
    `tel:${CUSTOMER_SECONDARY_PHONE}`,
  );

  // E nenhum deles carrega o outro dentro de si.
  const textoPrincipal = (await principal.textContent()) ?? "";
  expect(textoPrincipal).not.toContain(CUSTOMER_SECONDARY_PHONE.slice(-4));
});

/**
 * Mesma OS, olhos do ADMIN: os dois telefones continuam lá.
 */
test("o ADMIN também vê os dois telefones", async ({ page }) => {
  await login(page, ADMIN_EMAIL);
  await expect(page).toHaveURL(/\/dashboard/);
  await page.goto(orderUrl);

  await expect(page.getByTestId("customer-phone")).toBeVisible();
  await expect(page.getByTestId("customer-secondary-phone")).toBeVisible();
});

/**
 * Ausência de dado: a tela não pode inventar linha nem mentir estado.
 *
 * Sem telefone alternativo, o rótulo inteiro some — uma linha permanentemente
 * vazia dizendo "Não informado" treina o olho a ignorar a região inteira,
 * inclusive quando ela tiver conteúdo. Já o telefone principal é campo fixo:
 * ausente, ele DECLARA a ausência.
 */
test("sem telefone alternativo a linha não é renderizada; sem nenhum, declara a ausência", async ({
  page,
}) => {
  await login(page, TECH_EMAIL);
  await expect(page).toHaveURL(/\/minhas-os/);
  await page.goto(sparseOrderUrl);

  await expect(page.getByTestId("customer-phone")).toBeVisible();
  await expect(page.getByTestId("customer-secondary-phone")).toHaveCount(0);
  await expect(page.getByText("Telefone alternativo")).toHaveCount(0);

  // Agora sem telefone NENHUM.
  await prisma.customer.update({
    where: { id: sparseCustomerId },
    data: { phone: null },
  });
  await page.reload();

  await expect(page.getByTestId("customer-phone")).toHaveCount(0);
  await expect(page.getByText("Não informado").first()).toBeVisible();
});

/**
 * Senha ausente ≠ senha escondida.
 *
 * A máscara diz “existe um valor aqui”. Mostrá-la num cadastro sem senha
 * mandaria o técnico tentar revelar algo que não existe, e ele descobriria
 * isso na porta do cliente.
 */
test("conexão sem senha declara a ausência em vez de mascarar", async ({
  page,
}) => {
  await login(page, TECH_EMAIL);
  await expect(page).toHaveURL(/\/minhas-os/);
  await page.goto(sparseOrderUrl);

  await expect(page.getByTestId("pppoe-panel")).toBeVisible();
  await expect(
    page.getByText("Não configurada para este cliente."),
  ).toBeVisible();

  await expect(page.getByTestId("pppoe-password")).toHaveCount(0);
  await expect(page.getByTestId("pppoe-reveal")).toHaveCount(0);
});
