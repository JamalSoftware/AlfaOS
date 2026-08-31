import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { assertTestDatabase } from "./test-db-guard";

/**
 * Painel de despacho, pelo navegador (`P-W1`–`P-W12`).
 *
 * O que só se prova aqui: que a tela obedece ao backend. Os testes de rota
 * (`src/tests/dispatch-queue-api.test.ts`) já provam a API; este prova que a
 * página **não** inventa posição, **não** engole 409 e **não** depende de
 * arrastar para ser operável.
 */

const ADMIN_EMAIL = "admin@alfatelecom.local";
const DISPATCHER_EMAIL = "dispatcher@alfatelecom.local";
const TECH_EMAIL = "tech@alfatelecom.local";
const TECH2_EMAIL = "tech2@alfatelecom.local";
const PASSWORD = "AlfaOS@2026";

const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgresql://alfaos:alfaos_dev_password@localhost:5432/alfaos_test?schema=public";

const prisma = new PrismaClient({
  datasources: { db: { url: E2E_DATABASE_URL } },
});

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Senha").fill(PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
  await page.waitForURL(/\/(dashboard|minhas-os)/);
}

let companyId = "";
let techId = "";
let numeros: number[] = [];

/** Marcador do fixture: é por ele que a limpeza acha o que este spec criou. */
const CLIENTE_FIXTURE = "Cliente Fila Teste";

/**
 * Os `Technician` que ESTE spec criou, para desfazer no fim.
 *
 * O seed cria usuários com perfil TECHNICIAN, mas **não** os vincula a um
 * `Technician` — e `service-orders.spec.ts` depende exatamente disso: a tela
 * "novo técnico" só lista usuários ainda não vinculados. Deixar o vínculo para
 * trás some com a opção e derruba aquele spec, que roda depois deste na ordem
 * alfabética.
 */
const techniciansCriados: string[] = [];

/**
 * Apaga tudo o que este spec cria, e **nada mais**.
 *
 * Não é higiene opcional. A suíte E2E compartilha um banco só, e um spec que
 * deixa quatro OS `ASSIGNED` para o técnico do seed quebra quem vier depois
 * lendo `/minhas-os` — foi exatamente o que aconteceu: os testes passavam
 * isolados e derrubavam `technician-execution` e `team-workday` na suíte
 * inteira.
 *
 * A ordem segue as FKs: entradas, depois OS, depois cliente.
 */
async function limparFixture() {
  const clientes = await prisma.customer.findMany({
    where: { name: CLIENTE_FIXTURE },
    select: { id: true },
  });
  const ids = clientes.map((c) => c.id);
  if (ids.length === 0) return;

  const ordens = await prisma.serviceOrder.findMany({
    where: { customerId: { in: ids } },
    select: { id: true },
  });
  const ordemIds = ordens.map((o) => o.id);

  await prisma.technicianDispatchQueueEntry.deleteMany({
    where: { serviceOrderId: { in: ordemIds } },
  });
  await prisma.serviceOrderEvent.deleteMany({
    where: { serviceOrderId: { in: ordemIds } },
  });
  await prisma.serviceOrder.deleteMany({ where: { id: { in: ordemIds } } });
  await prisma.technicianDispatchQueue.deleteMany({
    where: { companyId, entries: { none: {} } },
  });
  await prisma.customer.deleteMany({ where: { id: { in: ids } } });
}

/**
 * Uma fila de quatro OS: uma urgente e três normais.
 *
 * Escrita direto no banco — é fixture, não o que está sob teste. O estado
 * resultante é o mesmo que o backfill produz, e toda operação da tela a partir
 * daqui passa pela API de verdade.
 */
async function seedQueue() {
  const tech = await prisma.user.findUniqueOrThrow({
    where: { email: TECH_EMAIL },
    select: { id: true, companyId: true },
  });
  const tech2 = await prisma.user.findUniqueOrThrow({
    where: { email: TECH2_EMAIL },
    select: { id: true },
  });
  companyId = tech.companyId;

  for (const userId of [tech.id, tech2.id]) {
    const existente = await prisma.technician.findFirst({ where: { userId } });
    if (!existente) {
      const criado = await prisma.technician.create({
        data: { companyId, userId },
      });
      techniciansCriados.push(criado.id);
    }
  }
  techId = (
    await prisma.technician.findFirstOrThrow({ where: { userId: tech.id } })
  ).id;

  await limparFixture();

  const customer = await prisma.customer.create({
    data: {
      companyId,
      name: CLIENTE_FIXTURE,
      district: "Centro",
      city: "Guaçuí",
    },
  });

  const criadas: { id: string; number: number }[] = [];
  for (const priority of ["URGENT", "NORMAL", "NORMAL", "NORMAL"] as const) {
    const counter = await prisma.serviceOrderCounter.upsert({
      where: { companyId },
      create: { companyId, lastNumber: 1 },
      update: { lastNumber: { increment: 1 } },
    });
    criadas.push(
      await prisma.serviceOrder.create({
        data: {
          companyId,
          customerId: customer.id,
          technicianId: techId,
          number: counter.lastNumber,
          type: "Instalação",
          description: "OS da fila operacional",
          priority,
          status: "ASSIGNED",
          assignedAt: new Date(),
        },
        select: { id: true, number: true },
      }),
    );
  }

  const queue = await prisma.technicianDispatchQueue.create({
    data: { companyId, technicianId: techId },
  });
  for (let index = 0; index < criadas.length; index += 1) {
    const os = criadas[index];
    await prisma.technicianDispatchQueueEntry.create({
      data: {
        companyId,
        queueId: queue.id,
        serviceOrderId: os.id,
        position: index + 1,
      },
    });
  }

  numeros = criadas.map((o) => o.number);
}

test.beforeAll(async () => {
  await assertTestDatabase(E2E_DATABASE_URL, "E2E_DATABASE_URL");
});

test.beforeEach(async () => {
  await seedQueue();
});

test.afterAll(async () => {
  /*
    O spec devolve o banco como o encontrou.

    Não é zelo: a suíte E2E compartilha um banco só e roda em um worker. Deixar
    OS atribuídas para trás quebrou `technician-execution` e `team-workday`;
    deixar o vínculo de técnico quebrou `service-orders`. Os dois só apareceram
    na suíte inteira — isolados, estes testes passavam.
  */
  await limparFixture();
  if (techniciansCriados.length > 0) {
    await prisma.technicianDispatchQueue.deleteMany({
      where: { technicianId: { in: techniciansCriados } },
    });
    await prisma.technician.deleteMany({
      where: { id: { in: techniciansCriados } },
    });
  }
  await prisma.$disconnect();
});

/** Os números das OS na ordem em que a tela os mostra, AGORA. */
async function ordemNaTela(page: Page): Promise<number[]> {
  const itens = page.locator('[data-testid^="queue-item-"]');
  await expect(itens.first()).toBeVisible();
  const ids = await itens.evaluateAll((nodes) =>
    nodes.map((n) => n.getAttribute("data-testid") ?? ""),
  );
  return ids.map((id) => Number(id.replace("queue-item-", "")));
}

/**
 * A ordem esperada, com reexecução até a resposta do servidor chegar.
 *
 * `expect(await ordemNaTela(...)).toEqual(...)` lê o DOM **uma vez** e não
 * reexecuta: entre o clique e a substituição do estado pela resposta cabe um
 * `fetch` inteiro, e a primeira versão destes testes falhava acusando o painel
 * quando o que faltava era esperar. `expect.poll` reexecuta até bater ou
 * estourar.
 */
async function esperarOrdem(page: Page, esperada: number[]): Promise<void> {
  await expect
    .poll(() => ordemNaTela(page), { timeout: 10_000 })
    .toEqual(esperada);
}

async function abrirDespacho(page: Page) {
  await page.goto("/despacho");
  await expect(page.getByTestId("dispatch-panel")).toBeVisible();
  await expect(page.locator('[data-testid^="queue-item-"]').first()).toBeVisible();
}

test.describe("P-W1..P-W3 · acesso", () => {
  test("P-W1 · ADMIN acessa /despacho pelo menu", async ({ page }) => {
    await login(page, ADMIN_EMAIL);
    await page.getByRole("link", { name: "Despacho" }).first().click();
    await page.waitForURL("**/despacho");
    await expect(
      page.getByRole("heading", { name: "Despacho", level: 1 }),
    ).toBeVisible();
  });

  test("P-W2 · DISPATCHER acessa", async ({ page }) => {
    await login(page, DISPATCHER_EMAIL);
    await page.goto("/despacho");
    await expect(page.getByTestId("dispatch-panel")).toBeVisible();
  });

  test("P-W3 · TECHNICIAN não vê o menu nem opera a tela", async ({ page }) => {
    await login(page, TECH_EMAIL);
    /*
      Defesa em profundidade: o menu não oferece, e a rota redireciona. Quem
      recusa de verdade continua sendo a API, testada em `dispatch-queue-api`.

      A asserção é escopada à NAVEGAÇÃO e com nome exato. `getByRole(name:)`
      casa por substring na página inteira, e a primeira versão deste teste
      falhou acusando o menu quando o que casava eram OS de um cliente cujo
      nome de fixture continha a palavra.
    */
    await expect(
      page.getByRole("navigation").getByRole("link", {
        name: "Despacho",
        exact: true,
      }),
    ).toHaveCount(0);
    await page.goto("/despacho");
    await expect(page.getByTestId("dispatch-panel")).toHaveCount(0);
  });
});

test.describe("P-W4 · fila ordenada", () => {
  test("mostra a ordem do backend, com posição e rótulo textual", async ({
    page,
  }) => {
    await login(page, ADMIN_EMAIL);
    await abrirDespacho(page);

    await esperarOrdem(page, numeros);

    // Posição visível: 1ª, 2ª, 3ª — sem contar linhas.
    await expect(page.getByTestId(`position-${numeros[0]}`)).toHaveText("1ª");
    await expect(page.getByTestId(`position-${numeros[3]}`)).toHaveText("4ª");

    // Prioridade com RÓTULO, nunca só cor.
    const primeiro = page.getByTestId(`queue-item-${numeros[0]}`);
    await expect(primeiro.getByText("Urgente")).toBeVisible();
  });

  test("resumo do técnico usa só dados do DTO", async ({ page }) => {
    await login(page, ADMIN_EMAIL);
    await abrirDespacho(page);
    const resumo = page.getByTestId("queue-summary");
    await expect(resumo).toContainText("0 em atendimento");
    await expect(resumo).toContainText("4 na fila");
    await expect(resumo).toContainText("1 urgente");
  });
});

test.describe("P-W5, P-W6 · prioridade", () => {
  test("P-W5/P-W6 · NORMAL vira URGENTE e assume a posição que o backend devolveu", async ({
    page,
  }) => {
    await login(page, ADMIN_EMAIL);
    await abrirDespacho(page);

    // A última da fila, uma NORMAL.
    const alvo = numeros[3];
    await page.getByTestId(`quick-priority-${alvo}`).click();

    await expect(
      page.getByTestId(`queue-item-${alvo}`).getByText("Urgente"),
    ).toBeVisible();

    /*
      A posição é a EFETIVA, não a suposta.

      Promover manda para o FIM da banda urgente — atrás da urgente que já
      estava lá —, e não para a posição 1. Uma tela que "corrigisse" isso
      localmente mostraria 1ª e mentiria.
    */
    await expect(page.getByTestId(`position-${alvo}`)).toHaveText("2ª");
    await esperarOrdem(page, [
      numeros[0],
      alvo,
      numeros[1],
      numeros[2],
    ]);
  });
});

test.describe("P-W7, P-W8 · reordenação", () => {
  test("P-W7 · move a 3ª para a 1ª pelo teclado", async ({ page }) => {
    await login(page, ADMIN_EMAIL);
    await abrirDespacho(page);

    // A 3ª é NORMAL; a 1ª é URGENTE. Pedir a posição 1 é acomodado para a 2ª.
    await page.getByTestId(`move-to-${numeros[2]}`).click();
    await page.getByTestId(`move-input-${numeros[2]}`).fill("1");
    await page.getByTestId(`move-confirm-${numeros[2]}`).click();

    await esperarOrdem(page, [
      numeros[0],
      numeros[2],
      numeros[1],
      numeros[3],
    ]);
  });

  test("duas reordenações seguidas funcionam — a versão vem da resposta", async ({
    page,
  }) => {
    /*
      O teste que faltava, encontrado por sabotagem.

      Uma mutação sozinha passa mesmo que a tela guarde a `queueVersion`
      antiga: o token só é conferido na PRÓXIMA escrita. Aqui a segunda
      reordenação usa a versão que veio da resposta da primeira — e, se a tela
      reaproveitasse a velha, o servidor recusaria com 409 e o aviso de
      conflito apareceria sem que ninguém tivesse mexido em nada.
    */
    await login(page, ADMIN_EMAIL);
    await abrirDespacho(page);

    await page.getByTestId(`move-down-${numeros[1]}`).click();
    await esperarOrdem(page, [
      numeros[0],
      numeros[2],
      numeros[1],
      numeros[3],
    ]);

    await page.getByTestId(`move-down-${numeros[1]}`).click();
    await esperarOrdem(page, [
      numeros[0],
      numeros[2],
      numeros[3],
      numeros[1],
    ]);

    // Nenhum conflito: a segunda escrita usou a versão que a primeira devolveu.
    await expect(page.getByTestId("queue-conflict")).toHaveCount(0);
  });

  test("P-W8 · a acomodação de banda fica visível", async ({ page }) => {
    await login(page, ADMIN_EMAIL);
    await abrirDespacho(page);

    const normal = numeros[3];
    await page.getByTestId(`move-to-${normal}`).click();
    await page.getByTestId(`move-input-${normal}`).fill("1");
    await page.getByTestId(`move-confirm-${normal}`).click();

    // Pediu 1ª, ficou 2ª: a urgente continua na frente, e a tela mostra o que
    // de fato aconteceu.
    await expect(page.getByTestId(`position-${normal}`)).toHaveText("2ª");
    await expect(page.getByTestId(`position-${numeros[0]}`)).toHaveText("1ª");
  });
});

test.describe("P-W9, P-W10 · conflito de versão", () => {
  test("uma segunda aba muda a fila; a primeira recebe 409, avisa e recarrega", async ({
    browser,
  }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    await login(pageA, ADMIN_EMAIL);
    await login(pageB, DISPATCHER_EMAIL);
    await abrirDespacho(pageA);
    await abrirDespacho(pageB);

    // B move e commita: a versão que A tem na tela envelhece.
    await pageB.getByTestId(`move-to-${numeros[3]}`).click();
    await pageB.getByTestId(`move-input-${numeros[3]}`).fill("2");
    await pageB.getByTestId(`move-confirm-${numeros[3]}`).click();
    await expect(pageB.getByTestId(`position-${numeros[3]}`)).toHaveText("2ª");

    // A age sobre a leitura antiga.
    await pageA.getByTestId(`move-to-${numeros[1]}`).click();
    await pageA.getByTestId(`move-input-${numeros[1]}`).fill("2");
    await pageA.getByTestId(`move-confirm-${numeros[1]}`).click();

    // Avisa, e NÃO sobrescreve.
    const aviso = pageA.getByTestId("queue-conflict");
    await expect(aviso).toBeVisible();
    await expect(aviso).toContainText("alterada por outro usuário");

    // E recarrega: a tela de A passa a mostrar o que B fez.
    await expect(pageA.getByTestId(`position-${numeros[3]}`)).toHaveText("2ª");

    await contextA.close();
    await contextB.close();
  });
});

test.describe("P-W11 · reatribuição", () => {
  test("move a OS para outro técnico e some desta fila", async ({ page }) => {
    await login(page, ADMIN_EMAIL);
    await abrirDespacho(page);

    const alvo = numeros[1];
    page.once("dialog", (d) => void d.accept());
    await page.getByTestId(`reassign-${alvo}`).click();
    const select = page.getByTestId(`reassign-select-${alvo}`);
    await select.selectOption({ index: 1 });
    await page.getByTestId(`reassign-confirm-${alvo}`).click();

    await expect(page.getByTestId(`queue-item-${alvo}`)).toHaveCount(0);
    await esperarOrdem(page, [
      numeros[0],
      numeros[2],
      numeros[3],
    ]);
  });
});

test.describe("double-submit", () => {
  test("enquanto a reatribuição corre, a tela não aceita outro comando", async ({
    page,
  }) => {
    /*
      `/assign` NÃO exige `Idempotency-Key` — risco conhecido e registrado. A
      proteção possível é de tela, e é esta: enquanto a requisição corre,
      nenhuma ação da fila aceita clique.

      A requisição é atrasada de propósito, para que o meio do voo seja um
      instante observável em vez de uma corrida com o relógio.
    */
    await login(page, ADMIN_EMAIL);
    await abrirDespacho(page);

    await page.route("**/api/service-orders/*/assign", async (route) => {
      await new Promise((r) => setTimeout(r, 1500));
      await route.continue();
    });

    const alvo = numeros[1];
    page.once("dialog", (d) => void d.accept());
    await page.getByTestId(`reassign-${alvo}`).click();
    await page
      .getByTestId(`reassign-select-${alvo}`)
      .selectOption({ index: 1 });
    await page.getByTestId(`reassign-confirm-${alvo}`).click();

    // Em voo: nem esta OS nem as outras aceitam comando.
    await expect(page.getByTestId(`move-down-${numeros[2]}`)).toBeDisabled();
    await expect(page.getByTestId(`quick-priority-${numeros[2]}`)).toBeDisabled();

    // E terminou com UMA reatribuição só.
    await expect(page.getByTestId(`queue-item-${alvo}`)).toHaveCount(0);
    await expect(page.getByTestId(`move-down-${numeros[2]}`)).toBeEnabled();
  });
});

test.describe("P-W12 · operável só pelo teclado", () => {
  test("subir e descer sem arrastar, e sem mouse", async ({ page }) => {
    await login(page, ADMIN_EMAIL);
    await abrirDespacho(page);

    /*
      Arrastar é conveniência. O que precisa funcionar é isto: chegar ao botão
      pelo Tab e acioná-lo pelo Enter, sem ponteiro nenhum.
    */
    const descer = page.getByTestId(`move-down-${numeros[1]}`);
    await descer.focus();
    await expect(descer).toBeFocused();
    await page.keyboard.press("Enter");

    await esperarOrdem(page, [
      numeros[0],
      numeros[2],
      numeros[1],
      numeros[3],
    ]);
  });

  test("as ações têm rótulo acessível", async ({ page }) => {
    await login(page, ADMIN_EMAIL);
    await abrirDespacho(page);

    await expect(
      page.getByRole("button", { name: `Subir a OS ${numeros[1]} na fila` }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: `Descer a OS ${numeros[1]} na fila` }),
    ).toBeVisible();
  });

  test("a primeira não sobe e a última não desce", async ({ page }) => {
    await login(page, ADMIN_EMAIL);
    await abrirDespacho(page);

    await expect(page.getByTestId(`move-up-${numeros[0]}`)).toBeDisabled();
    await expect(page.getByTestId(`move-down-${numeros[3]}`)).toBeDisabled();
  });
});

test.describe("seletor completo de prioridade", () => {
  test("alcança LOW e HIGH, que a ação rápida não cobre", async ({ page }) => {
    await login(page, ADMIN_EMAIL);
    await abrirDespacho(page);

    const alvo = numeros[1];
    await page.getByTestId(`priority-menu-${alvo}`).click();
    const opcoes = page.getByTestId(`priority-options-${alvo}`);
    await expect(opcoes.getByRole("button", { name: "Baixa" })).toBeVisible();
    await expect(opcoes.getByRole("button", { name: "Alta" })).toBeVisible();

    await opcoes.getByRole("button", { name: "Alta" }).click();
    await expect(
      page.getByTestId(`queue-item-${alvo}`).getByText("Alta"),
    ).toBeVisible();
    // HIGH fica atrás da urgente e à frente das normais.
    await expect(page.getByTestId(`position-${alvo}`)).toHaveText("2ª");
  });
});

test.describe("arrastar", () => {
  test("o gesto vira o MESMO comando absoluto das setas", async ({ page }) => {
    await login(page, ADMIN_EMAIL);
    await abrirDespacho(page);

    /*
      `dragTo` do Playwright move o ponteiro, mas NÃO carrega um `DataTransfer`
      — e o HTML5 nativo depende dele para o `drop` saber o que foi arrastado.
      O gesto é reproduzido aqui despachando os três eventos com um
      `DataTransfer` de verdade, que é o que o navegador faz.
    */
    await page.evaluate(
      ([origemId, destinoId]) => {
        const origem = document.querySelector(
          `[data-testid="queue-item-${origemId}"]`,
        );
        const destino = document.querySelector(
          `[data-testid="queue-item-${destinoId}"]`,
        );
        if (!origem || !destino) throw new Error("cartão não encontrado");
        const dt = new DataTransfer();
        origem.dispatchEvent(
          new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }),
        );
        destino.dispatchEvent(
          new DragEvent("dragover", { bubbles: true, dataTransfer: dt }),
        );
        destino.dispatchEvent(
          new DragEvent("drop", { bubbles: true, dataTransfer: dt }),
        );
      },
      [numeros[3], numeros[1]] as const,
    );

    await esperarOrdem(page, [
      numeros[0],
      numeros[3],
      numeros[1],
      numeros[2],
    ]);
  });
});
