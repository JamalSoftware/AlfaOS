import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { assertTestDatabase } from "./test-db-guard";

/**
 * # HOTFIX-FIELD-01 — "Hoje" em /minhas-os é o dia da EMPRESA
 *
 * O servidor de teste roda no fuso da máquina, e a empresa sintética fica em
 * `Asia/Tokyo` — doze horas de São Paulo. Com essa distância, em QUALQUER hora
 * do dia existe um instante que é hoje para a empresa e não para o servidor, e
 * outro que é hoje para o servidor e não para a empresa. A spec os encontra
 * pelo relógio real, com uma conta própria de data civil (não a do código sob
 * teste), e confere de que lado da tela cada OS aparece.
 *
 * Limite declarado: se a meia-noite da empresa ou do servidor cair entre o
 * `beforeAll` e a leitura da página (segundos, duas vezes por dia), o "hoje"
 * muda no meio da spec. Os instantes são escolhidos no MEIO dos intervalos
 * para que só essa janela, e não a hora do dia, possa derrubar o teste.
 */

const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgresql://alfaos:alfaos_dev_password@localhost:5432/alfaos_test?schema=public";

const prisma = new PrismaClient({
  datasources: { db: { url: E2E_DATABASE_URL } },
});

const SENHA = "AlfaOS@2026";
const EMAIL_TECNICO = "hotfix.field01.tecnico@sintetico.local";
const FUSO_EMPRESA = "Asia/Tokyo";
// O `next dev` do Playwright roda nesta mesma máquina, com o mesmo fuso.
const FUSO_SERVIDOR = Intl.DateTimeFormat().resolvedOptions().timeZone;

const NUMERO_HOJE_EMPRESA = 9101;
const NUMERO_HOJE_SERVIDOR = 9102;
const NUMERO_ATRASADA = 9103;
const NUMERO_PROXIMA = 9104;
const NUMERO_SEM_AGENDA = 9105;

/**
 * A OS que é "hoje" só no relógio do SERVIDOR cai em "Próximas" ou em
 * "Atrasadas" conforme ela esteja no futuro ou no passado — as duas respostas
 * são corretas, e o teste não pode depender de qual das duas o relógio deu.
 */
let ehFuturo = false;

let empresaId = "";

function dataCivil(instante: Date, fuso: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: fuso,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instante);
}

/**
 * O instante do MEIO entre todos os que satisfazem o predicado, varrendo de
 * 15 em 15 minutos até 36 h para cada lado. O meio fica longe das meias-noites.
 */
function instanteNoMeio(agora: Date, predicado: (d: Date) => boolean): Date {
  const candidatos: Date[] = [];
  for (let passo = -36 * 4; passo <= 36 * 4; passo++) {
    const d = new Date(agora.getTime() + passo * 15 * 60_000);
    if (predicado(d)) candidatos.push(d);
  }
  if (candidatos.length === 0) throw new Error("nenhum instante satisfaz o cenário");
  return candidatos[Math.floor(candidatos.length / 2)];
}

test.beforeAll(async () => {
  await assertTestDatabase(E2E_DATABASE_URL, "E2E_DATABASE_URL");
  expect(FUSO_SERVIDOR, "o cenário exige fusos diferentes").not.toBe(FUSO_EMPRESA);

  const bcrypt = (await import("bcryptjs")).default;
  const empresa = await prisma.company.create({
    data: { name: "HOTFIX-FIELD-01 Sintetica", timezone: FUSO_EMPRESA },
  });
  empresaId = empresa.id;
  const user = await prisma.user.create({
    data: {
      companyId: empresaId,
      name: "Técnico Hotfix",
      email: EMAIL_TECNICO,
      profile: "TECHNICIAN",
      passwordHash: bcrypt.hashSync(SENHA, 10),
    },
  });
  const tecnico = await prisma.technician.create({
    data: { companyId: empresaId, userId: user.id },
  });
  const cliente = await prisma.customer.create({
    data: { companyId: empresaId, name: "Cliente Hotfix" },
  });

  const agora = new Date();
  const hojeEmpresa = dataCivil(agora, FUSO_EMPRESA);
  const hojeServidor = dataCivil(agora, FUSO_SERVIDOR);
  // Hoje para a empresa, e NÃO hoje para o servidor.
  const x = instanteNoMeio(
    agora,
    (d) => dataCivil(d, FUSO_EMPRESA) === hojeEmpresa && dataCivil(d, FUSO_SERVIDOR) !== hojeServidor,
  );
  // Hoje para o servidor, e NÃO hoje para a empresa.
  const y = instanteNoMeio(
    agora,
    (d) => dataCivil(d, FUSO_SERVIDOR) === hojeServidor && dataCivil(d, FUSO_EMPRESA) !== hojeEmpresa,
  );

  ehFuturo = y.getTime() > agora.getTime();

  const TRES_DIAS = 3 * 24 * 60 * 60_000;
  for (const [numero, scheduledAt] of [
    [NUMERO_HOJE_EMPRESA, x],
    [NUMERO_HOJE_SERVIDOR, y],
    // RC-1D: uma OS de cada seção nova.
    [NUMERO_ATRASADA, new Date(agora.getTime() - TRES_DIAS)],
    [NUMERO_PROXIMA, new Date(agora.getTime() + TRES_DIAS)],
    [NUMERO_SEM_AGENDA, null],
  ] as const) {
    await prisma.serviceOrder.create({
      data: {
        companyId: empresaId,
        number: numero,
        customerId: cliente.id,
        technicianId: tecnico.id,
        type: "INSTALACAO",
        description: "OS do hotfix de fuso",
        status: "ASSIGNED",
        scheduledAt,
      },
    });
  }
});

test.afterAll(async () => {
  if (empresaId) {
    await prisma.serviceOrder.deleteMany({ where: { companyId: empresaId } });
    await prisma.customer.deleteMany({ where: { companyId: empresaId } });
    await prisma.technician.deleteMany({ where: { companyId: empresaId } });
    await prisma.auditLog.deleteMany({ where: { companyId: empresaId } });
    await prisma.user.deleteMany({ where: { companyId: empresaId } });
    await prisma.company.delete({ where: { id: empresaId } });
  }
  await prisma.$disconnect();
});

async function entrar(page: Page) {
  await page.goto("/login");
  await page.getByLabel("E-mail").fill(EMAIL_TECNICO);
  await page.getByLabel("Senha").fill(SENHA);
  await page.getByRole("button", { name: "Entrar" }).click();
  await page.waitForURL(/\/minhas-os/);
}

const secao = (page: Page, titulo: string) =>
  page
    .locator("section")
    .filter({ has: page.getByRole("heading", { level: 2, name: titulo, exact: true }) });

test("FIELD-TODAY-E2E-01 · /minhas-os: 'Hoje' segue o dia civil da empresa, não o do servidor", async ({ page }) => {
  await entrar(page);

  const hoje = secao(page, "Hoje");
  const proximas = secao(page, "Próximas");

  // Só a OS do dia da EMPRESA em "Hoje".
  await expect(hoje.getByTestId("order-number")).toHaveText([`OS Nº ${NUMERO_HOJE_EMPRESA}`]);

  /*
    A que só é "hoje" no relógio do servidor NÃO some — e desde a RC-1D ela vai
    para a seção que a descreve: futura em "Próximas", vencida em "Atrasadas".
  */
  const destino = ehFuturo ? proximas : secao(page, "Atrasadas");
  await expect(destino.getByTestId("order-number")).toContainText([
    `OS Nº ${NUMERO_HOJE_SERVIDOR}`,
  ]);
});

test("RC1D-MINHAS-OS · atrasada, próxima e sem agendamento têm seção própria", async ({ page }) => {
  /*
    O débito que a RC-1D fecha: "Próximas" juntava futuro, vencido e sem data.
    Na validação do dono, em 13/09/2026, ela mostrou OS agendadas para 06/09.
  */
  await entrar(page);

  await expect(
    secao(page, "Atrasadas").getByTestId("order-number"),
  ).toContainText([`OS Nº ${NUMERO_ATRASADA}`]);
  await expect(secao(page, "Atrasadas")).toContainText(
    "Agendadas para antes de hoje e ainda não iniciadas",
  );

  await expect(
    secao(page, "Próximas").getByTestId("order-number"),
  ).toContainText([`OS Nº ${NUMERO_PROXIMA}`]);

  const semAgenda = secao(page, "Sem agendamento");
  await expect(semAgenda.getByTestId("order-number")).toHaveText([
    `OS Nº ${NUMERO_SEM_AGENDA}`,
  ]);
  await expect(semAgenda).toContainText("ainda sem data marcada");

  // E nenhuma delas ficou em "Próximas" junto das futuras.
  const proximas = await secao(page, "Próximas").getByTestId("order-number").allTextContents();
  expect(proximas).not.toContain(`OS Nº ${NUMERO_ATRASADA}`);
  expect(proximas).not.toContain(`OS Nº ${NUMERO_SEM_AGENDA}`);
});
