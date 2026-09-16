import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { allocateServiceOrderNumber } from "../src/lib/service-order-number";
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
    data: { companyId, name: "CTO QA RC1D", code: "RC1D-01", capacity: 10, ...LOCAL },
  });
  ctoId = cto.id;
  await prisma.cTOPort.createMany({
    data: Array.from({ length: 10 }, (_, i) => ({ ctoId, companyId, number: i + 1 })),
  });

  const agora = Date.now();
  const casos: Array<{
    chave: string;
    nome: string;
    porta: number;
    /**
     * `minutos` é a idade da VERIFICAÇÃO; `desdeMin`, a do ESTADO.
     *
     * Quando os dois são iguais a fixture não distingue nada — foi por isso que
     * o caso do dono (online há nove dias, verificado há dois minutos) precisou
     * de um campo próprio: sem ele, um teste que derivasse duração de
     * `observedAt` continuaria passando.
     */
    leitura: {
      status: "ONLINE" | "OFFLINE";
      minutos: number;
      desdeMin?: number;
    } | null;
    ativo?: boolean;
    os: Array<"PENDING" | "ASSIGNED" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED">;
  }> = [
    { chave: "online", nome: "QA RC1D ONLINE", porta: 1, leitura: { status: "ONLINE", minutos: 2 }, os: [] },
    { chave: "offline", nome: "QA RC1D OFFLINE", porta: 2, leitura: { status: "OFFLINE", minutos: 18 }, os: [] },
    { chave: "semLeitura", nome: "QA RC1D SEM LEITURA", porta: 3, leitura: null, os: [] },
    { chave: "onlineOs", nome: "QA RC1D ONLINE COM OS", porta: 4, leitura: { status: "ONLINE", minutos: 5 }, os: ["ASSIGNED", "COMPLETED"] },
    { chave: "offline2Os", nome: "QA RC1D OFFLINE COM 2 OS", porta: 5, leitura: { status: "OFFLINE", minutos: 40 }, os: ["PENDING", "IN_PROGRESS", "CANCELLED"] },
    // O caso que o dono levantou: online HÁ NOVE DIAS, verificado agora há pouco.
    { chave: "longo", nome: "QA RC1D ONLINE LONGO", porta: 6, leitura: { status: "ONLINE", minutos: 2, desdeMin: 9 * 24 * 60 }, os: [] },
    // Verificação atrasada: o estado é conhecido, a confirmação envelheceu.
    { chave: "atrasado", nome: "QA RC1D ATRASADO", porta: 7, leitura: { status: "ONLINE", minutos: 37, desdeMin: 5 * 24 * 60 }, os: [] },
    // Cadastro inativo e fisicamente ONLINE — o cabo continua no poste.
    { chave: "inativo", nome: "QA RC1D INATIVO", porta: 8, leitura: { status: "ONLINE", minutos: 1, desdeMin: 2 * 24 * 60 }, ativo: false, os: [] },
  ];
  for (const caso of casos) {
    const cliente = await prisma.customer.create({
      data: { companyId, name: caso.nome, active: caso.ativo ?? true },
    });
    clientes[caso.chave] = cliente.id;
    if (caso.leitura) {
      await prisma.customerDiagnosticSnapshot.create({
        data: {
          companyId,
          customerId: cliente.id,
          externalProvider: "MOCK",
          connectivityStatus: caso.leitura.status,
          observedAt: new Date(agora - caso.leitura.minutos * MIN),
          statusSince: new Date(
            agora - (caso.leitura.desdeMin ?? caso.leitura.minutos) * MIN,
          ),
        },
      });
    }
    for (const status of caso.os) {
      await prisma.serviceOrder.create({
        data: {
          companyId,
          // O número vem do contador da empresa, nunca de um literal (DEV-DATA-01).
          number: await allocateServiceOrderNumber(prisma, companyId),
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
  await expect(page.getByTestId("cto-port-filters")).toBeVisible();
}

const linhas = (page: Page) => page.getByTestId("cto-port-row");

/** O número de cada porta visível, na ordem da lista. */
async function portasVisiveis(page: Page) {
  const textos = await linhas(page)
    .locator('[data-testid^="cto-port-number-"]')
    .allTextContents();
  return textos.map((t) => Number(t.trim()));
}

test("UX-01 · o card 'Clientes' NÃO existe mais na tela da caixa", async ({ page }) => {
  await login(page, ADMIN);
  await abrirCaixa(page);

  /*
    O dono removeu o bloco inteiro: ele repetia, no topo, números que a lista já
    carrega linha a linha, e no celular empurrava as portas para baixo da dobra.
  */
  await expect(page.getByTestId("cto-clients-summary")).toHaveCount(0);
  await expect(page.getByTestId("cto-clients-active")).toHaveCount(0);
  await expect(page.getByTestId("cto-clients-open-orders")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Clientes" })).toHaveCount(0);

  // E o que importava sobreviveu: as contagens estão nos filtros.
  await expect(page.getByTestId("cto-port-filter-online")).toHaveText("Online(4)");
  await expect(page.getByTestId("cto-port-filter-open_os")).toHaveText(
    "Com OS aberta(2)",
  );
});

test("UX-02/03 · 'Ocupada' e o estado do cliente ficam LADO A LADO, no desktop e no celular", async ({
  page,
}) => {
  await login(page, ADMIN);
  await abrirCaixa(page);

  /*
    A regra é de LEITURA: os dois selos são lidos juntos, então precisam estar
    na mesma faixa horizontal. Antes, a conectividade ficava numa terceira linha,
    debaixo do nome do cliente.

    A prova é geométrica, não estrutural: comparar o topo dos dois elementos
    pega o caso em que alguém os separa de novo mudando o layout sem mexer no
    JSX que o teste inspeciona.
  */
  for (const largura of [1280, 375]) {
    await page.setViewportSize({ width: largura, height: 900 });
    const ocupada = await page.getByTestId("cto-port-state-1").boundingBox();
    const estado = await page.getByTestId("cto-port-connectivity-1").boundingBox();
    expect(ocupada).not.toBeNull();
    expect(estado).not.toBeNull();
    // Mesma linha: a diferença de topo é menor que a altura de um selo.
    expect(Math.abs(ocupada!.y - estado!.y)).toBeLessThan(ocupada!.height);
    expect(estado!.x).toBeGreaterThan(ocupada!.x);
  }
});

test("UX-04/05 · 'Cadastro ativo' não é dito; 'Cadastro inativo' é", async ({ page }) => {
  await login(page, ADMIN);
  await abrirCaixa(page);

  // O normal não se anuncia: repetido em oito linhas, era só ruído.
  for (const n of [1, 2, 3, 4, 5, 6, 7]) {
    await expect(page.getByTestId(`cto-port-registration-${n}`)).toHaveCount(0);
  }
  await expect(linhas(page).first()).not.toContainText("Cadastro ativo");

  // A exceção, sim — o cabo continua no poste.
  await expect(page.getByTestId("cto-port-registration-8")).toHaveText(
    "Cadastro inativo",
  );
  // E ela convive com a conectividade: inativo e ONLINE ao mesmo tempo.
  await expect(page.getByTestId("cto-port-connectivity-8")).toHaveText(/Online/);
});

test("UX-06/07 · 'Online há 9 d' vem de statusSince; 'Verificado há 2 min' vem de observedAt", async ({
  page,
}) => {
  await login(page, ADMIN);
  await abrirCaixa(page);

  /*
    O TESTE DE CONFUSÃO DO TÉCNICO, na tela real.

    A porta 6 está online há nove dias e foi verificada há dois minutos. Se
    alguém voltar a derivar a duração de `observedAt`, esta linha passa a dizer
    "Online há 2 min" e o teste cai — que é exatamente o defeito que a
    verificação automática de 5 em 5 minutos introduziria em silêncio.
  */
  await expect(page.getByTestId("cto-port-reading-6")).toHaveText("Online há 9 d");
  await expect(page.getByTestId("cto-port-reading-6")).not.toContainText("há 2 min");
  await expect(page.getByTestId("cto-port-checked-6")).toHaveText("Verificado há 2 min");

  // O mesmo para o offline: duração e frescor são campos diferentes.
  await expect(page.getByTestId("cto-port-reading-2")).toHaveText("Offline há 18 min");
  await expect(page.getByTestId("cto-port-checked-2")).toHaveText(
    "Verificado há 18 min",
  );

  // Sem leitura nenhuma: nada de "há 0 min".
  await expect(page.getByTestId("cto-port-reading-3")).toHaveText(
    "Sem diagnóstico disponível",
  );
  await expect(page.getByTestId("cto-port-checked-3")).toHaveCount(0);
});

test("UX-08 · verificação atrasada aparece como AVISO, sem mudar o estado", async ({
  page,
}) => {
  await login(page, ADMIN);
  await abrirCaixa(page);

  // A porta 7 foi verificada há 37 min — mais que o dobro do alvo de 5.
  await expect(page.getByTestId("cto-port-stale-7")).toHaveText("Verificação atrasada");
  // O estado NÃO virou outra coisa: continua o último conhecido.
  await expect(page.getByTestId("cto-port-connectivity-7")).toHaveText(/Online/);
  await expect(page.getByTestId("cto-port-reading-7")).toHaveText("Online há 5 d");
  await expect(page.getByTestId("cto-port-checked-7")).toHaveText("Verificado há 37 min");

  // Quem foi verificado agora há pouco não recebe o aviso.
  await expect(page.getByTestId("cto-port-stale-1")).toHaveCount(0);
  await expect(page.getByTestId("cto-port-stale-6")).toHaveCount(0);
  // E "sem leitura" não é "atrasado": são coisas diferentes.
  await expect(page.getByTestId("cto-port-stale-3")).toHaveCount(0);
});

test("RC1D-CTO-03 · porta LIVRE não tem conectividade — nem 'Sem leitura'", async ({ page }) => {
  await login(page, ADMIN);
  await abrirCaixa(page);

  for (const n of [9, 10]) {
    await expect(page.getByTestId(`cto-port-state-${n}`)).toHaveText("Livre");
    await expect(page.getByTestId(`cto-port-client-${n}`)).toHaveCount(0);
    await expect(page.getByTestId(`cto-port-connectivity-${n}`)).toHaveCount(0);
    await expect(page.getByTestId(`cto-port-checked-${n}`)).toHaveCount(0);
  }
  const livre = linhas(page).filter({ has: page.getByTestId("cto-port-state-9") });
  await expect(livre).not.toContainText("Sem leitura");
});

test("RC1D-CTO-04 · filtros: Offline, Sem leitura, Livres, Com OS aberta — e Todas devolve tudo", async ({ page }) => {
  await login(page, ADMIN);
  await abrirCaixa(page);

  await expect(page.getByTestId("cto-port-filter-all")).toHaveText("Todas(10)");
  // O INATIVO da porta 8 está online e NÃO entra: filtro de cliente conta
  // cliente de cadastro ativo, que é a mesma unidade do popup do mapa.
  await expect(page.getByTestId("cto-port-filter-online")).toHaveText("Online(4)");
  await expect(page.getByTestId("cto-port-filter-offline")).toHaveText("Offline(2)");
  await expect(page.getByTestId("cto-port-filter-unknown")).toHaveText("Sem leitura(1)");
  await expect(page.getByTestId("cto-port-filter-free")).toHaveText("Livres(2)");
  await expect(page.getByTestId("cto-port-filter-open_os")).toHaveText("Com OS aberta(2)");

  await page.getByTestId("cto-port-filter-offline").click();
  await expect(page.getByTestId("cto-port-filter-offline")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("cto-port-filter-all")).toHaveAttribute("aria-pressed", "false");
  expect(await portasVisiveis(page)).toEqual([2, 5]);
  await expect(page.getByTestId("cto-port-filter-status")).toHaveText(
    "Mostrando 2 de 10 portas — Offline.",
  );

  await page.getByTestId("cto-port-filter-unknown").click();
  expect(await portasVisiveis(page)).toEqual([3]);

  await page.getByTestId("cto-port-filter-online").click();
  expect(await portasVisiveis(page)).toEqual([1, 4, 6, 7]);

  await page.getByTestId("cto-port-filter-open_os").click();
  expect(await portasVisiveis(page)).toEqual([4, 5]);

  await page.getByTestId("cto-port-filter-free").click();
  expect(await portasVisiveis(page)).toEqual([9, 10]);
  await expect(page.getByTestId("cto-port-filters").locator("..")).not.toContainText("Sem leitura disponível");

  await page.getByTestId("cto-port-filter-all").click();
  expect(await portasVisiveis(page)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
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
  /*
    O card saiu, e a consistência com o popup continua sendo afirmada — agora
    sobre as contagens que a tela REALMENTE mostra: as dos filtros. Se elas e o
    popup divergirem, a caixa passa a dizer duas coisas sobre os mesmos
    clientes, que é o defeito que a fase existe para impedir.
  */
  const soNumero = async (testId: string) => {
    const texto = await page.getByTestId(testId).innerText();
    return texto.match(/\((\d+)\)/)?.[1] ?? `sem numero em "${texto}"`;
  };
  const detalhe = {
    online: await soNumero("cto-port-filter-online"),
    offline: await soNumero("cto-port-filter-offline"),
    semLeitura: await soNumero("cto-port-filter-unknown"),
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
    online: numero("Online"),
    offline: numero("Offline"),
    semLeitura: numero("Sem leitura"),
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
  await expect(page.getByTestId("cto-port-filter-online")).toHaveText("Online(4)");
  await expect(page.getByTestId("cto-port-reading-2")).toHaveText(/Offline há 1[89] min/);
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
  await expect(page.getByTestId("cto-port-filters")).toHaveCount(0);
  expect(new URL(page.url()).pathname).not.toBe(`/ctos/${ctoId}`);
});

test("RC1D-CTO-11 · a caixa de outra empresa não abre, mesmo com o id conhecido", async ({ page }) => {
  await login(page, OUTRO_ADMIN);
  const resposta = await page.goto(`/ctos/${ctoId}`);
  expect(resposta?.status()).toBe(404);
  await expect(page.getByTestId("cto-port-filters")).toHaveCount(0);
  await expect(page.getByText("QA RC1D ONLINE")).toHaveCount(0);

  // E a própria caixa dela abre, sem cliente nenhum.
  await page.goto(`/ctos/${ctoAlheiaId}`);
  await expect(page.getByTestId("cto-port-filter-online")).toHaveText("Online(0)");
  await expect(page.getByTestId("cto-port-filter-occupied")).toHaveText("Ocupadas(0)");
});
