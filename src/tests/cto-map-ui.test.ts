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
  CTO_MARKER_SIZE,
  ctoMarkerHtml,
} from "@/components/map/cto-marker-icon";
import {
  DEFAULT_NORMAL_URL,
  MAP_INITIAL_FIT_MAX_ZOOM,
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
    // Um desenho em que as portas escapam do corpo não lê como caixa.
    const html = svg();
    const corpo = /<rect class="cto-box__body" x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/.exec(html);
    const bandeja = /<rect class="cto-box__tray" x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/.exec(html);

    expect(corpo).not.toBeNull();
    expect(bandeja).not.toBeNull();

    const [, cx, cy, cw, ch] = corpo!.map(Number) as unknown as number[];
    const [, bx, by, bw, bh] = bandeja!.map(Number) as unknown as number[];

    expect(bx).toBeGreaterThanOrEqual(cx);
    expect(by).toBeGreaterThanOrEqual(cy);
    expect(bx + bw).toBeLessThanOrEqual(cx + cw);
    expect(by + bh).toBeLessThanOrEqual(cy + ch);
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
