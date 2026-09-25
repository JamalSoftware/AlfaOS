import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { assertTestDatabase } from "./test-db-guard";

/**
 * # PRD §382 — configurar o checklist PELO PRODUTO
 *
 * As duas superfícies de configuração existiam só como API. Este arquivo prova
 * o que a §382 passou a exigir na V1: um ADMIN configura cobertura e exigência
 * pela interface, sem `curl`, e o que ele salva volta depois de recarregar.
 *
 * Estado PRÓPRIO deste arquivo: um tipo dedicado, removido no fim. O catálogo
 * da empresa de teste é compartilhado com outros specs, e um tipo sobrevivente
 * apareceria na contagem deles.
 */

const ADMIN_EMAIL = "admin@alfatelecom.local";
const DISPATCHER_EMAIL = "dispatcher@alfatelecom.local";
const TECH_EMAIL = "tech@alfatelecom.local";
const PASSWORD = "AlfaOS@2026";

const TYPE_NAME = "Checklist E2E";

const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgresql://alfaos:alfaos_dev_password@localhost:5432/alfaos_test?schema=public";

const prisma = new PrismaClient({
  datasources: { db: { url: E2E_DATABASE_URL } },
});

let typeId = "";
let companyId = "";

async function login(page: Page, email: string) {
  // Trocar de perfil no mesmo contexto exige soltar a sessão anterior: com ela
  // viva, `/login` redireciona para o painel e o campo de e-mail nunca aparece.
  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Senha").fill(PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

test.beforeAll(async () => {
  await assertTestDatabase(E2E_DATABASE_URL, "E2E_DATABASE_URL");

  const admin = await prisma.user.findUniqueOrThrow({
    where: { email: ADMIN_EMAIL },
    select: { companyId: true },
  });
  companyId = admin.companyId;

  const tipo = await prisma.serviceOrderType.upsert({
    where: { companyId_name: { companyId, name: TYPE_NAME } },
    update: { active: true },
    create: { companyId, name: TYPE_NAME, sortOrder: 900 },
  });
  typeId = tipo.id;
});

test.afterAll(async () => {
  await prisma.checklistTemplateItem.deleteMany({
    where: { template: { serviceOrderTypeId: typeId } },
  });
  await prisma.checklistTemplate.deleteMany({
    where: { serviceOrderTypeId: typeId },
  });
  await prisma.serviceOrderCompletionPolicy.deleteMany({
    where: { serviceOrderTypeId: typeId },
  });
  await prisma.serviceOrderType.deleteMany({ where: { id: typeId } });
  await prisma.$disconnect();
});

test.describe("CHK-UI — configuração de checklist pelo ADMIN", () => {
  test("CHK-UI-01/02 · o ADMIN cria o checklist do tipo, marca obrigatório e o que salvou volta", async ({
    page,
  }) => {
    await login(page, ADMIN_EMAIL);
    await page.goto("/tipos-os");

    await page.getByTestId(`checklist-configure-${typeId}`).click();
    const editor = page.getByTestId(`checklist-editor-${typeId}`);
    await expect(editor).toBeVisible();

    await page.getByTestId(`checklist-add-item-${typeId}`).click();
    await page
      .getByTestId(`checklist-item-label-${typeId}-0`)
      .fill("Confirmar ponto de atendimento");
    // Nasce obrigatório: um item que ninguém precisa responder não muda o
    // fechamento, e a §382 é sobre exigir o que o atendimento precisa.
    await expect(
      page.getByTestId(`checklist-item-required-${typeId}-0`),
    ).toBeChecked();

    await page.getByTestId(`checklist-add-item-${typeId}`).click();
    await page
      .getByTestId(`checklist-item-label-${typeId}-1`)
      .fill("Testar conectividade");

    await page.getByTestId(`checklist-save-${typeId}`).click();
    await expect(page.getByText("Checklist salvo.")).toBeVisible();

    // A prova é a RELEITURA: sessão nova, dado vindo do servidor.
    await page.goto("/tipos-os");
    await expect(page.getByTestId(`checklist-summary-${typeId}`)).toContainText(
      "2 itens · 2 obrigatórios",
    );

    await page.getByTestId(`checklist-configure-${typeId}`).click();
    await expect(
      page.getByTestId(`checklist-item-label-${typeId}-0`),
    ).toHaveValue("Confirmar ponto de atendimento");
    await expect(
      page.getByTestId(`checklist-item-label-${typeId}-1`),
    ).toHaveValue("Testar conectividade");
  });

  test("CHK-UI-03 · exigir checklist para concluir persiste e preserva o resto da política", async ({
    page,
  }) => {
    /*
      A API SUBSTITUI a política inteira. Esta política nasce com exigência de
      assinatura para provar o que o enunciado exige preservar: marcar
      "exigir checklist" não pode apagar em silêncio o que já era exigido.
    */
    await prisma.serviceOrderCompletionPolicy.upsert({
      where: { serviceOrderTypeId: typeId },
      update: { requireChecklist: false, requireSignature: true, minEvidenceCount: 2 },
      create: {
        companyId,
        serviceOrderTypeId: typeId,
        requireChecklist: false,
        requireSignature: true,
        minEvidenceCount: 2,
      },
    });

    await login(page, ADMIN_EMAIL);
    await page.goto("/tipos-os");

    const marcador = page.getByTestId(`policy-require-checklist-${typeId}`);
    await expect(marcador).not.toBeChecked();
    /*
      `click`, e não `check`: o marcador é CONTROLADO pelo servidor. `check`
      exige que o estado mude no próprio clique, e aqui ele só muda quando a
      API confirma e a página relê — que é justamente a propriedade desta tela
      (ela não é autoridade). Quem prova a mudança é o banco, logo abaixo.
    */
    await marcador.click();

    await expect(async () => {
      const policy = await prisma.serviceOrderCompletionPolicy.findUniqueOrThrow({
        where: { serviceOrderTypeId: typeId },
      });
      expect(policy.requireChecklist).toBe(true);
      expect(policy.requireSignature, "a assinatura exigida foi apagada").toBe(
        true,
      );
      expect(policy.minEvidenceCount, "o mínimo de fotos foi apagado").toBe(2);
    }).toPass({ timeout: 10_000 });

    await page.goto("/tipos-os");
    await expect(
      page.getByTestId(`policy-require-checklist-${typeId}`),
    ).toBeChecked();
  });

  test("CHK-UI-04 · o checklist padrão da empresa é configurável e diz o que ele cobre", async ({
    page,
  }) => {
    await login(page, ADMIN_EMAIL);
    await page.goto("/tipos-os");

    await expect(
      page.getByText("Checklist padrão da empresa", { exact: true }),
    ).toBeVisible();
    /*
      A cópia não pode prometer bloqueio para OS sem tipo: a exigência é por
      tipo, e ordem importada não tem tipo (CHK-NULL-01). Dizer o contrário
      faria o operador acreditar que configurou uma trava que não existe.
    */
    await expect(
      page.getByText("só uma OS com tipo pode ser bloqueada por checklist"),
    ).toBeVisible();

    await page.getByTestId("checklist-configure-default").click();
    await expect(page.getByTestId("checklist-editor-default")).toBeVisible();
  });

  test("CHK-UI-05 · DISPATCHER e TECHNICIAN não alcançam a tela nem a escrita", async ({
    page,
  }) => {
    for (const email of [DISPATCHER_EMAIL, TECH_EMAIL]) {
      await login(page, email);
      await page.goto("/tipos-os");
      await expect(page).not.toHaveURL(/\/tipos-os/);
    }

    // A tela é conveniência; quem recusa é a rota. Sessão de DISPATCHER
    // mandando o corpo correto continua sendo 403.
    /*
      `page.request`, e não a fixture `request`: só ele carrega os cookies da
      sessão que acabou de entrar. A fixture tem pote de cookies próprio, e o
      teste mediria um 401 de anônimo achando que mediu o 403 do perfil.
    */
    await login(page, DISPATCHER_EMAIL);
    const resposta = await page.request.put("/api/checklist-templates", {
      data: {
        serviceOrderTypeId: typeId,
        name: "Checklist proibido",
        items: [{ label: "Não deveria existir", type: "BOOLEAN", required: true }],
      },
    });
    expect(resposta.status()).toBe(403);

    const gravado = await prisma.checklistTemplate.findFirst({
      where: { serviceOrderTypeId: typeId, name: "Checklist proibido" },
    });
    expect(gravado, "o DISPATCHER gravou um checklist").toBeNull();
  });
});

/**
 * # `APP-003` — o ADMIN configura TODOS os requisitos pela tela
 *
 * O backend já decidia os sete; a tela expunha um. Estes casos provam a
 * superfície nova pelo navegador — inclusive que ela não mostra nome de enum,
 * e que uma falha de gravação não é anunciada como sucesso.
 */
test.describe("POL-ADMIN — requisitos de conclusão pela interface", () => {
  async function abrirRequisitos(page: Page) {
    await page.goto("/tipos-os");
    await page.getByTestId(`requisitos-configure-${typeId}`).click();
    await expect(page.getByTestId(`requisitos-editor-${typeId}`)).toBeVisible();
  }

  test("POL-ADMIN-01/14 · os sete requisitos aparecem, em português", async ({
    page,
  }) => {
    await login(page, ADMIN_EMAIL);
    await abrirRequisitos(page);

    // Os cinco interruptores.
    for (const campo of [
      "requireCheckIn",
      "requireChecklist",
      "requireEquipment",
      "requireMaterials",
      "requireSignature",
    ]) {
      await expect(
        page.getByTestId(`requisito-${campo}-${typeId}`),
      ).toBeVisible();
    }
    // A quantidade mínima e as categorias.
    await expect(page.getByTestId(`requisito-min-fotos-${typeId}`)).toBeVisible();
    await expect(
      page.getByTestId(`requisito-categoria-ONU_ONT-${typeId}`),
    ).toBeVisible();

    /*
      POL-ADMIN-14: o VALOR canônico continua embaixo (é o `data-testid`), e o
      texto que o operador lê é o rótulo. A asserção olha o painel inteiro:
      qualquer enum cru que escape aparece aqui.
    */
    const painel = page.getByTestId(`requisitos-editor-${typeId}`);
    await expect(painel).toContainText("ONU / ONT");
    await expect(painel).toContainText("Leitura óptica");
    await expect(painel).not.toContainText("ONU_ONT");
    await expect(painel).not.toContainText("OPTICAL_READING");
    await expect(painel).not.toContainText("minEvidenceCount");
    await expect(painel).not.toContainText("requireSignature");
  });

  test("POL-ADMIN-02/03..08 · o que o ADMIN salva volta depois de recarregar", async ({
    page,
  }) => {
    await login(page, ADMIN_EMAIL);
    await abrirRequisitos(page);

    await page.getByTestId(`requisito-requireSignature-${typeId}`).check();
    await page.getByTestId(`requisito-requireEquipment-${typeId}`).check();
    await page.getByTestId(`requisito-requireCheckIn-${typeId}`).check();
    await page.getByTestId(`requisito-min-fotos-${typeId}`).fill("2");
    await page.getByTestId(`requisito-categoria-CTO-${typeId}`).check();

    await page.getByTestId(`requisitos-save-${typeId}`).click();
    // O sucesso é dito DEPOIS do servidor confirmar.
    await expect(page.getByTestId(`requisitos-aviso-${typeId}`)).toHaveText(
      "Requisitos salvos.",
    );

    // A prova é a RELEITURA: o estado local pode estar certo e o banco não.
    await abrirRequisitos(page);
    await expect(
      page.getByTestId(`requisito-requireSignature-${typeId}`),
    ).toBeChecked();
    await expect(
      page.getByTestId(`requisito-requireEquipment-${typeId}`),
    ).toBeChecked();
    await expect(
      page.getByTestId(`requisito-requireCheckIn-${typeId}`),
    ).toBeChecked();
    await expect(
      page.getByTestId(`requisito-min-fotos-${typeId}`),
    ).toHaveValue("2");
    await expect(
      page.getByTestId(`requisito-categoria-CTO-${typeId}`),
    ).toBeChecked();
    // E o que não foi marcado continua desmarcado.
    await expect(
      page.getByTestId(`requisito-requireMaterials-${typeId}`),
    ).not.toBeChecked();
  });

  test("POL-ADMIN-16 · falha ao salvar NÃO vira sucesso, e o rascunho fica", async ({
    page,
  }) => {
    await login(page, ADMIN_EMAIL);
    await abrirRequisitos(page);

    // O servidor recusa. A tela não pode anunciar que gravou.
    await page.route(
      `**/api/service-order-types/${typeId}/completion-policy`,
      (route) =>
        route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "Falha simulada do servidor." }),
        }),
    );

    await page.getByTestId(`requisito-requireMaterials-${typeId}`).check();
    await page.getByTestId(`requisito-min-fotos-${typeId}`).fill("5");
    await page.getByTestId(`requisitos-save-${typeId}`).click();

    /*
      O erro tem `testid` próprio: `getByRole("alert")` sozinho também casa com
      o anunciador de rota do Next (`__next-route-announcer__`), e a asserção
      falhava por ambiguidade — com a tela CERTA por trás.
    */
    await expect(page.getByTestId(`requisitos-erro-${typeId}`)).toContainText(
      "Falha simulada",
    );
    await expect(
      page.getByTestId(`requisitos-aviso-${typeId}`),
    ).toHaveCount(0);

    // O trabalho do operador sobrevive à falha: ele tenta de novo, não
    // redigita.
    await expect(
      page.getByTestId(`requisito-requireMaterials-${typeId}`),
    ).toBeChecked();
    await expect(
      page.getByTestId(`requisito-min-fotos-${typeId}`),
    ).toHaveValue("5");
  });
});
