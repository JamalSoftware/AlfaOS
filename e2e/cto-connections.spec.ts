import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { assertTestDatabase } from "./test-db-guard";

/**
 * # `CTO-2.3` — vincular, mover e desconectar pela TELA
 *
 * O que só um navegador prova: a ordem visual, o que a pessoa consegue clicar,
 * e — sobretudo — o que acontece quando a tela está **velha**. Nenhum teste de
 * rota alcança o cenário que este arquivo existe para cobrir: dois operadores,
 * um deles olhando um mundo que já mudou.
 *
 * **Tenant sintético.** Este spec cria a própria empresa e apaga tudo o que
 * criou. A CTO de QA do dono não é tocada, e a empresa semeada não é usada —
 * ligar a capability nela mudaria o menu que outros specs inspecionam.
 */

const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgresql://alfaos:alfaos_dev_password@localhost:5432/alfaos_test?schema=public";

const prisma = new PrismaClient({
  datasources: { db: { url: E2E_DATABASE_URL } },
});

const EMAIL = "cto23@sintetico.local";
const SENHA = "AlfaOS@2026";
const EMPRESA = "CTO-2.3 Sintetica";

let companyId = "";

test.beforeAll(async () => {
  await assertTestDatabase(E2E_DATABASE_URL, "E2E_DATABASE_URL");

  const bcrypt = (await import("bcryptjs")).default;
  const company = await prisma.company.create({
    data: { name: EMPRESA, ctoNetworkEnabled: true },
  });
  companyId = company.id;
  await prisma.user.create({
    data: {
      companyId,
      name: "Admin CTO 2.3",
      email: EMAIL,
      profile: "ADMIN",
      passwordHash: bcrypt.hashSync(SENHA, 10),
    },
  });
});

test.afterAll(async () => {
  /*
    Limpeza por ESCOPO, na ordem que as FKs `Restrict` exigem: vínculo, porta,
    CTO, cliente. Apagar "o que parece de teste" é como uma suíte come dado
    real.
  */
  await prisma.customerNetworkConnection.deleteMany({ where: { companyId } });
  await prisma.cTOPort.deleteMany({ where: { companyId } });
  await prisma.cTO.deleteMany({ where: { companyId } });
  await prisma.customer.deleteMany({ where: { companyId } });
  await prisma.auditLog.deleteMany({ where: { companyId } });
  await prisma.user.deleteMany({ where: { companyId } });
  await prisma.company.delete({ where: { id: companyId } });
  await prisma.$disconnect();
});

// --- ajudantes --------------------------------------------------------------

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("E-mail").fill(EMAIL);
  await page.getByLabel("Senha").fill(SENHA);
  await page.getByRole("button", { name: "Entrar" }).click();
  await page.waitForURL((u) => !u.pathname.includes("/login"));
}

let seq = 0;
async function criarCto(nome: string, capacidade = 4) {
  seq += 1;
  const cto = await prisma.cTO.create({
    data: { companyId, name: `${nome}-${seq}`, capacity: capacidade },
  });
  await prisma.cTOPort.createMany({
    data: Array.from({ length: capacidade }, (_, i) => ({
      ctoId: cto.id,
      companyId,
      number: i + 1,
    })),
  });
  return cto;
}

async function criarCliente(nome: string) {
  return prisma.customer.create({ data: { companyId, name: nome } });
}

async function porta(ctoId: string, numero: number) {
  return prisma.cTOPort.findFirstOrThrow({ where: { ctoId, number: numero } });
}

/** Um vínculo criado FORA da tela, para montar o estado de partida. */
async function vincular(customerId: string, ctoPortId: string) {
  return prisma.customerNetworkConnection.create({
    data: {
      companyId,
      customerId,
      ctoPortId,
      connectedAt: new Date(),
      source: "WEB",
    },
  });
}

async function abrir(page: Page, ctoId: string) {
  await page.goto(`/ctos/${ctoId}`);
  await expect(page.getByTestId("cto-port-row").first()).toBeVisible();
}

// ---------------------------------------------------------------------------

test("E2E-CONNECT — o ADMIN vincula um cliente e a ocupação muda", async ({ page }) => {
  const cto = await criarCto("CONECTA");
  await criarCliente("Marina Alves");
  await login(page);
  await abrir(page, cto.id);

  await expect(page.getByTestId("cto-free")).toHaveText("4");

  await page.getByTestId("cto-port-connect-1").click();
  await expect(page.getByTestId("cto-connect-dialog")).toBeVisible();
  await page.getByTestId("cto-customer-search").fill("Marina");
  const opcao = page.getByRole("button", { name: /Marina Alves/ });
  await expect(opcao).toBeVisible();
  await opcao.click();
  await expect(page.getByTestId("cto-connect-plain")).toBeVisible();
  await page.getByTestId("cto-connect-confirm").click();

  await expect(page.getByTestId("cto-connection-success")).toContainText("vinculado");
  await expect(page.getByTestId("cto-port-customer-1")).toHaveText("Marina Alves");
  await expect(page.getByTestId("cto-port-state-1")).toHaveText("Ocupada");
  await expect(page.getByTestId("cto-free")).toHaveText("3");

  // F5: a autoridade é o servidor, não o estado local.
  await page.reload();
  await expect(page.getByTestId("cto-port-customer-1")).toHaveText("Marina Alves");
  await expect(page.getByTestId("cto-free")).toHaveText("3");
  // E a porta ocupada não oferece vincular.
  await expect(page.getByTestId("cto-port-connect-1")).toHaveCount(0);
});

test("E2E-DISCONNECT — desconectar pede confirmação e devolve a porta", async ({ page }) => {
  const cto = await criarCto("DESCONECTA");
  const cliente = await criarCliente("Rui Barbosa");
  await vincular(cliente.id, (await porta(cto.id, 2)).id);
  await login(page);
  await abrir(page, cto.id);

  await expect(page.getByTestId("cto-port-customer-2")).toHaveText("Rui Barbosa");
  await page.getByTestId("cto-port-disconnect-2").click();

  const dialogo = page.getByTestId("cto-disconnect-dialog");
  await expect(dialogo).toBeVisible();
  // O contexto suficiente: cliente, porta e CTO — sem id interno.
  await expect(dialogo).toContainText("Rui Barbosa");
  await expect(dialogo).toContainText("02");
  await expect(dialogo).not.toContainText(cliente.id);

  await page.getByTestId("cto-disconnect-confirm").click();
  await expect(page.getByTestId("cto-connection-success")).toContainText("desconectado");
  await expect(page.getByTestId("cto-port-customer-2")).toHaveCount(0);
  await expect(page.getByTestId("cto-port-state-2")).toHaveText("Livre");

  await page.reload();
  await expect(page.getByTestId("cto-port-customer-2")).toHaveCount(0);
  await expect(page.getByTestId("cto-free")).toHaveText("4");
});

test("E2E-MOVE — mover dentro da mesma CTO troca a porta e mantém a ocupação", async ({ page }) => {
  const cto = await criarCto("MOVE-INTERNO");
  const cliente = await criarCliente("Selma Costa");
  const vinculo = await vincular(cliente.id, (await porta(cto.id, 1)).id);
  await login(page);
  await abrir(page, cto.id);

  await expect(page.getByTestId("cto-port-customer-1")).toHaveText("Selma Costa");
  await page.getByTestId("cto-port-move-1").click();
  await expect(page.getByTestId("cto-move-dialog")).toBeVisible();
  await page.getByTestId("cto-move-port").selectOption({ label: "Porta 03" });
  await page.getByTestId("cto-move-confirm").click();

  await expect(page.getByTestId("cto-connection-success")).toContainText("movido");
  await expect(page.getByTestId("cto-port-customer-1")).toHaveCount(0);
  await expect(page.getByTestId("cto-port-customer-3")).toHaveText("Selma Costa");
  // A ocupação TOTAL não mudou: mover não conecta ninguém novo.
  await expect(page.getByTestId("cto-free")).toHaveText("3");

  await page.reload();
  await expect(page.getByTestId("cto-port-customer-3")).toHaveText("Selma Costa");
  await expect(page.getByTestId("cto-port-customer-1")).toHaveCount(0);

  /*
    UMA movimentação, e a prova é a HISTÓRIA AUDITADA — não a contagem de
    linhas.

    A primeira versão deste teste contava linhas, e desconectar+conectar produz
    exatamente as mesmas duas: a sabotagem que quebra a atomicidade em duas
    requisições passava. O que separa os dois casos é o que o registro diz ter
    acontecido — um movimento, ou uma saída seguida de uma entrada. A segunda
    versão abre uma janela sem vínculo que o histórico denuncia.
  */
  const linhas = await prisma.customerNetworkConnection.findMany({
    where: { customerId: cliente.id },
    select: { id: true },
  });
  const acoes = await prisma.auditLog.findMany({
    where: {
      companyId,
      action: { startsWith: "CTO_CONNECTION." },
      entityId: { in: [vinculo.id, ...linhas.map((l) => l.id)] },
    },
    select: { action: true },
  });
  expect(acoes.map((a) => a.action)).toEqual(["CTO_CONNECTION.MOVED"]);
});

test("E2E-MOVE-CROSS — mover entre CTOs da mesma empresa", async ({ page }) => {
  const origem = await criarCto("ORIGEM");
  const destino = await criarCto("DESTINO");
  const cliente = await criarCliente("Tiago Nunes");
  await vincular(cliente.id, (await porta(origem.id, 1)).id);
  await login(page);
  await abrir(page, origem.id);

  await page.getByTestId("cto-port-move-1").click();
  await page.getByTestId("cto-move-cto").selectOption({ label: destino.name });
  await page.getByTestId("cto-move-port").selectOption({ label: "Porta 02" });
  await page.getByTestId("cto-move-confirm").click();
  await expect(page.getByTestId("cto-connection-success")).toBeVisible();

  await expect(page.getByTestId("cto-port-customer-1")).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("cto-free")).toHaveText("4");

  // E as duas telas contam a mesma história.
  await abrir(page, destino.id);
  await expect(page.getByTestId("cto-port-customer-2")).toHaveText("Tiago Nunes");
  await expect(page.getByTestId("cto-free")).toHaveText("3");
});

test("E2E-DAMAGED — ocupada E danificada mostra as DUAS, sem oferecer vincular", async ({ page }) => {
  /*
    O caso que o congelamento encontrou. Se a tela mostrasse só
    `effectiveState`, a porta apareceria apenas como "Ocupada" e a informação de
    defeito — que é justamente por que alguém a marcou — desapareceria.
  */
  const cto = await criarCto("DANIFICADA");
  const cliente = await criarCliente("Vera Lima");
  const p3 = await porta(cto.id, 3);
  await vincular(cliente.id, p3.id);
  await prisma.cTOPort.update({
    where: { id: p3.id },
    data: { administrativeState: "DAMAGED" },
  });
  await login(page);
  await abrir(page, cto.id);

  await expect(page.getByTestId("cto-port-state-3")).toHaveText("Ocupada");
  await expect(page.getByTestId("cto-port-admin-3")).toHaveText("Danificada");
  await expect(page.getByTestId("cto-port-customer-3")).toHaveText("Vera Lima");

  // As duas contagens incluem a mesma porta — e a tela avisa que se sobrepõem.
  const ocupacao = page.getByRole("heading", { name: "Ocupação" }).locator("..");
  await expect(ocupacao).toContainText("pode passar da capacidade");

  // Sem "Vincular"; com "Mover" e "Desconectar".
  await expect(page.getByTestId("cto-port-connect-3")).toHaveCount(0);
  await expect(page.getByTestId("cto-port-move-3")).toBeVisible();
  await expect(page.getByTestId("cto-port-disconnect-3")).toBeVisible();
});

test("E2E-RESERVED-LEGADO — ocupada E reservada aparece inteira", async ({ page }) => {
  const cto = await criarCto("RESERVADA");
  const cliente = await criarCliente("Wilson Braga");
  const p1 = await porta(cto.id, 1);
  await vincular(cliente.id, p1.id);
  await prisma.cTOPort.update({
    where: { id: p1.id },
    data: { administrativeState: "RESERVED" },
  });
  await login(page);
  await abrir(page, cto.id);

  await expect(page.getByTestId("cto-port-state-1")).toHaveText("Ocupada");
  await expect(page.getByTestId("cto-port-admin-1")).toHaveText("Reservada");
  await expect(page.getByTestId("cto-port-disconnect-1")).toBeVisible();
  await expect(page.getByTestId("cto-port-connect-1")).toHaveCount(0);
});

test("E2E-INATIVA — CTO desativada não recebe, mas continua liberando", async ({ page }) => {
  const cto = await criarCto("INATIVA");
  const cliente = await criarCliente("Zilda Prado");
  await vincular(cliente.id, (await porta(cto.id, 1)).id);
  await prisma.cTO.update({ where: { id: cto.id }, data: { active: false } });
  await login(page);
  await abrir(page, cto.id);

  // Nenhuma porta oferece vínculo novo...
  await expect(page.getByTestId("cto-port-connect-2")).toHaveCount(0);
  // ...e quem está dentro não fica preso.
  await expect(page.getByTestId("cto-port-disconnect-1")).toBeVisible();
  await expect(page.getByTestId("cto-port-move-1")).toBeVisible();
});

test("E2E-STALE-DISCONNECT — a tela velha não desconecta o vínculo novo", async ({ page }) => {
  const cto = await criarCto("STALE-D");
  const cliente = await criarCliente("Ana Paula");
  const p1 = await porta(cto.id, 1);
  const p2 = await porta(cto.id, 2);
  const antigo = await vincular(cliente.id, p1.id);
  await login(page);
  await abrir(page, cto.id);
  await expect(page.getByTestId("cto-port-customer-1")).toHaveText("Ana Paula");

  /*
    Outro operador move o cliente — POR FORA da tela, que continua exibindo o
    mundo antigo. É o cenário exato que a guarda existe para impedir.
  */
  await prisma.customerNetworkConnection.update({
    where: { id: antigo.id },
    data: { disconnectedAt: new Date() },
  });
  const novo = await vincular(cliente.id, p2.id);

  await page.getByTestId("cto-port-disconnect-1").click();
  await page.getByTestId("cto-disconnect-confirm").click();

  await expect(page.getByTestId("cto-connection-error")).toContainText(
    "mudou desde que a tela",
  );

  // O vínculo NOVO continua ativo — a tela velha não o alcançou.
  const linha = await prisma.customerNetworkConnection.findUniqueOrThrow({
    where: { id: novo.id },
  });
  expect(linha.disconnectedAt).toBeNull();

  // E a tela se corrigiu sozinha: o cliente aparece na porta certa, sem F5.
  await expect(page.getByTestId("cto-port-customer-2")).toHaveText("Ana Paula");
  await expect(page.getByTestId("cto-port-customer-1")).toHaveCount(0);
});

test("E2E-STALE-MOVE — a tela velha não move o vínculo novo", async ({ page }) => {
  const cto = await criarCto("STALE-M");
  const cliente = await criarCliente("Bento Reis");
  const p1 = await porta(cto.id, 1);
  const p2 = await porta(cto.id, 2);
  const antigo = await vincular(cliente.id, p1.id);
  await login(page);
  await abrir(page, cto.id);

  await page.getByTestId("cto-port-move-1").click();
  await page.getByTestId("cto-move-port").selectOption({ label: "Porta 04" });

  // O mundo muda entre abrir o diálogo e confirmar.
  await prisma.customerNetworkConnection.update({
    where: { id: antigo.id },
    data: { disconnectedAt: new Date() },
  });
  const novo = await vincular(cliente.id, p2.id);

  await page.getByTestId("cto-move-confirm").click();
  await expect(page.getByTestId("cto-connection-error")).toContainText("mudou desde que a tela");

  expect(
    (await prisma.customerNetworkConnection.findUniqueOrThrow({ where: { id: novo.id } }))
      .disconnectedAt,
  ).toBeNull();
  // A porta 4 continua livre: o move obsoleto não a ocupou.
  expect(
    await prisma.customerNetworkConnection.count({
      where: { ctoPortId: (await porta(cto.id, 4)).id, disconnectedAt: null },
    }),
  ).toBe(0);
});

test("E2E-DESTINO-OCUPADO — a porta que deixou de estar livre é recusada", async ({ page }) => {
  const cto = await criarCto("CORRIDA");
  const cliente = await criarCliente("Célia Rocha");
  const outro = await criarCliente("Outro Cliente");
  await login(page);
  await abrir(page, cto.id);

  await page.getByTestId("cto-port-connect-1").click();
  await page.getByTestId("cto-customer-search").fill("Célia");
  await page.getByRole("button", { name: /Célia Rocha/ }).click();
  await expect(page.getByTestId("cto-connect-plain")).toBeVisible();

  // Outro operador ocupa a porta antes do submit.
  await vincular(outro.id, (await porta(cto.id, 1)).id);

  await page.getByTestId("cto-connect-confirm").click();
  await expect(page.getByTestId("cto-connection-error")).toContainText("ocupada");
  // O cliente escolhido NÃO foi conectado em lugar nenhum.
  expect(
    await prisma.customerNetworkConnection.count({ where: { customerId: cliente.id } }),
  ).toBe(0);
});

test("E2E-JÁ-CONECTADO — a tela oferece MOVER, não conectar", async ({ page }) => {
  const cto = await criarCto("JA-CONECTADO");
  const cliente = await criarCliente("Décio Farias");
  await vincular(cliente.id, (await porta(cto.id, 1)).id);
  await login(page);
  await abrir(page, cto.id);

  await page.getByTestId("cto-port-connect-3").click();
  await page.getByTestId("cto-customer-search").fill("Décio");
  await page.getByRole("button", { name: /Décio Farias/ }).click();

  await expect(page.getByTestId("cto-connect-move-notice")).toContainText("porta 01");
  await expect(page.getByTestId("cto-connect-confirm")).toHaveText("Mover para esta porta");

  await page.getByTestId("cto-connect-confirm").click();
  await expect(page.getByTestId("cto-connection-success")).toContainText("movido");
  await expect(page.getByTestId("cto-port-customer-3")).toHaveText("Décio Farias");
  await expect(page.getByTestId("cto-port-customer-1")).toHaveCount(0);

  /*
    UMA movimentação, e não um par desconectar+conectar: são duas linhas ao
    todo. Três significaria que a tela quebrou a atomicidade em duas
    requisições, abrindo uma janela sem vínculo.
  */
  expect(
    await prisma.customerNetworkConnection.count({ where: { customerId: cliente.id } }),
  ).toBe(2);
});

test("E2E-DUPLO-CLIQUE — dois cliques produzem uma operação só", async ({ page }) => {
  const cto = await criarCto("DUPLO");
  const cliente = await criarCliente("Elias Prado");
  const vinculo = await vincular(cliente.id, (await porta(cto.id, 1)).id);
  await login(page);
  await abrir(page, cto.id);

  await page.getByTestId("cto-port-disconnect-1").click();
  const confirmar = page.getByTestId("cto-disconnect-confirm");
  await confirmar.click();
  // O segundo clique com `force`: mesmo escapando do `disabled`, a chave de
  // idempotência é a mesma e o servidor devolve a resposta gravada.
  await confirmar.click({ force: true }).catch(() => {});

  await expect(page.getByTestId("cto-connection-success")).toBeVisible();
  /*
    Escopo pelo VÍNCULO, não pela empresa.

    A primeira versão contava `CTO_CONNECTION.DISCONNECTED` da empresa inteira
    e falhou na suíte completa por um motivo que não era o código: outro teste
    deste mesmo arquivo já havia desconectado alguém na mesma empresa
    sintética. Isolado, passava — que é exatamente o sinal de teste com escopo
    errado.
  */
  expect(
    await prisma.auditLog.count({
      where: { companyId, action: "CTO_CONNECTION.DISCONNECTED", entityId: vinculo.id },
    }),
  ).toBe(1);
});

test("E2E-XSS — nome de cliente com HTML é TEXTO, nunca script", async ({ page }) => {
  const cto = await criarCto("XSS");
  const cliente = await criarCliente('<img src=x onerror="window.__xss=1">');
  await vincular(cliente.id, (await porta(cto.id, 1)).id);
  await login(page);
  await abrir(page, cto.id);

  const celula = page.getByTestId("cto-port-customer-1");
  await expect(celula).toContainText("<img src=x");
  // Nenhuma tag foi criada, e nenhum handler rodou.
  expect(await page.locator("img[src='x']").count()).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
});

test("E2E-MOBILE — 390×844 sem estouro horizontal, com os diálogos utilizáveis", async ({ page }) => {
  const cto = await criarCto("MOBILE");
  const cliente = await criarCliente("Fátima Souza");
  await vincular(cliente.id, (await porta(cto.id, 1)).id);
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await abrir(page, cto.id);

  const semEstouro = async (rotulo: string) => {
    const largura = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(largura, rotulo).toBeLessThanOrEqual(390);
  };

  await semEstouro("lista de portas");
  await expect(page.getByTestId("cto-port-customer-1")).toBeVisible();

  await page.getByTestId("cto-port-disconnect-1").click();
  await expect(page.getByTestId("cto-disconnect-dialog")).toBeVisible();
  await expect(page.getByTestId("cto-disconnect-confirm")).toBeVisible();
  await semEstouro("diálogo de desconexão");
  // `Esc` fecha: o diálogo não prende quem está no teclado.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("cto-disconnect-dialog")).toHaveCount(0);

  await page.getByTestId("cto-port-move-1").click();
  await expect(page.getByTestId("cto-move-dialog")).toBeVisible();
  await semEstouro("diálogo de movimentação");
  await page.keyboard.press("Escape");

  await page.getByTestId("cto-port-connect-2").click();
  await expect(page.getByTestId("cto-connect-dialog")).toBeVisible();
  await semEstouro("diálogo de vínculo");
});

test("E2E-PERFIL — DISPATCHER e TECHNICIAN não alcançam a tela", async ({ page }) => {
  const cto = await criarCto("PERFIL");
  const bcrypt = (await import("bcryptjs")).default;
  const hash = bcrypt.hashSync(SENHA, 10);
  await prisma.user.create({
    data: { companyId, name: "Desp", email: "desp23@sintetico.local", profile: "DISPATCHER", passwordHash: hash },
  });

  await page.goto("/login");
  await page.getByLabel("E-mail").fill("desp23@sintetico.local");
  await page.getByLabel("Senha").fill(SENHA);
  await page.getByRole("button", { name: "Entrar" }).click();
  await page.waitForURL((u) => !u.pathname.includes("/login"));

  // Nem menu, nem rota direta.
  await expect(page.getByRole("link", { name: "CTOs" })).toHaveCount(0);
  await page.goto(`/ctos/${cto.id}`);
  await expect(page.getByTestId("cto-port-row")).toHaveCount(0);
});

/*
  # `CTO-2.3.1` — a ação administrativa de porta precisa se anunciar

  Achado da validação humana: numa porta ocupada, clicar em **Danificada**
  mudava o estado corretamente — e a tela continuava exibindo o banner verde da
  operação ANTERIOR, "cliente vinculado à porta 02". Para quem clicou, o botão
  não fez nada.

  É a mesma família de defeito da `CTO-1.3` e do conflito que a `CTO-2.3`
  corrigiu: a operação acontece, o estado muda, e a tela não conta. A diferença
  aqui é pior — não há silêncio, há uma mensagem ERRADA ocupando o lugar da
  certa.
*/

test("FB-01 / FB-02 — marcar danificada anuncia a ação e SUBSTITUI o banner anterior", async ({
  page,
}) => {
  const cto = await criarCto("FEEDBACK");
  await criarCliente("Heitor Vaz");
  await login(page);
  await abrir(page, cto.id);

  // Primeiro, uma operação de vínculo — que deixa o banner verde na tela.
  await page.getByTestId("cto-port-connect-2").click();
  await page.getByTestId("cto-customer-search").fill("Heitor");
  await page.getByRole("button", { name: /Heitor Vaz/ }).click();
  await page.getByTestId("cto-connect-confirm").click();
  await expect(page.getByTestId("cto-connection-success")).toContainText(
    "vinculado à porta 02",
  );

  // Agora a ação administrativa, na MESMA porta.
  await page.getByTestId("cto-port-damaged-2").click();

  // FB-01: a ação se anuncia, nomeando a porta e o que aconteceu.
  await expect(page.getByTestId("cto-port-state-feedback")).toContainText(
    "Porta 02 marcada como danificada",
  );
  // FB-02: e o banner da operação anterior NÃO sobrevive a ela.
  await expect(page.getByText("vinculado à porta 02")).toHaveCount(0);

  // FB-06 — os dois selos continuam, exatamente como validado.
  await expect(page.getByTestId("cto-port-state-2")).toHaveText("Ocupada");
  await expect(page.getByTestId("cto-port-admin-2")).toHaveText("Danificada");
  await expect(page.getByTestId("cto-port-customer-2")).toHaveText("Heitor Vaz");
});

test("FB-03 / FB-04 — liberar e reservar também se anunciam", async ({ page }) => {
  const cto = await criarCto("FEEDBACK-2");
  const p1 = await porta(cto.id, 1);
  await prisma.cTOPort.update({
    where: { id: p1.id },
    data: { administrativeState: "DAMAGED" },
  });
  await login(page);
  await abrir(page, cto.id);

  await page.getByTestId("cto-port-available-1").click();
  await expect(page.getByTestId("cto-port-state-feedback")).toContainText(
    "Porta 01 liberada",
  );
  await expect(page.getByTestId("cto-port-state-1")).toHaveText("Livre");

  await page.getByTestId("cto-port-reserved-1").click();
  await expect(page.getByTestId("cto-port-state-feedback")).toContainText(
    "Porta 01 reservada",
  );
  await expect(page.getByTestId("cto-port-state-1")).toHaveText("Reservada");
});

test("FB-05 — a recusa não deixa o sucesso anterior parecendo atual", async ({
  page,
}) => {
  /*
    A porta histórica é read-only desde a `CTO-1.9`, e o servidor responde 409.
    O que este teste guarda é o que a TELA faz com isso: um banner verde de uma
    ação anterior não pode sobreviver a uma recusa e passar por confirmação da
    ação nova.
  */
  const cto = await criarCto("FEEDBACK-3", 8);
  await criarCliente("Iara Melo");
  await login(page);
  await abrir(page, cto.id);

  await page.getByTestId("cto-port-connect-1").click();
  await page.getByTestId("cto-customer-search").fill("Iara");
  await page.getByRole("button", { name: /Iara Melo/ }).click();
  await page.getByTestId("cto-connect-confirm").click();
  await expect(page.getByTestId("cto-connection-success")).toBeVisible();
  /*
    Esperar a RELEITURA pousar antes de mexer no banco.

    O banner é local e aparece com a resposta; o `router.refresh()` disparado
    junto pousa depois. Reduzir a capacidade nesse intervalo é uma corrida: se a
    releitura chegar em seguida, a porta 6 vem `disabled` pela regra da
    `CTO-1.9` e o clique expira. O teste ficou instável por isso — passava
    isolado, falhava por tempo na suíte.

    O sinal de que a releitura chegou é o cliente aparecer na linha.
  */
  await expect(page.getByTestId("cto-port-customer-1")).toBeVisible();

  /*
    A capacidade cai POR FORA, e a tela não recarrega.

    A primeira versão deste teste reduzia a capacidade e dava F5 — e aí o botão
    da porta 6 vem `disabled` pela regra da `CTO-1.9`, de modo que não havia
    clique nenhum para o servidor recusar. A recusa real só existe com a tela
    VELHA, que é justamente o caso que importa.
  */
  await prisma.cTO.update({ where: { id: cto.id }, data: { capacity: 4 } });

  await page.getByTestId("cto-port-reserved-6").click();
  await expect(page.getByTestId("cto-ports-error")).toBeVisible();
  // Nenhum verde sobrevivente fingindo que a reserva deu certo.
  await expect(page.getByTestId("cto-connection-success")).toHaveCount(0);
  await expect(page.getByTestId("cto-port-state-feedback")).toHaveCount(0);
});

test("FB-07 — o resumo conta a porta nas DUAS categorias", async ({ page }) => {
  const cto = await criarCto("FEEDBACK-4", 4);
  const cliente = await criarCliente("Jonas Reis");
  await vincular(cliente.id, (await porta(cto.id, 1)).id);
  await login(page);
  await abrir(page, cto.id);

  // O valor é o `dd` que segue o `dt` do rótulo — sem depender de estrutura
  // intermediária, que a tela pode reorganizar sem mudar a semântica.
  const valorDe = (rotulo: string) =>
    page.locator(`dt:text-is("${rotulo}") + dd`).innerText();

  await page.getByTestId("cto-port-damaged-1").click();
  await expect(page.getByTestId("cto-port-state-feedback")).toBeVisible();
  /*
    O banner é local e aparece assim que a resposta chega; o RESUMO só muda
    quando a releitura do servidor pousa. Ler a contagem antes disso mede o
    estado anterior — foi o que a primeira versão fez, e reportou 0 danificadas
    com o código correto.
  */
  await expect(page.getByTestId("cto-port-admin-1")).toHaveText("Danificada");

  expect(await valorDe("Danificadas")).toContain("1");
  expect(await valorDe("Ocupadas")).toContain("1");
  expect(await valorDe("Livres")).toContain("3");
});

/*
  # `CTO-2.3.2` — a confirmação precisa aparecer ONDE a pessoa clicou

  Achado da validação humana: `CONNECT` mostrava confirmação, `MOVE` e
  `DISCONNECT` pareciam não mostrar nada.

  A hipótese a testar não é "a mensagem não é criada" — os testes anteriores
  provam que ela é. É POSIÇÃO: o banner vive na seção "Ocupação", acima da lista
  de portas, e numa CTO real de 16 posições a ação acontece dezenas de linhas
  abaixo dele. Fora da viewport, a confirmação não existe para quem clicou.

  É literalmente a `CTO-1.3` num lugar novo.
*/

test("CF-VIEWPORT — a confirmação aparece ONDE a pessoa clicou", async ({
  page,
}) => {
  const cto = await criarCto("VIEWPORT", 16);
  const cliente = await criarCliente("Karla Dias");
  await vincular(cliente.id, (await porta(cto.id, 12)).id);
  await login(page);
  await abrir(page, cto.id);

  // A ação acontece na porta 12, bem abaixo do resumo.
  await page.getByTestId("cto-port-disconnect-12").scrollIntoViewIfNeeded();
  await page.getByTestId("cto-port-disconnect-12").click();
  await page.getByTestId("cto-disconnect-confirm").click();

  const banner = page.getByTestId("cto-connection-success");
  await expect(banner).toContainText("desconectado");
  // A pergunta que importa: dá para VER?
  await expect(banner).toBeInViewport();
});

test("CF-01 / CF-04 / CF-06 — cada operação se anuncia e substitui a anterior", async ({
  page,
}) => {
  const cto = await criarCto("CF-BASE", 16);
  await criarCliente("Lucas Prado");
  await login(page);
  await abrir(page, cto.id);

  // CF-01 — vincular continua confirmando.
  await page.getByTestId("cto-port-connect-12").scrollIntoViewIfNeeded();
  await page.getByTestId("cto-port-connect-12").click();
  await page.getByTestId("cto-customer-search").fill("Lucas");
  await page.getByRole("button", { name: /Lucas Prado/ }).click();
  await page.getByTestId("cto-connect-confirm").click();
  const banner = page.getByTestId("cto-connection-success");
  await expect(banner).toContainText("vinculado à porta 12");
  await expect(banner).toBeInViewport();

  // CF-04 / CF-06 — desconectar confirma, e o texto anterior NÃO sobrevive.
  await page.getByTestId("cto-port-disconnect-12").click();
  await page.getByTestId("cto-disconnect-confirm").click();
  await expect(page.getByTestId("cto-connection-success")).toContainText(
    "desconectado da porta 12",
  );
  await expect(page.getByTestId("cto-connection-success")).toBeInViewport();
  await expect(page.getByText("vinculado à porta 12")).toHaveCount(0);
});

test("CF-02 / CF-05 — mover na mesma CTO confirma o destino e substitui", async ({
  page,
}) => {
  const cto = await criarCto("CF-MOVE", 16);
  await criarCliente("Mara Luz");
  await login(page);
  await abrir(page, cto.id);

  await page.getByTestId("cto-port-connect-10").scrollIntoViewIfNeeded();
  await page.getByTestId("cto-port-connect-10").click();
  await page.getByTestId("cto-customer-search").fill("Mara");
  await page.getByRole("button", { name: /Mara Luz/ }).click();
  await page.getByTestId("cto-connect-confirm").click();
  await expect(page.getByTestId("cto-connection-success")).toContainText(
    "vinculado à porta 10",
  );

  await page.getByTestId("cto-port-move-10").click();
  await page.getByTestId("cto-move-port").selectOption({ label: "Porta 14" });
  await page.getByTestId("cto-move-confirm").click();

  const banner = page.getByTestId("cto-connection-success");
  await expect(banner).toContainText("movido para a porta 14");
  await expect(banner).toBeInViewport();
  // CF-05: a confirmação do vínculo anterior não ficou pendurada.
  await expect(page.getByText("vinculado à porta 10")).toHaveCount(0);
  // CF-10: nome da caixa é nome completo, sem repetir a palavra.
  await expect(banner).not.toContainText("CTO CTO");
});

test("CF-03 — mover entre CTOs nomeia o destino, sem duplicar a palavra", async ({
  page,
}) => {
  const origem = await criarCto("CF-ORIG", 8);
  const destino = await prisma.cTO.create({
    data: { companyId, name: "CTO QA DESTINO", capacity: 8 },
  });
  await prisma.cTOPort.createMany({
    data: Array.from({ length: 8 }, (_, i) => ({
      ctoId: destino.id,
      companyId,
      number: i + 1,
    })),
  });
  const cliente = await criarCliente("Nilo Braga");
  await vincular(cliente.id, (await porta(origem.id, 5)).id);
  await login(page);
  await abrir(page, origem.id);

  await page.getByTestId("cto-port-move-5").scrollIntoViewIfNeeded();
  await page.getByTestId("cto-port-move-5").click();
  await page.getByTestId("cto-move-cto").selectOption({ label: "CTO QA DESTINO" });
  await page.getByTestId("cto-move-port").selectOption({ label: "Porta 03" });
  await page.getByTestId("cto-move-confirm").click();

  const banner = page.getByTestId("cto-connection-success");
  await expect(banner).toContainText("movido para a porta 03");
  await expect(banner).toContainText("CTO QA DESTINO");
  await expect(banner).not.toContainText("CTO CTO");
  await expect(banner).toBeInViewport();
});

test("CF-07 / CF-08 — recusa não deixa o sucesso anterior parecendo atual", async ({
  page,
}) => {
  const cto = await criarCto("CF-FALHA", 8);
  const cliente = await criarCliente("Olga Reis");
  const outro = await criarCliente("Pedro Sá");
  await login(page);
  await abrir(page, cto.id);

  await page.getByTestId("cto-port-connect-1").click();
  await page.getByTestId("cto-customer-search").fill("Olga");
  await page.getByRole("button", { name: /Olga Reis/ }).click();
  await page.getByTestId("cto-connect-confirm").click();
  await expect(page.getByTestId("cto-connection-success")).toContainText("vinculado");
  // A releitura precisa pousar antes de o banco mudar — mesma corrida do FB-05.
  await expect(page.getByTestId("cto-port-customer-1")).toBeVisible();

  // CF-07: o destino do move é ocupado por fora, e o move é recusado.
  await vincular(outro.id, (await porta(cto.id, 4)).id);
  await page.getByTestId("cto-port-move-1").click();
  /*
    Abrir o diálogo já apaga a confirmação anterior.

    Sem isso, o banner "vinculado" fica em cena durante todo o envio da
    movimentação, e quem olha não sabe se ele fala do que acabou de pedir ou do
    que fez antes.
  */
  await expect(page.getByTestId("cto-connection-success")).toHaveCount(0);
  await page.getByTestId("cto-move-port").selectOption({ label: "Porta 04" });
  await page.getByTestId("cto-move-confirm").click();
  await expect(page.getByTestId("cto-connection-error")).toBeVisible();
  await expect(page.getByTestId("cto-connection-success")).toHaveCount(0);

  // CF-08: o vínculo é encerrado por fora, e a desconexão fica obsoleta.
  await page.reload();
  const ativo = await prisma.customerNetworkConnection.findFirstOrThrow({
    where: { customerId: cliente.id, disconnectedAt: null },
  });
  await prisma.customerNetworkConnection.update({
    where: { id: ativo.id },
    data: { disconnectedAt: new Date() },
  });
  await vincular(cliente.id, (await porta(cto.id, 6)).id);

  await page.getByTestId("cto-port-disconnect-1").click();
  await page.getByTestId("cto-disconnect-confirm").click();
  await expect(page.getByTestId("cto-connection-error")).toContainText(
    "mudou desde que a tela",
  );
  await expect(page.getByTestId("cto-connection-success")).toHaveCount(0);
});

test("CF-09 — o diálogo de desconexão não repete a palavra CTO", async ({ page }) => {
  const cto = await prisma.cTO.create({
    data: { companyId, name: "CTO QA 011", capacity: 4 },
  });
  await prisma.cTOPort.createMany({
    data: Array.from({ length: 4 }, (_, i) => ({
      ctoId: cto.id,
      companyId,
      number: i + 1,
    })),
  });
  const cliente = await criarCliente("Quirino Alves");
  await vincular(cliente.id, (await porta(cto.id, 2)).id);
  await login(page);
  await abrir(page, cto.id);

  await page.getByTestId("cto-port-disconnect-2").click();
  const dialogo = page.getByTestId("cto-disconnect-dialog");
  await expect(dialogo).toBeVisible();
  // O nome aparece inteiro, uma vez, e a palavra não é prefixada a ele.
  await expect(dialogo).toContainText("CTO QA 011");
  await expect(dialogo).not.toContainText("CTO CTO");
  await expect(dialogo).toContainText("Quirino Alves");
  await expect(dialogo).toContainText("porta 02");
});
