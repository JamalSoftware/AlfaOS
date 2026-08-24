import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { assertTestDatabase } from "./test-db-guard";

/**
 * Coerência do estado da busca de cliente no ERP.
 *
 * O defeito que estas regressões fixam: o resultado de uma busca sobrevivia à
 * busca seguinte. Uma consulta que devolveu `[]` seguida de outra que falha
 * pintava, ao mesmo tempo, "Nenhum cliente encontrado" e "Erro de conexão" —
 * duas afirmações incompatíveis sobre a mesma tentativa. Pior: resultados de
 * uma busca anterior continuavam listados sob o termo novo, e o operador podia
 * importar um cliente que não corresponde ao que ele acabou de procurar.
 *
 * A falha de rede é simulada abortando a requisição no browser (`route.abort`),
 * que é exatamente o caminho do `catch` do componente. Nenhuma chamada sai para
 * o ReceitaNet real.
 */

const ADMIN_EMAIL = "admin@alfatelecom.local";
const PASSWORD = "AlfaOS@2026";

const SEARCH_ENDPOINT = "**/api/integrations/customers/search";

const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgresql://alfaos:alfaos_dev_password@localhost:5432/alfaos_test?schema=public";

const prisma = new PrismaClient({
  datasources: { db: { url: E2E_DATABASE_URL } },
});

/**
 * O bloco de busca no ERP só é renderizado para uma integração RECEITANET
 * habilitada — o MockERP não implementa busca de cliente e o formulário
 * deliberadamente não oferece um botão que sempre falharia.
 */
test.beforeAll(async () => {
  await assertTestDatabase(E2E_DATABASE_URL, "E2E_DATABASE_URL");

  const admin = await prisma.user.findUniqueOrThrow({
    where: { email: ADMIN_EMAIL },
  });

  await prisma.eRPIntegration.updateMany({
    where: { companyId: admin.companyId },
    data: { provider: "RECEITANET", name: "ReceitaNet", enabled: true },
  });
});

/** Devolve a integração ao estado do seed, que as outras specs esperam. */
test.afterAll(async () => {
  const admin = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL } });

  if (admin) {
    await prisma.eRPIntegration.updateMany({
      where: { companyId: admin.companyId },
      data: { provider: "MOCK", name: "Mock ERP", enabled: true },
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

async function search(page: Page, term: string) {
  await page.getByLabel("Termo").fill(term);
  await page.getByTestId("erp-search").click();
}

const EMPTY_STATE = "Nenhum cliente encontrado.";
const NETWORK_ERROR = "Erro de conexão. Tente novamente.";

test("busca vazia seguida de falha de rede mostra o erro, não o estado vazio", async ({
  page,
}) => {
  await login(page, ADMIN_EMAIL);

  let calls = 0;
  await page.route(SEARCH_ENDPOINT, async (route) => {
    calls += 1;

    if (calls === 1) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: { hits: [] } }),
      });
      return;
    }

    await route.abort("failed");
  });

  await page.goto("/ordens/novo");

  // Controle positivo: a primeira busca chega mesmo ao estado vazio.
  await search(page, "Fulano");
  await expect(page.getByText(EMPTY_STATE)).toBeVisible();

  await search(page, "Sicrano");

  await expect(page.getByText(NETWORK_ERROR)).toBeVisible();
  // O ponto da regressão: as duas mensagens não podem coexistir.
  await expect(page.getByText(EMPTY_STATE)).toBeHidden();
});

test("resultados da busca anterior não sobrevivem a uma busca que falha", async ({
  page,
}) => {
  await login(page, ADMIN_EMAIL);

  let calls = 0;
  await page.route(SEARCH_ENDPOINT, async (route) => {
    calls += 1;

    if (calls === 1) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            hits: [
              {
                externalId: "15678",
                name: "Cliente Da Busca Anterior",
                document: "44911891882",
                city: "Presidente Prudente",
                state: "SP",
                localCustomerId: null,
              },
            ],
          },
        }),
      });
      return;
    }

    await route.abort("failed");
  });

  await page.goto("/ordens/novo");

  // Controle positivo: a primeira busca realmente lista o cliente.
  await search(page, "Cliente");
  await expect(page.getByText("Cliente Da Busca Anterior")).toBeVisible();

  await search(page, "Outro Nome Qualquer");

  await expect(page.getByText(NETWORK_ERROR)).toBeVisible();
  /**
   * Sem o reset, este nome continuaria na tela sob o termo novo — e importar a
   * partir dele criaria uma OS para o cliente errado.
   */
  await expect(page.getByText("Cliente Da Busca Anterior")).toBeHidden();
});

test("termo em branco limpa o resultado anterior em vez de contradizê-lo", async ({
  page,
}) => {
  await login(page, ADMIN_EMAIL);

  await page.route(SEARCH_ENDPOINT, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { hits: [] } }),
    });
  });

  await page.goto("/ordens/novo");

  await search(page, "Fulano");
  await expect(page.getByText(EMPTY_STATE)).toBeVisible();

  // A validação local também é uma tentativa que falhou: o resultado da busca
  // anterior não descreve mais nada.
  await search(page, "   ");

  await expect(page.getByText("Informe um termo de busca.")).toBeVisible();
  await expect(page.getByText(EMPTY_STATE)).toBeHidden();
});
