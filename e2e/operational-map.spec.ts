import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { assertTestDatabase } from "./test-db-guard";

/**
 * # `CTO-3.2` — o Mapa Operacional num navegador de verdade
 *
 * Este spec existe porque **`jsdom` não tem layout**. O Leaflet mede o
 * contêiner para decidir quantos tiles pedir e onde pôr cada marcador; sem
 * layout ele "monta" e não desenha nada, e um teste de componente afirmando que
 * o mapa apareceu passaria com o mapa invisível.
 *
 * É a mesma lição da `CTO-1.8`: 129 testes verdes conviviam com uma foto que
 * não abria, porque todos afirmavam presença e atributo, e nenhum afirmava que
 * a imagem tinha dimensão depois de decodificada. Aqui a asserção equivalente é
 * o contêiner ter altura real e os marcadores existirem no DOM do Leaflet.
 *
 * ## Nenhum tile sai desta máquina
 *
 * Toda requisição ao provedor é interceptada e respondida com um PNG local. O
 * spec precisa passar com `tile.openstreetmap.org` fora do ar — e, mais que
 * isso, uma suíte que baixa tiles públicos a cada execução é exatamente o uso
 * que a política do OSM recusa.
 */

const ADMIN_EMAIL = "admin@alfatelecom.local";
const DISPATCHER_EMAIL = "dispatcher@alfatelecom.local";
const TECHNICIAN_EMAIL = "tech@alfatelecom.local";
const PASSWORD = "AlfaOS@2026";

const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgresql://alfaos:alfaos_dev_password@localhost:5432/alfaos_test?schema=public";

const prisma = new PrismaClient({
  datasources: { db: { url: E2E_DATABASE_URL } },
});

/** Faixa fictícia do Atlântico sul, a mesma da `CTO-3.1`. */
const BASE = { latitude: -20.5, longitude: -41.5 };

/** PNG 1×1 transparente — o tile local que substitui o provedor. */
const TILE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

let companyId = "";
const criadas: string[] = [];
let clienteId = "";

async function criarCto(
  nome: string,
  opcoes: {
    capacity?: number;
    latitude?: number | null;
    longitude?: number | null;
    active?: boolean;
    code?: string | null;
  } = {},
) {
  const capacity = opcoes.capacity ?? 8;
  const cto = await prisma.cTO.create({
    data: {
      companyId,
      name: nome,
      code: opcoes.code ?? null,
      capacity,
      latitude: opcoes.latitude === undefined ? BASE.latitude : opcoes.latitude,
      longitude:
        opcoes.longitude === undefined ? BASE.longitude : opcoes.longitude,
      active: opcoes.active ?? true,
      ports: {
        create: Array.from({ length: capacity }, (_, i) => ({
          companyId,
          number: i + 1,
        })),
      },
    },
  });
  criadas.push(cto.id);
  return cto;
}

test.beforeAll(async () => {
  await assertTestDatabase(E2E_DATABASE_URL, "E2E_DATABASE_URL");

  const admin = await prisma.user.findUniqueOrThrow({
    where: { email: ADMIN_EMAIL },
  });
  companyId = admin.companyId;

  await prisma.company.update({
    where: { id: companyId },
    data: { ctoNetworkEnabled: true },
  });

  /*
    Quatro caixas, uma por estado derivado — porque o mapa precisa provar que
    traduz os QUATRO, e não só o feliz. As coordenadas são próximas para caberem
    no mesmo enquadramento inicial.
  */
  await criarCto("MAPA QA DISPONIVEL", {
    code: "MQA-01",
    latitude: BASE.latitude,
    longitude: BASE.longitude,
  });

  const comDefeito = await criarCto("MAPA QA DEFEITO", {
    latitude: BASE.latitude + 0.004,
    longitude: BASE.longitude + 0.004,
  });
  await prisma.cTOPort.updateMany({
    where: { ctoId: comDefeito.id, number: 3 },
    data: { administrativeState: "DAMAGED" },
  });

  await criarCto("MAPA QA INATIVA", {
    active: false,
    latitude: BASE.latitude - 0.004,
    longitude: BASE.longitude - 0.004,
  });

  // `FULL`: capacidade 1, com a única porta ocupada por um vínculo ativo. A
  // ocupação continua DERIVADA do vínculo — nenhuma coluna de estado é escrita.
  const lotada = await criarCto("MAPA QA LOTADA", {
    capacity: 1,
    latitude: BASE.latitude + 0.004,
    longitude: BASE.longitude - 0.004,
  });
  const cliente = await prisma.customer.create({
    data: { companyId, name: "CLIENTE-MAPA-QA-NAO-EXIBIR" },
  });
  clienteId = cliente.id;
  const porta = await prisma.cTOPort.findFirstOrThrow({
    where: { ctoId: lotada.id, number: 1 },
  });
  await prisma.customerNetworkConnection.create({
    data: {
      companyId,
      customerId: cliente.id,
      ctoPortId: porta.id,
      source: "WEB",
      connectedAt: new Date(),
    },
  });

  // Sem coordenada: nunca vira marcador, e é contada à parte.
  await criarCto("MAPA QA SEM GPS", { latitude: null, longitude: null });
});

test.afterAll(async () => {
  /*
    Limpeza por ESCOPO, e na ordem das FKs.

    A `DQ-4` custou três testes de outros arquivos porque um spec deixou dado
    para trás. Aqui só sai o que este spec criou, e o vínculo precisa sair antes
    da porta, que precisa sair antes da caixa.
  */
  if (criadas.length > 0) {
    await prisma.customerNetworkConnection.deleteMany({
      where: { ctoPort: { ctoId: { in: criadas } } },
    });
    await prisma.cTOPort.deleteMany({ where: { ctoId: { in: criadas } } });
    await prisma.cTO.deleteMany({ where: { id: { in: criadas } } });
  }
  if (clienteId) {
    await prisma.customer.deleteMany({ where: { id: clienteId } });
  }
  await prisma.company.update({
    where: { id: companyId },
    data: { ctoNetworkEnabled: false },
  });
  await prisma.$disconnect();
});

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Senha").fill(PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

/**
 * Serve os tiles localmente: a suíte não depende da internet.
 *
 * **Os TRÊS provedores**, desde a `CTO-3.2.1`. Interceptar só o OSM faria o
 * teste de satélite depender do Esri estar no ar — e um spec que fica vermelho
 * porque um provedor de terceiro teve um mau dia ensina a ignorar o vermelho.
 *
 * O padrão casa por caminho, e não só por host: assim ele continua valendo se
 * alguém apontar `MAP_TILE_SATELLITE_URL` para outro lugar no ambiente de
 * teste.
 */
async function interceptarTiles(page: Page) {
  const provedores = [
    /tile\.openstreetmap\.org/,
    /server\.arcgisonline\.com/,
    /basemaps\.cartocdn\.com/,
  ];
  for (const padrao of provedores) {
    await page.route(padrao, (route) =>
      route.fulfill({ status: 200, contentType: "image/png", body: TILE_PNG }),
    );
  }
}

/** Quantos tiles de cada provedor o navegador pediu. */
function contarTiles(page: Page) {
  const contagem = { normal: 0, satellite: 0, labels: 0 };
  page.on("request", (r) => {
    const url = r.url();
    if (url.includes("tile.openstreetmap.org")) contagem.normal += 1;
    else if (url.includes("arcgisonline.com")) contagem.satellite += 1;
    else if (url.includes("cartocdn.com")) contagem.labels += 1;
  });
  return contagem;
}

/** Coleta erros de página e de console para as asserções de "sem erro". */
function coletarErros(page: Page) {
  const erros: string[] = [];
  page.on("pageerror", (e) => erros.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") erros.push(`console: ${m.text()}`);
  });
  return erros;
}

async function abrirMapa(page: Page) {
  await interceptarTiles(page);
  await page.goto("/mapa");
  await expect(page.getByRole("heading", { name: "Mapa Operacional" })).toBeVisible();
  // O Leaflet montou de verdade quando o contêiner dele existe no DOM.
  await expect(page.locator(".leaflet-container")).toBeVisible();
  // E os marcadores só aparecem depois da primeira leitura do recorte.
  await expect(page.locator(".leaflet-marker-icon").first()).toBeVisible({
    timeout: 15_000,
  });
}

// ---------------------------------------------------------------------------

test.describe("Mapa Operacional — CTO-3.2", () => {
  test("UI-MAP-01 · a página abre, o mapa monta e não há erro de Leaflet/SSR", async ({
    page,
  }) => {
    const erros = coletarErros(page);
    await login(page, ADMIN_EMAIL);
    await abrirMapa(page);

    /*
      "Monta" precisa ser mais que "o elemento existe".

      Um contêiner de altura zero satisfaz `toBeVisible` em vários casos e não
      desenha mapa nenhum — é o modo de falha nº 1 do Leaflet, e o motivo de a
      altura ser explícita no CSS.
    */
    const caixa = await page.locator(".leaflet-container").boundingBox();
    expect(caixa?.height ?? 0).toBeGreaterThan(300);
    expect(caixa?.width ?? 0).toBeGreaterThan(300);

    // Os tiles foram pedidos e desenhados — com o provedor interceptado.
    await expect(page.locator(".leaflet-tile").first()).toBeVisible();

    expect(
      erros.filter((e) => /leaflet|window is not defined|hydrat/i.test(e)),
    ).toEqual([]);
    expect(erros).toEqual([]);
  });

  test("UI-MAP-02 · TECHNICIAN não acessa /mapa nem vê o item no menu", async ({
    page,
  }) => {
    await login(page, TECHNICIAN_EMAIL);

    await expect(
      page.getByRole("link", { name: "Mapa Operacional" }),
    ).toHaveCount(0);

    // Mesmo digitando a URL.
    await page.goto("/mapa");
    await expect(page).toHaveURL(/\/minhas-os/);
  });

  test("UI-MAP-03 · capability desligada: a rota some do menu e responde 404", async ({
    page,
  }) => {
    await prisma.company.update({
      where: { id: companyId },
      data: { ctoNetworkEnabled: false },
    });
    try {
      await login(page, ADMIN_EMAIL);
      await expect(
        page.getByRole("link", { name: "Mapa Operacional" }),
      ).toHaveCount(0);

      const resposta = await page.goto("/mapa");
      expect(resposta?.status()).toBe(404);
    } finally {
      await prisma.company.update({
        where: { id: companyId },
        data: { ctoNetworkEnabled: true },
      });
    }
  });

  test("UI-MAP-04/05 · o bbox vai ao backend, e arrastar não pede por pixel", async ({
    page,
  }) => {
    const pedidos: URL[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/api/ctos/map?")) pedidos.push(new URL(r.url()));
    });

    await login(page, ADMIN_EMAIL);
    await abrirMapa(page);

    // UI-MAP-04: os quatro lados viajam na query.
    expect(pedidos.length).toBeGreaterThan(0);
    for (const lado of ["north", "south", "east", "west"]) {
      const valor = pedidos[0].searchParams.get(lado);
      expect(valor, `falta ${lado}`).not.toBeNull();
      expect(Number.isFinite(Number(valor))).toBe(true);
    }

    const antes = pedidos.length;

    /*
      UI-MAP-05: um arrasto com MUITOS passos intermediários.

      Cada `mouse.move` produz um evento `move` do Leaflet. Se a leitura
      estivesse presa a `move` em vez de `moveend`, seriam dezenas de
      requisições — a "requisição por pixel" que o contrato proíbe.
    */
    const caixa = await page.locator(".leaflet-container").boundingBox();
    const cx = (caixa?.x ?? 0) + (caixa?.width ?? 0) / 2;
    const cy = (caixa?.y ?? 0) + (caixa?.height ?? 0) / 2;

    await page.mouse.move(cx, cy);
    await page.mouse.down();
    for (let i = 1; i <= 30; i += 1) {
      await page.mouse.move(cx - i * 3, cy - i * 2);
    }
    await page.mouse.up();

    await page.waitForTimeout(1500);

    const durante = pedidos.length - antes;
    expect(durante).toBeGreaterThan(0); // o arrasto PRECISA reler
    expect(durante).toBeLessThanOrEqual(2); // e não uma vez por passo
  });

  test("UI-MAP-06 · resposta atrasada não sobrescreve a mais nova", async ({
    page,
  }) => {
    await login(page, ADMIN_EMAIL);
    await interceptarTiles(page);

    let chamada = 0;
    await page.route("**/api/ctos/map?**", async (route) => {
      chamada += 1;
      const atual = chamada;
      const nome = atual === 1 ? "VELHA-NAO-DEVE-APARECER" : "NOVA-CORRETA";
      // A primeira resposta demora MUITO mais que a segunda — que é
      // exatamente o caso real: o bairro com duzentas caixas contra o com três.
      await new Promise((r) => setTimeout(r, atual === 1 ? 2500 : 50));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          data: {
            map: {
              markers: [
                {
                  id: `id-${atual}`,
                  name: nome,
                  code: null,
                  latitude: BASE.latitude,
                  longitude: BASE.longitude,
                  active: true,
                  status: "AVAILABLE",
                  summary: {
                    capacity: 8,
                    free: 8,
                    occupied: 0,
                    reserved: 0,
                    damaged: 0,
                    historical: 0,
                  },
                  // A `CTO-3.2.2` acrescentou o resumo operacional ao DTO, e o
                  // marcador o lê sem guarda — é contrato de servidor, não
                  // entrada de usuário. Um payload de teste sem ele derruba a
                  // camada inteira, e foi assim que este teste quebrou.
                  operational: {
                    activeCustomerCount: 0,
                    onlineCount: 0,
                    offlineCount: 0,
                    unknownCount: 0,
                    openServiceOrderCount: 0,
                  },
                },
              ],
              truncated: false,
              limit: 200,
              missingLocationCount: 0,
            },
          },
        }),
      });
    });

    /*
      A PRIMEIRA versão deste teste passava pelo motivo errado, e a lição é a
      mesma das corridas da `CTO-2.6`: a ordem perigosa nunca acontecia.

      O arrasto era disparado assim que o contêiner ficava visível — antes de o
      atraso de 350 ms vencer. O `handleViewport` do arrasto substituía o
      temporizador pendente, e existia UMA requisição em vez de duas. O teste
      então observava a resposta lenta como se fosse a única, e acusava um
      defeito que não existia.

      Agora a segunda leitura só é provocada depois de a primeira estar
      COMPROVADAMENTE em voo.
    */
    const primeiraEmVoo = page.waitForRequest((r) =>
      r.url().includes("/api/ctos/map?"),
    );

    await page.goto("/mapa");
    await expect(page.locator(".leaflet-container")).toBeVisible();
    await primeiraEmVoo;

    const caixa = await page.locator(".leaflet-container").boundingBox();
    const cx = (caixa?.x ?? 0) + (caixa?.width ?? 0) / 2;
    const cy = (caixa?.y ?? 0) + (caixa?.height ?? 0) / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    for (let i = 1; i <= 10; i += 1) {
      await page.mouse.move(cx - i * 8, cy - i * 5);
    }
    await page.mouse.up();

    // Duas leituras saíram, e a lenta responde bem depois da rápida.
    await expect.poll(() => chamada, { timeout: 15_000 }).toBeGreaterThan(1);
    await page.waitForTimeout(4000);

    await page.locator(".leaflet-marker-icon").first().click();
    await expect(page.getByTestId("cto-map-popup")).toContainText(
      "NOVA-CORRETA",
    );
    await expect(page.getByTestId("cto-map-popup")).not.toContainText(
      "VELHA-NAO-DEVE-APARECER",
    );
  });

  test("UI-MAP-07..11 · os quatro estados aparecem, e não só por cor", async ({
    page,
  }) => {
    await login(page, ADMIN_EMAIL);
    await abrirMapa(page);

    /*
      Desde a `CTO-3.2.1` o marcador é a CAIXA, e o selo é que muda por estado.
      A silhueta é idêntica nos quatro — é a identidade da CTO —, então o que se
      conta aqui é um marcador de cada tom, mais o desenho da caixa em todos.
    */
    await expect(page.locator(".leaflet-marker-pane svg.cto-box")).toHaveCount(4);
    await expect(page.locator(".leaflet-marker-pane svg.cto-box .cto-box__body")).toHaveCount(4);
    for (const tom of ["success", "warning", "danger", "neutral"]) {
      await expect(page.locator(`svg.cto-box--${tom}`)).toHaveCount(1);
    }

    // O selo carrega GLIFO, e não só cor: quatro glifos distintos na tela.
    const glifos = await page.locator(".leaflet-marker-pane svg.cto-box .cto-box__glyph").allTextContents();
    expect(new Set(glifos).size).toBe(4);

    // A legenda continua explicando cada selo por forma, glifo e rótulo.
    await expect(page.locator(".cto-marker--circle")).toHaveCount(1);
    await expect(page.locator(".cto-marker--triangle")).toHaveCount(1);
    await expect(page.locator(".cto-marker--square")).toHaveCount(1);
    await expect(page.locator(".cto-marker--diamond")).toHaveCount(1);

    // E o estado está escrito em TEXTO na página, com todos os popups fechados.
    const legenda = page.getByTestId("map-legend");
    await expect(legenda).toContainText("Com vaga");
    await expect(legenda).toContainText("Sem vaga");
    await expect(legenda).toContainText("Com defeito");
    await expect(legenda).toContainText("Inativa");
  });

  test("UI-MAP-12/13/14 · popup mostra o resumo, não vaza cliente, e abre a CTO", async ({
    page,
  }) => {
    await login(page, ADMIN_EMAIL);
    await abrirMapa(page);

    const marcador = page
      .locator(".leaflet-marker-icon")
      .filter({ has: page.locator(".cto-box--success") })
      .first();
    await marcador.click();

    const popup = page.getByTestId("cto-map-popup");
    await expect(popup).toBeVisible();

    // UI-MAP-12: o resumo mínimo.
    await expect(popup).toContainText("MAPA QA DISPONIVEL");
    await expect(popup).toContainText("MQA-01");
    await expect(popup).toContainText("Capacidade");
    await expect(popup).toContainText("Livres");
    await expect(popup).toContainText("Ocupadas");
    await expect(popup).toContainText("Reservadas");
    await expect(popup).toContainText("Danificadas");
    await expect(page.getByTestId("cto-map-popup-status")).toContainText(
      "Com vaga",
    );
    await expect(page.getByTestId("cto-map-popup-free")).toHaveText("8");

    // UI-MAP-13: nada de cliente, vínculo ou identificador interno na tela.
    const texto = (await popup.innerText()).toLowerCase();
    expect(texto).not.toContain("cliente-mapa-qa");
    expect(texto).not.toContain("companyid");
    expect(texto).not.toContain(companyId.toLowerCase());
    expect(texto).not.toContain(clienteId.toLowerCase());

    // UI-MAP-14: "Abrir CTO" leva ao detalhe que já existe.
    await page.getByTestId("cto-map-popup-open").click();
    // A `href` agora carrega a vista de volta (`CTO-3.2.1`), então o caminho
    // não termina no id — ele é seguido da query que reconstrói o mapa.
    await expect(page).toHaveURL(/\/ctos\/[a-z0-9]+\?/);
    await expect(
      page.getByRole("heading", { name: "MAPA QA DISPONIVEL" }),
    ).toBeVisible();
  });

  test("UI-MAP-15/16 · CTO sem coordenada é contada e NÃO vira marcador", async ({
    page,
  }) => {
    await login(page, ADMIN_EMAIL);
    await abrirMapa(page);

    // UI-MAP-15: o contador existe e nomeia o motivo.
    await expect(page.getByTestId("map-missing-location")).toContainText(
      "sem localização",
    );

    // UI-MAP-16: quatro caixas localizadas → quatro marcadores. A quinta, sem
    // coordenada, não está entre eles — e não existe marcador em 0,0.
    await expect(page.locator(".leaflet-marker-icon")).toHaveCount(4);

    const nomes: string[] = [];
    for (const marcador of await page.locator(".leaflet-marker-icon").all()) {
      nomes.push((await marcador.getAttribute("title")) ?? "");
    }
    expect(nomes.join(" | ")).not.toContain("SEM GPS");
  });

  test("UI-MAP-17 · recorte truncado pede aproximação", async ({ page }) => {
    await login(page, ADMIN_EMAIL);
    await interceptarTiles(page);

    await page.route("**/api/ctos/map?**", async (route) => {
      const resposta = await route.fetch();
      const corpo = await resposta.json();
      // Só o sinal é forçado: os marcadores continuam sendo os reais.
      corpo.data.map.truncated = true;
      corpo.data.map.limit = 200;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(corpo),
      });
    });

    await page.goto("/mapa");
    await expect(page.getByTestId("map-truncated")).toContainText(
      "Aproxime o mapa",
    );
    await expect(page.getByTestId("map-truncated")).toContainText("200");
  });

  test("UI-MAP-18 · falha da API é DISTINTA de área sem CTO", async ({
    page,
  }) => {
    await login(page, ADMIN_EMAIL);
    await interceptarTiles(page);

    await page.route("**/api/ctos/map?**", (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: "Erro interno." }),
      }),
    );

    await page.goto("/mapa");

    const erro = page.getByTestId("map-error");
    await expect(erro).toBeVisible();
    await expect(erro).toContainText("Isto não significa que não existam");

    /*
      A parte que importa: a falha NÃO pode ser lida como "não há caixas aqui".

      Sem esta asserção, um mapa vazio com uma mensagem discreta passaria — e é
      exatamente assim que o despachante concluiria que o bairro não tem
      infraestrutura.
    */
    await expect(page.getByTestId("map-marker-count")).toHaveCount(0);
    await expect(page.getByTestId("map-count-unavailable")).toContainText(
      "Contagem indisponível",
    );

    // E a mensagem não vaza detalhe interno.
    const texto = (await erro.innerText()).toLowerCase();
    for (const proibido of ["prisma", "select", "at ", "stack", "postgres"]) {
      expect(texto).not.toContain(proibido);
    }

    // Tentar novamente existe, e funciona quando a API volta.
    await page.unroute("**/api/ctos/map?**");
    await page.getByRole("button", { name: "Tentar novamente" }).click();
    await expect(page.getByTestId("map-error")).toHaveCount(0);
    await expect(page.locator(".leaflet-marker-icon").first()).toBeVisible();
  });

  test("UI-MAP-18b · área realmente vazia diz zero, sem overlay de erro", async ({
    page,
  }) => {
    await login(page, ADMIN_EMAIL);
    await interceptarTiles(page);

    /*
      O contraste com o teste anterior é o ponto INTEIRO desta dupla.

      Aqui a API responde 200 com lista vazia — que é o que uma região sem
      caixas produz. A tela precisa dizer "0 CTOs nesta área" e NÃO mostrar
      erro. No teste acima ela responde 500, e a tela precisa cobrir o mapa.
      Se os dois desfechos tivessem a mesma aparência, o despachante concluiria
      que o bairro não tem infraestrutura sempre que a API caísse.
    */
    await page.route("**/api/ctos/map?**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          data: {
            map: { markers: [], truncated: false, limit: 200, missingLocationCount: 0 },
          },
        }),
      }),
    );

    await page.goto("/mapa");
    await expect(page.locator(".leaflet-container")).toBeVisible();

    await expect(page.getByTestId("map-marker-count")).toContainText(
      "0 CTOs nesta área",
      { timeout: 15_000 },
    );
    await expect(page.getByTestId("map-error")).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// Busca
// ---------------------------------------------------------------------------

test.describe("Mapa Operacional — busca", () => {
  test("SEARCH-05 · achar pelo nome recentraliza o mapa naquela caixa", async ({
    page,
  }) => {
    const recortes: URL[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/api/ctos/map?")) recortes.push(new URL(r.url()));
    });

    await login(page, ADMIN_EMAIL);
    await abrirMapa(page);

    await page.getByTestId("cto-map-search-input").fill("MAPA QA LOTADA");

    const resultado = page.getByTestId("cto-map-search-hit").first();
    await expect(resultado).toContainText("MAPA QA LOTADA", {
      timeout: 15_000,
    });

    const antes = recortes.length;
    await resultado.getByTestId("cto-map-search-hit-focus").click();

    // Recentralizar dispara uma leitura NOVA do recorte, e o retângulo dela
    // contém a coordenada da caixa procurada.
    await expect
      .poll(() => recortes.length, { timeout: 15_000 })
      .toBeGreaterThan(antes);

    const ultimo = recortes[recortes.length - 1];
    const alvoLat = BASE.latitude + 0.004;
    const alvoLng = BASE.longitude - 0.004;
    expect(Number(ultimo.searchParams.get("south"))).toBeLessThanOrEqual(alvoLat);
    expect(Number(ultimo.searchParams.get("north"))).toBeGreaterThanOrEqual(alvoLat);
    expect(Number(ultimo.searchParams.get("west"))).toBeLessThanOrEqual(alvoLng);
    expect(Number(ultimo.searchParams.get("east"))).toBeGreaterThanOrEqual(alvoLng);
  });

  test("SEARCH-02 · achar pelo código funciona igual", async ({ page }) => {
    await login(page, ADMIN_EMAIL);
    await abrirMapa(page);

    await page.getByTestId("cto-map-search-input").fill("MQA-01");

    await expect(page.getByTestId("cto-map-search-hit")).toHaveCount(1, {
      timeout: 15_000,
    });
    await expect(page.getByTestId("cto-map-search-hit")).toContainText(
      "MAPA QA DISPONIVEL",
    );
  });

  test("SEARCH-06 · CTO sem coordenada é achável e NÃO oferece centralizar", async ({
    page,
  }) => {
    await login(page, ADMIN_EMAIL);
    await abrirMapa(page);

    await page.getByTestId("cto-map-search-input").fill("MAPA QA SEM GPS");

    const linha = page.getByTestId("cto-map-search-hit").first();
    await expect(linha).toContainText("MAPA QA SEM GPS", { timeout: 15_000 });

    // Aparece marcada como sem localização, e sem o botão que mentiria.
    await expect(
      linha.getByTestId("cto-map-search-hit-unlocated"),
    ).toBeVisible();
    await expect(linha.getByTestId("cto-map-search-hit-focus")).toHaveCount(0);

    // E continua oferecendo o que ela realmente tem.
    await expect(linha.getByRole("link", { name: "Abrir CTO" })).toBeVisible();
  });

  test("SEARCH-04 · termo curto não consulta, e sem resultado diz isso", async ({
    page,
  }) => {
    const buscas: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/api/ctos/map/search")) buscas.push(r.url());
    });

    await login(page, ADMIN_EMAIL);
    await abrirMapa(page);

    const campo = page.getByTestId("cto-map-search-input");
    await campo.fill("M");
    await page.waitForTimeout(900);
    expect(buscas).toEqual([]);

    await campo.fill("ZZZ-NAO-EXISTE-NENHUMA");
    await expect(
      page.getByTestId("cto-map-search-results"),
    ).toContainText("Nada encontrado com esse nome, código ou número de OS", { timeout: 15_000 });
  });

  test("SEARCH-03 · o DISPATCHER lê o mapa, sem ganhar o detalhe da CTO", async ({
    page,
  }) => {
    await login(page, DISPATCHER_EMAIL);
    await interceptarTiles(page);

    await page.getByRole("link", { name: "Mapa Operacional" }).click();
    await expect(page.locator(".leaflet-marker-icon").first()).toBeVisible({
      timeout: 15_000,
    });

    await page.getByTestId("cto-map-search-input").fill("MAPA QA DISPONIVEL");
    await expect(page.getByTestId("cto-map-search-hit").first()).toContainText(
      "MAPA QA DISPONIVEL",
      { timeout: 15_000 },
    );

    /*
      `/ctos/[id]` é de ADMIN, e continua sendo. Oferecer o botão ao DISPATCHER
      o levaria a um redirecionamento sem explicação — pior que não oferecer.
      Quem barra continua sendo a página, não esta ausência.
    */
    await expect(
      page.getByTestId("cto-map-search-hit").first().getByRole("link", {
        name: "Abrir CTO",
      }),
    ).toHaveCount(0);

    await page.locator(".leaflet-marker-icon").first().click();
    await expect(page.getByTestId("cto-map-popup")).toBeVisible();
    await expect(page.getByTestId("cto-map-popup-open")).toHaveCount(0);

    // E o servidor é quem realmente barra.
    const resposta = await page.goto(`/ctos/${criadas[0]}`);
    expect(resposta?.url()).not.toContain("/ctos/");
  });
});

// ---------------------------------------------------------------------------
// Responsividade
// ---------------------------------------------------------------------------

test.describe("Mapa Operacional — responsividade", () => {
  for (const viewport of [
    { nome: "tablet", width: 768, height: 1024 },
    { nome: "desktop", width: 1440, height: 900 },
  ]) {
    test(`o mapa tem altura real em ${viewport.nome}`, async ({ page }) => {
      await page.setViewportSize({
        width: viewport.width,
        height: viewport.height,
      });
      await login(page, ADMIN_EMAIL);
      await abrirMapa(page);

      const caixa = await page.locator(".leaflet-container").boundingBox();
      expect(caixa?.height ?? 0).toBeGreaterThan(300);
      expect(caixa?.width ?? 0).toBeGreaterThan(300);

      // E a página não rola na horizontal por causa do mapa.
      const larguraDocumento = await page.evaluate(
        () => document.documentElement.scrollWidth,
      );
      expect(larguraDocumento).toBeLessThanOrEqual(viewport.width + 1);
    });
  }
});

// ---------------------------------------------------------------------------
// CTO-3.2.1 — bases de mapa e navegação de volta
// ---------------------------------------------------------------------------

/** A vista que está na barra de endereço agora. */
function vistaDaUrl(page: Page) {
  return new URL(page.url()).searchParams;
}

test.describe("Mapa Operacional — bases NORMAL/SATELLITE/HYBRID", () => {
  test("MAPUX-01/02/03 · as três bases pedem tiles dos provedores certos", async ({
    page,
  }) => {
    const tiles = contarTiles(page);
    const erros = coletarErros(page);

    await login(page, ADMIN_EMAIL);
    await abrirMapa(page);

    // O controle existe e oferece exatamente os três modos configurados.
    await expect(page.getByTestId("map-mode-control")).toBeVisible();
    await expect(page.getByTestId("map-mode-normal")).toBeVisible();
    await expect(page.getByTestId("map-mode-satellite")).toBeVisible();
    await expect(page.getByTestId("map-mode-hybrid")).toBeVisible();

    // MAPUX-01: o padrão é NORMAL, e só ele pediu tile.
    await expect(page.getByTestId("map-mode-normal")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(tiles.normal).toBeGreaterThan(0);
    expect(tiles.satellite).toBe(0);
    expect(tiles.labels).toBe(0);

    // MAPUX-02: satélite troca a BASE, e é o provedor de imagem que responde.
    await page.getByTestId("map-mode-satellite").click();
    await expect
      .poll(() => tiles.satellite, { timeout: 15000 })
      .toBeGreaterThan(0);
    expect(tiles.labels).toBe(0);
    await expect(page.getByTestId("map-mode-satellite")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByTestId("map-mode-normal")).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    // MAPUX-03: híbrido monta as DUAS camadas sobre o mesmo mapa.
    await page.getByTestId("map-mode-hybrid").click();
    await expect.poll(() => tiles.labels, { timeout: 15000 }).toBeGreaterThan(0);

    /*
      UM mapa, e não três.

      Se cada modo remontasse o MapContainer, existiriam contêineres novos a
      cada clique — e centro e zoom se perderiam junto. Um só prova que a troca
      é de camada.
    */
    await expect(page.locator(".leaflet-container")).toHaveCount(1);
    // Os marcadores sobrevivem à troca de base: eles não são da camada de tile.
    await expect(page.locator(".leaflet-marker-pane svg.cto-box")).toHaveCount(4);

    expect(erros).toEqual([]);
  });

  test("MAPUX-04 · a base escolhida sobrevive a recarregar a página", async ({
    page,
  }) => {
    await login(page, ADMIN_EMAIL);
    await abrirMapa(page);

    await page.getByTestId("map-mode-hybrid").click();
    await expect(page.getByTestId("map-mode-hybrid")).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    /*
      Entra pela porta SEM query: é o caso do técnico que abre o mapa pelo menu
      no dia seguinte. Só a preferência guardada no aparelho pode responder.
    */
    await page.goto("/mapa");
    await expect(page.locator(".leaflet-container")).toBeVisible();
    await expect(page.getByTestId("map-mode-hybrid")).toHaveAttribute(
      "aria-pressed",
      "true",
      { timeout: 10000 },
    );
  });

  test("MAPUX-04b · a URL VENCE a preferência guardada", async ({ page }) => {
    await login(page, ADMIN_EMAIL);
    await abrirMapa(page);

    await page.getByTestId("map-mode-hybrid").click();
    await expect(page.getByTestId("map-mode-hybrid")).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // Um link explícito pede outra base — e é uma escolha para AQUELA vista.
    await page.goto("/mapa?mode=SATELLITE");
    await expect(page.getByTestId("map-mode-satellite")).toHaveAttribute(
      "aria-pressed",
      "true",
      { timeout: 10000 },
    );
  });

  test("MAPUX-06 · a CSP libera os três hosts, e nenhum curinga", async ({
    page,
  }) => {
    await login(page, ADMIN_EMAIL);
    const resposta = await page.goto("/mapa");
    const csp = resposta?.headers()["content-security-policy"] ?? "";

    const imgSrc =
      csp.split(";").find((p) => p.trim().startsWith("img-src")) ?? "";

    expect(imgSrc).toContain("https://tile.openstreetmap.org");
    expect(imgSrc).toContain("https://server.arcgisonline.com");
    expect(imgSrc).toContain("https://*.basemaps.cartocdn.com");
    // Curinga global tornaria a política decorativa.
    expect(imgSrc.split(/\s+/)).not.toContain("*");
  });

  test("MAPUX-06b · nenhum tile é bloqueado pela política, nos três modos", async ({
    page,
  }) => {
    /*
      A violação de CSP NÃO quebra a página: ela apaga a imagem. Foi assim que
      a CTO-3.2 quase entregou um mapa cinza. Aqui o console é a testemunha.
    */
    const violacoes: string[] = [];
    page.on("console", (m) => {
      if (/content security policy|refused to load/i.test(m.text())) {
        violacoes.push(m.text());
      }
    });

    await login(page, ADMIN_EMAIL);
    await abrirMapa(page);

    for (const modo of ["satellite", "hybrid", "normal"]) {
      await page.getByTestId("map-mode-" + modo).click();
      await page.waitForTimeout(800);
    }

    expect(violacoes).toEqual([]);
    // E os tiles realmente foram desenhados, não só pedidos.
    await expect(page.locator(".leaflet-tile").first()).toBeVisible();
  });
});

test.describe("Mapa Operacional — voltar de uma CTO", () => {
  test("NAVMAP-01/04..08 · o retorno diz Mapa Operacional e devolve a vista", async ({
    page,
  }) => {
    await login(page, ADMIN_EMAIL);
    await abrirMapa(page);

    // Monta um contexto: base híbrida, uma busca digitada, e o mapa movido.
    await page.getByTestId("map-mode-hybrid").click();
    await page.getByTestId("cto-map-search-input").fill("MAPA QA");
    await expect(page.getByTestId("cto-map-search-hit").first()).toBeVisible({
      timeout: 15000,
    });

    const caixa = await page.locator(".leaflet-container").boundingBox();
    const cx = (caixa?.x ?? 0) + (caixa?.width ?? 0) / 2;
    const cy = (caixa?.y ?? 0) + (caixa?.height ?? 0) / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx - 70, cy - 45, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(1200);

    // A vista está na barra de endereço — é ela que vai atravessar a navegação.
    const antes = vistaDaUrl(page);
    expect(antes.get("lat")).not.toBeNull();
    expect(antes.get("z")).not.toBeNull();
    expect(antes.get("mode")).toBe("HYBRID");
    expect(antes.get("q")).toBe("MAPA QA");

    await page.locator(".leaflet-marker-pane svg.cto-box").first().click();
    await page.getByTestId("cto-map-popup-open").click();

    // NAVMAP-01: o botão diz de onde a pessoa veio.
    const voltar = page.getByTestId("cto-back-link");
    await expect(voltar).toHaveText("← Mapa Operacional");

    await voltar.click();
    await expect(page.locator(".leaflet-container")).toBeVisible({
      timeout: 15000,
    });

    const depois = vistaDaUrl(page);
    // NAVMAP-04/05: centro e zoom.
    expect(Number(depois.get("lat"))).toBeCloseTo(Number(antes.get("lat")), 3);
    expect(Number(depois.get("lng"))).toBeCloseTo(Number(antes.get("lng")), 3);
    expect(depois.get("z")).toBe(antes.get("z"));
    // NAVMAP-08: a base.
    expect(depois.get("mode")).toBe("HYBRID");
    await expect(page.getByTestId("map-mode-hybrid")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // NAVMAP-06: a busca digitada.
    await expect(page.getByTestId("cto-map-search-input")).toHaveValue(
      "MAPA QA",
    );
    // NAVMAP-07: a caixa que foi aberta volta selecionada.
    expect(depois.get("sel")).not.toBeNull();
    await expect(page.locator(".leaflet-marker-pane svg.cto-box--selected")).toHaveCount(1);
  });

  test("NAVMAP-02 · vindo da listagem, o retorno continua sendo CTOs", async ({
    page,
  }) => {
    await login(page, ADMIN_EMAIL);
    await page.goto("/ctos");

    await page
      .getByRole("link", { name: "MAPA QA DISPONIVEL", exact: false })
      .first()
      .click();

    const voltar = page.getByTestId("cto-back-link");
    await expect(voltar).toHaveText("← CTOs");

    await voltar.click();
    await expect(page).toHaveURL(/\/ctos$/);
  });

  test("NAVMAP-03 · link direto para a CTO mantém o retorno seguro", async ({
    page,
  }) => {
    await login(page, ADMIN_EMAIL);
    await page.goto("/ctos/" + criadas[0]);

    await expect(page.getByTestId("cto-back-link")).toHaveText("← CTOs");
  });

  test("NAVMAP-09 · origem externa não vira redirect aberto", async ({
    page,
  }) => {
    await login(page, ADMIN_EMAIL);

    for (const hostil of [
      "https://evil.example.com",
      "//evil.example.com",
      "/mapa?x=1",
      "javascript:alert(1)",
    ]) {
      await page.goto(
        "/ctos/" + criadas[0] + "?returnTo=" + encodeURIComponent(hostil),
      );
      const voltar = page.getByTestId("cto-back-link");
      await expect(voltar, hostil + " escapou").toHaveText("← CTOs");
      await expect(voltar).toHaveAttribute("href", "/ctos");
    }
  });

  test("NAVMAP-09b · coordenada hostil na volta não derruba o mapa", async ({
    page,
  }) => {
    const erros = coletarErros(page);
    await login(page, ADMIN_EMAIL);
    await interceptarTiles(page);

    // Tudo inválido: o mapa precisa abrir mesmo assim, no enquadramento padrão.
    await page.goto("/mapa?lat=1e400&lng=NaN&z=-5&mode=%3Cscript%3E&sel=../x");

    await expect(page.locator(".leaflet-container")).toBeVisible();
    await expect(page.locator(".leaflet-marker-pane svg.cto-box").first()).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByTestId("map-mode-normal")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(erros).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// CTO-3.2.1b — os quatro pontos que o dono levantou
// ---------------------------------------------------------------------------

/** Luminância relativa da WCAG, a partir de um `rgb()` do navegador. */
function luminancia(cor: string): number {
  const m = cor.match(/\d+(\.\d+)?/g);
  if (!m) throw new Error("cor não reconhecida: " + cor);
  const [r, g, b] = m.slice(0, 3).map((v) => {
    const c = Number(v) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contraste(frente: string, fundo: string): number {
  const a = luminancia(frente);
  const b = luminancia(fundo);
  const [claro, escuro] = a > b ? [a, b] : [b, a];
  return (claro + 0.05) / (escuro + 0.05);
}

test.describe("Mapa Operacional — altura", () => {
  /*
    A FAIXA foi refeita, e o motivo fica registrado.

    A `CTO-3.2.1b` fixou 380/440/500/560 quando a página tinha busca, mapa,
    uma linha de contagens e uma legenda de quatro itens. Esta fase acrescentou
    três coisas que ocupam altura: o cartão de camadas, que o dono pediu FORA
    do canvas porque lá dentro ele cobria os botões `+`/`−`; o resumo em chips,
    com número grande; e a legenda em três grupos.

    Medido em 1440×900 com tudo ligado: o documento fecha em exatamente 900px
    com o mapa em 400. Com os 560 antigos, a legenda caía 75px abaixo da
    dobra — e "a legenda fica visível sem rolar" é regra validada pelo dono
    (`UXP-02`), não detalhe.

    O que NÃO mudou é a regra: altura de mapa continua sendo faixa de leitura
    em PIXELS, nunca fração de tela. Unidade de viewport traria de volta o mapa
    que cresce e empurra o resto para fora.
  */
  for (const caso of [
    { nome: "desktop", width: 1440, height: 900, min: 360, max: 440 },
    { nome: "notebook", width: 1280, height: 800, min: 360, max: 440 },
    { nome: "tablet", width: 768, height: 1024, min: 340, max: 420 },
    { nome: "celular", width: 390, height: 844, min: 290, max: 360 },
  ]) {
    test(`UXP-01/03 · a altura fica na faixa em ${caso.nome}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: caso.width, height: caso.height });
      await login(page, ADMIN_EMAIL);
      await abrirMapa(page);

      const caixa = await page.getByTestId("operational-map").boundingBox();
      const altura = caixa?.height ?? 0;

      expect(altura).toBeGreaterThanOrEqual(caso.min);
      expect(altura).toBeLessThanOrEqual(caso.max);

      /*
        UXP-02, medido e não lido do CSS: o mapa não pode ocupar a tela toda.

        Era esse o defeito — com `vh` ele crescia junto com a janela e empurrava
        busca, contadores e legenda para fora da primeira dobra.
      */
      expect(altura).toBeLessThan(caso.height * 0.85);

      // E o que vem depois dele continua na página, não numa rolagem absurda.
      const documento = await page.evaluate(
        () => document.documentElement.scrollHeight,
      );
      expect(documento).toBeLessThan(caso.height * 2.5);
    });
  }

  test("UXP-02 · a legenda continua visível sem rolar em desktop", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, ADMIN_EMAIL);
    await abrirMapa(page);

    // O sintoma concreto do mapa alto: a legenda saía da primeira dobra.
    await expect(page.getByTestId("map-legend")).toBeInViewport();
  });
});

test.describe("Mapa Operacional — política de zoom", () => {
  /** Os níveis `z` que o navegador chegou a pedir de cada provedor. */
  function zoomsPedidos(page: Page) {
    const pedidos: { provedor: string; z: number }[] = [];
    page.on("request", (r) => {
      const url = r.url();
      let provedor = "";
      let z = NaN;
      if (url.includes("tile.openstreetmap.org")) {
        provedor = "normal";
        z = Number(/\/(\d+)\/\d+\/\d+\.png/.exec(url)?.[1]);
      } else if (url.includes("arcgisonline.com")) {
        provedor = "satellite";
        z = Number(/\/tile\/(\d+)\/\d+\/\d+/.exec(url)?.[1]);
      } else if (url.includes("cartocdn.com")) {
        provedor = "labels";
        z = Number(/\/(\d+)\/\d+\/\d+\.png/.exec(url)?.[1]);
      }
      if (provedor && Number.isFinite(z)) pedidos.push({ provedor, z });
    });
    return pedidos;
  }

  async function aproximarAteOLimite(page: Page) {
    // Doze cliques passam com folga de qualquer zoom inicial até o teto.
    for (let i = 0; i < 12; i += 1) {
      const botao = page.locator(".leaflet-control-zoom-in");
      if ((await botao.getAttribute("class"))?.includes("disabled")) break;
      await botao.click();
      await page.waitForTimeout(120);
    }
    await page.waitForTimeout(1200);
  }

  test("UXP-04 · NORMAL nunca pede acima do zoom nativo do OSM", async ({
    page,
  }) => {
    const pedidos = zoomsPedidos(page);
    await login(page, ADMIN_EMAIL);
    await abrirMapa(page);
    await aproximarAteOLimite(page);

    const normais = pedidos.filter((p) => p.provedor === "normal");
    expect(normais.length).toBeGreaterThan(0);
    expect(Math.max(...normais.map((p) => p.z))).toBeLessThanOrEqual(19);
  });

  test("UXP-05 · SATELLITE nunca pede o tile da placa", async ({ page }) => {
    /*
      A prova de que a placa "Map data not yet available" não volta.

      Ela aparece quando o Leaflet PEDE um tile acima da cobertura do Esri — e
      o Esri responde `200` com a placa em vez de `404`. Com `maxNativeZoom`,
      o pedido nunca sai: o Leaflet amplia o último nível real.
    */
    const pedidos = zoomsPedidos(page);
    await login(page, ADMIN_EMAIL);
    await abrirMapa(page);

    await page.getByTestId("map-mode-satellite").click();
    await aproximarAteOLimite(page);

    const satelite = pedidos.filter((p) => p.provedor === "satellite");
    expect(satelite.length, "o satélite não pediu tile nenhum").toBeGreaterThan(0);
    expect(
      Math.max(...satelite.map((p) => p.z)),
      "pediu tile acima da cobertura medida do Esri",
    ).toBeLessThanOrEqual(18);

    // E o mapa continua desenhando: ampliar não é ficar cinza.
    await expect(page.locator(".leaflet-tile-loaded").first()).toBeVisible();
  });

  test("UXP-06 · HYBRID respeita o limite das DUAS camadas", async ({
    page,
  }) => {
    const pedidos = zoomsPedidos(page);
    await login(page, ADMIN_EMAIL);
    await abrirMapa(page);

    await page.getByTestId("map-mode-hybrid").click();
    await aproximarAteOLimite(page);

    const base = pedidos.filter((p) => p.provedor === "satellite");
    const rotulos = pedidos.filter((p) => p.provedor === "labels");

    expect(base.length).toBeGreaterThan(0);
    expect(rotulos.length).toBeGreaterThan(0);
    expect(Math.max(...base.map((p) => p.z))).toBeLessThanOrEqual(18);
    expect(Math.max(...rotulos.map((p) => p.z))).toBeLessThanOrEqual(19);

    /*
      Nenhuma das duas "quebra" enquanto a outra continua: as duas ampliam a
      partir do próprio nativo, e as duas seguem desenhadas.
    */
    await expect(page.locator(".leaflet-tile-loaded").first()).toBeVisible();
    await expect(page.getByTestId("map-mode-hybrid")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  test("UXP-07 · uma CTO só não abre colada demais", async ({ page }) => {
    await login(page, ADMIN_EMAIL);
    await abrirMapa(page);

    const z = Number(new URL(page.url()).searchParams.get("z"));
    expect(Number.isFinite(z)).toBe(true);
    // Enxerga a caixa, a rua dela e as quadras em volta — nem o país, nem a
    // calçada.
    expect(z).toBeGreaterThanOrEqual(12);
    expect(z).toBeLessThanOrEqual(17);
  });
});

test.describe("Mapa Operacional — marcador e ação", () => {
  test("UXP-08/09/10 · o marcador é uma caixa óptica com régua de portas", async ({
    page,
  }) => {
    await login(page, ADMIN_EMAIL);
    await abrirMapa(page);

    const caixa = page.locator(".leaflet-marker-pane svg.cto-box").first();
    await expect(caixa).toBeVisible();

    // A silhueta.
    await expect(caixa.locator(".cto-box__body")).toHaveCount(1);
    await expect(caixa.locator(".cto-box__lid")).toHaveCount(1);
    /*
      UMA placa de prensa-cabos, DOIS cabos — desde a `CTO-3.2.1c`.

      A contagem de cabos era 1 e virou 2 porque o dono pediu "entrada/saída de
      cabo melhor resolvida": o tronco desce reto até o poste, a drop do
      assinante sai em curva. Um cabo só descrevia metade do que a caixa faz.

      A placa continua sendo UMA. Dois blocos pequenos sob a caixa leem como
      pés — foi a primeira tentativa desta fase, e ela foi descartada olhando o
      desenho renderizado.
    */
    await expect(caixa.locator(".cto-box__gland")).toHaveCount(1);
    await expect(caixa.locator(".cto-box__cable")).toHaveCount(2);

    // A régua — e não a grade de pontos que o dono recusou.
    await expect(caixa.locator(".cto-box__tray")).toHaveCount(1);
    expect(
      await caixa.locator(".cto-box__ports line").count(),
    ).toBeGreaterThanOrEqual(4);
    await expect(caixa.locator(".cto-box__ports circle")).toHaveCount(0);

    // O estado continua por forma e glifo.
    await expect(caixa.locator(".cto-box__badge")).toHaveCount(1);
    await expect(caixa.locator(".cto-box__glyph")).toHaveCount(1);

    // E o marcador é pequeno: ele aponta para o mapa, não compete com ele.
    const medida = await caixa.boundingBox();
    expect(medida?.width ?? 0).toBeLessThanOrEqual(48);
    expect(medida?.width ?? 0).toBeGreaterThanOrEqual(24);
  });

  test("UXP-08b · a caixa continua legível sobre satélite e híbrido", async ({
    page,
  }) => {
    await login(page, ADMIN_EMAIL);
    await abrirMapa(page);

    for (const modo of ["satellite", "hybrid"]) {
      await page.getByTestId(`map-mode-${modo}`).click();
      await page.waitForTimeout(600);
      // Sobre imagem aérea não há fundo previsível: a sombra é o que separa o
      // desenho de um telhado escuro ou de uma laje clara.
      const filtro = await page
        .locator(".leaflet-marker-pane svg.cto-box")
        .first()
        .evaluate((el) => getComputedStyle(el).filter);
      expect(filtro, `sem sombra no modo ${modo}`).toContain("drop-shadow");
    }
  });

  for (const tema of ["light", "dark"] as const) {
    test(`UXP-12 · "Abrir CTO" tem contraste real no tema ${tema}`, async ({
      page,
    }) => {
      await login(page, ADMIN_EMAIL);

      await page.addInitScript((t) => {
        window.localStorage.setItem("alfaos-theme", t);
      }, tema);
      await abrirMapa(page);

      await page.locator(".leaflet-marker-pane svg.cto-box").first().click();
      const botao = page.getByTestId("cto-map-popup-open");
      await expect(botao).toBeVisible();

      /*
        A asserção que faltava, e que nenhum teste anterior faria.

        O botão sempre esteve lá, com o texto certo, no lugar certo — e ilegível:
        `leaflet.css` pinta TODO <a> do mapa com #0078A8, vencendo a utility do
        Tailwind por especificidade, e o resultado era azul sobre azul com
        contraste de cerca de 1,06:1.

        Presença e texto não pegam isso. Contraste calculado pega.
      */

      /*
        O PONTEIRO SAI DE CIMA ANTES DE MEDIR — e isto foi diagnosticado, não
        chutado.

        Este teste falhou uma vez na suíte inteira, com
        `contraste 4.06:1 entre rgb(255, 255, 255) e rgb(52, 121, 243)`, e
        `rgb(52,121,243)` não é token nenhum: `--primary` é `rgb(37,99,235)` e
        `--primary-hover` é `rgb(59,130,246)`. O valor está ENTRE os dois, ou
        seja, era a transição de 0,15s correndo.

        A causa é o clique no marcador deixar o cursor parado onde clicou, e o
        popup — que o `autoPan` do Leaflet ainda pode deslocar — vir a passar
        por baixo dele. O botão entra em `:hover`, a cor começa a andar, e a
        leitura pega o meio do caminho.

        Medir uma cor em movimento é medir coisa nenhuma. Tirando o ponteiro e
        esperando a transição assentar, o teste volta a afirmar sobre o estado
        que ele diz medir. Isso NÃO afrouxa a asserção: o limiar continua 4,5.

        INFO pré-existente que o episódio revelou, e que NÃO é desta fase.
        Medido no navegador, o hover anda em direções OPOSTAS nos dois temas:

            claro   repouso rgb(37,99,235)  5,17:1  ->  hover rgb(29,78,216)  6,70:1
            escuro  repouso rgb(37,99,235)  5,17:1  ->  hover rgb(59,130,246) 3,68:1

        No tema claro o hover escurece e o contraste MELHORA; no escuro ele
        clareia e cai para **3,68:1**, abaixo de AA. É propriedade do design
        system — `bg-primary` com `hover:bg-primary-hover` aparece no produto
        inteiro —, e mudá-la é decisão de design com alcance muito maior que o
        polimento de duas coisas no mapa. Fica registrado, não corrigido em
        silêncio e não transformado numa asserção frouxa que documentaria 3,68
        como aceitável.
      */
      await page.mouse.move(4, 4);
      await expect
        .poll(() => botao.evaluate((el) => el.matches(":hover")))
        .toBe(false);
      // Duas vezes a transição de 150ms: a cor já assentou quando a leitura sai.
      await page.waitForTimeout(300);

      const cores = await botao.evaluate((el) => {
        const s = getComputedStyle(el);
        return { frente: s.color, fundo: s.backgroundColor };
      });

      const razao = contraste(cores.frente, cores.fundo);
      expect(
        razao,
        `contraste ${razao.toFixed(2)}:1 entre ${cores.frente} e ${cores.fundo}`,
      ).toBeGreaterThanOrEqual(4.5);

      // E o fundo é mesmo o primário, não transparente por acidente.
      expect(cores.fundo).not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
    });
  }

  test("UXP-13/14 · a ação navega e o retorno preserva a vista", async ({
    page,
  }) => {
    await login(page, ADMIN_EMAIL);
    await abrirMapa(page);

    await page.getByTestId("map-mode-hybrid").click();
    await page.waitForTimeout(800);

    const antes = new URL(page.url()).searchParams;

    await page.locator(".leaflet-marker-pane svg.cto-box").first().click();
    await page.getByTestId("cto-map-popup-open").click();

    await expect(page.getByTestId("cto-back-link")).toHaveText(
      "← Mapa Operacional",
    );
    await page.getByTestId("cto-back-link").click();

    await expect(page.locator(".leaflet-container")).toBeVisible({
      timeout: 15000,
    });
    const depois = new URL(page.url()).searchParams;

    expect(depois.get("mode")).toBe("HYBRID");
    expect(depois.get("z")).toBe(antes.get("z"));
    expect(Number(depois.get("lat"))).toBeCloseTo(Number(antes.get("lat")), 3);
    await expect(page.getByTestId("map-mode-hybrid")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});

// ---------------------------------------------------------------------------
// CTO-3.2.1c — a plaqueta com o nome da CTO
// ---------------------------------------------------------------------------

/**
 * Abre o mapa numa vista EXPLÍCITA.
 *
 * `abrirMapa` deixa o enquadramento por conta do `fitBounds`, e o zoom que ele
 * escolhe depende do tamanho da janela — as quatro caixas de teste cabem em
 * `z16` numa viewport e em `z15` noutra. Como a plaqueta tem limiar de zoom,
 * um teste que dependesse disso mediria a viewport, não a regra.
 */
async function abrirMapaEm(page: Page, zoom: number, extra = "") {
  await interceptarTiles(page);
  await page.goto(
    `/mapa?lat=${BASE.latitude}&lng=${BASE.longitude}&z=${zoom}${extra}`,
  );
  await expect(page.locator(".leaflet-container")).toBeVisible();
  await expect(page.locator(".leaflet-marker-icon").first()).toBeVisible({
    timeout: 15_000,
  });
}

/** A plaqueta de uma caixa, achada pelo nome que ela mostra. */
function plaquetaDe(page: Page, nome: string) {
  return page.locator(".leaflet-tooltip.cto-map-label").filter({ hasText: nome });
}

/** O marcador daquela mesma caixa: o `title` carrega o nome. */
function marcadorDe(page: Page, nome: string) {
  return page.locator(`.leaflet-marker-icon[title^="${nome}"]`);
}

test.describe("Mapa Operacional — plaqueta com o nome da CTO", () => {
  test("ML-01/02 · o nome aparece POR CIMA da caixa, sem clicar em nada", async ({
    page,
  }) => {
    const erros = coletarErros(page);
    await login(page, ADMIN_EMAIL);
    /*
      `z16` e não `z17`, e a razão é do BACKEND, não da plaqueta.

      As quatro caixas do fixture estão a cerca de 440 m do centro. Em `z17` o
      recorte da janela não as alcança, e a API — corretamente — devolve só a
      caixa central: o mapa nunca carrega o que está fora da vista. Em `z16` a
      janela cobre cerca de 1,2 km e as quatro entram.

      É também o limiar exato da plaqueta, o que torna este teste mais forte:
      ele afirma que no PRIMEIRO zoom em que as plaquetas aparecem elas já
      aparecem todas.
    */
    await abrirMapaEm(page, 16);

    /*
      A afirmação central da fase, e ela é sobre o que o dono vê ao ABRIR.

      Nada foi clicado, nada foi apontado. As quatro caixas do recorte mostram o
      próprio nome — que é literalmente o pedido: "o nome da CTO deve aparecer
      por cima dela no mapa".
    */
    await expect(page.getByTestId("cto-map-label")).toHaveCount(4, {
      timeout: 15_000,
    });
    await expect(plaquetaDe(page, "MAPA QA DISPONIVEL")).toHaveCount(1);
    await expect(plaquetaDe(page, "MAPA QA LOTADA")).toHaveCount(1);

    // E é PERMANENTE: continua ali depois de clicar no mapa vazio, que é onde
    // um tooltip comum do Leaflet se fecharia.
    await page.locator(".leaflet-container").click({ position: { x: 8, y: 8 } });
    await expect(page.getByTestId("cto-map-label")).toHaveCount(4);

    expect(erros).toEqual([]);
  });

  test("ML-04 · a plaqueta fica ACIMA do marcador e centrada nele", async ({
    page,
  }) => {
    await login(page, ADMIN_EMAIL);
    await abrirMapaEm(page, 17);

    const nome = "MAPA QA DISPONIVEL";
    const plaqueta = plaquetaDe(page, nome);
    const marcador = marcadorDe(page, nome);
    await expect(plaqueta).toBeVisible();
    await expect(marcador).toBeVisible();

    const p = (await plaqueta.boundingBox())!;
    const m = (await marcador.boundingBox())!;

    /*
      ACIMA de verdade, medido — e não "tem a classe que diz top".

      A sabotagem `S2` desta fase troca `direction` para `bottom`; a única
      asserção que a derruba é esta comparação de retângulos.
    */
    expect(
      p.y + p.height,
      `a plaqueta (base ${p.y + p.height}) precisa ficar acima do marcador (topo ${m.y})`,
    ).toBeLessThanOrEqual(m.y + 2);

    // ANCORADA: centrada no marcador, e encostada nele.
    const centroPlaqueta = p.x + p.width / 2;
    const centroMarcador = m.x + m.width / 2;
    expect(Math.abs(centroPlaqueta - centroMarcador)).toBeLessThanOrEqual(6);
    expect(
      m.y - (p.y + p.height),
      "plaqueta solta, longe do marcador",
    ).toBeLessThanOrEqual(24);

    // Truncada com critério: ela nunca vira uma faixa atravessando o mapa.
    expect(p.width).toBeLessThanOrEqual(130);

    // A cauda repintada é o conector: sem ela a plaqueta flutua desligada.
    const cauda = await plaqueta.evaluate((el) => {
      const s = getComputedStyle(el, "::before");
      return { cor: s.borderTopColor, largura: s.borderTopWidth };
    });
    expect(cauda.cor).not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
    expect(parseFloat(cauda.largura)).toBeGreaterThan(0);
  });

  for (const tema of ["light", "dark"] as const) {
    test(`ML-03 · a plaqueta tem contraste real no tema ${tema}`, async ({
      page,
    }) => {
      await login(page, ADMIN_EMAIL);
      await page.addInitScript((t) => {
        window.localStorage.setItem("alfaos-theme", t);
      }, tema);
      await abrirMapaEm(page, 17);

      const plaqueta = plaquetaDe(page, "MAPA QA DISPONIVEL");
      await expect(plaqueta).toBeVisible();

      /*
        O mesmo detector que reproduziu o defeito do botão na `CTO-3.2.1b`.

        "Tem contraste suficiente" é afirmação numérica, e presença de elemento
        não a responde. Aqui ela vale duas vezes: a plaqueta flutua sobre imagem
        que não é nossa, e sem fundo OPACO o número dependeria do tile atrás.
      */
      const cores = await plaqueta.evaluate((el) => {
        const s = getComputedStyle(el);
        return { frente: s.color, fundo: s.backgroundColor };
      });

      const razao = contraste(cores.frente, cores.fundo);
      expect(
        razao,
        `contraste ${razao.toFixed(2)}:1 entre ${cores.frente} e ${cores.fundo}`,
      ).toBeGreaterThanOrEqual(4.5);

      // OPACA: com alfa, o número acima seria uma meia-verdade.
      expect(cores.fundo).not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
      expect(cores.fundo, "fundo semitransparente").not.toMatch(
        /rgba\([^)]*,\s*0?\.\d+\)/,
      );
    });
  }

  test("ML-05 · a plaqueta NÃO substitui o popup, e não come o clique", async ({
    page,
  }) => {
    await login(page, ADMIN_EMAIL);
    await abrirMapaEm(page, 17);

    const plaqueta = plaquetaDe(page, "MAPA QA DISPONIVEL");
    await expect(plaqueta).toBeVisible();

    /*
      INERTE ao ponteiro.

      Uma plaqueta que aceitasse eventos cobriria o marcador do vizinho e
      engoliria o clique dele — e o operador veria um marcador que simplesmente
      não abre, sem nenhuma pista do porquê.
    */
    expect(
      await plaqueta.evaluate((el) => getComputedStyle(el).pointerEvents),
    ).toBe("none");

    // E o popup continua sendo o lugar do detalhe.
    await marcadorDe(page, "MAPA QA DISPONIVEL").click();
    await expect(page.getByTestId("cto-map-popup")).toBeVisible();
    await expect(page.getByTestId("cto-map-popup-free")).toBeVisible();
    await expect(page.getByTestId("cto-map-popup-open")).toBeVisible();

    // Com o popup aberto, a plaqueta continua lá: elas não competem.
    await expect(plaqueta).toBeVisible();
  });

  test("ML-03b · a plaqueta continua legível sobre satélite e híbrido", async ({
    page,
  }) => {
    await login(page, ADMIN_EMAIL);
    await abrirMapaEm(page, 17);

    for (const modo of ["satellite", "hybrid"]) {
      await page.getByTestId(`map-mode-${modo}`).click();
      await page.waitForTimeout(600);

      const plaqueta = plaquetaDe(page, "MAPA QA DISPONIVEL");
      await expect(plaqueta, `plaqueta sumiu no modo ${modo}`).toBeVisible();

      const estilo = await plaqueta.evaluate((el) => {
        const s = getComputedStyle(el);
        return { fundo: s.backgroundColor, sombra: s.boxShadow, cor: s.color };
      });

      // Sobre imagem aérea não há fundo previsível: fundo opaco mais sombra é o
      // que separa a plaqueta de um telhado escuro ou de uma laje clara.
      expect(estilo.fundo).not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
      expect(estilo.sombra, `sem sombra no modo ${modo}`).not.toBe("none");
      expect(contraste(estilo.cor, estilo.fundo)).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("ML-DENS-05 · afastar apaga as plaquetas; a selecionada permanece", async ({
    page,
  }) => {
    await login(page, ADMIN_EMAIL);

    // No limiar, todas as caixas do recorte mostram o nome.
    await abrirMapaEm(page, 16);
    await expect(page.getByTestId("cto-map-label")).toHaveCount(4, {
      timeout: 15_000,
    });

    /*
      Abaixo do limiar, NENHUMA — e é isso que evita a parede de texto.

      Em `z13` as quatro caixas do teste ficam a poucos pixels umas das outras;
      quatro plaquetas ali seriam quatro retângulos empilhados, ilegíveis, por
      cima do mapa.
    */
    await abrirMapaEm(page, 13);
    await expect(page.locator(".leaflet-marker-icon").first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("cto-map-label")).toHaveCount(0);

    /*
      Menos a SELECIONADA, e é a exceção que torna a regra usável: quem achou
      uma caixa na busca precisa saber qual mancha é a dela.
    */
    await abrirMapaEm(page, 13, `&sel=${criadas[0]}`);
    await expect(page.getByTestId("cto-map-label")).toHaveCount(1, {
      timeout: 15_000,
    });
    await expect(plaquetaDe(page, "MAPA QA DISPONIVEL")).toHaveCount(1);

    // E ela se distingue: a borda acompanha o anel do marcador selecionado.
    await expect(
      page.locator(".leaflet-tooltip.cto-map-label--selected"),
    ).toHaveCount(1);
  });

  test("ML-06/07/08 · o marcador refinado, no navegador", async ({ page }) => {
    await login(page, ADMIN_EMAIL);
    await abrirMapaEm(page, 17);

    const caixa = page.locator(".leaflet-marker-pane svg.cto-box").first();
    await expect(caixa).toBeVisible();

    // ML-06: corpo, tampa com fecho, UMA placa de prensa-cabos e DOIS cabos.
    await expect(caixa.locator(".cto-box__body")).toHaveCount(1);
    await expect(caixa.locator(".cto-box__lid")).toHaveCount(1);
    await expect(caixa.locator(".cto-box__latch")).toHaveCount(1);
    await expect(caixa.locator(".cto-box__gland")).toHaveCount(1);
    await expect(caixa.locator(".cto-box__cable")).toHaveCount(2);

    /*
      O corpo é um `<path>`, e a asserção mede a proporção NA TELA.

      A estrutural olha `CTO_MARKER_GEOMETRY`; esta olha o que o navegador
      desenhou, que é onde a proporção de fato acontece. Foi por olhar o
      desenho renderizado que as duas tentativas anteriores desta fase caíram.
    */
    const corpo = (await caixa.locator(".cto-box__body").boundingBox())!;
    expect(
      corpo.height,
      `corpo ${corpo.width.toFixed(1)} × ${corpo.height.toFixed(1)}px: precisa ler como caixa em pé`,
    ).toBeGreaterThan(corpo.width);

    // ML-07: a régua de adaptadores, e nenhum ponto solto.
    await expect(caixa.locator(".cto-box__tray")).toHaveCount(1);
    expect(
      await caixa.locator(".cto-box__ports line").count(),
    ).toBeGreaterThanOrEqual(4);
    await expect(caixa.locator(".cto-box__ports circle")).toHaveCount(0);

    // ML-08: o estado continua por forma e glifo, não só por cor.
    await expect(caixa.locator(".cto-box__badge")).toHaveCount(1);
    await expect(caixa.locator(".cto-box__glyph")).toHaveCount(1);

    /*
      E o desenho continua PINTADO pelos tokens.

      O fecho e a placa de prensa-cabos são as peças novas, e peça nova é
      exatamente a que nasce sem regra de CSS. Um `fill` ausente no SVG não
      falha: ele significa PRETO, a única cor que ignora o tema escolhido — e
      foi assim que a primeira prévia desta fase saiu, com o marcador inteiro em
      preto porque a folha de estilo não fora carregada junto.
    */
    for (const parte of [".cto-box__latch", ".cto-box__gland"]) {
      const preenchimento = await caixa
        .locator(parte)
        .first()
        .evaluate((el) => getComputedStyle(el).fill);
      expect(preenchimento, `${parte} sem cor de token`).not.toBe("none");
      expect(preenchimento).toMatch(/^rgb/);
    }

    // Continua pequeno: aponta para o mapa, não compete com ele.
    const medida = await caixa.boundingBox();
    expect(medida?.width ?? 0).toBeLessThanOrEqual(48);
    expect(medida?.width ?? 0).toBeGreaterThanOrEqual(24);
  });

  test("ML-09 · a persistência do mapa NÃO regrediu", async ({ page }) => {
    await login(page, ADMIN_EMAIL);
    await abrirMapaEm(page, 17);

    await page.getByTestId("map-mode-hybrid").click();
    await expect(page.getByTestId("map-mode-hybrid")).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    const antes = vistaDaUrl(page);
    await page.reload();
    await expect(page.locator(".leaflet-container")).toBeVisible();

    // Modo, zoom e centro sobrevivem — a plaqueta não pode ter custado isso.
    await expect(page.getByTestId("map-mode-hybrid")).toHaveAttribute(
      "aria-pressed",
      "true",
      { timeout: 10_000 },
    );
    const depois = vistaDaUrl(page);
    // Igualdade, e não aproximação: as duas pontas escrevem o mesmo
    // `toFixed(6)`, e uma tolerância de três casas aceitaria 55 metros de
    // deriva sem reclamar.
    expect(depois.get("z")).toBe(antes.get("z"));
    expect(depois.get("lat")).toBe(antes.get("lat"));
    expect(depois.get("lng")).toBe(antes.get("lng"));

    // E a plaqueta volta junto.
    await expect(page.getByTestId("cto-map-label").first()).toBeVisible({
      timeout: 15_000,
    });

    /*
      A OUTRA metade da persistência, e ela quase escapou.

      A sabotagem `S5` desta fase — remover a gravação da preferência de base —
      **passou** por este teste na primeira versão, e passou com razão: recarregar
      a URL acima restaura o modo a partir da própria URL, que a vista espelha.
      A preferência do aparelho só responde por quem entra pela porta sem query,
      que é o operador abrindo o mapa pelo menu no dia seguinte.

      Sem esta segunda entrada, "a persistência não regrediu" seria meia
      verdade: um teste com o nome certo cobrindo metade do assunto.
    */
    await page.goto("/mapa");
    await expect(page.locator(".leaflet-container")).toBeVisible();
    await expect(page.getByTestId("map-mode-hybrid")).toHaveAttribute(
      "aria-pressed",
      "true",
      { timeout: 10_000 },
    );
  });

  test("ML-10 · o retorno ao Mapa Operacional NÃO regrediu", async ({
    page,
  }) => {
    await login(page, ADMIN_EMAIL);
    await abrirMapaEm(page, 17);

    const antes = vistaDaUrl(page);

    await marcadorDe(page, "MAPA QA DISPONIVEL").click();
    await expect(page.getByTestId("cto-map-popup")).toBeVisible();
    await page.getByTestId("cto-map-popup-open").click();

    await expect(page.getByTestId("cto-back-link")).toHaveText(
      "← Mapa Operacional",
    );
    await page.getByTestId("cto-back-link").click();

    await expect(page.locator(".leaflet-container")).toBeVisible({
      timeout: 15_000,
    });
    const depois = vistaDaUrl(page);
    expect(depois.get("z")).toBe(antes.get("z"));
    expect(Number(depois.get("lat"))).toBeCloseTo(Number(antes.get("lat")), 3);

    // De volta ao mapa, o nome está lá de novo — e o da caixa aberta em
    // destaque, porque ela voltou selecionada.
    await expect(page.getByTestId("cto-map-label").first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.locator(".leaflet-tooltip.cto-map-label--selected"),
    ).toHaveCount(1);
  });
});

// ---------------------------------------------------------------------------
// CTO-3.2.1c — delta do dono: o CORPO da caixa carrega o estado
// ---------------------------------------------------------------------------

/** Os canais de um `rgb(...)` que o navegador devolveu. */
function canais(cor: string): { r: number; g: number; b: number } {
  const m = cor.match(/\d+(\.\d+)?/g);
  if (!m) throw new Error("cor não reconhecida: " + cor);
  const [r, g, b] = m.slice(0, 3).map(Number);
  return { r, g, b };
}

/** Quanto o tom se afasta do cinza. Zero = cinza puro. */
function saturacao(cor: string): number {
  const { r, g, b } = canais(cor);
  return Math.max(r, g, b) - Math.min(r, g, b);
}

/** O `svg.cto-box` da caixa com aquele nome. */
function marcadorSvg(page: Page, nome: string) {
  return page.locator(`.leaflet-marker-icon[title^="${nome}"] svg.cto-box`);
}

/** A cor de traço do CORPO, computada pelo navegador. */
function contornoDe(page: Page, nome: string) {
  return marcadorSvg(page, nome)
    .locator(".cto-box__body")
    .evaluate((el) => getComputedStyle(el).stroke);
}

test.describe("Mapa Operacional — o corpo comunica o estado", () => {
  test("STATUSVIS-01/02/03 · cada estado tem contorno próprio, medido no navegador", async ({
    page,
  }) => {
    await login(page, ADMIN_EMAIL);
    await abrirMapaEm(page, 16);
    await expect(page.locator(".leaflet-marker-pane svg.cto-box")).toHaveCount(4, { timeout: 15_000 });

    const disponivel = await contornoDe(page, "MAPA QA DISPONIVEL");
    const lotada = await contornoDe(page, "MAPA QA LOTADA");
    const defeito = await contornoDe(page, "MAPA QA DEFEITO");
    const inativa = await contornoDe(page, "MAPA QA INATIVA");

    /*
      As asserções olham o CANAL DOMINANTE, e não o valor exato.

      Fixar `rgb(4, 120, 87)` amarraria o teste ao hexadecimal de hoje e
      quebraria na primeira afinação do design system — sem que nada estivesse
      errado. O que precisa continuar verdadeiro é a LEITURA: verde é verde,
      vermelho é vermelho.
    */
    const verde = canais(disponivel);
    expect(
      verde.g,
      `AVAILABLE deveria puxar para o verde, e veio ${disponivel}`,
    ).toBeGreaterThan(verde.r);
    expect(verde.g).toBeGreaterThan(verde.b);

    const vermelho = canais(defeito);
    expect(
      vermelho.r,
      `DAMAGED deveria puxar para o vermelho, e veio ${defeito}`,
    ).toBeGreaterThan(vermelho.g);
    expect(vermelho.r).toBeGreaterThan(vermelho.b);

    // Âmbar: vermelho e verde altos, azul baixo — é o que separa amarelo de
    // laranja-avermelhado e de verde.
    const ambar = canais(lotada);
    expect(ambar.r, `FULL veio ${lotada}`).toBeGreaterThan(ambar.b);
    expect(ambar.g).toBeGreaterThan(ambar.b);

    // E os quatro são DISTINTOS: um estado que reusasse a cor de outro não
    // seria distinguível de relance, que é o ponto do delta.
    const todos = [disponivel, lotada, defeito, inativa];
    expect(
      new Set(todos).size,
      `contornos repetidos: ${todos.join(" | ")}`,
    ).toBe(4);

    // O contorno é grosso o bastante para sobreviver a fundo texturizado.
    const largura = await marcadorSvg(page, "MAPA QA DISPONIVEL")
      .locator(".cto-box__body")
      .evaluate((el) => parseFloat(getComputedStyle(el).strokeWidth));
    expect(largura).toBeGreaterThanOrEqual(2);
  });

  test("STATUSVIS-04/05 · INATIVA apaga a caixa, mantém o selo e escreve o estado", async ({
    page,
  }) => {
    await login(page, ADMIN_EMAIL);
    await abrirMapaEm(page, 16);
    await expect(page.locator(".leaflet-marker-pane svg.cto-box")).toHaveCount(4, { timeout: 15_000 });

    const svg = marcadorSvg(page, "MAPA QA INATIVA");
    const figura = await svg.locator(".cto-box__figure").evaluate((el) => {
      const s = getComputedStyle(el);
      return { opacidade: parseFloat(s.opacity), filtro: s.filter };
    });

    // APAGADA e DESSATURADA — de forma controlada, não invisível.
    expect(figura.opacidade, "a inativa não apagou").toBeLessThan(1);
    expect(figura.opacidade, "apagada demais deixa de ser legível").toBeGreaterThan(0.3);
    expect(figura.filtro, "a inativa não dessaturou").toContain("grayscale");

    // O contorno da inativa é CINZA: baixa saturação, ao contrário dos outros.
    const cinza = await contornoDe(page, "MAPA QA INATIVA");
    expect(
      saturacao(cinza),
      `o contorno da inativa deveria ser cinza, e veio ${cinza}`,
    ).toBeLessThan(40);

    /*
      O SELO continua em opacidade cheia, e é isso que a figura separada
      garante.

      Se ele apagasse junto, a caixa desbotada esconderia o próprio motivo —
      e ficaria indistinguível de um controle desabilitado pela interface.
    */
    /*
      A opacidade EFETIVA, subindo a árvore — e isto foi corrigido por uma
      sabotagem que passou.

      A primeira versão lia `getComputedStyle(selo).opacity` e afirmava que o
      selo continuava cheio. A sabotagem `V5`, que põe `opacity: .55` no
      marcador INTEIRO, **passou**: `opacity` não é herdada, ela COMPÕE. O selo
      continua com o próprio valor 1 enquanto o ancestral o apaga na tela, e a
      leitura direta não tem como ver isso.

      Multiplicar do selo até o `svg` responde a pergunta certa — "quanto disto
      chega aos olhos?" — em vez da pergunta que era fácil de fazer.
    */
    const opacidadeEfetiva = (seletor: string) =>
      svg.evaluate((raiz, sel) => {
        let no: Element | null = raiz.querySelector(sel);
        let produto = 1;
        while (no && no !== raiz.parentElement) {
          produto *= parseFloat(getComputedStyle(no).opacity || "1");
          no = no.parentElement;
        }
        return produto;
      }, seletor);

    expect(
      await opacidadeEfetiva(".cto-box__badge"),
      "o selo apagou junto com a caixa",
    ).toBe(1);
    expect(
      await opacidadeEfetiva(".cto-box__body"),
      "a caixa não apagou de verdade na tela",
    ).toBeLessThan(1);
    await expect(svg.locator(".cto-box__glyph")).toHaveCount(1);

    // STATUSVIS-05: a plaqueta escreve o estado, e o nome continua inteiro.
    const plaqueta = page
      .locator(".leaflet-tooltip.cto-map-label")
      .filter({ hasText: "MAPA QA INATIVA" });
    await expect(plaqueta).toBeVisible();
    await expect(plaqueta.getByTestId("cto-map-label-state")).toHaveText("INATIVA");
    await expect(plaqueta.locator(".cto-map-label__name")).toHaveText(
      "MAPA QA INATIVA",
    );

    // Duas LINHAS de verdade: o estado embaixo do nome, e não emendado nele.
    const nome = (await plaqueta.locator(".cto-map-label__name").boundingBox())!;
    const estado = (await plaqueta.getByTestId("cto-map-label-state").boundingBox())!;
    expect(
      estado.y,
      "o estado precisa ficar ABAIXO do nome, e não ao lado",
    ).toBeGreaterThanOrEqual(nome.y + nome.height - 1);

    /*
      E SÓ a inativa escreve o estado.

      Escrever em todas transformaria o mapa numa lista de palavras — nos outros
      três o contorno e o selo já dizem tudo.
    */
    await expect(page.getByTestId("cto-map-label-state")).toHaveCount(1);
  });

  test("STATUSVIS-06 · selecionar NÃO apaga o estado", async ({ page }) => {
    await login(page, ADMIN_EMAIL);
    /*
      `z15` e não `z16`, e a razão é geométrica.

      As fixtures ficam a ±0,004° do centro, uns 444m. Com o mapa em 400px de
      altura (a faixa foi refeita nesta fase), z16 mostra ~960m: a caixa ao
      norte cai a uns 15px do topo, e a plaqueta permanente dela — que fica
      ACIMA do marcador — sai pela borda. O Leaflet recorta, e o marcador
      nunca chega a "visível" para o ponteiro.

      É a mesma lição que a `ML-01/02` já tinha aprendido ao contrário, quando
      z17 era apertado demais para um mapa maior: o zoom do teste é função da
      altura do mapa, e mudou junto com ela.
    */
    await abrirMapaEm(page, 15);
    await expect(page.locator(".leaflet-marker-pane svg.cto-box")).toHaveCount(4, { timeout: 15_000 });

    const antes = await contornoDe(page, "MAPA QA DEFEITO");

    await page
      .locator('.leaflet-marker-icon[title^="MAPA QA DEFEITO"]')
      .click();
    await expect(page.getByTestId("cto-map-popup")).toBeVisible();

    const svg = marcadorSvg(page, "MAPA QA DEFEITO");
    await expect(svg).toHaveClass(/cto-box--selected/);

    /*
      As duas camadas ao mesmo tempo, e é esta a afirmação da fase.

          halo externo ..... seleção, na cor de foco
          contorno do corpo  estado, na cor do estado

      Uma caixa com defeito e selecionada mostra as duas. Se a seleção pintasse
      o corpo, clicar apagaria justamente a informação que fez alguém clicar.
    */
    const depois = await contornoDe(page, "MAPA QA DEFEITO");
    expect(depois, "a seleção mudou a cor do estado").toBe(antes);
    const vermelho = canais(depois);
    expect(vermelho.r).toBeGreaterThan(vermelho.g);

    const halo = await svg.evaluate((el) => {
      const s = getComputedStyle(el);
      return { cor: s.outlineColor, largura: parseFloat(s.outlineWidth) };
    });
    expect(halo.largura, "selecionado sem halo").toBeGreaterThan(0);
    // O halo é de OUTRA cor que o contorno: se fossem iguais, as duas camadas
    // se confundiriam e nada seria distinguível.
    expect(halo.cor).not.toBe(depois);
  });

  test("STATUSVIS-07 · o contorno sobrevive a Mapa, Satélite e Híbrido", async ({
    page,
  }) => {
    await login(page, ADMIN_EMAIL);
    await abrirMapaEm(page, 16);
    await expect(page.locator(".leaflet-marker-pane svg.cto-box")).toHaveCount(4, { timeout: 15_000 });

    for (const modo of ["normal", "satellite", "hybrid"]) {
      await page.getByTestId(`map-mode-${modo}`).click();
      await page.waitForTimeout(500);

      /*
        Sobre vegetação, telhado e asfalto não há fundo previsível.

        O que mantém o contorno perceptível é a sombra projetada do marcador
        mais a espessura do traço — os dois precisam continuar existindo em
        qualquer base, e é isso que se mede aqui.
      */
      const svg = marcadorSvg(page, "MAPA QA DEFEITO");
      const sombra = await svg.evaluate((el) => getComputedStyle(el).filter);
      expect(sombra, `sem sombra no modo ${modo}`).toContain("drop-shadow");

      const traco = await svg.locator(".cto-box__body").evaluate((el) => {
        const s = getComputedStyle(el);
        return { cor: s.stroke, largura: parseFloat(s.strokeWidth) };
      });
      expect(traco.largura, `traço fino demais no modo ${modo}`).toBeGreaterThanOrEqual(2);
      const c = canais(traco.cor);
      expect(c.r, `DAMAGED perdeu o vermelho no modo ${modo}`).toBeGreaterThan(c.g);

      // E o estado continua não dependendo só de cor: o selo segue lá.
      await expect(svg.locator(".cto-box__badge")).toHaveCount(1);
      await expect(svg.locator(".cto-box__glyph")).toHaveCount(1);
    }
  });
});

// ---------------------------------------------------------------------------
// CTO-3.2.1d — ajustar a posição da CTO pelo mapa
// ---------------------------------------------------------------------------

/**
 * Uma caixa SÓ para estas provas, e longe de todas as outras.
 *
 * Ela é movida de verdade, e movê-la é o ponto. Reaproveitar uma das quatro do
 * fixture faria um teste de posição mudar o enquadramento de que os testes de
 * estado e de plaqueta dependem — e a suíte passaria a falhar por ordem de
 * execução, que é a pior forma de flakiness porque parece defeito de código.
 *
 * `+0,1°` são cerca de 11 km: fora do recorte de qualquer outro teste, inclusive
 * do `z13` da política de densidade.
 */
const POS = { latitude: BASE.latitude + 0.1, longitude: BASE.longitude + 0.1 };
const NOME_POS = "MAPA QA POSICAO";
let ctoPosicaoId = "";

/** A coordenada gravada, lida direto do banco. */
async function coordenadaGravada() {
  const linha = await prisma.cTO.findUniqueOrThrow({
    where: { id: ctoPosicaoId },
  });
  return {
    latitude: linha.latitude === null ? null : Number(linha.latitude),
    longitude: linha.longitude === null ? null : Number(linha.longitude),
  };
}

/** Devolve a caixa ao ponto de origem, para cada teste começar igual. */
async function restaurarCoordenada() {
  await prisma.cTO.update({
    where: { id: ctoPosicaoId },
    data: { latitude: POS.latitude, longitude: POS.longitude },
  });
}

/** Abre o mapa enquadrado na caixa de posição. */
async function abrirMapaNaCaixaDePosicao(page: Page) {
  await interceptarTiles(page);
  await page.goto(`/mapa?lat=${POS.latitude}&lng=${POS.longitude}&z=17`);
  await expect(page.locator(".leaflet-container")).toBeVisible();
  await expect(marcadorDe(page, NOME_POS)).toBeVisible({ timeout: 15_000 });
}

/**
 * Onde o marcador está DENTRO do mapa.
 *
 * Medir contra o viewport misturava referenciais: assim que qualquer coisa
 * rola a página — e a `arrastar` rola, porque o ponteiro não alcança o que
 * está fora da dobra —, a mesma posição no mapa passa a ter outro `y` na
 * tela. A diferença medida foi de 41px, que é rolagem, não movimento de
 * caixa.
 *
 * Descontando a caixa do contêiner, a rolagem cancela e sobra o que o teste
 * quer saber: o marcador voltou para onde estava no mapa?
 */
async function posicaoNoMapa(page: Page) {
  const marcador = (await marcadorDe(page, NOME_POS).boundingBox())!;
  const mapa = (await page.locator(".leaflet-container").boundingBox())!;
  return { x: marcador.x - mapa.x, y: marcador.y - mapa.y };
}

/**
 * Espera o mapa PARAR de se mexer.
 *
 * A vista só é reescrita na URL no `moveend`, então a barra de endereço é o
 * sinal mais barato de "acabou". Duas leituras iguais em vez de um tempo fixo.
 *
 * Isto é necessário nos DOIS lados:
 *
 * - ao MEDIR, porque um centro velho comparado a um marcador já na posição
 *   nova dá erro puro de enquadramento — 25,9px, medidos;
 * - ao ARRASTAR, porque o `autoPan` do popup ainda pode estar em voo quando a
 *   caixa do marcador é lida. O ponteiro então desce onde o marcador ESTAVA,
 *   erra o alvo, e o que se arrasta é o mapa. Nada é gravado, o botão Salvar
 *   continua desabilitado, e o teste falha dizendo que a coordenada não mudou
 *   — intermitentemente, só quando a máquina está carregada.
 */
async function esperarMapaParar(page: Page) {
  let anterior = vistaDaUrl(page).toString();
  for (let i = 0; i < 20; i += 1) {
    await page.waitForTimeout(150);
    const atual = vistaDaUrl(page).toString();
    if (atual === anterior) return;
    anterior = atual;
  }
}

/**
 * Onde uma COORDENADA cai no mapa, segundo a vista corrente da URL.
 *
 * Web Mercator à mão, que é o que o Leaflet faz: `z` dá a escala, o centro
 * vem da barra de endereço, e a diferença projetada é o deslocamento em
 * pixels a partir do meio do contêiner.
 */
async function pontoDaCoordenada(page: Page, latitude: number, longitude: number) {
  const mapa = (await page.locator(".leaflet-container").boundingBox())!;
  const vista = vistaDaUrl(page);
  const escala = 256 * 2 ** Number(vista.get("z"));
  const projetar = (lat: number, lng: number) => {
    const seno = Math.sin((lat * Math.PI) / 180);
    return {
      x: ((lng + 180) / 360) * escala,
      y: (0.5 - Math.log((1 + seno) / (1 - seno)) / (4 * Math.PI)) * escala,
    };
  };
  const centro = projetar(Number(vista.get("lat")), Number(vista.get("lng")));
  const alvo = projetar(latitude, longitude);
  return {
    x: mapa.width / 2 + (alvo.x - centro.x),
    y: mapa.height / 2 + (alvo.y - centro.y),
  };
}

/**
 * O desvio entre onde o marcador ESTÁ e onde a coordenada GRAVADA cai.
 *
 * Esta é a grandeza que o teste de Cancelar precisa, e comparar pixels de tela
 * não era. Medido numa sonda: o mapa se desloca sozinho no meio da sequência —
 * o `autoPan` do popup, e a própria vista muda de `-20.397441` para
 * `-20.397129` durante o terceiro arrasto. Com o mapa se mexendo, a mesma
 * posição geográfica tem outro pixel, e o teste acusava o Cancelar de não
 * restaurar quando quem tinha se movido era o enquadramento.
 *
 * O desvio cancela tudo isso: ele é constante — é só o ancoramento do ícone —
 * enquanto o marcador estiver sobre a coordenada gravada, esteja o mapa onde
 * estiver.
 */
async function desvioDoGravado(page: Page) {
  await esperarMapaParar(page);
  const gravada = await coordenadaGravada();
  const esperado = await pontoDaCoordenada(
    page,
    gravada.latitude!,
    gravada.longitude!,
  );
  const atual = await posicaoNoMapa(page);
  return { x: atual.x - esperado.x, y: atual.y - esperado.y };
}

/**
 * Traz o marcador para o meio do mapa, arrastando o MAPA.
 *
 * O rascunho de posição não pode ser tocado por um reenquadramento de teste,
 * então quem se move é o mapa — a coordenada do marcador não muda, e as
 * medições comparam contra a coordenada gravada projetada (`desvioDoGravado`),
 * que é invariante a pan.
 *
 * O ponto de PEGADA é escolhido longe do marcador de propósito: em modo de
 * edição o marcador é arrastável, e começar o gesto em cima dele arrastaria a
 * caixa em vez do mapa.
 */
async function centralizarMarcador(page: Page, nome = NOME_POS) {
  const mapa = (await page.locator(".leaflet-container").boundingBox())!;
  const alvo = (await marcadorDe(page, nome).boundingBox())!;
  const centroX = mapa.x + mapa.width / 2;
  const centroY = mapa.y + mapa.height / 2;
  const alvoX = alvo.x + alvo.width / 2;
  const alvoY = alvo.y + alvo.height / 2;

  const dx = centroX - alvoX;
  const dy = centroY - alvoY;
  if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;

  // Um quarto da tela, do lado OPOSTO ao marcador: longe dele e dentro do mapa.
  const pegaX = alvoX > centroX ? mapa.x + mapa.width * 0.2 : mapa.x + mapa.width * 0.8;
  const pegaY = alvoY > centroY ? mapa.y + mapa.height * 0.25 : mapa.y + mapa.height * 0.75;

  await page.mouse.move(pegaX, pegaY);
  await page.mouse.down();
  await page.mouse.move(pegaX + dx, pegaY + dy, { steps: 12 });
  await page.mouse.up();
  await esperarMapaParar(page);
}

/** Arrasta o marcador por alguns pixels, como uma mão faria. */
async function arrastar(page: Page, dx: number, dy: number, nome = NOME_POS) {
  const alvo = marcadorDe(page, nome);
  await esperarMapaParar(page);

  /*
    RECENTRAR antes de cada arrasto, e não só quando o ponteiro erra.

    O marcador caminha: o `autoPan` do popup empurra a vista uns 111px ao abrir,
    e cada arrasto soma mais. Com o mapa em 400px de altura — a faixa foi
    refeita na `CTO-3.2.2b` — a caixa sai pela borda de baixo no segundo gesto,
    e medido: ela foi parar em `y=719` num mapa que termina em `697`, com o
    ponteiro caindo sobre um chip do resumo.

    Recentrando sempre, o gesto começa de um lugar previsível e o teste deixa de
    depender de quanto sobrou de mapa.
  */
  await centralizarMarcador(page, nome);
  await alvo.scrollIntoViewIfNeeded();

  const sobreOMarcador = async (px: number, py: number) =>
    page.evaluate(
      ([a, b]) => {
        const el = document.elementFromPoint(a, b);
        return Boolean(el && el.closest(".leaflet-marker-icon"));
      },
      [px, py],
    );

  const caixa = (await alvo.boundingBox())!;
  const x = caixa.x + caixa.width / 2;
  const y = caixa.y + caixa.height / 2;

  /*
    E ainda assim a pegada é CONFERIDA.

    Um arrasto que erra o alvo não dá erro: ele simplesmente não acontece, o
    teste segue adiante e quem reclama é alguma asserção lá na frente. Melhor
    uma falha que diz a verdade.
  */
  if (!(await sobreOMarcador(x, y))) {
    throw new Error(
      "o ponteiro não alcança o marcador: o arrasto não provaria nada",
    );
  }

  await page.mouse.move(x, y);
  await page.mouse.down();
  // Em passos: um salto único não produz os `mousemove` que o Leaflet escuta.
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 6 });
  await page.mouse.move(x + dx, y + dy, { steps: 6 });
  await page.mouse.up();
}

test.describe("Mapa Operacional — ADMIN ajusta a posição da CTO", () => {
  /*
    Janela alta, porque estes testes são sobre ARRASTAR — e o ponteiro não
    alcança o que está fora da dobra.

    O mapa tem altura fixa por decisão da `CTO-3.2.1b` (faixa de leitura, nunca
    fração de tela), então num viewport de 720px ele já termina abaixo dela. Abrir
    o popup ainda dispara o `autoPan`, que empurra o mapa para baixo para o popup
    caber — medido: o marcador foi parar em `y=761`, com `elementFromPoint`
    devolvendo NADA ali, e o arrasto simplesmente não acontecia.

    Rolar a página antes de cada arrasto resolvia o alcance e trocava o problema
    de lugar: as medições passavam a misturar rolagem com movimento de caixa.
    Uma janela de desktop alta é a condição real em que esta tela é usada, e
    deixa a geometria estável. A regra de altura tem teste próprio na `UXP-02`.
  */
  test.use({ viewport: { width: 1280, height: 1000 } });

  /*
    A caixa nasce e morre DENTRO deste `describe`, e isso foi corrigido depois de
    a suíte inteira quebrar.

    Ela começou num `beforeAll` de arquivo, e nove testes de outros blocos
    passaram a falhar com `locator.click: timeout`. A causa não é a distância em
    si: `getCtoMapInitialView` agrega **todas** as CTOs da empresa, então uma
    caixa 11 km ao lado força o `fitBounds` a afastar até tudo caber — e as
    quatro caixas originais, a 440 m umas das outras, colapsavam em poucos
    pixels e passavam a interceptar o clique umas das outras.

    O sintoma é traiçoeiro: `svg.cto-box` continuava visível, habilitado e
    estável, e o que o Playwright reclamava era que o marcador VIZINHO
    interceptava o ponteiro.

    E ele não apareceu em nenhuma das rodadas filtradas por `-g "MAPEDIT"`,
    porque o filtro escondia justamente os testes afetados. **Efeito colateral
    de fixture só aparece na suíte inteira.**
  */
  test.beforeAll(async () => {
    const cto = await criarCto(NOME_POS, {
      latitude: POS.latitude,
      longitude: POS.longitude,
    });
    ctoPosicaoId = cto.id;
  });

  test.afterAll(async () => {
    // Sai daqui mesmo, e não só na limpeza de arquivo: enquanto ela existir,
    // ela participa do enquadramento inicial de qualquer teste que rode depois.
    if (!ctoPosicaoId) return;
    await prisma.cTOPort.deleteMany({ where: { ctoId: ctoPosicaoId } });
    await prisma.cTO.deleteMany({ where: { id: ctoPosicaoId } });
  });

  test.beforeEach(async () => {
    await restaurarCoordenada();
  });

  test("MAPEDIT-01/02 · a ação é do ADMIN, e o DISPATCHER não a vê", async ({
    page,
  }) => {
    await login(page, ADMIN_EMAIL);
    await abrirMapaNaCaixaDePosicao(page);

    await marcadorDe(page, NOME_POS).click();
    await expect(page.getByTestId("cto-map-popup")).toBeVisible();
    await expect(page.getByTestId("cto-map-popup-edit-position")).toBeVisible();

    // E ela é SECUNDÁRIA: "Abrir CTO" continua sendo o caminho principal.
    await expect(page.getByTestId("cto-map-popup-open")).toBeVisible();
    const principal = (await page
      .getByTestId("cto-map-popup-open")
      .boundingBox())!;
    const secundaria = (await page
      .getByTestId("cto-map-popup-edit-position")
      .boundingBox())!;
    expect(
      secundaria.y,
      "a ação secundária precisa vir DEPOIS da principal",
    ).toBeGreaterThan(principal.y);

    // O DISPATCHER lê o mapa e não recebe escrita nenhuma.
    await page.context().clearCookies();
    await login(page, DISPATCHER_EMAIL);
    await abrirMapaNaCaixaDePosicao(page);
    await marcadorDe(page, NOME_POS).click();
    await expect(page.getByTestId("cto-map-popup")).toBeVisible();
    await expect(page.getByTestId("cto-map-popup-edit-position")).toHaveCount(0);
  });

  test("MAPEDIT-03/04 · fora do modo de edição nada é arrastável", async ({
    page,
  }) => {
    await login(page, ADMIN_EMAIL);
    await abrirMapaNaCaixaDePosicao(page);

    const svg = marcadorSvg(page, NOME_POS);
    await expect(svg).not.toHaveClass(/cto-box--editing/);

    /*
      Arrastar sem ter entrado em edição move o MAPA, não a caixa.

      É a prova de que o marcador não é arrastável por padrão: o gesto é o
      mesmo, e o que acontece é diferente.

      A asserção olha o CENTRO do mapa, e isso foi corrigido por uma sabotagem
      que passou. A primeira versão afirmava só que o banco não mudara — e a
      sabotagem `S1`, que deixa todo marcador arrastável, sobrevivia inteira a
      ela: com `draggable` sempre ligado o marcador se move na tela, mas nada é
      gravado, então "o banco não mudou" continua verdade. O teste media a
      consequência errada.

      Com o marcador inerte, o gesto é capturado pelo mapa e o centro anda. Com
      ele arrastável, o mapa fica parado — e é essa diferença que o detector
      precisa enxergar.
    */
    const antes = await coordenadaGravada();
    const centroAntes = vistaDaUrl(page).get("lat");
    await arrastar(page, 60, 40);
    await page.waitForTimeout(600);

    expect(
      vistaDaUrl(page).get("lat"),
      "o arrasto deveria ter movido o MAPA, e o mapa não saiu do lugar",
    ).not.toBe(centroAntes);
    expect(await coordenadaGravada()).toEqual(antes);
    await expect(page.getByTestId("cto-map-position-panel")).toHaveCount(0);

    // Entrando em edição, só ELA fica arrastável.
    await marcadorDe(page, NOME_POS).click();
    await page.getByTestId("cto-map-popup-edit-position").click();
    await expect(page.getByTestId("cto-map-position-panel")).toBeVisible();
    await expect(svg).toHaveClass(/cto-box--editing/);
    expect(
      await svg.evaluate((el) => getComputedStyle(el).cursor),
      "sem cursor de arrasto, nada promete que dá para arrastar",
    ).toBe("grab");

    // O popup saiu da frente da caixa que vai ser movida.
    await expect(page.getByTestId("cto-map-popup")).toHaveCount(0);
  });

  test("MAPEDIT-05/06/07 · arrastar não salva, e Cancelar devolve o ponto", async ({
    page,
  }) => {
    await login(page, ADMIN_EMAIL);
    await abrirMapaNaCaixaDePosicao(page);

    const antes = await coordenadaGravada();

    await marcadorDe(page, NOME_POS).click();
    await page.getByTestId("cto-map-popup-edit-position").click();
    await expect(page.getByTestId("cto-map-position-panel")).toBeVisible();

    /*
      A referência é capturada DEPOIS de entrar em edição, e isso foi medido.

      Abrir o popup dispara o `autoPan` do Leaflet, que move o mapa para o popup
      caber — 138 pixels, medidos numa sonda. Uma referência tirada antes do
      clique compararia dois enquadramentos diferentes, e o teste acusaria o
      Cancelar de não restaurar quando quem se moveu foi o mapa.

      Daqui em diante o enquadramento está estável: o painel é ancorado dentro
      do mapa e não desloca nada, e os arrastos abaixo são do marcador.
    */
    await page.waitForTimeout(400);
    const desvioOriginal = await desvioDoGravado(page);

    // Antes de qualquer arrasto não existe "nova posição" a mostrar.
    await expect(page.getByTestId("cto-map-position-after")).toHaveText("—");
    await expect(page.getByTestId("cto-map-position-save")).toBeDisabled();

    await arrastar(page, 70, 50);

    // O painel passou a mostrar um par novo...
    const depoisDoArrasto = await page
      .getByTestId("cto-map-position-after")
      .textContent();
    expect(depoisDoArrasto).not.toBe("—");
    await expect(page.getByTestId("cto-map-position-save")).toBeEnabled();

    // ...e o marcador saiu do lugar na tela.
    const arrastado = await desvioDoGravado(page);
    expect(Math.abs(arrastado.x - desvioOriginal.x)).toBeGreaterThan(20);

    /*
      MAPEDIT-06: o BANCO não mudou.

      É a afirmação inteira da fase. "Arrastou" e "salvou" são coisas
      diferentes, e a única prova disso é ler a linha.

      Esta conferência é RÁPIDA e, por ser rápida, é uma corrida — declarada.

      A sabotagem `S2`, que grava no `dragend`, caiu quando este teste rodou
      sozinho e PASSOU no conjunto: num processo mais carregado a escrita
      sabotada chegava depois da leitura. Um detector cujo veredito depende da
      carga da máquina não é detector.

      Tentei trocar o relógio por `waitForLoadState("networkidle")` e foi pior:
      ele resolve de imediato quando a página já terminou de carregar, então não
      esperava nada — e ainda derrubou o controle limpo.

      A conclusão é que o instante depois do arrasto não é o lugar de provar
      isso. Quem prova sem relógio nenhum é `MAPEDIT-06b`, que recarrega a
      página: aí a caixa vem do servidor, e não há tempo a acertar. Esta linha
      fica como sanidade barata, e a prova mora lá.
    */
    await page.waitForTimeout(700);
    expect(await coordenadaGravada()).toEqual(antes);

    /*
      MAPEDIT-07: Cancelar depois de VÁRIOS arrastos.

      O enunciado pede confiabilidade justamente depois de muitos eventos — e é
      onde uma implementação que fosse acumulando deltas erraria. Aqui não há
      acumulação: existe uma origem que nunca foi tocada.
    */
    await arrastar(page, -40, 30);
    await arrastar(page, 25, -60);
    await page.getByTestId("cto-map-position-cancel").click();

    await expect(page.getByTestId("cto-map-position-panel")).toHaveCount(0);
    await expect(marcadorSvg(page, NOME_POS)).not.toHaveClass(
      /cto-box--editing/,
    );

    const restaurado = await desvioDoGravado(page);
    expect(Math.abs(restaurado.x - desvioOriginal.x)).toBeLessThanOrEqual(2);
    expect(Math.abs(restaurado.y - desvioOriginal.y)).toBeLessThanOrEqual(2);
    expect(await coordenadaGravada()).toEqual(antes);
  });

  test("MAPEDIT-06b · arrastar e RECARREGAR devolve a caixa ao ponto gravado", async ({
    page,
  }) => {
    await login(page, ADMIN_EMAIL);
    await abrirMapaNaCaixaDePosicao(page);

    const antes = await coordenadaGravada();

    await marcadorDe(page, NOME_POS).click();
    await page.getByTestId("cto-map-popup-edit-position").click();
    await arrastar(page, 85, 65);
    await expect(page.getByTestId("cto-map-position-after")).not.toHaveText("—");

    /*
      A prova que NÃO depende de tempo.

      Conferir o banco logo depois do arrasto é uma corrida contra uma escrita
      que não deveria existir — e a sabotagem `S2` mostrou que essa corrida se
      perde num processo carregado. Recarregar remove o relógio da conta: a
      página inteira volta do servidor, e a caixa aparece onde o servidor a tem.

      Se o arrasto tivesse gravado, ela reapareceria no ponto arrastado. Ela
      reaparece no ponto de origem porque nada foi gravado.
    */
    await page.reload();
    await expect(marcadorDe(page, NOME_POS)).toBeVisible({ timeout: 15_000 });

    expect(await coordenadaGravada()).toEqual(antes);
    // E o modo de edição não sobrevive a um recarregamento: ele é de sessão.
    await expect(page.getByTestId("cto-map-position-panel")).toHaveCount(0);
    await expect(marcadorSvg(page, NOME_POS)).not.toHaveClass(
      /cto-box--editing/,
    );
  });

  test("MAPEDIT-08/14 · Salvar persiste, e a nova posição sobrevive ao reload", async ({
    page,
  }) => {
    await login(page, ADMIN_EMAIL);
    await abrirMapaNaCaixaDePosicao(page);

    const antes = await coordenadaGravada();

    await marcadorDe(page, NOME_POS).click();
    await page.getByTestId("cto-map-popup-edit-position").click();
    await arrastar(page, 80, 60);
    await page.getByTestId("cto-map-position-save").click();

    // Sai do modo de edição sozinho, sem erro na tela.
    await expect(page.getByTestId("cto-map-position-panel")).toHaveCount(0, {
      timeout: 15_000,
    });
    await expect(page.getByTestId("cto-map-position-error")).toHaveCount(0);

    const depois = await coordenadaGravada();
    expect(depois.latitude).not.toBe(antes.latitude);
    expect(depois.longitude).not.toBe(antes.longitude);
    // Arrastar para a direita e para baixo: longitude sobe, latitude desce.
    expect(depois.longitude!).toBeGreaterThan(antes.longitude!);
    expect(depois.latitude!).toBeLessThan(antes.latitude!);

    /*
      MAPEDIT-14: o reload é quem confirma.

      Estado local otimista mostraria a caixa no lugar novo mesmo se nada tivesse
      sido gravado. Recarregando, o que aparece vem do servidor.
    */
    /*
      Entrada NOVA, e não `reload()`.

      O `reload` herda a vista que estava na barra de endereço, e ela não é a
      de quando o teste começou: o `autoPan` do popup empurrou o mapa uns 219px
      para o norte. Somando o arrasto de 60px para o sul, a caixa reaparecia
      exatamente na borda inferior do recorte consultado — às vezes dentro,
      às vezes fora. Um teste de persistência não pode depender de qual lado da
      borda a caixa calhou de cair.

      Entrar de novo enquadrado na coordenada ORIGINAL mantém o que importa —
      o que aparece vem do servidor, não de estado local otimista — e tira a
      vista herdada da equação. Se nada tivesse sido gravado, a caixa estaria
      no centro, e não deslocada para sudeste.
    */
    await page.goto(`/mapa?lat=${POS.latitude}&lng=${POS.longitude}&z=17`);
    await expect(page.locator(".leaflet-container")).toBeVisible();
    await expect(marcadorDe(page, NOME_POS)).toBeVisible({ timeout: 15_000 });

    await marcadorDe(page, NOME_POS).click();
    await expect(page.getByTestId("cto-map-popup")).toBeVisible();
    // O popup abre no ponto novo, e o estado da caixa continua o mesmo.
    await expect(page.getByTestId("cto-map-popup-status")).toContainText(
      "Com vaga",
    );
    expect(await coordenadaGravada()).toEqual(depois);
  });

  test("MAPEDIT-09/10 · durante o arrasto a plaqueta acompanha e o estado fica", async ({
    page,
  }) => {
    await login(page, ADMIN_EMAIL);
    await abrirMapaNaCaixaDePosicao(page);

    /*
      A referência é capturada ANTES de entrar em edição, e isso foi corrigido
      por uma sabotagem que passou.

      A primeira versão media o contorno depois de já estar em modo de edição, e
      comparava antes/depois do ARRASTO. A sabotagem `S10` — que pinta o corpo
      com a cor de edição — sobrevivia inteira a essa comparação: os dois
      valores já vinham sabotados, e iguais. Comparar dois erros dá igualdade.

      A pergunta certa é se ENTRAR em modo de edição muda o estado, e para
      respondê-la a referência tem de vir de fora dele.
    */
    const svg = marcadorSvg(page, NOME_POS);
    const contornoAntes = await contornoDe(page, NOME_POS);

    await marcadorDe(page, NOME_POS).click();
    await page.getByTestId("cto-map-popup-edit-position").click();
    await expect(svg).toHaveClass(/cto-box--editing/);

    expect(
      await contornoDe(page, NOME_POS),
      "entrar em edição repintou o contorno de estado",
    ).toBe(contornoAntes);

    await arrastar(page, 90, 70);

    /*
      MAPEDIT-09: a plaqueta ficou junto.

      O rótulo é um tooltip do Leaflet preso ao marcador, então ele acompanha
      nativamente — mas "acompanha" é afirmação de posição, e só a medição a
      sustenta. Uma plaqueta que ficasse para trás apontaria para o lugar errado
      com o nome certo, que é pior que não ter plaqueta.
    */
    const marcador = (await marcadorDe(page, NOME_POS).boundingBox())!;
    const plaqueta = (await plaquetaDe(page, NOME_POS).boundingBox())!;
    const centroMarcador = marcador.x + marcador.width / 2;
    const centroPlaqueta = plaqueta.x + plaqueta.width / 2;
    expect(
      Math.abs(centroPlaqueta - centroMarcador),
      "a plaqueta ficou para trás no arrasto",
    ).toBeLessThanOrEqual(8);
    expect(
      plaqueta.y + plaqueta.height,
      "a plaqueta precisa continuar ACIMA do marcador",
    ).toBeLessThanOrEqual(marcador.y + 2);

    /*
      MAPEDIT-10: o estado NÃO muda de cor por estar sendo movido.

      Modo de edição é gesto de interface; verde/amarelo/vermelho são operação.
      Misturá-los faria alguém ler que a caixa mudou de situação por ter sido
      arrastada.
    */
    expect(await contornoDe(page, NOME_POS)).toBe(contornoAntes);
    await expect(svg).toHaveClass(/cto-box--success/);
    await expect(svg.locator(".cto-box__badge")).toHaveCount(1);

    // E o halo de edição é TRACEJADO, distinto do halo sólido da seleção.
    expect(await svg.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe(
      "dashed",
    );

    await page.getByTestId("cto-map-position-cancel").click();
  });

  test("MAPEDIT-11 · falha ao salvar aparece, e nada é gravado", async ({
    page,
  }) => {
    await login(page, ADMIN_EMAIL);
    await abrirMapaNaCaixaDePosicao(page);

    const antes = await coordenadaGravada();

    // O servidor recusa. O que importa é o que a tela faz com isso.
    await page.route("**/api/ctos/**", (route) => {
      if (route.request().method() === "PATCH") {
        return route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ ok: false, error: "Falha ao salvar." }),
        });
      }
      return route.fallback();
    });

    await marcadorDe(page, NOME_POS).click();
    await page.getByTestId("cto-map-popup-edit-position").click();
    await arrastar(page, 60, 40);
    await page.getByTestId("cto-map-position-save").click();

    /*
      O erro é VISÍVEL, e o modo de edição CONTINUA.

      É a alternativa mais honesta: o marcador fica onde a mão o deixou, mas o
      painel segue na tela dizendo "Ajustando posição" com o erro ao lado —
      ninguém confunde isso com uma posição salva. Devolver o marcador ao ponto
      antigo apagaria o trabalho de quem acabou de posicionar a caixa por causa
      de uma falha que pode ser de rede.
    */
    const erro = page.getByTestId("cto-map-position-error");
    await expect(erro).toBeVisible();
    await expect(page.getByTestId("cto-map-position-panel")).toBeVisible();

    // E a mensagem não vaza detalhe interno.
    const texto = (await erro.textContent()) ?? "";
    for (const proibido of ["prisma", "Prisma", "SELECT", "cTO", "at Object"]) {
      expect(texto, `a mensagem vaza ${proibido}`).not.toContain(proibido);
    }

    expect(await coordenadaGravada()).toEqual(antes);

    // Dá para desistir depois do erro, e desistir também não grava.
    await page.getByTestId("cto-map-position-cancel").click();
    await expect(page.getByTestId("cto-map-position-panel")).toHaveCount(0);
    expect(await coordenadaGravada()).toEqual(antes);
  });

  test("MAPEDIT-12/13 · pan, zoom e troca de base durante a edição", async ({
    page,
  }) => {
    const erros = coletarErros(page);
    await login(page, ADMIN_EMAIL);
    await abrirMapaNaCaixaDePosicao(page);

    const antes = await coordenadaGravada();

    await marcadorDe(page, NOME_POS).click();
    await page.getByTestId("cto-map-popup-edit-position").click();
    await expect(page.getByTestId("cto-map-position-panel")).toBeVisible();

    /*
      Satélite e Híbrido são justamente as melhores bases para achar o poste, e
      por isso trocar de base durante a edição precisa continuar valendo — sem
      que a troca seja confundida com uma alteração da CTO.
    */
    for (const modo of ["satellite", "hybrid", "normal"]) {
      await page.getByTestId(`map-mode-${modo}`).click();
      await page.waitForTimeout(400);
      await expect(
        page.getByTestId("cto-map-position-panel"),
        `o painel morreu ao trocar para ${modo}`,
      ).toBeVisible();
    }
    expect(await coordenadaGravada()).toEqual(antes);

    /*
      Arrastar o MAPA durante a edição dispara releitura do recorte. A caixa em
      edição precisa sobreviver a isso — com só o id em mãos, ela sumiria
      debaixo da mão e levaria o painel junto.
    */
    await page.mouse.move(200, 200);
    await page.mouse.down();
    await page.mouse.move(320, 260, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(900);

    await expect(page.getByTestId("cto-map-position-panel")).toBeVisible();
    await expect(marcadorDe(page, NOME_POS)).toBeVisible();

    await page.getByTestId("cto-map-position-cancel").click();
    expect(await coordenadaGravada()).toEqual(antes);

    // MAPEDIT-12: nenhum laço de render durante tudo isso.
    expect(
      erros.filter((e) => /Maximum update depth|too many re-renders/i.test(e)),
    ).toEqual([]);
  });

  test("MAPEDIT-04b · abrir o painel NÃO empurra o mapa", async ({ page }) => {
    await login(page, ADMIN_EMAIL);
    await abrirMapaNaCaixaDePosicao(page);

    /*
      Regressão medida e corrigida nesta fase.

      A primeira versão renderizava o painel no fluxo da página, acima do mapa:
      entrar em edição descia o mapa **206 pixels**, ou seja, o mapa saltava
      debaixo da mão no instante exato em que a pessoa vai arrastar com
      precisão. Ancorado dentro do mapa, nada no fluxo se move.

      A moldura é a referência certa — o marcador não serve, porque o `autoPan`
      do popup o desloca legitimamente ao abrir.
    */
    /*
      A medida é relativa ao DOCUMENTO, e não à viewport.

      `boundingBox()` devolve coordenada de viewport, e o `.click()` do Playwright
      rola a página para trazer o alvo à vista. O popup abre perto do topo do
      mapa, então clicar em "Ajustar posição" às vezes rola — e a moldura mudava
      de `y` sem que nada no layout tivesse se mexido. O teste acusava um
      deslocamento que era da barra de rolagem, e falhava de forma intermitente.

      Somando `window.scrollY`, a rolagem sai da conta e sobra a única pergunta
      que interessa: o painel empurrou o mapa no layout?
    */
    const topoNoDocumento = () =>
      page
        .getByTestId("operational-map")
        .evaluate((el) => el.getBoundingClientRect().top + window.scrollY);

    const molduraAntes = await topoNoDocumento();
    const alturaAntes = (await page.getByTestId("operational-map").boundingBox())!
      .height;

    await marcadorDe(page, NOME_POS).click();
    await page.getByTestId("cto-map-popup-edit-position").click();
    await expect(page.getByTestId("cto-map-position-panel")).toBeVisible();

    const molduraDepois = await topoNoDocumento();
    expect(
      Math.abs(molduraDepois - molduraAntes),
      `o mapa desceu ${(molduraDepois - molduraAntes).toFixed(0)}px ao abrir o painel`,
    ).toBeLessThanOrEqual(1);
    expect(
      (await page.getByTestId("operational-map").boundingBox())!.height,
    ).toBe(alturaAntes);

    // E o painel está DENTRO da moldura, onde ele não some da vista.
    const dentro = await page
      .getByTestId("cto-map-position-panel")
      .evaluate((el) => {
        const moldura = document
          .querySelector('[data-testid="operational-map"]')!
          .getBoundingClientRect();
        const painel = el.getBoundingClientRect();
        return (
          painel.top >= moldura.top - 1 && painel.bottom <= moldura.bottom + 1
        );
      });
    expect(dentro, "o painel escapou da moldura do mapa").toBe(true);

    await page.getByTestId("cto-map-position-cancel").click();
  });

  test("MAPEDIT-13b · a vista do mapa sobrevive ao salvamento", async ({
    page,
  }) => {
    await login(page, ADMIN_EMAIL);
    await abrirMapaNaCaixaDePosicao(page);

    await page.getByTestId("map-mode-hybrid").click();
    await expect(page.getByTestId("map-mode-hybrid")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const zoomAntes = vistaDaUrl(page).get("z");

    await marcadorDe(page, NOME_POS).click();
    await page.getByTestId("cto-map-popup-edit-position").click();
    await arrastar(page, 50, 40);
    await page.getByTestId("cto-map-position-save").click();
    await expect(page.getByTestId("cto-map-position-panel")).toHaveCount(0, {
      timeout: 15_000,
    });

    // Mover a caixa não é navegar: zoom e base continuam onde estavam.
    expect(vistaDaUrl(page).get("z")).toBe(zoomAntes);
    await expect(page.getByTestId("map-mode-hybrid")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});

// ---------------------------------------------------------------------------
// CTO-3.2.2 — camadas de cliente e de OS aberta
// ---------------------------------------------------------------------------

/**
 * Fixtures PRÓPRIAS, longe de todas as outras — a lição da `CTO-3.2.1d`.
 *
 * Naquela fase uma caixa criada num `beforeAll` de arquivo alargou o
 * `fitBounds` de toda a empresa e fez nove testes de outros blocos falharem com
 * `locator.click: timeout`, porque os marcadores originais colapsaram e
 * passaram a interceptar o clique uns dos outros.
 *
 * Aqui nada é criado fora deste `describe`, tudo é removido no `afterAll`, e as
 * coordenadas ficam a `+0,2°` — cerca de 22 km — do resto do arquivo.
 */
const LAYER_BASE = { latitude: BASE.latitude + 0.2, longitude: BASE.longitude + 0.2 };

interface FixtureDeCamadas {
  ctoId: string;
  online: string;
  offline: string;
  semLeitura: string;
  semLocal: string;
  ordemId: string;
  ordemNumero: number;
}

let camadas: FixtureDeCamadas;
const clientesCriados: string[] = [];
const ordensCriadas: string[] = [];
const ctosDeCamada: string[] = [];

async function criarClienteE2E(
  nome: string,
  opcoes: { lat?: number | null; lng?: number; ativo?: boolean } = {},
) {
  const cliente = await prisma.customer.create({
    data: { companyId, name: nome, active: opcoes.ativo ?? true },
  });
  clientesCriados.push(cliente.id);
  if (opcoes.lat !== null) {
    await prisma.customerLocation.create({
      data: {
        companyId,
        customerId: cliente.id,
        latitude: opcoes.lat ?? LAYER_BASE.latitude,
        longitude: opcoes.lng ?? LAYER_BASE.longitude,
        source: "MANUAL",
      },
    });
  }
  return cliente;
}

test.describe("Mapa Operacional — camadas de cliente e OS", () => {
  test.beforeAll(async () => {
    const online = await criarClienteE2E("CAMADA CLIENTE ONLINE");
    const offline = await criarClienteE2E("CAMADA CLIENTE OFFLINE", {
      lat: LAYER_BASE.latitude + 0.0008,
    });
    const semLeitura = await criarClienteE2E("CAMADA CLIENTE SEM LEITURA", {
      lat: LAYER_BASE.latitude - 0.0008,
    });
    const semLocal = await criarClienteE2E("CAMADA CLIENTE SEM LOCAL", {
      lat: null,
    });

    for (const [customerId, status] of [
      [online.id, "ONLINE"],
      [offline.id, "OFFLINE"],
    ] as const) {
      await prisma.customerDiagnosticSnapshot.create({
        data: {
          companyId,
          customerId,
          externalProvider: "MOCK",
          connectivityStatus: status,
          observedAt: new Date(),
        },
      });
    }

    // O OFFLINE também tem OS aberta: os dois sinais precisam conviver.
    const ordem = await prisma.serviceOrder.create({
      data: {
        companyId,
        number: 8800,
        customerId: offline.id,
        type: "REPARO",
        description: "OS da camada",
        status: "ASSIGNED",
      },
    });
    ordensCriadas.push(ordem.id);

    /*
      Uma OS URGENTE, para o contrato visual de urgência.

      Ela vai no cliente SEM LEITURA, que ainda não tinha OS: assim a contagem
      de pontos continua 3, o `danger + with-order` continua sendo um só (o
      cliente OFFLINE), e nasce um segundo losango — este vermelho — num ponto
      diferente do primeiro.

      `URGENT` é escrito no campo que o domínio usa para isso. Nada aqui deduz
      urgência de tipo, título ou tempo em aberto.
    */
    const urgente = await prisma.serviceOrder.create({
      data: {
        companyId,
        number: 8802,
        customerId: semLeitura.id,
        type: "REPARO",
        description: "OS urgente da camada",
        status: "ASSIGNED",
        priority: "URGENT",
      },
    });
    ordensCriadas.push(urgente.id);

    // Uma OS aberta de cliente SEM localização: contador, nunca marcador falso.
    const orfa = await prisma.serviceOrder.create({
      data: {
        companyId,
        number: 8801,
        customerId: semLocal.id,
        type: "REPARO",
        description: "OS sem local",
        status: "PENDING",
      },
    });
    ordensCriadas.push(orfa.id);

    const cto = await criarCto("CAMADA CAIXA", {
      latitude: LAYER_BASE.latitude,
      longitude: LAYER_BASE.longitude,
    });
    ctosDeCamada.push(cto.id);
    for (const [customerId, porta] of [
      [online.id, 1],
      [offline.id, 2],
    ] as const) {
      const p = await prisma.cTOPort.findFirstOrThrow({
        where: { ctoId: cto.id, number: porta },
      });
      await prisma.customerNetworkConnection.create({
        data: {
          companyId,
          customerId,
          ctoPortId: p.id,
          source: "WEB",
          connectedAt: new Date(),
        },
      });
    }

    camadas = {
      ctoId: cto.id,
      online: online.id,
      offline: offline.id,
      semLeitura: semLeitura.id,
      semLocal: semLocal.id,
      ordemId: ordem.id,
      ordemNumero: ordem.number,
    };
  });

  test.afterAll(async () => {
    await prisma.serviceOrder.deleteMany({ where: { id: { in: ordensCriadas } } });
    await prisma.customerNetworkConnection.deleteMany({
      where: { customerId: { in: clientesCriados } },
    });
    await prisma.cTOPort.deleteMany({ where: { ctoId: { in: ctosDeCamada } } });
    await prisma.cTO.deleteMany({ where: { id: { in: ctosDeCamada } } });
    await prisma.customerDiagnosticSnapshot.deleteMany({
      where: { customerId: { in: clientesCriados } },
    });
    await prisma.customerLocation.deleteMany({
      where: { customerId: { in: clientesCriados } },
    });
    await prisma.customer.deleteMany({ where: { id: { in: clientesCriados } } });
  });

  /**
   * A vista depois de o mapa PARAR de se mexer.
   *
   * Abrir um popup dispara o `autoPan` do Leaflet, e a URL só é reescrita no
   * `moveend` seguinte. Ler a barra de endereço no instante do clique captura o
   * enquadramento ANTERIOR ao deslocamento — e a comparação depois da volta
   * acusa uma diferença que é do popup, não da navegação.
   *
   * A `CTO-3.2.1d` já tinha medido esse deslocamento em 138px. Aqui a saída é
   * esperar duas leituras iguais em vez de cravar um tempo.
   */
  async function vistaEstavel(page: Page) {
    let anterior = vistaDaUrl(page).toString();
    for (let i = 0; i < 20; i += 1) {
      await page.waitForTimeout(150);
      const atual = vistaDaUrl(page).toString();
      if (atual === anterior) return vistaDaUrl(page);
      anterior = atual;
    }
    return vistaDaUrl(page);
  }

  async function abrirCamadas(page: Page, email = ADMIN_EMAIL, zoom = 16) {
    await login(page, email);
    await interceptarTiles(page);
    /*
      O zoom vem pela URL, e não pela roda do mouse.

      A roda avança por quantidades que dependem do navegador e centra no
      cursor; medir escala com ela mistura duas variáveis. Pela URL o teste
      declara o degrau que quer.
    */
    await page.goto(
      `/mapa?lat=${LAYER_BASE.latitude}&lng=${LAYER_BASE.longitude}&z=${zoom}`,
    );
    await expect(page.locator(".leaflet-container")).toBeVisible();
    await expect(page.getByTestId("map-layer-control")).toBeVisible();
  }

  /*
    # Estabilidade do mapa — o defeito era UM só, com três sintomas

    O dono relatou três coisas separadas: a CTO abre e some, os pontos de
    cliente somem no zoom, e o mapa se mexe sozinho. Sondas mostraram que era
    a mesma cadeia:

    1. clicar numa caixa abre o popup;
    2. o `autoPan` do Leaflet empurra a vista — medido em **291px**, porque o
       popup tinha 520px num mapa de 558;
    3. o `moveend` do empurrão dispara a releitura com o recorte NOVO;
    4. a caixa clicada fica FORA desse recorte, o servidor não a devolve, o
       marcador é desmontado e **o popup morre junto** — 750ms depois do
       clique, medido.

    A cura de raiz é o recorte com folga (`MAP_VIEWPORT_PADDING_RATIO`): o
    cliente guarda mais do que mostra, então um deslocamento pequeno não muda
    a resposta. O popup encolhido (321px) reduziu o empurrão a 111px.
  */
  test("STAB-01 · o popup da CTO continua aberto depois do clique", async ({
    page,
  }) => {
    await abrirCamadas(page);
    await expect(page.locator(".leaflet-marker-pane svg.cto-box").first()).toBeVisible({
      timeout: 15_000,
    });

    const releituras: number[] = [];
    page.on("response", (r) => {
      if (r.url().includes("/api/ctos/map?")) releituras.push(1);
    });

    await page.locator('.leaflet-marker-icon[title^="CAMADA CAIXA"]').click();
    await expect(page.getByTestId("cto-map-popup")).toBeVisible();

    /*
      Esperar a RELEITURA acontecer, e não um tempo qualquer.

      É ela que derrubava o popup. Um teste que só olhasse o instante do
      clique passaria com o defeito vivo, porque a morte chega depois.
    */
    await expect
      .poll(() => releituras.length, { timeout: 15_000 })
      .toBeGreaterThanOrEqual(1);
    await page.waitForTimeout(1200);

    await expect(
      page.getByTestId("cto-map-popup"),
      "o popup fechou sozinho depois da releitura",
    ).toBeVisible();
    await expect(page.getByTestId("cto-map-popup")).toContainText("CAMADA CAIXA");
  });

  test("STAB-02 · o zoom não apaga os pontos de cliente", async ({ page }) => {
    await abrirCamadas(page);
    await page.getByTestId("map-layer-customers").check();
    await expect(page.locator(".leaflet-marker-pane svg.cto-dot")).toHaveCount(3, { timeout: 15_000 });

    /*
      O zoom da roda centra no CURSOR, e por isso ele vai no MEIO do mapa.

      Com o ponteiro acima do centro, a vista sobe e o cliente ao sul sai de
      cena por direito — o teste acusaria o código de um sumiço que é do
      gesto. Medido: `3,3,3,3,2,2,2,2,2,2` com o cursor a 150px do topo.
    */
    const area = (await page.locator(".leaflet-container").boundingBox())!;
    await page.mouse.move(area.x + area.width / 2, area.y + Math.min(area.height, 500) / 2);

    /*
      Amostragem DURANTE e depois do zoom.

      O que o dono via era o ponto sumir; medir só o estado final esconderia
      um apagão intermediário. Aqui a contagem é lida dez vezes, e o mínimo
      observado é que precisa se sustentar.
      Com o recorte colado no viewport, um zoom de um passo derrubava de 3
      para 1 — os clientes das bordas saíam do recorte pedido ao servidor.
    */
    await page.mouse.wheel(0, -120);
    const amostras: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      amostras.push(await page.locator(".leaflet-marker-pane svg.cto-dot").count());
      await page.waitForTimeout(200);
    }
    expect(
      Math.min(...amostras),
      `os pontos sumiram durante o zoom: ${amostras.join(",")}`,
    ).toBeGreaterThanOrEqual(3);
  });

  test("STAB-03 · o mapa não se recentraliza sozinho depois do pan", async ({
    page,
  }) => {
    await abrirCamadas(page);
    await page.getByTestId("map-layer-customers").check();
    await expect(page.locator(".leaflet-marker-pane svg.cto-dot").first()).toBeVisible({
      timeout: 15_000,
    });

    const area = (await page.locator(".leaflet-container").boundingBox())!;
    const x = area.x + area.width * 0.3;
    const y = area.y + 140;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 90, y + 70, { steps: 12 });
    await page.mouse.up();

    // Deixa a vista assentar e a releitura chegar.
    await page.waitForTimeout(1500);
    const assentado = vistaDaUrl(page).toString();

    /*
      Depois de assentar, NADA pode mexer a vista.

      Três segundos cobrem a releitura das três camadas com folga. Qualquer
      deriva aqui é o mapa se movendo sem ninguém pedir — que é exatamente o
      que o dono relatou.
    */
    await page.waitForTimeout(3000);
    expect(
      vistaDaUrl(page).toString(),
      "a vista mudou sozinha depois do pan",
    ).toBe(assentado);
  });


  /*
    A FOLGA do recorte, afirmada no contrato e não num sintoma.

    Este teste existe porque a prova por sintoma ficou fraca de propósito: ao
    encolher o popup de 520px para 321px, o empurrão do `autoPan` caiu de
    291px para 111px, e com um empurrão pequeno o marcador não sai nem de um
    recorte colado no viewport. Zerar a folga deixou de derrubar a `STAB-01`.

    Uma proteção que nenhum teste derruba é uma proteção que alguém apaga na
    próxima limpeza. Aqui a afirmação é sobre o que vai no fio: o recorte
    PEDIDO tem de ser maior que o visível.
  */
  test("STAB-04 · o recorte pedido ao servidor é maior que a tela", async ({
    page,
  }) => {
    const pedidos: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/api/ctos/map?")) pedidos.push(r.url());
    });

    await abrirCamadas(page);
    await expect(page.locator(".leaflet-marker-pane svg.cto-box").first()).toBeVisible({
      timeout: 15_000,
    });
    await expect.poll(() => pedidos.length).toBeGreaterThan(0);

    const ultimo = new URL(pedidos[pedidos.length - 1]);
    const north = Number(ultimo.searchParams.get("north"));
    const south = Number(ultimo.searchParams.get("south"));

    const vista = vistaDaUrl(page);
    const latitude = Number(vista.get("lat"));
    const zoom = Number(vista.get("z"));
    const altura = (await page.locator(".leaflet-container").boundingBox())!.height;

    /*
      Quanto o mapa MOSTRA, em graus de latitude — Web Mercator, o mesmo
      cálculo que o Leaflet faz.
    */
    const metrosPorPixel =
      (156543.03392 * Math.cos((latitude * Math.PI) / 180)) / 2 ** zoom;
    const visivelEmGraus = (altura * metrosPorPixel) / 111_320;
    const pedidoEmGraus = north - south;

    expect(
      pedidoEmGraus / visivelEmGraus,
      "o recorte pedido está colado no viewport: um deslocamento pequeno vai " +
        "apagar o que está na tela",
    ).toBeGreaterThan(1.3);
  });


  test("STAB-05 · o cartão de camadas não cobre os controles do mapa", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await abrirCamadas(page);
    await page.getByTestId("map-layer-customers").check();
    await expect(page.locator(".leaflet-control-zoom")).toBeVisible();

    const controle = (await page.getByTestId("map-layer-control").boundingBox())!;
    const zoom = (await page.locator(".leaflet-control-zoom").boundingBox())!;

    /*
      Sem INTERSEÇÃO, e não "está em outro lugar".

      O defeito que o dono relatou era o cartão por cima dos botões `+`/`−`, que
      moram no canto superior esquerdo do mapa. Comparar só coordenadas de topo
      deixaria passar uma sobreposição lateral.
    */
    const cruza =
      controle.x < zoom.x + zoom.width &&
      zoom.x < controle.x + controle.width &&
      controle.y < zoom.y + zoom.height &&
      zoom.y < controle.y + controle.height;
    expect(
      cruza,
      `o cartão de camadas cobre o zoom: camadas=${JSON.stringify(controle)} zoom=${JSON.stringify(zoom)}`,
    ).toBe(false);

    // E os botões respondem ao ponteiro, que é o que a sobreposição roubava.
    await expect(page.locator(".leaflet-control-zoom-in")).toBeVisible();
    await page.locator(".leaflet-control-zoom-in").click();
  });

  test("VIS-01 · a legenda nomeia caixas, clientes e OS", async ({ page }) => {
    await abrirCamadas(page);
    await page.getByTestId("map-layer-customers").check();
    await expect(page.locator(".leaflet-marker-pane svg.cto-dot").first()).toBeVisible({
      timeout: 15_000,
    });

    const legenda = page.getByTestId("map-legend");
    await expect(legenda).toBeVisible();
    await expect(legenda.getByTestId("map-legend-ctos")).toBeVisible();
    await expect(legenda.getByTestId("map-legend-customers")).toBeVisible();
    await expect(legenda.getByTestId("map-legend-orders")).toBeVisible();

    // Os quatro estados da caixa e os três do cliente, por extenso. A lista
    // exata e ordenada de cada grupo é da `LEGEND-01..06`.
    for (const termo of [
      "Com vaga",
      "Sem vaga",
      "Com defeito",
      "Inativa",
      "Cliente online",
      "Cliente offline",
      "Sem leitura",
      "OS aberta",
    ]) {
      await expect(legenda).toContainText(termo);
    }

    /*
      Grupo de camada DESLIGADA não aparece.

      Explicar símbolo que não está na tela é ruído, e a legenda cresceria
      justamente onde o espaço vertical é disputado.
    */
    await page.getByTestId("map-layer-customers").uncheck();
    await expect(legenda.getByTestId("map-legend-customers")).toHaveCount(0);
  });

  test("VIS-02 · o resumo operacional fica na primeira dobra", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await abrirCamadas(page);
    await page.getByTestId("map-layer-customers").check();
    await expect(page.locator(".leaflet-marker-pane svg.cto-dot").first()).toBeVisible({
      timeout: 15_000,
    });

    const resumo = page.getByTestId("map-summary");
    await expect(resumo).toBeVisible();
    await expect(resumo.getByTestId("map-marker-count")).toBeVisible();
    await expect(resumo.getByTestId("map-customer-count")).toBeVisible();
    await expect(resumo.getByTestId("map-order-count")).toBeVisible();

    // Numérica, e não `toBeInViewport()`: aquele matcher aceita qualquer
    // interseção, e um resumo com um terço visível ainda passaria.
    const caixa = (await resumo.boundingBox())!;
    expect(
      caixa.y + caixa.height,
      "o resumo saiu da primeira dobra",
    ).toBeLessThanOrEqual(900);
  });

  test("VIS-03 · CUSTOMERVIS-03..06 · cada estado do cliente tem a sua cor e a sua forma", async ({
    page,
  }) => {
    await abrirCamadas(page);
    await page.getByTestId("map-layer-customers").check();
    await expect(page.locator(".leaflet-marker-pane svg.cto-dot")).toHaveCount(3, {
      timeout: 15_000,
    });

    const lido = await page.evaluate(() => {
      const saida: Record<string, { fill: string; tracejado: string; traco: string }> = {};
      for (const [titulo, chave] of [
        ["CAMADA CLIENTE ONLINE", "online"],
        ["CAMADA CLIENTE OFFLINE", "offline"],
        ["CAMADA CLIENTE SEM LEITURA", "semLeitura"],
      ] as const) {
        const corpo = document.querySelector(
          `.leaflet-marker-icon[title^="${titulo}"] .cto-dot__body`,
        );
        if (!corpo) continue;
        const estilo = getComputedStyle(corpo);
        saida[chave] = {
          fill: estilo.fill,
          tracejado: estilo.strokeDasharray,
          traco: estilo.stroke,
        };
      }
      return saida;
    });

    const canais = (cor: string) => (cor.match(/\d+(\.\d+)?/g) ?? []).map(Number);

    // Verde: o canal verde domina.
    const on = canais(lido.online.fill);
    expect(on[1], `online não está verde: ${lido.online.fill}`).toBeGreaterThan(on[0]);

    // Vermelho: o canal vermelho domina.
    const off = canais(lido.offline.fill);
    expect(off[0], `offline não está vermelho: ${lido.offline.fill}`).toBeGreaterThan(off[1]);

    /*
      E "sem leitura" não é só uma cor a menos: ele é OCO e TRACEJADO.

      Cor sozinha não distingue para quem não a enxerga, e um glifo de 7px é
      ilegível num ponto de 16px — quem carrega a diferença é a forma.
    */
    expect(lido.semLeitura.fill).toBe("none");
    expect(
      lido.semLeitura.tracejado,
      "sem leitura precisa ser tracejado, e não só cinza",
    ).not.toBe("none");

    /*
      CUSTOMERVIS-05: e o contorno dele é NEUTRO.

      Os três canais próximos: nem verde de online, nem vermelho de offline.
      Um "sem leitura" pintado com a cor de um dos outros dois diria um estado
      que ninguém leu.
    */
    const neutro = canais(lido.semLeitura.traco);
    expect(
      Math.max(...neutro.slice(0, 3)) - Math.min(...neutro.slice(0, 3)),
      `sem leitura deveria ser neutro: ${lido.semLeitura.traco}`,
    ).toBeLessThan(40);

    // O anel de OS convive com o estado, e não o substitui.
    const comOs = page.locator(
      ".leaflet-marker-pane svg.cto-dot.cto-dot--danger.cto-dot--with-order",
    );
    await expect(comOs).toHaveCount(1);
    await expect(comOs.locator(".cto-dot__order")).toHaveCount(1);
    await expect(comOs.locator(".cto-dot__body")).toHaveCount(1);
  });

  test("VIS-04 · a OS é visível e menor que a caixa", async ({ page }) => {
    await abrirCamadas(page);
    await expect(page.locator(".leaflet-marker-pane svg.cto-order").first()).toBeVisible({
      timeout: 15_000,
    });

    const os = (await page
      .locator(".leaflet-marker-pane svg.cto-order")
      .first()
      .boundingBox())!;
    const caixa = (await page
      .locator(".leaflet-marker-pane svg.cto-box")
      .first()
      .boundingBox())!;

    /*
      Visível, e sem disputar protagonismo.

      A caixa é a infraestrutura; a OS é o trabalho aberto em cima dela. Se a OS
      ficasse maior, o mapa passaria a ser lido pelo que está quebrado em vez do
      que existe.
    */
    expect(os.width, "a OS sumiu do mapa").toBeGreaterThan(8);
    expect(
      os.width * os.height,
      "a OS está disputando protagonismo com a caixa",
    ).toBeLessThan(caixa.width * caixa.height);

    // Losango, e não círculo nem retângulo: três formas distinguíveis sem cor.
    await expect(
      page.locator(".leaflet-marker-pane svg.cto-order polygon.cto-order__body").first(),
    ).toHaveCount(1);

    const cor = await page
      .locator(".leaflet-marker-pane svg.cto-order .cto-order__body")
      .first()
      .evaluate((el) => getComputedStyle(el).fill);
    const [r, g, b] = (cor.match(/\d+(\.\d+)?/g) ?? []).map(Number);
    expect(r, `a OS deveria ser laranja: ${cor}`).toBeGreaterThan(b);
    expect(g, `a OS deveria ser laranja: ${cor}`).toBeGreaterThan(b);
  });


  /** O lado do desenho de um marcador, já com a escala de zoom aplicada. */
  async function ladoDoDesenho(page: Page, seletor: string) {
    const caixa = (await page
      .locator(`.leaflet-marker-pane ${seletor}`)
      .first()
      .boundingBox())!;
    return caixa.width;
  }

  test("ZOOMVIS-01/02/03/04/05 · a hierarquia e as faixas de tamanho", async ({
    page,
  }) => {
    await abrirCamadas(page, ADMIN_EMAIL, 17);
    await page.getByTestId("map-layer-customers").check();
    await expect(page.locator(".leaflet-marker-pane svg.cto-dot").first()).toBeVisible({
      timeout: 15_000,
    });

    const cto = await ladoDoDesenho(page, "svg.cto-box");
    const cliente = await ladoDoDesenho(page, "svg.cto-dot");
    const os = await ladoDoDesenho(page, "svg.cto-order");

    /*
      O dono pediu aproximação de proporções: a caixa estava grande demais e os
      outros dois pequenos demais. As faixas são o alvo do enunciado, medidas no
      zoom operacional.
    */
    expect(cto, `CTO fora da faixa: ${cto}`).toBeGreaterThanOrEqual(30);
    expect(cto, `CTO fora da faixa: ${cto}`).toBeLessThanOrEqual(34);
    /*
      MAIOR que 18, e não "18 ou mais".

      18px era o tamanho da `CTO-3.2.2c`, e o pedido do dono na `CTO-3.2.2d` foi
      aumentar o cliente de novo. Com `>=` a sabotagem que devolve o valor
      antigo passa — foi o que aconteceu com o `>= 16` da fase anterior, na
      primeira rodada. O limite inferior tem de excluir o que se quer sair.

      A OS sobe junto (20 → 23), senão a hierarquia inverte — ver
      `VISUAL_OS` em `OperationalMarkers.tsx`. Pelo mesmo motivo, o limite
      inferior dela exclui o 20.
    */
    expect(cliente, `cliente não cresceu: ${cliente}`).toBeGreaterThan(18);
    expect(cliente, `cliente fora da faixa: ${cliente}`).toBeLessThanOrEqual(22);
    expect(os, `OS não acompanhou o cliente: ${os}`).toBeGreaterThan(20);
    expect(os, `OS fora da faixa: ${os}`).toBeLessThanOrEqual(24);

    // E a hierarquia: CTO > OS > cliente. A caixa é a infraestrutura.
    expect(cto, "a CTO deixou de ser a maior").toBeGreaterThan(os);
    expect(os, "a OS deixou de se destacar do cliente").toBeGreaterThan(cliente);
  });

  test("ZOOMVIS-06/07 · o desenho cresce com o zoom, e a caixa reduz menos", async ({
    page,
  }) => {
    /*
      Uma sessão só para os três zooms.

      `login()` preenche o formulário, e com sessão viva a segunda chamada cai
      no dashboard — não existe campo de e-mail para preencher. A autenticação
      acontece uma vez; o resto é navegação.
    */
    await abrirCamadas(page, ADMIN_EMAIL, 17);
    await page.getByTestId("map-layer-customers").check();

    const medirEm = async (zoom: number) => {
      await page.goto(
        `/mapa?lat=${LAYER_BASE.latitude}&lng=${LAYER_BASE.longitude}&z=${zoom}&layers=CTOS,ORDERS,CUSTOMERS`,
      );
      await expect(page.locator(".leaflet-marker-pane svg.cto-dot").first()).toBeVisible({
        timeout: 15_000,
      });
      await page.waitForTimeout(400);
      return {
        cto: await ladoDoDesenho(page, "svg.cto-box"),
        cliente: await ladoDoDesenho(page, "svg.cto-dot"),
      };
    };

    const longe = await medirEm(13);
    const meio = await medirEm(15);
    const perto = await medirEm(18);

    expect(perto.cliente, "z18 deveria ser maior que z15").toBeGreaterThan(meio.cliente);
    expect(meio.cliente, "z15 deveria ser maior que z13").toBeGreaterThan(longe.cliente);

    /*
      A CAIXA reduz MENOS, e é isso que preserva a hierarquia de longe.

      Cliente e OS podem virar pontinhos discretos quando o mapa se afasta; uma
      caixa que encolhesse na mesma proporção deixaria o mapa sem referência de
      infraestrutura.
    */
    const quedaDaCaixa = longe.cto / perto.cto;
    const quedaDoCliente = longe.cliente / perto.cliente;
    expect(
      quedaDaCaixa,
      "a caixa está encolhendo tanto quanto o cliente",
    ).toBeGreaterThan(quedaDoCliente);
  });

  test("ZOOMVIS-08/09 · a escala não move a coordenada nem o transform do Leaflet", async ({
    page,
  }) => {
    await abrirCamadas(page, ADMIN_EMAIL, 17);
    await expect(page.locator(".leaflet-marker-pane svg.cto-box").first()).toBeVisible({
      timeout: 15_000,
    });

    const ler = async () =>
      page.evaluate(() => {
        const m = document.querySelector(
          '.leaflet-marker-icon[title^="CAMADA CAIXA"]',
        ) as HTMLElement;
        const r = m.getBoundingClientRect();
        const mapa = document.querySelector(".leaflet-container")!.getBoundingClientRect();
        return {
          // O transform do CONTÊINER é do Leaflet, e tem de continuar sendo.
          transform: getComputedStyle(m).transform,
          // Âncora na base, relativa ao mapa: é ela que aponta para o poste.
          ancoraX: Math.round((r.left + r.width / 2 - mapa.left) * 10) / 10,
          ancoraY: Math.round((r.bottom - 2 - mapa.top) * 10) / 10,
          /*
            A camada de clique DESTE marcador, e da OS em separado.

            A primeira versão lia o primeiro `.cto-marker-hit` do painel — e
            qual marcador é o primeiro depende de qual resposta HTTP chegou
            antes, o mesmo sorteio da `LAYER-20`. Numa rodada da suíte inteira
            ela comparou a caixa (32) com uma OS (30) e acusou encolhimento que
            não existia.
          */
          hit: Math.round(
            (m.querySelector(".cto-marker-hit") as HTMLElement).getBoundingClientRect().width,
          ),
          hitOs: Math.round(
            (
              document.querySelector(
                '.leaflet-marker-icon[title^="OS número 8800"] .cto-marker-hit',
              ) as HTMLElement
            ).getBoundingClientRect().width,
          ),
        };
      });

    const antes = await ler();

    /*
      O `transform` do contêiner é `matrix(1, 0, 0, 1, x, y)` — translação pura.

      Se a escala fosse aplicada ali, ela substituiria o posicionamento do
      Leaflet e a caixa sairia do lugar geográfico. Ela mora numa camada de
      dentro, e é por isso que este teste existe.
    */
    expect(antes.transform, "o Leaflet perdeu o transform de posição").toMatch(
      /^matrix\(1,\s*0,\s*0,\s*1,/,
    );

    // Troca de zoom sem mexer no centro: só a escala muda.
    await page.goto(
      `/mapa?lat=${LAYER_BASE.latitude}&lng=${LAYER_BASE.longitude}&z=18`,
    );
    await expect(page.locator(".leaflet-marker-pane svg.cto-box").first()).toBeVisible({
      timeout: 15_000,
    });
    await page.waitForTimeout(400);
    const depois = await ler();

    expect(depois.transform).toMatch(/^matrix\(1,\s*0,\s*0,\s*1,/);
    // ZOOMVIS-10: o alvo de clique não encolhe com o desenho.
    expect(depois.hit, "a área de clique encolheu junto com o desenho").toBe(antes.hit);
    expect(depois.hit).toBeGreaterThanOrEqual(28);
    expect(depois.hitOs, "a área de clique da OS encolheu junto").toBe(antes.hitOs);
    expect(depois.hitOs).toBeGreaterThanOrEqual(28);
  });


  test("LABELZOOM-01/02/04/05/07 · os rótulos aparecem no zoom operacional", async ({
    page,
  }) => {
    await abrirCamadas(page, ADMIN_EMAIL, 17);
    await page.getByTestId("map-layer-customers").check();
    await expect(page.locator(".leaflet-marker-pane svg.cto-dot").first()).toBeVisible({
      timeout: 15_000,
    });

    const rotuloDeCliente = page.getByTestId("customer-map-label").first();
    const rotuloDeOs = page.getByTestId("order-map-label").first();
    const plaquetaDaCto = page.locator(".cto-map-label__name").first();

    // z17: primeiro nome e número visíveis.
    await expect(rotuloDeCliente).toBeVisible();
    await expect(rotuloDeOs).toBeVisible();
    await expect(rotuloDeOs).toContainText("OS-N°");
    // LABELZOOM-07: a plaqueta da caixa não regrediu.
    await expect(plaquetaDaCto).toBeVisible();

    /*
      z14: o mapa é leitura de DISTRIBUIÇÃO, não de identidade.

      Texto em cima de cada ponto a essa distância vira sobreposição. O elemento
      continua no DOM — some por CSS, sem recriar marcador, que é o que mantém
      popup aberto e evita o remonte que a `CTO-3.2.2b` consertou.
    */
    await page.goto(
      `/mapa?lat=${LAYER_BASE.latitude}&lng=${LAYER_BASE.longitude}&z=14&layers=CTOS,ORDERS,CUSTOMERS`,
    );
    await expect(page.locator(".leaflet-marker-pane svg.cto-dot").first()).toBeVisible({
      timeout: 15_000,
    });
    await page.waitForTimeout(400);

    await expect(page.getByTestId("customer-map-label").first()).toBeHidden();
    await expect(page.getByTestId("order-map-label").first()).toBeHidden();
  });

  test("LABELZOOM-03 · o rótulo é o PRIMEIRO nome, e nunca o completo", async ({
    page,
  }) => {
    await abrirCamadas(page, ADMIN_EMAIL, 17);
    await page.getByTestId("map-layer-customers").check();
    await expect(page.locator(".leaflet-marker-pane svg.cto-dot").first()).toBeVisible({
      timeout: 15_000,
    });

    const textos = await page.getByTestId("customer-map-label").allTextContents();
    expect(textos.length).toBeGreaterThan(0);

    /*
      Uma palavra, nunca o nome inteiro.

      As fixtures chamam-se "CAMADA CLIENTE ONLINE" e companhia, então o
      primeiro nome delas é "Camada" — feio, e exatamente o que a regra manda
      mostrar. O que importa é a propriedade: sem espaço no meio.
    */
    /*
      `\s`, e não `s`.

      A primeira versão desta asserção dizia `/s/` — a LETRA "s" —, porque a
      barra invertida se perdeu no script que a escreveu. Ela passava porque
      "Camada" não tem "s", e passaria igual com o nome inteiro na plaqueta.
      O `toBe("Camada")` abaixo é o que tira a ambiguidade: afirma a palavra, e
      não só a ausência de espaço.
    */
    for (const t of textos) {
      expect(t.trim(), `rótulo com mais de uma palavra: ${t}`).not.toMatch(/\s/);
      expect(t.trim()).toBe("Camada");
    }

    /*
      E o nome COMPLETO não aparece no painel de marcadores.

      É a regra de privacidade do rótulo: identificação mínima no mapa, nome
      inteiro só no popup, que é aberto por ação explícita.
    */
    /*
      O painel do MAPA inteiro, e não o de marcadores.

      A primeira versão lia `.leaflet-marker-pane`, e os rótulos não moram lá:
      eles vivem no painel de TOOLTIPS. A asserção nunca teria visto um nome
      completo vazando para a plaqueta — passava por não olhar.
    */
    const painel = await page.locator(".leaflet-map-pane").innerText();
    expect(painel).not.toContain("CAMADA CLIENTE ONLINE");
    expect(painel).not.toContain("CLIENTE OFFLINE");
  });

  test("OSURG-01/02/03/04/06 · OSLABEL-01..07 · a urgência vem do domínio, e não é só cor", async ({
    page,
  }) => {
    await abrirCamadas(page, ADMIN_EMAIL, 17);
    await expect(page.locator(".leaflet-marker-pane svg.cto-order").first()).toBeVisible({
      timeout: 15_000,
    });

    const normal = page.locator(
      ".leaflet-marker-pane svg.cto-order:not(.cto-order--urgente)",
    );
    const urgente = page.locator(".leaflet-marker-pane svg.cto-order--urgente");

    await expect(normal).toHaveCount(1);
    await expect(urgente).toHaveCount(1);

    const cor = async (alvo: typeof normal) =>
      alvo.locator(".cto-order__body").first().evaluate((el) => getComputedStyle(el).fill);
    const canais = (c: string) => (c.match(/\d+(\.\d+)?/g) ?? []).map(Number);

    // OSURG-01: a normal é âmbar — vermelho e verde altos, azul baixo.
    const [rn, gn, bn] = canais(await cor(normal));
    expect(rn, `normal deveria ser âmbar: ${await cor(normal)}`).toBeGreaterThan(bn);
    expect(gn).toBeGreaterThan(bn);

    // OSURG-02: a urgente é vermelha — o verde CAI em relação à normal.
    const [ru, gu] = canais(await cor(urgente));
    expect(ru).toBeGreaterThan(gu);
    expect(gu, "a urgente não se distingue da normal").toBeLessThan(gn);

    /*
      OSURG-03/04: o `!` é reforço, e só a urgente o tem.

      A cor não pode ser a única portadora da urgência — mesma regra dos estados
      do cliente. Quem não distingue vermelho de laranja continua vendo o sinal.
    */
    await expect(urgente.locator(".cto-order__bang")).toHaveCount(1);
    await expect(normal.locator(".cto-order__bang")).toHaveCount(0);

    /*
      OSLABEL-01/02/03/06: o rótulo é o NÚMERO do domínio, e NADA mais.

      O `!` aparecia duas vezes — no losango e no texto — e o dono apontou a
      duplicação. Ele ficou só no símbolo. O rótulo da urgente é idêntico ao da
      normal, e prioridade por extenso é assunto do popup.
    */
    const rotulos = await page.getByTestId("order-map-label").allTextContents();
    expect(rotulos.some((r) => r.trim() === "OS-N°8800")).toBe(true);
    expect(rotulos.some((r) => r.trim() === "OS-N°8802")).toBe(true);
    for (const r of rotulos) {
      expect(r, `rótulo com formato inesperado: ${r}`).toMatch(/^OS-N°\d+$/);
      expect(r, "o ! voltou a duplicar no rótulo").not.toContain("!");
    }
  });

  test("OSURG-05 · a conectividade do cliente não mexe na prioridade da OS", async ({
    page,
  }) => {
    await abrirCamadas(page, ADMIN_EMAIL, 17);
    await expect(page.locator(".leaflet-marker-pane svg.cto-order").first()).toBeVisible({
      timeout: 15_000,
    });

    /*
      A fixture monta o caso adverso de propósito.

      A OS NORMAL está no cliente OFFLINE; a URGENTE está no cliente SEM
      LEITURA. Se alguma coisa deduzisse urgência do estado do link, a normal
      seria a vermelha — vermelho em cliente é OFFLINE, e são semânticas
      diferentes que dividem a mesma cor.
    */
    const urgenteId = await page
      .locator(".leaflet-marker-pane svg.cto-order--urgente")
      .first()
      .evaluate((el) => el.closest(".leaflet-marker-icon")?.getAttribute("title") ?? "");
    expect(urgenteId).toContain("8802");
    expect(urgenteId).toContain("Urgente");
  });


  // -------------------------------------------------------------------------
  // CTO-3.2.2d — polimento final
  // -------------------------------------------------------------------------

  /** A caixa renderizada de um elemento, relativa ao contêiner do mapa. */
  async function caixaNoMapa(page: Page, seletor: string) {
    const el = (await page.locator(seletor).first().boundingBox())!;
    const mapa = (await page.locator(".leaflet-container").boundingBox())!;
    return { x: el.x - mapa.x, y: el.y - mapa.y, width: el.width, height: el.height };
  }

  test("CUSTOMERVIS-01/02/09 · o cliente cresceu, abaixo da OS, e sem sair do lugar", async ({
    page,
  }) => {
    await abrirCamadas(page, ADMIN_EMAIL, 17);
    await page.getByTestId("map-layer-customers").check();
    await expect(page.locator(".leaflet-marker-pane svg.cto-dot")).toHaveCount(3, {
      timeout: 15_000,
    });

    /*
      A hierarquia é de ÁREA DESENHADA, e não de lado de ícone.

      O lado do SVG esconde a inversão: 21 de cliente contra 20 de OS parece
      ordem certa em número e é ordem errada na tela, porque o losango ocupa
      metade do quadrado dele e o disco ocupa bem mais. Por isso a medida aqui é
      o CORPO de cada um — disco, losango e caixa —, e a área que cada forma
      realmente pinta.
    */
    const disco = await caixaNoMapa(
      page,
      '.leaflet-marker-icon[title^="CAMADA CLIENTE ONLINE"] .cto-dot__body',
    );
    const losango = await caixaNoMapa(page, ".leaflet-marker-pane svg.cto-order .cto-order__body");
    const caixa = await caixaNoMapa(
      page,
      '.leaflet-marker-icon[title^="CAMADA CAIXA"] .cto-box__body',
    );

    const areaCliente = Math.PI * (disco.width / 2) ** 2;
    const areaOs = (losango.width * losango.height) / 2;
    const areaCaixa = caixa.width * caixa.height;

    /*
      CUSTOMERVIS-01: o disco PINTADO cresceu.

      A caixa de um `<circle>` inclui o traço. Medido: 15,5px no ícone de 21; o
      de 18 pintava ~13,3px (12 de disco mais o traço). O limite inferior exclui
      o tamanho antigo — um `> 12.5` escrito na primeira versão aceitava os
      dois, e a sabotagem que devolve o 18 passaria por ele.
    */
    expect(disco.width, `o cliente não cresceu: disco de ${disco.width}px`).toBeGreaterThan(14.2);
    expect(disco.width, `o cliente cresceu demais: ${disco.width}px`).toBeLessThanOrEqual(17);

    // CUSTOMERVIS-02, e a metade que o pedido não disse mas o objetivo exige.
    expect(areaCaixa, "a caixa deixou de ser a maior").toBeGreaterThan(areaOs);
    expect(
      areaOs,
      `a OS ficou menor que o cliente: ${areaOs.toFixed(0)} contra ${areaCliente.toFixed(0)} px²`,
    ).toBeGreaterThan(areaCliente);

    /*
      CUSTOMERVIS-09: crescer não pode tirar o ponto do lugar.

      O centro do marcador tem de cair na projeção da coordenada gravada. Um
      `iconAnchor` que não acompanhasse o tamanho novo empurraria o ponto metade
      da diferença para um lado — e o cliente passaria a ser desenhado na casa
      do vizinho.
    */
    await esperarMapaParar(page);
    const icone = await caixaNoMapa(
      page,
      '.leaflet-marker-icon[title^="CAMADA CLIENTE ONLINE"]',
    );
    const esperado = await pontoDaCoordenada(page, LAYER_BASE.latitude, LAYER_BASE.longitude);
    expect(Math.abs(icone.x + icone.width / 2 - esperado.x)).toBeLessThanOrEqual(1.5);
    expect(Math.abs(icone.y + icone.height / 2 - esperado.y)).toBeLessThanOrEqual(1.5);
  });

  test("CUSTOMERVIS-07/08 · o primeiro nome aparece a partir de z16, e some em z15", async ({
    page,
  }) => {
    await abrirCamadas(page, ADMIN_EMAIL, 16);
    await page.getByTestId("map-layer-customers").check();
    await expect(page.locator(".leaflet-marker-pane svg.cto-dot").first()).toBeVisible({
      timeout: 15_000,
    });

    // z16 é a FRONTEIRA, e ela é inclusiva: é o zoom operacional.
    await expect(page.getByTestId("customer-map-label").first()).toBeVisible();
    await expect(page.getByTestId("customer-map-label").first()).toHaveText("Camada");

    await page.goto(
      `/mapa?lat=${LAYER_BASE.latitude}&lng=${LAYER_BASE.longitude}&z=15&layers=CTOS,ORDERS,CUSTOMERS`,
    );
    await expect(page.locator(".leaflet-marker-pane svg.cto-dot").first()).toBeVisible({
      timeout: 15_000,
    });
    await page.waitForTimeout(400);
    // No DOM, e escondido: some por CSS, sem recriar marcador.
    await expect(page.getByTestId("customer-map-label")).not.toHaveCount(0);
    await expect(page.getByTestId("customer-map-label").first()).toBeHidden();
  });

  test("LEGEND-01..06 · a legenda nomeia o sujeito, e cada termo tem o seu símbolo", async ({
    page,
  }) => {
    await abrirCamadas(page);
    await page.getByTestId("map-layer-customers").check();
    await expect(page.locator(".leaflet-marker-pane svg.cto-dot").first()).toBeVisible({
      timeout: 15_000,
    });

    /*
      A lista EXATA, na ordem, e só o texto do rótulo.

      `toContainText("Online")` casaria com "Cliente online"? Não — é sensível a
      caixa —, mas `toContainText("online")` casaria com as duas versões, e é o
      tipo de afrouxamento que deixa a sabotagem passar. Aqui cada entrada é o
      nó de texto dela, sem o SVG (o `!` da urgente é texto de SVG, e entraria
      no `textContent`).
    */
    const entradas = (grupo: string) =>
      page.getByTestId(grupo).evaluate((secao) =>
        Array.from(secao.querySelectorAll(":scope > span")).map((item) => ({
          rotulo: Array.from(item.childNodes)
            .filter((no) => no.nodeType === Node.TEXT_NODE)
            .map((no) => no.textContent ?? "")
            .join("")
            .trim(),
          classes: item.querySelector("svg")?.getAttribute("class") ?? "",
          furo: Boolean(item.querySelector(".cto-dot__hollow")),
          anel: Boolean(item.querySelector(".cto-dot__order")),
          tracejado: Boolean(item.querySelector(".cto-dot__body--sem-leitura")),
          exclamacao: Boolean(item.querySelector(".cto-order__bang")),
        })),
      );

    const clientes = await entradas("map-legend-customers");
    // LEGEND-01..04
    expect(clientes.map((e) => e.rotulo)).toEqual([
      "Cliente online",
      "Cliente offline",
      "Sem leitura",
      "Com OS aberta",
    ]);
    // E o símbolo de cada termo é o do mapa: o rótulo não pode mudar de dono.
    expect(clientes[0].classes).toContain("cto-dot--success");
    expect(clientes[1].classes).toContain("cto-dot--danger");
    expect(clientes[1].furo).toBe(true);
    expect(clientes[2].tracejado).toBe(true);
    expect(clientes[3].anel).toBe(true);

    const ordens = await entradas("map-legend-orders");
    // LEGEND-05/06
    expect(ordens.map((e) => e.rotulo)).toEqual(["Aberta", "Urgente"]);
    expect(ordens[0].classes).not.toContain("cto-order--urgente");
    expect(ordens[0].exclamacao).toBe(false);
    expect(ordens[1].classes).toContain("cto-order--urgente");
    expect(ordens[1].exclamacao).toBe(true);
  });

  test("LABELCOL-01/02 · rótulos no mesmo ponto não se sobrepõem, e a cauda é da plaqueta", async ({
    page,
  }) => {
    /*
      Tema ESCURO de propósito.

      A cauda padrão do Leaflet é branca. No tema claro ela coincide com o fundo
      da plaqueta e a asserção passaria com o defeito presente — no escuro, a
      diferença existe e tem de ser zero.
    */
    await page.emulateMedia({ colorScheme: "dark" });
    await abrirCamadas(page, ADMIN_EMAIL, 17);
    await page.getByTestId("map-layer-customers").check();
    await expect(page.getByTestId("customer-map-label").first()).toBeVisible({
      timeout: 15_000,
    });
    await page.waitForTimeout(400);

    /*
      Cada rótulo é achado pelo MARCADOR dono dele.

      O Leaflet liga os dois por `aria-describedby`: o marcador aponta o `id` do
      tooltip. Pegar "o primeiro rótulo de cliente" e "o primeiro de OS" poderia
      comparar dois pontos diferentes, e a asserção passaria por geometria de
      fixture, não pela regra.
    */
    const lido = await page.evaluate(() => {
      const caixa = (el: Element | null) => {
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return { l: b.left, t: b.top, r: b.right, b: b.bottom };
      };
      const rotuloDe = (titulo: string) => {
        const marcador = document.querySelector(`.leaflet-marker-icon[title^="${titulo}"]`);
        const id = marcador?.getAttribute("aria-describedby");
        return id ? document.getElementById(id) : null;
      };
      const seta = (t: Element | null, lado: "Left" | "Right") => {
        if (!t) return null;
        const antes = getComputedStyle(t, "::before");
        return {
          seta: lado === "Left" ? antes.borderLeftColor : antes.borderRightColor,
          fundo: getComputedStyle(t).backgroundColor,
        };
      };
      const offline = rotuloDe("CAMADA CLIENTE OFFLINE");
      const semLeitura = rotuloDe("CAMADA CLIENTE SEM LEITURA");
      const online = rotuloDe("CAMADA CLIENTE ONLINE");
      const os8800 = rotuloDe("OS número 8800");
      const os8802 = rotuloDe("OS número 8802");
      return {
        offline: caixa(offline),
        semLeitura: caixa(semLeitura),
        online: caixa(online),
        os8800: caixa(os8800),
        os8802: caixa(os8802),
        plaqueta: caixa(rotuloDe("CAMADA CAIXA")),
        corpoDaCaixa: caixa(
          document.querySelector('.leaflet-marker-icon[title^="CAMADA CAIXA"] .cto-box__body'),
        ),
        setas: [seta(offline, "Left"), seta(online, "Left"), seta(os8800, "Right"), seta(os8802, "Right")],
      };
    });

    type Caixa = { l: number; t: number; r: number; b: number };
    const cruzam = (a: Caixa | null, b: Caixa | null) => {
      if (!a || !b) throw new Error("rótulo não encontrado pelo marcador");
      return a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
    };

    /*
      LABELCOL-01: os pares ESTRUTURAIS não se cruzam.

      São os de mesma coordenada, que acontecem em todo cliente com OS e não
      por acaso de fixture: o nome do cliente contra o número da OS que está em
      cima dele, e o cliente ONLINE contra a caixa no ponto exato dele. Antes
      desta fase o nome e o número nasciam a um pixel um do outro.

      Colisão entre pontos DIFERENTES e próximos é densidade, e continua sendo o
      limite que a `CTO-3.2.1c` declarou: o limiar de zoom evita a parede, não
      toda sobreposição.
    */
    expect(cruzam(lido.offline, lido.os8800), "nome × OS 8800").toBe(false);
    expect(cruzam(lido.semLeitura, lido.os8802), "nome × OS 8802").toBe(false);
    expect(cruzam(lido.online, lido.plaqueta), "nome × plaqueta da caixa").toBe(false);
    expect(cruzam(lido.online, lido.corpoDaCaixa), "nome × corpo da caixa").toBe(false);

    // LABELCOL-02: a cauda tem a cor da plaqueta, nas duas direções novas.
    for (const s of lido.setas) {
      expect(s, "rótulo não encontrado pelo marcador").not.toBeNull();
      expect(s!.seta, "a cauda da plaqueta ficou com a cor padrão do Leaflet").toBe(s!.fundo);
    }
  });

  /*
    # OSPOP — o popup da OS no centro e nas QUATRO bordas

    O dono viu o "Abrir OS" abaixo da área visível do mapa. A causa era a mesma
    cadeia da `CTO-3.2.2b`: popup mais alto que o mapa (473px num mapa de 398),
    o `autoPan` empurra, e o botão — que fica no fim — sai de baixo. Na borda
    ficava pior.

    A posição é CALCULADA a partir do tamanho real do mapa, e não cravada: a
    primeira sonda usou um deslocamento medido em 1440px e, em 1280px, pôs a OS
    3px fora do mapa — o teste falharia pelo motivo errado. Aqui a OS fica a
    36px de cada borda, em qualquer largura.
  */
  const OSPOP_VIEWPORTS = [
    [1440, 900],
    [1366, 768],
    [1280, 720],
  ] as const;

  for (const [largura, altura] of OSPOP_VIEWPORTS) {
    test(`OSPOP-01..10 · o popup da OS é utilizável no centro e nas bordas — ${largura}×${altura}`, async ({
      page,
    }) => {
      test.setTimeout(150_000);
      await page.setViewportSize({ width: largura, height: altura });
      await login(page, ADMIN_EMAIL);
      await interceptarTiles(page);

      const osLat = LAYER_BASE.latitude + 0.0008;
      const osLng = LAYER_BASE.longitude;
      const pxLng = (256 * 2 ** 17) / 360;
      const pxLat = pxLng / Math.cos((osLat * Math.PI) / 180);
      const MARGEM = 36;
      const marcador = page.locator(
        `.leaflet-marker-icon[title^="OS número ${camadas.ordemNumero}"]`,
      );

      await page.goto(`/mapa?lat=${osLat}&lng=${osLng}&z=17`);
      await expect(marcador).toBeVisible({ timeout: 15_000 });
      const mapa0 = (await page.locator(".leaflet-container").boundingBox())!;
      const meiaL = mapa0.width / 2 - MARGEM;
      const meiaA = mapa0.height / 2 - MARGEM;

      const casos = [
        ["centro", 0, 0],
        ["topo", -meiaA / pxLat, 0],
        ["fundo", meiaA / pxLat, 0],
        ["esquerda", 0, meiaL / pxLng],
        ["direita", 0, -meiaL / pxLng],
      ] as const;

      for (const [nome, dLat, dLng] of casos) {
        await page.goto(
          `/mapa?lat=${(osLat + dLat).toFixed(6)}&lng=${(osLng + dLng).toFixed(6)}&z=17`,
        );
        await expect(marcador).toBeVisible({ timeout: 15_000 });
        await esperarMapaParar(page);

        /*
          Controle positivo: a OS está MESMO na borda.

          Sem isto, um erro de conta poria todos os casos no meio do mapa e o
          teste passaria provando só o centro, cinco vezes.
        */
        const antes = await caixaNoMapa(
          page,
          `.leaflet-marker-icon[title^="OS número ${camadas.ordemNumero}"]`,
        );
        const cx = antes.x + antes.width / 2;
        const cy = antes.y + antes.height / 2;
        const borda = {
          centro: Math.min(cx, mapa0.width - cx, cy, mapa0.height - cy) > 120,
          topo: Math.abs(cy - MARGEM) <= 3,
          fundo: Math.abs(mapa0.height - cy - MARGEM) <= 3,
          esquerda: Math.abs(cx - MARGEM) <= 3,
          direita: Math.abs(mapa0.width - cx - MARGEM) <= 3,
        }[nome];
        expect(borda, `${nome}: a OS não está onde o caso diz (${cx}, ${cy})`).toBe(true);

        await marcador.click();
        const popup = page.getByTestId("order-map-popup");
        await expect(popup).toBeVisible();

        const medir = () =>
          page.evaluate((numero) => {
            const r = (el: Element | null) => {
              if (!el) return null;
              const b = el.getBoundingClientRect();
              return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height };
            };
            const acerta = (el: Element | null, alvo: string) => {
              if (!el) return false;
              const b = el.getBoundingClientRect();
              const topo = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
              return Boolean(topo && topo.closest(`[data-testid="${alvo}"]`));
            };
            const cta = document.querySelector('[data-testid="order-map-open"]');
            const cliente = document.querySelector('[data-testid="order-map-open-customer"]');
            const fechar = document.querySelector(".leaflet-popup-close-button");
            const fecharB = fechar?.getBoundingClientRect();
            const noFechar = fecharB
              ? document.elementFromPoint(
                  fecharB.left + fecharB.width / 2,
                  fecharB.top + fecharB.height / 2,
                )
              : null;
            return {
              janela: { w: window.innerWidth, h: window.innerHeight },
              mapa: r(document.querySelector(".leaflet-container")),
              popup: r(document.querySelector(".leaflet-popup-content-wrapper")),
              cta: r(cta),
              cliente: r(cliente),
              ctaAcerta: acerta(cta, "order-map-open"),
              clienteAcerta: acerta(cliente, "order-map-open-customer"),
              fecharAcerta: Boolean(noFechar && noFechar.closest(".leaflet-popup-close-button")),
              controles: Array.from(
                document.querySelectorAll(
                  '.leaflet-control-zoom, .leaflet-control-attribution, [data-testid="map-mode-control"]',
                ),
              ).map((el) => ({
                nome: el.getAttribute("data-testid") ?? el.className.toString().split(" ")[1],
                caixa: r(el),
              })),
              marcador: r(
                document.querySelector(`.leaflet-marker-icon[title^="OS número ${numero}"]`),
              ),
            };
          }, camadas.ordemNumero);

        /*
          OSPOP-08: o `autoPan` ESTABILIZA — o popup para de se mexer.

          A barra de endereço não serve de sinal aqui: ela só muda no `moveend`,
          então durante a animação do empurrão ela ainda mostra a vista velha e
          "duas leituras iguais da URL" sai no meio do movimento — medido, o
          popup andou mais 9px depois disso. O sinal é o próprio popup: três
          leituras iguais seguidas, dentro de um prazo. Um popup que oscilasse
          para sempre esgotaria o prazo.
        */
        let m = await medir();
        let iguais = 0;
        for (let i = 0; i < 30 && iguais < 2; i += 1) {
          await page.waitForTimeout(150);
          const n = await medir();
          iguais = JSON.stringify(n.popup) === JSON.stringify(m.popup) ? iguais + 1 : 0;
          m = n;
        }
        expect(iguais, `${nome}: o popup não parou de se mexer`).toBe(2);

        const dentro = (
          a: { l: number; t: number; r: number; b: number } | null,
          b: { l: number; t: number; r: number; b: number } | null,
        ) => Boolean(a && b && a.l >= b.l - 1 && a.r <= b.r + 1 && a.t >= b.t - 1 && a.b <= b.b + 1);

        // OSPOP-07: o popup inteiro dentro do mapa — nada cortado pela borda.
        expect(dentro(m.popup, m.mapa), `${nome}: o popup passou da borda do mapa`).toBe(true);
        expect(m.popup!.h, `${nome}: o popup ficou alto demais`).toBeLessThanOrEqual(260);

        // OSPOP-01/03..06: o botão principal visível — no mapa, no popup, na janela.
        expect(dentro(m.cta, m.mapa), `${nome}: Abrir OS fora do mapa`).toBe(true);
        expect(dentro(m.cta, m.popup), `${nome}: Abrir OS cortado dentro do popup`).toBe(true);
        expect(m.cta!.t >= 0 && m.cta!.b <= m.janela.h, `${nome}: Abrir OS fora da janela`).toBe(
          true,
        );
        // OSPOP-02: e é ELE que recebe o clique no centro dele.
        expect(m.ctaAcerta, `${nome}: outra coisa está por cima do Abrir OS`).toBe(true);

        // OSPOP-09: o marcador sobreviveu ao empurrão, dentro do mapa.
        expect(dentro(m.marcador, m.mapa), `${nome}: o marcador saiu do mapa`).toBe(true);

        // OSPOP-10: "Abrir cliente" continua alcançável.
        expect(dentro(m.cliente, m.popup), `${nome}: Abrir cliente cortado`).toBe(true);
        expect(m.clienteAcerta, `${nome}: Abrir cliente coberto`).toBe(true);

        /*
          E o popup não pousa DEBAIXO de controle do mapa.

          Foi o que esta prova encontrou na primeira rodada: perto da borda
          direita, o seletor Mapa/Satélite/Híbrido interceptava o clique no "×"
          — os controles ficam acima dos painéis do mapa, e um popup embaixo
          deles perde o cabeçalho e o botão de fechar.
        */
        expect(m.controles.length).toBeGreaterThanOrEqual(3);
        for (const c of m.controles) {
          const cruza =
            m.popup!.l < c.caixa!.r &&
            c.caixa!.l < m.popup!.r &&
            m.popup!.t < c.caixa!.b &&
            c.caixa!.t < m.popup!.b;
          expect(cruza, `${nome}: o popup ficou debaixo de ${c.nome}`).toBe(false);
        }
        expect(m.fecharAcerta, `${nome}: o × está coberto`).toBe(true);

        // Fechar pelo ×, como a pessoa fecha. O Esc do Leaflet só vale com o
        // FOCO no contêiner, e o clique no marcador leva o foco para o marcador.
        await page.locator(".leaflet-popup-close-button").click();
        await expect(popup).toHaveCount(0);
      }

      /*
        OSPOP-02 de verdade: o clique NAVEGA.

        Na borda de cima, que é onde o `autoPan` mais trabalha. Um botão que
        passa em todas as geometrias e não leva a lugar nenhum não serve.
      */
      await page.goto(
        `/mapa?lat=${(osLat - meiaA / pxLat).toFixed(6)}&lng=${osLng.toFixed(6)}&z=17`,
      );
      await expect(marcador).toBeVisible({ timeout: 15_000 });
      await marcador.click();
      await page.getByTestId("order-map-open").click();
      await expect(page).toHaveURL(new RegExp(`/ordens/${camadas.ordemId}`));
      await expect(page.getByTestId("order-back-link")).toHaveText("← Mapa Operacional");
    });
  }

  /** A geometria que o refresh NÃO pode mexer. */
  async function geometriaDaPagina(page: Page) {
    return page.evaluate(() => {
      const box = (sel: string) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return [Math.round(r.top * 10) / 10, Math.round(r.height * 10) / 10];
      };
      return {
        mapa: box(".leaflet-container"),
        controle: box('[data-testid="map-layer-control"]'),
        resumo: box('[data-testid="map-summary"]'),
        legenda: box('[data-testid="map-legend"]'),
      };
    });
  }

  test("LOADUX-01..06 · o indicador de atualização não move nada", async ({
    page,
  }) => {
    await abrirCamadas(page, ADMIN_EMAIL, 17);
    await page.getByTestId("map-layer-customers").check();
    await expect(page.locator(".leaflet-marker-pane svg.cto-dot").first()).toBeVisible({
      timeout: 15_000,
    });
    await page.waitForTimeout(600);

    const antes = await geometriaDaPagina(page);

    /*
      A resposta é RETARDADA de propósito.

      O defeito que o dono relatou só existe ENQUANTO a leitura está em voo: a
      mensagem entrava no fluxo acima do mapa, empurrava tudo para baixo e
      sumia empurrando de volta. Medir só antes e depois não veria nada.
    */
    await page.route("**/api/map/customers**", async (route) => {
      await new Promise((r) => setTimeout(r, 1500));
      return route.fallback();
    });

    const area = (await page.locator(".leaflet-container").boundingBox())!;
    const x = area.x + area.width * 0.3;
    const y = area.y + area.height * 0.4;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 70, y + 50, { steps: 10 });
    await page.mouse.up();

    // LOADUX-06 (primeira metade): a pílula aparece.
    await expect(page.getByTestId("map-updating")).toBeVisible({ timeout: 10_000 });

    const durante = await geometriaDaPagina(page);

    /*
      Tolerância de UM pixel, e o alvo é zero.

      Qualquer elemento que entre no fluxo durante o refresh aparece aqui como
      deslocamento — foi assim que o defeito foi relatado: "a página desce e
      depois volta".
    */
    for (const chave of ["mapa", "controle", "resumo", "legenda"] as const) {
      const a = antes[chave]!;
      const d = durante[chave]!;
      expect(
        Math.abs(d[0] - a[0]),
        `${chave} mudou de posição durante o refresh: ${a[0]} → ${d[0]}`,
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs(d[1] - a[1]),
        `${chave} mudou de altura durante o refresh: ${a[1]} → ${d[1]}`,
      ).toBeLessThanOrEqual(1);
    }

    // LOADUX-06 (segunda metade): some quando a leitura termina.
    await expect(page.getByTestId("map-updating")).toBeHidden({ timeout: 15_000 });
  });

  test("LOADUX-07 · resposta instantânea não faz a pílula piscar", async ({
    page,
  }) => {
    await abrirCamadas(page, ADMIN_EMAIL, 17);
    await page.getByTestId("map-layer-customers").check();
    await expect(page.locator(".leaflet-marker-pane svg.cto-dot").first()).toBeVisible({
      timeout: 15_000,
    });
    await page.waitForTimeout(600);

    /*
      O atraso é SÓ da interface.

      Uma resposta que volta em poucas dezenas de milissegundos faria a pílula
      aparecer e sumir num piscar, que incomoda mais do que informa. O pedido
      sai na hora; quem espera é o aviso. Aqui a resposta é imediata, e a
      pílula não pode chegar a existir.
      */
    await page.route("**/api/map/customers**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          data: {
            map: {
              markers: [],
              truncated: false,
              limit: 300,
              missingLocationCount: 0,
            },
          },
        }),
      }),
    );

    const aparicoes: number[] = [];
    const relogio = setInterval(() => {
      void page
        .getByTestId("map-updating")
        .count()
        .then((n) => aparicoes.push(n))
        .catch(() => undefined);
    }, 40);

    const area = (await page.locator(".leaflet-container").boundingBox())!;
    const x = area.x + area.width * 0.3;
    const y = area.y + area.height * 0.4;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 60, y + 40, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(1500);
    clearInterval(relogio);

    expect(
      Math.max(0, ...aparicoes),
      `a pílula piscou numa resposta instantânea: ${aparicoes.join(",")}`,
    ).toBe(0);
  });

  test("POP-03 · o popup do cliente não repete a palavra CTO", async ({
    page,
  }) => {
    await abrirCamadas(page, ADMIN_EMAIL, 17);
    await page.getByTestId("map-layer-customers").check();
    // Sem a camada de OS, o ponto do cliente fica alcançável — ver `LAYER-08/09`.
    await page.getByTestId("map-layer-orders").uncheck();
    await expect(page.locator(".leaflet-marker-pane svg.cto-order")).toHaveCount(0);
    await expect(page.locator(".leaflet-marker-pane svg.cto-dot").first()).toBeVisible({
      timeout: 15_000,
    });

    await page
      .locator('.leaflet-marker-icon[title^="CAMADA CLIENTE ONLINE"]')
      .click();
    const popup = page.getByTestId("customer-map-popup");
    await expect(popup).toBeVisible();

    const texto = (await popup.getByTestId("customer-map-cto").innerText()).trim();
    /*
      O nome da caixa JÁ COMEÇA com "CTO", e o rótulo repetia: saía
      "CTO CTO QA FIELD 01 · 1". O valor persistido não foi tocado — quem saiu
      foi o rótulo redundante.
    */
    expect(texto, `o rótulo voltou a duplicar: ${texto}`).not.toMatch(/CTO\s+CTO/);
    expect(texto).toContain("CAMADA CAIXA");
    expect(texto).toContain("Porta");

    // E o nome completo do cliente continua no popup, que é onde ele pode estar.
    await expect(popup).toContainText("CAMADA CLIENTE ONLINE");
  });


  test("ZOOMSEQ-01 · zoom repetido não some, não duplica e não fecha o popup", async ({
    page,
  }) => {
    /*
      A camada de clientes fica DESLIGADA aqui, e o motivo é uma decisão aberta.

      A fixture `CAMADA CLIENTE ONLINE` está na coordenada EXATA da caixa. Com
      a área de clique dos pontos em 30px — ela cresceu nesta fase, junto com o
      alvo mínimo —, o ponto passa a cobrir o centro da caixa e intercepta o
      clique nela.

      Qual dos dois deve receber o clique quando ocupam o mesmo ponto é decisão
      de produto que segue EM ABERTO desde a `CTO-3.2.2`, e o enunciado desta
      fase manda não resolvê-la em silêncio. Este teste é sobre estabilidade de
      zoom, então ele não depende dela — o sumiço de pontos de cliente tem
      detector próprio na `STAB-02`.
    */
    await abrirCamadas(page, ADMIN_EMAIL, 17);
    await expect(page.locator(".leaflet-marker-pane svg.cto-box")).toHaveCount(1, {
      timeout: 15_000,
    });

    const pedidos: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/api/map/") || r.url().includes("/api/ctos/map?")) {
        pedidos.push(r.url());
      }
    });

    // O popup fica ABERTO durante toda a sequência: remonte de marcador o
    // mataria, e é justamente isso que a escala por CSS existe para evitar.
    await page.locator('.leaflet-marker-icon[title^="CAMADA CAIXA"]').click();
    await expect(page.getByTestId("cto-map-popup")).toBeVisible();

    const area = (await page.locator(".leaflet-container").boundingBox())!;
    const cx = area.x + area.width / 2;
    const cy = area.y + area.height / 2;
    await page.mouse.move(cx, cy);

    /*
      A sequência do enunciado: 17 → 15 → 18 → 14 → 17, duas vezes.

      A pergunta é se a entidade continua existindo quando continua no recorte
      carregado. "Saiu do bbox" e "sumiu por defeito de render" são coisas
      diferentes, e a caixa fica no CENTRO — ela nunca sai.
    */
    const caixasVistas: number[] = [];
    for (let volta = 0; volta < 2; volta += 1) {
      for (const passo of [-120, 120, -180, 180]) {
        await page.mouse.wheel(0, passo);
        await page.waitForTimeout(500);
        caixasVistas.push(
          await page.locator(".leaflet-marker-pane svg.cto-box").count(),
        );
      }
    }

    expect(
      Math.min(...caixasVistas),
      `a caixa sumiu durante o zoom: ${caixasVistas.join(",")}`,
    ).toBeGreaterThanOrEqual(1);
    expect(
      Math.max(...caixasVistas),
      `a caixa duplicou durante o zoom: ${caixasVistas.join(",")}`,
    ).toBe(1);

    // O popup atravessou a sequência inteira.
    await expect(
      page.getByTestId("cto-map-popup"),
      "o popup fechou durante o zoom",
    ).toBeVisible();

    /*
      E a escala NÃO custou requisição.

      Ela é decisão de cliente. As leituras que aconteceram são as do recorte,
      que é outro mecanismo — se a escala dependesse de dado, cada degrau de
      zoom teria pedido o mapa de novo.
    */
    const porZoom = pedidos.length / 8;
    expect(porZoom, `requisições demais por degrau de zoom: ${pedidos.length}`).toBeLessThan(4);
  });


  test("LAYER-01/02/03 · o estado inicial das camadas", async ({ page }) => {
    await abrirCamadas(page);

    // CTOs e OS abertas ligadas; clientes DESLIGADA.
    await expect(page.getByTestId("map-layer-ctos")).toBeChecked();
    await expect(page.getByTestId("map-layer-orders")).toBeChecked();
    await expect(page.getByTestId("map-layer-customers")).not.toBeChecked();

    // As duas ligadas desenham; a desligada não.
    await expect(page.locator(".leaflet-marker-pane svg.cto-box").first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.locator(".leaflet-marker-pane svg.cto-order").first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.locator(".leaflet-marker-pane svg.cto-dot")).toHaveCount(0);

    /*
      Camada DESLIGADA não consulta.

      Uma camada apagada que continuasse pedindo gastaria banco e banda para
      desenhar nada — e é o tipo de custo que ninguém percebe, porque não
      aparece na tela.
    */
    const deClientes: string[] = [];
    const deOrdens: string[] = [];
    page.on("request", (r) => {
      const u = r.url();
      if (u.includes("/api/map/customers")) deClientes.push(u);
      if (u.includes("/api/map/service-orders")) deOrdens.push(u);
    });

    /*
      O arrasto precisa cair DENTRO da parte visível do mapa.

      Medido: o contêiner começa em `y=343` e tem 558px de altura, num viewport
      de 720 — ou seja, a metade de baixo dele está fora do alcance do ponteiro.
      Um ponto escolhido "no meio do mapa" por fração da altura cai lá fora, o
      mapa não se mexe, e a afirmação "não consultou" passa sem ter provado
      nada. Foi exatamente assim que a sabotagem S11 sobreviveu a este teste.
    */
    const area = await page.locator(".leaflet-container").boundingBox();
    if (!area) throw new Error("o mapa não foi renderizado");
    const x = area.x + area.width * 0.25;
    const y = area.y + 120;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 70, y + 60, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(1500);

    /*
      CONTROLE POSITIVO, e ele é o que dá sentido ao resto.

      A camada LIGADA recarregou depois do mesmo gesto. Sem esta linha, a
      afirmação de baixo é satisfeita por um arrasto inerte — que é a forma
      mais silenciosa de um teste passar sem testar.
    */
    expect(
      deOrdens.length,
      "o arrasto não moveu o mapa: o resto deste teste não prova nada",
    ).toBeGreaterThan(0);
    expect(deClientes, "a camada desligada consultou").toEqual([]);
  });

  test("LAYER-04/05/06/07 · ligar clientes mostra os três estados", async ({
    page,
  }) => {
    await abrirCamadas(page);
    await page.getByTestId("map-layer-customers").check();

    await expect(page.locator(".leaflet-marker-pane svg.cto-dot")).toHaveCount(3, {
      timeout: 15_000,
    });

    const estados = await page
      .locator(".leaflet-marker-pane svg.cto-dot")
      .evaluateAll((nos) => nos.map((n) => n.getAttribute("class")));
    expect(estados.some((c) => c?.includes("cto-dot--success"))).toBe(true);
    expect(estados.some((c) => c?.includes("cto-dot--danger"))).toBe(true);
    expect(estados.some((c) => c?.includes("cto-dot--neutral"))).toBe(true);

    /*
      LAYER-07: OFFLINE **e** OS ABERTA ao mesmo tempo.

      O miolo continua vermelho — o estado do link — e o anel tracejado diz que
      há trabalho aberto. Um marcador que trocasse a cor por "tem OS"
      esconderia justamente a informação que explica a OS existir.
    */
    const comOs = page.locator(".leaflet-marker-pane svg.cto-dot.cto-dot--danger.cto-dot--with-order");
    await expect(comOs).toHaveCount(1);
    await expect(comOs.locator(".cto-dot__order")).toHaveCount(1);

    // O cliente sem localização não virou marcador, e é contado.
    await expect(page.getByTestId("map-customers-missing")).toContainText(
      "sem localização",
    );
  });

  test("LAYER-08/09 · popup do cliente, e voltar restaura o mapa", async ({
    page,
  }) => {
    await abrirCamadas(page);
    await page.getByTestId("map-layer-customers").check();
    /*
      A camada de OS sai do caminho — e isto é o cenário REAL, não um jeito de
      fazer o teste passar.

      O marcador da OS nasce na coordenada do CLIENTE, então o losango cobre o
      ponto de todo cliente com OS aberta, e por decisão ele fica por cima
      (`OS_ACIMA_DO_CLIENTE`). Com as duas camadas ligadas, clicar nesse ponto
      abre o popup da OS — o que a `LAYER-20` afirma. O popup do CLIENTE desse
      cliente só é alcançável com a camada de OS desligada, e é exatamente aí
      que a contagem "OS abertas: 1" tem quem a leia.
    */
    await page.getByTestId("map-layer-orders").uncheck();
    await expect(page.locator(".leaflet-marker-pane svg.cto-order")).toHaveCount(0);
    await expect(page.locator(".leaflet-marker-pane svg.cto-dot").first()).toBeVisible({
      timeout: 15_000,
    });

    /*
      A vista de referência é a que o operador tinha AO CLICAR.

      Lê-la depois de o popup abrir capturaria o deslocamento do `autoPan` do
      Leaflet — medido aqui em 0,0027°, uns 124px — que é efeito de abrir o
      popup, e não uma vista que alguém escolheu. O link de volta carrega
      justamente a vista de antes desse empurrão, e é essa que a volta deve
      devolver.
    */
    const antes = await vistaEstavel(page);

    await page
      .locator('.leaflet-marker-icon[title^="CAMADA CLIENTE OFFLINE"]')
      .click();
    const popup = page.getByTestId("customer-map-popup");
    await expect(popup).toBeVisible();

    // Cadastro e conectividade, nomeados e separados.
    await expect(popup).toContainText("Cadastro: Ativo");
    await expect(popup.getByTestId("map-connectivity")).toHaveAttribute(
      "data-status",
      "OFFLINE",
    );
    await expect(popup.getByTestId("customer-map-open-os")).toHaveText("1");
    // A CTO e a porta vêm do VÍNCULO, e aparecem.
    await expect(popup).toContainText("CAMADA CAIXA");

    await popup.getByTestId("customer-map-open").click();

    await expect(page.getByTestId("customer-back-link")).toHaveText(
      "← Mapa Operacional",
    );
    await page.getByTestId("customer-back-link").click();

    await expect(page.locator(".leaflet-container")).toBeVisible({
      timeout: 15_000,
    });
    const depois = vistaDaUrl(page);
    expect(depois.get("z")).toBe(antes.get("z"));
    expect(Number(depois.get("lat"))).toBeCloseTo(Number(antes.get("lat")), 3);
    // LAYER-09: as camadas voltam como estavam — a ligada ligada E a desligada
    // desligada. Só a primeira metade deixaria passar um retorno que
    // reacendesse tudo no padrão.
    await expect(page.getByTestId("map-layer-customers")).toBeChecked();
    await expect(page.getByTestId("map-layer-orders")).not.toBeChecked();
  });

  /*
    O empate de z é REAL, e o desfecho precisa ser ÚNICO.

    Cliente e OS ocupam o mesmo pixel por construção. Medido antes da correção:
    z 239 nos dois, com o desempate caindo para a ordem no DOM — isto é, para
    qual das duas respostas HTTP chegou primeiro. Este teste existe porque um
    popup sorteado passa despercebido: a tela abre, alguma coisa aparece, e só
    quem procura nota que nem sempre é a mesma.
  */
  /*
    A legenda continua na primeira dobra com AS TRÊS camadas ligadas.

    A `UXP-02` já afirma isso, mas só no estado padrão — e foi ligando camadas
    que a página cresceu. Medido em 1440×900: cada camada trazia a sua própria
    linha de contadores, empilhadas, e a terceira punha a legenda em `y=916`,
    dezesseis pixels abaixo da janela. Os contadores passaram a dividir UMA
    linha que quebra sozinha, e a legenda voltou para `y=852`.

    Este teste existe para a quarta camada não repetir a conta em silêncio.
  */
  test("LAYER-21 · a legenda sobrevive às três camadas ligadas", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await abrirCamadas(page);
    await page.getByTestId("map-layer-customers").check();
    await expect(page.locator(".leaflet-marker-pane svg.cto-dot").first()).toBeVisible({
      timeout: 15_000,
    });
    // As três contagens estão na tela, e são elas que empurram a legenda.
    await expect(page.getByTestId("map-marker-count")).toBeVisible();
    await expect(page.getByTestId("map-customer-count")).toBeVisible();
    await expect(page.getByTestId("map-order-count")).toBeVisible();

    /*
      A afirmação é NUMÉRICA, e `toBeInViewport()` não bastava.

      Ele aceita qualquer interseção: uma legenda com 4 dos seus 20px dentro da
      janela ainda passa. Foi assim que a primeira versão deste teste
      SOBREVIVEU à reversão que empilha os contadores de novo — um detector que
      não cai quando o defeito volta não é detector. O que interessa é a
      legenda INTEIRA estar acima da dobra.
    */
    const legenda = (await page.getByTestId("map-legend").boundingBox())!;
    expect(
      legenda.y + legenda.height,
      "a legenda saiu da primeira dobra com as três camadas ligadas",
    ).toBeLessThanOrEqual(900);
  });

  test("LAYER-20 · cliente e OS no mesmo ponto: quem abre é a OS", async ({
    page,
  }) => {
    await abrirCamadas(page);
    await page.getByTestId("map-layer-customers").check();
    await expect(page.locator(".leaflet-marker-pane svg.cto-dot").first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.locator(".leaflet-marker-pane svg.cto-order").first()).toBeVisible({
      timeout: 15_000,
    });

    const alvo = page.locator(
      '.leaflet-marker-icon[title^="CAMADA CLIENTE OFFLINE"]',
    );
    const caixa = await alvo.boundingBox();
    if (!caixa) throw new Error("o ponto do cliente não foi renderizado");

    const z = await page.evaluate(() => {
      const porTitulo = (t: string) =>
        document.querySelector<HTMLElement>(
          `.leaflet-marker-icon[title^="${t}"]`,
        );
      return {
        cliente: Number(porTitulo("CAMADA CLIENTE OFFLINE")?.style.zIndex),
        os: Number(porTitulo("OS número 8800")?.style.zIndex),
      };
    });
    // O mesmo ponto ⇒ a latitude não desempata. Quem desempata é a regra.
    expect(z.os, "a OS precisa ficar acima do ponto do cliente").toBeGreaterThan(
      z.cliente,
    );

    /*
      E o clique é feito no PONTO, não no elemento: mandar o evento direto ao
      marcador do cliente pularia o teste de acerto do navegador, que é
      justamente o que está sendo medido.
    */
    await page.mouse.click(
      caixa.x + caixa.width / 2,
      caixa.y + caixa.height / 2,
    );

    const daOs = page.getByTestId("order-map-popup");
    await expect(daOs).toBeVisible();
    await expect(page.getByTestId("customer-map-popup")).toHaveCount(0);

    /*
      Nada se perde no ponto compartilhado: o popup da OS nomeia o cliente,
      mostra a conectividade dele e oferece o caminho para o cadastro. É o que
      sustenta a decisão de a OS vencer o empate.
    */
    await expect(daOs).toContainText("CAMADA CLIENTE OFFLINE");
    await expect(daOs.getByTestId("map-connectivity")).toHaveAttribute(
      "data-status",
      "OFFLINE",
    );
    await expect(daOs.getByTestId("order-map-open-customer")).toBeVisible();
  });

  test("LAYER-10/11 · popup da OS, e voltar restaura o mapa", async ({ page }) => {
    await abrirCamadas(page);
    await expect(page.locator(".leaflet-marker-pane svg.cto-order").first()).toBeVisible({
      timeout: 15_000,
    });

    // A vista de referência, pela mesma razão da `LAYER-08/09`: lida ANTES do
    // clique, para não capturar o empurrão do `autoPan`.
    const antes = await vistaEstavel(page);

    await page
      .locator(`.leaflet-marker-icon[title^="OS número ${camadas.ordemNumero}"]`)
      .click();
    const popup = page.getByTestId("order-map-popup");
    await expect(popup).toBeVisible();
    await expect(popup).toContainText("CAMADA CLIENTE OFFLINE");
    // A conectividade do cliente aparece dentro do popup da OS.
    await expect(popup.getByTestId("map-connectivity")).toHaveAttribute(
      "data-status",
      "OFFLINE",
    );

    await popup.getByTestId("order-map-open").click();

    await expect(page.getByTestId("order-back-link")).toHaveText(
      "← Mapa Operacional",
    );
    await page.getByTestId("order-back-link").click();

    await expect(page.locator(".leaflet-container")).toBeVisible({
      timeout: 15_000,
    });
    /*
      Centro E zoom, não só o zoom.

      Afirmar apenas `z` deixaria passar uma volta que devolve o zoom certo em
      cima de outro bairro — que é exatamente o defeito que a `CTO-3.2.1`
      consertou.
    */
    const depois = vistaDaUrl(page);
    expect(depois.get("z")).toBe(antes.get("z"));
    expect(depois.get("lat")).toBe(antes.get("lat"));
    expect(depois.get("lng")).toBe(antes.get("lng"));
  });

  test("LAYER-12/13/14 · o selo de OS na caixa, os contadores e os clientes por porta", async ({
    page,
  }) => {
    await abrirCamadas(page);
    const caixa = page.locator('.leaflet-marker-icon[title^="CAMADA CAIXA"]');
    await expect(caixa).toBeVisible({ timeout: 15_000 });

    // LAYER-12: o selo de OS existe, e o selo de ESTADO continua lá.
    // Encadeado a partir do marcador: o escopo do painel já veio de `caixa`.
    const svg = caixa.locator("svg.cto-box");
    await expect(svg.locator(".cto-box__orders")).toHaveCount(1);
    await expect(svg.locator(".cto-box__badge")).toHaveCount(1);
    await expect(svg.locator(".cto-box__glyph")).toHaveCount(1);

    await caixa.click();
    const popup = page.getByTestId("cto-map-popup");
    await expect(popup).toBeVisible();

    // LAYER-13: os contadores operacionais.
    await expect(popup.getByTestId("cto-map-active-customers")).toHaveText("2");
    await expect(popup.getByTestId("cto-map-open-orders")).toHaveText("1");
    await expect(popup.getByTestId("cto-map-operational")).toContainText(
      "Sem leitura",
    );

    // LAYER-14: a lista nominal, buscada só ao clicar.
    await popup.getByTestId("cto-map-show-customers").click();
    const painel = page.getByTestId("cto-customers-panel");
    await expect(painel).toBeVisible();
    await expect(painel.getByTestId("cto-customers-row")).toHaveCount(2, {
      timeout: 15_000,
    });
    await expect(painel).toContainText("Porta 01");
    await expect(painel).toContainText("CAMADA CLIENTE ONLINE");
    await expect(painel).toContainText("CAMADA CLIENTE OFFLINE");
    await expect(
      painel.getByTestId("cto-customers-open-os").first(),
    ).toContainText("1 OS aberta");
  });

  test("LAYER-15/16 · a busca acha cliente e OS, e centraliza", async ({
    page,
  }) => {
    await abrirCamadas(page);

    await page.getByTestId("cto-map-search-input").fill("CAMADA CLIENTE ONLINE");
    const hits = page.getByTestId("cto-map-search-hit");
    await expect(hits.first()).toBeVisible({ timeout: 15_000 });
    await expect(
      hits.first().getByTestId("cto-map-search-hit-kind"),
    ).toHaveText("Cliente");
    await hits.first().getByTestId("cto-map-search-hit-focus").click();
    await expect
      .poll(() => Number(vistaDaUrl(page).get("lat")))
      .toBeCloseTo(LAYER_BASE.latitude, 2);

    // E pelo NÚMERO da OS.
    await page
      .getByTestId("cto-map-search-input")
      .fill(String(camadas.ordemNumero));
    await expect(
      page
        .getByTestId("cto-map-search-hit")
        .filter({ hasText: `OS Nº ${camadas.ordemNumero}` }),
    ).toHaveCount(1, { timeout: 15_000 });
  });

  test("LAYER-17 · falha da camada de clientes NÃO derruba CTO nem OS", async ({
    page,
  }) => {
    await abrirCamadas(page);

    await page.route("**/api/map/customers**", (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: "Falha ao carregar clientes." }),
      }),
    );
    await page.getByTestId("map-layer-customers").check();

    /*
      A mensagem é ESPECÍFICA, e não "0 clientes".

      Zero seria uma afirmação falsa sobre a rede, e é a leitura perigosa: o
      operador concluiria que o bairro não tem assinantes.
    */
    await expect(page.getByTestId("map-customers-error")).toBeVisible();
    await expect(page.getByTestId("map-customer-count")).toHaveCount(0);

    // E as outras camadas continuam inteiras.
    await expect(page.locator(".leaflet-marker-pane svg.cto-box").first()).toBeVisible();
    await expect(page.locator(".leaflet-marker-pane svg.cto-order").first()).toBeVisible();
  });

  test("LAYER-18 · o DISPATCHER não vê a camada de clientes", async ({ page }) => {
    await abrirCamadas(page, DISPATCHER_EMAIL);

    // O controle nem é oferecido...
    await expect(page.getByTestId("map-layer-customers")).toHaveCount(0);
    await expect(page.getByTestId("map-layer-ctos")).toBeChecked();
    await expect(page.getByTestId("map-layer-orders")).toBeChecked();

    // ...e o popup da caixa não traz contagem nominal de clientes.
    await page.locator('.leaflet-marker-icon[title^="CAMADA CAIXA"]').click();
    await expect(page.getByTestId("cto-map-popup")).toBeVisible();
    await expect(page.getByTestId("cto-map-operational")).toHaveCount(0);
    await expect(page.getByTestId("cto-map-show-customers")).toHaveCount(0);
  });

  test("LAYER-19 · resposta velha não substitui a nova", async ({ page }) => {
    await abrirCamadas(page);

    /*
      O modo de falha: arrastar do bairro A para o B dispara duas leituras, e a
      de A demora mais. Sem a guarda, ela chega depois e o mapa fica no lugar
      certo com os clientes do outro lugar — sem erro nenhum na tela.
    */
    let primeira = true;
    await page.route("**/api/map/customers**", async (route) => {
      if (primeira) {
        primeira = false;
        await new Promise((r) => setTimeout(r, 1500));
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ok: true,
            data: {
              map: {
                markers: [],
                truncated: false,
                limit: 300,
                missingLocationCount: 999,
              },
            },
          }),
        });
      }
      return route.fallback();
    });

    await page.getByTestId("map-layer-customers").check();
    await page.waitForTimeout(200);

    /*
      O arrasto tem de mover o mapa DE VERDADE — é ele que dispara a segunda
      leitura, e sem segunda leitura não existe "resposta velha".

      Medido: o contêiner do mapa começa em `y=343` e é mais alto que o
      viewport de 720, então coordenadas fixas escolhidas a olho caem fora
      dele. Com o arrasto inerte, este teste observava uma requisição só e
      deixava de exercer a guarda inteira.
    */
    const area = await page.locator(".leaflet-container").boundingBox();
    if (!area) throw new Error("o mapa não foi renderizado");
    const x = area.x + area.width * 0.25;
    const y = area.y + 120;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 70, y + 60, { steps: 10 });
    await page.mouse.up();

    await expect(page.locator(".leaflet-marker-pane svg.cto-dot").first()).toBeVisible({
      timeout: 20_000,
    });
    await page.waitForTimeout(1500);

    /*
      A afirmação precisa das DUAS metades.

      `not.toContainText` sozinho também passa quando o elemento não existe —
      e um contador ausente é indistinguível de um contador correto para essa
      asserção. Exigir que ele esteja na tela é o que impede o teste de se
      satisfazer com o vazio.
    */
    const contador = page.getByTestId("map-customers-missing");
    await expect(contador).toBeVisible();
    // O `999` da resposta velha nunca aparece: ela foi descartada.
    await expect(contador).not.toContainText("999");
  });
});

// ---------------------------------------------------------------------------
// CTO-3.2.2d — ativos PRÓXIMOS, nomes reais e o fluxo do dono
// ---------------------------------------------------------------------------

/**
 * Um bairro pequeno SÓ para estas provas, a cerca de 11 km de todos os outros.
 *
 * A caixa nasce e morre dentro do `describe`, pela mesma razão da caixa de
 * posição: enquanto existe, ela entra no enquadramento inicial de qualquer
 * teste que abra o mapa sem coordenada. Todos os testes daqui abrem com
 * coordenada explícita.
 *
 * As distâncias são em PIXELS de z17, convertidas para graus: é a grandeza que
 * decide se um clique acerta o alvo certo. 36px entre centros deixam ~5px
 * entre a área de clique de 30px do cliente e a caixa de 32px — próximos de
 * verdade, e não sobrepostos. Mesma coordenada exata é outra coisa: é a
 * decisão ainda aberta, e não é testada aqui.
 */
const PROX = { latitude: LAYER_BASE.latitude + 0.1, longitude: LAYER_BASE.longitude };
const PX_POR_GRAU_Z17 = (256 * 2 ** 17) / 360;
const PROX_DLNG = 36 / PX_POR_GRAU_Z17;
const PROX_DLAT = 60 / (PX_POR_GRAU_Z17 / Math.cos((PROX.latitude * Math.PI) / 180));
const NOME_PROX_CAIXA = "PROX CAIXA";
const prox = {
  ctoId: "",
  osNormal: "",
  osUrgente: "",
  clientes: [] as string[],
};

async function abrirBairro(page: Page, extra = "&layers=CTOS,ORDERS,CUSTOMERS") {
  await page.goto(`/mapa?lat=${PROX.latitude}&lng=${PROX.longitude}&z=17${extra}`);
  await expect(page.locator(".leaflet-container")).toBeVisible();
  await expect(marcadorDe(page, NOME_PROX_CAIXA)).toBeVisible({ timeout: 15_000 });
}

/** Os canais de uma cor `rgb(...)` do `getComputedStyle`. */
function canaisDaCor(cor: string): number[] {
  return (cor.match(/\d+(\.\d+)?/g) ?? []).map(Number);
}

test.describe("Mapa Operacional — ativos próximos, primeiro nome e o fluxo do dono", () => {
  // Alta pelo mesmo motivo da `MAPEDIT`: o fluxo do dono ARRASTA a caixa.
  test.use({ viewport: { width: 1280, height: 1000 } });

  test.beforeAll(async () => {
    const roseli = await criarClienteE2E("ROSELI JESUNO DE SOUZA TEIXEIRA", {
      lat: PROX.latitude,
      lng: PROX.longitude + PROX_DLNG,
    });
    const joao = await criarClienteE2E("João da Silva Neto", {
      lat: PROX.latitude,
      lng: PROX.longitude - PROX_DLNG,
    });
    const maria = await criarClienteE2E("Maria Gonçalves", {
      lat: PROX.latitude - PROX_DLAT,
      lng: PROX.longitude,
    });
    prox.clientes = [roseli.id, joao.id, maria.id];

    for (const [customerId, status] of [
      [roseli.id, "ONLINE"],
      [joao.id, "OFFLINE"],
    ] as const) {
      await prisma.customerDiagnosticSnapshot.create({
        data: {
          companyId,
          customerId,
          externalProvider: "MOCK",
          connectivityStatus: status,
          observedAt: new Date(),
        },
      });
    }

    const normal = await prisma.serviceOrder.create({
      data: {
        companyId,
        number: 8810,
        customerId: joao.id,
        type: "REPARO",
        description: "OS normal do bairro",
        status: "ASSIGNED",
      },
    });
    const urgente = await prisma.serviceOrder.create({
      data: {
        companyId,
        number: 8811,
        customerId: maria.id,
        type: "REPARO",
        description: "OS urgente do bairro",
        status: "ASSIGNED",
        priority: "URGENT",
      },
    });
    prox.osNormal = normal.id;
    prox.osUrgente = urgente.id;

    const cto = await criarCto(NOME_PROX_CAIXA, {
      latitude: PROX.latitude,
      longitude: PROX.longitude,
    });
    prox.ctoId = cto.id;
  });

  test.afterAll(async () => {
    await prisma.serviceOrder.deleteMany({
      where: { id: { in: [prox.osNormal, prox.osUrgente].filter(Boolean) } },
    });
    await prisma.customerDiagnosticSnapshot.deleteMany({
      where: { customerId: { in: prox.clientes } },
    });
    await prisma.customerLocation.deleteMany({ where: { customerId: { in: prox.clientes } } });
    await prisma.customer.deleteMany({ where: { id: { in: prox.clientes } } });
    if (prox.ctoId) {
      await prisma.cTOPort.deleteMany({ where: { ctoId: prox.ctoId } });
      await prisma.cTO.deleteMany({ where: { id: prox.ctoId } });
    }
  });

  test("PROX-01 · caixa, cliente e OS próximos abrem cada um o SEU popup", async ({ page }) => {
    await login(page, ADMIN_EMAIL);
    await interceptarTiles(page);
    await abrirBairro(page);
    await expect(page.locator(".leaflet-marker-pane svg.cto-dot")).toHaveCount(3, {
      timeout: 15_000,
    });
    await expect(page.locator(".leaflet-marker-pane svg.cto-order")).toHaveCount(2);

    /*
      Controle positivo: eles estão MESMO próximos.

      Se a conta de graus errasse e espalhasse os pontos, o teste passaria
      provando cliques em alvos isolados — que não é o que o dono validou.
    */
    const caixa = (await marcadorDe(page, NOME_PROX_CAIXA).boundingBox())!;
    const cliente = (await marcadorDe(page, "ROSELI JESUNO").boundingBox())!;
    const folga = cliente.x - (caixa.x + caixa.width);
    expect(folga, `folga entre caixa e cliente: ${folga}px`).toBeGreaterThanOrEqual(0);
    expect(folga, `folga entre caixa e cliente: ${folga}px`).toBeLessThanOrEqual(10);

    const casos = [
      {
        alvo: marcadorDe(page, NOME_PROX_CAIXA),
        popup: "cto-map-popup",
        texto: NOME_PROX_CAIXA,
      },
      {
        alvo: marcadorDe(page, "ROSELI JESUNO"),
        popup: "customer-map-popup",
        texto: "ROSELI JESUNO DE SOUZA TEIXEIRA",
      },
      {
        alvo: page.locator('.leaflet-marker-icon[title^="OS número 8810"]'),
        popup: "order-map-popup",
        texto: "João da Silva Neto",
      },
      {
        alvo: page.locator('.leaflet-marker-icon[title^="OS número 8811"]'),
        popup: "order-map-popup",
        texto: "Maria Gonçalves",
      },
      // De volta à caixa: abrir os outros não mudou quem fica por cima.
      {
        alvo: marcadorDe(page, NOME_PROX_CAIXA),
        popup: "cto-map-popup",
        texto: NOME_PROX_CAIXA,
      },
    ];

    for (const caso of casos) {
      // Cada clique parte do MESMO enquadramento: o `autoPan` do anterior não
      // pode decidir onde o próximo alvo está.
      await abrirBairro(page);
      await expect(page.locator(".leaflet-marker-pane svg.cto-dot")).toHaveCount(3, {
        timeout: 15_000,
      });
      await caso.alvo.click();
      const popup = page.getByTestId(caso.popup);
      await expect(popup).toBeVisible();
      await expect(popup).toContainText(caso.texto);
      await expect(page.locator(".leaflet-popup")).toHaveCount(1);
    }
  });

  test("FIRSTNAME-MAP · o mapa mostra o primeiro nome real, e só o popup mostra o completo", async ({
    page,
  }) => {
    await login(page, ADMIN_EMAIL);
    await interceptarTiles(page);
    await abrirBairro(page);
    await expect(page.getByTestId("customer-map-label")).toHaveCount(3, { timeout: 15_000 });

    // Os exemplos do dono, e a caixa normalizada: "ROSELI" vira "Roseli".
    const rotulos = (await page.getByTestId("customer-map-label").allTextContents())
      .map((t) => t.trim())
      .sort();
    expect(rotulos).toEqual(["João", "Maria", "Roseli"]);

    /*
      Nenhum pedaço do sobrenome em lugar nenhum do mapa.

      O painel certo é o `.leaflet-map-pane` inteiro: os rótulos moram no painel
      de TOOLTIPS, e não no de marcadores.
    */
    // Sem distinguir caixa: "Roseli jesuno" vaza o sobrenome tanto quanto
    // "ROSELI JESUNO".
    const mapa = (await page.locator(".leaflet-map-pane").innerText()).toLocaleLowerCase("pt-BR");
    for (const pedaco of ["jesuno", "souza", "teixeira", "silva", "neto", "gonçalves"]) {
      expect(mapa, `o mapa mostra "${pedaco}" sem ninguém ter clicado`).not.toContain(pedaco);
    }

    // O popup é aberto por ação explícita, e é autorizado a mostrar o nome todo.
    await marcadorDe(page, "ROSELI JESUNO").click();
    await expect(page.getByTestId("customer-map-popup")).toContainText(
      "ROSELI JESUNO DE SOUZA TEIXEIRA",
    );
  });

  test("OWNER-FLOW · o roteiro do dono, de ponta a ponta", async ({ page }) => {
    test.setTimeout(240_000);

    await test.step("1. abrir o mapa", async () => {
      await login(page, ADMIN_EMAIL);
      await interceptarTiles(page);
      await abrirBairro(page, "");
    });

    await test.step("2. ligar as três camadas", async () => {
      await page.getByTestId("map-layer-customers").check();
      for (const camada of ["ctos", "orders", "customers"]) {
        await expect(page.getByTestId(`map-layer-${camada}`)).toBeChecked();
      }
      await expect(page.locator(".leaflet-marker-pane svg.cto-dot")).toHaveCount(3, {
        timeout: 15_000,
      });
    });

    await test.step("3. o cliente mostra o primeiro nome", async () => {
      await expect(
        page.getByTestId("customer-map-label").filter({ hasText: /^Roseli$/ }),
      ).toBeVisible();
    });

    await test.step("4. o cliente cresceu e continua menor que a caixa", async () => {
      const lado = async (seletor: string) =>
        (await page.locator(`.leaflet-marker-pane ${seletor}`).first().boundingBox())!.width;
      const ladoCliente = await lado("svg.cto-dot");
      expect(ladoCliente).toBeGreaterThan(18);
      expect(ladoCliente).toBeLessThanOrEqual(22);
      expect(await lado("svg.cto-box")).toBeGreaterThan(ladoCliente);
    });

    await test.step("5–6. clicar no cliente, e fechar", async () => {
      await marcadorDe(page, "ROSELI JESUNO").click();
      await expect(page.getByTestId("customer-map-popup")).toBeVisible();
      await page.locator(".leaflet-popup-close-button").click();
      await expect(page.locator(".leaflet-popup")).toHaveCount(0);
    });

    const popupOs = page.getByTestId("order-map-popup");
    /** O "Abrir OS" está dentro do mapa, e é ele que recebe o clique. */
    const ctaAcertavel = () =>
      page.getByTestId("order-map-open").evaluate((cta) => {
        const b = cta.getBoundingClientRect();
        const mapa = document.querySelector(".leaflet-container")!.getBoundingClientRect();
        const topo = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
        return (
          b.top >= mapa.top &&
          b.bottom <= mapa.bottom &&
          Boolean(topo && topo.closest('[data-testid="order-map-open"]'))
        );
      });

    let zoomDoMapa: string | null = null;
    await test.step("7–10. OS normal: rótulo sem !, popup utilizável, Abrir OS clicável", async () => {
      await esperarMapaParar(page);
      zoomDoMapa = vistaDaUrl(page).get("z");
      await page.locator('.leaflet-marker-icon[title^="OS número 8810"]').click();
      await expect(popupOs).toHaveAttribute("data-order-id", prox.osNormal);
      await expect(
        page.getByTestId("order-map-label").filter({ hasText: "8810" }),
      ).toHaveText("OS-N°8810");
      await esperarMapaParar(page);
      expect(await ctaAcertavel(), "Abrir OS fora do mapa ou coberto").toBe(true);
      await page.getByTestId("order-map-open").click();
      await expect(page).toHaveURL(new RegExp(`/ordens/${prox.osNormal}`));
    });

    await test.step("11. voltar ao mapa", async () => {
      await page.getByTestId("order-back-link").click();
      await expect(page.locator(".leaflet-container")).toBeVisible({ timeout: 15_000 });
      await expect(page.locator(".leaflet-marker-pane svg.cto-dot")).toHaveCount(3, {
        timeout: 15_000,
      });
      expect(vistaDaUrl(page).get("z")).toBe(zoomDoMapa);
    });

    await test.step("12–15. OS urgente: vermelha com !, rótulo sem !, Abrir OS visível", async () => {
      const osUrgente = page.locator('.leaflet-marker-icon[title^="OS número 8811"]');
      await osUrgente.click();
      await expect(popupOs).toHaveAttribute("data-order-id", prox.osUrgente);

      const desenho = osUrgente.locator("svg.cto-order");
      await expect(desenho).toHaveClass(/cto-order--urgente/);
      await expect(desenho.locator(".cto-order__bang")).toHaveCount(1);
      const [r, g] = canaisDaCor(
        await desenho.locator(".cto-order__body").evaluate((el) => getComputedStyle(el).fill),
      );
      expect(r, "a urgente deveria ser vermelha").toBeGreaterThan(g);

      await expect(
        page.getByTestId("order-map-label").filter({ hasText: "8811" }),
      ).toHaveText("OS-N°8811");

      await esperarMapaParar(page);
      expect(await ctaAcertavel(), "Abrir OS fora do mapa ou coberto").toBe(true);
      await page.locator(".leaflet-popup-close-button").click();
      await expect(page.locator(".leaflet-popup")).toHaveCount(0);
    });

    await test.step("16. zoom", async () => {
      await page.locator(".leaflet-control-zoom-in").click();
      await expect.poll(() => vistaDaUrl(page).get("z")).toBe("18");
      await expect(page.locator(".leaflet-marker-pane svg.cto-dot")).toHaveCount(3);
      await page.locator(".leaflet-control-zoom-out").click();
      await expect.poll(() => vistaDaUrl(page).get("z")).toBe("17");
      await expect(page.locator(".leaflet-marker-pane svg.cto-dot")).toHaveCount(3);
    });

    await test.step("17. pan", async () => {
      await esperarMapaParar(page);
      const lngAntes = vistaDaUrl(page).get("lng");
      const area = (await page.locator(".leaflet-container").boundingBox())!;
      const pegaX = area.x + area.width * 0.15;
      const pegaY = area.y + area.height * 0.8;
      await page.mouse.move(pegaX, pegaY);
      await page.mouse.down();
      await page.mouse.move(pegaX + 90, pegaY, { steps: 10 });
      await page.mouse.up();
      /*
        POLL, e não `esperarMapaParar`.

        A URL só muda no `moveend`, que vem depois da inércia do arrasto. Duas
        leituras iguais logo após o `mouseup` são duas leituras da vista VELHA —
        medido: o teste afirmou que o pan não moveu o mapa, e moveu.
      */
      await expect
        .poll(() => vistaDaUrl(page).get("lng"), { message: "o pan não moveu o mapa" })
        .not.toBe(lngAntes);
      await expect(page.locator(".leaflet-marker-pane svg.cto-dot")).toHaveCount(3);
    });

    await test.step("18. o ativo próximo: a caixa, a 36px do cliente, abre a CAIXA", async () => {
      await abrirBairro(page);
      await marcadorDe(page, NOME_PROX_CAIXA).click();
      await expect(page.getByTestId("cto-map-popup")).toContainText(NOME_PROX_CAIXA);
    });

    /*
      Referência: onde o marcador fica em relação à coordenada GRAVADA.

      É o ancoramento do ícone, constante enquanto ele estiver sobre ela — e
      invariante a pan, que é o que a comparação de pixels de tela não era.
    */
    const desvioDaCaixa = async () => {
      /*
        Parado = o MARCADOR e a URL iguais em duas leituras seguidas.

        Só a URL não basta: ela muda no `moveend`, no FIM da animação do
        `autoPan`. Medido: a referência tirada logo depois de abrir o popup da
        caixa pegou o marcador no meio do empurrão com a vista de antes, e o
        Cancelar foi acusado de errar 185px — o tamanho do empurrão.
      */
      let anterior = "";
      for (let i = 0; i < 30; i += 1) {
        const agora = JSON.stringify({
          m: await marcadorDe(page, NOME_PROX_CAIXA).boundingBox(),
          v: vistaDaUrl(page).toString(),
        });
        if (agora === anterior) break;
        anterior = agora;
        await page.waitForTimeout(150);
      }
      const linha = await prisma.cTO.findUniqueOrThrow({ where: { id: prox.ctoId } });
      const esperado = await pontoDaCoordenada(
        page,
        Number(linha.latitude),
        Number(linha.longitude),
      );
      const mapa = (await page.locator(".leaflet-container").boundingBox())!;
      const m = (await marcadorDe(page, NOME_PROX_CAIXA).boundingBox())!;
      return { x: m.x - mapa.x - esperado.x, y: m.y - mapa.y - esperado.y };
    };
    const original = await prisma.cTO.findUniqueOrThrow({ where: { id: prox.ctoId } });
    const ancora = await desvioDaCaixa();

    await test.step("19–20. Ajustar posição, arrastar, Cancelar: nada gravado", async () => {
      await page.getByTestId("cto-map-popup-edit-position").click();
      await expect(page.getByTestId("cto-map-position-panel")).toBeVisible();
      await arrastar(page, 50, 30, NOME_PROX_CAIXA);
      await expect(page.getByTestId("cto-map-position-save")).toBeEnabled();

      await page.getByTestId("cto-map-position-cancel").click();
      await expect(page.getByTestId("cto-map-position-panel")).toHaveCount(0);
      const gravada = await prisma.cTO.findUniqueOrThrow({ where: { id: prox.ctoId } });
      expect(Number(gravada.latitude)).toBe(Number(original.latitude));
      expect(Number(gravada.longitude)).toBe(Number(original.longitude));
      const voltou = await desvioDaCaixa();
      expect(Math.abs(voltou.x - ancora.x)).toBeLessThanOrEqual(1.5);
      expect(Math.abs(voltou.y - ancora.y)).toBeLessThanOrEqual(1.5);
    });

    let salva: { latitude: number; longitude: number } = { latitude: 0, longitude: 0 };
    await test.step("21–22. repetir, e salvar", async () => {
      await marcadorDe(page, NOME_PROX_CAIXA).click();
      await page.getByTestId("cto-map-popup-edit-position").click();
      await expect(page.getByTestId("cto-map-position-panel")).toBeVisible();
      await arrastar(page, 50, 30, NOME_PROX_CAIXA);

      await page.getByTestId("cto-map-position-save").click();
      await expect(page.getByTestId("cto-map-position-panel")).toHaveCount(0, {
        timeout: 15_000,
      });
      await expect(page.getByTestId("cto-map-position-error")).toHaveCount(0);
      const linha = await prisma.cTO.findUniqueOrThrow({ where: { id: prox.ctoId } });
      salva = { latitude: Number(linha.latitude), longitude: Number(linha.longitude) };
      // Para a direita e para baixo: longitude sobe, latitude desce.
      expect(salva.longitude).toBeGreaterThan(Number(original.longitude));
      expect(salva.latitude).toBeLessThan(Number(original.latitude));
    });

    await test.step("23–24. recarregar, e a posição persiste", async () => {
      await page.reload();
      await expect(marcadorDe(page, NOME_PROX_CAIXA)).toBeVisible({ timeout: 15_000 });
      const linha = await prisma.cTO.findUniqueOrThrow({ where: { id: prox.ctoId } });
      expect(Number(linha.latitude)).toBe(salva.latitude);
      expect(Number(linha.longitude)).toBe(salva.longitude);
      const naNova = await desvioDaCaixa();
      expect(Math.abs(naNova.x - ancora.x)).toBeLessThanOrEqual(1.5);
      expect(Math.abs(naNova.y - ancora.y)).toBeLessThanOrEqual(1.5);
    });
  });
});
