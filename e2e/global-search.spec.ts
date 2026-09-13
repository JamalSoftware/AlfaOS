import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { allocateServiceOrderNumber } from "../src/lib/service-order-number";
import { assertTestDatabase } from "./test-db-guard";

/**
 * # GS-1 — Busca global, pelo navegador
 *
 * Duas empresas sintéticas com dados GÊMEOS (mesmo nome, mesmo telefone): a
 * busca de uma nunca devolve a outra, e o registro de cada uma é achado pela
 * própria — o controle positivo. Três perfis, porque o DISPATCHER não recebe CTO
 * e o TECHNICIAN não tem busca.
 */

const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgresql://alfaos:alfaos_dev_password@localhost:5432/alfaos_test?schema=public";

const prisma = new PrismaClient({
  datasources: { db: { url: E2E_DATABASE_URL } },
});

const SENHA = "AlfaOS@2026";
const EMAIL_ADMIN = "qa.gs.admin@sintetico.local";
const EMAIL_DESPACHO = "qa.gs.despacho@sintetico.local";
const EMAIL_TECNICO = "qa.gs.tecnico@sintetico.local";
const EMAIL_ADMIN_OUTRA = "qa.gs.admin.outra@sintetico.local";
const EMAILS = [EMAIL_ADMIN, EMAIL_DESPACHO, EMAIL_TECNICO, EMAIL_ADMIN_OUTRA];

const JOANA = "QA GS Joana Gêmea";
const TELEFONE = "92988880001";
const LOTE = 6;

let empresaId = "";
let outraId = "";
let joanaId = "";
let joanaOutraId = "";
let osId = "";
let osNumero = 0;
let ctoId = "";
let tecnicoNome = "";

test.beforeAll(async () => {
  await assertTestDatabase(E2E_DATABASE_URL, "E2E_DATABASE_URL");
  const bcrypt = (await import("bcryptjs")).default;
  const hash = bcrypt.hashSync(SENHA, 10);

  empresaId = (
    await prisma.company.create({ data: { name: "GS-1 Sintetica", ctoNetworkEnabled: true } })
  ).id;
  outraId = (
    await prisma.company.create({ data: { name: "GS-1 Outra Sintetica", ctoNetworkEnabled: true } })
  ).id;
  const usuario = (companyId: string, email: string, name: string, profile: "ADMIN" | "DISPATCHER" | "TECHNICIAN") =>
    prisma.user.create({ data: { companyId, email, name, profile, passwordHash: hash } });
  await usuario(empresaId, EMAIL_ADMIN, "QA GS Admin", "ADMIN");
  await usuario(empresaId, EMAIL_DESPACHO, "QA GS Despacho", "DISPATCHER");
  const userTecnico = await usuario(empresaId, EMAIL_TECNICO, "QA GS Técnico Busca", "TECHNICIAN");
  await usuario(outraId, EMAIL_ADMIN_OUTRA, "QA GS Admin Outra", "ADMIN");
  tecnicoNome = userTecnico.name;
  const tecnico = await prisma.technician.create({ data: { companyId: empresaId, userId: userTecnico.id } });

  const gemea = {
    name: JOANA,
    phone: TELEFONE,
    address: "Rua das Palmeiras",
    number: "10",
    district: "Centro",
    city: "Manaus",
    state: "AM",
  };
  joanaId = (await prisma.customer.create({ data: { companyId: empresaId, ...gemea } })).id;
  joanaOutraId = (await prisma.customer.create({ data: { companyId: outraId, ...gemea } })).id;
  await prisma.customer.create({ data: { companyId: empresaId, name: "QA GS Pedro Inativo", active: false } });
  for (let i = 1; i <= LOTE; i += 1) {
    await prisma.customer.create({ data: { companyId: empresaId, name: `QA GS Lote ${i}` } });
  }

  const os = await prisma.serviceOrder.create({
    data: {
      companyId: empresaId,
      number: await allocateServiceOrderNumber(prisma, empresaId),
      customerId: joanaId,
      technicianId: tecnico.id,
      type: "Instalação",
      description: "QA GS instalação",
      status: "ASSIGNED",
      assignedAt: new Date(),
    },
  });
  osId = os.id;
  osNumero = os.number;
  ctoId = (
    await prisma.cTO.create({ data: { companyId: empresaId, name: "QA GS CTO Norte", code: "GSN1", capacity: 8 } })
  ).id;
});

test.afterAll(async () => {
  for (const companyId of [empresaId, outraId].filter(Boolean)) {
    const w = { where: { companyId } };
    await prisma.serviceOrderEvent.deleteMany(w);
    await prisma.serviceOrder.deleteMany(w);
    await prisma.cTO.deleteMany(w);
    await prisma.customer.deleteMany(w);
    await prisma.technician.deleteMany(w);
    await prisma.auditLog.deleteMany(w);
    await prisma.user.deleteMany(w);
    await prisma.company.delete({ where: { id: companyId } });
  }
  await prisma.loginAttempt.deleteMany({ where: { email: { in: EMAILS } } });
  await prisma.$disconnect();
});

async function entrar(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Senha").fill(SENHA);
  await page.getByRole("button", { name: "Entrar" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
}

/** O campo do menu que está NA TELA (o do desktop fica escondido no celular). */
const campoDoMenu = (page: Page) =>
  page.getByTestId("sidebar-search").filter({ visible: true }).getByRole("searchbox");

async function buscarPeloMenu(page: Page, termo: string) {
  await campoDoMenu(page).fill(termo);
  await campoDoMenu(page).press("Enter");
  await page.waitForURL(/\/busca\?q=/);
}

const grupo = (page: Page, tipo: string) => page.locator(`[data-testid="global-search-group"][data-type="${tipo}"]`);
const hit = (page: Page, tipo: string, id: string) =>
  page.locator(`[data-testid="global-search-hit"][data-type="${tipo}"][data-id="${id}"]`);

async function semRolagemHorizontal(page: Page) {
  const { rolagem, janela } = await page.evaluate(() => ({
    rolagem: document.documentElement.scrollWidth,
    janela: window.innerWidth,
  }));
  expect(rolagem).toBeLessThanOrEqual(janela);
}

test.describe("GS-1 — busca global", () => {
  test("GS-E2E-01 — ADMIN acha o cliente pelo menu, abre, e volta aos resultados", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await entrar(page, EMAIL_ADMIN);
    await buscarPeloMenu(page, "Joana Gêmea");

    await expect(page.getByRole("heading", { level: 1, name: "Busca" })).toBeVisible();
    await expect(grupo(page, "CUSTOMER")).toContainText(JOANA);
    await expect(hit(page, "CUSTOMER", joanaId)).toHaveCount(1);
    // A gêmea da outra empresa nunca aparece.
    await expect(hit(page, "CUSTOMER", joanaOutraId)).toHaveCount(0);
    await expect(grupo(page, "CUSTOMER")).toContainText("Centro · Manaus/AM");

    await hit(page, "CUSTOMER", joanaId).getByRole("link", { name: JOANA }).click();
    await expect(page).toHaveURL(new RegExp(`/clientes/${joanaId}/editar$`));
    await page.goBack();
    await expect(page).toHaveURL(/\/busca\?q=Joana/);
    await expect(hit(page, "CUSTOMER", joanaId)).toBeVisible();
  });

  test("GS-E2E-02 — telefone com máscara, endereço, número de OS, CTO e técnico, cada um na rota dele", async ({ page }) => {
    await entrar(page, EMAIL_ADMIN);

    await page.goto(`/busca?q=${encodeURIComponent("(92) 98888-0001")}`);
    await expect(hit(page, "CUSTOMER", joanaId)).toHaveCount(1);
    await page.goto("/busca?q=Palmeiras");
    await expect(hit(page, "CUSTOMER", joanaId)).toHaveCount(1);

    await page.goto(`/busca?q=${encodeURIComponent(`OS ${osNumero}`)}`);
    await hit(page, "SERVICE_ORDER", osId).getByRole("link", { name: `OS Nº ${osNumero}` }).click();
    await expect(page).toHaveURL(new RegExp(`/ordens/${osId}$`));

    await page.goto("/busca?q=GSN1");
    await hit(page, "CTO", ctoId).getByRole("link", { name: "QA GS CTO Norte" }).click();
    await expect(page).toHaveURL(new RegExp(`/ctos/${ctoId}$`));

    await page.goto(`/busca?q=${encodeURIComponent("Técnico Busca")}`);
    await grupo(page, "TECHNICIAN").getByRole("link", { name: tecnicoNome }).click();
    await expect(page).toHaveURL(/\/tecnicos\?search=/);
    await expect(page.locator("table tbody tr", { hasText: tecnicoNome })).toHaveCount(1);
  });

  test("GS-E2E-03 — nada encontrado, termo curto, inativo marcado e 'ver todos' na listagem", async ({ page }) => {
    await entrar(page, EMAIL_ADMIN);

    await page.goto("/busca?q=QA%20GS%20Inexistente%20Xyz");
    await expect(page.getByTestId("global-search-empty")).toContainText("Nenhum resultado");
    await expect(page.getByTestId("global-search-error")).toHaveCount(0);

    await page.goto("/busca?q=a");
    await expect(page.getByTestId("global-search-too-short")).toBeVisible();

    await page.goto("/busca?q=Pedro%20Inativo");
    await expect(grupo(page, "CUSTOMER")).toContainText("Inativo");

    await page.goto("/busca?q=QA%20GS%20Lote");
    await expect(grupo(page, "CUSTOMER").getByTestId("global-search-hit")).toHaveCount(5);
    await grupo(page, "CUSTOMER").getByRole("link", { name: "Ver todos em Clientes" }).click();
    await expect(page).toHaveURL(/\/clientes\?search=QA(%20|\+)GS(%20|\+)Lote$/);
    await expect(page.locator("table tbody tr")).toHaveCount(LOTE);
  });

  test("GS-E2E-04 — DISPATCHER acha cliente, OS e técnico, e nunca CTO", async ({ page }) => {
    await entrar(page, EMAIL_DESPACHO);
    await buscarPeloMenu(page, "QA GS");
    await expect(grupo(page, "CUSTOMER")).toBeVisible();
    await expect(grupo(page, "SERVICE_ORDER")).toBeVisible();
    await expect(grupo(page, "TECHNICIAN")).toBeVisible();
    await expect(grupo(page, "CTO")).toHaveCount(0);
    await page.goto("/busca?q=GSN1");
    await expect(page.getByTestId("global-search-empty")).toBeVisible();
  });

  test("GS-E2E-05 — TECHNICIAN não tem o campo, e /busca o manda para a tela dele", async ({ page }) => {
    await entrar(page, EMAIL_TECNICO);
    await expect(page.getByTestId("sidebar-search")).toHaveCount(0);
    await page.goto("/busca?q=Joana");
    await expect(page).toHaveURL(/\/minhas-os/);
  });

  test("GS-E2E-06 — celular 375 pela gaveta, e desktops 1280/1366/1440 sem rolagem horizontal", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await entrar(page, EMAIL_ADMIN);
    await page.getByRole("button", { name: "Abrir menu" }).click();
    await buscarPeloMenu(page, "Joana Gêmea");
    await expect(hit(page, "CUSTOMER", joanaId)).toBeVisible();
    await semRolagemHorizontal(page);

    for (const [width, height] of [
      [1280, 720],
      [1366, 768],
      [1440, 900],
    ]) {
      await page.setViewportSize({ width, height });
      await page.goto("/busca?q=QA%20GS");
      await expect(grupo(page, "CUSTOMER")).toBeVisible();
      await semRolagemHorizontal(page);
    }
  });
});
