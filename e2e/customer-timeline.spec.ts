import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { assertTestDatabase } from "./test-db-guard";

/**
 * # TL-1 — Histórico do cliente, pelo navegador
 *
 * Uma empresa sintética em `America/Manaus` — uma hora atrás de São Paulo, o
 * fuso da máquina. Os fatos principais acontecem às 03:30 UTC: 23:30 do dia
 * ANTERIOR em Manaus, 00:30 do dia seguinte em São Paulo. Se a tela voltar a
 * formatar no fuso do servidor, o dia e a hora mudam, e a spec vê.
 *
 * Mais de 50 registros para o cliente completo, então "Ver eventos anteriores"
 * existe; um cliente sem nenhum registro, para o estado vazio; e três perfis,
 * porque CTO e porta são só do ADMIN e o técnico não tem tela de cliente.
 */

const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgresql://alfaos:alfaos_dev_password@localhost:5432/alfaos_test?schema=public";

const prisma = new PrismaClient({
  datasources: { db: { url: E2E_DATABASE_URL } },
});

const SENHA = "AlfaOS@2026";
const EMAIL_ADMIN = "qa.tl.admin@sintetico.local";
const EMAIL_DESPACHO = "qa.tl.despacho@sintetico.local";
const EMAIL_TECNICO = "qa.tl.tecnico@sintetico.local";
const FUSO_EMPRESA = "America/Manaus";
const FUSO_SERVIDOR = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** 03:30 UTC de 01/09: 23:30 de 31/08 em Manaus. */
const BASE = Date.UTC(2026, 8, 1, 3, 30);
const t = (minutos: number) => new Date(BASE + minutos * 60_000);
/** Os fatos do atendimento: 15 itens (três fotos viram um). */
const PRINCIPAIS = 15;
const ENCHIMENTO = 60;

let empresaId = "";
let clienteId = "";
let vazioId = "";
let os1Id = "";
let ctoId = "";

test.beforeAll(async () => {
  await assertTestDatabase(E2E_DATABASE_URL, "E2E_DATABASE_URL");

  const bcrypt = (await import("bcryptjs")).default;
  const hash = bcrypt.hashSync(SENHA, 10);
  const empresa = await prisma.company.create({
    data: { name: "TL-1 Sintetica", timezone: FUSO_EMPRESA, ctoNetworkEnabled: true },
  });
  empresaId = empresa.id;
  const usuario = (email: string, name: string, profile: "ADMIN" | "DISPATCHER" | "TECHNICIAN") =>
    prisma.user.create({ data: { companyId: empresaId, email, name, profile, passwordHash: hash } });
  const admin = await usuario(EMAIL_ADMIN, "QA TL Admin", "ADMIN");
  await usuario(EMAIL_DESPACHO, "QA TL Despacho", "DISPATCHER");
  const userTecnico = await usuario(EMAIL_TECNICO, "QA TL Técnico", "TECHNICIAN");
  const tecnico = await prisma.technician.create({
    data: { companyId: empresaId, userId: userTecnico.id },
  });

  const cliente = await prisma.customer.create({
    data: { companyId: empresaId, name: "QA TL Cliente Completo" },
  });
  clienteId = cliente.id;
  vazioId = (
    await prisma.customer.create({ data: { companyId: empresaId, name: "QA TL Cliente Vazio" } })
  ).id;

  const ordem = (numero: number, subtype: string | null) =>
    prisma.serviceOrder.create({
      data: {
        companyId: empresaId,
        number: numero,
        customerId: clienteId,
        technicianId: tecnico.id,
        type: "Instalação",
        subtype,
        description: "QA TL",
        status: "COMPLETED",
        startedAt: t(2),
        completedAt: t(10),
      },
    });
  const os1 = await ordem(9301, "Fibra");
  const os2 = await ordem(9302, null);
  os1Id = os1.id;

  const evento = (serviceOrderId: string, event: string, minuto: number, extra: object = {}) =>
    prisma.serviceOrderEvent.create({
      data: {
        companyId: empresaId,
        serviceOrderId,
        userId: admin.id,
        event,
        createdAt: t(minuto),
        ...extra,
      },
    });
  await evento(os1.id, "SERVICE_ORDER_CREATED", 0);
  await evento(os1.id, "TECHNICIAN_ASSIGNED", 1, {
    metadata: { technicianName: "QA TL Técnico" },
  });
  await evento(os1.id, "OS_STARTED", 2, { userId: userTecnico.id });
  await prisma.serviceOrderCheckIn.create({
    data: {
      companyId: empresaId,
      serviceOrderId: os1.id,
      technicianId: tecnico.id,
      source: "DEVICE_GPS",
      checkedInAt: t(3),
    },
  });
  for (const [minuto, category] of [
    [4, "CTO"],
    [5, "ONU_ONT"],
    [6, "ONU_ONT"],
    [7, "SPEED_TEST"],
  ] as const) {
    await prisma.serviceOrderEvidence.create({
      data: {
        companyId: empresaId,
        serviceOrderId: os1.id,
        uploadedByUserId: userTecnico.id,
        category,
        storageKey: `qa-tl-e2e/${empresaId}/${minuto}.jpg`,
        originalName: "qa.jpg",
        mimeType: "image/jpeg",
        sizeBytes: 10,
        createdAt: t(minuto),
      },
    });
  }
  await prisma.serviceOrderSignature.create({
    data: {
      companyId: empresaId,
      serviceOrderId: os1.id,
      signerName: "QA TL Assinante",
      storageKey: `qa-tl-e2e/${empresaId}/assinatura.png`,
      mimeType: "image/png",
      sizeBytes: 10,
      signedAt: t(8),
      capturedByUserId: userTecnico.id,
    },
  });
  await prisma.serviceOrderEquipment.create({
    data: {
      companyId: empresaId,
      serviceOrderId: os1.id,
      customerId: clienteId,
      equipmentType: "ONU",
      manufacturer: "Huawei",
      model: "HG8245",
      installedByUserId: userTecnico.id,
      createdAt: t(9),
    },
  });
  await evento(os1.id, "OS_COMPLETED", 10, { userId: userTecnico.id });
  await prisma.serviceOrderExecution.create({
    data: {
      companyId: empresaId,
      serviceOrderId: os1.id,
      notes: "Cliente pediu retorno no sábado para organizar os cabos da sala.",
    },
  });

  const cto = await prisma.cTO.create({
    data: { companyId: empresaId, name: "QA TL CTO Centro", capacity: 8 },
  });
  ctoId = cto.id;
  await prisma.cTOPort.createMany({
    data: Array.from({ length: 8 }, (_, i) => ({ ctoId, companyId: empresaId, number: i + 1 })),
  });
  const porta2 = await prisma.cTOPort.findFirstOrThrow({ where: { ctoId, number: 2 } });
  await prisma.customerNetworkConnection.create({
    data: {
      companyId: empresaId,
      customerId: clienteId,
      ctoPortId: porta2.id,
      source: "WEB",
      connectedAt: t(11),
      disconnectedAt: t(12),
      reason: "Cliente suspenso",
    },
  });
  await prisma.customerNetworkConnection.create({
    data: {
      companyId: empresaId,
      customerId: clienteId,
      ctoPortId: porta2.id,
      source: "WEB",
      connectedAt: t(13),
    },
  });
  await prisma.customerLocationHistory.create({
    data: {
      companyId: empresaId,
      customerId: clienteId,
      serviceOrderId: os1.id,
      kind: "COORDINATES",
      reason: "INCORRECT_LOCATION",
      previousLatitude: -3.1,
      previousLongitude: -60.02,
      newLatitude: -3.11,
      newLongitude: -60.03,
      newSource: "TECHNICIAN_GPS",
      newVerified: true,
      changedByUserId: userTecnico.id,
      technicianId: tecnico.id,
      createdAt: t(14),
    },
  });

  await evento(os2.id, "SERVICE_ORDER_CREATED", 15);
  await prisma.serviceOrderImpediment.create({
    data: {
      companyId: empresaId,
      serviceOrderId: os2.id,
      technicianId: tecnico.id,
      reason: "NO_ACCESS",
      reportedAt: t(16),
    },
  });
  // Enchimento: registros mais antigos, para existir "Ver eventos anteriores".
  await prisma.serviceOrderContactAttempt.createMany({
    data: Array.from({ length: ENCHIMENTO }, (_, i) => ({
      companyId: empresaId,
      serviceOrderId: os2.id,
      technicianId: tecnico.id,
      channel: "PHONE_CALL" as const,
      result: "NO_ANSWER" as const,
      attemptedAt: t(-(i + 1) * 10),
    })),
  });
});

test.afterAll(async () => {
  if (empresaId) {
    const w = { where: { companyId: empresaId } };
    await prisma.customerNetworkConnection.deleteMany(w);
    await prisma.cTOPort.deleteMany(w);
    await prisma.cTO.deleteMany(w);
    await prisma.serviceOrderEquipment.deleteMany(w);
    await prisma.serviceOrderEvidence.deleteMany(w);
    await prisma.serviceOrderSignature.deleteMany(w);
    await prisma.serviceOrderCheckIn.deleteMany(w);
    await prisma.serviceOrderContactAttempt.deleteMany(w);
    await prisma.serviceOrderImpediment.deleteMany(w);
    await prisma.serviceOrderExecution.deleteMany(w);
    await prisma.customerLocationHistory.deleteMany(w);
    await prisma.serviceOrderEvent.deleteMany(w);
    await prisma.serviceOrder.deleteMany(w);
    await prisma.customer.deleteMany(w);
    await prisma.technician.deleteMany(w);
    await prisma.auditLog.deleteMany(w);
    await prisma.user.deleteMany(w);
    await prisma.company.delete({ where: { id: empresaId } });
  }
  await prisma.$disconnect();
});

async function entrar(page: Page, email: string, destino: RegExp) {
  await page.goto("/login");
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Senha").fill(SENHA);
  await page.getByRole("button", { name: "Entrar" }).click();
  await page.waitForURL(destino);
}

/** Pela listagem, como o operador faz — não por URL digitada. */
async function abrirCliente(page: Page, nome: string) {
  await page.goto("/clientes");
  await page.locator("table tbody tr", { hasText: nome }).getByRole("link", { name: "Editar" }).click();
  await expect(page).toHaveURL(/\/clientes\/[^/]+\/editar/);
}

const secao = (page: Page) => page.getByTestId("customer-timeline");
const itens = (page: Page) => secao(page).getByTestId("timeline-item");

async function lerItens(page: Page) {
  return itens(page).evaluateAll((els) =>
    els.map((el) => ({
      id: el.getAttribute("data-item-id") ?? "",
      kind: el.getAttribute("data-kind") ?? "",
      instante: el.querySelector("time")?.getAttribute("datetime") ?? "",
    })),
  );
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

function contraste(frente: string, fundo: string): number {
  const a = luminancia(frente);
  const b = luminancia(fundo);
  const [claro, escuro] = a > b ? [a, b] : [b, a];
  return (claro + 0.05) / (escuro + 0.05);
}

test("TL-E2E-01 · fluxo do dono: histórico em ordem, OS pelo item, volta, e 'Ver eventos anteriores'", async ({ page }) => {
  expect(FUSO_SERVIDOR, "o cenário exige fusos diferentes").not.toBe(FUSO_EMPRESA);

  await test.step("1. login ADMIN", () => entrar(page, EMAIL_ADMIN, /\/dashboard/));

  await test.step("2. abrir o cliente pela listagem", () => abrirCliente(page, "QA TL Cliente Completo"));

  await test.step("3. a seção 'Histórico do cliente' existe, com 50 itens", async () => {
    await expect(secao(page).getByRole("heading", { name: "Histórico do cliente" })).toBeVisible();
    await expect(itens(page)).toHaveCount(50);
    await expect(secao(page).getByTestId("customer-timeline-error")).toHaveCount(0);
  });

  await test.step("4. do mais recente ao mais antigo, sem repetir", async () => {
    const lidos = await lerItens(page);
    for (let i = 1; i < lidos.length; i++) {
      expect(Date.parse(lidos[i - 1].instante)).toBeGreaterThanOrEqual(Date.parse(lidos[i].instante));
    }
    expect(new Set(lidos.map((l) => l.id)).size).toBe(lidos.length);
    expect(lidos.slice(0, 5).map((l) => l.kind)).toEqual([
      "IMPEDIMENT",
      "OS_CREATED",
      "LOCATION_CORRECTED",
      "NETWORK_CONNECTED",
      "NETWORK_DISCONNECTED",
    ]);
  });

  await test.step("5. hora e dia no fuso da empresa (03:40 UTC é 23:40 de 31/08 em Manaus)", async () => {
    const concluida = secao(page).locator('[data-kind="OS_COMPLETED"]');
    await expect(concluida.getByTestId("timeline-time")).toHaveText("23:40");
    await expect(secao(page).getByTestId("timeline-day").first()).toHaveText(
      /31 de agosto de 2026/i,
    );
  });

  await test.step("6. o conteúdo é humano: título, detalhe, autor, e nada de código cru", async () => {
    const concluida = secao(page).locator('[data-kind="OS_COMPLETED"]');
    await expect(concluida.getByTestId("timeline-title")).toHaveText("Atendimento concluído");
    await expect(concluida.getByTestId("timeline-description")).toContainText(
      "Observações: Cliente pediu retorno no sábado",
    );
    await expect(concluida.getByTestId("timeline-actor")).toHaveText("QA TL Técnico");
    const fotos = secao(page).locator('[data-kind="PHOTOS"]');
    await expect(fotos.getByTestId("timeline-title")).toHaveText("3 fotos do atendimento");
    await expect(fotos.getByTestId("timeline-description")).toHaveText("ONU / ONT (2) · CTO (1)");
    const saida = secao(page).locator('[data-kind="NETWORK_DISCONNECTED"]');
    await expect(saida.getByTestId("timeline-title")).toHaveText(
      "Desconectado da CTO QA TL CTO Centro · porta 2",
    );
    await expect(saida.getByTestId("timeline-description")).toHaveText(
      "Pelo painel · Motivo: Cliente suspenso",
    );
    await expect(secao(page).locator('[data-kind="NETWORK_CONNECTED"]')).toHaveCount(2);
    const texto = await secao(page).innerText();
    expect(texto).not.toMatch(/\b[A-Z]{2,}(?:_[A-Z0-9]+)+\b/);
    expect(texto).not.toMatch(/-3\.1|-60\.0/);
  });

  await test.step("7. abrir a OS pelo item", async () => {
    const link = secao(page).locator('[data-kind="OS_COMPLETED"]').getByTestId("timeline-order-link");
    await expect(link).toHaveText("OS Nº 9301 · Instalação · Fibra");
    await link.click();
    await expect(page).toHaveURL(new RegExp(`/ordens/${os1Id}$`));
  });

  await test.step("8. voltar ao cliente, com o histórico intacto", async () => {
    await page.goBack();
    await expect(page).toHaveURL(/\/clientes\/[^/]+\/editar/);
    await expect(itens(page)).toHaveCount(50);
  });

  await test.step("9. 'Ver eventos anteriores' continua de onde parou, sem pular nem repetir", async () => {
    const antes = await lerItens(page);
    const mais = secao(page).getByTestId("customer-timeline-more");
    await expect(mais).toHaveText("Ver eventos anteriores");
    await mais.click();
    await expect(page).toHaveURL(/historico=100#historico$/);
    await expect(itens(page)).toHaveCount(PRINCIPAIS + ENCHIMENTO);
    const depois = await lerItens(page);
    expect(depois.slice(0, 50).map((l) => l.id)).toEqual(antes.map((l) => l.id));
    expect(new Set(depois.map((l) => l.id)).size).toBe(depois.length);
    await expect(secao(page).getByTestId("customer-timeline-more")).toHaveCount(0);
    await expect(secao(page)).toBeInViewport();
  });

  await test.step("10. o link da CTO leva à caixa", async () => {
    const cto = secao(page).locator('[data-kind="NETWORK_CONNECTED"]').first().getByTestId("timeline-cto-link");
    await expect(cto).toHaveAttribute("href", `/ctos/${ctoId}`);
  });
});

test("TL-E2E-02 · cliente sem registro: mensagem humana, não erro", async ({ page }) => {
  await entrar(page, EMAIL_ADMIN, /\/dashboard/);
  await abrirCliente(page, "QA TL Cliente Vazio");
  const vazio = secao(page).getByTestId("customer-timeline-empty");
  await expect(vazio).toBeVisible();
  await expect(vazio).toContainText("Nenhum registro ainda");
  await expect(secao(page).getByRole("alert")).toHaveCount(0);
  await expect(itens(page)).toHaveCount(0);
  await expect(secao(page).getByTestId("customer-timeline-more")).toHaveCount(0);
});

test("TL-E2E-03 · DISPATCHER vê o histórico sem CTO e porta; TECHNICIAN não tem a tela", async ({ page }) => {
  await test.step("DISPATCHER", async () => {
    await entrar(page, EMAIL_DESPACHO, /\/dashboard/);
    await abrirCliente(page, "QA TL Cliente Completo");
    await expect(itens(page).first()).toBeVisible();
    await expect(secao(page).locator('[data-kind^="NETWORK_"]')).toHaveCount(0);
    await expect(secao(page).getByTestId("timeline-cto-link")).toHaveCount(0);
    await expect(secao(page).locator('[data-kind="OS_COMPLETED"]')).toHaveCount(1);
    await page.context().clearCookies();
  });

  await test.step("TECHNICIAN", async () => {
    await entrar(page, EMAIL_TECNICO, /\/minhas-os/);
    await page.goto(`/clientes/${clienteId}/editar`);
    await expect(page).toHaveURL(/\/minhas-os/);
    await expect(page.getByTestId("customer-timeline")).toHaveCount(0);
  });
});

test("TL-E2E-04 · contraste do texto da seção, no tema claro", async ({ page }) => {
  await entrar(page, EMAIL_ADMIN, /\/dashboard/);
  await page.goto(`/clientes/${clienteId}/editar`);
  const medidas = await secao(page).evaluate((el) => {
    const fundoDe = (n: Element | null): string => {
      for (let x = n; x; x = x.parentElement) {
        const bg = getComputedStyle(x).backgroundColor;
        if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") return bg;
      }
      return "rgb(255, 255, 255)";
    };
    const par = (sel: string) => {
      const alvo = el.querySelector(sel);
      if (!alvo) throw new Error("não achei " + sel);
      return { sel, frente: getComputedStyle(alvo).color, fundo: fundoDe(alvo) };
    };
    return [
      par('[data-kind="IMPEDIMENT"] [data-testid="timeline-category"]'),
      par('[data-kind="OS_COMPLETED"] [data-testid="timeline-category"]'),
      par('[data-kind="OS_COMPLETED"] [data-testid="timeline-title"]'),
      par('[data-kind="OS_COMPLETED"] [data-testid="timeline-description"]'),
      par('[data-kind="OS_COMPLETED"] [data-testid="timeline-actor"]'),
      par('[data-kind="OS_COMPLETED"] [data-testid="timeline-time"]'),
      par('[data-testid="timeline-day"]'),
      par('[data-kind="OS_COMPLETED"] [data-testid="timeline-order-link"]'),
    ];
  });
  for (const m of medidas) {
    expect(contraste(m.frente, m.fundo), `${m.sel}: ${m.frente} sobre ${m.fundo}`).toBeGreaterThanOrEqual(4.5);
  }
  // O impedimento é o único item com cor de aviso.
  const impedimento = medidas[0];
  const neutro = medidas[1];
  expect(impedimento.fundo).not.toBe(neutro.fundo);
});

for (const [largura, altura] of [
  [1440, 900],
  [1366, 768],
  [1280, 720],
  [375, 812],
] as const) {
  test(`TL-E2E-05 · ${largura}x${altura}: nada vaza para o lado`, async ({ page }) => {
    await page.setViewportSize({ width: largura, height: altura });
    await entrar(page, EMAIL_ADMIN, /\/dashboard/);
    await page.goto(`/clientes/${clienteId}/editar#historico`);
    await expect(itens(page).first()).toBeVisible();
    const medidas = await page.evaluate(() => {
      const secaoEl = document.querySelector('[data-testid="customer-timeline"]')!;
      const caixa = secaoEl.getBoundingClientRect();
      const itensEl = Array.from(secaoEl.querySelectorAll('[data-testid="timeline-item"]'));
      return {
        rolagemLateral: document.documentElement.scrollWidth - window.innerWidth,
        secaoDireita: caixa.right,
        largura: window.innerWidth,
        itemVazado: itensEl.some((i) => i.getBoundingClientRect().right > caixa.right + 0.5),
        textoVazado: itensEl.some((i) => i.scrollWidth > i.clientWidth + 1),
      };
    });
    expect(medidas.rolagemLateral).toBeLessThanOrEqual(0);
    expect(medidas.secaoDireita).toBeLessThanOrEqual(medidas.largura);
    expect(medidas.itemVazado).toBe(false);
    expect(medidas.textoVazado).toBe(false);
  });
}
