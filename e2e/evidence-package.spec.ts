import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { allocateServiceOrderNumber } from "../src/lib/service-order-number";
import { montarPngReal } from "../src/tests/support/png-real";
import { assertTestDatabase } from "./test-db-guard";

/**
 * # EV-1 — Pacote técnico de evidências, pelo navegador
 *
 * O atendimento é feito pela API REAL do Field, como o aplicativo faz: login do
 * técnico, início, correção do ponto, check-in, checklist, fotos, equipamento
 * com etiqueta, material, relatório, assinatura e conclusão. Nada do que o
 * pacote mostra é gravado direto no banco — se a tela concordasse com uma
 * fixture escrita à mão, provaria só que concorda com a fixture.
 *
 * Cada foto tem uma DIMENSÃO própria. A imagem que o navegador abre precisa ter
 * a largura e a altura da foto daquela categoria: é o que prova que ela
 * decodificou (lição da CTO-1.8 — um `<img>` quebrado responde 200) e que cada
 * quadro aponta para a própria evidência, não para a vizinha.
 *
 * A empresa vive em `America/Manaus`, uma hora atrás do fuso da máquina: hora
 * formatada no fuso do servidor sai diferente, e a spec vê.
 */

const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgresql://alfaos:alfaos_dev_password@localhost:5432/alfaos_test?schema=public";

const prisma = new PrismaClient({
  datasources: { db: { url: E2E_DATABASE_URL } },
});

const SENHA = "AlfaOS@2026";
const EMAIL_ADMIN = "qa.ev.admin@sintetico.local";
const EMAIL_DESPACHO = "qa.ev.despacho@sintetico.local";
const EMAIL_TECNICO = "qa.ev.tecnico@sintetico.local";
const EMAIL_OUTRO_TECNICO = "qa.ev.outro@sintetico.local";
const EMAIL_ADMIN_OUTRA = "qa.ev.admin.outra@sintetico.local";
const EMAILS = [EMAIL_ADMIN, EMAIL_DESPACHO, EMAIL_TECNICO, EMAIL_OUTRO_TECNICO, EMAIL_ADMIN_OUTRA];
const FUSO_EMPRESA = "America/Manaus";

const NOME_CLIENTE = "QA EV Cliente";
const NOME_TECNICO = "QA EV Técnico";
const ASSINANTE = "Maria QA EV";
const DIAGNOSTICO = "Sinal ausente por conector mal polido na CTO.";
const SERVICO = "Conector refeito, ONU ativada e velocidade aferida.";
const MATERIAL = "Cabo drop óptico QA EV";

/** Dimensão de cada foto: a imagem aberta tem de ter exatamente esta. */
const DIMENSAO = {
  CTO: [64, 48],
  ONU_ONT: [48, 64],
  SPEED_TEST: [80, 40],
  OPTICAL_READING: [40, 80],
  EQUIPMENT_LABEL: [60, 60],
  ASSINATURA: [120, 40],
} as const;

/** As coordenadas do atendimento. Nenhuma pode aparecer na página. */
const PONTO = { latitude: -3.1197, longitude: -60.0213 };
const CHECKIN = { latitude: -3.11983, longitude: -60.02141 };

let empresaId = "";
let outraEmpresaId = "";
let concluidaId = "";
let concluidaNumero = 0;
let emAtendimentoId = "";
let etiquetaId = "";
let fotoCtoId = "";

test.beforeAll(async ({ playwright }, testInfo) => {
  // Cada rota do Field compila no primeiro acesso do `next dev`.
  test.setTimeout(240_000);
  await assertTestDatabase(E2E_DATABASE_URL, "E2E_DATABASE_URL");

  const bcrypt = (await import("bcryptjs")).default;
  const hash = bcrypt.hashSync(SENHA, 10);

  const empresa = await prisma.company.create({
    data: { name: "EV-1 Sintetica", timezone: FUSO_EMPRESA },
  });
  empresaId = empresa.id;
  const outra = await prisma.company.create({ data: { name: "EV-1 Outra Sintetica" } });
  outraEmpresaId = outra.id;

  const usuario = (
    companyId: string,
    email: string,
    name: string,
    profile: "ADMIN" | "DISPATCHER" | "TECHNICIAN",
  ) => prisma.user.create({ data: { companyId, email, name, profile, passwordHash: hash } });
  await usuario(empresaId, EMAIL_ADMIN, "QA EV Admin", "ADMIN");
  await usuario(empresaId, EMAIL_DESPACHO, "QA EV Despacho", "DISPATCHER");
  const userTecnico = await usuario(empresaId, EMAIL_TECNICO, NOME_TECNICO, "TECHNICIAN");
  const userOutro = await usuario(empresaId, EMAIL_OUTRO_TECNICO, "QA EV Outro Técnico", "TECHNICIAN");
  await usuario(outraEmpresaId, EMAIL_ADMIN_OUTRA, "QA EV Admin Outra", "ADMIN");
  const tecnico = await prisma.technician.create({
    data: { companyId: empresaId, userId: userTecnico.id },
  });
  await prisma.technician.create({ data: { companyId: empresaId, userId: userOutro.id } });

  const tipo = await prisma.serviceOrderType.create({
    data: { companyId: empresaId, name: "Instalação EV" },
  });
  await prisma.checklistTemplate.create({
    data: {
      companyId: empresaId,
      serviceOrderTypeId: tipo.id,
      name: "Checklist EV-1",
      items: {
        create: [
          { companyId: empresaId, label: "Cabo testado?", type: "BOOLEAN", required: true, sortOrder: 0 },
          { companyId: empresaId, label: "Potência óptica (dBm)", type: "NUMBER", sortOrder: 1 },
          {
            companyId: empresaId,
            label: "Foto da ONU",
            type: "PHOTO",
            required: true,
            evidenceCategory: "ONU_ONT",
            sortOrder: 2,
          },
        ],
      },
    },
  });

  const cliente = await prisma.customer.create({
    data: {
      companyId: empresaId,
      name: NOME_CLIENTE,
      address: "Rua das Fibras",
      number: "100",
      city: "Manaus",
      state: "AM",
    },
  });
  // O número vem do contador da empresa, nunca de um literal (DEV-DATA-01).
  const concluida = await prisma.serviceOrder.create({
    data: {
      companyId: empresaId,
      number: await allocateServiceOrderNumber(prisma, empresaId),
      customerId: cliente.id,
      technicianId: tecnico.id,
      type: "Instalação EV",
      subtype: "Fibra",
      typeId: tipo.id,
      description: "QA EV",
      status: "ASSIGNED",
      assignedAt: new Date(),
    },
  });
  concluidaId = concluida.id;
  concluidaNumero = concluida.number;
  emAtendimentoId = (
    await prisma.serviceOrder.create({
      data: {
        companyId: empresaId,
        number: await allocateServiceOrderNumber(prisma, empresaId),
        customerId: cliente.id,
        technicianId: tecnico.id,
        type: "Instalação EV",
        description: "QA EV em atendimento",
        status: "IN_PROGRESS",
        assignedAt: new Date(),
        startedAt: new Date(),
      },
    })
  ).id;

  const baseURL = testInfo.project.use.baseURL;
  const api = await playwright.request.newContext({ baseURL });
  const admin = await playwright.request.newContext({ baseURL });
  try {
    await atendimento(api, admin, concluida.id, concluida.version, tecnico.id);
  } finally {
    await api.dispose();
    await admin.dispose();
  }

  const etiqueta = await prisma.serviceOrderEquipment.findFirstOrThrow({
    where: { companyId: empresaId, serviceOrderId: concluidaId },
    select: { labelEvidenceId: true },
  });
  etiquetaId = etiqueta.labelEvidenceId ?? "";
  fotoCtoId = (
    await prisma.serviceOrderEvidence.findFirstOrThrow({
      where: { companyId: empresaId, serviceOrderId: concluidaId, category: "CTO" },
      select: { id: true },
    })
  ).id;
});

test.afterAll(async () => {
  // Os arquivos de verdade: as rotas do Field gravaram no storage do app.
  const raiz = path.resolve(__dirname, "..", process.env.STORAGE_ROOT ?? ".storage");
  for (const companyId of [empresaId, outraEmpresaId].filter(Boolean)) {
    const pasta = path.resolve(raiz, companyId);
    if (pasta.startsWith(raiz + path.sep) && /^[a-z0-9]+$/.test(companyId)) {
      await fs.rm(pasta, { recursive: true, force: true });
    }
  }

  // Por ESCOPO, na ordem das FKs `Restrict`. Nada fora das duas empresas.
  for (const companyId of [empresaId, outraEmpresaId].filter(Boolean)) {
    const w = { where: { companyId } };
    await prisma.serviceOrderEquipment.deleteMany(w);
    await prisma.serviceOrderMaterialUsage.deleteMany(w);
    await prisma.inventoryMovement.deleteMany(w);
    await prisma.inventoryItem.deleteMany(w);
    await prisma.serviceOrderCompletion.deleteMany(w);
    await prisma.serviceOrderCheckIn.deleteMany(w);
    await prisma.serviceOrderContactAttempt.deleteMany(w);
    await prisma.serviceOrderImpediment.deleteMany(w);
    await prisma.serviceOrderChecklistItem.deleteMany(w);
    await prisma.serviceOrderEvidence.deleteMany(w);
    await prisma.serviceOrderSignature.deleteMany(w);
    await prisma.serviceOrderExecution.deleteMany(w);
    await prisma.serviceOrderEvent.deleteMany(w);
    await prisma.customerLocationHistory.deleteMany(w);
    await prisma.customerLocation.deleteMany(w);
    await prisma.technicianDispatchQueueEntry.deleteMany(w);
    await prisma.technicianDispatchQueue.deleteMany(w);
    await prisma.serviceOrder.deleteMany(w);
    await prisma.checklistTemplateItem.deleteMany(w);
    await prisma.checklistTemplate.deleteMany(w);
    await prisma.serviceOrderType.deleteMany(w);
    await prisma.customer.deleteMany(w);
    await prisma.idempotencyRecord.deleteMany(w);
    await prisma.notification.deleteMany(w);
    await prisma.outboxEvent.deleteMany(w);
    await prisma.mobileDevice.deleteMany(w);
    await prisma.technician.deleteMany(w);
    await prisma.auditLog.deleteMany(w);
    await prisma.user.deleteMany(w);
    await prisma.company.delete({ where: { id: companyId } });
  }
  await prisma.loginAttempt.deleteMany({ where: { email: { in: EMAILS } } });
  await prisma.$disconnect();
});

let chaveSeq = 0;
const chave = (passo: string) => `qa-ev1-${passo}-${++chaveSeq}-${Date.now()}`;

type Dados = Record<string, unknown>;

async function campo(
  api: APIRequestContext,
  token: string,
  method: "GET" | "POST" | "PUT",
  url: string,
  corpo: { data?: unknown; multipart?: Record<string, string | { name: string; mimeType: string; buffer: Buffer }> } = {},
): Promise<Dados> {
  const res = await api.fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(method === "GET" ? {} : { "Idempotency-Key": chave(method.toLowerCase()) }),
    },
    ...corpo,
  });
  const body = (await res.json().catch(() => null)) as { ok?: boolean; data?: Dados } | null;
  if (!res.ok() || !body?.ok) {
    throw new Error(`${method} ${url} → ${res.status()} ${JSON.stringify(body)}`);
  }
  return body.data ?? {};
}

/** O atendimento inteiro, pelas rotas do Field e pelo estoque do ADMIN. */
async function atendimento(
  api: APIRequestContext,
  admin: APIRequestContext,
  orderId: string,
  versaoInicial: number,
  technicianId: string,
) {
  const login = await api.post("/api/field/v1/auth/login", {
    data: {
      email: EMAIL_TECNICO,
      password: SENHA,
      device: { platform: "ANDROID", installationId: `qa-ev1-${orderId.slice(-10)}` },
    },
  });
  const token = ((await login.json()) as { data: { token: string } }).data.token;
  const base = `/api/field/v1/service-orders/${orderId}`;

  const iniciada = await campo(api, token, "POST", `${base}/start`, {
    data: { expectedVersion: versaoInicial },
  });
  const versaoExecucao = (iniciada.execution as { version: number }).version;

  let bundle: Dados = {};
  const reler = async () => {
    bundle = await campo(api, token, "GET", `${base}/execution`);
  };
  const versao = () => bundle.version as number;
  await reler();

  await campo(api, token, "POST", `${base}/location/correct`, {
    data: {
      expectedVersion: null,
      reason: "INCOMPLETE_REGISTRATION",
      ...PONTO,
      accuracyMeters: 8,
      source: "TECHNICIAN_GPS",
    },
  });
  await reler();
  await campo(api, token, "POST", `${base}/check-in`, {
    data: { expectedVersion: versao(), ...CHECKIN, accuracyMeters: 12 },
  });
  await reler();

  const itens = bundle.checklist as { id: string; label: string }[];
  for (const [label, resposta] of [
    ["Cabo testado?", { valueBoolean: true }],
    ["Potência óptica (dBm)", { valueNumber: -18.5 }],
  ] as const) {
    const item = itens.find((i) => i.label === label);
    if (!item) throw new Error(`checklist sem o item ${label}`);
    await campo(api, token, "POST", `${base}/checklist/${item.id}`, {
      data: { expectedVersion: versao(), ...resposta },
    });
    await reler();
  }

  const foto = async (
    category: keyof typeof DIMENSAO,
    caption?: string,
  ): Promise<string> => {
    const [w, h] = DIMENSAO[category];
    const criada = await campo(api, token, "POST", `${base}/evidence`, {
      multipart: {
        file: { name: `${category.toLowerCase()}.png`, mimeType: "image/png", buffer: montarPngReal(w, h) },
        expectedOrderVersion: String(versao()),
        category,
        ...(caption ? { caption } : {}),
      },
    });
    await reler();
    return (criada.evidence as { id: string }).id;
  };
  await foto("CTO", "Caixa identificada no poste");
  await foto("ONU_ONT");
  await foto("SPEED_TEST");
  await foto("OPTICAL_READING");

  const etiqueta = await foto("EQUIPMENT_LABEL");
  await campo(api, token, "POST", `${base}/equipment`, {
    data: {
      expectedVersion: versao(),
      equipmentType: "ONU",
      manufacturer: "Fabricante QA",
      model: "MODELO-EV",
      serial: "SERIEQAEV01",
      macAddress: "aa:bb:cc:dd:ee:01",
      labelEvidenceId: etiqueta,
    },
  });
  await reler();

  // O saldo do técnico só nasce por entrega do ADMIN — o Field não cria estoque.
  const entrou = await admin.post("/api/auth/login", {
    data: { email: EMAIL_ADMIN, password: SENHA },
  });
  if (!entrou.ok()) throw new Error(`login do ADMIN → ${entrou.status()}`);
  const item = await admin.post("/api/inventory/items", {
    data: { code: "QA-EV-CABO", name: MATERIAL, unit: "METER" },
  });
  const itemId = ((await item.json()) as { data: { item: { id: string } } }).data.item.id;
  const entrega = await admin.post("/api/inventory/movements", {
    data: { type: "WAREHOUSE_TO_TECHNICIAN", itemId, technicianId, quantity: 100 },
  });
  if (!entrega.ok()) throw new Error(`entrega de material → ${entrega.status()}`);
  await campo(api, token, "POST", `${base}/materials`, {
    data: { expectedVersion: versao(), itemId, quantity: 35.5 },
  });
  await reler();

  await campo(api, token, "POST", `${base}/execution`, {
    data: {
      expectedVersion: versaoExecucao,
      diagnosis: DIAGNOSTICO,
      workPerformed: SERVICO,
      notes: "Cliente orientado sobre o roteador.",
    },
  });
  await reler();

  const [aw, ah] = DIMENSAO.ASSINATURA;
  await campo(api, token, "PUT", `${base}/signature`, {
    multipart: {
      file: { name: "assinatura.png", mimeType: "image/png", buffer: montarPngReal(aw, ah) },
      expectedOrderVersion: String(versao()),
      signerName: ASSINANTE,
    },
  });
  await reler();

  await campo(api, token, "POST", `${base}/complete`, {
    data: { expectedVersion: versao(), expectedExecutionVersion: bundle.executionVersion as number },
  });
}

async function entrar(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Senha").fill(SENHA);
  await page.getByRole("button", { name: "Entrar" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
}

const pacoteUrl = () => `/ordens/${concluidaId}/pacote`;

/** A imagem ABRIU: decodificada, com a dimensão da foto que foi enviada. */
async function dimensaoAberta(page: Page, seletor: string): Promise<[number, number]> {
  const img = page.locator(seletor).first();
  await img.scrollIntoViewIfNeeded();
  await expect
    .poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0))
    .toBe(true);
  return img.evaluate((el: HTMLImageElement) => [el.naturalWidth, el.naturalHeight] as [number, number]);
}

async function semRolagemHorizontal(page: Page) {
  const { rolagem, janela } = await page.evaluate(() => ({
    rolagem: document.documentElement.scrollWidth,
    janela: window.innerWidth,
  }));
  expect(rolagem).toBeLessThanOrEqual(janela);
}

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

function contraste(a: string, b: string): number {
  const [x, y] = [luminancia(a), luminancia(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

async function contrasteDaLinha(page: Page, testId: string) {
  return page.getByTestId(testId).evaluate((el) => {
    const titulo = el.querySelector("span.block") as HTMLElement;
    return { cor: getComputedStyle(titulo).color, fundo: getComputedStyle(el).backgroundColor };
  });
}

test.describe("EV-1 — pacote técnico", () => {
  test("EV-E2E-01 — o ADMIN abre a OS concluída, abre o pacote e confere o atendimento", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await entrar(page, EMAIL_ADMIN);

    // Pela listagem, como o operador faz.
    await page.goto("/ordens");
    await page.getByRole("link", { name: `Nº ${concluidaNumero}`, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/ordens/${concluidaId}$`));
    await page.getByTestId("evidence-package-link").click();
    await expect(page).toHaveURL(new RegExp(`/ordens/${concluidaId}/pacote$`));

    await expect(page.getByRole("heading", { level: 1, name: "Pacote técnico" })).toBeVisible();
    await expect(page.getByText(`OS Nº ${concluidaNumero} · Instalação EV · Fibra`)).toBeVisible();

    // Cliente e técnico.
    await expect(page.getByTestId("package-customer")).toContainText(NOME_CLIENTE);
    await expect(page.getByTestId("package-customer")).toContainText("Rua das Fibras");
    await expect(page.getByTestId("package-technician")).toContainText(NOME_TECNICO);

    // A conferência vem do hash do fechamento, nas duas pontas.
    await expect(page.getByTestId("package-integrity-content")).toHaveAttribute("data-tone", "ok");
    await expect(page.getByTestId("package-integrity-signature")).toHaveAttribute("data-tone", "ok");

    // Hora no fuso da EMPRESA, não no do servidor.
    const os = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: concluidaId },
      select: { completedAt: true },
    });
    const noFuso = (timeZone: string, comData: boolean) =>
      new Intl.DateTimeFormat("pt-BR", {
        timeZone,
        ...(comData ? { day: "2-digit", month: "2-digit", year: "numeric" } : {}),
        hour: "2-digit",
        minute: "2-digit",
      }).format(os.completedAt!);
    const fusoServidor = Intl.DateTimeFormat().resolvedOptions().timeZone;
    // Pré-requisito: os dois fusos dão horas diferentes, senão nada se prova.
    expect(noFuso(FUSO_EMPRESA, false)).not.toBe(noFuso(fusoServidor, false));
    await expect(page.getByTestId("package-completed-at").locator("dd")).toHaveText(noFuso(FUSO_EMPRESA, true));
    const conclusao = page
      .getByTestId("package-times")
      .locator("div", { has: page.locator("dt", { hasText: /^Conclusão$/ }) })
      .locator("dd");
    await expect(conclusao).toHaveText(noFuso(FUSO_EMPRESA, false));

    // Check-in com contexto humano, sem coordenada.
    const checkin = page.getByTestId("package-checkin");
    await expect(checkin).toContainText("com GPS do aparelho");
    await expect(checkin).toContainText(/A \d+ m do ponto cadastrado/);
    await expect(checkin).toContainText("Precisão do GPS: 12 m");
    await expect(page.getByTestId("package-location-changes").locator("li")).toHaveCount(1);

    // Relatório.
    const relatorio = page.getByTestId("package-report");
    await expect(relatorio).toContainText(DIAGNOSTICO);
    await expect(relatorio).toContainText(SERVICO);

    // Checklist: as respostas, e a foto obrigatória satisfeita pela categoria.
    const checklist = page.getByTestId("package-checklist-item");
    await expect(checklist).toHaveCount(3);
    await expect(checklist.filter({ hasText: "Cabo testado?" })).toContainText("Sim");
    await expect(checklist.filter({ hasText: "Potência óptica" })).toContainText("-18,5");
    await expect(checklist.filter({ hasText: "Foto da ONU" })).toContainText("Foto anexada");

    // Fotos: medições e etiqueta NÃO repetem na galeria.
    const fotos = page.getByTestId("package-photos").getByTestId("package-photo");
    await expect(fotos).toHaveCount(2);
    await expect(page.getByTestId("package-photos").locator('[data-category="CTO"]')).toHaveCount(1);
    await expect(page.getByTestId("package-photos").locator('[data-category="ONU_ONT"]')).toHaveCount(1);
    await expect(page.getByTestId("package-photos")).toContainText("Caixa identificada no poste");
    await expect(page.getByTestId("package-photos").locator('[data-category="EQUIPMENT_LABEL"]')).toHaveCount(0);
    await expect(page.getByTestId("package-speed-tests").getByTestId("package-photo")).toHaveCount(1);
    await expect(page.getByTestId("package-optical-readings").getByTestId("package-photo")).toHaveCount(1);

    // Equipamento, com a etiqueta ao lado dele.
    const equipamento = page.getByTestId("package-equipment");
    await expect(equipamento).toHaveCount(1);
    await expect(equipamento).toContainText("ONU");
    // Série e MAC como o domínio GRAVOU (normalizados), não como foram digitados.
    const gravado = await prisma.serviceOrderEquipment.findFirstOrThrow({
      where: { companyId: empresaId, serviceOrderId: concluidaId },
      select: { serial: true, macAddress: true },
    });
    await expect(equipamento).toContainText(`Série: ${gravado.serial}`);
    await expect(equipamento).toContainText(`MAC: ${gravado.macAddress}`);

    // Material e assinatura.
    await expect(page.getByTestId("package-materials")).toContainText(MATERIAL);
    await expect(page.getByTestId("package-materials")).toContainText("35,5 m");
    await expect(page.getByTestId("package-signature")).toContainText(ASSINANTE);
    await expect(page.getByTestId("package-signature")).toContainText(`coletada por ${NOME_TECNICO}`);

    // Cada imagem ABRE, e é a foto da própria categoria.
    const pares: [string, readonly [number, number]][] = [
      ['[data-testid="package-photos"] [data-category="CTO"] img', DIMENSAO.CTO],
      ['[data-testid="package-photos"] [data-category="ONU_ONT"] img', DIMENSAO.ONU_ONT],
      ['[data-testid="package-speed-tests"] img', DIMENSAO.SPEED_TEST],
      ['[data-testid="package-optical-readings"] img', DIMENSAO.OPTICAL_READING],
      ['[data-testid="package-equipment"] img', DIMENSAO.EQUIPMENT_LABEL],
      ['[data-testid="package-signature"] img', DIMENSAO.ASSINATURA],
    ];
    for (const [seletor, esperado] of pares) {
      expect(await dimensaoAberta(page, seletor), seletor).toEqual([...esperado]);
    }

    // Volta para a OS de onde veio.
    await page.getByTestId("evidence-package-back").click();
    await expect(page).toHaveURL(new RegExp(`/ordens/${concluidaId}$`));
  });

  test("EV-E2E-02 — o HTML não carrega coordenada nem chave de storage", async ({ page }) => {
    await entrar(page, EMAIL_ADMIN);
    const res = await page.request.get(pacoteUrl());
    expect(res.status()).toBe(200);
    const html = await res.text();
    expect(html).toContain(NOME_CLIENTE);

    for (const valor of [PONTO.latitude, PONTO.longitude, CHECKIN.latitude, CHECKIN.longitude]) {
      expect(html).not.toContain(String(valor));
    }
    const chaves = await prisma.serviceOrderEvidence.findMany({
      where: { companyId: empresaId, serviceOrderId: concluidaId },
      select: { storageKey: true },
    });
    const assinatura = await prisma.serviceOrderSignature.findUniqueOrThrow({
      where: { serviceOrderId: concluidaId },
      select: { storageKey: true },
    });
    expect(chaves.length).toBe(5);
    for (const { storageKey } of [...chaves, assinatura]) {
      expect(html).not.toContain(storageKey);
      expect(html).not.toContain(path.basename(storageKey));
    }
  });

  test("EV-E2E-03 — o arquivo segue a regra da OS: dono e empresa abrem; o resto recebe 404 ou 401", async ({
    page,
    browser,
  }) => {
    const foto = `/api/service-orders/${concluidaId}/evidence/${fotoCtoId}/content`;
    const etiqueta = `/api/service-orders/${concluidaId}/evidence/${etiquetaId}/content`;
    const assinatura = `/api/service-orders/${concluidaId}/signature`;

    await entrar(page, EMAIL_ADMIN);
    for (const url of [foto, etiqueta, assinatura]) {
      const res = await page.request.get(url);
      expect(res.status(), url).toBe(200);
      expect(res.headers()["content-type"]).toBe("image/png");
      expect(res.headers()["x-content-type-options"]).toBe("nosniff");
      expect(res.headers()["cache-control"]).toContain("no-store");
      expect(res.headers()["content-disposition"]).toMatch(/^attachment/);
    }

    const como = async (email: string) => {
      const ctx = await browser.newContext();
      const p = await ctx.newPage();
      await entrar(p, email);
      return { ctx, p };
    };

    // Outro técnico da MESMA empresa: nem a página, nem o arquivo.
    const outro = await como(EMAIL_OUTRO_TECNICO);
    expect((await outro.p.goto(pacoteUrl()))?.status()).toBe(404);
    for (const url of [foto, assinatura]) {
      expect((await outro.p.request.get(url)).status(), url).toBe(404);
    }
    await outro.ctx.close();

    // ADMIN de OUTRA empresa: 404, nunca 403.
    const outraEmpresa = await como(EMAIL_ADMIN_OUTRA);
    expect((await outraEmpresa.p.goto(pacoteUrl()))?.status()).toBe(404);
    for (const url of [foto, etiqueta, assinatura]) {
      expect((await outraEmpresa.p.request.get(url)).status(), url).toBe(404);
    }
    await outraEmpresa.ctx.close();

    // Sem sessão: 401 no arquivo; a página manda para o login.
    const anonimo = await browser.newContext();
    const pa = await anonimo.newPage();
    expect((await pa.request.get(foto)).status()).toBe(401);
    await pa.goto(pacoteUrl());
    await expect(pa).toHaveURL(/\/login/);
    await anonimo.close();

    // Controle positivo: o técnico DONO e o despacho abrem.
    const dono = await como(EMAIL_TECNICO);
    await dono.p.goto(pacoteUrl());
    await expect(dono.p.getByTestId("package-summary")).toBeVisible();
    expect((await dono.p.request.get(foto)).status()).toBe(200);
    await dono.ctx.close();
    const despacho = await como(EMAIL_DESPACHO);
    await despacho.p.goto(pacoteUrl());
    await expect(despacho.p.getByTestId("package-summary")).toBeVisible();
    expect((await despacho.p.request.get(assinatura)).status()).toBe(200);
    await despacho.ctx.close();
  });

  test("EV-E2E-04 — OS em atendimento: sem botão na OS e a página diz que o pacote ainda não existe", async ({
    page,
  }) => {
    await entrar(page, EMAIL_ADMIN);
    await page.goto(`/ordens/${emAtendimentoId}`);
    await expect(page.getByTestId("evidence-package-link")).toHaveCount(0);

    await page.goto(`/ordens/${emAtendimentoId}/pacote`);
    await expect(page.getByTestId("evidence-package-not-completed")).toContainText(
      "O atendimento ainda não foi concluído.",
    );
    await expect(page.getByTestId("package-summary")).toHaveCount(0);
    await expect(page.getByTestId("package-photos")).toHaveCount(0);
  });

  test("EV-E2E-05 — celular 375 e desktops 1280/1366/1440: sem rolagem horizontal", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await entrar(page, EMAIL_TECNICO);
    await page.goto(pacoteUrl());
    await expect(page.getByTestId("package-signature")).toBeVisible();
    await semRolagemHorizontal(page);
    // A foto cabe na tela do celular.
    const largura = await page
      .getByTestId("package-photos")
      .locator("img")
      .first()
      .evaluate((el) => el.getBoundingClientRect().width);
    expect(largura).toBeLessThanOrEqual(375);
    expect(await dimensaoAberta(page, '[data-testid="package-equipment"] img')).toEqual([
      ...DIMENSAO.EQUIPMENT_LABEL,
    ]);

    for (const width of [1280, 1366, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(pacoteUrl());
      await expect(page.getByTestId("package-signature")).toBeVisible();
      await semRolagemHorizontal(page);
    }
  });

  test("EV-E2E-06 — a conferência é legível nos dois temas", async ({ browser }) => {
    for (const colorScheme of ["light", "dark"] as const) {
      const ctx = await browser.newContext({ colorScheme });
      const page = await ctx.newPage();
      await entrar(page, EMAIL_ADMIN);
      await page.goto(pacoteUrl());
      for (const testId of ["package-integrity-content", "package-integrity-signature"]) {
        const { cor, fundo } = await contrasteDaLinha(page, testId);
        expect(contraste(cor, fundo), `${colorScheme} ${testId}: ${cor} sobre ${fundo}`).toBeGreaterThanOrEqual(4.5);
      }
      await ctx.close();
    }
  });
});
