import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { assertTestDatabase } from "./test-db-guard";

/**
 * # DASH-1 — o painel operacional pela interface (PRD §380)
 *
 * O spec cria as PRÓPRIAS empresas sintéticas — uma com dados, uma vazia —,
 * então os números afirmados são exatos e não dependem do que outros specs
 * deixaram no banco. Duas afirmações centrais:
 *
 * 1. **o cartão leva à listagem filtrada, e a listagem mostra o mesmo número**
 *    — é o critério de teste do MASTER-PLAN §4;
 * 2. **a empresa vazia vê zero** enquanto a outra tem dado — o isolamento de
 *    tenant visto pela tela, não só pela consulta.
 *
 * O relógio do servidor é o real, então as fixtures são escolhidas para não
 * depender da hora em que a suíte roda: "atrasada" é de 30 dias atrás, e "de
 * hoje" é uma OS em atendimento agendada para AGORA — que é sempre hoje e,
 * por estar em atendimento, nunca é atrasada.
 */

const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgresql://alfaos:alfaos_dev_password@localhost:5432/alfaos_test?schema=public";

const prisma = new PrismaClient({
  datasources: { db: { url: E2E_DATABASE_URL } },
});

const SENHA = "AlfaOS@2026";
const EMAIL_ADMIN = "dash1.admin@sintetico.local";
const EMAIL_DESPACHO = "dash1.despacho@sintetico.local";
const EMAIL_VAZIA = "dash1.vazia@sintetico.local";

let empresaId = "";
let vaziaId = "";

test.beforeAll(async () => {
  await assertTestDatabase(E2E_DATABASE_URL, "E2E_DATABASE_URL");
  const bcrypt = (await import("bcryptjs")).default;
  const hash = bcrypt.hashSync(SENHA, 10);

  const empresa = await prisma.company.create({
    data: {
      name: "DASH-1 Sintetica",
      ctoNetworkEnabled: true,
      timezone: "America/Sao_Paulo",
    },
  });
  empresaId = empresa.id;
  const vazia = await prisma.company.create({
    data: {
      name: "DASH-1 Vazia",
      ctoNetworkEnabled: true,
      timezone: "America/Sao_Paulo",
    },
  });
  vaziaId = vazia.id;

  await prisma.user.createMany({
    data: [
      { companyId: empresaId, name: "Admin DASH", email: EMAIL_ADMIN, profile: "ADMIN", passwordHash: hash },
      { companyId: empresaId, name: "Despacho DASH", email: EMAIL_DESPACHO, profile: "DISPATCHER", passwordHash: hash },
      { companyId: vaziaId, name: "Admin Vazia", email: EMAIL_VAZIA, profile: "ADMIN", passwordHash: hash },
    ],
  });
  const tecnicoUser = await prisma.user.create({
    data: {
      companyId: empresaId,
      name: "Técnico DASH",
      email: "dash1.tecnico@sintetico.local",
      profile: "TECHNICIAN",
      passwordHash: hash,
    },
  });
  const tecnico = await prisma.technician.create({
    data: { companyId: empresaId, userId: tecnicoUser.id },
  });

  // Clientes: offline, online, sem leitura, e um inativo offline (não conta).
  const [offline, online, , inativo] = await Promise.all(
    ["Cliente Offline", "Cliente Online", "Cliente Sem Leitura", "Cliente Inativo"].map(
      (name, i) =>
        prisma.customer.create({
          data: { companyId: empresaId, name, active: i !== 3 },
        }),
    ),
  );
  const agora = new Date();
  for (const [cliente, status] of [
    [offline, "OFFLINE"],
    [online, "ONLINE"],
    [inativo, "OFFLINE"],
  ] as const) {
    await prisma.customerDiagnosticSnapshot.create({
      data: {
        companyId: empresaId,
        customerId: cliente.id,
        externalProvider: "MOCK",
        connectivityStatus: status,
        observedAt: agora,
        technology: "1",
      },
    });
  }

  // OS: atrasada (pendente há 30 dias), de hoje (em atendimento agora),
  // pendente sem agendamento, e uma concluída que não conta em nada.
  const trintaDias = new Date(agora.getTime() - 30 * 24 * 3_600_000);
  const ordens = [
    { status: "PENDING" as const, scheduledAt: trintaDias, technicianId: null, customerId: online.id },
    { status: "IN_PROGRESS" as const, scheduledAt: agora, technicianId: tecnico.id, customerId: online.id },
    { status: "PENDING" as const, scheduledAt: null, technicianId: null, customerId: offline.id },
    { status: "COMPLETED" as const, scheduledAt: trintaDias, technicianId: tecnico.id, customerId: online.id },
  ];
  for (let i = 0; i < ordens.length; i++) {
    const ordem = ordens[i];
    await prisma.serviceOrder.create({
      data: {
        companyId: empresaId,
        number: 810 + i,
        type: "INSTALACAO",
        description: "OS do painel",
        ...ordem,
        ...(ordem.status === "COMPLETED" ? { completedAt: agora } : {}),
      },
    });
  }

  // CTOs: uma com defeito e com o cliente offline (que tem OS aberta), uma sã.
  const comDefeito = await prisma.cTO.create({
    data: { companyId: empresaId, name: "CX DASH DEFEITO", capacity: 4 },
  });
  const sa = await prisma.cTO.create({
    data: { companyId: empresaId, name: "CX DASH SA", capacity: 4 },
  });
  for (const cto of [comDefeito, sa]) {
    await prisma.cTOPort.createMany({
      data: [1, 2, 3, 4].map((number) => ({
        companyId: empresaId,
        ctoId: cto.id,
        number,
        administrativeState: cto.id === comDefeito.id && number === 1 ? "DAMAGED" : "AVAILABLE",
      })),
    });
  }
  const porta2 = await prisma.cTOPort.findFirstOrThrow({
    where: { ctoId: comDefeito.id, number: 2 },
  });
  await prisma.customerNetworkConnection.create({
    data: {
      companyId: empresaId,
      customerId: offline.id,
      ctoPortId: porta2.id,
      source: "WEB",
      connectedAt: agora,
    },
  });
});

test.afterAll(async () => {
  // Por ESCOPO, na ordem das FKs `Restrict`. Nada fora das duas empresas.
  for (const companyId of [empresaId, vaziaId].filter(Boolean)) {
    await prisma.customerNetworkConnection.deleteMany({ where: { companyId } });
    await prisma.cTOPort.deleteMany({ where: { companyId } });
    await prisma.cTO.deleteMany({ where: { companyId } });
    await prisma.serviceOrder.deleteMany({ where: { companyId } });
    await prisma.customerDiagnosticSnapshot.deleteMany({ where: { companyId } });
    await prisma.customer.deleteMany({ where: { companyId } });
    await prisma.technician.deleteMany({ where: { companyId } });
    await prisma.auditLog.deleteMany({ where: { companyId } });
    await prisma.user.deleteMany({ where: { companyId } });
    await prisma.company.delete({ where: { id: companyId } });
  }
  await prisma.$disconnect();
});

async function entrar(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Senha").fill(SENHA);
  await page.getByRole("button", { name: "Entrar" }).click();
  await page.waitForURL(/\/dashboard/);
}

async function valorDoCartao(page: Page, chave: string): Promise<string> {
  return (await page.getByTestId(`dash-value-${chave}`).innerText()).trim();
}

/** A contagem que a tela de destino MOSTRA: a faixa do recorte, ou as linhas. */
async function contagemDoDestino(page: Page): Promise<number> {
  const faixa = page.getByTestId("list-slice-total");
  if ((await faixa.count()) > 0) return Number((await faixa.innerText()).trim());
  return page.locator("table tbody tr").count();
}

const DESTINOS: Record<string, RegExp> = {
  abertas: /\/ordens\?recorte=abertas$/,
  atrasadas: /\/ordens\?recorte=atrasadas$/,
  hoje: /\/ordens\?recorte=hoje$/,
  pendentes: /\/ordens\?status=PENDING$/,
  "tecnicos-em-atendimento": /\/tecnicos\?emAtendimento=true$/,
  "clientes-offline": /\/clientes\?active=true&conectividade=OFFLINE$/,
  "ctos-com-defeito": /\/ctos\?situacao=defeito$/,
  "ctos-com-os-abertas": /\/ctos\?situacao=com-os-abertas$/,
};

test("DASH-E2E-01 · ADMIN: os oito cartões, com os números da fixture, e cada um leva à lista com o MESMO número", async ({ page }) => {
  await entrar(page, EMAIL_ADMIN);

  const esperado: Record<string, string> = {
    abertas: "3",
    atrasadas: "1",
    hoje: "1",
    pendentes: "2",
    "tecnicos-em-atendimento": "1",
    "clientes-offline": "1",
    "ctos-com-defeito": "1",
    "ctos-com-os-abertas": "1",
  };
  for (const [chave, valor] of Object.entries(esperado)) {
    expect(await valorDoCartao(page, chave), chave).toBe(valor);
  }
  // O contexto do offline: a última leitura, entre os que TÊM leitura.
  await expect(page.getByTestId("dash-card-clientes-offline")).toContainText("de 2 com leitura");

  for (const [chave, destino] of Object.entries(DESTINOS)) {
    const valor = Number(await valorDoCartao(page, chave));
    await page.getByTestId(`dash-card-${chave}`).click();
    await expect(page, chave).toHaveURL(destino);
    expect(await contagemDoDestino(page), `destino de ${chave}`).toBe(valor);
    await page.goBack();
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByTestId(`dash-card-${chave}`)).toBeVisible();
  }
});

test("DASH-E2E-02 · DISPATCHER: só OS e equipe; clientes e CTOs nem aparecem, e a URL não os abre", async ({ page }) => {
  await entrar(page, EMAIL_DESPACHO);
  for (const chave of ["abertas", "atrasadas", "hoje", "pendentes", "tecnicos-em-atendimento"]) {
    await expect(page.getByTestId(`dash-card-${chave}`), chave).toBeVisible();
  }
  for (const chave of ["clientes-offline", "ctos-com-defeito", "ctos-com-os-abertas"]) {
    await expect(page.getByTestId(`dash-card-${chave}`), chave).toHaveCount(0);
  }

  // O recorte de conectividade não é honrado para o DISPATCHER — o servidor
  // o ignora, e a lista abre sem faixa e sem filtrar ninguém por conectividade.
  await page.goto("/clientes?active=true&conectividade=OFFLINE");
  await expect(page.getByTestId("list-slice-banner")).toHaveCount(0);
  await expect(page.locator("table tbody tr")).toHaveCount(3);
});

test("DASH-E2E-03 · empresa vazia: zero verdadeiro, e 'Sem leitura' em vez de '0 offline'", async ({ page }) => {
  await entrar(page, EMAIL_VAZIA);
  for (const chave of [
    "abertas",
    "atrasadas",
    "hoje",
    "pendentes",
    "tecnicos-em-atendimento",
    "ctos-com-defeito",
    "ctos-com-os-abertas",
  ]) {
    expect(await valorDoCartao(page, chave), chave).toBe("0");
  }
  expect(await valorDoCartao(page, "clientes-offline")).toBe("Sem leitura");
  // Nada da empresa com dados vaza para a vazia.
  await expect(page.getByText("CX DASH DEFEITO")).toHaveCount(0);
});

test("DASH-E2E-04 · recorte: a faixa diz qual e quantos; 'Limpar recorte' sai dele; 'Filtrar' o mantém", async ({ page }) => {
  await entrar(page, EMAIL_ADMIN);
  await page.goto("/ordens?recorte=atrasadas");
  await expect(page.getByTestId("list-slice-banner")).toContainText("OS atrasadas");
  await expect(page.getByTestId("list-slice-total")).toHaveText("1");

  await page.locator('select[name="priority"]').selectOption("NORMAL");
  await page.getByRole("button", { name: "Filtrar" }).click();
  await expect(page).toHaveURL(/recorte=atrasadas/);
  await expect(page).toHaveURL(/priority=NORMAL/);
  await expect(page.getByTestId("list-slice-total")).toHaveText("1");

  await page.getByRole("link", { name: "Limpar recorte" }).click();
  await expect(page).not.toHaveURL(/recorte=/);
  await expect(page.getByTestId("list-slice-banner")).toHaveCount(0);

  // Recorte desconhecido: a lista abre sem recorte, nunca com um adivinhado.
  await page.goto("/ordens?recorte=todas");
  await expect(page.getByTestId("list-slice-banner")).toHaveCount(0);
});

test("DASH-E2E-05 · cartão é link de verdade: foco por teclado e Enter navegam", async ({ page }) => {
  await entrar(page, EMAIL_ADMIN);
  const cartao = page.getByTestId("dash-card-atrasadas");
  await expect(cartao).toHaveAttribute("href", "/ordens?recorte=atrasadas");
  await expect(page.getByRole("link", { name: /OS atrasadas: 1/ })).toBeVisible();
  await cartao.focus();
  await expect(cartao).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/ordens\?recorte=atrasadas$/);
});

for (const [largura, altura] of [
  [1440, 900],
  [1366, 768],
  [1280, 720],
  [375, 812],
] as const) {
  test(`DASH-E2E-06 · layout ${largura}×${altura}: sem rolagem lateral, cartões inteiros e alvo confortável`, async ({ page }) => {
    await page.setViewportSize({ width: largura, height: altura });
    await entrar(page, EMAIL_ADMIN);

    const medidas = await page.evaluate(() => {
      const cartoes = Array.from(
        document.querySelectorAll<HTMLElement>('[data-testid^="dash-card-"]'),
      ).map((el) => {
        const r = el.getBoundingClientRect();
        return { id: el.dataset.testid, top: r.top, bottom: r.bottom, height: r.height, left: r.left, right: r.right };
      });
      return {
        rolagemLateral: document.documentElement.scrollWidth - window.innerWidth,
        largura: window.innerWidth,
        altura: window.innerHeight,
        cartoes,
      };
    });

    expect(medidas.rolagemLateral).toBeLessThanOrEqual(0);
    expect(medidas.cartoes).toHaveLength(8);
    for (const c of medidas.cartoes) {
      expect(c.height, c.id).toBeGreaterThanOrEqual(44);
      expect(c.left, c.id).toBeGreaterThanOrEqual(0);
      expect(c.right, c.id).toBeLessThanOrEqual(medidas.largura);
    }
    if (largura >= 1024) {
      // Desktop: a fileira de OS inteira na primeira dobra, e da mesma altura.
      const os = medidas.cartoes.filter((c) =>
        ["abertas", "atrasadas", "hoje", "pendentes"].some((k) => c.id === `dash-card-${k}`),
      );
      for (const c of os) expect(c.bottom, c.id).toBeLessThanOrEqual(medidas.altura);
      expect(new Set(os.map((c) => Math.round(c.height))).size).toBe(1);
      expect(new Set(os.map((c) => Math.round(c.top))).size).toBe(1);
    }
  });
}
