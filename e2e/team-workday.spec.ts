import { test, expect, type Page } from "@playwright/test";

/**
 * Jornada da equipe, pelo navegador.
 *
 * O que só se prova aqui: que a página monta, que o item de menu leva a ela e
 * que o DISPATCHER vê a lista sem receber a fila de correções — a assimetria de
 * papel que o PRD §231 fixou.
 *
 * Os testes de rota (`src/tests/time-clock-security.test.ts`) já provam a
 * recusa da API. Este prova o caminho que a pessoa percorre.
 */

const ADMIN_EMAIL = "admin@alfatelecom.local";
const DISPATCHER_EMAIL = "dispatcher@alfatelecom.local";
const TECH_EMAIL = "tech@alfatelecom.local";
const PASSWORD = "AlfaOS@2026";

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Senha").fill(PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
  await page.waitForURL(/\/(dashboard|minhas-os)/);
}

test.describe("jornada da equipe", () => {
  test("ADMIN abre pelo menu e vê a lista e a fila de correções", async ({
    page,
  }) => {
    await login(page, ADMIN_EMAIL);

    // Pelo MENU, não por URL direta: prova que o caminho existe para a pessoa.
    await page.getByRole("link", { name: "Jornada" }).click();
    await page.waitForURL(/\/jornada/);

    await expect(
      page.getByRole("heading", { name: "Jornada da equipe" }),
    ).toBeVisible();

    // A tabela parte dos USUÁRIOS: quem não bateu aparece como "Não iniciou",
    // que é justamente o estado que o gestor precisa ver.
    await expect(page.getByText("Não iniciou").first()).toBeVisible();

    // A fila de correções é do ADMIN.
    await expect(
      page.getByRole("heading", { name: "Correções aguardando decisão" }),
    ).toBeVisible();
  });

  test("DISPATCHER vê a lista, mas NÃO a fila de correções", async ({
    page,
  }) => {
    await login(page, DISPATCHER_EMAIL);
    await page.goto("/jornada");

    await expect(
      page.getByRole("heading", { name: "Jornada da equipe" }),
    ).toBeVisible();

    /*
      A assimetria é deliberada (§231).

      Saber quem está em jornada é insumo direto do despacho. Julgar a jornada
      de outra pessoa é da família de administrar usuário e credencial — e no
      AlfaOS isso é do ADMIN.
    */
    await expect(
      page.getByRole("heading", { name: "Correções aguardando decisão" }),
    ).toHaveCount(0);
  });

  test("TECHNICIAN não entra na jornada da equipe", async ({ page }) => {
    await login(page, TECH_EMAIL);
    await page.goto("/jornada");

    // Esconder o item de menu é UX; a página recusa por conta própria.
    await expect(
      page.getByRole("heading", { name: "Jornada da equipe" }),
    ).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Jornada" })).toHaveCount(0);
  });
});

test.describe("correção administrativa", () => {
  /*
    Um dia bem no passado, e um horário de manhã.

    O servidor recusa horário no futuro, e a suíte roda a qualquer hora: dois
    dias atrás às 08:30 é passado em qualquer fuso brasileiro, em qualquer
    execução.
  */
  const DIA = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  test("ADMIN abre a correção pela tabela e ela cai na fila", async ({
    page,
  }) => {
    await login(page, ADMIN_EMAIL);
    await page.goto("/jornada");

    // Pela TABELA, não por URL direta: prova que a ação existe para a pessoa.
    await page.getByRole("link", { name: "Ver / corrigir" }).first().click();
    await page.waitForURL(new RegExp("/jornada/"));

    // O dia é escolhido na própria tela.
    await page.getByLabel("Dia").fill(DIA);
    await page.getByRole("button", { name: "Ver dia" }).click();
    await page.waitForURL(new RegExp(`date=${DIA}`));

    await page.getByTestId("open-member-adjustment").click();
    await expect(page.getByTestId("member-adjustment-form")).toBeVisible();

    await page.getByLabel("Horário correto").fill("08:30");
    await page
      .getByLabel("Motivo")
      .fill("Celular sem bateria; ele trabalhou o dia inteiro.");
    await page.getByTestId("submit-member-adjustment").click();

    /*
      O que aparece é um PEDIDO, não uma marcação.

      O gestor não edita `TimeEntry` em lugar nenhum: a tela cria o mesmo
      `TimeAdjustmentRequest` que o aplicativo cria, e ele espera decisão.
    */
    await expect(page.getByTestId("member-adjustment-list")).toBeVisible();
    await expect(page.getByText("Aguardando decisão")).toBeVisible();

    // E cai na MESMA fila do painel — não existe uma segunda fila.
    await page.goto("/jornada");
    await expect(
      page.getByText("Celular sem bateria; ele trabalhou o dia inteiro."),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Aprovar" })).toBeVisible();
  });

  test("o formulário recusa envio sem motivo, e a recusa fica na tela", async ({
    page,
  }) => {
    await login(page, ADMIN_EMAIL);
    await page.goto("/jornada");
    await page.getByRole("link", { name: "Ver / corrigir" }).first().click();
    await page.waitForURL(new RegExp("/jornada/"));

    await page.getByTestId("open-member-adjustment").click();
    await page.getByLabel("Horário correto").fill("08:30");
    await page.getByTestId("submit-member-adjustment").click();

    // O formulário continua aberto, dizendo o que falta.
    await expect(page.getByTestId("member-adjustment-error")).toBeVisible();
    await expect(page.getByTestId("member-adjustment-form")).toBeVisible();
  });

  test("DISPATCHER não recebe a ação de corrigir", async ({ page }) => {
    await login(page, DISPATCHER_EMAIL);
    await page.goto("/jornada");

    await expect(
      page.getByRole("heading", { name: "Jornada da equipe" }),
    ).toBeVisible();
    // Corrigir a jornada de outra pessoa é da família de decidi-la (§231).
    await expect(page.getByRole("link", { name: "Ver / corrigir" })).toHaveCount(
      0,
    );
  });

  test("DISPATCHER não abre o espelho de um funcionário por URL", async ({
    page,
  }) => {
    await login(page, ADMIN_EMAIL);
    await page.goto("/jornada");
    await page.getByRole("link", { name: "Ver / corrigir" }).first().click();
    await page.waitForURL(new RegExp("/jornada/"));
    const url = page.url();

    await page.context().clearCookies();
    await login(page, DISPATCHER_EMAIL);
    await page.goto(url);

    // Esconder o link é UX; a página recusa por conta própria.
    await expect(page.getByTestId("open-member-adjustment")).toHaveCount(0);
  });
});
