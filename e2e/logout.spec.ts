import { test, expect, type Page } from "@playwright/test";

/**
 * Sair do AlfaOS, pelo botão de verdade.
 *
 * O defeito relatado: clicar em "Sair" levava a `/api/auth/logout` mostrando
 * `{"ok":false,"error":"Origem não permitida."}` — JSON cru na cara do
 * operador. A causa era a comparação Same-Origin contra o host que o Next
 * resolveu ao subir, e não contra o host que o navegador endereçou.
 *
 * Estes testes clicam no botão. Chamar a rota direto provaria que a rota
 * responde, e não que o caminho que o usuário percorre funciona.
 */

const ADMIN_EMAIL = "admin@alfatelecom.local";
const TECH_EMAIL = "tech@alfatelecom.local";
const PASSWORD = "AlfaOS@2026";

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Senha").fill(PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
  await page.waitForURL(/\/(dashboard|minhas-os)/);
}

test.describe("sair pelo botão", () => {
  test("termina na tela de login, não em JSON", async ({ page }) => {
    await login(page, ADMIN_EMAIL);

    await page.getByRole("button", { name: "Sair" }).click();
    await page.waitForURL(/\/login/);

    // A prova do defeito original: nada de corpo de API na tela.
    const html = await page.content();
    expect(html).not.toContain("Origem não permitida");
    expect(html).not.toContain('"ok":false');
    expect(page.url()).not.toContain("/api/auth/logout");

    // E é a tela de login de verdade, com o formulário pronto para uso.
    await expect(page.getByRole("button", { name: "Entrar" })).toBeVisible();
    await expect(page.getByLabel("E-mail")).toBeVisible();
  });

  test("a sessão cai: a área autenticada deixa de abrir", async ({ page }) => {
    await login(page, ADMIN_EMAIL);
    await page.getByRole("button", { name: "Sair" }).click();
    await page.waitForURL(/\/login/);

    // Voltar pela URL não reabre — e não é o cache do navegador respondendo.
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login/);

    await page.goto("/usuarios");
    await expect(page).toHaveURL(/\/login/);
  });

  test("o cookie de sessão é removido do navegador", async ({ page, context }) => {
    await login(page, ADMIN_EMAIL);
    expect(
      (await context.cookies()).some(
        (c) => c.name === "alfaos_session" && c.value.length > 0,
      ),
    ).toBe(true);

    await page.getByRole("button", { name: "Sair" }).click();
    await page.waitForURL(/\/login/);

    expect(
      (await context.cookies()).some(
        (c) => c.name === "alfaos_session" && c.value.length > 0,
      ),
    ).toBe(false);
  });

  /** O técnico sai pela gaveta do celular, que é outro caminho de render. */
  test("o técnico sai pela gaveta no celular", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await login(page, TECH_EMAIL);
    await expect(page).toHaveURL(/\/minhas-os/);

    await page.getByRole("button", { name: "Abrir menu" }).click();
    await page.getByRole("button", { name: "Sair" }).click();
    await page.waitForURL(/\/login/);

    expect(await page.content()).not.toContain("Origem não permitida");
    await expect(page.getByRole("button", { name: "Entrar" })).toBeVisible();
  });

  /**
   * O redirect precisa ser RELATIVO.
   *
   * Absoluto, ele carregava o host do boot: quem abrisse o AlfaOS pelo IP da
   * rede seria mandado ao `localhost` do próprio aparelho ao sair — no celular,
   * uma página que não existe.
   */
  test("o redirect não sai do host que o usuário está usando", async ({
    page,
  }) => {
    await login(page, ADMIN_EMAIL);
    const origem = new URL(page.url()).origin;

    const [resposta] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/api/auth/logout") && r.status() === 303,
      ),
      page.getByRole("button", { name: "Sair" }).click(),
    ]);

    expect(resposta.headers()["location"]).toBe("/login");
    await page.waitForURL(/\/login/);
    expect(new URL(page.url()).origin).toBe(origem);
  });
});

test.describe("logout continua protegido", () => {
  /**
   * Controle positivo do controle negativo: a proteção não foi removida, só
   * passou a comparar contra o host certo.
   */
  test("uma origem de terceiro não derruba a sessão", async ({
    page,
    context,
  }) => {
    await login(page, ADMIN_EMAIL);

    const resposta = await page.request.post("/api/auth/logout", {
      headers: { Origin: "http://evil.example" },
      maxRedirects: 0,
      failOnStatusCode: false,
    });
    expect(resposta.status()).toBe(403);

    // A sessão sobreviveu ao ataque.
    expect(
      (await context.cookies()).some(
        (c) => c.name === "alfaos_session" && c.value.length > 0,
      ),
    ).toBe(true);
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/dashboard/);
  });

  /** GET não desloga: a rota só exporta POST. */
  test("GET em /api/auth/logout não encerra a sessão", async ({
    page,
    context,
  }) => {
    await login(page, ADMIN_EMAIL);

    const resposta = await page.request.get("/api/auth/logout", {
      maxRedirects: 0,
      failOnStatusCode: false,
    });
    expect(resposta.status()).toBeGreaterThanOrEqual(400);

    expect(
      (await context.cookies()).some(
        (c) => c.name === "alfaos_session" && c.value.length > 0,
      ),
    ).toBe(true);
  });
});
