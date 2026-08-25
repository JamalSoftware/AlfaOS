import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { assertTestDatabase } from "./test-db-guard";

const ADMIN_EMAIL = "admin@alfatelecom.local";
const DISPATCHER_EMAIL = "dispatcher@alfatelecom.local";
const PASSWORD = "AlfaOS@2026";

/**
 * A recognizable token so the assertions below can prove it never appears in
 * the page HTML after being saved.
 */
const TOKEN = "e2e_secret_token_do_not_leak_ABCD";
const TOKEN_LAST4 = "ABCD";

const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgresql://alfaos:alfaos_dev_password@localhost:5432/alfaos_test?schema=public";

const prisma = new PrismaClient({
  datasources: { db: { url: E2E_DATABASE_URL } },
});

test.beforeAll(async () => {
  await assertTestDatabase(E2E_DATABASE_URL, "E2E_DATABASE_URL");
});

/** Leaves the seeded integration exactly as the other specs expect it. */
test.afterAll(async () => {
  const admin = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL } });
  if (admin) {
    await prisma.eRPIntegration.updateMany({
      where: { companyId: admin.companyId },
      data: {
        credentialCiphertext: null,
        credentialIv: null,
        credentialAuthTag: null,
        credentialLast4: null,
        credentialUpdatedAt: null,
      },
    });
    await prisma.auditLog.deleteMany({
      where: { action: { startsWith: "ERP_CREDENTIAL" } },
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

test("ADMIN salva a credencial e o token nunca reaparece na tela", async ({
  page,
}) => {
  await login(page, ADMIN_EMAIL);
  await page.goto("/integracoes");

    // Um bloco por API desde a v0.7.1. Os dois existem; este teste cuida do
  // CallCenter, e o proximo prova que sao independentes.
  const cc = page.getByTestId("erp-credential-CALLCENTER");
  await expect(cc).toBeVisible();
  await expect(page.getByTestId("erp-credential-CHATBOT")).toBeVisible();
  await expect(cc.getByTestId("credential-status")).toContainText(
    "Não configurada",
  );

  await cc.getByTestId("credential-input").fill(TOKEN);
  await cc.getByTestId("credential-save").click();

  await expect(cc.getByTestId("credential-status")).toContainText(
    "Credencial configurada",
  );
  await expect(cc.getByTestId("credential-masked")).toContainText(TOKEN_LAST4);
  // "Configured" is explicitly not "validated".
  await expect(cc.getByTestId("credential-notice")).toContainText(
    "documentação oficial",
  );

  // The decisive assertion: the full token is nowhere in the rendered page.
  expect(await page.content()).not.toContain(TOKEN);

  // Nor after a full reload, where the HTML comes fresh from the server.
  await page.reload();
  await expect(cc.getByTestId("credential-masked")).toContainText(TOKEN_LAST4);
  expect(await page.content()).not.toContain(TOKEN);

  // And the database holds ciphertext, not the token.
  // O segredo vive em `erp_credentials` desde o cutover da v0.7.1; as
  // colunas legadas de `erp_integrations` ficaram inertes.
  const row = await prisma.eRPCredential.findFirstOrThrow({
    where: {
      company: { users: { some: { email: ADMIN_EMAIL } } },
      kind: "CALLCENTER",
    },
  });
  expect(JSON.stringify(row)).not.toContain(TOKEN);
  expect(row.credentialCiphertext).not.toBeNull();
  expect(row.aadVersion).toBe("v2");

  const legacy = await prisma.eRPIntegration.findFirstOrThrow({
    where: { company: { users: { some: { email: ADMIN_EMAIL } } } },
  });
  expect(legacy.credentialCiphertext).toBeNull();
});

test("ADMIN substitui e remove a credencial", async ({ page }) => {
  await login(page, ADMIN_EMAIL);
  await page.goto("/integracoes");
  const cc = page.getByTestId("erp-credential-CALLCENTER");

  // Replace: the form is hidden until the admin asks for it.
  await cc.getByTestId("credential-replace").click();
  await cc.getByTestId("credential-input").fill("outro_token_totalmente_novo_WXYZ");
  await cc.getByTestId("credential-save").click();
  await expect(cc.getByTestId("credential-masked")).toContainText("WXYZ");

  page.once("dialog", (d) => d.accept());
  await cc.getByTestId("credential-remove").click();
  await expect(cc.getByTestId("credential-status")).toContainText(
    "Não configurada",
  );
});

test("DISPATCHER não acessa a tela de integrações", async ({ page }) => {
  await login(page, DISPATCHER_EMAIL);
  await page.goto("/integracoes");
  // The page is ADMIN-only; the credential form must not be reachable.
  await expect(page.getByTestId("erp-credential-CALLCENTER")).toHaveCount(0);
  await expect(page.getByTestId("erp-credential-CHATBOT")).toHaveCount(0);
});

/**
 * A regressao que a separacao de credenciais existe para impedir: mexer numa
 * destruir a outra. Aqui isso e provado pela TELA, que e por onde o operador
 * de fato mexe.
 */
test("os dois blocos de credencial sao independentes", async ({ page }) => {
  await login(page, ADMIN_EMAIL);
  await page.goto("/integracoes");

  const cc = page.getByTestId("erp-credential-CALLCENTER");
  const cb = page.getByTestId("erp-credential-CHATBOT");

  // Abre o formulario quando o bloco ja chega configurado de um teste
  // anterior — a spec compartilha banco.
  async function fill(
    block: ReturnType<typeof page.getByTestId>,
    value: string,
  ) {
    const input = block.getByTestId("credential-input");
    if (!(await input.isVisible())) {
      await block.getByTestId("credential-replace").click();
    }
    await input.fill(value);
    await block.getByTestId("credential-save").click();
  }

  // Configura o CallCenter.
  await fill(cc, "token_do_callcenter_AAAA");
  await expect(cc.getByTestId("credential-masked")).toContainText("AAAA");

  // Configura o Chatbot.
  await fill(cb, "token_do_chatbot_BBBB");
  await expect(cb.getByTestId("credential-masked")).toContainText("BBBB");

  // O CallCenter continua onde estava.
  await expect(cc.getByTestId("credential-masked")).toContainText("AAAA");

  // Remover o Chatbot NAO pode tocar o CallCenter.
  page.once("dialog", (d) => d.accept());
  await cb.getByTestId("credential-remove").click();
  await expect(cb.getByTestId("credential-status")).toContainText(
    "Não configurada",
  );
  await expect(cc.getByTestId("credential-masked")).toContainText("AAAA");

  // E nenhum dos tokens aparece no HTML.
  const html = await page.content();
  expect(html).not.toContain("token_do_callcenter_AAAA");
  expect(html).not.toContain("token_do_chatbot_BBBB");
});

/**
 * O teste visual real da v0.7.1 encontrou a tela contando duas mentiras: o
 * card dizia 'Mock ERP' com o provider em RECEITANET, e um bloco anunciava a
 * integracao como futura quando ela ja estava wired. Estes testes fecham as
 * duas, e provam que cada bloco tem acoes proprias.
 */
test("a tela reflete o provider configurado, sem texto de futuro", async ({
  page,
}) => {
  await login(page, ADMIN_EMAIL);

  // Coloca a empresa em RECEITANET, que e o cenario onde o rotulo mentia.
  const admin = await prisma.user.findUniqueOrThrow({
    where: { email: ADMIN_EMAIL },
  });
  await prisma.eRPIntegration.updateMany({
    where: { companyId: admin.companyId },
    data: { provider: "RECEITANET" },
  });

  await page.goto("/integracoes");

  await expect(page.getByTestId("integration-name")).toHaveText("ReceitaNet");

  // O rotulo do CARD e o que mentia. `Mock ERP` continua existindo no
  // seletor de provider, e deve mesmo — trocar de volta segue possivel.
  await expect(page.getByTestId("integration-name")).not.toHaveText("Mock ERP");

  const html = await page.content();
  expect(html).not.toContain("ReceitaNet (futuro)");
  expect(html).not.toContain("sera implementada");
});

test("cada bloco tem Testar conexao, Substituir e Remover proprios", async ({
  page,
}) => {
  await login(page, ADMIN_EMAIL);
  await page.goto("/integracoes");

  const cc = page.getByTestId("erp-credential-CALLCENTER");
  const cb = page.getByTestId("erp-credential-CHATBOT");

  /**
   * Enquanto o formulario de token esta aberto, as acoes nao sao renderizadas
   * — "testar conexao" nao se aplica a uma credencial que ainda esta sendo
   * digitada. O botao aparece depois de salvar, logo abaixo.
   */

  /**
   * A spec roda em serie e compartilha banco, entao um bloco pode chegar aqui
   * ja configurado por um teste anterior. Nesse caso o campo so aparece
   * depois de 'Substituir' — abrir o formulario torna o teste independente
   * da ordem em que ele roda.
   */
  async function setToken(
    block: ReturnType<typeof page.getByTestId>,
    value: string,
  ) {
    const input = block.getByTestId("credential-input");
    if (!(await input.isVisible())) {
      await block.getByTestId("credential-replace").click();
    }
    await input.fill(value);
    await block.getByTestId("credential-save").click();
    await expect(block.getByTestId("credential-masked")).toBeVisible();
  }

  // Configura as duas.
  await setToken(cc, "token_do_callcenter_AAAA");
  await setToken(cb, "token_do_chatbot_BBBB");

  // As tres acoes existem em CADA bloco.
  for (const block of [cc, cb]) {
    await expect(block.getByTestId("credential-test")).toBeEnabled();
    await expect(block.getByTestId("credential-replace")).toBeVisible();
    await expect(block.getByTestId("credential-remove")).toBeVisible();
  }

  /**
   * O resultado e POR bloco. Testar um nao pode fazer o outro parecer
   * testado — sao credenciais diferentes, que podem falhar em momentos
   * diferentes.
   *
   * O token e ficticio, entao o teste falha de verdade contra o provedor. O
   * que se prova aqui e a INDEPENDENCIA, nao o sucesso.
   */
  await cc.getByTestId("credential-test").click();
  await expect(cc.getByTestId("credential-test-result")).toBeVisible({
    timeout: 30000,
  });
  await expect(cb.getByTestId("credential-test-result")).toHaveCount(0);

  // E nenhum token aparece no HTML depois de tudo isso.
  const html = await page.content();
  expect(html).not.toContain("token_do_callcenter_AAAA");
  expect(html).not.toContain("token_do_chatbot_BBBB");
});
