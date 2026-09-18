import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { allocateServiceOrderNumber } from "../src/lib/service-order-number";
import { assertTestDatabase } from "./test-db-guard";

/**
 * # `RC-1` — as datas da tela são o relógio da EMPRESA (débito §12)
 *
 * `Intl.DateTimeFormat` sem `timeZone` formata no fuso do PROCESSO — em
 * produção, UTC. O `HOTFIX-FIELD-01` já fizera "Hoje" e "Atrasadas" seguirem
 * `Company.timezone`, e a data escrita ao lado continuava vindo do servidor:
 * a mesma OS aparecia na seção "Hoje" com a data de amanhã impressa no cartão.
 *
 * A empresa sintética fica em `Asia/Tokyo` — doze horas de São Paulo. Com essa
 * distância, um instante escolhido de propósito cai em DIAS diferentes nos dois
 * relógios, e a spec afirma o dia da empresa e **proíbe** o do servidor. Fosse
 * um fuso de uma hora, o teste passaria por acidente na maior parte do dia.
 *
 * As três superfícies são as que o §12 nomeia: `Agendada:` em `/minhas-os`,
 * `Criada em` no detalhe da OS e `Vinculado em` na lista de técnicos.
 */

const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgresql://alfaos:alfaos_dev_password@localhost:5432/alfaos_test?schema=public";

const prisma = new PrismaClient({
  datasources: { db: { url: E2E_DATABASE_URL } },
});

const SENHA = "AlfaOS@2026";
const EMAIL_ADMIN = "rc1.fuso.admin@sintetico.local";
const EMAIL_TECNICO = "rc1.fuso.tecnico@sintetico.local";
const FUSO_EMPRESA = "Asia/Tokyo";
/** O `next dev` do Playwright roda nesta máquina, com o fuso dela. */
const FUSO_SERVIDOR = Intl.DateTimeFormat().resolvedOptions().timeZone;

let empresaId = "";
let ordemId = "";
let numeroOrdem = 0;
/** Instante que cai em dias civis DIFERENTES nos dois relógios. */
let instante = new Date();

function formatar(data: Date, fuso: string): string {
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: fuso,
  }).format(data);
}

function formatarData(data: Date, fuso: string): string {
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: fuso,
  }).format(data);
}

function diaCivil(data: Date, fuso: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: fuso,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(data);
}

/**
 * Um instante em que empresa e servidor estão em dias civis diferentes.
 *
 * Varre de 15 em 15 minutos e devolve o do MEIO da faixa encontrada: longe das
 * duas meias-noites, para a virada não decidir o resultado.
 */
function instanteEmDiasDiferentes(agora: Date): Date {
  const candidatos: Date[] = [];
  for (let passo = -48 * 4; passo <= 48 * 4; passo++) {
    const d = new Date(agora.getTime() + passo * 15 * 60_000);
    if (diaCivil(d, FUSO_EMPRESA) !== diaCivil(d, FUSO_SERVIDOR)) candidatos.push(d);
  }
  if (candidatos.length === 0) throw new Error("nenhum instante separa os dois relógios");
  return candidatos[Math.floor(candidatos.length / 2)];
}

test.beforeAll(async () => {
  await assertTestDatabase(E2E_DATABASE_URL, "E2E_DATABASE_URL");
  expect(FUSO_SERVIDOR, "o cenário exige fusos diferentes").not.toBe(FUSO_EMPRESA);

  const bcrypt = (await import("bcryptjs")).default;
  const empresa = await prisma.company.create({
    data: { name: "RC-1 Fuso Sintetica", timezone: FUSO_EMPRESA },
  });
  empresaId = empresa.id;

  const admin = await prisma.user.create({
    data: {
      companyId: empresaId,
      name: "Admin Fuso",
      email: EMAIL_ADMIN,
      profile: "ADMIN",
      passwordHash: bcrypt.hashSync(SENHA, 10),
    },
  });
  const userTecnico = await prisma.user.create({
    data: {
      companyId: empresaId,
      name: "Tecnico Fuso",
      email: EMAIL_TECNICO,
      profile: "TECHNICIAN",
      passwordHash: bcrypt.hashSync(SENHA, 10),
    },
  });

  instante = instanteEmDiasDiferentes(new Date());

  const tecnico = await prisma.technician.create({
    data: { companyId: empresaId, userId: userTecnico.id, createdAt: instante },
  });
  const cliente = await prisma.customer.create({
    data: { companyId: empresaId, name: "Cliente Fuso" },
  });

  numeroOrdem = await allocateServiceOrderNumber(prisma, empresaId);
  const ordem = await prisma.serviceOrder.create({
    data: {
      companyId: empresaId,
      number: numeroOrdem,
      customerId: cliente.id,
      technicianId: tecnico.id,
      type: "INSTALACAO",
      description: "OS do fuso",
      status: "ASSIGNED",
      scheduledAt: instante,
      createdAt: instante,
    },
  });
  ordemId = ordem.id;
  void admin;
});

test.afterAll(async () => {
  if (empresaId) {
    await prisma.serviceOrderEvent.deleteMany({ where: { serviceOrder: { companyId: empresaId } } });
    await prisma.serviceOrder.deleteMany({ where: { companyId: empresaId } });
    await prisma.customer.deleteMany({ where: { companyId: empresaId } });
    await prisma.technician.deleteMany({ where: { companyId: empresaId } });
    await prisma.auditLog.deleteMany({ where: { companyId: empresaId } });
    await prisma.user.deleteMany({ where: { companyId: empresaId } });
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

test("RC-TZ-01 · /minhas-os: 'Agendada:' usa o relógio da empresa", async ({ page }) => {
  await entrar(page, EMAIL_TECNICO, /\/minhas-os/);

  const esperado = formatar(instante, FUSO_EMPRESA);
  const doServidor = formatar(instante, FUSO_SERVIDOR);
  expect(esperado, "o cenário exige leituras diferentes").not.toBe(doServidor);

  await expect(page.getByText(`Agendada: ${esperado}`)).toBeVisible();
  await expect(page.getByText(`Agendada: ${doServidor}`)).toHaveCount(0);
});

test("RC-TZ-02 · detalhe da OS: 'Criada em' e 'Agendamento' usam o relógio da empresa", async ({ page }) => {
  await entrar(page, EMAIL_ADMIN, /\/dashboard/);
  await page.goto(`/ordens/${ordemId}`);

  const esperado = formatar(instante, FUSO_EMPRESA);
  const doServidor = formatar(instante, FUSO_SERVIDOR);

  /*
    As datas administrativas moram num bloco recolhido ("Detalhes
    administrativos"): sem abri-lo, a asserção falha por ausência e não por
    fuso — foi o que aconteceu na primeira versão deste teste, que passou a
    reprovar o código CERTO.
  */
  // `<details>` nativo: quem abre é o `summary`, não um botão.
  const bloco = page.getByTestId("admin-details-section");
  await bloco.locator("summary").click();

  // "Criada em" e "Agendamento" carregam o mesmo instante nesta fixture.
  await expect(bloco.getByText(esperado).first()).toBeVisible();
  await expect(bloco.getByText(doServidor)).toHaveCount(0);
});

test("RC-TZ-03 · /tecnicos: 'Vinculado em' usa o relógio da empresa", async ({ page }) => {
  await entrar(page, EMAIL_ADMIN, /\/dashboard/);
  await page.goto("/tecnicos");

  const esperado = formatarData(instante, FUSO_EMPRESA);
  const doServidor = formatarData(instante, FUSO_SERVIDOR);
  expect(esperado, "o cenário exige dias diferentes").not.toBe(doServidor);

  const linha = page.locator("tr").filter({ hasText: "Tecnico Fuso" });
  await expect(linha).toContainText(esperado);
  await expect(linha).not.toContainText(doServidor);
});
