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
 *
 * **O fuso da empresa sintética é `America/Manaus`, e não o de São Paulo**
 * (DASH-1a). A máquina de desenvolvimento roda em São Paulo; com a empresa no
 * mesmo fuso, "a hora mostrada é a da empresa" e "a hora mostrada é a do
 * servidor" dariam o MESMO texto, e a asserção de "Agendada para" não
 * distinguiria as duas. Manaus é UTC−4 o ano inteiro, uma hora de diferença.
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
const FUSO_EMPRESA = "America/Manaus";

let empresaId = "";
let vaziaId = "";
/** O agendamento da OS atrasada — o valor que "Agendada para" tem de mostrar. */
let agendamentoAtrasada = new Date(0);
/** O agendamento da OS de hoje. */
let agendamentoHoje = new Date(0);

function formatarNoFuso(data: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  }).format(data);
}

test.beforeAll(async () => {
  await assertTestDatabase(E2E_DATABASE_URL, "E2E_DATABASE_URL");
  const bcrypt = (await import("bcryptjs")).default;
  const hash = bcrypt.hashSync(SENHA, 10);

  const empresa = await prisma.company.create({
    data: {
      name: "DASH-1 Sintetica",
      ctoNetworkEnabled: true,
      timezone: FUSO_EMPRESA,
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
  /*
    DASH-1a: um técnico INATIVO com OS em atendimento. A OS iniciada antes da
    desativação é fato operacional, e o recorte o mostra — com o status
    cadastral "Inativo" ao lado, sem esconder nem confundir os dois.
  */
  const inativoUser = await prisma.user.create({
    data: {
      companyId: empresaId,
      name: "Técnico Inativo DASH",
      email: "dash1.tecnico.inativo@sintetico.local",
      profile: "TECHNICIAN",
      passwordHash: hash,
    },
  });
  const tecnicoInativo = await prisma.technician.create({
    data: { companyId: empresaId, userId: inativoUser.id, active: false },
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
  // pendente sem agendamento, uma concluída que não conta em nada e — DASH-1a —
  // a do técnico inativo, em atendimento e SEM agendamento (não é de hoje).
  const trintaDias = new Date(agora.getTime() - 30 * 24 * 3_600_000);
  agendamentoAtrasada = trintaDias;
  agendamentoHoje = agora;
  const ordens = [
    { status: "PENDING" as const, scheduledAt: trintaDias, technicianId: null, customerId: online.id },
    { status: "IN_PROGRESS" as const, scheduledAt: agora, technicianId: tecnico.id, customerId: online.id },
    { status: "PENDING" as const, scheduledAt: null, technicianId: null, customerId: offline.id },
    { status: "COMPLETED" as const, scheduledAt: trintaDias, technicianId: tecnico.id, customerId: online.id },
    { status: "IN_PROGRESS" as const, scheduledAt: null, technicianId: tecnicoInativo.id, customerId: online.id },
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
  // DASH-1a: inativa COM porta danificada — é INACTIVE, nunca "com defeito".
  const inativa = await prisma.cTO.create({
    data: { companyId: empresaId, name: "CX DASH INATIVA", capacity: 4, active: false },
  });
  for (const cto of [comDefeito, sa, inativa]) {
    await prisma.cTOPort.createMany({
      data: [1, 2, 3, 4].map((number) => ({
        companyId: empresaId,
        ctoId: cto.id,
        number,
        administrativeState:
          cto.id !== sa.id && number === 1 ? "DAMAGED" : "AVAILABLE",
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
  pendentes: /\/ordens\?recorte=pendentes$/,
  "tecnicos-em-atendimento": /\/tecnicos\?emAtendimento=true$/,
  "clientes-offline": /\/clientes\?active=true&conectividade=OFFLINE$/,
  "ctos-com-defeito": /\/ctos\?situacao=defeito$/,
  "ctos-com-os-abertas": /\/ctos\?situacao=com-os-abertas$/,
};

test("DASH-E2E-01 · ADMIN: os oito cartões, com os números da fixture, e cada um leva à lista com o MESMO número", async ({ page }) => {
  await entrar(page, EMAIL_ADMIN);

  const esperado: Record<string, string> = {
    abertas: "4",
    atrasadas: "1",
    hoje: "1",
    pendentes: "2",
    "tecnicos-em-atendimento": "2",
    "clientes-offline": "1",
    "ctos-com-defeito": "1",
    "ctos-com-os-abertas": "1",
  };
  for (const [chave, valor] of Object.entries(esperado)) {
    expect(await valorDoCartao(page, chave), chave).toBe(valor);
  }
  // O contexto do offline: entre os que TÊM leitura.
  await expect(page.getByTestId("dash-card-clientes-offline")).toContainText(
    "Entre 2 clientes com leitura disponível.",
  );

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

// ---------------------------------------------------------------------------
// DASH-1a — cada listagem explica por que a linha está no recorte
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

async function voltarAoPainel(page: Page) {
  const volta = page.getByTestId("back-to-dashboard");
  await expect(volta).toBeVisible();
  await volta.click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

async function abrirCartao(page: Page, chave: string, destino: RegExp) {
  await page.getByTestId(`dash-card-${chave}`).click();
  await expect(page).toHaveURL(destino);
}

const linha = (page: Page, texto: string) =>
  page.locator("table tbody tr", { hasText: texto });

test("DASHCTX-E2E-01 · fluxo do dono: cada cartão abre a lista que explica o recorte, e a volta é ao painel", async ({ page }) => {
  await test.step("1. login ADMIN", async () => {
    await entrar(page, EMAIL_ADMIN);
  });

  await test.step("2. abrir dashboard", async () => {
    await expect(page.getByTestId("dash-card-abertas")).toBeVisible();
    await expect(page.getByTestId("back-to-dashboard")).toHaveCount(0);
  });

  await test.step("3. clicar OS abertas", async () => {
    await abrirCartao(page, "abertas", DESTINOS.abertas);
  });

  await test.step("4. ver 'Voltar ao Dashboard': acima do título, link real para /dashboard", async () => {
    const volta = page.getByTestId("back-to-dashboard");
    await expect(volta).toBeVisible();
    await expect(volta).toHaveText(/Voltar ao Dashboard/);
    await expect(volta).toHaveAttribute("href", "/dashboard");
    const [caixaVolta, caixaTitulo] = await Promise.all([
      volta.boundingBox(),
      page.getByRole("heading", { level: 1, name: "Ordens de Serviço" }).boundingBox(),
    ]);
    expect(caixaVolta!.y + caixaVolta!.height).toBeLessThanOrEqual(caixaTitulo!.y + 1);
    await expect(page.getByTestId("list-slice-banner")).toContainText(
      "Recorte do painel: OS abertas · 4 OS",
    );
  });

  await test.step("5. voltar", () => voltarAoPainel(page));

  await test.step("6. clicar OS atrasadas", async () => {
    await abrirCartao(page, "atrasadas", DESTINOS.atrasadas);
  });

  await test.step("7. conferir 'Agendada para': o agendamento real, no fuso da EMPRESA", async () => {
    await expect(page.getByRole("columnheader", { name: "Agendada para" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Criada em" })).toHaveCount(0);
    const esperado = formatarNoFuso(agendamentoAtrasada, FUSO_EMPRESA);
    // Sanidade do próprio teste: no fuso do servidor o texto seria outro.
    expect(esperado).not.toBe(formatarNoFuso(agendamentoAtrasada, "America/Sao_Paulo"));
    // E não é a criação: a OS foi criada agora e agendada há 30 dias.
    expect(esperado.slice(0, 10)).not.toBe(formatarNoFuso(new Date(), FUSO_EMPRESA).slice(0, 10));
    await expect(linha(page, "Nº 810").getByTestId("order-scheduled-at")).toHaveText(esperado);
  });

  await test.step("8. voltar", () => voltarAoPainel(page));

  await test.step("9. clicar OS de hoje", async () => {
    await abrirCartao(page, "hoje", DESTINOS.hoje);
  });

  await test.step("10. conferir o contexto do recorte (o vazio contextual é o DASHCTX-E2E-03)", async () => {
    await expect(page.getByTestId("list-slice-banner")).toContainText(
      "Recorte do painel: OS de hoje · 1 OS",
    );
    await expect(page.getByRole("columnheader", { name: "Agendada para" })).toBeVisible();
    await expect(linha(page, "Nº 811").getByTestId("order-scheduled-at")).toHaveText(
      formatarNoFuso(agendamentoHoje, FUSO_EMPRESA),
    );
  });

  await test.step("11. voltar", () => voltarAoPainel(page));

  await test.step("12. clicar OS pendentes", async () => {
    await abrirCartao(page, "pendentes", DESTINOS.pendentes);
  });

  await test.step("13. conferir a faixa do recorte, como nos outros sete", async () => {
    await expect(page.getByTestId("list-slice-banner")).toContainText(
      "Recorte do painel: OS pendentes · 2 OS",
    );
    await expect(page.getByTestId("list-slice-clear")).toHaveText("Limpar recorte");
    await expect(page.locator("table tbody tr")).toHaveCount(2);
    await expect(page.locator("table tbody tr", { hasText: "Pendente" })).toHaveCount(2);
  });

  await test.step("14. voltar", () => voltarAoPainel(page));

  await test.step("15. clicar Técnicos em atendimento", async () => {
    await abrirCartao(page, "tecnicos-em-atendimento", DESTINOS["tecnicos-em-atendimento"]);
  });

  await test.step("16. conferir '1 OS em atendimento', com o status cadastral separado, inclusive Inativo", async () => {
    await expect(page.getByTestId("list-slice-banner")).toContainText(
      "Recorte do painel: Técnicos em atendimento · 2 técnicos",
    );
    await expect(page.getByRole("columnheader", { name: "Status cadastral" })).toBeVisible();
    const ativo = linha(page, "Técnico DASH");
    await expect(ativo.getByTestId("tech-in-service")).toHaveText("1 OS em atendimento");
    await expect(ativo.getByText("Ativo", { exact: true })).toBeVisible();
    const inativo = linha(page, "Técnico Inativo DASH");
    await expect(inativo.getByTestId("tech-in-service")).toHaveText("1 OS em atendimento");
    await expect(inativo.getByText("Inativo", { exact: true })).toBeVisible();
  });

  await test.step("17. voltar", () => voltarAoPainel(page));

  await test.step("18. clicar Clientes offline", async () => {
    await abrirCartao(page, "clientes-offline", DESTINOS["clientes-offline"]);
  });

  await test.step("19. conferir 'Ativo' + 'Offline': duas perguntas, dois nomes", async () => {
    await expect(page.getByTestId("list-slice-banner")).toContainText(
      "Recorte do painel: Clientes offline · 1 cliente",
    );
    await expect(page.getByRole("columnheader", { name: "Conectividade" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Status cadastral" })).toBeVisible();
    const cliente = linha(page, "Cliente Offline");
    await expect(cliente.getByTestId("customer-connectivity")).toContainText("Offline");
    await expect(cliente.getByTestId("customer-connectivity-age")).toHaveText(
      /^Leitura (agora há pouco|há \d+ min|há \d+ h)$/,
    );
    await expect(cliente.getByText("Ativo", { exact: true })).toBeVisible();
  });

  await test.step("20. voltar", () => voltarAoPainel(page));

  await test.step("21. clicar CTOs com defeito", async () => {
    await abrirCartao(page, "ctos-com-defeito", DESTINOS["ctos-com-defeito"]);
  });

  await test.step("22. conferir o contexto: 'Com defeito', portas danificadas, a inativa fora e o resultado antes do cadastro", async () => {
    await expect(page.getByTestId("list-slice-banner")).toContainText(
      "Recorte do painel: CTOs com defeito · 1 CTO",
    );
    await expect(page.getByTestId("cto-row")).toHaveCount(1);
    const caixa = page.getByTestId("cto-row").filter({ hasText: "CX DASH DEFEITO" });
    await expect(caixa.getByTestId("cto-operational-state")).toHaveText(/Com defeito/);
    await expect(caixa.getByTestId("cto-damaged-ports")).toHaveText("1");
    await expect(page.getByText("CX DASH INATIVA")).toHaveCount(0);
    const [primeiraLinha, formulario] = await Promise.all([
      page.getByTestId("cto-row").first().boundingBox(),
      page.getByTestId("cto-create-form").boundingBox(),
    ]);
    expect(primeiraLinha!.y).toBeLessThan(formulario!.y);
  });

  await test.step("23. voltar", () => voltarAoPainel(page));

  await test.step("24. clicar CTOs com OS abertas", async () => {
    await abrirCartao(page, "ctos-com-os-abertas", DESTINOS["ctos-com-os-abertas"]);
  });

  await test.step("25. conferir a contagem de OS: o número, não só a coluna", async () => {
    await expect(page.getByTestId("list-slice-banner")).toContainText(
      "Recorte do painel: CTOs com OS abertas · 1 CTO",
    );
    await expect(page.getByRole("columnheader", { name: "OS abertas" })).toBeVisible();
    const caixa = page.getByTestId("cto-row").filter({ hasText: "CX DASH DEFEITO" });
    await expect(caixa.getByTestId("cto-open-orders")).toHaveText("1");
  });

  await test.step("26. voltar", () => voltarAoPainel(page));

  await test.step("27. conferir a atividade recente humanizada", async () => {
    const primeiro = page.getByTestId("dash-activity-item").first();
    await expect(primeiro.getByTestId("dash-activity-action")).toHaveText("Login realizado");
    await expect(primeiro.getByTestId("dash-activity-action")).toHaveAttribute("title", "AUTH.LOGIN");
    await expect(primeiro.getByTestId("dash-activity-meta")).toHaveText("Usuário · Admin DASH");
    const atividade = page.getByTestId("dash-activity");
    await expect(atividade.getByText("AUTH.LOGIN", { exact: true })).toHaveCount(0);
    await expect(atividade).not.toContainText("User ·");
  });
});

test("DASHCTX-E2E-02 · a volta só existe com recorte; 'Limpar recorte' fica na lista; a volta ignora o histórico", async ({ page }) => {
  await entrar(page, EMAIL_ADMIN);

  // RETURN-03: a listagem aberta normalmente não tem volta nem faixa.
  for (const url of ["/ordens", "/tecnicos", "/clientes", "/ctos"]) {
    await page.goto(url);
    await expect(page.getByTestId("back-to-dashboard"), url).toHaveCount(0);
    await expect(page.getByTestId("list-slice-banner"), url).toHaveCount(0);
  }
  // Recorte inválido também não: nunca um recorte adivinhado.
  await page.goto("/ordens?recorte=todas");
  await expect(page.getByTestId("back-to-dashboard")).toHaveCount(0);

  // Recorte + filtro: o filtro soma, e a volta continua lá.
  await page.goto("/ordens?recorte=atrasadas");
  await page.locator('select[name="priority"]').selectOption("NORMAL");
  await page.getByRole("button", { name: "Filtrar" }).click();
  await expect(page).toHaveURL(/recorte=atrasadas/);
  await expect(page).toHaveURL(/priority=NORMAL/);
  await expect(page.getByTestId("back-to-dashboard")).toBeVisible();

  // RETURN-04: "Limpar recorte" fica na MESMA listagem, com o filtro.
  await page.getByTestId("list-slice-clear").click();
  await expect(page).toHaveURL(/\/ordens\?priority=NORMAL$/);
  await expect(page.getByTestId("list-slice-banner")).toHaveCount(0);
  await expect(page.getByTestId("back-to-dashboard")).toHaveCount(0);
  await expect(page.locator('select[name="priority"]')).toHaveValue("NORMAL");

  // A volta é o painel, e não "a página anterior": chegando por URL direta, o
  // histórico aponta para /ordens?priority=NORMAL, e a volta vai ao painel.
  await page.goto("/ordens?recorte=atrasadas&priority=NORMAL&page=1");
  await voltarAoPainel(page);
});

test("DASHCTX-E2E-03 · empresa vazia: os oito recortes com faixa '· 0', vazio contextual e nenhuma ação irrelevante", async ({ page }) => {
  await entrar(page, EMAIL_VAZIA);
  const vazios: Record<string, { faixa: string; titulo: string; descricao: string }> = {
    abertas: {
      faixa: "OS abertas · 0 OS",
      titulo: "Nenhuma OS aberta",
      descricao: "Não há ordens de serviço abertas neste momento.",
    },
    atrasadas: {
      faixa: "OS atrasadas · 0 OS",
      titulo: "Nenhuma OS atrasada",
      descricao: "Nenhuma ordem com horário agendado vencido está aguardando o início do atendimento.",
    },
    hoje: {
      faixa: "OS de hoje · 0 OS",
      titulo: "Nenhuma OS agendada para hoje",
      descricao: "Não há ordens abertas agendadas para o dia de hoje.",
    },
    pendentes: {
      faixa: "OS pendentes · 0 OS",
      titulo: "Nenhuma OS pendente",
      descricao: "Todas as ordens abertas já têm técnico atribuído.",
    },
    "tecnicos-em-atendimento": {
      faixa: "Técnicos em atendimento · 0 técnicos",
      titulo: "Nenhum técnico em atendimento",
      descricao: "Nenhum técnico está com OS em atendimento neste momento.",
    },
    "clientes-offline": {
      faixa: "Clientes offline · 0 clientes",
      titulo: "Nenhum cliente offline",
      descricao: "Nenhum cliente ativo tem a última leitura de conectividade como offline.",
    },
    "ctos-com-defeito": {
      faixa: "CTOs com defeito · 0 CTOs",
      titulo: "Nenhuma CTO com defeito",
      descricao: "Nenhuma caixa ativa tem porta danificada.",
    },
    "ctos-com-os-abertas": {
      faixa: "CTOs com OS abertas · 0 CTOs",
      titulo: "Nenhuma CTO com OS abertas",
      descricao: "Nenhum cliente vinculado a uma caixa tem ordem de serviço aberta.",
    },
  };

  for (const [chave, esperado] of Object.entries(vazios)) {
    await abrirCartao(page, chave, DESTINOS[chave]);
    await expect(page.getByTestId("list-slice-banner"), chave).toContainText(
      `Recorte do painel: ${esperado.faixa}`,
    );
    /*
      UM estado vazio, e é o do recorte. O botão "Sincronizar Mock ERP" do
      cabeçalho de /ordens continua existindo (é o INFO de release da §48) —
      a afirmação é sobre o que o VAZIO sugere, não sobre a página inteira.
    */
    const vazio = page.getByTestId("empty-state");
    await expect(vazio, chave).toHaveCount(1);
    await expect(vazio.getByRole("heading"), chave).toHaveText(esperado.titulo);
    await expect(vazio.locator("p"), chave).toHaveText(esperado.descricao);
    // EMPTY-02: nada de "sincronize o Mock ERP", "crie uma OS", "cadastre".
    await expect(vazio, chave).not.toContainText(
      /Mock ERP|sincroniz|Crie|Cadastre|Vincule|importe/i,
    );
    await voltarAoPainel(page);
  }
});

test("DASHCTX-E2E-04 · DISPATCHER: volta e faixa onde o recorte vale; nenhuma onde o servidor o ignora", async ({ page }) => {
  await entrar(page, EMAIL_DESPACHO);
  await abrirCartao(page, "tecnicos-em-atendimento", DESTINOS["tecnicos-em-atendimento"]);
  await expect(page.getByTestId("list-slice-banner")).toContainText("· 2 técnicos");
  await voltarAoPainel(page);

  await page.goto("/clientes?active=true&conectividade=OFFLINE");
  await expect(page.getByTestId("back-to-dashboard")).toHaveCount(0);
  await expect(page.getByTestId("list-slice-banner")).toHaveCount(0);
  await expect(page.getByRole("columnheader", { name: "Conectividade" })).toHaveCount(0);
});

for (const tema of ["light", "dark"] as const) {
  test(`DASHCTX-E2E-05 · tema ${tema}: a volta, o selo Offline e o 'Com defeito' têm contraste real`, async ({ page }) => {
    await page.addInitScript((t) => {
      window.localStorage.setItem("alfaos-theme", t);
    }, tema);
    await entrar(page, EMAIL_ADMIN);

    const medir = (seletor: string) =>
      page.locator(seletor).first().evaluate((el) => {
        const fundoDe = (no: Element | null): string => {
          for (let atual = no; atual; atual = atual.parentElement) {
            const bg = getComputedStyle(atual).backgroundColor;
            if (bg && !/rgba\(0, 0, 0, 0\)|transparent/.test(bg)) return bg;
          }
          return getComputedStyle(document.body).backgroundColor;
        };
        return { frente: getComputedStyle(el).color, fundo: fundoDe(el) };
      });

    await page.goto("/clientes?active=true&conectividade=OFFLINE");
    for (const seletor of [
      '[data-testid="back-to-dashboard"]',
      '[data-testid="customer-connectivity"] > span',
      '[data-testid="customer-connectivity-age"]',
    ]) {
      const cores = await medir(seletor);
      const razao = contraste(cores.frente, cores.fundo);
      expect(
        razao,
        `${seletor}: ${razao.toFixed(2)}:1 entre ${cores.frente} e ${cores.fundo}`,
      ).toBeGreaterThanOrEqual(4.5);
    }

    await page.goto("/ctos?situacao=defeito");
    const cores = await medir('[data-testid="cto-operational-state"] > span');
    const razao = contraste(cores.frente, cores.fundo);
    expect(razao, `Com defeito: ${razao.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
  });
}

for (const [largura, altura] of [
  [1440, 900],
  [1366, 768],
  [1280, 720],
  [375, 812],
] as const) {
  test(`DASHCTX-E2E-06 · layout ${largura}×${altura}: o contexto novo não cria rolagem lateral nem sobreposição`, async ({ page }) => {
    await page.setViewportSize({ width: largura, height: altura });
    await entrar(page, EMAIL_ADMIN);

    for (const url of [
      "/ordens?recorte=atrasadas",
      "/tecnicos?emAtendimento=true",
      "/clientes?active=true&conectividade=OFFLINE",
      "/ctos?situacao=defeito",
    ]) {
      await page.goto(url);
      await expect(page.getByTestId("back-to-dashboard"), url).toBeVisible();
      const medidas = await page.evaluate(() => {
        const caixa = (seletor: string) => {
          const el = document.querySelector(seletor);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height };
        };
        // `main` é o contêiner que rola (layout do app): uma linha larga demais
        // rolaria ALI, e não no documento. As duas medidas contam.
        const main = document.querySelector("main")!;
        return {
          rolagemLateral: Math.max(
            document.documentElement.scrollWidth - window.innerWidth,
            main.scrollWidth - main.clientWidth,
          ),
          largura: window.innerWidth,
          volta: caixa('[data-testid="back-to-dashboard"]'),
          titulo: caixa("h1"),
          faixa: caixa('[data-testid="list-slice-banner"]'),
        };
      });
      expect(medidas.rolagemLateral, url).toBeLessThanOrEqual(0);
      const volta = medidas.volta!;
      expect(volta.left, url).toBeGreaterThanOrEqual(0);
      expect(volta.right, url).toBeLessThanOrEqual(medidas.largura);
      // Alvo confortável (WCAG 2.5.8: 24px).
      expect(volta.height, url).toBeGreaterThanOrEqual(24);
      // Nada sobreposto: volta acima do título, título acima da faixa.
      expect(volta.bottom, url).toBeLessThanOrEqual(medidas.titulo!.top + 1);
      expect(medidas.titulo!.bottom, url).toBeLessThanOrEqual(medidas.faixa!.top + 1);
      expect(medidas.faixa!.right, url).toBeLessThanOrEqual(medidas.largura);
    }
  });
}
