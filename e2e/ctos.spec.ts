import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { assertTestDatabase } from "./test-db-guard";

/**
 * # CTO-1 — fluxo real do ADMIN pela interface
 *
 * Pela UI de verdade, e não por chamada de API disfarçada de teste de tela: o
 * que este spec cobre é justamente o que os testes de rota não veem — a
 * capability escondendo o módulo, o menu, e a sequência que o operador segue.
 *
 * **Este spec liga e DESLIGA a capability.** A empresa semeada não a tem, e os
 * outros specs contam com isso; deixar ligada mudaria o menu que eles
 * inspecionam. O `afterAll` devolve o banco como o encontrou — inclusive as
 * CTOs criadas, que nenhum outro spec espera encontrar.
 */

const ADMIN_EMAIL = "admin@alfatelecom.local";
const DISPATCHER_EMAIL = "dispatcher@alfatelecom.local";
const PASSWORD = "AlfaOS@2026";

const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgresql://alfaos:alfaos_dev_password@localhost:5432/alfaos_test?schema=public";

const prisma = new PrismaClient({
  datasources: { db: { url: E2E_DATABASE_URL } },
});

async function companyId(): Promise<string> {
  const admin = await prisma.user.findUniqueOrThrow({
    where: { email: ADMIN_EMAIL },
  });
  return admin.companyId;
}

async function setCapability(enabled: boolean) {
  await prisma.company.update({
    where: { id: await companyId() },
    data: { ctoNetworkEnabled: enabled },
  });
}

test.beforeAll(async () => {
  await assertTestDatabase(E2E_DATABASE_URL, "E2E_DATABASE_URL");
});

test.afterAll(async () => {
  /*
    Limpeza por ESCOPO, não por padrão de nome.

    Apagar "o que parece de teste" é como uma suíte come dado real. Aqui o
    escopo é preciso: as CTOs desta empresa, que só este spec cria, e as portas
    delas — que precisam sair primeiro porque a FK é `Restrict`.
  */
  const company = await companyId();
  await prisma.cTOPort.deleteMany({ where: { companyId: company } });
  await prisma.cTO.deleteMany({ where: { companyId: company } });
  await prisma.auditLog.deleteMany({
    where: { companyId: company, action: { startsWith: "CTO." } },
  });
  await setCapability(false);
  await prisma.$disconnect();
});

/**
 * Preenche um campo e só segue quando o valor SOBREVIVE.
 *
 * A tela de detalhe é renderizada no servidor e hidratada depois. Um `fill`
 * disparado antes da hidratação escreve no DOM, não chega ao estado do React, e
 * o primeiro render do cliente devolve o campo ao valor inicial — o formulário
 * então submete o número antigo, e o teste falha acusando um defeito que não
 * existe. Um operador humano nunca digita nos 300 ms seguintes ao carregamento;
 * um teste digita.
 *
 * `toPass` refaz o preenchimento até o valor persistir, que é o sinal de que o
 * React assumiu o controle do campo.
 */
async function preencherEstavel(page: Page, rotulo: string, valor: string) {
  const campo = page.getByLabel(rotulo);
  await expect(async () => {
    await campo.fill(valor);
    await expect(campo).toHaveValue(valor);
  }).toPass({ timeout: 10_000 });
}

/**
 * Preenche a capacidade e submete, repetindo até a tela reagir.
 *
 * `preencherEstavel` sozinho não bastou, e a razão é sutil: sem hidratação
 * nada re-renderiza, então o valor escrito no DOM **persiste** e a asserção de
 * valor passa mesmo com o React ainda ausente. O clique seguinte submetia o
 * número antigo, que o React devolvia ao campo, e o teste acusava um erro que
 * não existe.
 *
 * O sinal confiável é o EFEITO: a tela mudou ou apareceu uma mensagem. Repetir
 * a operação inteira é seguro porque submeter capacidade é idempotente — o
 * mesmo valor duas vezes produz o mesmo estado, e um valor recusado não produz
 * estado nenhum.
 */
async function alterarCapacidade(
  page: Page,
  valor: string,
  esperado: () => Promise<void>,
) {
  await expect(async () => {
    await preencherEstavel(page, "Portas", valor);
    await page.getByRole("button", { name: "Alterar capacidade" }).click();
    await esperado();
  }).toPass({ timeout: 20_000 });
}

/**
 * Espera o React ter ASSUMIDO o campo — sem retry que mascare a corrida.
 *
 * O sinal é direto: o nó do input carrega uma chave `__reactFiber$` ou
 * `__reactProps$` só depois que o React o hidrata. Antes disso o campo é HTML
 * do servidor, aceita digitação e não notifica ninguém.
 *
 * Isto substitui a espera implícita que eu havia embutido no helper de
 * preenchimento: repetir `fill` até o valor "grudar" também converge, e esconde
 * de qual lado veio a demora. Aqui a espera é explícita e nomeada.
 */
async function esperarHidratacao(page: Page) {
  await page.waitForFunction(
    () => {
      const el = document.querySelector("#cto-capacity-edit");
      if (!el) return false;
      return Object.keys(el).some(
        (k) => k.startsWith("__reactFiber$") || k.startsWith("__reactProps$"),
      );
    },
    undefined,
    { timeout: 15_000 },
  );
}

/** Digita como gente: foca, seleciona tudo, escreve. Sem `fill`. */
async function digitarCapacidade(page: Page, valor: string) {
  const campo = page.locator("#cto-capacity-edit");
  await campo.click();
  await page.keyboard.press("Control+A");
  if (valor.length > 0) {
    await page.keyboard.type(valor);
  } else {
    await page.keyboard.press("Delete");
  }
}

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Senha").fill(PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

test("com a capability desligada o módulo não aparece nem responde", async ({
  page,
}) => {
  await setCapability(false);
  await login(page, ADMIN_EMAIL);

  // Não está no menu.
  await expect(
    page.getByRole("link", { name: "CTOs", exact: true }),
  ).toHaveCount(0);

  // E a proteção não é o menu: ir direto na URL também não entra.
  const res = await page.goto("/ctos");
  expect(res?.status()).toBe(404);
});

test("ADMIN cadastra, opera as portas, muda capacidade e inativa", async ({
  page,
}) => {
  await setCapability(true);
  await login(page, ADMIN_EMAIL);

  // O item aparece assim que a empresa tem o módulo.
  await page.getByRole("link", { name: "CTOs", exact: true }).click();
  await expect(page).toHaveURL(/\/ctos$/);

  // --- criar ---------------------------------------------------------------
  const nome = `E2E-A16-${Date.now()}`;
  await page.getByLabel("Nome").fill(nome);
  await page.getByLabel("Capacidade (portas)").fill("8");
  await page
    .getByLabel("Referência de endereço (opcional)")
    .fill("Poste em frente ao nº 340");
  await page.getByRole("button", { name: "Cadastrar CTO" }).click();

  await expect(page.getByRole("link", { name: nome })).toBeVisible();

  // --- abrir o detalhe -----------------------------------------------------
  await page.getByRole("link", { name: nome }).click();
  await expect(page.getByRole("heading", { name: nome })).toBeVisible();

  // As oito portas nasceram com a caixa.
  await expect(page.getByTestId("cto-port-row")).toHaveCount(8);
  await expect(page.getByTestId("cto-free")).toHaveText("8");

  // --- reservar, danificar, liberar ---------------------------------------
  const porta1 = page.getByTestId("cto-port-row").first();
  await porta1.getByRole("button", { name: "Reservar" }).click();
  await expect(page.getByTestId("cto-port-state-1")).toHaveText("Reservada");
  // Reservada sai da contagem de livres — não está livre, e nunca esteve
  // ocupada.
  await expect(page.getByTestId("cto-free")).toHaveText("7");

  await porta1.getByRole("button", { name: "Danificada" }).click();
  await expect(page.getByTestId("cto-port-state-1")).toHaveText("Danificada");

  await porta1.getByRole("button", { name: "Liberar" }).click();
  await expect(page.getByTestId("cto-port-state-1")).toHaveText("Livre");
  await expect(page.getByTestId("cto-free")).toHaveText("8");

  // --- aumentar capacidade -------------------------------------------------
  await alterarCapacidade(page, "12", async () => {
    await expect(page.getByTestId("cto-port-row")).toHaveCount(12);
  });

  // --- redução recusada por porta reservada acima do limite ---------------
  const porta12 = page.getByTestId("cto-port-row").nth(11);
  await porta12.getByRole("button", { name: "Reservar" }).click();
  await expect(page.getByTestId("cto-port-state-12")).toHaveText("Reservada");

  await alterarCapacidade(page, "8", async () => {
    await expect(page.getByTestId("cto-capacity-error")).toContainText(
      "Não é possível reduzir a capacidade",
    );
  });
  // A recusa é total: continuam 12 portas.
  await expect(page.getByTestId("cto-port-row")).toHaveCount(12);

  // --- liberar e reduzir ---------------------------------------------------
  await page.getByTestId("cto-port-row").nth(11).getByRole("button", {
    name: "Liberar",
  }).click();
  await expect(page.getByTestId("cto-port-state-12")).toHaveText("Livre");

  await alterarCapacidade(page, "8", async () => {
    await expect(page.getByText("Fora da capacidade")).toHaveCount(4);
  });

  /*
    Reduzir NÃO apaga porta: as doze linhas continuam na tela, e as quatro
    acima da capacidade aparecem marcadas. Se este spec esperasse 8 linhas,
    estaria pedindo o comportamento que a fase decidiu não ter.
  */
  await expect(page.getByTestId("cto-port-row")).toHaveCount(12);
  await expect(page.getByText("Fora da capacidade")).toHaveCount(4);

  // --- inativar ------------------------------------------------------------
  await page.getByRole("button", { name: "Inativar CTO" }).click();
  await expect(page.getByRole("button", { name: "Reativar CTO" })).toBeVisible();
});

test("CTO criada sem coordenada mostra campos VAZIOS, não o exemplo", async ({
  page,
}) => {
  /*
    O achado da validação humana: uma CTO criada sem coordenada aparentava ter
    latitude -23.5505199 e longitude -46.6333094 na tela de detalhe.

    O banco tinha NULL nas duas — o que se via era o `placeholder`, que usava
    uma coordenada real e completa e por isso é indistinguível de um valor
    gravado a olho nu.

    Este é o único teste capaz de fazer essa distinção: `toHaveValue("")`
    verifica o VALOR do campo, que é o que seria enviado no submit, enquanto o
    texto cinza do placeholder é atributo e não valor. Um `defaultValue` com
    coordenada real derrubaria esta asserção; o placeholder não.
  */
  await setCapability(true);
  await login(page, ADMIN_EMAIL);

  const nome = `E2E-SEMGPS-${Date.now()}`;
  await page.goto("/ctos");
  await page.getByLabel("Nome").fill(nome);
  await page.getByLabel("Capacidade (portas)").fill("8");
  await page
    .getByLabel("Referência de endereço (opcional)")
    .fill("Poste QA em frente ao nº 340");
  await page.getByRole("button", { name: "Cadastrar CTO" }).click();

  await page.getByRole("link", { name: nome }).click();
  await expect(page.getByRole("heading", { name: nome })).toBeVisible();

  // O VALOR é vazio nas duas — é ele que iria no submit.
  await expect(page.getByLabel("Latitude")).toHaveValue("");
  await expect(page.getByLabel("Longitude")).toHaveValue("");

  // E a tela DIZ que não há coordenada, em vez de deixar a dúvida por conta do
  // contraste do texto cinza.
  await expect(page.getByTestId("cto-geo-state")).toContainText(
    "não tem coordenada cadastrada",
  );

  // O exemplo continua visível como exemplo, e prefixado para não ser lido
  // como dado.
  await expect(page.getByLabel("Latitude")).toHaveAttribute(
    "placeholder",
    /^ex\.:/,
  );

  // Salvar sem tocar nas coordenadas não pode inventar nenhuma.
  await page.getByLabel("Observações").fill("editado sem mexer em GPS");
  await page.getByTestId("cto-save").click();
  await page.reload();
  await expect(page.getByLabel("Latitude")).toHaveValue("");
  await expect(page.getByLabel("Longitude")).toHaveValue("");
  await expect(page.getByTestId("cto-geo-state")).toContainText(
    "não tem coordenada cadastrada",
  );
});

test("coordenada inválida é barrada antes do envio e não apaga a existente", async ({
  page,
}) => {
  /*
    Este é o ÚNICO lugar que consegue provar esta guarda.

    `JSON.stringify` converte `NaN` e `Infinity` em `null`, e `null` é a forma
    legítima de dizer "remova a coordenada". O servidor recebe os dois casos
    como a mesma coisa — então a validação tem de acontecer antes de o JSON ser
    montado, no cliente, e nenhum teste de rota alcança isso.

    `Infinity` está aqui de propósito: a primeira versão da guarda usava
    `Number.isNaN`, que fecha "abc" e deixa "Infinity" passar inteiro.
  */
  await setCapability(true);
  await login(page, ADMIN_EMAIL);

  const nome = `E2E-GEO-${Date.now()}`;
  await page.goto("/ctos");
  await page.getByLabel("Nome").fill(nome);
  await page.getByLabel("Capacidade (portas)").fill("4");
  await page.getByRole("button", { name: "Cadastrar CTO" }).click();
  await page.getByRole("link", { name: nome }).click();

  // Grava uma coordenada válida primeiro: sem ela, "não apagou" seria vácuo.
  await page.getByLabel("Latitude").fill("-23.5505199");
  await page.getByLabel("Longitude").fill("-46.6333094");
  await page.getByTestId("cto-save").click();
  await expect(page.getByLabel("Latitude")).toHaveValue("-23.5505199");

  for (const invalido of ["abc", "Infinity", "1,2,3"]) {
    await page.getByLabel("Latitude").fill(invalido);
    await page.getByTestId("cto-save").click();
    // A mensagem passou a nomear o CAMPO, e não mais os dois de uma vez: só a
    // latitude está errada aqui.
    await expect(page.getByTestId("cto-details-error")).toContainText(
      "Latitude inválida. Informe o valor correto.",
    );
    await expect(page.locator("#cto-lat")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    await expect(page.locator("#cto-lon")).toHaveAttribute(
      "aria-invalid",
      "false",
    );

    // A coordenada gravada sobreviveu: recarregar mostra a antiga, não vazio.
    await page.reload();
    await expect(page.getByLabel("Latitude")).toHaveValue("-23.5505199");
    await expect(page.getByLabel("Longitude")).toHaveValue("-46.6333094");
  }
});

test("redução recusada mostra o motivo ONDE a pessoa clicou", async ({
  page,
}) => {
  /*
    Achado da validação humana: com capacidade 16 e a porta 14 reservada, o
    operador tentou reduzir para 8, clicou em "Alterar capacidade" e **nada
    aconteceu na tela**.

    O backend rejeitava corretamente — 409, zero mutação, `updatedAt` intacto.
    O erro era renderizado, e num bloco único no TOPO do componente: com 16
    portas listadas entre ele e o botão, a mensagem nascia fora da viewport de
    quem acabara de clicar. Uma recusa invisível é indistinguível de um botão
    quebrado.

    `toBeInViewport` é a asserção que importa aqui, e não `toBeVisible`: o
    elemento sempre esteve visível no sentido do DOM. O que faltava era estar
    onde a pessoa está olhando.
  */
  await setCapability(true);
  await login(page, ADMIN_EMAIL);

  const nome = `E2E-CAP-${Date.now()}`;
  await page.goto("/ctos");
  await page.getByLabel("Nome").fill(nome);
  await page.getByLabel("Capacidade (portas)").fill("16");
  await page.getByRole("button", { name: "Cadastrar CTO" }).click();
  await page.getByRole("link", { name: nome }).click();

  // Reserva a porta 14 — acima do limite que será tentado.
  await page
    .getByTestId("cto-port-row")
    .nth(13)
    .getByRole("button", { name: "Reservar" })
    .click();
  await expect(page.getByTestId("cto-port-state-14")).toHaveText("Reservada");

  const erroLoc = page.getByTestId("cto-capacity-error");
  await alterarCapacidade(page, "8", async () => {
    await expect(erroLoc).toBeVisible();
  });

  // 1. A recusa aparece, e aparece ONDE se clicou.
  await expect(erroLoc).toBeInViewport();
  await expect(erroLoc).toContainText("Não é possível reduzir a capacidade");
  await expect(erroLoc).toContainText("14");

  // 2. Nada foi alterado: as 16 portas continuam e a 14 segue reservada.
  await expect(page.getByTestId("cto-port-row")).toHaveCount(16);
  await expect(page.getByTestId("cto-port-state-14")).toHaveText("Reservada");
  await expect(page.getByTestId("cto-capacity-current")).toContainText("16");

  // 3. O campo volta ao valor AUTORITATIVO. Deixá-lo em 8 ao lado de um
  //    cabeçalho que diz 16 é a mesma ambiguidade do placeholder: a tela
  //    mostrando um número que o servidor não tem.
  await expect(page.getByLabel("Portas")).toHaveValue("16");

  // 4. E o mesmo bloco não pode ter erro e sucesso ao mesmo tempo.
  await expect(page.getByTestId("cto-capacity-success")).toHaveCount(0);

  // --- porta DANIFICADA bloqueia igual ------------------------------------
  await page
    .getByTestId("cto-port-row")
    .nth(13)
    .getByRole("button", { name: "Liberar" })
    .click();
  await expect(page.getByTestId("cto-port-state-14")).toHaveText("Livre");
  await page
    .getByTestId("cto-port-row")
    .nth(12)
    .getByRole("button", { name: "Danificada" })
    .click();
  await expect(page.getByTestId("cto-port-state-13")).toHaveText("Danificada");

  await alterarCapacidade(page, "8", async () => {
    await expect(erroLoc).toContainText("13");
  });
  await expect(erroLoc).toBeInViewport();
  await expect(page.getByTestId("cto-port-row")).toHaveCount(16);

  // --- controle positivo: liberado, reduz --------------------------------
  await page
    .getByTestId("cto-port-row")
    .nth(12)
    .getByRole("button", { name: "Liberar" })
    .click();
  await expect(page.getByTestId("cto-port-state-13")).toHaveText("Livre");

  await alterarCapacidade(page, "8", async () => {
    await expect(page.getByTestId("cto-capacity-current")).toContainText("8");
  });
  await expect(page.getByTestId("cto-capacity-error")).toHaveCount(0);
  // Reduzir não apaga porta: as 16 linhas continuam, 8 delas fora da faixa.
  await expect(page.getByTestId("cto-port-row")).toHaveCount(16);
  await expect(page.getByText("Fora da capacidade")).toHaveCount(8);
});

test("capacidade inválida também mostra o motivo no lugar certo", async ({
  page,
}) => {
  // O formulário perdia TODO erro da mesma forma, não só o conflito de portas.
  await setCapability(true);
  await login(page, ADMIN_EMAIL);

  const nome = `E2E-CAPINV-${Date.now()}`;
  await page.goto("/ctos");
  await page.getByLabel("Nome").fill(nome);
  await page.getByLabel("Capacidade (portas)").fill("16");
  await page.getByRole("button", { name: "Cadastrar CTO" }).click();
  await page.getByRole("link", { name: nome }).click();

  /*
    Os três casos que o campo consegue produzir.

    "abc" não está na lista porque não é representável: num `input
    type="number"`, digitar letras deixa o campo VAZIO — o valor textual nunca
    chega ao formulário. O caso equivalente e alcançável é o campo em branco,
    que é o que o operador vê quando apaga tudo.

    `test.step` dá nome a cada iteração: sem ele, uma falha no loop aponta a
    linha e não diz qual valor a causou, que foi exatamente o que me custou
    tempo aqui.
  */
  for (const invalido of ["0", "257", ""]) {
    await test.step(`capacidade "${invalido}"`, async () => {
      await alterarCapacidade(page, invalido, async () => {
        await expect(page.getByTestId("cto-capacity-error")).toBeInViewport();
      });

      await expect(page.getByTestId("cto-capacity-current")).toContainText("16");
      await expect(page.getByTestId("cto-port-row")).toHaveCount(16);
      // E o campo volta ao autoritativo, como na recusa do servidor.
      await expect(page.getByLabel("Portas")).toHaveValue("16");
    });
  }
});

test("capacidade inválida: a mensagem aparece e PARECE um erro", async ({
  page,
}) => {
  /*
    Achado da validação humana, e ele foi mais fundo do que "faltou mensagem".
    O operador digitou `0`, clicou, viu o campo voltar para 16 — e não
    registrou nenhum erro na tela.

    A mensagem ESTAVA sendo renderizada. O que faltava era ela parecer um erro:
    eu havia escrito `text-danger-text`, e o design system define
    `danger.fg`. Tailwind ignora classe que não existe, então o texto herdava a
    cor normal — preto sobre um fundo rosa claro. Os dois únicos arquivos do
    projeto com essa classe inventada eram os meus.

    Por isso este teste verifica a COR, e não só a presença: era exatamente a
    cor que faltava, e nenhuma asserção de existência teria pego.

    Digitação humana de verdade — foco, Ctrl+A, teclas — depois de hidratação
    EXPLÍCITA. Nada de `fill` com retry, que converge e esconde de qual lado
    veio a demora.
  */
  await setCapability(true);
  await login(page, ADMIN_EMAIL);

  const nome = `E2E-INVALID-${Date.now()}`;
  await page.goto("/ctos");
  await page.getByLabel("Nome").fill(nome);
  await page.getByLabel("Capacidade (portas)").fill("16");
  await page.getByRole("button", { name: "Cadastrar CTO" }).click();
  await page.getByRole("link", { name: nome }).click();
  await expect(page.getByRole("heading", { name: nome })).toBeVisible();
  await esperarHidratacao(page);

  const alerta = page.getByTestId("cto-capacity-error");

  // Reserva a porta 14 para provar, ao final, que nada foi tocado.
  await page
    .getByTestId("cto-port-row")
    .nth(13)
    .getByRole("button", { name: "Reservar" })
    .click();
  await expect(page.getByTestId("cto-port-state-14")).toHaveText("Reservada");

  // CTO1PV-INVALID-01/02/03 — os três valores inválidos que o campo produz.
  for (const invalido of ["0", "-1", "257"]) {
    await test.step(`capacidade "${invalido}"`, async () => {
      await digitarCapacidade(page, invalido);
      await page.getByRole("button", { name: "Alterar capacidade" }).click();

      await expect(alerta).toBeVisible();
      await expect(alerta).toBeInViewport(); // CTO1PV-INVALID-07
      await expect(alerta).toContainText("entre 1 e 256");
      await expect(alerta).toHaveAttribute("role", "alert");

      /*
        A cor. `danger.fg` é vermelho; a cor do texto normal é escura e neutra.
        A asserção é sobre o canal vermelho dominar os outros — não sobre um
        hex exato, que mudaria com o tema sem que nada tenha quebrado.
      */
      const cor = await alerta.evaluate((el) => getComputedStyle(el).color);
      const [r, g, b] = cor.match(/\d+/g)!.map(Number);
      expect(r).toBeGreaterThan(g + 40);
      expect(r).toBeGreaterThan(b + 40);

      // CTO1PV-INVALID-04: a capacidade autoritativa não mudou.
      await expect(page.getByTestId("cto-capacity-current")).toContainText("16");
      await expect(page.getByLabel("Portas")).toHaveValue("16");
      await expect(page.getByTestId("cto-port-row")).toHaveCount(16);
      await expect(page.getByTestId("cto-port-state-14")).toHaveText("Reservada");
    });
  }

  // O campo vazio é o que o operador produz ao apagar tudo.
  await digitarCapacidade(page, "");
  await page.getByRole("button", { name: "Alterar capacidade" }).click();
  await expect(alerta).toBeVisible();
  await expect(alerta).toContainText("entre 1 e 256");

  // Controle positivo: um valor válido passa, e o alerta some.
  await digitarCapacidade(page, "20");
  await page.getByRole("button", { name: "Alterar capacidade" }).click();
  await expect(page.getByTestId("cto-capacity-current")).toContainText("20");
  await expect(alerta).toHaveCount(0);
});

test("os estados das portas também têm cor, não só fundo", async ({ page }) => {
  /*
    O mesmo defeito de classe inventada atingia `success` e `warning`: os
    selos Livre, Reservada e Danificada saíam com texto preto sobre fundo
    colorido. Testar só o TEXTO do selo não pegaria — e era o que os testes
    faziam.
  */
  await setCapability(true);
  await login(page, ADMIN_EMAIL);

  const nome = `E2E-CORES-${Date.now()}`;
  await page.goto("/ctos");
  await page.getByLabel("Nome").fill(nome);
  await page.getByLabel("Capacidade (portas)").fill("4");
  await page.getByRole("button", { name: "Cadastrar CTO" }).click();
  await page.getByRole("link", { name: nome }).click();
  await esperarHidratacao(page);

  async function corDoSelo(n: number) {
    return page
      .getByTestId(`cto-port-state-${n}`)
      .evaluate((el) => getComputedStyle(el).color);
  }

  // A cor do texto do selo não pode ser a mesma do texto comum da página.
  const corComum = await page
    .getByRole("heading", { name: nome })
    .evaluate((el) => getComputedStyle(el).color);

  await expect(page.getByTestId("cto-port-state-1")).toHaveText("Livre");
  expect(await corDoSelo(1)).not.toBe(corComum);

  await page
    .getByTestId("cto-port-row")
    .first()
    .getByRole("button", { name: "Reservar" })
    .click();
  await expect(page.getByTestId("cto-port-state-1")).toHaveText("Reservada");
  expect(await corDoSelo(1)).not.toBe(corComum);
});

test("coordenada inválida marca O CAMPO responsável, e diz por quê", async ({
  page,
}) => {
  /*
    Achado da validação humana: latitude 91 com longitude válida era recusada
    corretamente — e a tela dizia só "Dados inválidos.", sem apontar campo,
    problema ou faixa.

    Este teste cobre as três coisas que faltavam: mensagem específica, campo
    destacado, e associação acessível. As asserções visuais comparam a borda do
    campo em erro com a de um campo normal, sem fixar hex — hex quebraria a cada
    ajuste de tema, e o que precisa ser verdade é que os dois estados sejam
    distinguíveis.
  */
  await setCapability(true);
  await login(page, ADMIN_EMAIL);

  const nome = `E2E-COORD-${Date.now()}`;
  await page.goto("/ctos");
  await page.getByLabel("Nome").fill(nome);
  await page.getByLabel("Capacidade (portas)").fill("4");
  await page.getByRole("button", { name: "Cadastrar CTO" }).click();
  await page.getByRole("link", { name: nome }).click();
  await esperarHidratacao(page);

  const lat = page.locator("#cto-lat");
  const lon = page.locator("#cto-lon");
  const alerta = page.getByTestId("cto-details-error");
  const borda = (l: typeof lat) =>
    l.evaluate((el) => getComputedStyle(el).borderTopColor);

  /**
   * A borda do campo em erro precisa ser VERMELHA, não apenas diferente.
   *
   * A primeira versão comparava com a borda normal e exigia que mudasse. Isso
   * é fraco: trocar a classe de erro por uma inexistente também "muda" a
   * borda — ela cai para o padrão do navegador, porque a classe normal não
   * está mais lá. A sabotagem passou por essa fresta.
   *
   * Exigir o canal vermelho dominando é o que amarra a asserção ao token de
   * verdade, sem fixar hex (que quebraria a cada ajuste de tema).
   */
  async function esperarBordaDeErro(l: typeof lat) {
    const cor = await borda(l);
    const [r, g, b] = cor.match(/\d+/g)!.map(Number);
    expect(r, `borda deveria ser avermelhada, veio ${cor}`).toBeGreaterThan(
      g + 20,
    );
    expect(r).toBeGreaterThan(b + 20);
  }

  // Referência: como é a borda de um campo que NÃO está em erro.
  const bordaNormal = await borda(lat);

  async function digitar(campo: typeof lat, valor: string) {
    await campo.click();
    await page.keyboard.press("Control+A");
    if (valor) await page.keyboard.type(valor);
    else await page.keyboard.press("Delete");
  }

  async function salvar() {
    await page.getByTestId("cto-save").click();
  }

  // --- E2E-01: latitude fora da faixa -------------------------------------
  await digitar(lat, "91");
  await digitar(lon, "-46.6333094");
  await salvar();

  await expect(alerta).toBeVisible();
  await expect(alerta).toBeInViewport();
  await expect(alerta).toHaveText("Latitude inválida. Informe o valor correto.");
  await expect(lat).toHaveAttribute("aria-invalid", "true");
  await expect(lat).toHaveAttribute("aria-describedby", "cto-details-error");
  // Só a latitude. A longitude está correta e não pode ser acusada junto.
  await expect(lon).toHaveAttribute("aria-invalid", "false");
  await esperarBordaDeErro(lat);
  expect(await borda(lon)).toBe(bordaNormal);

  // --- E2E-02: longitude fora da faixa ------------------------------------
  await digitar(lat, "-23.5505199");
  await digitar(lon, "181");
  await salvar();

  await expect(alerta).toHaveText("Longitude inválida. Informe o valor correto.");
  await expect(lon).toHaveAttribute("aria-invalid", "true");
  await expect(lat).toHaveAttribute("aria-invalid", "false");
  await esperarBordaDeErro(lon);
  expect(await borda(lat)).toBe(bordaNormal);

  // --- E2E-03/04: par incompleto marca OS DOIS ----------------------------
  for (const [a, b] of [
    ["-23.5505199", ""],
    ["", "-46.6333094"],
  ] as const) {
    await digitar(lat, a);
    await digitar(lon, b);
    await salvar();

    await expect(alerta).toHaveText(
      "Coordenadas incompletas. Preencha latitude e longitude juntas ou deixe os dois campos vazios.",
    );
    await expect(lat).toHaveAttribute("aria-invalid", "true");
    await expect(lon).toHaveAttribute("aria-invalid", "true");
    await esperarBordaDeErro(lat);
    await esperarBordaDeErro(lon);
  }

  // --- E2E-05: corrigir limpa o destaque ----------------------------------
  await digitar(lat, "91");
  await digitar(lon, "-46.6333094");
  await salvar();
  await expect(lat).toHaveAttribute("aria-invalid", "true");

  await digitar(lat, "-23.5505199");
  await salvar();
  await expect(alerta).toHaveCount(0);
  await expect(lat).toHaveAttribute("aria-invalid", "false");
  await expect(lon).toHaveAttribute("aria-invalid", "false");
  expect(await borda(lat)).toBe(bordaNormal);

  // --- E2E-06: a coordenada válida foi de fato gravada --------------------
  await page.reload();
  await expect(page.locator("#cto-lat")).toHaveValue("-23.5505199");
  await expect(page.locator("#cto-lon")).toHaveValue("-46.6333094");
  await expect(page.getByTestId("cto-geo-state")).toContainText(
    "Coordenada cadastrada",
  );
});

/** Duas imagens sintéticas DIFERENTES, montadas em memória pelo navegador. */
const JPEG_A =
  "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";
const JPEG_B =
  "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";

/** Anexa um `data:` URI ao input de arquivo como se a pessoa o tivesse escolhido. */
async function escolherFoto(page: Page, dataUri: string, nome: string) {
  const base64 = dataUri.split(",")[1];
  await page.setInputFiles("[data-testid='cto-photo-input']", {
    name: nome,
    mimeType: "image/jpeg",
    buffer: Buffer.from(base64, "base64"),
  });
}

test("a foto tem preview, botão próprio e confirma a substituição", async ({
  page,
}) => {
  /*
    Achado da validação humana: a substituição FUNCIONAVA e era invisível.
    Escolher o arquivo já o enviava — sem confirmação, sem estado, sem preview
    —, e a única mudança na tela era o input voltar a "Nenhum arquivo
    escolhido". A pessoa não tinha como saber se a troca acontecera, que é o
    pior desfecho: ela não sabe se deve tentar de novo.

    Este teste prova as três coisas que faltavam — miniatura, ação explícita e
    confirmação — e prova a troca pela IDENTIDADE DO CONTEÚDO, não pelo texto:
    os bytes servidos depois têm de ser outros.
  */
  await setCapability(true);
  await login(page, ADMIN_EMAIL);

  const nome = `E2E-FOTO-${Date.now()}`;
  await page.goto("/ctos");
  await page.getByLabel("Nome").fill(nome);
  await page.getByLabel("Capacidade (portas)").fill("4");
  await page.getByRole("button", { name: "Cadastrar CTO" }).click();
  await page.getByRole("link", { name: nome }).click();
  await esperarHidratacao(page);

  const preview = page.getByTestId("cto-photo-preview");
  const enviar = page.getByTestId("cto-photo-submit");

  // CTO1PV-PHOTO-01 — sem foto: nenhuma miniatura, e o botão diz "Enviar".
  await expect(page.getByTestId("cto-photo-empty")).toBeVisible();
  await expect(preview).toHaveCount(0);
  await expect(enviar).toHaveText("Enviar foto");
  // Nada foi enviado ainda: sem arquivo escolhido, a ação está indisponível.
  await expect(enviar).toBeDisabled();

  // Escolher NÃO envia — era exatamente esse o upload silencioso.
  await escolherFoto(page, JPEG_A, "a.jpg");
  await expect(enviar).toBeEnabled();
  await expect(preview).toHaveCount(0);

  await enviar.click();
  await expect(page.getByTestId("cto-photo-success")).toHaveText(
    "Foto enviada com sucesso.",
  );
  await expect(preview).toBeVisible();
  await expect(preview).toHaveAttribute("alt", "Foto atual da CTO");

  // A identidade do conteúdo servido, para comparar depois da troca.
  const bytesDe = async () => {
    const src = await preview.getAttribute("src");
    const r = await page.request.get(new URL(src!, page.url()).toString());
    expect(r.status()).toBe(200);
    expect(r.headers()["content-type"]).toContain("image/");
    return (await r.body()).toString("base64");
  };
  const conteudoA = await bytesDe();

  // CTO1PV-PHOTO-02/04 — substituir por outra imagem.
  await expect(enviar).toHaveText("Substituir foto");
  await escolherFoto(page, JPEG_B, "b.jpg");
  await enviar.click();
  await expect(page.getByTestId("cto-photo-success")).toHaveText(
    "Foto atualizada com sucesso.",
  );

  const conteudoB = await bytesDe();
  expect(conteudoB).not.toBe(conteudoA);

  // CTO1PV-PHOTO-05 — a nova sobrevive ao F5, e a antiga não volta.
  await page.reload();
  await esperarHidratacao(page);
  await expect(page.getByTestId("cto-photo-preview")).toBeVisible();
  const depoisDoReload = await bytesDe();
  expect(depoisDoReload).toBe(conteudoB);
  expect(depoisDoReload).not.toBe(conteudoA);

  // CTO1PV-PHOTO-06 — arquivo inválido não derruba a foto vigente.
  await page.setInputFiles("[data-testid='cto-photo-input']", {
    name: "x.jpg",
    mimeType: "image/jpeg",
    buffer: Buffer.from("isto não é uma imagem"),
  });
  await page.getByTestId("cto-photo-submit").click();
  await expect(page.getByTestId("cto-photo-error")).toBeVisible();
  expect(await bytesDe()).toBe(conteudoB);
});

/**
 * Uma imagem REAL, pintada pelo próprio navegador.
 *
 * `JPEG_A`/`JPEG_B` provam identidade de conteúdo e bastam para isso. O que
 * elas NÃO provam é que o navegador consegue DECODIFICAR o que a rota devolve,
 * e é essa a lacuna que a validação humana encontrou. O `montarJpeg` dos
 * testes de servidor diz no próprio docstring que não precisa ser
 * decodificável — "nada no AlfaOS decodifica imagem". Era verdade até existir
 * um preview; o preview é exatamente o consumidor que decodifica.
 *
 * `canvas.toDataURL` produz um JPEG de verdade, com SOF e tabelas de Huffman,
 * de dimensões conhecidas — então `naturalWidth` deixa de ser "algum número" e
 * passa a ser um valor que o teste pode exigir.
 */
async function imagemReal(
  page: Page,
  largura: number,
  altura: number,
  cor: string,
): Promise<Buffer> {
  const base64 = await page.evaluate(
    ({ largura, altura, cor }) => {
      const canvas = document.createElement("canvas");
      canvas.width = largura;
      canvas.height = altura;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = cor;
      ctx.fillRect(0, 0, largura, altura);
      // Um quadrante escuro: cor chapada comprime a quase nada, e duas fotos
      // diferentes poderiam coincidir em tamanho.
      ctx.fillStyle = "#101010";
      ctx.fillRect(0, 0, Math.ceil(largura / 2), Math.ceil(altura / 2));
      return canvas.toDataURL("image/jpeg", 0.92).split(",")[1];
    },
    { largura, altura, cor },
  );
  return Buffer.from(base64, "base64");
}

/** O que o navegador conseguiu fazer com os bytes — não o que o DOM contém. */
async function medirPreview(page: Page) {
  return page.getByTestId("cto-photo-preview").evaluate((el) => {
    const img = el as HTMLImageElement;
    return {
      complete: img.complete,
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
    };
  });
}

async function enviarFoto(page: Page, bytes: Buffer, nome: string) {
  await page.setInputFiles("[data-testid='cto-photo-input']", {
    name: nome,
    mimeType: "image/jpeg",
    buffer: bytes,
  });
  await page.getByTestId("cto-photo-submit").click();
}

test("CTO1PV-PHOTO-DECODE — o preview é DECODIFICADO, não apenas exibido", async ({
  page,
}) => {
  /*
    Achado da validação humana: a rota respondia 200 com `image/jpeg` e a
    imagem aparecia quebrada.

    Nenhum teste anterior podia pegar isso. Todos afirmavam presença
    (`toBeVisible`), atributo (`alt`) ou identidade de bytes — e um `<img>` de
    origem quebrada continua visível, continua tendo `alt` e continua devolvendo
    bytes estáveis. A única asserção que separa "chegou" de "abriu" é a dimensão
    natural, que só existe depois da decodificação.

    Este teste também é o que decide, empiricamente, se
    `Content-Disposition: attachment` impede um subrecurso de renderizar.
  */
  await setCapability(true);
  await login(page, ADMIN_EMAIL);

  const nome = `E2E-DECODE-${Date.now()}`;
  await page.goto("/ctos");
  await page.getByLabel("Nome").fill(nome);
  await page.getByLabel("Capacidade (portas)").fill("4");
  await page.getByRole("button", { name: "Cadastrar CTO" }).click();
  await page.getByRole("link", { name: nome }).click();
  await esperarHidratacao(page);

  // --- foto A: 48x24 ------------------------------------------------------
  await enviarFoto(page, await imagemReal(page, 48, 24, "#c83232"), "a.jpg");
  await expect(page.getByTestId("cto-photo-success")).toBeVisible();

  const src = (await page
    .getByTestId("cto-photo-preview")
    .getAttribute("src"))!;
  const resposta = await page.request.get(new URL(src, page.url()).toString());
  expect(resposta.status()).toBe(200);
  // CTO1PV-PHOTO-BYTES-01/02 — corpo não vazio e magic byte concordando com o
  // header. Header e bytes têm de contar a mesma história.
  expect(resposta.headers()["content-type"]).toBe("image/jpeg");
  const corpo = await resposta.body();
  expect(corpo.byteLength).toBeGreaterThan(100);
  expect(corpo.subarray(0, 3).toString("hex")).toBe("ffd8ff");

  // CTO1PV-PHOTO-BYTES-03 — o corpo HTTP é byte a byte o que está no storage.
  // Uma serialização que passasse o binário por string quebraria aqui, e não
  // no tamanho: bytes acima de 0x7f viram U+FFFD.
  const linha = await prisma.cTO.findFirstOrThrow({
    where: { name: nome },
    select: { photoStorageKey: true },
  });
  const doDisco = await readFile(
    resolve(process.env.STORAGE_ROOT ?? ".storage", linha.photoStorageKey!),
  );
  expect(createHash("sha256").update(corpo).digest("hex")).toBe(
    createHash("sha256").update(doDisco).digest("hex"),
  );

  // --- a prova central ----------------------------------------------------
  await expect
    .poll(async () => (await medirPreview(page)).naturalWidth, {
      timeout: 10_000,
      message: "o navegador nunca decodificou a foto servida pela rota",
    })
    .toBe(48);
  const medidaA = await medirPreview(page);
  expect(medidaA.complete).toBe(true);
  expect(medidaA.naturalHeight).toBe(24);

  // --- foto B: 30x60, dimensões DIFERENTES --------------------------------
  await enviarFoto(page, await imagemReal(page, 30, 60, "#2864c8"), "b.jpg");
  await expect(page.getByTestId("cto-photo-success")).toHaveText(
    "Foto atualizada com sucesso.",
  );

  // A troca é provada pela DIMENSÃO decodificada, não pelo texto da
  // confirmação nem pelo `src`: só a dimensão prova que o navegador abriu a
  // imagem NOVA.
  await expect
    .poll(async () => (await medirPreview(page)).naturalWidth, {
      timeout: 10_000,
    })
    .toBe(30);
  expect((await medirPreview(page)).naturalHeight).toBe(60);

  // --- sobrevive ao F5 ----------------------------------------------------
  await page.reload();
  await esperarHidratacao(page);
  await expect
    .poll(async () => (await medirPreview(page)).naturalWidth, {
      timeout: 10_000,
    })
    .toBe(30);
  expect((await medirPreview(page)).naturalHeight).toBe(60);
});

/**
 * Um JPEG que o servidor ACEITA e o navegador NÃO abre.
 *
 * É a forma exata do arquivo que a validação humana encontrou na CTO de QA:
 * `SOI → APP0 → DQT → SOS`, quatro bytes de scan inventados, `EOI`. Assinatura
 * correta, contêiner que fecha, segmentos plausíveis — e nenhum `SOF`, então
 * não há quadro para decodificar. Toda validação do servidor passa; nenhum
 * decodificador abre.
 *
 * Existe aqui para provar que a tela DIZ isso, em vez de mostrar um quadro
 * vazio que a pessoa não tem como interpretar.
 */
function jpegQueNaoAbre(): Buffer {
  const segmento = (codigo: number, carga: Buffer) => {
    const cab = Buffer.alloc(4);
    cab[0] = 0xff;
    cab[1] = codigo;
    cab.writeUInt16BE(carga.length + 2, 2);
    return Buffer.concat([cab, carga]);
  };
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segmento(
      0xe0,
      Buffer.concat([
        Buffer.from("JFIF ", "ascii"),
        Buffer.from([0x01, 0x02, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]),
      ]),
    ),
    segmento(0xdb, Buffer.alloc(65, 0x10)),
    segmento(0xda, Buffer.from([0x01, 0x01, 0x00, 0x00, 0x3f, 0x00])),
    Buffer.from([0x12, 0x34, 0x56, 0x78]),
    Buffer.from([0xff, 0xd9]),
  ]);
}

test("CTO1PV-PHOTO-FALLBACK — foto que não abre DIZ que não abriu", async ({
  page,
}) => {
  /*
    O estado que a validação humana viu: foto cadastrada, rota respondendo 200,
    e um retângulo vazio com o `alt` dentro. Um `<img>` quebrado não é
    distinguível, para quem olha, de um bug de layout ou de uma tela ainda
    carregando — e a pessoa não tem como saber que precisa enviar outra imagem.

    A saída não é esconder: é DIZER, e deixar a ação de substituir ao lado.
  */
  await setCapability(true);
  await login(page, ADMIN_EMAIL);

  const nome = `E2E-QUEBRADA-${Date.now()}`;
  await page.goto("/ctos");
  await page.getByLabel("Nome").fill(nome);
  await page.getByLabel("Capacidade (portas)").fill("4");
  await page.getByRole("button", { name: "Cadastrar CTO" }).click();
  await page.getByRole("link", { name: nome }).click();
  await esperarHidratacao(page);

  // O servidor ACEITA — é este o ponto: não é um upload recusado.
  await enviarFoto(page, jpegQueNaoAbre(), "quebrada.jpg");
  await expect(page.getByTestId("cto-photo-success")).toBeVisible();

  const aviso = page.getByTestId("cto-photo-broken");
  await expect(aviso).toBeVisible();
  await expect(aviso).toContainText("Não foi possível carregar a foto atual.");
  // O quadro quebrado sai da frente; o `<img>` continua montado para que um
  // carregamento posterior possa desmentir o diagnóstico sem exigir F5.
  await expect(page.getByTestId("cto-photo-preview")).toBeHidden();
  expect((await medirPreview(page)).naturalWidth).toBe(0);

  // A saída está disponível, e não é uma sugestão vazia: enviar uma imagem de
  // verdade tira o aviso e devolve o preview.
  await expect(page.getByTestId("cto-photo-submit")).toHaveText(
    "Substituir foto",
  );
  await enviarFoto(page, await imagemReal(page, 36, 18, "#2e7d32"), "ok.jpg");
  await expect(page.getByTestId("cto-photo-success")).toHaveText(
    "Foto atualizada com sucesso.",
  );
  await expect(aviso).toHaveCount(0);
  await expect
    .poll(async () => (await medirPreview(page)).naturalWidth, {
      timeout: 10_000,
    })
    .toBe(36);

  // E o aviso não volta no recarregamento: o estado seguia o arquivo, não a
  // sessão de tela.
  await page.reload();
  await esperarHidratacao(page);
  await expect(page.getByTestId("cto-photo-broken")).toHaveCount(0);
});

test("a foto vem ANTES de Salvar alterações, no desktop e no mobile", async ({
  page,
}) => {
  /*
    O botão principal aparecia no meio do formulário, antes do último item
    editável. A ordem é verificada por GEOMETRIA, e não pela ordem do código:
    o que importa é onde a pessoa vê cada coisa, e CSS pode reordenar sem que
    o markup mude.
  */
  await setCapability(true);
  await login(page, ADMIN_EMAIL);

  const nome = `E2E-ORDEM-${Date.now()}`;
  await page.goto("/ctos");
  await page.getByLabel("Nome").fill(nome);
  await page.getByLabel("Capacidade (portas)").fill("4");
  await page.getByRole("button", { name: "Cadastrar CTO" }).click();
  await page.getByRole("link", { name: nome }).click();
  await esperarHidratacao(page);

  const salvar = page.getByTestId("cto-save");
  const foto = page.getByTestId("cto-photo-input");

  for (const [rotulo, largura, altura] of [
    ["desktop", 1280, 900],
    ["mobile", 390, 844],
  ] as const) {
    await test.step(rotulo, async () => {
      await page.setViewportSize({ width: largura, height: altura });

      const caixaFoto = (await foto.boundingBox())!;
      const caixaSalvar = (await salvar.boundingBox())!;
      expect(
        caixaFoto.y,
        `${rotulo}: a foto deveria estar acima de Salvar alterações`,
      ).toBeLessThan(caixaSalvar.y);

      // O rótulo mudou de "Salvar" para "Salvar alterações".
      await expect(salvar).toHaveText("Salvar alterações");

      // E não há um segundo botão de salvar no meio do formulário.
      await expect(
        page.getByRole("button", { name: "Salvar", exact: true }),
      ).toHaveCount(0);

      // Nada estoura a largura da viewport.
      const larguraDoc = await page.evaluate(
        () => document.documentElement.scrollWidth,
      );
      expect(larguraDoc).toBeLessThanOrEqual(largura + 1);
    });
  }

  // Editar e salvar pelo botão final continua funcionando.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByLabel("Observações").fill("editado pelo botão final");
  await page
    .getByLabel("Referência de endereço")
    .fill("Poste da esquina, lado par");
  await salvar.click();
  await page.reload();
  await expect(page.getByLabel("Observações")).toHaveValue(
    "editado pelo botão final",
  );
  await expect(page.getByLabel("Referência de endereço")).toHaveValue(
    "Poste da esquina, lado par",
  );
});

test("DISPATCHER não alcança o módulo", async ({ page }) => {
  await setCapability(true);
  await login(page, DISPATCHER_EMAIL);

  await expect(
    page.getByRole("link", { name: "CTOs", exact: true }),
  ).toHaveCount(0);

  // A página é de ADMIN: o despachante é redirecionado, não entra.
  await page.goto("/ctos");
  await expect(page).not.toHaveURL(/\/ctos$/);
});
