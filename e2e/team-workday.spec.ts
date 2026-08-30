import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { assertTestDatabase } from "./test-db-guard";

/**
 * Jornada da equipe, pelo navegador.
 *
 * O que só se prova aqui: que a página monta, que o item de menu leva a ela e
 * que o DISPATCHER vê a lista sem receber a fila de correções — a assimetria de
 * papel que o PRD §231 fixou.
 *
 * Os testes de rota (`src/tests/time-clock-security.test.ts`) já provam a
 * recusa da API. Este prova o caminho que a pessoa percorre.
 */

const ADMIN_EMAIL = "admin@alfatelecom.local";
/** O segundo aprovador. A regra de quatro olhos da §253 (LOW-1) depende dele. */
const ADMIN2_EMAIL = "admin2@alfatelecom.local";
const DISPATCHER_EMAIL = "dispatcher@alfatelecom.local";
const TECH_EMAIL = "tech@alfatelecom.local";
const PASSWORD = "AlfaOS@2026";

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Senha").fill(PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
  await page.waitForURL(/\/(dashboard|minhas-os)/);
}

const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgresql://alfaos:alfaos_dev_password@localhost:5432/alfaos_test?schema=public";

const prisma = new PrismaClient({
  datasources: { db: { url: E2E_DATABASE_URL } },
});

/** O dia esquecido, semeado no passado. Preenchido no `beforeAll`. */
let diaEsquecido = "";
let techUserId = "";

test.beforeAll(async () => {
  // Mesmo guard de todo caminho destrutivo da suíte: nunca um banco que não
  // termine em `_test`.
  await assertTestDatabase(E2E_DATABASE_URL, "E2E_DATABASE_URL");

  const tech = await prisma.user.findUniqueOrThrow({
    where: { email: TECH_EMAIL },
    select: { id: true, companyId: true },
  });
  techUserId = tech.id;

  /*
    Um dia de 12 dias atrás com ENTRADA e sem SAÍDA.

    É o caso do JOR-A1: antes da correção, este dia devolvia centenas de horas.
    Depois dela, devolve o tempo confirmado — zero, porque nenhum período
    fechou — e a inconsistência que explica o número.

    11h UTC cai no mesmo dia civil em qualquer fuso brasileiro, então a
    fixture não muda de dia conforme a hora em que a suíte roda.
  */
  const alvo = new Date(Date.now() - 12 * 24 * 3_600_000);
  diaEsquecido = alvo.toISOString().slice(0, 10);

  const workday = await prisma.workday.create({
    data: {
      companyId: tech.companyId,
      userId: tech.id,
      date: new Date(`${diaEsquecido}T00:00:00.000Z`),
      timezone: "America/Sao_Paulo",
    },
  });
  await prisma.timeEntry.create({
    data: {
      companyId: tech.companyId,
      userId: tech.id,
      workdayId: workday.id,
      type: "CLOCK_IN",
      source: "FIELD_APP",
      occurredAt: new Date(`${diaEsquecido}T11:00:00.000Z`),
    },
  });
});

test.afterAll(async () => {
  await prisma.$disconnect();
});

test.describe("jornada da equipe", () => {
  test("ADMIN abre pelo menu e vê a lista e a fila de correções", async ({
    page,
  }) => {
    await login(page, ADMIN_EMAIL);

    // Pelo MENU, não por URL direta: prova que o caminho existe para a pessoa.
    await page.getByRole("link", { name: "Jornada" }).click();
    await page.waitForURL(/\/jornada/);

    await expect(
      page.getByRole("heading", { name: "Jornada da equipe" }),
    ).toBeVisible();

    // A tabela parte dos USUÁRIOS: quem não bateu aparece como "Não iniciou",
    // que é justamente o estado que o gestor precisa ver.
    await expect(page.getByText("Não iniciou").first()).toBeVisible();

    // A fila de correções é do ADMIN.
    await expect(
      page.getByRole("heading", { name: "Correções aguardando decisão" }),
    ).toBeVisible();
  });

  test("DISPATCHER vê a lista, mas NÃO a fila de correções", async ({
    page,
  }) => {
    await login(page, DISPATCHER_EMAIL);
    await page.goto("/jornada");

    await expect(
      page.getByRole("heading", { name: "Jornada da equipe" }),
    ).toBeVisible();

    /*
      A assimetria é deliberada (§231).

      Saber quem está em jornada é insumo direto do despacho. Julgar a jornada
      de outra pessoa é da família de administrar usuário e credencial — e no
      AlfaOS isso é do ADMIN.
    */
    await expect(
      page.getByRole("heading", { name: "Correções aguardando decisão" }),
    ).toHaveCount(0);
  });

  test("TECHNICIAN não entra na jornada da equipe", async ({ page }) => {
    await login(page, TECH_EMAIL);
    await page.goto("/jornada");

    // Esconder o item de menu é UX; a página recusa por conta própria.
    await expect(
      page.getByRole("heading", { name: "Jornada da equipe" }),
    ).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Jornada" })).toHaveCount(0);
  });
});

test.describe("correção administrativa", () => {
  /*
    Um dia bem no passado, e um horário de manhã.

    O servidor recusa horário no futuro, e a suíte roda a qualquer hora: dois
    dias atrás às 08:30 é passado em qualquer fuso brasileiro, em qualquer
    execução.
  */
  const DIA = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  /** Abre a correção de um funcionário pela tela dele. Devolve o motivo usado. */
  async function abrirCorrecaoPara(
    page: Page,
    funcionario: string,
    motivo: string,
  ) {
    await page.goto("/jornada");

    // Pela TABELA, e na LINHA da pessoa certa: prova que a ação existe para
    // quem usa, e que ela é sobre quem o gestor escolheu.
    await page
      .getByRole("row", { name: new RegExp(funcionario) })
      .getByRole("link", { name: "Ver / corrigir" })
      .click();
    await page.waitForURL(new RegExp("/jornada/"));

    // O dia é escolhido na própria tela.
    await page.getByLabel("Dia").fill(DIA);
    await page.getByRole("button", { name: "Ver dia" }).click();
    await page.waitForURL(new RegExp(`date=${DIA}`));

    await page.getByTestId("open-member-adjustment").click();
    await expect(page.getByTestId("member-adjustment-form")).toBeVisible();

    await page.getByLabel("Horário correto").fill("08:30");
    await page.getByLabel("Motivo").fill(motivo);
    await page.getByTestId("submit-member-adjustment").click();

    /*
      O que aparece é um PEDIDO, não uma marcação.

      O gestor não edita `TimeEntry` em lugar nenhum: a tela cria o mesmo
      `TimeAdjustmentRequest` que o aplicativo cria, e ele espera decisão.
    */
    await expect(page.getByTestId("member-adjustment-list")).toBeVisible();
    await expect(page.getByText("Aguardando decisão")).toBeVisible();
  }

  test("ADMIN abre a correção pela tabela e ela cai na fila", async ({
    page,
  }) => {
    const motivo = "Celular sem bateria; ele trabalhou o dia inteiro.";
    await login(page, ADMIN_EMAIL);
    await abrirCorrecaoPara(page, "Tecnico Alfa", motivo);

    // E cai na MESMA fila do painel — não existe uma segunda fila.
    await page.goto("/jornada");
    await expect(page.getByText(motivo)).toBeVisible();
    await expect(page.getByRole("button", { name: "Aprovar" })).toBeVisible();
  });

  /*
    QUATRO OLHOS NA PRÓPRIA JORNADA (§253, LOW-1).

    Este é o teste de tela que detecta a volta da autoaprovação. Ele é o par do
    ataque de rota em `src/tests/time-clock-security.test.ts`: aqui prova-se que
    a fila não OFERECE a decisão; lá, que o servidor a RECUSA mesmo que alguém
    monte o POST à mão.

    Os dois precisam existir. Só a tela seria segurança por omissão de botão; só
    a rota deixaria o gestor clicando num botão que sempre falha.
  */
  test("o pedido que o ADMIN abriu para SI MESMO não oferece decisão", async ({
    page,
  }) => {
    const motivo = "Fiquei no almoxarifado e esqueci de bater a entrada.";
    await login(page, ADMIN_EMAIL);
    await abrirCorrecaoPara(page, "Administrador Alfa", motivo);

    await page.goto("/jornada");
    const item = page.locator("li", { hasText: motivo });
    await expect(item).toBeVisible();

    // Sem botão, e com a razão escrita: a saída é chamar outra pessoa.
    await expect(item.getByTestId("requires-another-approver")).toBeVisible();
    await expect(item.getByRole("button", { name: "Aprovar" })).toHaveCount(0);
    await expect(item.getByRole("button", { name: "Rejeitar" })).toHaveCount(0);
  });

  /*
    E O CAMINHO LEGÍTIMO CONTINUA ABERTO (§21 do plano de fechamento).

    A mesma correção que o primeiro ADMIN não pode decidir é decidida pelo
    segundo. A aprovação NÃO edita a marcação: ela passa pelo mesmo
    `decideTimeAdjustment` — mesmo lock do dia, mesma validação de sequência
    efetiva e mesma supersessão que o pedido do aplicativo usa.
  */
  test("OUTRO ADMIN decide o pedido, e a correção passa a valer", async ({
    page,
  }) => {
    const motivo = "Cheguei às 08:30 e o ponto não registrou.";
    await login(page, ADMIN_EMAIL);
    await abrirCorrecaoPara(page, "Administrador Alfa", motivo);

    // Troca de pessoa: quem decide é outro administrador autorizado. Pelo
    // botão, que é o único caminho que encerra a sessão de verdade.
    await page.getByRole("button", { name: "Sair" }).click();
    await page.waitForURL(/\/login/);
    await login(page, ADMIN2_EMAIL);
    await page.goto("/jornada");

    const item = page.locator("li", { hasText: motivo });
    await expect(item).toBeVisible();
    // Para ESTE aprovador o pedido não é próprio, então a decisão aparece.
    await expect(item.getByTestId("requires-another-approver")).toHaveCount(0);

    await item.getByRole("button", { name: "Aprovar" }).click();

    // Decidido, o pedido sai da fila de pendentes.
    await expect(page.locator("li", { hasText: motivo })).toHaveCount(0, {
      timeout: 15_000,
    });

    /*
      E a correção virou marcação EFETIVA, sem apagar nada.

      O espelho do dia passa a mostrar 08:30 marcada como correção aprovada — a
      linha derivada. A original, quando existe, continua no banco: quem lê o
      histórico bruto vê as duas, e quem lê o espelho vê a que vale (§229).
    */
    await page
      .getByRole("row", { name: /Administrador Alfa/ })
      .getByRole("link", { name: "Ver / corrigir" })
      .click();
    await page.getByLabel("Dia").fill(DIA);
    await page.getByRole("button", { name: "Ver dia" }).click();
    await page.waitForURL(new RegExp(`date=${DIA}`));

    await expect(page.getByText("correção aprovada").first()).toBeVisible();
  });

  test("o formulário recusa envio sem motivo, e a recusa fica na tela", async ({
    page,
  }) => {
    await login(page, ADMIN_EMAIL);
    await page.goto("/jornada");
    await page.getByRole("link", { name: "Ver / corrigir" }).first().click();
    await page.waitForURL(new RegExp("/jornada/"));

    await page.getByTestId("open-member-adjustment").click();
    await page.getByLabel("Horário correto").fill("08:30");
    await page.getByTestId("submit-member-adjustment").click();

    // O formulário continua aberto, dizendo o que falta.
    await expect(page.getByTestId("member-adjustment-error")).toBeVisible();
    await expect(page.getByTestId("member-adjustment-form")).toBeVisible();
  });

  test("DISPATCHER não recebe a ação de corrigir", async ({ page }) => {
    await login(page, DISPATCHER_EMAIL);
    await page.goto("/jornada");

    await expect(
      page.getByRole("heading", { name: "Jornada da equipe" }),
    ).toBeVisible();
    // Corrigir a jornada de outra pessoa é da família de decidi-la (§231).
    await expect(page.getByRole("link", { name: "Ver / corrigir" })).toHaveCount(
      0,
    );
  });

  test("DISPATCHER não abre o espelho de um funcionário por URL", async ({
    page,
  }) => {
    await login(page, ADMIN_EMAIL);
    await page.goto("/jornada");
    await page.getByRole("link", { name: "Ver / corrigir" }).first().click();
    await page.waitForURL(new RegExp("/jornada/"));
    const url = page.url();

    await page.context().clearCookies();
    await login(page, DISPATCHER_EMAIL);
    await page.goto(url);

    // Esconder o link é UX; a página recusa por conta própria.
    await expect(page.getByTestId("open-member-adjustment")).toHaveCount(0);
  });

  test("o dia esquecido mostra a inconsistência e NÃO centenas de horas", async ({
    page,
  }) => {
    /*
      JOR-A1 e JOR-A2, pelo navegador.

      Antes da correção esta página mostrava ~288 horas para um dia de 12 dias
      atrás, e nenhuma explicação: o número simplesmente crescia entre duas
      visitas. Agora mostra o tempo confirmado e o motivo de ele ser esse.
    */
    await login(page, ADMIN_EMAIL);
    await page.goto(`/jornada/${techUserId}?date=${diaEsquecido}`);

    await expect(page.getByTestId("member-workday-state")).toHaveText(
      "Trabalhando",
    );

    // A inconsistência aparece — é o sinal que existia no servidor e nunca era
    // exibido em tela nenhuma.
    const aviso = page.getByTestId("member-workday-inconsistencies");
    await expect(aviso).toBeVisible();
    await expect(aviso).toContainText("Jornada em aberto.");

    /*
      E o total NÃO explodiu.

      Doze dias de relógio corrido seriam 288h. A asserção proíbe o desfecho
      ruim em vez de tolerá-lo: nada de três dígitos antes do "h".
    */
    const resumo = page.getByText(/Trabalhado .* · Intervalo/);
    await expect(resumo).toBeVisible();
    await expect(resumo).not.toContainText(/\d{3,}h/);
  });
});
