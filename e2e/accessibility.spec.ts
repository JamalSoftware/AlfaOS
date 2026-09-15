import { test, expect, type Page } from "@playwright/test";

/**
 * # RC-1D — acessibilidade das telas operacionais
 *
 * Três regras que valem para toda tela do AlfaOS, e que só o navegador prova:
 *
 * 1. **todo controle tem nome** — um botão sem nome acessível é um botão que o
 *    leitor de tela anuncia como "botão", e nada mais;
 * 2. **estado nunca é só cor** — selo de estado precisa de texto; a mesma regra
 *    que o marcador do mapa e o selo de conectividade já seguem;
 * 3. **o que se opera com o mouse se opera com o teclado**, com foco visível.
 *
 * O AlfaOS é usado em navegador no celular pelo técnico e no desktop pelo
 * escritório — e a tela do técnico é a que mais depende de leitor de tela em
 * campo.
 */

const SENHA = "AlfaOS@2026";
const ADMIN = "admin@alfatelecom.local";

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Senha").fill(SENHA);
  await page.getByRole("button", { name: "Entrar" }).click();
  await page.waitForURL((u) => !u.pathname.includes("/login"));
}

/**
 * Os controles SEM nome acessível de uma página.
 *
 * O nome é calculado como o leitor de tela o calcula, na ordem que importa
 * aqui: `aria-label`, `aria-labelledby`, texto visível, `title`, e o `alt` de
 * uma imagem dentro do controle. Um controle escondido não conta — ele não
 * chega ao leitor.
 */
async function controlesSemNome(page: Page) {
  return page.evaluate(() => {
    const visivel = (el: Element) => {
      const r = el.getBoundingClientRect();
      const estilo = getComputedStyle(el);
      return (
        r.width > 0 &&
        r.height > 0 &&
        estilo.visibility !== "hidden" &&
        estilo.display !== "none"
      );
    };
    const nomeDe = (el: Element): string => {
      const rotulo = el.getAttribute("aria-label");
      if (rotulo?.trim()) return rotulo.trim();
      const referencia = el.getAttribute("aria-labelledby");
      if (referencia) {
        const alvo = document.getElementById(referencia);
        if (alvo?.textContent?.trim()) return alvo.textContent.trim();
      }
      if (el.textContent?.trim()) return el.textContent.trim();
      const titulo = el.getAttribute("title");
      if (titulo?.trim()) return titulo.trim();
      const img = el.querySelector("img[alt]");
      const alt = img?.getAttribute("alt");
      if (alt?.trim()) return alt.trim();
      return "";
    };
    return Array.from(
      document.querySelectorAll(
        'button, a[href], [role="button"], input[type="checkbox"], input[type="radio"], select',
      ),
    )
      .filter((el) => visivel(el) && !nomeDe(el))
      .map((el) => {
        const html = el.outerHTML.slice(0, 120);
        return `${el.tagName.toLowerCase()} ${el.getAttribute("data-testid") ?? ""} ${html}`;
      });
  });
}

/** Campos de formulário sem rótulo associado. */
async function camposSemRotulo(page: Page) {
  return page.evaluate(() =>
    Array.from(
      document.querySelectorAll("input:not([type=hidden]), textarea, select"),
    )
      .filter((el) => {
        const campo = el as HTMLInputElement;
        if (campo.getAttribute("aria-label")?.trim()) return false;
        if (campo.getAttribute("aria-labelledby")?.trim()) return false;
        if (campo.id && document.querySelector(`label[for="${campo.id}"]`)) return false;
        if (campo.closest("label")) return false;
        return campo.getBoundingClientRect().height > 0;
      })
      .map((el) => `${el.tagName.toLowerCase()} ${el.outerHTML.slice(0, 120)}`),
  );
}

const TELAS = [
  "/dashboard",
  "/ordens",
  "/clientes",
  "/ctos",
  "/tecnicos",
  "/jornada",
  "/dispositivos",
  "/integracoes",
  "/configuracoes",
  "/perfil",
  "/busca?q=qa",
];

test.describe("RC-1D — acessibilidade", () => {
  test("A11Y-01 · todo controle das telas do ADMIN tem nome acessível", async ({ page }) => {
    await login(page, ADMIN);
    const problemas: string[] = [];
    for (const tela of TELAS) {
      await page.goto(tela);
      await page.waitForLoadState("domcontentloaded");
      const semNome = await controlesSemNome(page);
      problemas.push(...semNome.map((p) => `${tela}: ${p}`));
    }
    expect(problemas).toEqual([]);
  });

  test("A11Y-02 · todo campo de formulário tem rótulo", async ({ page }) => {
    await login(page, ADMIN);
    const problemas: string[] = [];
    for (const tela of TELAS) {
      await page.goto(tela);
      await page.waitForLoadState("domcontentloaded");
      const semRotulo = await camposSemRotulo(page);
      problemas.push(...semRotulo.map((p) => `${tela}: ${p}`));
    }
    expect(problemas).toEqual([]);
  });

  test("A11Y-03 · o menu é percorrível pelo teclado, e o foco aparece", async ({ page }) => {
    await login(page, ADMIN);
    await page.goto("/dashboard");
    await page.keyboard.press("Tab");

    const foco = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const estilo = getComputedStyle(el);
      return {
        tag: el.tagName.toLowerCase(),
        contorno: estilo.outlineStyle,
        largura: estilo.outlineWidth,
        sombra: estilo.boxShadow,
      };
    });
    expect(foco).not.toBeNull();
    // Foco visível: contorno ou sombra — nunca `outline: none` sem substituto.
    const temSinal =
      (foco!.contorno !== "none" && foco!.largura !== "0px") ||
      foco!.sombra !== "none";
    expect(temSinal, `foco sem sinal visível em ${foco!.tag}`).toBe(true);
  });
});
