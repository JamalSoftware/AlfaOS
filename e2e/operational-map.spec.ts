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
const TECHNICIAN_EMAIL = "tecnico@alfatelecom.local";
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

/** Serve os tiles localmente: a suíte não depende da internet. */
async function interceptarTiles(page: Page) {
  await page.route(/tile\.openstreetmap\.org/, (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: TILE_PNG }),
  );
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

    await page.goto("/mapa");
    await expect(page.locator(".leaflet-container")).toBeVisible();

    // Provoca a segunda leitura antes de a primeira responder.
    const caixa = await page.locator(".leaflet-container").boundingBox();
    const cx = (caixa?.x ?? 0) + (caixa?.width ?? 0) / 2;
    const cy = (caixa?.y ?? 0) + (caixa?.height ?? 0) / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx - 60, cy - 40);
    await page.mouse.up();

    // Tempo bastante para a resposta LENTA chegar depois da rápida.
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

    // Forma própria por estado: o eixo que sobrevive a preto e branco.
    await expect(page.locator(".cto-marker--circle")).toHaveCount(1 + 1); // marcador + legenda
    await expect(page.locator(".cto-marker--triangle")).toHaveCount(2);
    await expect(page.locator(".cto-marker--square")).toHaveCount(2);
    await expect(page.locator(".cto-marker--diamond")).toHaveCount(2);

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
      .filter({ has: page.locator(".cto-marker--circle") })
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
    await expect(page).toHaveURL(/\/ctos\/[a-z0-9]+$/);
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
    await expect(page.getByTestId("map-marker-count")).not.toBeVisible();

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
