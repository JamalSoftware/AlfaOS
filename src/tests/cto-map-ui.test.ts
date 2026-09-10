import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCto } from "@/lib/cto";
import type { CtoMapStatus } from "@/lib/cto-map";
import {
  CTO_MAP_STATUS_PRESENTATION,
  CTO_MAP_VIEWPORT_DEBOUNCE_MS,
  boundingBoxFromLatLngBounds,
  boundingBoxToQuery,
  createLatestRequestGuard,
  ctoMapStatusPresentation,
} from "@/lib/cto-map-presentation";
import {
  MAP_FALLBACK_POINT,
  availableMapModes,
  getCtoMapInitialView,
  getMapFallbackPoint,
  getMapTileConfig,
} from "@/lib/map-config";
import {
  MAP_MODES,
  MAP_MODE_STORAGE_KEY,
  buildMapViewQuery,
  parseMapMode,
  parseMapViewParams,
} from "@/lib/map-view-params";
import { buildReturnTo, parseReturnTo } from "@/lib/return-to";
import {
  CTO_MARKER_GEOMETRY,
  CTO_MARKER_SIZE,
  ctoMarkerHtml,
} from "@/components/map/cto-marker-icon";
import {
  DEFAULT_NORMAL_URL,
  MAP_INITIAL_FIT_MAX_ZOOM,
  MAP_LABEL_MIN_ZOOM,
  MAP_MAX_ZOOM,
  readMapTileConfig,
  tileImageSource,
  tileImageSources,
} from "@/lib/map-tiles.config.mjs";
import { navigationFor } from "@/lib/navigation";
import { prisma } from "@/lib/prisma";
import { createTokenFor, seedTestData, type TestFixture } from "./helpers";

/**
 * # `CTO-3.2` — a superfície do Mapa Operacional
 *
 * O que dá para afirmar sem navegador mora aqui: portão da página, tradução de
 * estado para aparência, o recorte que o Leaflet entrega, a guarda de resposta
 * atrasada, a configuração de tiles e a fronteira servidor/cliente.
 *
 * **O mapa em si é validado no Playwright** (`e2e/operational-map.spec.ts`), e
 * a divisão é deliberada: `jsdom` não tem layout, e um Leaflet sem layout
 * "monta" sem desenhar nada. Um teste de componente afirmando que o mapa
 * apareceu passaria com o mapa invisível — que é exatamente o defeito da
 * `CTO-1.8`, onde 129 testes verdes conviviam com uma imagem que não abria.
 */

const session = vi.hoisted(() => ({ token: null as string | null }));

vi.mock("next/headers", () => ({
  cookies: () => ({
    get: (name: string) =>
      session.token ? { name, value: session.token } : undefined,
  }),
}));

let fixture: TestFixture;

beforeEach(async () => {
  fixture = await seedTestData();
  session.token = null;
  await prisma.company.updateMany({
    where: { id: { in: [fixture.companyA.id, fixture.companyB.id] } },
    data: { ctoNetworkEnabled: true },
  });
});

/** `redirect()` sinaliza controle de fluxo lançando um erro etiquetado. */
async function redirectTargetOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    const digest = (error as { digest?: unknown }).digest;
    if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT")) {
      return digest.split(";")[2] ?? "";
    }
    throw error;
  }
  throw new Error("Esperava um redirect, mas a página renderizou.");
}

async function digestOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    const digest = (error as { digest?: unknown }).digest;
    if (typeof digest === "string") return digest;
    throw error;
  }
  throw new Error("Esperava um erro de controle de fluxo do Next.");
}

const paginaDoMapa = () => import("@/app/(app)/mapa/page");

// ---------------------------------------------------------------------------
// UI-MAP-01 · UI-MAP-02 · UI-MAP-03 — o portão da página
// ---------------------------------------------------------------------------

describe("UI-MAP-01/02/03 — acesso à página", () => {
  it("UI-MAP-01 · ADMIN abre o Mapa Operacional", async () => {
    const { default: MapaPage } = await paginaDoMapa();
    session.token = await createTokenFor(fixture.adminA.id);

    await expect(MapaPage({})).resolves.toBeTruthy();
  });

  it("UI-MAP-01b · DISPATCHER também abre — é a decisão da CTO-3.1", async () => {
    const { default: MapaPage } = await paginaDoMapa();
    session.token = await createTokenFor(fixture.dispatcherA.id);

    await expect(MapaPage({})).resolves.toBeTruthy();
  });

  it("UI-MAP-02 · TECHNICIAN não abre, mesmo digitando a URL", async () => {
    const { default: MapaPage } = await paginaDoMapa();
    session.token = await createTokenFor(fixture.techA.id);

    expect(await redirectTargetOf(() => MapaPage({}))).toBe("/minhas-os");
  });

  it("UI-MAP-02b · sem sessão vai para o login", async () => {
    const { default: MapaPage } = await paginaDoMapa();
    session.token = null;

    expect(await redirectTargetOf(() => MapaPage({}))).toBe("/login");
  });

  it("UI-MAP-03 · capability desligada: a página não existe", async () => {
    await prisma.company.update({
      where: { id: fixture.companyA.id },
      data: { ctoNetworkEnabled: false },
    });

    const { default: MapaPage } = await paginaDoMapa();
    session.token = await createTokenFor(fixture.adminA.id);

    expect(await digestOf(() => MapaPage({}))).toMatch(/^NEXT_NOT_FOUND|^NEXT_HTTP_ERROR_FALLBACK;404/);
  });

  it("UI-MAP-03b · o item de menu segue a mesma capability", async () => {
    const ligada = navigationFor("ADMIN", { ctoNetworkEnabled: true });
    const desligada = navigationFor("ADMIN", { ctoNetworkEnabled: false });

    expect(ligada.map((i) => i.href)).toContain("/mapa");
    expect(desligada.map((i) => i.href)).not.toContain("/mapa");
  });

  it("UI-MAP-03c · o item aparece para DISPATCHER e nunca para TECHNICIAN", async () => {
    const features = { ctoNetworkEnabled: true };

    expect(navigationFor("DISPATCHER", features).map((i) => i.href)).toContain(
      "/mapa",
    );
    expect(
      navigationFor("TECHNICIAN", features).map((i) => i.href),
    ).not.toContain("/mapa");
  });

  it("UI-MAP-03d · a superfície se chama Mapa Operacional, e há UMA entrada", async () => {
    const itens = navigationFor("ADMIN", { ctoNetworkEnabled: true });
    const doMapa = itens.filter((i) => i.href.startsWith("/mapa"));

    expect(doMapa).toHaveLength(1);
    expect(doMapa[0].label).toBe("Mapa Operacional");
    // "Mapa de CTOs" faria a segunda camada nascer como uma segunda tela.
    expect(doMapa[0].label).not.toMatch(/CTO/i);
  });
});

// ---------------------------------------------------------------------------
// UI-MAP-07 a UI-MAP-11 — marcador e estado
// ---------------------------------------------------------------------------

describe("UI-MAP-07..11 — a tradução de estado para aparência", () => {
  const casos: {
    id: string;
    status: CtoMapStatus;
    shape: string;
    tone: string;
  }[] = [
    { id: "UI-MAP-07", status: "AVAILABLE", shape: "circle", tone: "success" },
    { id: "UI-MAP-08", status: "FULL", shape: "square", tone: "warning" },
    { id: "UI-MAP-09", status: "DAMAGED", shape: "triangle", tone: "danger" },
    { id: "UI-MAP-10", status: "INACTIVE", shape: "diamond", tone: "neutral" },
  ];

  for (const caso of casos) {
    it(`${caso.id} · ${caso.status} tem forma e tom próprios`, () => {
      const p = ctoMapStatusPresentation(caso.status);

      expect(p.status).toBe(caso.status);
      expect(p.shape).toBe(caso.shape);
      expect(p.tone).toBe(caso.tone);
    });
  }

  it("UI-MAP-11 · o estado NUNCA depende só de cor", () => {
    const todos = Object.values(CTO_MAP_STATUS_PRESENTATION);

    /*
      Três eixos independentes, e cada um sozinho já distingue os quatro
      estados: forma (para quem não vê cor), glifo (para quem vê o marcador
      pequeno) e rótulo (para quem lê a legenda ou o popup).

      Afirmar apenas "existe um rótulo" deixaria passar uma regressão em que
      dois estados compartilhassem a forma — que é o eixo que sobrevive a uma
      captura em preto e branco.
    */
    expect(new Set(todos.map((p) => p.tone)).size).toBe(4);
    expect(new Set(todos.map((p) => p.shape)).size).toBe(4);
    expect(new Set(todos.map((p) => p.glyph)).size).toBe(4);
    expect(new Set(todos.map((p) => p.label)).size).toBe(4);

    for (const p of todos) {
      expect(p.label.trim().length).toBeGreaterThan(0);
      expect(p.description.trim().length).toBeGreaterThan(0);
    }
  });

  it("UI-MAP-11b · a apresentação NÃO recalcula o status a partir do resumo", () => {
    /*
      `ctoMapStatusPresentation` recebe o status pronto e nada mais. Se um dia
      alguém lhe passar o `summary`, esta assinatura muda — e é a mudança de
      assinatura que denuncia a segunda precedência nascendo no cliente.
    */
    expect(ctoMapStatusPresentation.length).toBe(1);

    // E a tabela cobre exatamente os quatro valores do contrato, sem inventar
    // um quinto e sem esquecer nenhum.
    expect(Object.keys(CTO_MAP_STATUS_PRESENTATION).sort()).toEqual([
      "AVAILABLE",
      "DAMAGED",
      "FULL",
      "INACTIVE",
    ]);
  });
});

// ---------------------------------------------------------------------------
// UI-MAP-04 — o bbox que sai do Leaflet
// ---------------------------------------------------------------------------

describe("UI-MAP-04 — o recorte enviado ao backend", () => {
  it("UI-MAP-04 · os quatro lados viram query string", () => {
    const query = boundingBoxToQuery({
      north: -20,
      south: -21,
      east: -41,
      west: -42,
    });
    const params = new URLSearchParams(query);

    expect(params.get("north")).toBe("-20");
    expect(params.get("south")).toBe("-21");
    expect(params.get("east")).toBe("-41");
    expect(params.get("west")).toBe("-42");
  });

  it("UI-MAP-04b · um recorte normal atravessa sem alteração", () => {
    const bruto = { north: -20.1, south: -20.9, east: -41.2, west: -41.8 };
    expect(boundingBoxFromLatLngBounds(bruto)).toEqual(bruto);
  });

  it("UI-MAP-04c · latitude fora do planeta é limitada, não enviada", () => {
    const r = boundingBoxFromLatLngBounds({
      north: 118.4,
      south: -97.2,
      east: -41,
      west: -42,
    });

    expect(r.north).toBe(90);
    expect(r.south).toBe(-90);
  });

  it("UI-MAP-04d · a volta ao mundo vira o mundo, e não um 400", () => {
    const r = boundingBoxFromLatLngBounds({
      north: 70,
      south: -70,
      east: 540,
      west: -540,
    });

    expect(r.west).toBe(-180);
    expect(r.east).toBe(180);
  });

  it("UI-MAP-04e · recorte que cruzaria o antimeridiano vira o mundo", () => {
    // Centrado em 180°: o Leaflet devolveria oeste 170 e leste -170, que o
    // domínio recusa com `west > east`.
    const r = boundingBoxFromLatLngBounds({
      north: 10,
      south: -10,
      east: -170,
      west: 170,
    });

    expect(r.west).toBe(-180);
    expect(r.east).toBe(180);
    // E o resultado é sempre aceitável pelo domínio.
    expect(r.west).toBeLessThanOrEqual(r.east);
  });

  it("UI-MAP-04f · o que sai daqui nunca é recusado pelo `assertBoundingBox`", async () => {
    const { assertBoundingBox } = await import("@/lib/cto-map");

    const entradas = [
      { north: 95, south: -95, east: 400, west: -400 },
      { north: 10, south: -10, east: -170, west: 170 },
      { north: -20, south: -21, east: -41, west: -42 },
      { north: 0.5, south: -0.5, east: 0.5, west: -0.5 },
    ];

    for (const entrada of entradas) {
      const traduzido = boundingBoxFromLatLngBounds(entrada);
      expect(() => assertBoundingBox(traduzido)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// UI-MAP-05 / UI-MAP-06 — cadência e resposta atrasada
// ---------------------------------------------------------------------------

describe("UI-MAP-05/06 — cadência e ordem das respostas", () => {
  it("UI-MAP-05 · existe um atraso declarado entre mover e consultar", () => {
    /*
      A cadência real — "não uma requisição por pixel" — é medida no Playwright,
      contando requisições durante um arrasto. Aqui só se afirma que o atraso é
      uma constante do módulo, e não um número solto dentro do componente: zerá-lo
      é uma mudança visível no diff.
    */
    expect(CTO_MAP_VIEWPORT_DEBOUNCE_MS).toBeGreaterThan(0);
    expect(CTO_MAP_VIEWPORT_DEBOUNCE_MS).toBeLessThanOrEqual(1000);
  });

  it("UI-MAP-06 · a resposta antiga não é mais a atual quando a nova começou", () => {
    const guarda = createLatestRequestGuard();

    const primeira = guarda.begin();
    const segunda = guarda.begin();

    // A segunda saiu depois: a primeira perdeu o direito de escrever no estado.
    expect(guarda.isCurrent(primeira)).toBe(false);
    expect(guarda.isCurrent(segunda)).toBe(true);
  });

  it("UI-MAP-06b · o bairro lento não sobrescreve o bairro atual", () => {
    const guarda = createLatestRequestGuard();
    const estado: string[] = [];

    const bairroA = guarda.begin();
    const bairroB = guarda.begin();

    // B responde primeiro (é o bairro com três caixas).
    if (guarda.isCurrent(bairroB)) estado.push("B");
    // A responde depois (o bairro com duzentas) — e é DESCARTADO.
    if (guarda.isCurrent(bairroA)) estado.push("A");

    expect(estado).toEqual(["B"]);
  });

  it("UI-MAP-06c · cada guarda é independente da outra", () => {
    const mapa = createLatestRequestGuard();
    const busca = createLatestRequestGuard();

    const doMapa = mapa.begin();
    busca.begin();
    busca.begin();

    // Buscar duas vezes não invalida a leitura do recorte em voo.
    expect(mapa.isCurrent(doMapa)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Configuração de tiles
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// MAPUX-01..06 — as três bases e a CSP
// ---------------------------------------------------------------------------

describe("MAPUX-01..06 — configuração das bases de mapa", () => {
  it("MAPUX-01 · a base normal é o OpenStreetMap, com atribuição", () => {
    const config = readMapTileConfig({});

    expect(config.normal.urlTemplate).toBe(DEFAULT_NORMAL_URL);
    expect(config.normal.attribution).toContain("OpenStreetMap");
    expect(config.normal.maxNativeZoom).toBe(19);
  });

  it("MAPUX-02 · o satélite tem provedor PRÓPRIO, e não é o da base normal", () => {
    const config = readMapTileConfig({});

    expect(config.satellite).not.toBeNull();
    expect(config.satellite!.urlTemplate).not.toBe(config.normal.urlTemplate);
    expect(config.satellite!.attribution).not.toBe("");

    // Hosts diferentes: se um dia alguém apontar o satélite para o mesmo
    // provedor da base normal, o botão passaria a trocar duas imagens iguais.
    const host = (u: string) => new URL(u.replace("{s}", "s")).host;
    expect(host(config.satellite!.urlTemplate)).not.toBe(
      host(config.normal.urlTemplate),
    );
  });

  it("MAPUX-02b · o satélite padrão usa a ordem `{z}/{y}/{x}` do provedor", () => {
    /*
      Medido ao vivo antes de virar padrão: o Esri publica LINHA antes de
      coluna. Escrever na ordem habitual `{z}/{x}/{y}` devolve tiles de outro
      lugar do planeta — e esse é o pior tipo de defeito, porque o mapa carrega,
      parece funcionar, e mostra a cidade errada.
    */
    const url = readMapTileConfig({}).satellite!.urlTemplate;

    expect(url.indexOf("{y}")).toBeLessThan(url.indexOf("{x}"));
    expect(url).toContain("{z}");
  });

  it("MAPUX-03 · o híbrido é o satélite MAIS uma camada de rótulos", () => {
    const config = readMapTileConfig({});

    expect(config.hybrid).not.toBeNull();
    // A base do híbrido é a MESMA do satélite, e não uma segunda configuração:
    // duas cópias divergiriam na primeira troca de provedor.
    expect(config.hybrid!.base).toBe(config.satellite);
    expect(config.hybrid!.labels.urlTemplate).not.toBe(
      config.satellite!.urlTemplate,
    );
    expect(config.hybrid!.labels.attribution).not.toBe("");
  });

  it("MAPUX-03b · a camada de rótulos é SÓ rótulos, e é a variante clara", () => {
    // `dark_only_labels` é a de texto CLARO — a legível sobre imagem de
    // satélite, que é escura. A `light` sumiria sobre asfalto e telhado.
    expect(readMapTileConfig({}).hybrid!.labels.urlTemplate).toContain(
      "only_labels",
    );
  });

  it("MAPUX-04 · a preferência de base tem chave e parser próprios", () => {
    expect(MAP_MODE_STORAGE_KEY).toMatch(/^alfaos\./);

    for (const modo of MAP_MODES) {
      expect(parseMapMode(modo)).toBe(modo);
    }
    // Tolerante ao que o navegador devolveu, estrito com o resto.
    expect(parseMapMode("satellite")).toBe("SATELLITE");
    expect(parseMapMode(" hybrid ")).toBe("HYBRID");
    expect(parseMapMode("TERRAIN")).toBeNull();
    expect(parseMapMode(null)).toBeNull();
    expect(parseMapMode(3)).toBeNull();
  });

  it("MAPUX-05 · sem satélite o mapa CONTINUA, com um modo a menos", () => {
    const config = readMapTileConfig({ MAP_SATELLITE_ENABLED: "false" });

    // O que importa: a base normal sobrevive inteira.
    expect(config.normal.urlTemplate).toBe(DEFAULT_NORMAL_URL);
    expect(config.satellite).toBeNull();
    // O híbrido cai junto por consequência: ele É o satélite com rótulos.
    expect(config.hybrid).toBeNull();

    expect(availableMapModes(config as never)).toEqual(["NORMAL"]);
  });

  it("MAPUX-05b · variável escrita errada NÃO desliga o satélite em silêncio", () => {
    // Comparação exata com "false", o mesmo padrão de `SGP_ACTIVATION_ENABLED`.
    for (const valor of ["FALSE", "0", "no", "nao", "off", ""]) {
      expect(
        readMapTileConfig({ MAP_SATELLITE_ENABLED: valor }).satellite,
        `"${valor}" desligou o satélite`,
      ).not.toBeNull();
    }
  });

  it("MAPUX-05c · com tudo ligado, os três modos ficam disponíveis", () => {
    expect(availableMapModes(readMapTileConfig({}) as never)).toEqual([
      "NORMAL",
      "SATELLITE",
      "HYBRID",
    ]);
  });

  it("MAPUX-06 · a CSP recebe as TRÊS origens, derivadas da configuração", () => {
    const origens = tileImageSources(readMapTileConfig({}));

    expect(origens).toHaveLength(3);
    expect(origens).toContain("https://tile.openstreetmap.org");
    expect(origens).toContain("https://server.arcgisonline.com");
    // `{s}` vira curinga PRESO ao domínio configurado.
    expect(origens).toContain("https://*.basemaps.cartocdn.com");
  });

  it("MAPUX-06b · desligar o satélite ENCOLHE a política", () => {
    const origens = tileImageSources(
      readMapTileConfig({ MAP_SATELLITE_ENABLED: "false" }),
    );

    expect(origens).toEqual(["https://tile.openstreetmap.org"]);
  });

  it("MAPUX-06c · a CSP do projeto NÃO usa curinga global", () => {
    /*
      `img-src *` resolveria o sintoma de tile bloqueado e destruiria a
      política: qualquer host da internet passaria a entregar imagem para
      dentro da aplicação. Este teste lê a configuração REAL do Next.
    */
    const config = semComentarios(leia("next.config.mjs"));

    expect(config).toMatch(/img-src/);
    expect(config).not.toMatch(/img-src[^`"']*\*(?!\.)/);
    expect(config).not.toMatch(/img-src\s+\*/);
    // E a política é montada a partir da configuração, não de hosts escritos
    // à mão: um host repetido aqui seria o segundo lugar a esquecer.
    expect(config).toContain("tileImageSources");
    expect(config).not.toContain("openstreetmap.org");
    expect(config).not.toContain("arcgisonline.com");
    expect(config).not.toContain("cartocdn.com");
  });

  it("MAPUX-06d · cada origem é um host concreto, nunca um esquema solto", () => {
    for (const origem of tileImageSources(readMapTileConfig({}))) {
      expect(origem).toMatch(/^https:\/\/(\*\.)?[a-z0-9.-]+(:\d+)?$/);
      expect(origem).not.toBe("https:");
      expect(origem).not.toBe("*");
    }
  });

  it("o ambiente troca qualquer das três sem tocar em componente", () => {
    const config = readMapTileConfig({
      MAP_TILE_URL: "https://normal.exemplo.com/{z}/{x}/{y}.png",
      MAP_TILE_SATELLITE_URL: "https://sat.exemplo.com/{z}/{x}/{y}.jpg",
      MAP_TILE_HYBRID_LABELS_URL: "https://rot.exemplo.com/{z}/{x}/{y}.png",
      MAP_TILE_SATELLITE_MAX_NATIVE_ZOOM: "17",
    });

    expect(config.normal.urlTemplate).toContain("normal.exemplo.com");
    expect(config.satellite!.urlTemplate).toContain("sat.exemplo.com");
    expect(config.satellite!.maxNativeZoom).toBe(17);
    expect(config.hybrid!.labels.urlTemplate).toContain("rot.exemplo.com");
    expect(tileImageSources(config)).toEqual([
      "https://normal.exemplo.com",
      "https://sat.exemplo.com",
      "https://rot.exemplo.com",
    ]);
  });

  it("provedor trocado NÃO herda a atribuição do padrão", () => {
    /*
      Herdar seria creditar um provedor pelo mapa de outro — e a atribuição é
      exigência de licença, não enfeite.
    */
    const config = readMapTileConfig({
      MAP_TILE_URL: "https://normal.exemplo.com/{z}/{x}/{y}.png",
      MAP_TILE_SATELLITE_URL: "https://sat.exemplo.com/{z}/{x}/{y}.jpg",
    });

    expect(config.normal.attribution).toBe("");
    expect(config.satellite!.attribution).toBe("");
  });

  it("variável em branco cai no padrão, em vez de virar URL vazia", () => {
    expect(readMapTileConfig({ MAP_TILE_URL: "   " }).normal.urlTemplate).toBe(
      DEFAULT_NORMAL_URL,
    );
  });

  it("zoom inválido cai no padrão", () => {
    for (const bruto of ["0", "23", "abc", "12.5", ""]) {
      expect(
        readMapTileConfig({ MAP_TILE_MAX_NATIVE_ZOOM: bruto }).normal.maxNativeZoom,
      ).toBe(19);
    }
  });

  it("URL inválida falha ALTO, e não vira CSP silenciosamente inútil", () => {
    expect(() => tileImageSource("javascript:alert(1)")).toThrow();
    expect(() => tileImageSource("data:image/png;base64,AAAA")).toThrow();
    expect(() => tileImageSource("/relativa/{z}/{x}/{y}.png")).toThrow();
    expect(() => tileImageSource("")).toThrow();
  });

  it("`getMapTileConfig` valida TODAS as camadas ao montar a página", () => {
    // A falha precisa acontecer aqui, e não como um mapa cinza sem explicação
    // no navegador de quem despacha.
    expect(() =>
      getMapTileConfig({ MAP_TILE_URL: "ftp://tiles.exemplo.com/{z}.png" }),
    ).toThrow();
    expect(() =>
      getMapTileConfig({ MAP_TILE_SATELLITE_URL: "nao-e-url" }),
    ).toThrow();
    expect(() =>
      getMapTileConfig({ MAP_TILE_HYBRID_LABELS_URL: "javascript:1" }),
    ).toThrow();
  });

  /*
    S1 · a sabotagem que este teste precisa derrubar.

    Se alguém escrever a URL do tile dentro do componente, a CSP continuará
    liberando o host da configuração — e o mapa abre cinza sem nenhum erro
    visível, porque violação de CSP apaga a imagem em vez de quebrar a página.
  */
  it("S1 · nenhum componente do mapa contém URL de tile", () => {
    const arquivos = [
      "src/components/map/MapCanvas.tsx",
      "src/components/map/OperationalMap.tsx",
      "src/components/map/CtoMapLayer.tsx",
      "src/components/map/CtoMarkers.tsx",
      "src/components/map/cto-marker-icon.ts",
      "src/app/(app)/mapa/page.tsx",
    ];

    for (const arquivo of arquivos) {
      const codigo = semComentarios(leia(arquivo));

      expect(codigo, `${arquivo} contém template de tile`).not.toMatch(
        /\{z\}[^\n]*\{x\}[^\n]*\{y\}/,
      );
      expect(codigo, `${arquivo} contém host de tile`).not.toMatch(
        /https?:\/\/[^"'\s]*(tile|basemap|arcgis)/i,
      );
      expect(codigo, `${arquivo} cita o OpenStreetMap`).not.toMatch(
        /openstreetmap/i,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// MAPUX-07..11 — o marcador de caixa óptica
// ---------------------------------------------------------------------------

describe("MAPUX-07..11 — o marcador é uma CTO, não um alfinete", () => {
  it("MAPUX-07 · o marcador é SVG próprio do projeto", () => {
    const html = ctoMarkerHtml(ctoMapStatusPresentation("AVAILABLE"), false);

    expect(html.startsWith("<svg")).toBe(true);
    expect(html).toContain("viewBox");
    // A silhueta da caixa: corpo, tampa e portas. É isto que distingue a CTO de
    // um ponto genérico quando técnico, cliente e OS estiverem no mesmo mapa.
    expect(html).toContain("cto-box__body");
    expect(html).toContain("cto-box__lid");
    expect(html).toContain("cto-box__ports");
    expect(html).toContain("cto-box__tray");
  });

  it("MAPUX-07b · o alfinete padrão do Leaflet NÃO é usado", () => {
    /*
      O Leaflet cai no `marker-icon.png` dele quando nenhum ícone é informado —
      e com bundler esse caminho costuma nem resolver, produzindo um marcador
      quebrado. Aqui todo marcador recebe `divIcon` explícito.
    */
    const codigo = semComentarios(leia("src/components/map/CtoMarkers.tsx"));

    expect(codigo).toContain("divIcon");
    expect(codigo).toContain("ctoMarkerHtml");
    /*
      O alvo é o ASSET do Leaflet, e não a palavra.

      A primeira versão deste teste procurava `marker-icon` e falhava no meu
      próprio `import "./cto-marker-icon"` — exatamente o defeito de teste
      estrutural que a `CTO-2.5` já tinha cobrado três vezes: a busca casava com
      o nome do arquivo que existe justamente para NÃO usar o alfinete padrão.
    */
    expect(codigo).not.toMatch(/marker-icon\.png/);
    expect(codigo).not.toMatch(/leaflet\/dist\/images/);
    expect(codigo).not.toMatch(/new\s+Icon\(/);
    expect(codigo).not.toMatch(/\bL\.Icon\b/);
    // Todo `<Marker` do arquivo carrega `icon=`: um marcador sem ícone cairia
    // no alfinete padrão sem que nada quebrasse.
    const marcadores = codigo.match(/<Marker[\s\S]*?>/g) ?? [];
    expect(marcadores.length).toBeGreaterThan(0);
    for (const m of marcadores) expect(m).toContain("icon=");
  });

  const estados: { id: string; status: CtoMapStatus; forma: string }[] = [
    { id: "MAPUX-08", status: "AVAILABLE", forma: "circle" },
    { id: "MAPUX-09", status: "FULL", forma: "rect" },
    { id: "MAPUX-10", status: "DAMAGED", forma: "polygon" },
    { id: "MAPUX-11", status: "INACTIVE", forma: "polygon" },
  ];

  for (const caso of estados) {
    it(`${caso.id} · ${caso.status} tem caixa, selo e glifo`, () => {
      const p = ctoMapStatusPresentation(caso.status);
      const html = ctoMarkerHtml(p, false);

      // A caixa é a mesma nos quatro: é a identidade da CTO.
      expect(html).toContain("cto-box__body");
      // O selo é o que muda, e ele carrega FORMA e GLIFO — nunca só cor.
      expect(html).toContain("cto-box__badge");
      expect(html).toContain(`cto-box--${p.tone}`);

      /*
        O glifo é procurado DENTRO do `<text>`, e não no HTML inteiro.

        A primeira versão fazia `toContain(p.glyph)`, e a sabotagem `S4` mostrou
        o preço: o glifo do `FULL` é `"0"`, e `viewBox="0 0 40 40"` já contém um
        zero. O teste passava com o `<text>` inteiro removido — verde por
        coincidência de substring, sobre um marcador que tinha perdido o único
        sinal que não é cor.
      */
      const texto = /<text[^>]*>([^<]*)<\/text>/.exec(html)?.[1];
      expect(texto, "o marcador perdeu o glifo").toBe(p.glyph);
      expect(html).toMatch(
        new RegExp(`<g class="cto-box__badge"><${caso.forma}`),
      );
    });
  }

  it("S4 · remover o glifo deixaria o estado só na cor — e isto detecta", () => {
    const glifos = (["AVAILABLE", "FULL", "DAMAGED", "INACTIVE"] as const).map(
      (s) => {
        const html = ctoMarkerHtml(ctoMapStatusPresentation(s), false);
        const texto = /<text[^>]*>([^<]*)<\/text>/.exec(html)?.[1] ?? "";
        return texto;
      },
    );

    // Quatro glifos distintos e nenhum vazio: cada estado é legível sem cor.
    expect(new Set(glifos).size).toBe(4);
    for (const g of glifos) expect(g.trim()).not.toBe("");
  });

  it("S4b · as quatro formas do selo são elementos SVG DIFERENTES", () => {
    const selos = (["AVAILABLE", "FULL", "DAMAGED", "INACTIVE"] as const).map(
      (s) =>
        /<g class="cto-box__badge">(.*?)<\/g>/.exec(
          ctoMarkerHtml(ctoMapStatusPresentation(s), false),
        )?.[1] ?? "",
    );

    // Sem isto, trocar as quatro formas pela mesma passaria: a cor mudaria e o
    // teste de tom continuaria verde.
    expect(new Set(selos).size).toBe(4);
  });

  it("MAPUX-07c · o marcador selecionado ganha ANEL, não outra cor", () => {
    const p = ctoMapStatusPresentation("AVAILABLE");
    const normal = ctoMarkerHtml(p, false);
    const selecionado = ctoMarkerHtml(p, true);

    expect(selecionado).toContain("cto-box--selected");
    expect(normal).not.toContain("cto-box--selected");
    // O tom NÃO muda: mudar a cor se confundiria com mudança de estado.
    expect(selecionado).toContain(`cto-box--${p.tone}`);
  });

  it("MAPUX-07d · nome e código NUNCA entram no HTML do ícone", () => {
    /*
      `divIcon` injeta HTML cru. Uma interpolação de `marker.name` aqui
      transformaria o nome da caixa em markup — e o nome é digitado por gente.
    */
    const codigo = semComentarios(
      leia("src/components/map/cto-marker-icon.ts"),
    );

    for (const proibido of ["name", "code", "marker."]) {
      expect(codigo, `o ícone referencia ${proibido}`).not.toContain(proibido);
    }

    // E o construtor só recebe apresentação e um booleano.
    expect(ctoMarkerHtml.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// NAVMAP — a origem da navegação
// ---------------------------------------------------------------------------

describe("NAVMAP-01/02/03/09 — de onde o operador veio", () => {
  const abrirDetalhe = async (
    id: string,
    searchParams?: Record<string, string | string[] | undefined>,
  ) => {
    const { default: Pagina } = await import("@/app/(app)/ctos/[id]/page");
    return Pagina({ params: { id }, searchParams });
  };

  /** Procura um nó da árvore de React pelo `data-testid`. */
  function acharPorTestId(no: unknown, testId: string): Record<string, unknown> | null {
    if (!no || typeof no !== "object") return null;
    if (Array.isArray(no)) {
      for (const filho of no) {
        const achado = acharPorTestId(filho, testId);
        if (achado) return achado;
      }
      return null;
    }
    const props = (no as { props?: Record<string, unknown> }).props;
    if (!props) return null;
    if (props["data-testid"] === testId) return props;
    return acharPorTestId(props.children, testId);
  }

  let ctoId = "";

  beforeEach(async () => {
    session.token = await createTokenFor(fixture.adminA.id);
    const cto = await createCto(fixture.companyA.id, fixture.adminA.id, {
      name: "Caixa da navegação",
      capacity: 8,
      latitude: -20.5,
      longitude: -41.5,
    });
    ctoId = cto.id;
  });

  it("NAVMAP-01 · vindo do mapa, o retorno é o Mapa Operacional — com a vista", async () => {
    const arvore = await abrirDetalhe(ctoId, {
      returnTo: "/mapa",
      lat: "-20.512345",
      lng: "-41.498765",
      z: "17",
      mode: "HYBRID",
      q: "A16",
    });

    const link = acharPorTestId(arvore, "cto-back-link");
    expect(link).not.toBeNull();
    expect(link!.children).toBe("← Mapa Operacional");

    const href = String(link!.href);
    expect(href.startsWith("/mapa?")).toBe(true);
    const params = new URLSearchParams(href.split("?")[1]);
    expect(params.get("lat")).toBe("-20.512345");
    expect(params.get("lng")).toBe("-41.498765");
    expect(params.get("z")).toBe("17");
    expect(params.get("mode")).toBe("HYBRID");
    expect(params.get("q")).toBe("A16");
  });

  it("NAVMAP-02 · sem origem declarada, o retorno continua sendo a listagem", async () => {
    const link = acharPorTestId(await abrirDetalhe(ctoId), "cto-back-link");

    expect(link!.children).toBe("← CTOs");
    expect(link!.href).toBe("/ctos");
  });

  it("NAVMAP-03 · link direto com vista, mas SEM origem, não vira volta ao mapa", async () => {
    // Alguém colou os parâmetros sem o `returnTo`: a origem é o que decide, e
    // ela não está declarada. O fallback é o seguro.
    const link = acharPorTestId(
      await abrirDetalhe(ctoId, { lat: "-20.5", lng: "-41.5", z: "16" }),
      "cto-back-link",
    );

    expect(link!.href).toBe("/ctos");
    expect(link!.children).toBe("← CTOs");
  });

  it("NAVMAP-09 · origem externa NÃO produz redirect aberto", async () => {
    const hostis = [
      "https://evil.example.com",
      "//evil.example.com",
      "/\\evil.example.com",
      "javascript:alert(1)",
      "/mapa/../../evil",
      "/mapa?x=1",
      "/mapa/",
      "%2Fmapa",
      "  /mapa",
      "/MAPA",
    ];

    for (const bruto of hostis) {
      const link = acharPorTestId(
        await abrirDetalhe(ctoId, { returnTo: bruto }),
        "cto-back-link",
      );
      expect(link!.href, `"${bruto}" escapou`).toBe("/ctos");
    }
  });

  it("NAVMAP-09b · a allowlist é ANCORADA, e o mapa entrou como caminho puro", () => {
    expect(parseReturnTo("/mapa")).toEqual({ kind: "operational-map" });
    expect(buildReturnTo({ kind: "operational-map" })).toBe("/mapa");

    // Nada de query dentro do `returnTo`: a vista viaja em parâmetros próprios,
    // cada um validado, e o parser continua sendo uma igualdade.
    expect(parseReturnTo("/mapa?lat=1")).toBeNull();
    expect(parseReturnTo("/mapa#x")).toBeNull();
  });

  it("NAVMAP-09c · coordenada hostil na volta é DESCARTADA, não ecoada", async () => {
    const link = acharPorTestId(
      await abrirDetalhe(ctoId, {
        returnTo: "/mapa",
        lat: "1e400",
        lng: "NaN",
        z: "-5",
        mode: "<script>",
        q: "x".repeat(500),
      }),
      "cto-back-link",
    );

    const href = String(link!.href);
    expect(href).toBe("/mapa");
    // Nada do que o cliente escreveu sobreviveu até a `href`.
    expect(href).not.toContain("script");
    expect(href).not.toContain("1e400");
    expect(href).not.toContain("NaN");
  });
});

// ---------------------------------------------------------------------------
// NAVMAP-04..08 — o núcleo determinístico da restauração
// ---------------------------------------------------------------------------

describe("NAVMAP-04..08 — a vista sobrevive à ida e à volta", () => {
  const vista = {
    latitude: -20.512345,
    longitude: -41.498765,
    zoom: 17,
    mode: "HYBRID" as const,
    search: "A16",
    selectedId: "c" + "a1b2c3d4e5f6g7h8i9j0",
  };

  it("NAVMAP-04..08 · o que é montado é exatamente o que é lido de volta", () => {
    const query = buildMapViewQuery(vista);
    const lido = parseMapViewParams(
      Object.fromEntries(new URLSearchParams(query)),
    );

    expect(lido.latitude).toBeCloseTo(vista.latitude, 6); // centro
    expect(lido.longitude).toBeCloseTo(vista.longitude, 6);
    expect(lido.zoom).toBe(vista.zoom); // zoom
    expect(lido.search).toBe(vista.search); // busca
    expect(lido.selectedId).toBe(vista.selectedId); // seleção
    expect(lido.mode).toBe(vista.mode); // base
  });

  it("campo vazio é OMITIDO, e não escrito em branco", () => {
    const query = buildMapViewQuery({ mode: "NORMAL" });

    expect(query).toBe("mode=NORMAL");
    expect(query).not.toContain("q=");
    expect(query).not.toContain("sel=");
    expect(query).not.toContain("lat=");
  });

  it("a URL não carrega marcador nenhum — ela é endereço, não cache", () => {
    const query = buildMapViewQuery(vista);
    const chaves = Array.from(new URLSearchParams(query).keys()).sort();

    expect(chaves).toEqual(["lat", "lng", "mode", "q", "sel", "z"]);
  });

  it("coordenada fora do planeta não chega ao Leaflet", () => {
    /*
      `setView` com `Infinity` não desenha o mapa em lugar errado: ele lança, e
      o componente inteiro cai. Mesma lição da `CTO-1.1`, onde `Number.isNaN`
      deixava `"Infinity"` passar e só `Number.isFinite` fechava.
    */
    for (const bruto of ["1e400", "Infinity", "-Infinity", "NaN", "abc", "91"]) {
      const lido = parseMapViewParams({ lat: bruto, lng: "-41.5" });
      expect(lido.latitude, `lat=${bruto}`).toBeUndefined();
      expect(lido.longitude, `lat=${bruto}`).toBeUndefined();
    }

    expect(parseMapViewParams({ lat: "-20.5", lng: "181" }).longitude)
      .toBeUndefined();
    expect(parseMapViewParams({ z: "0" }).zoom).toBeUndefined();
    expect(parseMapViewParams({ z: "99" }).zoom).toBeUndefined();
  });

  it("meia coordenada não posiciona nada", () => {
    // A mesma regra que a `CTO-3.1` aplica à caixa sem localização.
    expect(parseMapViewParams({ lat: "-20.5" }).latitude).toBeUndefined();
    expect(parseMapViewParams({ lng: "-41.5" }).longitude).toBeUndefined();
  });

  it("um campo inválido não descarta os campos bons", () => {
    const lido = parseMapViewParams({
      lat: "-20.5",
      lng: "-41.5",
      z: "999",
      mode: "TERRAIN",
    });

    expect(lido.latitude).toBe(-20.5);
    expect(lido.longitude).toBe(-41.5);
    expect(lido.zoom).toBeUndefined();
    expect(lido.mode).toBeUndefined();
  });

  it("o termo de busca tem o MESMO teto do domínio", () => {
    const longo = "x".repeat(200);
    expect(parseMapViewParams({ q: longo }).search).toBeUndefined();
    expect(buildMapViewQuery({ search: longo }).length).toBeLessThan(120);
  });

  it("o identificador selecionado é conferido contra o formato interno", () => {
    expect(parseMapViewParams({ sel: "../../etc/passwd" }).selectedId)
      .toBeUndefined();
    expect(parseMapViewParams({ sel: "<script>" }).selectedId).toBeUndefined();
    expect(buildMapViewQuery({ selectedId: "<script>" })).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Vista inicial
// ---------------------------------------------------------------------------

describe("Vista inicial — do banco, nunca de GPS nem de constante escondida", () => {
  it("sem caixa localizada, cai no ponto de país", async () => {
    const view = await getCtoMapInitialView(fixture.companyA.id, {});

    expect(view.kind).toBe("point");
    if (view.kind === "point") {
      expect(view.point).toEqual(MAP_FALLBACK_POINT);
      // Zoom de país: quem abre entende na hora que o mapa não sabe onde ele
      // opera, em vez de procurar a própria cidade num ponto plausível e errado.
      expect(view.point.zoom).toBeLessThanOrEqual(5);
    }
  });

  it("com caixas localizadas, o retângulo é o extremo delas", async () => {
    await createCto(fixture.companyA.id, fixture.adminA.id, {
      name: "Sul",
      capacity: 8,
      latitude: -20.9,
      longitude: -41.9,
    });
    await createCto(fixture.companyA.id, fixture.adminA.id, {
      name: "Norte",
      capacity: 8,
      latitude: -20.1,
      longitude: -41.1,
    });

    const view = await getCtoMapInitialView(fixture.companyA.id, {});

    expect(view.kind).toBe("bounds");
    if (view.kind === "bounds") {
      expect(view.bounds).toEqual({
        south: -20.9,
        north: -20.1,
        west: -41.9,
        east: -41.1,
      });
    }
  });

  it("a vista inicial é do TENANT: a caixa de B não move o mapa de A", async () => {
    await createCto(fixture.companyB.id, fixture.adminB.id, {
      name: "Da empresa B",
      capacity: 8,
      latitude: 48.85,
      longitude: 2.35,
    });

    const view = await getCtoMapInitialView(fixture.companyA.id, {});

    expect(view.kind).toBe("point");

    // CONTROLE POSITIVO: B enxerga a própria caixa.
    const deB = await getCtoMapInitialView(fixture.companyB.id, {});
    expect(deB.kind).toBe("bounds");
  });

  it("caixa com meia coordenada não entra no enquadramento", async () => {
    const cto = await createCto(fixture.companyA.id, fixture.adminA.id, {
      name: "Metade",
      capacity: 8,
    });
    await prisma.cTO.update({
      where: { id: cto.id },
      data: { latitude: -20.5, longitude: null },
    });

    const view = await getCtoMapInitialView(fixture.companyA.id, {});

    expect(view.kind).toBe("point");
  });

  it("o fallback é configurável, e meia configuração não vira meio ponto", () => {
    const completo = getMapFallbackPoint({
      MAP_FALLBACK_LAT: "-22.9",
      MAP_FALLBACK_LNG: "-43.2",
      MAP_FALLBACK_ZOOM: "11",
    });
    expect(completo).toEqual({ latitude: -22.9, longitude: -43.2, zoom: 11 });

    // Latitude sem longitude produziria um ponto metade escolhido e metade
    // padrão, que não é o que ninguém pediu.
    const pelaMetade = getMapFallbackPoint({ MAP_FALLBACK_LAT: "-22.9" });
    expect(pelaMetade.latitude).toBe(MAP_FALLBACK_POINT.latitude);
    expect(pelaMetade.longitude).toBe(MAP_FALLBACK_POINT.longitude);
  });

  it("coordenada fora do planeta no ambiente é ignorada", () => {
    const p = getMapFallbackPoint({
      MAP_FALLBACK_LAT: "999",
      MAP_FALLBACK_LNG: "-43.2",
    });
    expect(p.latitude).toBe(MAP_FALLBACK_POINT.latitude);
  });
});

// ---------------------------------------------------------------------------
// A fronteira servidor / cliente
// ---------------------------------------------------------------------------

const RAIZ = path.resolve(__dirname, "..", "..");

function leia(relativo: string): string {
  return readFileSync(path.join(RAIZ, relativo), "utf8");
}

/**
 * Remove comentários antes de olhar o código.
 *
 * A `CTO-2.5` perdeu três testes estruturais para as PRÓPRIAS frases: eles
 * grepavam o arquivo cru e liam um comentário que dizia *"não chamamos X"* como
 * se fosse uma chamada a X. Um teste estrutural que lê comentário mede a
 * documentação, não o código.
 */
function semComentarios(codigo: string): string {
  return codigo
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("Fronteira servidor/cliente", () => {
  /*
    A lição da `DQ-4`, e ela custou a página de LOGIN inteira.

    Um componente de cliente importou rótulos de `service-orders.ts`, esse
    módulo alcançava `node:crypto`, e o webpack derrubou a rota. Aqui o risco
    equivalente é `cto-map.ts`, que importa `prisma`: um `import` de valor a
    partir do módulo de apresentação arrastaria o Prisma para o navegador.
  */
  it("o módulo de apresentação NÃO importa valor de `cto-map`", () => {
    const codigo = semComentarios(leia("src/lib/cto-map-presentation.ts"));
    const importacoes = codigo.match(/^import(?:(?!;)[\s\S])*?from\s+"\.\/cto-map";/gm);

    expect(importacoes).not.toBeNull();
    for (const importacao of importacoes ?? []) {
      // `import type` é apagado na compilação; `import { x }` não é.
      expect(importacao.trimStart().startsWith("import type")).toBe(true);
    }
  });

  it("o módulo de apresentação não alcança prisma, banco nem `node:`", () => {
    const codigo = semComentarios(leia("src/lib/cto-map-presentation.ts"));

    expect(codigo).not.toMatch(/from\s+"[^"]*prisma"/);
    expect(codigo).not.toMatch(/from\s+"node:/);
  });

  it("os componentes do mapa não importam valor de módulo com prisma", () => {
    for (const arquivo of [
      "src/components/map/CtoMapLayer.tsx",
      "src/components/map/CtoMarkers.tsx",
      "src/components/map/OperationalMap.tsx",
      "src/components/map/MapCanvas.tsx",
    ]) {
      const codigo = semComentarios(leia(arquivo));
      const deCtoMap = codigo.match(
        /^import(?:(?!;)[\s\S])*?from\s+"@\/lib\/cto-map";/gm,
      );
      for (const importacao of deCtoMap ?? []) {
        expect(
          importacao.trimStart().startsWith("import type"),
          `${arquivo} importa valor de @/lib/cto-map`,
        ).toBe(true);
      }

      const deMapConfig = codigo.match(
        /^import(?:(?!;)[\s\S])*?from\s+"@\/lib\/map-config";/gm,
      );
      for (const importacao of deMapConfig ?? []) {
        expect(
          importacao.trimStart().startsWith("import type"),
          `${arquivo} importa valor de @/lib/map-config`,
        ).toBe(true);
      }
    }
  });

  /*
    SSR: o grafo de módulos da PÁGINA não pode alcançar o Leaflet.

    `leaflet` toca `window` na carga, e um `import` estático quebraria o
    `next build` com `window is not defined`. Este teste roda em ambiente Node
    sem `window`: se a página importar Leaflet por um caminho síncrono, ele
    falha aqui — antes do build, e de forma permanente.
  */
  it("SSR · a página do mapa importa em Node, sem `window`", async () => {
    expect(typeof globalThis.window).toBe("undefined");

    await expect(paginaDoMapa()).resolves.toBeTruthy();
    await expect(import("@/components/map/CtoMapLayer")).resolves.toBeTruthy();
    await expect(import("@/components/map/OperationalMap")).resolves.toBeTruthy();
  });

  it("SSR · Leaflet entra apenas por `dynamic`, com `ssr: false`", () => {
    for (const arquivo of [
      "src/components/map/OperationalMap.tsx",
      "src/components/map/CtoMapLayer.tsx",
    ]) {
      const codigo = semComentarios(leia(arquivo));

      // Nenhum import estático de leaflet nos arquivos que o servidor alcança.
      expect(codigo, arquivo).not.toMatch(/^import[^\n]*from "leaflet"/m);
      expect(codigo, arquivo).not.toMatch(/^import[^\n]*from "react-leaflet"/m);
    }

    const invólucro = semComentarios(
      leia("src/components/map/OperationalMap.tsx"),
    );
    expect(invólucro).toMatch(/dynamic\(/);
    expect(invólucro).toMatch(/ssr:\s*false/);

    const camada = semComentarios(leia("src/components/map/CtoMapLayer.tsx"));
    expect(camada).toMatch(/dynamic\(/);
    expect(camada).toMatch(/ssr:\s*false/);
  });
});

// ---------------------------------------------------------------------------
// UI-MAP-13 — o popup não vaza
// ---------------------------------------------------------------------------

describe("UI-MAP-13 — o que o popup NÃO mostra", () => {
  /*
    A prova de comportamento é do Playwright, com o popup aberto de verdade.
    Aqui a asserção é estrutural e cobre o que a tela nem conseguiria mostrar:
    o componente não menciona campo nenhum que o DTO não traz.
  */
  it("UI-MAP-13 · o componente não cita cliente, histórico nem companyId", () => {
    const codigo = semComentarios(leia("src/components/map/CtoMarkers.tsx"));

    for (const proibido of [
      "companyId",
      "customer",
      "Customer",
      "connection",
      "history",
      "histórico",
      "serviceOrder",
      "notes",
      "photo",
    ]) {
      expect(codigo, `CtoMarkers cita ${proibido}`).not.toContain(proibido);
    }
  });

  /*
    XSS: nome e código são digitados por gente, e `divIcon` injeta HTML CRU.

    O ícone só pode ser montado a partir da tabela de apresentação — quatro
    formas e quatro glifos, constantes deste repositório. Uma interpolação de
    `marker.name` no `html` transformaria o nome da caixa em markup.
  */
  it("UI-MAP-13b · o ícone não interpola dado de usuário no HTML", () => {
    const codigo = semComentarios(leia("src/components/map/CtoMarkers.tsx"));
    const chamada = codigo.match(/divIcon\(\{[\s\S]*?\}\)/);

    expect(chamada).not.toBeNull();
    const html = chamada![0];

    for (const proibido of [
      "marker.name",
      "marker.code",
      "marker.id",
      "name}",
      "code}",
    ]) {
      expect(html, `divIcon interpola ${proibido}`).not.toContain(proibido);
    }
  });
});

// ---------------------------------------------------------------------------
// UXP-01..03 — a altura do mapa
// ---------------------------------------------------------------------------

/**
 * A moldura do mapa é a única coisa deste módulo que o navegador mede e o
 * `jsdom` não. O que dá para afirmar aqui é a POLÍTICA — quais alturas o
 * componente declara —, e a medida real fica no Playwright.
 */
function classesDaMoldura(): string {
  const codigo = leia("src/components/map/OperationalMap.tsx");
  const m = /className="(cto-map-shell[^"]*)"/.exec(codigo);
  if (!m) throw new Error("não achei a className da moldura do mapa");
  return m[1];
}

describe("UXP-01..03 — altura do mapa", () => {
  it("UXP-01 · a altura de desktop é limitada, e não cresce com a tela", () => {
    const classes = classesDaMoldura();

    // `lg` é o degrau de notebook/desktop, e ele é um NÚMERO de pixels.
    const lg = /lg:h-\[(\d+)px\]/.exec(classes);
    expect(lg, "falta a altura de desktop em pixels").not.toBeNull();

    const altura = Number(lg![1]);
    expect(altura).toBeGreaterThanOrEqual(500);
    expect(altura).toBeLessThanOrEqual(600);
  });

  it("UXP-02 · NENHUMA altura do mapa é fração de viewport", () => {
    /*
      O defeito que o dono relatou. Com `vh`, o mapa cresce com a tela e empurra
      busca, contadores e legenda para fora da primeira dobra — e num notebook
      com barra de tarefas ele nunca cabe inteiro.

      A proibição é de QUALQUER unidade de viewport, e não só de `100vh`: `60vh`
      produz o mesmo comportamento, só que mais devagar.
    */
    const classes = classesDaMoldura();

    expect(classes).not.toMatch(/h-\[[^\]]*v(h|min|max|dvh)/);
    expect(classes).not.toMatch(/h-screen/);
    expect(classes).not.toMatch(/calc\(100vh/);
  });

  it("UXP-03 · a altura é responsiva, e cresce com o tamanho da tela", () => {
    const classes = classesDaMoldura();

    const base = /(?:^|\s)h-\[(\d+)px\]/.exec(classes);
    const sm = /sm:h-\[(\d+)px\]/.exec(classes);
    const md = /md:h-\[(\d+)px\]/.exec(classes);
    const lg = /lg:h-\[(\d+)px\]/.exec(classes);

    for (const [nome, achado] of [
      ["base (celular)", base],
      ["sm", sm],
      ["md (tablet)", md],
      ["lg (desktop)", lg],
    ] as const) {
      expect(achado, `falta o degrau ${nome}`).not.toBeNull();
    }

    const alturas = [base, sm, md, lg].map((m) => Number(m![1]));

    // Monotônica: nenhum degrau encolhe em relação ao anterior.
    for (let i = 1; i < alturas.length; i += 1) {
      expect(alturas[i]).toBeGreaterThanOrEqual(alturas[i - 1]);
    }

    // E dentro das faixas que o dono pediu.
    expect(alturas[0]).toBeGreaterThanOrEqual(360);
    expect(alturas[0]).toBeLessThanOrEqual(440);
    expect(alturas[2]).toBeGreaterThanOrEqual(420);
    expect(alturas[2]).toBeLessThanOrEqual(560);
  });
});

// ---------------------------------------------------------------------------
// UXP-04..07 — a política de zoom, medida
// ---------------------------------------------------------------------------

describe("UXP-04..07 — política de zoom", () => {
  it("UXP-04 · NORMAL declara o zoom nativo do OpenStreetMap", () => {
    // Medido: acima de `z19` o OSM responde HTTP 400 com 30 bytes.
    expect(readMapTileConfig({}).normal.maxNativeZoom).toBe(19);
  });

  it("UXP-05 · SATELLITE para onde a imagem do Esri realmente acaba", () => {
    /*
      Este é o número que tira a placa "Map data not yet available" da tela.

      Medido em três lugares: `z19` em São Paulo, `z18` em cidade média e `z18`
      na área rural onde o dono validou. Acima disso o Esri responde
      `200 image/jpeg` com uma placa de 2.521 bytes, byte a byte idêntica em
      qualquer região — o Leaflet não tem como saber que aquilo não é imagem.

      O valor é o PIOR caso medido de propósito: adotar 19 devolveria a placa
      para a maior parte do país, e adotar 18 custa um nível de nitidez nas
      capitais. Um defeito é cosmético; o outro faz o mapa afirmar que não há
      dado onde há.
    */
    expect(readMapTileConfig({}).satellite!.maxNativeZoom).toBe(18);
  });

  it("UXP-05b · o satélite nunca declara nativo ACIMA do medido", () => {
    // A guarda contra o ajuste otimista: subir este número traz a placa de volta.
    expect(
      readMapTileConfig({}).satellite!.maxNativeZoom,
    ).toBeLessThanOrEqual(18);
  });

  it("UXP-06 · o híbrido respeita a camada mais restritiva", () => {
    const c = readMapTileConfig({});

    /*
      As duas camadas do híbrido declaram o próprio nativo, e o Leaflet amplia
      cada uma a partir do dela. É isso que impede a experiência em que uma
      continua e a outra quebra: nenhuma quebra — ambas ampliam.

      A base é a mais restritiva das duas, e o teto do mapa fica acima de ambas.
    */
    expect(c.hybrid!.base.maxNativeZoom).toBeLessThanOrEqual(
      c.hybrid!.labels.maxNativeZoom,
    );
    expect(MAP_MAX_ZOOM).toBeGreaterThanOrEqual(c.hybrid!.labels.maxNativeZoom);
    expect(MAP_MAX_ZOOM).toBeGreaterThanOrEqual(c.hybrid!.base.maxNativeZoom);

    // E a base do híbrido continua sendo o MESMO objeto do satélite: duas
    // cópias divergiriam na primeira troca de provedor.
    expect(c.hybrid!.base).toBe(c.satellite);
  });

  it("UXP-06b · o teto do mapa é um só, e fica acima de toda camada", () => {
    const c = readMapTileConfig({});
    const nativos = [
      c.normal.maxNativeZoom,
      c.satellite!.maxNativeZoom,
      c.hybrid!.labels.maxNativeZoom,
    ];

    for (const nativo of nativos) {
      expect(MAP_MAX_ZOOM).toBeGreaterThanOrEqual(nativo);
    }
    // Um teto igual ao maior nativo tiraria a ampliação; muito acima produziria
    // uma imagem borrada demais para servir.
    expect(MAP_MAX_ZOOM - Math.max(...nativos)).toBeGreaterThanOrEqual(1);
    expect(MAP_MAX_ZOOM - Math.min(...nativos)).toBeLessThanOrEqual(3);
  });

  it("UXP-07 · uma CTO só não abre colada demais", () => {
    /*
      `fitBounds` sobre um retângulo de área zero — uma caixa só, ou várias no
      mesmo poste — vai ao zoom máximo sem um teto. O operador abriria o mapa
      olhando uma calçada, sem nenhuma referência de onde aquilo fica.

      O teto precisa mostrar a caixa, a rua dela e as quadras em volta.
    */
    expect(MAP_INITIAL_FIT_MAX_ZOOM).toBeGreaterThanOrEqual(15);
    expect(MAP_INITIAL_FIT_MAX_ZOOM).toBeLessThanOrEqual(17);
    // E nunca acima do que o satélite consegue desenhar sem ampliar.
    expect(MAP_INITIAL_FIT_MAX_ZOOM).toBeLessThanOrEqual(
      readMapTileConfig({}).satellite!.maxNativeZoom,
    );
  });

  it("UXP-07b · o enquadramento inicial é usado pelo canvas", () => {
    // Sem isto, a constante existiria e o `fitBounds` continuaria sem teto.
    const codigo = semComentarios(leia("src/components/map/MapCanvas.tsx"));

    expect(codigo).toContain("MAP_INITIAL_FIT_MAX_ZOOM");
    expect(codigo).toMatch(/maxZoom:\s*MAP_INITIAL_FIT_MAX_ZOOM/);
  });

  it("UXP-05c · cada TileLayer declara maxNativeZoom, e não só maxZoom", () => {
    /*
      A asserção que a sabotagem `S3` precisa derrubar. Sem `maxNativeZoom`, o
      Leaflet PEDE o tile inexistente — e no satélite recebe a placa com
      `200 OK`, que ele desenha.
    */
    const codigo = semComentarios(leia("src/components/map/MapCanvas.tsx"));
    const camadas = codigo.match(/<TileLayer[\s\S]*?\/>/g) ?? [];

    expect(camadas.length).toBeGreaterThanOrEqual(4);
    for (const camada of camadas) {
      expect(camada, "TileLayer sem maxNativeZoom").toContain("maxNativeZoom");
      expect(camada, "TileLayer sem teto de mapa").toContain("MAP_MAX_ZOOM");
    }
  });
});

// ---------------------------------------------------------------------------
// UXP-08..10 — o marcador redesenhado
// ---------------------------------------------------------------------------

describe("UXP-08..10 — a caixa óptica", () => {
  const svg = () => ctoMarkerHtml(ctoMapStatusPresentation("AVAILABLE"), false);

  it("UXP-08 · o marcador tem estrutura de caixa óptica", () => {
    const html = svg();

    // Corpo, tampa e — o que diz "equipamento de rede" — o prensa-cabo.
    expect(html).toContain("cto-box__body");
    expect(html).toContain("cto-box__lid");
    expect(html).toContain("cto-box__gland");
    expect(html).toContain("cto-box__cable");
    expect(html.startsWith("<svg")).toBe(true);
  });

  it("UXP-09 · as portas ópticas são uma RÉGUA, e não uma grade de pontos", () => {
    /*
      O defeito que o dono nomeou: duas fileiras de pontos leem como calculadora
      ou teclado. Uma régua de traços verticais contíguos lê como conector.

      A asserção olha a estrutura — bandeja mais traços — e não uma substring
      qualquer do SVG.
    */
    const html = svg();

    expect(html, "falta a bandeja das portas").toContain("cto-box__tray");

    const regua = /<g class="cto-box__ports">([\s\S]*?)<\/g>/.exec(html);
    expect(regua, "falta o grupo de portas").not.toBeNull();

    const tracos = regua![1].match(/<line/g) ?? [];
    expect(tracos.length, "a régua precisa de vários conectores").toBeGreaterThanOrEqual(4);

    // Traços VERTICAIS: mesmo x nas duas pontas, y diferente. Um traço
    // horizontal aqui seria de novo uma fileira, não uma régua.
    const coords = Array.from(
      regua![1].matchAll(/x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)"/g),
    );
    expect(coords.length).toBe(tracos.length);
    for (const [, x1, y1, x2, y2] of coords) {
      expect(x1).toBe(x2);
      expect(y1).not.toBe(y2);
    }

    // E nenhum `<circle>` na régua — os pontos da versão anterior sumiram.
    expect(regua![1]).not.toContain("<circle");
  });

  it("UXP-09b · a régua está DENTRO do corpo da caixa", () => {
    /*
      Um desenho em que as portas escapam do corpo não lê como caixa.

      A asserção MUDOU DE MÉTODO na `CTO-3.2.1c`, e não de afirmação. Antes ela
      extraía as coordenadas do SVG com expressão regular sobre um `<rect>` — e
      o corpo virou um `<path>`, porque a cúpula do topo não é um retângulo. Uma
      regex que procura a forma antiga não reprova o desenho novo: ela só deixa
      de encontrar o que procurava, que é o pior tipo de teste — o que quebra
      quando nada está errado e o que passa quando casa com outro trecho.

      Agora a pergunta é aritmética sobre `CTO_MARKER_GEOMETRY`, que é a MESMA
      fonte de onde o SVG é montado. Não existe segunda cópia das coordenadas
      para divergir.
    */
    const { shell, tray, ports, latch } = CTO_MARKER_GEOMETRY;

    const dentro = (fora: typeof shell, dentroDe: typeof shell) =>
      dentroDe.x >= fora.x &&
      dentroDe.y >= fora.y &&
      dentroDe.x + dentroDe.width <= fora.x + fora.width &&
      dentroDe.y + dentroDe.height <= fora.y + fora.height;

    expect(dentro(shell, tray), "a bandeja escapa do corpo").toBe(true);
    expect(dentro(shell, latch), "o fecho escapa do corpo").toBe(true);

    // E os adaptadores dentro da bandeja, não vazando por cima dela.
    const primeiro = ports.first;
    const ultimo = ports.first + (ports.count - 1) * ports.step;
    expect(primeiro).toBeGreaterThanOrEqual(tray.x);
    expect(ultimo).toBeLessThanOrEqual(tray.x + tray.width);
    expect(ports.top).toBeGreaterThanOrEqual(tray.y);
    expect(ports.bottom).toBeLessThanOrEqual(tray.y + tray.height);

    // A geometria descreve o SVG DE VERDADE, e não um documento paralelo: o
    // caminho do corpo tem de começar nas coordenadas declaradas.
    const topo = CTO_MARKER_GEOMETRY.shellRadius.top;
    expect(svg()).toContain(`d="M ${shell.x} ${shell.y + topo}`);
  });

  it("UXP-10 · o estado continua sendo forma + glifo", () => {
    const estados = ["AVAILABLE", "FULL", "DAMAGED", "INACTIVE"] as const;

    const selos = estados.map(
      (s) =>
        /<g class="cto-box__badge">(.*?)<\/g>/.exec(
          ctoMarkerHtml(ctoMapStatusPresentation(s), false),
        )?.[1] ?? "",
    );
    const glifos = estados.map(
      (s) =>
        /<text[^>]*>([^<]*)<\/text>/.exec(
          ctoMarkerHtml(ctoMapStatusPresentation(s), false),
        )?.[1] ?? "",
    );

    expect(new Set(selos).size, "duas formas de selo iguais").toBe(4);
    expect(new Set(glifos).size, "dois glifos iguais").toBe(4);
    for (const g of glifos) expect(g.trim()).not.toBe("");

    // E a silhueta é a MESMA nos quatro: ela é a identidade da CTO.
    for (const s of estados) {
      expect(ctoMarkerHtml(ctoMapStatusPresentation(s), false)).toContain(
        "cto-box__tray",
      );
    }
  });

  it("UXP-10b · o marcador continua sem interpolar dado de usuário", () => {
    const codigo = semComentarios(
      leia("src/components/map/cto-marker-icon.ts"),
    );
    for (const proibido of ["name", "code", "marker."]) {
      expect(codigo, `o ícone referencia ${proibido}`).not.toContain(proibido);
    }
    expect(ctoMarkerHtml.length).toBe(2);
  });

  it("UXP-10c · o marcador é pequeno o bastante para não competir com o mapa", () => {
    expect(CTO_MARKER_SIZE).toBeGreaterThanOrEqual(28);
    expect(CTO_MARKER_SIZE).toBeLessThanOrEqual(44);
  });
});

// ---------------------------------------------------------------------------
// UXP-12 — o botão "Abrir CTO"
// ---------------------------------------------------------------------------

describe("UXP-12 — legibilidade da ação do popup", () => {
  it("UXP-12 · a ação usa a classe que vence a regra do Leaflet", () => {
    /*
      O defeito que o dono viu, e a causa é de ESPECIFICIDADE:

        leaflet.css   .leaflet-container a { color: #0078A8 }   (0,1,1)
        Tailwind      .text-primary-fg                          (0,1,0)

      A regra do Leaflet vence, então o texto saía #0078A8 sobre o #2563eb do
      `bg-primary` — azul sobre azul, contraste de cerca de 1,06:1. Nenhuma
      asserção de existência ou de texto pegaria isso: o elemento estava lá, com
      o conteúdo certo, no lugar certo.
    */
    const componente = semComentarios(leia("src/components/map/CtoMarkers.tsx"));
    const acao = /<Link[\s\S]*?data-testid="cto-map-popup-open"/.exec(componente);
    expect(acao, "não achei a ação do popup").not.toBeNull();

    expect(acao![0], "a ação precisa da classe própria").toContain(
      "cto-map-action",
    );
    // A utility de cor sozinha PERDE para o Leaflet; ela não pode voltar como
    // se resolvesse.
    expect(acao![0]).not.toContain("text-primary-fg");
  });

  it("UXP-12b · a classe existe no CSS, com especificidade maior que a do Leaflet", () => {
    const css = leia("src/app/globals.css");
    const regra = /\.cto-map-shell \.leaflet-popup-content a\.cto-map-action \{([\s\S]*?)\}/.exec(css);

    expect(regra, "falta a regra da ação no globals.css").not.toBeNull();

    // Três classes + um elemento (0,3,1) vence `.leaflet-container a` (0,1,1).
    expect(regra![1]).toContain("color:");
    expect(regra![1]).toContain("--primary-fg");
    expect(regra![1]).toContain("--primary");

    // Tokens, e nunca hexadecimal solto — inclusive o azul do Leaflet.
    expect(regra![1]).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    expect(css).toContain(".cto-map-shell .leaflet-popup-content a.cto-map-action:hover");
    expect(css).toContain(
      ".cto-map-shell .leaflet-popup-content a.cto-map-action:focus-visible",
    );
  });
});

// ---------------------------------------------------------------------------
// ML-01..ML-08 — CTO-3.2.1c: a plaqueta com o nome, e o marcador refinado
// ---------------------------------------------------------------------------

/**
 * O dono pediu duas coisas e só duas: o **nome da CTO por cima dela** no mapa,
 * e um marcador que pareça de verdade uma caixa óptica de poste.
 *
 * O que dá para afirmar sem navegador está aqui — estrutura do componente,
 * geometria do desenho e as regras de CSS. O que só o navegador mede — posição
 * real da plaqueta, contraste computado, popup abrindo — está em
 * `e2e/operational-map.spec.ts`.
 */
describe("ML-01..ML-08 — a plaqueta e o marcador refinado", () => {
  const componente = () =>
    semComentarios(leia("src/components/map/CtoMarkers.tsx"));
  const css = () => leia("src/app/globals.css");

  it("ML-01 · o marcador renderiza uma plaqueta PERMANENTE acima da caixa", () => {
    const codigo = componente();

    const plaqueta = /<Tooltip[\s\S]*?>/.exec(codigo);
    expect(plaqueta, "não achei a plaqueta").not.toBeNull();

    /*
      `permanent` é o contrato, e não um detalhe de configuração.

      Sem ele o Leaflet abre no `mouseover` e fecha no `mouseout` — é dica
      passageira, exatamente o que o enunciado proibiu ("não criar uma solução
      que só mostra o nome quando clica", e apontar não é melhor que clicar).
    */
    expect(plaqueta![0], "a plaqueta precisa ser permanente").toContain(
      "permanent",
    );
    expect(plaqueta![0], "a plaqueta precisa ficar ACIMA").toContain(
      "direction=" + JSON.stringify("top"),
    );
    expect(plaqueta![0]).toContain("cto-map-label");

    // E ela é do react-leaflet, não uma segunda camada montada à mão.
    expect(codigo).toMatch(/import[^;]*Tooltip[^;]*from "react-leaflet"/);
  });

  it("ML-02 · a plaqueta mostra o NOME da caixa, renderizado pelo React", () => {
    const codigo = componente();

    const corpo = /<Tooltip[\s\S]*?<\/Tooltip>/.exec(codigo);
    expect(corpo).not.toBeNull();
    expect(corpo![0]).toContain("{marker.name}");
    expect(corpo![0]).toContain("cto-map-label");

    /*
      O texto vem por FILHO de componente, e nunca pelo `divIcon`.

      Esta é a asserção de segurança da fase. `divIcon` recebe HTML cru e o
      injeta no DOM; um nome de caixa é digitado por gente. O `Tooltip` do
      react-leaflet renderiza os filhos por portal, e o React escapa texto — uma
      caixa batizada de `<img src=x onerror=…>` aparece com esse nome escrito.

      O ícone continua sem saber que existe nome: `UXP-10b` prova isso lendo o
      módulo do desenho, e aqui a contraparte é que ninguém passou o nome a ele.
    */
    const icone = /ctoMarkerHtml\(([^)]*)\)/.exec(codigo);
    expect(icone, "não achei a chamada do ícone").not.toBeNull();
    expect(icone![1]).not.toContain("name");
    expect(icone![1]).not.toContain("code");
  });

  it("ML-03 · a plaqueta tem estrutura de contraste, por TOKEN e sem hexadecimal", () => {
    const folha = css();
    const regra =
      /\.cto-map-shell \.leaflet-tooltip\.cto-map-label \{([\s\S]*?)\}/.exec(
        folha,
      );
    expect(regra, "falta a regra da plaqueta no globals.css").not.toBeNull();

    // Fundo e texto declarados: sem os dois, o branco padrão do Leaflet volta a
    // valer e a plaqueta deixa de acompanhar o tema.
    expect(regra![1]).toContain("background:");
    expect(regra![1]).toContain("color:");
    expect(regra![1]).toContain("--surface");
    expect(regra![1]).toContain("--fg");

    // A lição da `CTO-1.5`: cor de paleta escrita direto no lugar do token.
    expect(regra![1], "hexadecimal solto na plaqueta").not.toMatch(
      /#[0-9a-fA-F]{3,8}/,
    );

    /*
      OPACA, e isso é decisão medível — não preferência.

      Com fundo semitransparente o contraste do texto passa a depender do pixel
      do tile que estiver atrás, e deixa de existir um número para afirmar.
      Opaca, o teste de navegador calcula a razão da WCAG e ela vale igual sobre
      asfalto e sobre telhado.
    */
    expect(regra![1]).toMatch(/background:\s*rgb\(var\(--surface\)\)/);

    // A cauda repintada é o que prende a plaqueta ao marcador.
    expect(folha).toContain(
      ".cto-map-shell .leaflet-tooltip-top.cto-map-label::before",
    );
  });

  it("ML-04 · a plaqueta fica ANCORADA acima do marcador, e centrada nele", () => {
    const codigo = componente();

    const ancora = /tooltipAnchor:\s*\[([^\]]*)\]/.exec(codigo);
    expect(
      ancora,
      "sem tooltipAnchor a plaqueta nasce em cima da base da caixa",
    ).not.toBeNull();

    const [x, y] = ancora![1].split(",").map((p) => p.trim());
    // Centrada horizontalmente sobre a caixa.
    expect(x).toBe("0");
    /*
      E ACIMA: o valor é negativo e da ordem do tamanho do marcador.

      Um `y` positivo ou zero poria a plaqueta sobre a base da caixa — cobrindo
      justamente o desenho que ela existe para identificar.
    */
    expect(y).toContain("-CTO_MARKER_SIZE");

    // A âncora do ícone continua na base: é a ponta da fibra que toca o poste.
    expect(codigo).toContain(
      "iconAnchor: [CTO_MARKER_SIZE / 2, CTO_MARKER_SIZE - 2]",
    );
  });

  it("ML-05 · a plaqueta NÃO substitui o popup, e não rouba o clique", () => {
    const codigo = componente();

    // O popup continua existindo, com a ação dentro dele.
    expect(codigo).toContain("<Popup>");
    expect(codigo).toContain("cto-map-popup");
    expect(codigo).toContain("cto-map-popup-open");

    /*
      A plaqueta é INERTE.

      `.leaflet-tooltip` nasce com `pointer-events: none`, e é isso que impede
      uma plaqueta de cobrir o marcador do vizinho e comer o clique dele. A
      opção `interactive` do Leaflet reverteria isso; ela não pode aparecer.
    */
    const plaqueta = /<Tooltip[\s\S]*?>/.exec(codigo)!;
    expect(plaqueta[0], "plaqueta interativa engoliria o clique").not.toContain(
      "interactive",
    );
    expect(css(), "a plaqueta não pode reativar o ponteiro").not.toMatch(
      /\.cto-map-label[^{]*\{[^}]*pointer-events:\s*auto/,
    );
  });

  it("ML-06 · o marcador refinado mantém identidade de caixa óptica", () => {
    const { shell, shellRadius, latch, seamY, glandBar } = CTO_MARKER_GEOMETRY;
    const html = ctoMarkerHtml(ctoMapStatusPresentation("AVAILABLE"), false);

    /*
      A proporção EM PÉ é o achado da fase.

      A versão que o dono recusou media 29 × 21 — deitada. Caixa deitada com uma
      faixa dentro lê como aparelho de mesa; caixa de terminação de poste é em
      pé. Nenhum detalhe interno compensa a proporção errada, porque a proporção
      é o que sobrevive a 38 pixels.

      A margem não é simbólica: 24 × 24,5 passaria num teste de "altura maior
      que largura" e continuaria lendo como quadrado. Exigir um quarto a mais de
      altura é o que torna a asserção capaz de reprovar o desenho intermediário
      que esta fase já descartou.
    */
    expect(
      shell.height,
      `corpo ${shell.width} × ${shell.height}: quadrado demais para ler como caixa de poste`,
    ).toBeGreaterThanOrEqual(shell.width * 1.25);

    /*
      A CÚPULA: raio de topo próximo da metade da largura.

      Com raio pequeno o contorno volta a ser um retângulo arredondado, que é o
      que qualquer ícone de aplicativo também é. Perto da metade da largura, o
      topo é praticamente meia circunferência — e isso é perfil de caixa de
      terminação, não de aplicativo.
    */
    expect(shellRadius.top).toBeGreaterThanOrEqual(shell.width * 0.4);
    expect(shellRadius.top, "o raio não pode passar da metade").toBeLessThanOrEqual(
      shell.width / 2,
    );
    // E embaixo o canto é seco: a caixa apoia, não flutua.
    expect(shellRadius.bottom).toBeLessThan(shellRadius.top / 2);

    // A tampa: costura mais fecho. Linha sozinha não resolve leitura de tampa.
    expect(html).toContain("cto-box__lid");
    expect(html).toContain("cto-box__latch");
    expect(seamY).toBeGreaterThan(shell.y);
    expect(seamY).toBeLessThan(shell.y + shell.height);
    expect(latch.y, "o fecho precisa montar SOBRE a costura").toBeLessThan(
      seamY,
    );
    expect(latch.y + latch.height).toBeGreaterThan(seamY);

    /*
      ENTRADA e SAÍDA, e a diferença entre elas é a FORMA do traço.

      O tronco desce reto até a âncora — é o cabo que chega da rede, e a ponta
      dele é o ponto no chão. A drop sai em CURVA, porque fibra não corre em
      ângulo reto. Duas retas paralelas seriam dois fios quaisquer; uma reta e
      uma curva são um tronco e uma derivação.

      A placa é UMA. Dois blocos pequenos sob a caixa leem como pés — foi assim
      que a primeira tentativa desta fase ficou, e é por isso que a asserção
      olha a barra e não uma contagem.
    */
    expect(html).toContain("cto-box__gland");
    // BARRA, e não bloco: larga em relação à própria altura, e tucada sob a
    // caixa. Uma placa tão larga quanto o corpo vira prateleira, e o conjunto
    // com os dois cabos vira cavalete.
    expect(glandBar.width).toBeGreaterThanOrEqual(glandBar.height * 2.5);
    expect(glandBar.width, "placa larga demais lê como base").toBeLessThan(
      shell.width * 0.75,
    );
    expect(glandBar.x).toBeGreaterThan(shell.x);
    expect(glandBar.x + glandBar.width).toBeLessThan(shell.x + shell.width);

    const tronco = /<path class="cto-box__cable" d="([^"]*)"/.exec(html);
    const drop = /<path class="cto-box__cable cto-box__cable--drop" d="([^"]*)"/.exec(
      html,
    );
    expect(tronco, "falta o tronco").not.toBeNull();
    expect(drop, "falta a drop").not.toBeNull();
    expect(tronco![1], "o tronco tem de descer RETO").toContain("L ");
    expect(tronco![1], "o tronco não curva").not.toContain("C ");
    expect(drop![1], "a drop tem de sair em CURVA").toContain("C ");
  });

  it("ML-07 · as portas ópticas continuam explícitas, contíguas e verticais", () => {
    const { ports, tray } = CTO_MARKER_GEOMETRY;
    const html = ctoMarkerHtml(ctoMapStatusPresentation("AVAILABLE"), false);

    expect(html).toContain("cto-box__tray");
    expect(ports.count).toBeGreaterThanOrEqual(4);

    const regua = /<g class="cto-box__ports">([\s\S]*?)<\/g>/.exec(html);
    expect(regua).not.toBeNull();
    expect((regua![1].match(/<line/g) ?? []).length).toBe(ports.count);
    expect(regua![1], "ponto no lugar de conector").not.toContain("<circle");

    // VERTICAIS: mesmo x nas duas pontas.
    const coords = Array.from(
      regua![1].matchAll(/x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)"/g),
    );
    expect(coords.length).toBe(ports.count);
    for (const [, x1, , x2] of coords) {
      expect(x1).toBe(x2);
    }

    /*
      CONTÍGUAS, e é isso que separa conector de teclado.

      Traços lado a lado leem como régua óptica; espalhá-los pela largura da
      bandeja foi o que fez a primeira versão parecer calculadora. A régua tem
      de caber com folga dentro da bandeja — se o passo crescer até ocupar tudo,
      os traços viram grade de novo.
    */
    const largura = (ports.count - 1) * ports.step;
    expect(largura).toBeLessThan(tray.width);
    expect(ports.step).toBeLessThan(tray.height / 2);
  });

  it("ML-08 · o selo de estado continua presente, e convive com a plaqueta", () => {
    const estados = ["AVAILABLE", "FULL", "DAMAGED", "INACTIVE"] as const;

    for (const estado of estados) {
      const html = ctoMarkerHtml(ctoMapStatusPresentation(estado), false);
      expect(html, estado + " perdeu o selo").toContain("cto-box__badge");
      expect(html, estado + " perdeu o glifo").toContain("cto-box__glyph");
    }

    // Forma E glifo distintos nos quatro: a plaqueta acrescentou nome, e não
    // substituiu a única pista que funciona sem cor.
    const selos = estados.map(
      (s) =>
        /<g class="cto-box__badge">(.*?)<\/g>/.exec(
          ctoMarkerHtml(ctoMapStatusPresentation(s), false),
        )?.[1] ?? "",
    );
    expect(new Set(selos).size).toBe(4);

    // O glifo cabe no próprio selo: maior que a forma, ele encosta na borda e a
    // forma deixa de ser lida como forma.
    const glifo = /\.cto-box__glyph \{([\s\S]*?)\}/.exec(css());
    expect(glifo).not.toBeNull();
    const tamanho = /font-size:\s*(\d+(?:\.\d+)?)px/.exec(glifo![1]);
    expect(tamanho).not.toBeNull();
    expect(Number(tamanho![1])).toBeLessThanOrEqual(
      CTO_MARKER_GEOMETRY.badge.r * 1.5,
    );
  });
});

// ---------------------------------------------------------------------------
// ML-DENS — a política de densidade da plaqueta
// ---------------------------------------------------------------------------

describe("ML-DENS — quando o nome aparece, e por quê", () => {
  /** Metros por pixel no Web Mercator, na latitude onde o dono valida. */
  function metrosPorPixel(zoom: number, latitude = -20.77): number {
    return (156543.03392 * Math.cos((latitude * Math.PI) / 180)) / 2 ** zoom;
  }

  it("ML-DENS-01 · o limiar cai onde a conta diz que a parede de texto acaba", () => {
    /*
      Isto NÃO é gosto, e a medição está registrada em `map-tiles.config.mjs`.

      Não havia densidade real para observar — o banco de desenvolvimento tem
      uma caixa com coordenada —, então o que se mede é a projeção. Uma plaqueta
      tem no máximo 112px, e duas colidem quando a distância entre as caixas
      rende menos que isso na tela.
    */
    const CHIP = 112;
    const separacao = (metros: number, zoom: number) =>
      metros / metrosPorPixel(zoom);

    // A 300 m — rede urbana esparsa — o limiar já separa as plaquetas.
    expect(separacao(300, MAP_LABEL_MIN_ZOOM)).toBeGreaterThanOrEqual(CHIP);

    // Um nível abaixo dele, não separa. É essa a fronteira que o número marca.
    expect(separacao(300, MAP_LABEL_MIN_ZOOM - 1)).toBeLessThan(CHIP);

    /*
      E a parede que o limiar existe para evitar: em `z14` duas caixas a 300 m
      ficam a algumas dezenas de pixels, ou seja, as plaquetas se empilham por
      cima da cidade inteira.
    */
    expect(separacao(300, 14)).toBeLessThan(40);
  });

  it("ML-DENS-02 · o limiar é operacional: cabe entre o enquadramento inicial e o teto", () => {
    // Abrir o mapa já tem de mostrar nome — senão o dono abre e não vê o que
    // pediu.
    expect(MAP_INITIAL_FIT_MAX_ZOOM).toBeGreaterThanOrEqual(MAP_LABEL_MIN_ZOOM);
    expect(MAP_LABEL_MIN_ZOOM).toBeLessThan(MAP_MAX_ZOOM);
    expect(MAP_LABEL_MIN_ZOOM).toBeGreaterThan(10);
  });

  it("ML-DENS-03 · a fronteira recebe um BOOLEANO, e nunca o zoom", () => {
    /*
      A regra que fecha a realimentação da `CTO-3.2.1`.

      Uma prop derivada da câmera chegando aos marcadores fecha o laço
      `popup → autoPan → moveend → render`, que custou `Maximum update depth
      exceeded` e o popup parando de abrir. Um número muda a cada
      micro-movimento; um booleano só muda quando alguém cruza o limiar, e o
      `memo` bloqueia o resto.
    */
    const camada = semComentarios(leia("src/components/map/CtoMapLayer.tsx"));
    const marcadores = semComentarios(
      leia("src/components/map/CtoMarkers.tsx"),
    );

    expect(camada).toContain("showLabels={mostrarPlaquetas}");
    expect(camada).toMatch(/const mostrarPlaquetas = .*MAP_LABEL_MIN_ZOOM/);
    expect(marcadores).toContain("showLabels: boolean");

    // Nenhum zoom cru atravessa: uma prop `zoom` no marcador seria o número de
    // volta, e com ele o laço.
    expect(camada).not.toMatch(/<CtoMarkers[\s\S]*?zoom=/);

    // E a constante vem do módulo PURO, não de `map-config` (que alcança
    // Prisma). É a regressão que a `CTO-3.2.1b` cometeu e o teste estrutural
    // pegou no mesmo dia.
    expect(camada).toMatch(
      /import \{[^}]*MAP_LABEL_MIN_ZOOM[^}]*\} from "@\/lib\/map-tiles\.config\.mjs"/,
    );
  });

  it("ML-DENS-04 · a caixa SELECIONADA mostra o nome em qualquer zoom", () => {
    /*
      A exceção que torna a regra usável.

      Quem achou uma CTO na busca, ou voltou de uma CTO com `sel=` na URL,
      precisa saber qual mancha do mapa é a dela. Sem esta cláusula, buscar uma
      caixa e cair num zoom afastado devolveria um marcador anônimo.
    */
    const marcadores = semComentarios(
      leia("src/components/map/CtoMarkers.tsx"),
    );
    expect(marcadores).toMatch(/const comPlaqueta = showLabels \|\| selecionado/);

    // E ela é distinguível: a plaqueta da selecionada acompanha o anel do
    // marcador, senão o operador não saberia por que só aquele nome apareceu.
    expect(marcadores).toContain("cto-map-label--selected");
    expect(leia("src/app/globals.css")).toContain(
      ".cto-map-shell .leaflet-tooltip.cto-map-label--selected",
    );
  });
});

// ---------------------------------------------------------------------------
// STATUSVIS-01..07 — CTO-3.2.1c: o CORPO da caixa carrega o estado
// ---------------------------------------------------------------------------

/**
 * O delta visual que o dono pediu depois da primeira leitura da `CTO-3.2.1c`.
 *
 * Até aqui o estado morava só no selo — 14 unidades num ícone de 38 pixels. Num
 * mapa com dezenas de marcadores, o que se enxerga primeiro é a **silhueta**, e
 * não o adesivo no canto dela.
 *
 * O contrato passou a ser somatório, e nenhuma parcela sozinha responde:
 *
 * ```text
 * contorno do corpo  +  selo (forma + glifo)  +  tratamento  +  texto (só INATIVA)
 * ```
 */
describe("STATUSVIS-01..07 — o corpo da caixa carrega o estado", () => {
  const css = () => leia("src/app/globals.css");

  /** A regra `.cto-box--<tom> .cto-box__body`, se existir. */
  function contornoDoTom(tom: string): string | null {
    const regra = new RegExp(
      `\\.cto-box--${tom} \\.cto-box__body \\{([\\s\\S]*?)\\}`,
    ).exec(css());
    return regra?.[1] ?? null;
  }

  /** O token que a regra usa como `stroke`. */
  function tokenDoContorno(tom: string): string | null {
    const corpo = contornoDoTom(tom);
    if (!corpo) return null;
    return /stroke:\s*rgb\(var\(--([a-z-]+)\)\)/.exec(corpo)?.[1] ?? null;
  }

  /** O token que a regra do selo usa como `fill`. */
  function tokenDoSelo(tom: string): string | null {
    const regra = new RegExp(
      `\\.cto-box--${tom} \\.cto-box__badge > \\* \\{([\\s\\S]*?)\\}`,
    ).exec(css());
    return /fill:\s*rgb\(var\(--([a-z-]+)\)\)/.exec(regra?.[1] ?? "")?.[1] ?? null;
  }

  const TONS = {
    AVAILABLE: "success",
    FULL: "warning",
    DAMAGED: "danger",
    INACTIVE: "neutral",
  } as const;

  it("STATUSVIS-01/02/03 · cada estado pinta o CORPO, e com o mesmo token do selo", () => {
    /*
      UMA cor por estado, e ela vale para as duas peças.

      Se o contorno tivesse token próprio, existiriam duas fontes de verdade
      para a mesma pergunta — e a que divergisse seria a que ninguém revisou,
      porque as duas parecem certas isoladamente. É a mesma razão de
      `summarizePortCounts` ser uma função só.
    */
    for (const estado of ["AVAILABLE", "FULL", "DAMAGED"] as const) {
      const tom = TONS[estado];
      const contorno = tokenDoContorno(tom);
      const selo = tokenDoSelo(tom);

      expect(contorno, `${estado} não pinta o corpo`).not.toBeNull();
      expect(selo, `${estado} perdeu o selo`).not.toBeNull();
      expect(
        contorno,
        `${estado}: contorno usa --${contorno} e o selo usa --${selo}`,
      ).toBe(selo);
    }

    // E as três cores são DIFERENTES entre si: um estado que reusasse a cor de
    // outro não seria distinguível de relance, que é o ponto do delta.
    const cores = (["AVAILABLE", "FULL", "DAMAGED"] as const).map((e) =>
      tokenDoContorno(TONS[e]),
    );
    expect(new Set(cores).size, `cores repetidas: ${cores.join(", ")}`).toBe(3);
  });

  it("STATUSVIS-01/02/03b · o contorno é grosso o bastante para ser informação", () => {
    /*
      Contorno de estado não é delimitação de desenho.

      Ele precisa sobreviver a vegetação, telhado e asfalto num ícone de 38px, e
      abaixo de ~2px ele vira uma linha que some contra fundo texturizado.
    */
    const base = /\.cto-box__body \{([\s\S]*?)\}/.exec(css());
    expect(base).not.toBeNull();
    const largura = /stroke-width:\s*([\d.]+)/.exec(base![1]);
    expect(largura, "o corpo perdeu a largura de traço").not.toBeNull();
    expect(Number(largura![1])).toBeGreaterThanOrEqual(2.2);
  });

  it("STATUSVIS-04 · INATIVA apaga a FIGURA, e nunca o selo", () => {
    const html = ctoMarkerHtml(ctoMapStatusPresentation("INACTIVE"), false);

    /*
      A figura é um grupo PRÓPRIO, e é isso que torna o apagamento seletivo.

      Apagar o marcador inteiro levaria o selo junto — e uma caixa desbotada sem
      selo esconde justamente o motivo de ela estar desbotada.
    */
    const figura = /<g class="cto-box__figure">([\s\S]*?)<\/g>\s*<g class="cto-box__badge">/.exec(
      html,
    );
    expect(figura, "a figura precisa ser um grupo separado do selo").not.toBeNull();
    expect(figura![1]).toContain("cto-box__body");
    expect(figura![1]).toContain("cto-box__tray");
    expect(figura![1], "o selo não pode estar dentro da figura").not.toContain(
      "cto-box__badge",
    );

    // E o selo continua presente, fora dela.
    expect(html).toContain("cto-box__badge");
    expect(html).toContain("cto-box__glyph");

    // O tratamento: opacidade reduzida E dessaturação, na figura.
    const regra = /\.cto-box--neutral \.cto-box__figure \{([\s\S]*?)\}/.exec(css());
    expect(regra, "falta o tratamento da inativa").not.toBeNull();
    const opacidade = /opacity:\s*([\d.]+)/.exec(regra![1]);
    expect(opacidade, "a inativa não perde opacidade").not.toBeNull();
    expect(Number(opacidade![1])).toBeLessThan(1);
    expect(Number(opacidade![1]), "apagada demais deixa de ser legível").toBeGreaterThan(0.3);
    expect(regra![1], "a inativa não dessatura").toContain("grayscale");

    // Nenhuma regra apaga o marcador INTEIRO — seria levar o selo junto.
    expect(css()).not.toMatch(/\.cto-box--neutral \{[^}]*opacity/);
  });

  it("STATUSVIS-05 · INATIVA escreve o estado na plaqueta, e SÓ ela", () => {
    const codigo = semComentarios(leia("src/components/map/CtoMarkers.tsx"));

    // A condição é sobre o STATUS que veio do servidor, não sobre aparência.
    expect(codigo).toMatch(/const inativa = marker\.status === "INACTIVE"/);

    const plaqueta = /<Tooltip[\s\S]*?<\/Tooltip>/.exec(codigo);
    expect(plaqueta).not.toBeNull();
    expect(plaqueta![0]).toContain("cto-map-label-state");
    expect(plaqueta![0]).toContain("cto-map-label__state");

    /*
      O termo vem da TABELA de apresentação, e não de uma string escrita à mão.

      `apresentacao.label` é o mesmo "Inativa" que o popup e a legenda mostram;
      o versalete é do `.toUpperCase()`. Uma string literal aqui seria uma
      segunda grafia do mesmo estado, livre para divergir na primeira revisão de
      texto.
    */
    expect(plaqueta![0]).toContain("apresentacao.label.toUpperCase()");
    expect(plaqueta![0], "estado escrito à mão na plaqueta").not.toMatch(
      /["']INATIVA["']/,
    );

    // E é CONDICIONAL: os outros três não ganham segunda linha.
    expect(plaqueta![0]).toMatch(/inativa \?[\s\S]*?: null/);

    // O nome ARMAZENADO não é tocado: a plaqueta compõe, não renomeia.
    expect(plaqueta![0]).toContain("{marker.name}");
  });

  it("STATUSVIS-06 · a seleção NÃO substitui o indicador de estado", () => {
    /*
      Duas camadas, e elas não disputam a mesma propriedade:

          halo externo ao ícone .... seleção   (outline)
          contorno do corpo ........ estado    (stroke)

      Se a seleção pintasse o corpo, clicar numa caixa apagaria o estado dela —
      e o operador perderia exatamente a informação que o fez clicar.
    */
    const selecao = /\.cto-box--selected \{([\s\S]*?)\}/.exec(css());
    expect(selecao, "falta a regra de seleção").not.toBeNull();
    expect(selecao![1]).toContain("outline:");
    expect(
      selecao![1],
      "a seleção não pode tocar o traço do corpo",
    ).not.toContain("stroke");

    // Nenhuma regra de seleção sobrescreve o corpo, em nenhum tom.
    expect(css(), "seleção pintando o corpo").not.toMatch(
      /\.cto-box--selected[^{]*\.cto-box__body\s*\{/,
    );

    // E o SVG do selecionado continua trazendo o tom do estado.
    for (const estado of ["AVAILABLE", "DAMAGED", "INACTIVE"] as const) {
      const html = ctoMarkerHtml(ctoMapStatusPresentation(estado), true);
      expect(html).toContain("cto-box--selected");
      expect(html, `${estado} selecionado perdeu o tom`).toContain(
        `cto-box--${TONS[estado]}`,
      );
    }
  });

  it("STATUSVIS-07 · o estado continua legível SEM cor nenhuma", () => {
    /*
      O teste de sanidade do contrato: apagando toda a cor, o que sobra ainda
      distingue os quatro?

      Sobra forma do selo, glifo, e — na inativa — traço tracejado, opacidade e
      a palavra escrita. Se a resposta dependesse do tom, o marcador seria
      ilegível para quem não distingue vermelho de verde, sob sol, ou impresso.
    */
    const estados = ["AVAILABLE", "FULL", "DAMAGED", "INACTIVE"] as const;

    const formas = estados.map(
      (e) =>
        /<g class="cto-box__badge">(.*?)<\/g>/.exec(
          ctoMarkerHtml(ctoMapStatusPresentation(e), false),
        )?.[1] ?? "",
    );
    const glifos = estados.map(
      (e) =>
        /<text[^>]*>([^<]*)<\/text>/.exec(
          ctoMarkerHtml(ctoMapStatusPresentation(e), false),
        )?.[1] ?? "",
    );

    expect(new Set(formas).size, "duas formas de selo iguais").toBe(4);
    expect(new Set(glifos).size, "dois glifos iguais").toBe(4);

    // A inativa acrescenta um sinal que não é nem cor nem forma: o traço
    // tracejado. E ele é EXCLUSIVO dela — senão não distinguiria nada.
    expect(contornoDoTom("neutral")).toContain("stroke-dasharray");
    for (const tom of ["success", "warning", "danger"]) {
      expect(
        contornoDoTom(tom) ?? "",
        `${tom} não pode usar traço tracejado`,
      ).not.toContain("stroke-dasharray");
    }
  });
});

// ---------------------------------------------------------------------------
// MAPEDIT — CTO-3.2.1d: ajustar a posição da CTO pelo mapa
// ---------------------------------------------------------------------------

/**
 * O contrato de UX da fase cabe numa frase: **arrastar não é salvar.**
 *
 * Num mapa a mão está sempre arrastando alguma coisa. Se soltar o marcador
 * gravasse, uma coordenada certa viraria errada sem que ninguém tivesse pedido e
 * sem nada na tela para desfazer. Por isso a sequência é declarada:
 *
 * ```text
 * visualização → Ajustar posição → modo de edição → arrastar → Salvar / Cancelar
 * ```
 *
 * O que só o navegador mede — arrasto real, posição do rótulo, contorno de
 * estado durante a edição — está em `e2e/operational-map.spec.ts`.
 */
describe("MAPEDIT-01..14 — ajustar a posição pelo mapa", () => {
  const marcadores = () =>
    semComentarios(leia("src/components/map/CtoMarkers.tsx"));
  const camada = () => semComentarios(leia("src/components/map/CtoMapLayer.tsx"));
  const pagina = () => semComentarios(leia("src/app/(app)/mapa/page.tsx"));

  it("MAPEDIT-01/02 · a ação é de ADMIN, e a página é quem decide", () => {
    /*
      A prop nasce de `session.profile === "ADMIN"` no servidor, e é SEPARADA de
      `canOpenDetail`. As duas respondem `ADMIN` hoje e respondem perguntas
      diferentes — *"pode abrir a ficha?"* e *"pode mover a caixa?"*. Colapsá-las
      faria abrir a leitura do detalhe ao `DISPATCHER` lhe dar escrita de
      coordenada de brinde.
    */
    expect(pagina()).toContain('canEditPosition={session.profile === "ADMIN"}');
    expect(pagina()).toContain('canOpenDetail={session.profile === "ADMIN"}');

    // E o botão só existe sob a prop: o DISPATCHER não o vê.
    const codigo = marcadores();
    const acao = /\{canEditPosition \? \([\s\S]*?\) : null\}/.exec(codigo);
    expect(acao, "a ação não está sob a permissão").not.toBeNull();
    expect(acao![0]).toContain("cto-map-popup-edit-position");
    expect(acao![0]).toContain("Ajustar posição");

    // Secundária: o botão principal continua sendo Abrir CTO, com o primário.
    expect(acao![0]).toContain("cto-map-secondary");
    expect(acao![0], "a ação secundária virou botão primário").not.toContain(
      "bg-primary ",
    );
  });

  it("MAPEDIT-03/04 · só a caixa em edição é arrastável", () => {
    const codigo = marcadores();

    /*
      `draggable` derivado do id em edição, e não uma constante.

      Marcador permanentemente arrastável é o defeito que a fase existe para não
      cometer — e a sabotagem `S1` é exatamente `draggable` fixo em `true`.
    */
    expect(codigo).toContain("draggable={editando}");
    expect(codigo).toMatch(/const editando = marker\.id === editingId/);

    // Nenhum caminho torna todos arrastáveis.
    expect(codigo).not.toMatch(/draggable(=\{true\}|\s*$|>)/m);
  });

  it("MAPEDIT-05/06 · arrastar mexe SÓ no rascunho — o banco não é tocado", () => {
    const codigo = marcadores();

    /*
      `dragend` escreve no rascunho, e o rascunho é uma prop que veio da camada.
      Não existe `fetch` nenhum no componente dos marcadores: ele desenha e
      avisa, e quem grava é a camada, no clique em Salvar.
    */
    expect(codigo).toMatch(/dragend: \(evento\) => \{[\s\S]*?onDragEnd\(/);
    expect(codigo, "o marcador não pode falar com o servidor").not.toContain(
      "fetch(",
    );

    // E o arrasto não dispara nada além de avisar a camada.
    const handler = /dragend: \(evento\) => \{([\s\S]*?)\},/.exec(codigo);
    expect(handler).not.toBeNull();
    expect(handler![1]).not.toContain("PATCH");
    expect(handler![1]).not.toContain("salvar");
  });

  it("MAPEDIT-05b · o rascunho manda na posição, e o gravado nunca é alterado", () => {
    const codigo = marcadores();

    /*
      A posição vem do rascunho enquanto ele existe, e do par gravado quando
      não. É essa expressão que torna o Cancelar confiável depois de quantos
      arrastos forem: não há estado acumulado a desfazer, há uma origem que
      ninguém tocou.
    */
    const posicao = /position=\{([\s\S]*?)\}\r?\n/.exec(codigo);
    expect(posicao, "não achei a posição do marcador").not.toBeNull();
    expect(posicao![1]).toContain("draftPosition");
    expect(posicao![1]).toContain("marker.latitude");
  });

  it("MAPEDIT-07 · Cancelar não faz requisição, e só descarta o rascunho", () => {
    const codigo = camada();

    const cancelar = /const cancelarEdicao = useCallback\(\(\) => \{([\s\S]*?)\}, \[/.exec(
      codigo,
    );
    expect(cancelar, "não achei o cancelamento").not.toBeNull();

    // Nenhuma escrita: cancelar é um gesto local, e um `fetch` aqui seria um
    // efeito que ninguém pediu.
    expect(cancelar![1]).not.toContain("fetch");
    expect(cancelar![1]).not.toContain("PATCH");

    // Ele zera as três coisas: a caixa em edição, o rascunho e o erro.
    expect(cancelar![1]).toContain("setCtoEmEdicao(null)");
    expect(cancelar![1]).toContain("setEsboco(null)");
    expect(cancelar![1]).toContain("setErroPosicao(null)");
  });

  it("MAPEDIT-08 · Salvar manda o par pelo caminho que já existia", () => {
    const codigo = camada();

    expect(codigo).toMatch(/method: "PATCH"/);
    expect(codigo).toMatch(/fetch\(`\/api\/ctos\/\$\{[^}]+\}`/);

    // O corpo tem exatamente duas chaves — a garantia contra lost update.
    const corpo = /body: JSON\.stringify\(\{([\s\S]*?)\}\)/.exec(codigo);
    expect(corpo).not.toBeNull();
    const chaves = corpo![1]
      .split(",")
      .map((p) => p.split(":")[0].trim())
      .filter(Boolean);
    expect(chaves.sort()).toEqual(["latitude", "longitude"]);
  });

  it("MAPEDIT-08b · depois de salvar, quem confirma é a LEITURA", () => {
    const codigo = camada();
    const salvar = /const salvarPosicao = useCallback\(async \(\) => \{([\s\S]*?)\n  \}, \[/.exec(
      codigo,
    );
    expect(salvar, "não achei o salvamento").not.toBeNull();

    /*
      Sair do modo de edição com o rascunho na tela seria afirmar sucesso com
      estado local. A releitura do recorte traz a posição que o SERVIDOR tem — e
      se ela divergir, o mapa mostra a verdade em vez da esperança.
    */
    expect(salvar![1]).toContain("carregar(bbox)");
    expect(salvar![1]).toContain("setCtoEmEdicao(null)");
    expect(salvar![1]).toContain("setEsboco(null)");
  });

  it("MAPEDIT-11 · falha ao salvar NÃO finge sucesso", () => {
    const codigo = camada();
    const salvar = /const salvarPosicao = useCallback\(async \(\) => \{([\s\S]*?)\n  \}, \[/.exec(
      codigo,
    )!;

    // O caminho de erro sai ANTES de limpar o modo de edição.
    const recusa = /if \(!res\.ok\) \{([\s\S]*?)\n      \}/.exec(salvar[1]);
    expect(recusa, "não achei o tratamento de recusa").not.toBeNull();
    expect(recusa![1]).toContain("setErroPosicao");
    expect(
      recusa![1],
      "a recusa não pode encerrar a edição como se tivesse salvo",
    ).not.toContain("setCtoEmEdicao(null)");

    // Falha de rede também tem mensagem própria, e não silêncio.
    expect(salvar[1]).toMatch(/catch \{[\s\S]*?setErroPosicao/);

    // A mensagem exibida é a do servidor OU uma frase nossa — nunca o objeto
    // de erro cru, que é por onde detalhe interno vazaria para a tela.
    expect(codigo).toMatch(/payload\?\.error \?\? "Não foi possível salvar/);
  });

  it("MAPEDIT-09/23 · a plaqueta acompanha, inclusive fora do zoom operacional", () => {
    const codigo = marcadores();

    /*
      Entrar em edição fecha o popup, e fechar o popup limpa a seleção. Sem a
      terceira cláusula, quem estivesse abaixo do limiar de zoom perderia o nome
      da caixa exatamente enquanto a arrasta.
    */
    expect(codigo).toMatch(
      /const comPlaqueta = showLabels \|\| selecionado \|\| editando/,
    );

    // O rótulo continua sendo do Leaflet, preso ao marcador — é o que faz ele
    // acompanhar o arrasto em tempo real sem uma linha de código nossa.
    expect(codigo).toContain("permanent");
    expect(codigo).toContain('direction="top"');
  });

  it("MAPEDIT-10 · o modo de edição NÃO reaproveita a cor de estado", () => {
    /*
      Três dimensões independentes. Modo de edição não é estado da rede: uma CTO
      disponível continua verde enquanto está sendo movida. Pintá-la de outra
      cor faria o operador ler uma mudança de operação onde houve um gesto de
      interface.
    */
    const html = ctoMarkerHtml(
      ctoMapStatusPresentation("AVAILABLE"),
      true,
      true,
    );
    expect(html).toContain("cto-box--editing");
    expect(html, "a edição apagou o tom do estado").toContain("cto-box--success");
    expect(html).toContain("cto-box--selected");

    const css = leia("src/app/globals.css");
    const regra = /\.cto-box--editing \{([\s\S]*?)\}/.exec(css);
    expect(regra, "falta a regra do modo de edição").not.toBeNull();

    // Ela mexe no HALO e no cursor, e nunca no traço do corpo.
    expect(regra![1]).toContain("outline");
    expect(regra![1]).toContain("cursor: grab");
    expect(regra![1], "a edição não pode tocar o contorno de estado").not.toContain(
      "stroke",
    );

    // E o halo de edição é distinguível do de seleção: tracejado contra sólido.
    expect(regra![1]).toContain("dashed");
    const selecao = /\.cto-box--selected \{([\s\S]*?)\}/.exec(css)!;
    expect(selecao[1]).toContain("solid");
  });

  it("MAPEDIT-12 · o popup fecha ao entrar em edição, e o arrasto não o reabre", () => {
    const codigo = camada();

    /*
      A realimentação histórica: `popup → autoPan → moveend → render`. Um popup
      aberto sobre a caixa que está sendo arrastada reabre a briga entre
      `click`, `drag` e `autoPan` — além de cobrir justamente o que se quer ver.
    */
    const iniciar = /const iniciarEdicao = useCallback\([\s\S]*?\n    \},/.exec(
      codigo,
    );
    expect(iniciar, "não achei a entrada em edição").not.toBeNull();
    expect(iniciar![0]).toContain("closePopup()");

    /*
      E o rascunho chega aos marcadores por `dragend`, nunca por `drag`.

      `drag` dispara por quadro; como a posição é uma prop, atualizá-la a cada
      quadro re-renderizaria todos os marcadores dezenas de vezes por segundo —
      que é a forma exata do laço que a `CTO-3.2.1` pagou.
    */
    const marc = marcadores();
    expect(marc).toContain("dragend:");
    expect(marc, "`drag` contínuo reabre o laço de realimentação").not.toMatch(
      /\n\s+drag: /,
    );
  });

  it("MAPEDIT-13 · a caixa em edição sobrevive a arrastar e dar zoom no mapa", () => {
    const codigo = camada();

    /*
      A `§7` exige que pan e zoom continuem funcionando durante a edição, e isso
      dispara releitura do recorte. Se o operador afastar o mapa, a caixa que
      ele está movendo pode sair da lista que o servidor devolve.

      Guardar a CÓPIA — e não só o id — é o que a mantém desenhada. Com o id
      sozinho, o marcador sumiria debaixo da mão e levaria o painel junto.
    */
    expect(codigo).toMatch(/const \[ctoEmEdicao, setCtoEmEdicao\] = useState/);
    expect(codigo).toMatch(/const marcadores = useMemo\(/);
    expect(codigo).toContain("[...markers, ctoEmEdicao]");

    // E o modo/zoom continuam vivendo onde sempre viveram: nada da edição toca
    // o espelho da vista na URL.
    const salvar = /const salvarPosicao = useCallback\(async \(\) => \{([\s\S]*?)\n  \}, \[/.exec(
      codigo,
    )!;
    expect(salvar[1]).not.toContain("setMode");
    expect(salvar[1]).not.toContain("setCamera");
    expect(salvar[1]).not.toContain("replaceState");
  });

  it("MAPEDIT-14 · o painel mostra as DUAS posições, e Salvar exige um arrasto", () => {
    const codigo = camada();

    expect(codigo).toContain("cto-map-position-before");
    expect(codigo).toContain("cto-map-position-after");

    /*
      Sem a posição anterior não há como conferir nada — e conferir é o passo que
      separa "corrigi a caixa" de "movi a caixa".
    */
    expect(codigo).toMatch(/Posição anterior/);
    expect(codigo).toMatch(/Nova posição/);

    // Sem arrasto, Salvar fica indisponível: clicar não pode parecer que gravou.
    expect(codigo).toMatch(/disabled=\{salvando \|\| !esboco\}/);
  });

  it("MAPEDIT-SEC · a camada do mapa não conhece faixa de coordenada", () => {
    /*
      A validação é do DOMÍNIO, e uma cópia na tela seria a segunda autoridade
      que a `CTO-1.6` já custou: duas camadas sabendo `-90..90`, e quem falava
      era a que tinha menos a dizer.

      A tela desabilita o botão sem rascunho e mostra o que o servidor recusar.
      Ela não decide o que é uma coordenada.
    */
    const codigo = camada();
    expect(codigo).not.toContain("-90");
    expect(codigo).not.toContain("Number.isFinite");
    expect(codigo).not.toMatch(/latitude\s*[<>]=?\s*-?\d/);
  });
});
