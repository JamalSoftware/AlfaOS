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
