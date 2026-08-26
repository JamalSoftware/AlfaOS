import { test, expect, type Page } from "@playwright/test";

/**
 * Sistema de temas — claro, escuro e sistema.
 *
 * A maior parte destes testes usa `/login`, que não exige sessão: o tema é
 * aplicado pelo script do `<head>`, muito antes de qualquer autorização, e
 * uma tela pública exercita exatamente o mesmo caminho por uma fração do
 * tempo. A jornada autenticada existe para o seletor, que mora na Sidebar.
 */

const ADMIN_EMAIL = "admin@alfatelecom.local";
const PASSWORD = "AlfaOS@2026";

/** Lê o tema efetivamente aplicado ao `<html>`. */
async function temaAplicado(page: Page): Promise<string | null> {
  return page.evaluate(() => document.documentElement.dataset.theme ?? null);
}

/**
 * Grava a preferência antes de a página carregar, como se já existisse.
 *
 * Só grava quando ainda não há nada. `addInitScript` roda a CADA
 * carregamento, inclusive depois de um reload — gravando
 * incondicionalmente, ele apagaria a escolha que o teste acabou de fazer
 * pelo seletor, e o teste passaria a medir a si mesmo em vez do produto.
 */
async function preferenciaGravada(page: Page, valor: string) {
  await page.addInitScript((v) => {
    if (window.localStorage.getItem("alfaos-theme") === null) {
      window.localStorage.setItem("alfaos-theme", v as string);
    }
  }, valor);
}

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("E-mail").fill(ADMIN_EMAIL);
  await page.getByLabel("Senha").fill(PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

test.describe("preferência SYSTEM — o padrão", () => {
  test("sem preferência gravada, acompanha o aparelho", async ({ browser }) => {
    const claro = await browser.newContext({ colorScheme: "light" });
    const p1 = await claro.newPage();
    await p1.goto("/login");
    expect(await temaAplicado(p1)).toBe("light");
    await claro.close();

    const escuro = await browser.newContext({ colorScheme: "dark" });
    const p2 = await escuro.newPage();
    await p2.goto("/login");
    expect(await temaAplicado(p2)).toBe("dark");
    await escuro.close();
  });

  /**
   * O atributo precisa estar no `<html>` ANTES do primeiro paint. Se ele só
   * aparecesse depois da hidratação, quem usa tema escuro veria a página
   * clara por alguns quadros — o flash branco que o tema escuro existe para
   * evitar.
   *
   * `domcontentloaded` é anterior à hidratação do React; o script inline do
   * `<head>` já rodou.
   */
  test("o tema é aplicado antes do primeiro paint, não depois da hidratação", async ({
    browser,
  }) => {
    const contexto = await browser.newContext({ colorScheme: "dark" });
    const page = await contexto.newPage();
    await page.goto("/login", { waitUntil: "domcontentloaded" });
    expect(await temaAplicado(page)).toBe("dark");

    // E o `color-scheme` acompanha, senão a barra de rolagem e os campos
    // nativos do navegador continuam claros.
    expect(
      await page.evaluate(() => document.documentElement.style.colorScheme),
    ).toBe("dark");
    await contexto.close();
  });
});

test.describe("escolha explícita vence o sistema", () => {
  test("CLARO explícito num aparelho em modo escuro", async ({ browser }) => {
    const contexto = await browser.newContext({ colorScheme: "dark" });
    const page = await contexto.newPage();
    await preferenciaGravada(page, "light");
    await page.goto("/login");
    expect(await temaAplicado(page)).toBe("light");
    await contexto.close();
  });

  test("ESCURO explícito num aparelho em modo claro", async ({ browser }) => {
    const contexto = await browser.newContext({ colorScheme: "light" });
    const page = await contexto.newPage();
    await preferenciaGravada(page, "dark");
    await page.goto("/login");
    expect(await temaAplicado(page)).toBe("dark");
    await contexto.close();
  });

  /**
   * O valor vem do `localStorage`, que o usuário edita à mão. Ele termina num
   * atributo do `<html>`: sem allowlist, entraria string arbitrária no DOM.
   */
  test("valor hostil no storage cai no padrão em vez de ir para o DOM", async ({
    browser,
  }) => {
    const contexto = await browser.newContext({ colorScheme: "light" });
    const page = await contexto.newPage();
    await preferenciaGravada(page, 'dark"><style>*{display:none}</style>');
    await page.goto("/login");

    expect(await temaAplicado(page)).toBe("light");
    // A página continua visível — nada do valor injetado teve efeito.
    await expect(page.getByRole("button", { name: "Entrar" })).toBeVisible();
    expect(await page.content()).not.toContain("display:none}</style>");
    await contexto.close();
  });
});

test.describe("jornada com o seletor", () => {
  test("trocar para ESCURO aplica sem recarregar, persiste e sobrevive à navegação", async ({
    browser,
  }) => {
    const contexto = await browser.newContext({ colorScheme: "light" });
    const page = await contexto.newPage();
    await login(page);

    expect(await temaAplicado(page)).toBe("light");

    const seletor = page.getByTestId("theme-select");
    await expect(seletor).toBeVisible();

    // Sem reload: a troca acontece na mesma árvore do React.
    await seletor.selectOption("dark");
    await expect
      .poll(() => temaAplicado(page))
      .toBe("dark");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    // Sobrevive a recarregar.
    await page.reload();
    expect(await temaAplicado(page)).toBe("dark");
    await expect(seletor).toHaveValue("dark");

    // E a mudar de tela.
    await page.goto("/ordens");
    expect(await temaAplicado(page)).toBe("dark");
    await page.goto("/clientes");
    expect(await temaAplicado(page)).toBe("dark");

    await contexto.close();
  });

  test("voltar para SISTEMA devolve o controle ao aparelho", async ({
    browser,
  }) => {
    const contexto = await browser.newContext({ colorScheme: "dark" });
    const page = await contexto.newPage();
    await preferenciaGravada(page, "light");
    await login(page);

    expect(await temaAplicado(page)).toBe("light");

    await page.getByTestId("theme-select").selectOption("system");
    await expect
      .poll(() => temaAplicado(page))
      .toBe("dark");

    await page.reload();
    expect(await temaAplicado(page)).toBe("dark");
    await expect(page.getByTestId("theme-select")).toHaveValue("system");

    await contexto.close();
  });

  test("o seletor tem rótulo associado", async ({ page }) => {
    await login(page);
    // `getByLabel` só encontra se o `<label for>` estiver ligado ao controle.
    await expect(page.getByLabel("Tema")).toHaveValue("system");
  });
});

test.describe("as duas jornadas, pintadas de verdade", () => {
  /**
   * O tema muda variáveis CSS, então o teste confere a cor COMPUTADA. Assertar
   * nomes de classe provaria só que a classe está lá, não que ela pinta algo
   * diferente nos dois temas.
   */
  const fundoDoCorpo = (page: Page) =>
    page.evaluate(() => getComputedStyle(document.body).backgroundColor);

  const corDoTexto = (page: Page) =>
    page.evaluate(() => getComputedStyle(document.body).color);

  test("claro: fundo claro, texto escuro", async ({ browser }) => {
    const contexto = await browser.newContext({ colorScheme: "light" });
    const page = await contexto.newPage();
    await preferenciaGravada(page, "light");
    await login(page);

    expect(await fundoDoCorpo(page)).toBe("rgb(248, 250, 252)");
    expect(await corDoTexto(page)).toBe("rgb(15, 23, 42)");
    await contexto.close();
  });

  test("escuro: fundo escuro, texto claro, e os badges acompanham", async ({
    browser,
  }) => {
    const contexto = await browser.newContext({ colorScheme: "light" });
    const page = await contexto.newPage();
    await preferenciaGravada(page, "dark");
    await login(page);

    expect(await fundoDoCorpo(page)).toBe("rgb(15, 23, 42)");
    expect(await corDoTexto(page)).toBe("rgb(241, 245, 249)");

    await page.goto("/ordens");
    const badge = page.getByTestId("status-badge").first();
    if ((await badge.count()) > 0) {
      // A pílula não pode ficar com o fundo claro do tema anterior.
      const fundo = await badge.evaluate(
        (el) => getComputedStyle(el).backgroundColor,
      );
      expect(fundo).not.toBe("rgb(255, 255, 255)");
      // E carrega o rótulo por extenso: cor nunca é o único sinal.
      expect((await badge.textContent())?.trim().length ?? 0).toBeGreaterThan(2);
    }
    await contexto.close();
  });
});
