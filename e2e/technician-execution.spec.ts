import { test, expect, type Page } from "@playwright/test";

const ADMIN_EMAIL = "admin@alfatelecom.local";
const TECH_EMAIL = "tech@alfatelecom.local";
const TECH2_EMAIL = "tech2@alfatelecom.local";
const PASSWORD = "AlfaOS@2026";

const TECH_NAME = "Tecnico Alfa";
const TECH2_NAME = "Tecnico Beta";

/**
 * Orders used by this file. 10001 is claimed by `service-orders.spec.ts`, so
 * this suite works on 10002 (desktop flow) and 10003 (mobile flow) to stay out
 * of its way — the suite shares one seeded database and does not reset between
 * files.
 */
const DESKTOP_ORDER = "10002";
const MOBILE_ORDER = "10003";

const DIAGNOSIS = "Sinal fraco no CTO, conector oxidado.";
const WORK_PERFORMED = "Conector substituído e potência reajustada.";
const NOTES = "Cliente pediu retorno na próxima semana.";

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Senha").fill(PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
  // Wait for the post-login redirect to land. Without this, a `page.goto()`
  // issued right after the click races the redirect and can be sent before the
  // session cookie exists — the request then bounces back to /login and the
  // test fails for a reason that has nothing to do with what it asserts.
  await expect(page).not.toHaveURL(/\/login/);
}

async function logout(page: Page) {
  await page.getByRole("button", { name: "Sair" }).click();
  await expect(page).toHaveURL(/\/login/);
}

/** Idempotent: the previous spec may already have linked this technician. */
async function ensureTechnicianLinked(
  page: Page,
  userLabel: string,
  techName: string,
) {
  await page.goto("/tecnicos");
  await expect(page.getByRole("heading", { name: "Técnicos" })).toBeVisible();
  if ((await page.getByRole("cell", { name: techName }).count()) > 0) {
    return;
  }
  await page.goto("/tecnicos/novo");
  await page.getByLabel("Usuário").selectOption({ label: userLabel });
  await page.getByRole("button", { name: "Vincular técnico" }).click();
  await expect(page).toHaveURL(/\/tecnicos$/);
  await expect(page.getByRole("cell", { name: techName })).toBeVisible();
}

/**
 * Rótulo operacional da OS, indexado pelo número externo da fixture.
 *
 * A tela identifica a OS por `OS Nº <number>` — sequencial por empresa e
 * alocado no servidor. O número do ERP continua no registro (e continua
 * buscável), mas não é mais o que aparece no card nem no cabeçalho.
 */
const orderLabels: Record<string, string> = {};

/** Fronteira de palavra: `Nº 1` não pode casar com `Nº 12`. */
function osLabel(externalNumber: string): RegExp {
  return new RegExp(`${orderLabels[externalNumber]}\\b`);
}

/** Idempotent: assigns only when the order still has no technician. */
async function ensureAssigned(
  page: Page,
  orderNumber: string,
  techName: string,
): Promise<string> {
  // Busca pelo número do ERP: ele não é mais clicável na listagem, mas segue
  // sendo um critério de busca válido.
  await page.goto(`/ordens?search=${orderNumber}`);
  const rows = page.locator("tbody tr");
  await expect(rows).toHaveCount(1);
  await rows.getByRole("link").click();
  await expect(page).toHaveURL(new RegExp("/ordens/[a-z0-9]+$"));

  orderLabels[orderNumber] = (
    await page.getByTestId("order-number").innerText()
  ).trim();
  expect(orderLabels[orderNumber]).toMatch(/^OS Nº \d+$/);
  const orderUrl = page.url();

  if (await page.getByText("Nenhum técnico atribuído.").isVisible()) {
    await page.getByLabel("Técnico").selectOption({ label: techName });
    await page.getByRole("button", { name: "Atribuir OS" }).click();
    await expect(page.locator('span:text-is("Atribuída")')).toBeVisible();
  }
  return orderUrl;
}

/** `window.confirm` is auto-dismissed by Playwright unless handled. */
function acceptConfirmDialogs(page: Page) {
  page.on("dialog", (dialog) => dialog.accept());
}

async function expectNoHorizontalOverflow(page: Page) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  // 1px of slack for sub-pixel rounding; anything more is a real overflow.
  expect(
    scrollWidth,
    `página rola horizontalmente (${scrollWidth}px em ${clientWidth}px)`,
  ).toBeLessThanOrEqual(clientWidth + 1);
}

let desktopOrderUrl = "";
let mobileOrderUrl = "";

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  await login(page, ADMIN_EMAIL);
  await expect(page).toHaveURL(/\/dashboard/);

  await ensureTechnicianLinked(
    page,
    `${TECH_NAME} (${TECH_EMAIL})`,
    TECH_NAME,
  );
  await ensureTechnicianLinked(
    page,
    `${TECH2_NAME} (${TECH2_EMAIL})`,
    TECH2_NAME,
  );

  await page.goto("/ordens");
  await page.getByRole("button", { name: "Sincronizar Mock ERP" }).click();
  await expect(page.getByText(/Sincronizado:/)).toBeVisible();

  desktopOrderUrl = await ensureAssigned(page, DESKTOP_ORDER, TECH_NAME);
  mobileOrderUrl = await ensureAssigned(page, MOBILE_ORDER, TECH_NAME);

  await page.close();
});

test.describe.serial("Execução do técnico", () => {
  test("técnico inicia o atendimento a partir de Minhas OS", async ({
    page,
  }) => {
    acceptConfirmDialogs(page);

    await login(page, TECH_EMAIL);
    await expect(page).toHaveURL(/\/minhas-os/);
    await expect(page.getByRole("heading", { name: "Minhas OS" })).toBeVisible();

    await page
      .getByRole("link", { name: osLabel(DESKTOP_ORDER) })
      .click();
    await expect(
      page.getByRole("heading", { name: osLabel(DESKTOP_ORDER) }),
    ).toBeVisible();
    await expect(page.locator('span:text-is("Atribuída")')).toBeVisible();

    await page.getByRole("button", { name: "Iniciar atendimento" }).click();

    await expect(page.getByText("Status: Em atendimento")).toBeVisible();
    await expect(page.getByText(/Iniciado às \d{2}:\d{2}/)).toBeVisible();
    await expect(page.locator('span:text-is("Em atendimento")')).toBeVisible();
    await expect(page.getByText("Atendimento iniciado")).toBeVisible();

    // The started order is promoted to its own section, listed first.
    await page.goto("/minhas-os");
    await expect(
      page.getByRole("heading", { name: "Em atendimento" }),
    ).toBeVisible();
  });

  test("técnico preenche a execução, salva e o conteúdo sobrevive ao reload", async ({
    page,
  }) => {
    await login(page, TECH_EMAIL);
    await page.goto(desktopOrderUrl);
    await expect(page.getByText("Status: Em atendimento")).toBeVisible();

    await page.getByLabel("Diagnóstico").fill(DIAGNOSIS);
    await page.getByLabel("Serviço realizado").fill(WORK_PERFORMED);
    await page.getByLabel("Observações").fill(NOTES);

    await page.getByRole("button", { name: "Salvar execução" }).click();
    await expect(page.getByText("Execução salva.")).toBeVisible();

    await page.reload();
    await expect(page.getByLabel("Diagnóstico")).toHaveValue(DIAGNOSIS);
    await expect(page.getByLabel("Serviço realizado")).toHaveValue(
      WORK_PERFORMED,
    );
    await expect(page.getByLabel("Observações")).toHaveValue(NOTES);
  });

  test("técnico B não acessa a OS do técnico A por URL direta", async ({
    page,
  }) => {
    await login(page, TECH2_EMAIL);
    await expect(page).toHaveURL(/\/minhas-os/);
    await expect(
      page.getByRole("link", { name: osLabel(DESKTOP_ORDER) }),
    ).toHaveCount(0);

    await page.goto(desktopOrderUrl);
    await expect(page.getByText("This page could not be found.")).toBeVisible();
    await expect(page.getByLabel("Diagnóstico")).toHaveCount(0);
  });

  test("admin vê a OS em atendimento com a execução somente leitura", async ({
    page,
  }) => {
    await login(page, ADMIN_EMAIL);
    await page.goto(desktopOrderUrl);

    await expect(page.locator('span:text-is("Em atendimento")')).toBeVisible();
    await expect(page.getByText(TECH_NAME).first()).toBeVisible();
    await expect(page.getByText("Atendimento iniciado")).toBeVisible();

    // The content is there…
    await expect(page.getByText(DIAGNOSIS)).toBeVisible();
    await expect(page.getByText(WORK_PERFORMED)).toBeVisible();
    await expect(page.getByText(NOTES)).toBeVisible();

    // …but nothing editable, and no way to start someone else's work.
    await expect(page.getByLabel("Diagnóstico")).toHaveCount(0);
    await expect(page.getByLabel("Serviço realizado")).toHaveCount(0);
    await expect(page.getByLabel("Observações")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Salvar execução" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Iniciar atendimento" }),
    ).toHaveCount(0);

    await logout(page);
  });
});

test.describe("Execução do técnico — mobile 390x844", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("fluxo completo cabe na tela e os botões são clicáveis", async ({
    page,
  }) => {
    acceptConfirmDialogs(page);

    await login(page, TECH_EMAIL);
    await expect(page).toHaveURL(/\/minhas-os/);
    await expectNoHorizontalOverflow(page);

    await page
      .getByRole("link", { name: osLabel(MOBILE_ORDER) })
      .click();
    await expect(
      page.getByRole("heading", { name: osLabel(MOBILE_ORDER) }),
    ).toBeVisible();
    await expectNoHorizontalOverflow(page);

    const startButton = page.getByRole("button", {
      name: "Iniciar atendimento",
    });
    // `click()` fails on its own if the control is off-screen, covered or
    // zero-sized, so a successful click IS the "really clickable" assertion.
    await expect(startButton).toBeInViewport();
    await startButton.click();

    await expect(page.getByText("Status: Em atendimento")).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await page.getByLabel("Diagnóstico").fill("Diagnóstico no celular.");
    await page.getByLabel("Serviço realizado").fill("Serviço no celular.");
    await page.getByLabel("Observações").fill("Observação no celular.");
    await expectNoHorizontalOverflow(page);

    const saveButton = page.getByRole("button", { name: "Salvar execução" });
    await saveButton.scrollIntoViewIfNeeded();
    await expect(saveButton).toBeInViewport();
    await saveButton.click();

    await expect(page.getByText("Execução salva.")).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await page.reload();
    await expect(page.getByLabel("Diagnóstico")).toHaveValue(
      "Diagnóstico no celular.",
    );
    await expectNoHorizontalOverflow(page);
  });
});
