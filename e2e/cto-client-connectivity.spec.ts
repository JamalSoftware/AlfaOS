import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { assertTestDatabase } from "./test-db-guard";

/**
 * # RC-1D — os clientes da CTO, na tela da caixa
 *
 * Ao abrir uma CTO, o ADMIN precisa bater o olho e saber quais clientes estão
 * online, offline ou sem leitura, e quantas OS abertas eles têm. Só leitura:
 * nada é consultado no provedor, nada é gravado.
 *
 * O que só o navegador prova: o que aparece em cada porta, o que os filtros
 * escondem e mostram, que o estado não é só cor, que o detalhe diz os mesmos
 * números do popup do mapa — e que a tela aguenta 375 px.
 *
 * **Tenant sintético**, criado e apagado aqui — a mesma disciplina de
 * `cto-connections.spec.ts`.
 */

const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgresql://alfaos:alfaos_dev_password@localhost:5432/alfaos_test?schema=public";

const prisma = new PrismaClient({
  datasources: { db: { url: E2E_DATABASE_URL } },
});

const SENHA = "AlfaOS@2026";
const ADMIN = "rc1d-admin@sintetico.local";
const DESPACHO = "rc1d-despacho@sintetico.local";
const OUTRO_ADMIN = "rc1d-outra@sintetico.local";

/** Longe de qualquer outra fixture de mapa. */
const LOCAL = { latitude: -19.4321, longitude: -42.1234 };

let companyId = "";
let outraId = "";
let ctoId = "";
let ctoAlheiaId = "";
const clientes: Record<string, string> = {};

const MIN = 60_000;

test.beforeAll(async () => {
  await assertTestDatabase(E2E_DATABASE_URL, "E2E_DATABASE_URL");
  const bcrypt = (await import("bcryptjs")).default;
  const hash = bcrypt.hashSync(SENHA, 10);

  const empresa = await prisma.company.create({
    data: { name: "RC-1D Sintetica", ctoNetworkEnabled: true },
  });
  companyId = empresa.id;
  await prisma.user.createMany({
    data: [
      { companyId, name: "Admin RC1D", email: ADMIN, profile: "ADMIN", passwordHash: hash },
      { companyId, name: "Despacho RC1D", email: DESPACHO, profile: "DISPATCHER", passwordHash: hash },
    ],
  });

  const outra = await prisma.company.create({
    data: { name: "RC-1D Outra", ctoNetworkEnabled: true },
  });
  outraId = outra.id;
  await prisma.user.create({
    data: { companyId: outraId, name: "Admin Outra", email: OUTRO_ADMIN, profile: "ADMIN", passwordHash: hash },
  });

  // A caixa do roteiro do dono: portas 1–5 com os casos, 6–8 livres.
  const cto = await prisma.cTO.create({
    data: { companyId, name: "CTO QA RC1D", code: "RC1D-01", capacity: 8, ...LOCAL },
  });
  ctoId = cto.id;
  await prisma.cTOPort.createMany({
    data: Array.from({ length: 8 }, (_, i) => ({ ctoId, companyId, number: i + 1 })),
  });

  const agora = Date.now();
  const casos: Array<{
    chave: string;
    nome: string;
    porta: number;
    leitura: { status: "ONLINE" | "OFFLINE"; minutos: number } | null;
    os: Array<"PENDING" | "ASSIGNED" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED">;
  }> = [
    { chave: "online", nome: "QA RC1D ONLINE", porta: 1, leitura: { status: "ONLINE", minutos: 2 }, os: [] },
    { chave: "offline", nome: "QA RC1D OFFLINE", porta: 2, leitura: { status: "OFFLINE", minutos: 18 }, os: [] },
    { chave: "semLeitura", nome: "QA RC1D SEM LEITURA", porta: 3, leitura: null, os: [] },
    { chave: "onlineOs", nome: "QA RC1D ONLINE COM OS", porta: 4, leitura: { status: "ONLINE", minutos: 5 }, os: ["ASSIGNED", "COMPLETED"] },
    { chave: "offline2Os", nome: "QA RC1D OFFLINE COM 2 OS", porta: 5, leitura: { status: "OFFLINE", minutos: 40 }, os: ["PENDING", "IN_PROGRESS", "CANCELLED"] },
  ];
  let numero = 9100;
  for (const caso of casos) {
    const cliente = await prisma.customer.create({ data: { companyId, name: caso.nome } });
    clientes[caso.chave] = cliente.id;
    if (caso.leitura) {
      await prisma.customerDiagnosticSnapshot.create({
        data: {
          companyId,
          customerId: cliente.id,
          externalProvider: "MOCK",
          connectivityStatus: caso.leitura.status,
          observedAt: new Date(agora - caso.leitura.minutos * MIN),
        },
      });
    }
    for (const status of caso.os) {
      numero += 1;
      await prisma.serviceOrder.create({
        data: {
          companyId,
          number: numero,
          customerId: cliente.id,
          type: "Manutenção",
          description: "OS de QA RC-1D",
          status,
          ...(status === "COMPLETED" ? { completedAt: new Date() } : {}),
        },
      });
    }
    const porta = await prisma.cTOPort.findFirstOrThrow({ where: { ctoId, number: caso.porta } });
    await prisma.customerNetworkConnection.create({
      data: { companyId, customerId: cliente.id, ctoPortId: porta.id, connectedAt: new Date(), source: "WEB" },
    });
  }

  // Uma caixa de OUTRA empresa, para o teste de tenant.
  const alheia = await prisma.cTO.create({
    data: { companyId: outraId, name: "CTO ALHEIA RC1D", capacity: 2 },
  });
  ctoAlheiaId = alheia.id;
  await prisma.cTOPort.createMany({
    data: [1, 2].map((n) => ({ ctoId: ctoAlheiaId, companyId: outraId, number: n })),
  });
});

test.afterAll(async () => {
  for (const id of [companyId, outraId].filter(Boolean)) {
    await prisma.customerNetworkConnection.deleteMany({ where: { companyId: id } });
    await prisma.customerDiagnosticSnapshot.deleteMany({ where: { companyId: id } });
    await prisma.serviceOrderEvent.deleteMany({ where: { companyId: id } });
    await prisma.serviceOrder.deleteMany({ where: { companyId: id } });
    await prisma.cTOPort.deleteMany({ where: { companyId: id } });
    await prisma.cTO.deleteMany({ where: { companyId: id } });
    await prisma.customer.deleteMany({ where: { companyId: id } });
    await prisma.auditLog.deleteMany({ where: { companyId: id } });
    await prisma.user.deleteMany({ where: { companyId: id } });
    await prisma.company.delete({ where: { id } });
  }
  await prisma.$disconnect();
});

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Senha").fill(SENHA);
  await page.getByRole("button", { name: "Entrar" }).click();
  await page.waitForURL((u) => !u.pathname.includes("/login"));
}

async function abrirCaixa(page: Page) {
  await page.goto(`/ctos/${ctoId}`);
  await expect(page.getByTestId("cto-clients-summary")).toBeVisible();
}

const linhas = (page: Page) => page.getByTestId("cto-port-row");

/** O número de cada porta visível, na ordem da lista. */
async function portasVisiveis(page: Page) {
  const textos = await linhas(page).locator("span.w-16").allTextContents();
  return textos.map((t) => Number(t.trim()));
}

test("RC1D-CTO-01 · o resumo de clientes: ativos, online, offline, sem leitura e OS abertas", async ({ page }) => {
  await login(page, ADMIN);
  await abrirCaixa(page);

  await expect(page.getByTestId("cto-clients-active")).toHaveText("5");
  await expect(page.getByTestId("cto-clients-online")).toHaveText("2");
  await expect(page.getByTestId("cto-clients-offline")).toHaveText("2");
  await expect(page.getByTestId("cto-clients-unknown")).toHaveText("1");
  // 1 + 2: a OS concluída e a cancelada não contam.
  await expect(page.getByTestId("cto-clients-open-orders")).toHaveText("3");

  // Portas e clientes continuam separados.
  await expect(page.getByTestId("cto-free")).toHaveText("3");
  await expect(page.getByTestId("cto-clients-summary")).toContainText(
    "Abrir esta página não consulta o provedor",
  );
});

test("RC1D-CTO-02 · cada porta ocupada diz o cadastro, o estado, a idade da leitura e as OS — em TEXTO", async ({ page }) => {
  await login(page, ADMIN);
  await abrirCaixa(page);

  const online = page.getByTestId("cto-port-connectivity-1");
  await expect(online).toHaveText(/Online/);
  await expect(online).toHaveAttribute("data-status", "ONLINE");
  await expect(page.getByTestId("cto-port-registration-1")).toHaveText("Cadastro ativo");
  await expect(page.getByTestId("cto-port-reading-1")).toHaveText(/^Última leitura há 2 min$/);

  await expect(page.getByTestId("cto-port-connectivity-2")).toHaveText(/Offline/);
  await expect(page.getByTestId("cto-port-reading-2")).toHaveText("Última leitura há 18 min");

  // Sem snapshot: "Sem leitura", nunca "Offline".
  await expect(page.getByTestId("cto-port-connectivity-3")).toHaveText(/Sem leitura/);
  await expect(page.getByTestId("cto-port-connectivity-3")).not.toHaveText(/Offline/);
  await expect(page.getByTestId("cto-port-reading-3")).toHaveText("Nenhuma leitura disponível");

  await expect(page.getByTestId("cto-port-open-orders-4")).toHaveText("1 OS aberta");
  await expect(page.getByTestId("cto-port-open-orders-5")).toHaveText("2 OS abertas");
  await expect(page.getByTestId("cto-port-open-orders-1")).toHaveCount(0);

  // O estado não é só cor: a porta 1 e a 2 têm o rótulo escrito, diferente.
  const texto1 = await page.getByTestId("cto-port-connectivity-1").innerText();
  const texto2 = await page.getByTestId("cto-port-connectivity-2").innerText();
  expect(texto1).not.toBe(texto2);
});

test("RC1D-CTO-03 · porta LIVRE não tem conectividade — nem 'Sem leitura'", async ({ page }) => {
  await login(page, ADMIN);
  await abrirCaixa(page);

  for (const n of [6, 7, 8]) {
    await expect(page.getByTestId(`cto-port-state-${n}`)).toHaveText("Livre");
    await expect(page.getByTestId(`cto-port-client-${n}`)).toHaveCount(0);
  }
  const livre = linhas(page).filter({ has: page.getByTestId("cto-port-state-6") });
  await expect(livre).not.toContainText("Sem leitura");
});

test("RC1D-CTO-04 · filtros: Offline, Sem leitura, Livres, Com OS aberta — e Todas devolve tudo", async ({ page }) => {
  await login(page, ADMIN);
  await abrirCaixa(page);

  await expect(page.getByTestId("cto-port-filter-all")).toHaveText("Todas(8)");
  await expect(page.getByTestId("cto-port-filter-online")).toHaveText("Online(2)");
  await expect(page.getByTestId("cto-port-filter-offline")).toHaveText("Offline(2)");
  await expect(page.getByTestId("cto-port-filter-unknown")).toHaveText("Sem leitura(1)");
  await expect(page.getByTestId("cto-port-filter-free")).toHaveText("Livres(3)");
  await expect(page.getByTestId("cto-port-filter-open_os")).toHaveText("Com OS aberta(2)");

  await page.getByTestId("cto-port-filter-offline").click();
  await expect(page.getByTestId("cto-port-filter-offline")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("cto-port-filter-all")).toHaveAttribute("aria-pressed", "false");
  expect(await portasVisiveis(page)).toEqual([2, 5]);
  await expect(page.getByTestId("cto-port-filter-status")).toHaveText(
    "Mostrando 2 de 8 portas — Offline.",
  );

  await page.getByTestId("cto-port-filter-unknown").click();
  expect(await portasVisiveis(page)).toEqual([3]);

  await page.getByTestId("cto-port-filter-online").click();
  expect(await portasVisiveis(page)).toEqual([1, 4]);

  await page.getByTestId("cto-port-filter-open_os").click();
  expect(await portasVisiveis(page)).toEqual([4, 5]);

  await page.getByTestId("cto-port-filter-free").click();
  expect(await portasVisiveis(page)).toEqual([6, 7, 8]);
  await expect(page.getByTestId("cto-port-filters").locator("..")).not.toContainText("Sem leitura disponível");

  await page.getByTestId("cto-port-filter-all").click();
  expect(await portasVisiveis(page)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
});

test("RC1D-CTO-05 · o filtro funciona pelo TECLADO, e o foco é visível", async ({ page }) => {
  await login(page, ADMIN);
  await abrirCaixa(page);

  const offline = page.getByTestId("cto-port-filter-offline");
  await offline.focus();
  await expect(offline).toBeFocused();
  // Anel de foco: há sombra (o ring do Tailwind) no botão focado pelo teclado.
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(offline).toBeFocused();
  const sombra = await offline.evaluate((el) => getComputedStyle(el).boxShadow);
  expect(sombra).not.toBe("none");

  await page.keyboard.press("Enter");
  await expect(offline).toHaveAttribute("aria-pressed", "true");
  expect(await portasVisiveis(page)).toEqual([2, 5]);
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Space");
  // O anterior ao Offline é o Online.
  await expect(page.getByTestId("cto-port-filter-online")).toHaveAttribute("aria-pressed", "true");
});

test("RC1D-CTO-06 · o detalhe diz os MESMOS números do popup da caixa no mapa", async ({ page }) => {
  await login(page, ADMIN);
  await abrirCaixa(page);
  const detalhe = {
    ativos: await page.getByTestId("cto-clients-active").innerText(),
    online: await page.getByTestId("cto-clients-online").innerText(),
    offline: await page.getByTestId("cto-clients-offline").innerText(),
    semLeitura: await page.getByTestId("cto-clients-unknown").innerText(),
    os: await page.getByTestId("cto-clients-open-orders").innerText(),
  };

  await page.goto(`/mapa?lat=${LOCAL.latitude}&lng=${LOCAL.longitude}&z=17`);
  const marcador = page.locator('.leaflet-marker-icon[title^="CTO QA RC1D"]');
  await expect(marcador).toBeVisible({ timeout: 15_000 });
  await marcador.click();
  const operacional = page.getByTestId("cto-map-operational");
  await expect(operacional).toBeVisible();
  const texto = (await operacional.innerText()).replace(/\s+/g, " ");
  const numero = (rotulo: string) =>
    texto.match(new RegExp(`${rotulo} (\\d+)`))?.[1] ?? "?";

  expect({
    ativos: numero("Ativos"),
    online: numero("Online"),
    offline: numero("Offline"),
    semLeitura: numero("Sem leitura"),
    os: numero("OS abertas"),
  }).toEqual(detalhe);
});

test("RC1D-CTO-07 · recarregar mantém os números — nada foi gravado ao abrir", async ({ page }) => {
  const antes = await prisma.customerDiagnosticSnapshot.findMany({
    where: { companyId },
    orderBy: { id: "asc" },
  });
  await login(page, ADMIN);
  await abrirCaixa(page);
  await page.reload();
  await expect(page.getByTestId("cto-clients-online")).toHaveText("2");
  await expect(page.getByTestId("cto-port-reading-2")).toHaveText(/Última leitura há 1[89] min/);
  expect(
    await prisma.customerDiagnosticSnapshot.findMany({ where: { companyId }, orderBy: { id: "asc" } }),
  ).toEqual(antes);
});

test("RC1D-CTO-08 · o nome do cliente abre a ficha dele", async ({ page }) => {
  await login(page, ADMIN);
  await abrirCaixa(page);
  await page.getByTestId("cto-port-customer-2").click();
  await page.waitForURL(`**/clientes/${clientes.offline}/editar`);
});

test("RC1D-CTO-09 · 375 px: filtros quebram linha, e a página não rola de lado", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await login(page, ADMIN);
  await abrirCaixa(page);
  const larguras = await page.evaluate(() => ({
    rolagem: document.documentElement.scrollWidth,
    tela: document.documentElement.clientWidth,
  }));
  expect(larguras.rolagem).toBeLessThanOrEqual(larguras.tela);

  // A lista é longa e fica abaixo da dobra — o que importa é CABER na largura.
  const filtros = page.getByTestId("cto-port-filters").getByRole("button");
  await filtros.first().scrollIntoViewIfNeeded();
  for (const botao of await filtros.all()) {
    const caixa = (await botao.boundingBox())!;
    expect(caixa.x).toBeGreaterThanOrEqual(0);
    expect(caixa.x + caixa.width).toBeLessThanOrEqual(375);
  }
  const linha1 = page.getByTestId("cto-port-client-1");
  await linha1.scrollIntoViewIfNeeded();
  const meta = (await linha1.boundingBox())!;
  expect(meta.x + meta.width).toBeLessThanOrEqual(375);
});

test("RC1D-CTO-10 · DISPATCHER não abre a tela da CTO — o acesso não foi ampliado", async ({ page }) => {
  await login(page, DESPACHO);
  await page.goto(`/ctos/${ctoId}`);
  await expect(page.getByTestId("cto-clients-summary")).toHaveCount(0);
  expect(new URL(page.url()).pathname).not.toBe(`/ctos/${ctoId}`);
});

test("RC1D-CTO-11 · a caixa de outra empresa não abre, mesmo com o id conhecido", async ({ page }) => {
  await login(page, OUTRO_ADMIN);
  const resposta = await page.goto(`/ctos/${ctoId}`);
  expect(resposta?.status()).toBe(404);
  await expect(page.getByTestId("cto-clients-summary")).toHaveCount(0);
  await expect(page.getByText("QA RC1D ONLINE")).toHaveCount(0);

  // E a própria caixa dela abre, vazia de clientes.
  await page.goto(`/ctos/${ctoAlheiaId}`);
  await expect(page.getByTestId("cto-clients-active")).toHaveText("0");
});
