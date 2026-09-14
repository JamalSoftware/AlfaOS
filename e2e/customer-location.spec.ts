import { test, expect, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { allocateServiceOrderNumber } from "../src/lib/service-order-number";
import { assertTestDatabase } from "./test-db-guard";

/**
 * # RC-1C — localização do cliente, pelo navegador
 *
 * O teste central é a dúvida que o dono teve olhando o caso real: "o técnico
 * corrigiu, e o mapa mudou MESMO?". Aqui:
 *
 * 1. o cliente tem o ponto A, e o ADMIN vê o marcador em A;
 * 2. o técnico corrige com o GPS em B, pela API REAL do Field;
 * 3. a autoridade, a trilha A → B e a projeção dizem B;
 * 4. o marcador está em B — depois de recarregar, e numa sessão NOVA.
 *
 * A posição do marcador é medida contra a projeção Web Mercator da vista da
 * URL, como a `MAPEDIT` do Mapa Operacional faz: o que se afirma é "o desenho
 * está sobre a coordenada", não "o elemento existe".
 *
 * Mais o contrato de "Confirmar" (perto passa, longe não grava nada), o cartão
 * somente leitura do ADMIN, a timeline com a distância, a correção só de
 * endereço e o cartão em 375×812.
 */

const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgresql://alfaos:alfaos_dev_password@localhost:5432/alfaos_test?schema=public";

const prisma = new PrismaClient({ datasources: { db: { url: E2E_DATABASE_URL } } });

const SENHA = "AlfaOS@2026";
const EMAIL_ADMIN = "qa.rc1c.admin@sintetico.local";
const EMAIL_DESPACHO = "qa.rc1c.despacho@sintetico.local";
const EMAIL_TECNICO = "qa.rc1c.tecnico@sintetico.local";
const EMAILS = [EMAIL_ADMIN, EMAIL_DESPACHO, EMAIL_TECNICO];
const NOME_TECNICO = "QA RC1C Técnico";

/** ~550 m entre A e B, na mesma longitude. Fictícios. */
const A = { latitude: -20.3155, longitude: -40.3128 };
const B = { latitude: -20.3105, longitude: -40.3128 };
/** Ponto do cliente da confirmação. */
const C = { latitude: -20.2805, longitude: -40.2951 };
/** Ponto do cliente da correção só de endereço. */
const D = { latitude: -20.3305, longitude: -40.3301 };

const RAIO = 6_371_008.8;
const aNorte = (p: { latitude: number; longitude: number }, metros: number) => ({
  latitude: p.latitude + ((metros / RAIO) * 180) / Math.PI,
  longitude: p.longitude,
});

let empresaId = "";
const ids = {
  central: { cliente: "", os: "" },
  confirma: { cliente: "", os: "" },
  longe: { cliente: "", os: "" },
  endereco: { cliente: "", os: "" },
  semPonto: "",
  legado: "",
  divergente: "",
};

/** Autoridade em E, projeção em F (~400 m ao norte). O mapa tem de desenhar E. */
const E = { latitude: -20.2605, longitude: -40.3501 };
const F = { latitude: -20.2569, longitude: -40.3501 };
let numeroOsCentral = 0;

async function clienteComPonto(
  nome: string,
  ponto: { latitude: number; longitude: number },
  tecnicoId: string,
) {
  const cliente = await prisma.customer.create({
    data: {
      companyId: empresaId,
      name: nome,
      address: "Rua QA RC1C",
      number: "10",
      city: "Vitória",
      state: "ES",
      active: true,
      // A projeção como o escritor de importação a deixa: em sincronia.
      latitude: ponto.latitude,
      longitude: ponto.longitude,
      locationSource: "IMPORTED",
      locationVerified: false,
    },
  });
  await prisma.customerLocation.create({
    data: {
      companyId: empresaId,
      customerId: cliente.id,
      latitude: ponto.latitude,
      longitude: ponto.longitude,
      source: "IMPORTED",
      verified: false,
    },
  });
  const os = await prisma.serviceOrder.create({
    data: {
      companyId: empresaId,
      number: await allocateServiceOrderNumber(prisma, empresaId),
      customerId: cliente.id,
      technicianId: tecnicoId,
      type: "Reparo RC1C",
      description: "QA RC1C",
      status: "IN_PROGRESS",
      assignedAt: new Date(),
      startedAt: new Date(),
    },
  });
  return { cliente: cliente.id, os: os.id, numero: os.number };
}

test.beforeAll(async () => {
  await assertTestDatabase(E2E_DATABASE_URL, "E2E_DATABASE_URL");
  const bcrypt = (await import("bcryptjs")).default;
  const hash = bcrypt.hashSync(SENHA, 10);

  const empresa = await prisma.company.create({
    data: { name: "RC-1C Sintetica", ctoNetworkEnabled: true },
  });
  empresaId = empresa.id;
  const usuario = (email: string, name: string, profile: "ADMIN" | "DISPATCHER" | "TECHNICIAN") =>
    prisma.user.create({ data: { companyId: empresaId, email, name, profile, passwordHash: hash } });
  await usuario(EMAIL_ADMIN, "QA RC1C Admin", "ADMIN");
  await usuario(EMAIL_DESPACHO, "QA RC1C Despacho", "DISPATCHER");
  const userTecnico = await usuario(EMAIL_TECNICO, NOME_TECNICO, "TECHNICIAN");
  const tecnico = await prisma.technician.create({
    data: { companyId: empresaId, userId: userTecnico.id },
  });

  const central = await clienteComPonto("QA RC1C Cliente Central", A, tecnico.id);
  ids.central = { cliente: central.cliente, os: central.os };
  numeroOsCentral = central.numero;
  const confirma = await clienteComPonto("QA RC1C Cliente Confirma", C, tecnico.id);
  ids.confirma = { cliente: confirma.cliente, os: confirma.os };
  const longe = await clienteComPonto("QA RC1C Cliente Longe", C, tecnico.id);
  ids.longe = { cliente: longe.cliente, os: longe.os };
  const endereco = await clienteComPonto("QA RC1C Cliente Endereco", D, tecnico.id);
  ids.endereco = { cliente: endereco.cliente, os: endereco.os };

  ids.semPonto = (
    await prisma.customer.create({
      data: { companyId: empresaId, name: "QA RC1C Sem Ponto", address: "Rua Sem Ponto", city: "Vitória" },
    })
  ).id;
  // Divergência forçada (nenhum escritor de produção a produz): a autoridade
  // diz E, a projeção diz F.
  const divergente = await prisma.customer.create({
    data: {
      companyId: empresaId,
      name: "QA RC1C Divergente",
      city: "Vitória",
      active: true,
      latitude: F.latitude,
      longitude: F.longitude,
      locationSource: "IMPORTED",
    },
  });
  await prisma.customerLocation.create({
    data: {
      companyId: empresaId,
      customerId: divergente.id,
      latitude: E.latitude,
      longitude: E.longitude,
      source: "IMPORTED",
      verified: false,
    },
  });
  ids.divergente = divergente.id;

  // O legado do RC-LOC-04: projeção, e nenhuma autoridade.
  ids.legado = (
    await prisma.customer.create({
      data: {
        companyId: empresaId,
        name: "QA RC1C Legado",
        address: "Rua Legado",
        city: "Vitória",
        latitude: -20.3399,
        longitude: -40.3399,
        locationSource: "IMPORTED",
      },
    })
  ).id;
});

test.afterAll(async () => {
  if (empresaId) {
    const w = { where: { companyId: empresaId } };
    await prisma.serviceOrderEvent.deleteMany(w);
    await prisma.customerLocationHistory.deleteMany(w);
    await prisma.customerLocation.deleteMany(w);
    await prisma.technicianDispatchQueueEntry.deleteMany(w);
    await prisma.technicianDispatchQueue.deleteMany(w);
    await prisma.serviceOrderExecution.deleteMany(w);
    await prisma.serviceOrder.deleteMany(w);
    await prisma.customer.deleteMany(w);
    await prisma.idempotencyRecord.deleteMany(w);
    await prisma.notification.deleteMany(w);
    await prisma.outboxEvent.deleteMany(w);
    await prisma.mobileDevice.deleteMany(w);
    await prisma.technician.deleteMany(w);
    await prisma.auditLog.deleteMany(w);
    await prisma.user.deleteMany(w);
    await prisma.company.delete({ where: { id: empresaId } });
  }
  await prisma.loginAttempt.deleteMany({ where: { email: { in: EMAILS } } });
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// Ajudantes
// ---------------------------------------------------------------------------

async function entrar(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Senha").fill(SENHA);
  await page.getByRole("button", { name: "Entrar" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
}

let seq = 0;
async function tokenDoTecnico(api: APIRequestContext): Promise<string> {
  const login = await api.post("/api/field/v1/auth/login", {
    data: {
      email: EMAIL_TECNICO,
      password: SENHA,
      device: { platform: "ANDROID", installationId: `qa-rc1c-${++seq}-${Date.now()}` },
    },
  });
  expect(login.ok()).toBe(true);
  return ((await login.json()) as { data: { token: string } }).data.token;
}

async function comandoDoCampo(
  api: APIRequestContext,
  token: string,
  url: string,
  data: Record<string, unknown>,
) {
  const res = await api.post(url, {
    headers: { Authorization: `Bearer ${token}`, "Idempotency-Key": `qa-rc1c-${++seq}-${Date.now()}` },
    data,
  });
  return { status: res.status(), body: (await res.json()) as Record<string, unknown> };
}

async function versaoDoPonto(customerId: string) {
  return (await prisma.customerLocation.findUniqueOrThrow({ where: { customerId } })).version;
}

const seletorDoCliente = (nome: string) => `.leaflet-marker-icon[title^="${nome}"] .cto-dot__body`;

/** 1×1 transparente: o tile de verdade não importa, e a rede externa fica de fora. */
const TILE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/** Abre o mapa com a camada de clientes, enquadrando o ponto pedido. */
async function abrirMapa(page: Page, centro: { latitude: number; longitude: number }, zoom = 16) {
  // Os HOSTS dos provedores, e nada mais amplo: um padrão como /tile/ casaria
  // também com chunk do Next em desenvolvimento (`map-tiles`).
  for (const host of [/tile\.openstreetmap\.org/, /server\.arcgisonline\.com/, /basemaps\.cartocdn\.com/]) {
    await page.route(host, (r) => r.fulfill({ status: 200, contentType: "image/png", body: TILE_PNG }));
  }
  await page.goto(
    `/mapa?lat=${centro.latitude}&lng=${centro.longitude}&z=${zoom}&layers=CTOS,ORDERS,CUSTOMERS`,
  );
  await expect(page.locator(".leaflet-container")).toBeVisible({ timeout: 20_000 });
}

/** Onde uma coordenada cai no contêiner do mapa, pela vista da URL (Web Mercator). */
function pontoDaCoordenada(
  page: Page,
  mapa: { width: number; height: number },
  alvo: { latitude: number; longitude: number },
) {
  const vista = new URL(page.url()).searchParams;
  const escala = 256 * 2 ** Number(vista.get("z"));
  const projetar = (lat: number, lng: number) => {
    const seno = Math.sin((lat * Math.PI) / 180);
    return {
      x: ((lng + 180) / 360) * escala,
      y: (0.5 - Math.log((1 + seno) / (1 - seno)) / (4 * Math.PI)) * escala,
    };
  };
  const centro = projetar(Number(vista.get("lat")), Number(vista.get("lng")));
  const p = projetar(alvo.latitude, alvo.longitude);
  return { x: mapa.width / 2 + (p.x - centro.x), y: mapa.height / 2 + (p.y - centro.y) };
}

/** O centro do marcador do cliente, relativo ao contêiner do mapa. */
async function centroDoMarcador(page: Page, nome: string) {
  const marcador = page.locator(seletorDoCliente(nome));
  await expect(marcador).toBeVisible({ timeout: 20_000 });
  const m = (await marcador.boundingBox())!;
  const mapa = (await page.locator(".leaflet-container").boundingBox())!;
  return { centro: { x: m.x - mapa.x + m.width / 2, y: m.y - mapa.y + m.height / 2 }, mapa };
}

function distanciaPx(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** O marcador está sobre `perto` (≤ 8 px) e longe de `longe` (≥ 60 px). */
async function marcadorEm(
  page: Page,
  nome: string,
  perto: { latitude: number; longitude: number },
  longe: { latitude: number; longitude: number },
) {
  const { centro, mapa } = await centroDoMarcador(page, nome);
  const alvo = pontoDaCoordenada(page, mapa, perto);
  const outro = pontoDaCoordenada(page, mapa, longe);
  expect(distanciaPx(centro, alvo), `marcador longe de onde deveria estar`).toBeLessThanOrEqual(8);
  expect(distanciaPx(centro, outro), `marcador ainda perto do ponto antigo`).toBeGreaterThanOrEqual(60);
}

const MEIO_AB = { latitude: (A.latitude + B.latitude) / 2, longitude: A.longitude };
const NOME_CENTRAL = "QA RC1C Cliente Central";

// ---------------------------------------------------------------------------
// O teste central — LOC-R01..R06
// ---------------------------------------------------------------------------

test.describe("RC-1C — corrigir com GPS move o marcador, e ele fica", () => {
  test("LOC-R01..R06 · A → B pela API do Field; o mapa mostra B, depois de recarregar e numa sessão nova", async ({
    page,
    playwright,
    browser,
    baseURL,
  }) => {
    test.setTimeout(180_000);

    // 1. antes: o ADMIN vê o marcador em A.
    await entrar(page, EMAIL_ADMIN);
    await abrirMapa(page, MEIO_AB);
    await marcadorEm(page, NOME_CENTRAL, A, B);

    // 2. o técnico corrige com o GPS em B — a API real do aplicativo.
    const api = await playwright.request.newContext({ baseURL });
    try {
      const token = await tokenDoTecnico(api);
      const r = await comandoDoCampo(
        api,
        token,
        `/api/field/v1/service-orders/${ids.central.os}/location/correct`,
        {
          expectedVersion: await versaoDoPonto(ids.central.cliente),
          reason: "INCORRECT_LOCATION",
          latitude: B.latitude,
          longitude: B.longitude,
          accuracyMeters: 6,
          source: "TECHNICIAN_GPS",
        },
      );
      // 3. a API respondeu sucesso.
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    } finally {
      await api.dispose();
    }

    // 4..6. autoridade = B, trilha A → B, projeção = B.
    const ponto = await prisma.customerLocation.findUniqueOrThrow({
      where: { customerId: ids.central.cliente },
    });
    expect(Number(ponto.latitude)).toBeCloseTo(B.latitude, 7);
    expect(ponto.source).toBe("TECHNICIAN_GPS");
    expect(ponto.verified).toBe(true);
    const trilha = await prisma.customerLocationHistory.findFirstOrThrow({
      where: { customerId: ids.central.cliente },
    });
    expect(Number(trilha.previousLatitude)).toBeCloseTo(A.latitude, 7);
    expect(Number(trilha.newLatitude)).toBeCloseTo(B.latitude, 7);
    const projecao = await prisma.customer.findUniqueOrThrow({ where: { id: ids.central.cliente } });
    expect(Number(projecao.latitude)).toBeCloseTo(B.latitude, 7);

    // 8..9. o ADMIN abre o mapa: o marcador está em B.
    await abrirMapa(page, MEIO_AB);
    await marcadorEm(page, NOME_CENTRAL, B, A);

    // 10..11. recarregar: continua em B.
    await page.reload();
    await expect(page.locator(".leaflet-container")).toBeVisible();
    await marcadorEm(page, NOME_CENTRAL, B, A);

    // 12..13. uma sessão NOVA, do zero: continua em B.
    const outra = await (browser as Browser).newContext();
    const nova = await outra.newPage();
    try {
      await entrar(nova, EMAIL_ADMIN);
      await abrirMapa(nova, MEIO_AB);
      await marcadorEm(nova, NOME_CENTRAL, B, A);
    } finally {
      await outra.close();
    }
  });

  test("RC-LOC-03 · o cartão do ADMIN mostra o ponto corrigido, e 'Ver no mapa' leva até ele", async ({
    page,
  }) => {
    await entrar(page, EMAIL_ADMIN);
    await page.goto(`/clientes/${ids.central.cliente}/editar`);
    const card = page.getByTestId("customer-location-card");
    await expect(card).toBeVisible();
    await expect(card.getByRole("heading", { name: "Localização do cliente" })).toBeVisible();
    await expect(card.getByText("Localização cadastrada")).toBeVisible();
    await expect(page.getByTestId("customer-location-latitude")).toHaveText(B.latitude.toFixed(7));
    await expect(page.getByTestId("customer-location-longitude")).toHaveText(B.longitude.toFixed(7));
    await expect(page.getByTestId("customer-location-accuracy")).toHaveText("6 m");
    await expect(page.getByTestId("customer-location-source")).toHaveText(
      "Técnico em campo (GPS do aparelho)",
    );
    await expect(page.getByTestId("customer-location-verified")).toHaveText("Sim");
    await expect(page.getByTestId("customer-location-technician")).toHaveText(NOME_TECNICO);
    await expect(page.getByTestId("customer-location-order")).toHaveText(`OS Nº ${numeroOsCentral}`);
    // Somente leitura: nenhum campo de coordenada para editar.
    await expect(card.locator("input, textarea, select")).toHaveCount(0);

    await page.getByTestId("customer-location-map-link").click();
    await page.waitForURL(/\/mapa\?/);
    const vista = new URL(page.url()).searchParams;
    expect(Number(vista.get("lat"))).toBeCloseTo(B.latitude, 5);
    expect(vista.get("layers")).toContain("CUSTOMERS");
    const { centro, mapa } = await centroDoMarcador(page, NOME_CENTRAL);
    expect(distanciaPx(centro, { x: mapa.width / 2, y: mapa.height / 2 })).toBeLessThanOrEqual(8);
  });
});

test("§30 · autoridade em E e projeção em F: o mapa E o cartão mostram E", async ({ page }) => {
  // No teste central as duas concordam, então ele sozinho não distingue qual
  // o mapa lê. Aqui elas discordam de propósito.
  await entrar(page, EMAIL_ADMIN);
  await abrirMapa(page, { latitude: (E.latitude + F.latitude) / 2, longitude: E.longitude });
  await marcadorEm(page, "QA RC1C Divergente", E, F);

  await page.goto(`/clientes/${ids.divergente}/editar`);
  await expect(page.getByTestId("customer-location-latitude")).toHaveText(E.latitude.toFixed(7));
});

// ---------------------------------------------------------------------------
// Confirmar — o contrato, pelo servidor real
// ---------------------------------------------------------------------------

test.describe("RC-1C — confirmar pelo servidor real", () => {
  test("LOC-C05 · longe (~2,3 km): 400 com a orientação, e o ponto NÃO vira verificado", async ({
    playwright,
    baseURL,
    page,
  }) => {
    const api = await playwright.request.newContext({ baseURL });
    try {
      const token = await tokenDoTecnico(api);
      const longe = aNorte(C, 2357);
      const r = await comandoDoCampo(
        api,
        token,
        `/api/field/v1/service-orders/${ids.longe.os}/location/confirm`,
        {
          expectedVersion: await versaoDoPonto(ids.longe.cliente),
          observedLatitude: longe.latitude,
          observedLongitude: longe.longitude,
          observedAccuracyMeters: 12,
        },
      );
      expect(r.status).toBe(400);
      expect((r.body.error as { message: string }).message).toBe(
        "Você está a 2,36 km do ponto cadastrado. Use Corrigir localização.",
      );
      // Sem GPS também não.
      const semGps = await comandoDoCampo(
        api,
        token,
        `/api/field/v1/service-orders/${ids.longe.os}/location/confirm`,
        { expectedVersion: await versaoDoPonto(ids.longe.cliente) },
      );
      expect(semGps.status).toBe(400);
    } finally {
      await api.dispose();
    }
    const ponto = await prisma.customerLocation.findUniqueOrThrow({
      where: { customerId: ids.longe.cliente },
    });
    expect(ponto.verified).toBe(false);

    await entrar(page, EMAIL_ADMIN);
    await page.goto(`/clientes/${ids.longe.cliente}/editar`);
    await expect(page.getByTestId("customer-location-verified")).toHaveText("Não");
  });

  test("LOC-C02 + RC-LOC-02 · perto (40 m): confirma; o cartão diz verificada e a timeline diz a distância", async ({
    playwright,
    baseURL,
    page,
  }) => {
    const api = await playwright.request.newContext({ baseURL });
    try {
      const token = await tokenDoTecnico(api);
      const perto = aNorte(C, 40);
      const r = await comandoDoCampo(
        api,
        token,
        `/api/field/v1/service-orders/${ids.confirma.os}/location/confirm`,
        {
          expectedVersion: await versaoDoPonto(ids.confirma.cliente),
          observedLatitude: perto.latitude,
          observedLongitude: perto.longitude,
          observedAccuracyMeters: 9,
        },
      );
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect((r.body.data as { distanceMeters: number }).distanceMeters).toBe(40);
    } finally {
      await api.dispose();
    }

    await entrar(page, EMAIL_ADMIN);
    await page.goto(`/clientes/${ids.confirma.cliente}/editar`);
    // Confirmar não move o ponto nem troca a origem.
    await expect(page.getByTestId("customer-location-latitude")).toHaveText(C.latitude.toFixed(7));
    await expect(page.getByTestId("customer-location-source")).toHaveText("Importação do ERP");
    await expect(page.getByTestId("customer-location-verified")).toHaveText("Sim");

    const timeline = page.getByTestId("customer-timeline");
    await expect(timeline.getByText("Localização confirmada em campo")).toBeVisible();
    await expect(timeline.getByText("Confirmada a 40 m do ponto cadastrado.")).toBeVisible();
    // Nenhuma coordenada na timeline.
    await expect(timeline).not.toContainText(C.latitude.toFixed(4));
  });
});

// ---------------------------------------------------------------------------
// Só o endereço
// ---------------------------------------------------------------------------

test("LOC-R07 · corrigir só o endereço: o texto muda e o marcador NÃO se move", async ({
  playwright,
  baseURL,
  page,
}) => {
  const api = await playwright.request.newContext({ baseURL });
  try {
    const token = await tokenDoTecnico(api);
    const r = await comandoDoCampo(
      api,
      token,
      `/api/field/v1/service-orders/${ids.endereco.os}/location/correct`,
      {
        expectedVersion: await versaoDoPonto(ids.endereco.cliente),
        reason: "INCORRECT_ADDRESS",
        address: { address: "Rua Corrigida RC1C", number: "77" },
      },
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  } finally {
    await api.dispose();
  }

  await entrar(page, EMAIL_ADMIN);
  await page.goto(`/clientes/${ids.endereco.cliente}/editar`);
  await expect(page.getByTestId("customer-location-latitude")).toHaveText(D.latitude.toFixed(7));
  await expect(page.getByTestId("customer-location-verified")).toHaveText("Não");

  await abrirMapa(page, D, 17);
  await marcadorEm(page, "QA RC1C Cliente Endereco", D, aNorte(D, 300));
});

// ---------------------------------------------------------------------------
// O cartão: sem ponto, legado, perfil e tela pequena
// ---------------------------------------------------------------------------

test.describe("RC-LOC-03 — o cartão em outros estados", () => {
  test("sem ponto: 'Sem localização geográfica cadastrada', com a explicação aprovada", async ({ page }) => {
    await entrar(page, EMAIL_ADMIN);
    await page.goto(`/clientes/${ids.semPonto}/editar`);
    const card = page.getByTestId("customer-location-card");
    await expect(card.getByText("Sem localização geográfica cadastrada")).toBeVisible();
    await expect(
      card.getByText(
        "O endereço textual existe, mas este cliente ainda não possui uma posição geográfica confirmada no AlfaOS.",
      ),
    ).toBeVisible();
    await expect(page.getByTestId("customer-location-map-link")).toHaveCount(0);
    await expect(page.getByTestId("customer-location-legacy")).toHaveCount(0);
  });

  test("legado (projeção sem autoridade): SEM localização, com a nota — e sem a coordenada antiga", async ({
    page,
  }) => {
    await entrar(page, EMAIL_ADMIN);
    await page.goto(`/clientes/${ids.legado}/editar`);
    const card = page.getByTestId("customer-location-card");
    await expect(card.getByText("Sem localização geográfica cadastrada")).toBeVisible();
    await expect(page.getByTestId("customer-location-legacy")).toBeVisible();
    await expect(card).not.toContainText("-20.3399");
    await expect(page.getByTestId("customer-location-latitude")).toHaveCount(0);
  });

  test("DISPATCHER não recebe o cartão", async ({ page }) => {
    await entrar(page, EMAIL_DESPACHO);
    await page.goto(`/clientes/${ids.central.cliente}/editar`);
    await expect(page.getByRole("heading", { name: "Editar cliente" })).toBeVisible();
    await expect(page.getByTestId("customer-location-card")).toHaveCount(0);
  });

  test("375×812: o cartão cabe, a coordenada não estoura, e a página não rola de lado", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await entrar(page, EMAIL_ADMIN);
    await page.goto(`/clientes/${ids.central.cliente}/editar`);
    const card = page.getByTestId("customer-location-card");
    await card.scrollIntoViewIfNeeded();
    await expect(card).toBeVisible();

    const caixa = (await card.boundingBox())!;
    expect(caixa.x).toBeGreaterThanOrEqual(0);
    expect(caixa.x + caixa.width).toBeLessThanOrEqual(375);
    for (const id of ["customer-location-latitude", "customer-location-longitude", "customer-location-map-link"]) {
      const b = (await page.getByTestId(id).boundingBox())!;
      expect(b.x, id).toBeGreaterThanOrEqual(caixa.x);
      expect(b.x + b.width, id).toBeLessThanOrEqual(caixa.x + caixa.width + 0.5);
    }
    const rolagemLateral = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(rolagemLateral).toBeLessThanOrEqual(0);
  });
});
