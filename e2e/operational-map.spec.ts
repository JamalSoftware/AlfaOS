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
    await expect(page.locator("svg.cto-box")).toHaveCount(4);
    await expect(page.locator("svg.cto-box .cto-box__body")).toHaveCount(4);
    for (const tom of ["success", "warning", "danger", "neutral"]) {
      await expect(page.locator(`svg.cto-box--${tom}`)).toHaveCount(1);
    }

    // O selo carrega GLIFO, e não só cor: quatro glifos distintos na tela.
    const glifos = await page.locator("svg.cto-box .cto-box__glyph").allTextContents();
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
    ).toContainText("Nenhuma CTO encontrada", { timeout: 15_000 });
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
    await expect(page.locator("svg.cto-box")).toHaveCount(4);

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

    await page.locator("svg.cto-box").first().click();
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
    await expect(page.locator("svg.cto-box--selected")).toHaveCount(1);
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
    await expect(page.locator("svg.cto-box").first()).toBeVisible({
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
  for (const caso of [
    { nome: "desktop", width: 1440, height: 900, min: 500, max: 600 },
    { nome: "notebook", width: 1280, height: 800, min: 500, max: 600 },
    { nome: "tablet", width: 768, height: 1024, min: 420, max: 560 },
    { nome: "celular", width: 390, height: 844, min: 360, max: 440 },
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

    const caixa = page.locator("svg.cto-box").first();
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
        .locator("svg.cto-box")
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

      await page.locator("svg.cto-box").first().click();
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

    await page.locator("svg.cto-box").first().click();
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

    const caixa = page.locator("svg.cto-box").first();
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
    expect(depois.get("z")).toBe(antes.get("z"));
    expect(Number(depois.get("lat"))).toBeCloseTo(Number(antes.get("lat")), 3);

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
