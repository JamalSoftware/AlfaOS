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
  getCtoMapInitialView,
  getMapFallbackPoint,
  getMapTileConfig,
} from "@/lib/map-config";
import {
  DEFAULT_TILE_URL,
  readMapTileConfig,
  tileImageSource,
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

    await expect(MapaPage()).resolves.toBeTruthy();
  });

  it("UI-MAP-01b · DISPATCHER também abre — é a decisão da CTO-3.1", async () => {
    const { default: MapaPage } = await paginaDoMapa();
    session.token = await createTokenFor(fixture.dispatcherA.id);

    await expect(MapaPage()).resolves.toBeTruthy();
  });

  it("UI-MAP-02 · TECHNICIAN não abre, mesmo digitando a URL", async () => {
    const { default: MapaPage } = await paginaDoMapa();
    session.token = await createTokenFor(fixture.techA.id);

    expect(await redirectTargetOf(() => MapaPage())).toBe("/minhas-os");
  });

  it("UI-MAP-02b · sem sessão vai para o login", async () => {
    const { default: MapaPage } = await paginaDoMapa();
    session.token = null;

    expect(await redirectTargetOf(() => MapaPage())).toBe("/login");
  });

  it("UI-MAP-03 · capability desligada: a página não existe", async () => {
    await prisma.company.update({
      where: { id: fixture.companyA.id },
      data: { ctoNetworkEnabled: false },
    });

    const { default: MapaPage } = await paginaDoMapa();
    session.token = await createTokenFor(fixture.adminA.id);

    expect(await digestOf(() => MapaPage())).toMatch(/^NEXT_NOT_FOUND|^NEXT_HTTP_ERROR_FALLBACK;404/);
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

describe("Tiles — a configuração é uma só", () => {
  it("o padrão é OpenStreetMap, com atribuição", () => {
    const config = readMapTileConfig({});

    expect(config.urlTemplate).toBe(DEFAULT_TILE_URL);
    expect(config.attribution).toContain("OpenStreetMap");
    expect(config.maxZoom).toBe(19);
  });

  it("o ambiente troca o provedor sem tocar em componente", () => {
    const config = readMapTileConfig({
      MAP_TILE_URL: "https://tiles.exemplo.com/{z}/{x}/{y}.png",
      MAP_TILE_ATTRIBUTION: "© Exemplo",
      MAP_TILE_MAX_ZOOM: "17",
    });

    expect(config.urlTemplate).toBe("https://tiles.exemplo.com/{z}/{x}/{y}.png");
    expect(config.attribution).toBe("© Exemplo");
    expect(config.maxZoom).toBe(17);
  });

  it("provedor trocado NÃO herda a atribuição do OpenStreetMap", () => {
    /*
      Herdar seria creditar o OSM por um mapa que não é dele — e a atribuição é
      exigência de licença, não enfeite.
    */
    const config = readMapTileConfig({
      MAP_TILE_URL: "https://tiles.exemplo.com/{z}/{x}/{y}.png",
    });

    expect(config.attribution).toBe("");
  });

  it("variável em branco cai no padrão, em vez de virar URL vazia", () => {
    const config = readMapTileConfig({ MAP_TILE_URL: "   " });
    expect(config.urlTemplate).toBe(DEFAULT_TILE_URL);
  });

  it("zoom inválido cai no padrão", () => {
    for (const bruto of ["0", "23", "abc", "12.5", ""]) {
      expect(readMapTileConfig({ MAP_TILE_MAX_ZOOM: bruto }).maxZoom).toBe(19);
    }
  });

  it("a CSP recebe a ORIGEM derivada da mesma URL", () => {
    expect(tileImageSource(DEFAULT_TILE_URL)).toBe(
      "https://tile.openstreetmap.org",
    );
    expect(tileImageSource("https://tiles.exemplo.com/{z}/{x}/{y}.png")).toBe(
      "https://tiles.exemplo.com",
    );
    expect(tileImageSource("https://cdn.local:8443/{z}/{x}/{y}.png")).toBe(
      "https://cdn.local:8443",
    );
  });

  it("o `{s}` vira curinga PRESO ao domínio, nunca `https:` solto", () => {
    const origem = tileImageSource("https://{s}.tile.exemplo.com/{z}/{x}/{y}.png");

    expect(origem).toBe("https://*.tile.exemplo.com");
    // Um curinga solto liberaria imagem de qualquer host da internet, e a CSP
    // viraria decoração.
    expect(origem).not.toBe("https:");
    expect(origem).not.toBe("*");
  });

  it("URL inválida falha ALTO, e não vira CSP silenciosamente inútil", () => {
    expect(() => tileImageSource("javascript:alert(1)")).toThrow();
    expect(() => tileImageSource("data:image/png;base64,AAAA")).toThrow();
    expect(() => tileImageSource("/relativa/{z}/{x}/{y}.png")).toThrow();
    expect(() => tileImageSource("")).toThrow();
  });

  it("`getMapTileConfig` valida a URL ao montar a página", () => {
    expect(() =>
      getMapTileConfig({ MAP_TILE_URL: "ftp://tiles.exemplo.com/{z}.png" }),
    ).toThrow();
  });

  /*
    A CSP e o componente NÃO podem ter fontes diferentes.

    Este é o teste que a sabotagem `S6` precisa derrubar: se alguém escrever a
    URL do tile dentro do componente, a CSP continuará liberando o host da
    configuração — e o mapa abre cinza sem nenhum erro visível, porque violação
    de CSP apaga a imagem em vez de quebrar a página.
  */
  it("S6 · nenhum componente do mapa contém URL de tile", () => {
    const arquivos = [
      "src/components/map/MapCanvas.tsx",
      "src/components/map/OperationalMap.tsx",
      "src/components/map/CtoMapLayer.tsx",
      "src/components/map/CtoMarkers.tsx",
      "src/app/(app)/mapa/page.tsx",
    ];

    for (const arquivo of arquivos) {
      const codigo = semComentarios(leia(arquivo));

      // O padrão de tile do Leaflet, em qualquer provedor.
      expect(codigo, `${arquivo} contém template de tile`).not.toMatch(
        /\{z\}[^\n]*\{x\}[^\n]*\{y\}/,
      );
      expect(codigo, `${arquivo} contém host de tile`).not.toMatch(
        /https?:\/\/[^"'\s]*tile/i,
      );
      expect(codigo, `${arquivo} cita o OpenStreetMap`).not.toMatch(
        /openstreetmap/i,
      );
    }
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
