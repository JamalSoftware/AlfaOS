import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { allocateServiceOrderNumber } from "../src/lib/service-order-number";
import { assertTestDatabase } from "./test-db-guard";

/**
 * A OS do técnico em celular.
 *
 * O foco é o que a tela ENTREGA e o que ela deixou de mostrar. A autorização
 * continua coberta por `pppoe-access.spec.ts` e pelos testes de tenancy — aqui
 * o alvo é hierarquia, ruído e navegação.
 */

const ADMIN_EMAIL = "admin@alfatelecom.local";
const TECH_EMAIL = "tech-ux@alfatelecom.local";
const PASSWORD = "AlfaOS@2026";

const CUSTOMER_NAME = "Cliente UX Mobile";
const ORDER_DESCRIPTION = "Trocar o roteador e conferir o sinal do cliente.";
const PHONE = "27999887766";
const SECONDARY_PHONE = "2733224455";

const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgresql://alfaos:alfaos_dev_password@localhost:5432/alfaos_test?schema=public";

const prisma = new PrismaClient({
  datasources: { db: { url: E2E_DATABASE_URL } },
});

let customerId = "";
let orderId = "";
let orderUrl = "";
let orderNumber = 0;

/**
 * Entra e ESPERA o redirect terminar.
 *
 * Sem essa espera, o `goto` seguinte corre contra o redirect pós-login e o
 * teste acaba medindo o dashboard. ADMIN cai em /dashboard, TECHNICIAN em
 * /minhas-os — a espera cobre os dois.
 */
async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Senha").fill(PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
  await page.waitForURL(/\/(dashboard|minhas-os)/);
}

test.beforeAll(async () => {
  await assertTestDatabase(E2E_DATABASE_URL, "E2E_DATABASE_URL");

  const seeded = await prisma.user.findUniqueOrThrow({
    where: { email: "tech@alfatelecom.local" },
  });

  const techUser = await prisma.user.upsert({
    where: { email: TECH_EMAIL },
    update: { active: true },
    create: {
      companyId: seeded.companyId,
      name: "Tecnico UX",
      email: TECH_EMAIL,
      profile: "TECHNICIAN",
      passwordHash: seeded.passwordHash,
    },
  });
  const technician = await prisma.technician.upsert({
    where: { userId: techUser.id },
    update: { active: true },
    create: { companyId: techUser.companyId, userId: techUser.id },
  });

  const customer = await prisma.customer.create({
    data: {
      companyId: techUser.companyId,
      name: CUSTOMER_NAME,
      document: "10020030044",
      phone: PHONE,
      secondaryPhone: SECONDARY_PHONE,
      address: "Rua das Palmeiras",
      number: "123",
      complement: "fundos",
      district: "Centro",
      city: "Cachoeiro",
      state: "ES",
      zipCode: "29300-000",
      latitude: -20.848,
      longitude: -41.113,
    },
  });
  customerId = customer.id;

  await prisma.customerConnection.create({
    data: {
      companyId: techUser.companyId,
      customerId: customer.id,
      username: "cliente-ux@provedor",
      usernameSource: "RECEITANET_CHATBOT",
    },
  });

  const order = await prisma.serviceOrder.create({
    data: {
      companyId: techUser.companyId,
      number: await allocateServiceOrderNumber(prisma, techUser.companyId),
      customerId: customer.id,
      technicianId: technician.id,
      type: "Instalação",
      description: ORDER_DESCRIPTION,
      status: "ASSIGNED",
      assignedAt: new Date(),
    },
  });
  orderId = order.id;
  orderNumber = order.number;
  orderUrl = `/ordens/${order.id}`;
});

test.afterAll(async () => {
  const orders = await prisma.serviceOrder.findMany({
    where: { description: ORDER_DESCRIPTION },
    select: { id: true },
  });
  const ids = orders.map((o) => o.id);
  if (ids.length > 0) {
    await prisma.serviceOrderEvent.deleteMany({
      where: { serviceOrderId: { in: ids } },
    });
    await prisma.serviceOrder.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.customerConnection.deleteMany({ where: { customerId } });
  await prisma.customer.deleteMany({ where: { name: CUSTOMER_NAME } });
  await prisma.technician.deleteMany({
    where: { user: { email: TECH_EMAIL } },
  });
  await prisma.user.deleteMany({ where: { email: TECH_EMAIL } });
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// A tela que o técnico recebe
// ---------------------------------------------------------------------------

test.describe("OS do técnico no celular", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("contato, endereço e navegação chegam prontos para usar", async ({
    page,
  }) => {
    await login(page, TECH_EMAIL);
    await expect(page).toHaveURL(/\/minhas-os/);
    await page.goto(orderUrl);

    await expect(page.getByTestId("order-number")).toHaveText(
      `OS Nº ${orderNumber}`,
    );

    // Cada telefone disca o SEU número.
    await expect(page.getByTestId("customer-phone")).toHaveAttribute(
      "href",
      `tel:${PHONE}`,
    );
    await expect(page.getByTestId("customer-secondary-phone")).toHaveAttribute(
      "href",
      `tel:${SECONDARY_PHONE}`,
    );

    // O endereço vem inteiro, com o complemento que faz achar a porta.
    const endereco = page.getByTestId("customer-address");
    await expect(endereco).toContainText("Rua das Palmeiras");
    await expect(endereco).toContainText("fundos");

    // Navegação, com rótulo textual — não só ícone.
    await expect(page.getByTestId("nav-google-maps")).toHaveText("Google Maps");
    await expect(page.getByTestId("nav-waze")).toHaveText("Waze");

    /*
      Alvo de toque: quem liga está em pé, na rua, às vezes de luva. 44px é o
      mínimo que a diretriz de acessibilidade móvel considera alcançável.
    */
    for (const id of ["customer-phone", "nav-google-maps", "nav-waze"]) {
      const caixa = await page.getByTestId(id).boundingBox();
      expect(caixa!.height, id).toBeGreaterThanOrEqual(44);
    }
  });

  test("o serviço tem peso visual, e a ação principal continua lá", async ({
    page,
  }) => {
    await login(page, TECH_EMAIL);
    await page.goto(orderUrl);

    const servico = page.getByTestId("service-description");
    await expect(servico).toContainText(ORDER_DESCRIPTION);

    // Não é mais um parágrafo apagado de 14px no cabeçalho.
    const tamanho = await servico
      .locator("p")
      .last()
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(tamanho).toBeGreaterThanOrEqual(16);

    await expect(
      page.getByRole("button", { name: /iniciar atendimento/i }),
    ).toBeVisible();
  });

  test("o PPPoE fica mascarado e sem administração", async ({ page }) => {
    await login(page, TECH_EMAIL);
    await page.goto(orderUrl);

    await expect(page.getByTestId("pppoe-username")).toHaveText(
      "cliente-ux@provedor",
    );
    // Esta conexão não tem senha: a tela DECLARA a ausência em vez de mascarar.
    await expect(
      page.getByText("Não configurada para este cliente."),
    ).toBeVisible();

    for (const texto of [
      "Gerenciar acesso",
      "Trocar senha",
      "Restaurar padrão",
      "Desativar",
      "Nova conexão PPPoE",
      "Ações avançadas",
    ]) {
      await expect(page.getByText(texto, { exact: false })).toHaveCount(0);
    }
  });

  test("o ruído de integração some da tela do técnico", async ({ page }) => {
    await login(page, TECH_EMAIL);
    await page.goto(orderUrl);

    const html = await page.content();
    for (const ruido of [
      "ID técnico",
      "Nº no ERP",
      "Interna (AlfaOS)",
      "Sem manutenção informada",
      "Esta OS está atribuída a você",
    ]) {
      expect(html, ruido).not.toContain(ruido);
    }

    // O card do provider não existe para ele.
    await expect(page.getByTestId("receitanet-panel")).toHaveCount(0);
    // E o id interno não é apresentado como identificação.
    await expect(page.getByTestId("order-number")).not.toContainText(orderId);
  });

  /** Nenhuma largura pode produzir rolagem lateral. */
  test("cabe em 320px sem overflow horizontal", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await login(page, TECH_EMAIL);
    await page.goto(orderUrl);

    const medida = await page.evaluate(() => ({
      doc: document.documentElement.scrollWidth,
      win: window.innerWidth,
    }));
    expect(medida.doc).toBeLessThanOrEqual(medida.win + 1);
  });
});

// ---------------------------------------------------------------------------
// ADMIN mantém o que tinha
// ---------------------------------------------------------------------------

test.describe("o ADMIN não foi simplificado junto", () => {
  test("continua vendo contexto de integração e administração de acesso", async ({
    page,
  }) => {
    await login(page, ADMIN_EMAIL);
    await expect(page).toHaveURL(/\/dashboard/);
    await page.goto(orderUrl);

    await expect(page.getByRole("link", { name: "Gerenciar acesso" })).toBeVisible();

    // Recolhido, não removido: o conteúdo do <details> continua no HTML.
    const html = await page.content();
    expect(html).toContain("ID interno da OS");

    /*
      "Nº no ERP" NÃO aparece — e é o comportamento correto. Esta OS nasceu
      interna e não tem número externo; a linha some em vez de virar um
      travessão que o operador não sabe se é "não tem" ou "não carregou".
    */
    expect(html).not.toContain("Nº no ERP");
  });

  test("as ações administrativas existem, recolhidas quando o acesso veio do provedor", async ({
    page,
  }) => {
    await login(page, ADMIN_EMAIL);
    await page.goto(`/clientes/${customerId}/editar`);

    const avancadas = page.getByTestId("connection-advanced");
    await expect(avancadas).toBeVisible();

    /*
      Recolhido, não apagado. A capability continua no backend, e o ADMIN a
      usa quando o provedor está fora ou trouxe o dado errado — só que ela
      deixou de disputar espaço com o que se faz todo dia.
    */
    expect(await avancadas.evaluate((el) => el.hasAttribute("open"))).toBe(
      false,
    );
    await expect(page.getByTestId("replace-password")).toHaveCount(1);

    await avancadas.locator("summary").click();
    await expect(page.getByTestId("replace-password")).toBeVisible();
    await expect(page.getByTestId("restore-default-password")).toBeVisible();
    await expect(page.getByTestId("toggle-connection-active")).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Navegação contextual
// ---------------------------------------------------------------------------

test.describe("voltar para onde se veio", () => {
  test("entrando pela OS, o botão volta para a OS", async ({ page }) => {
    await login(page, ADMIN_EMAIL);
    await page.goto(orderUrl);
    await page.getByRole("link", { name: "Gerenciar acesso" }).click();

    await expect(page).toHaveURL(/\/clientes\/.+\/editar\?returnTo=/);
    const voltar = page.getByTestId("customer-back-link");
    await expect(voltar).toHaveText(`← Voltar para OS Nº ${orderNumber}`);

    await voltar.click();
    await expect(page).toHaveURL(new RegExp(`/ordens/${orderId}$`));
  });

  test("entrando pelo menu, o botão volta para clientes", async ({ page }) => {
    await login(page, ADMIN_EMAIL);
    await page.goto(`/clientes/${customerId}/editar`);

    await expect(page.getByTestId("customer-back-link")).toHaveText(
      "← Voltar para clientes",
    );
  });

  /**
   * Redirect aberto: um link montado por terceiro levaria o operador
   * AUTENTICADO para fora do AlfaOS, numa tela que imita a de origem.
   */
  test("destino hostil nunca vira link", async ({ page }) => {
    await login(page, ADMIN_EMAIL);

    const ataques = [
      "https://evil.example",
      "//evil.example",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "/\\evil.example",
      "%2f%2fevil.example",
      "https%3A%2F%2Fevil.example",
      "/ordens/../../evil",
      "/usuarios",
    ];

    for (const ataque of ataques) {
      await page.goto(
        `/clientes/${customerId}/editar?returnTo=${encodeURIComponent(ataque)}`,
      );
      const voltar = page.getByTestId("customer-back-link");
      await expect(voltar, ataque).toHaveText("← Voltar para clientes");
      await expect(voltar, ataque).toHaveAttribute("href", "/clientes");
    }
  });

  /**
   * Formato válido não basta: a OS ainda é resolvida sob a empresa da sessão.
   * Um id bem formado de outro tenant passa pela allowlist e morre na
   * verificação de tenant.
   */
  test("id bem formado de OS inexistente cai no padrão", async ({ page }) => {
    await login(page, ADMIN_EMAIL);
    await page.goto(
      `/clientes/${customerId}/editar?returnTo=${encodeURIComponent(
        "/ordens/cmt000000000000000000000",
      )}`,
    );

    await expect(page.getByTestId("customer-back-link")).toHaveText(
      "← Voltar para clientes",
    );
  });
});

// ---------------------------------------------------------------------------
// A visão compacta do ADMIN
// ---------------------------------------------------------------------------

test.describe("OS do ADMIN — operacional na frente, resto recolhido", () => {
  test("a visão principal não abre ruído de integração", async ({ page }) => {
    await login(page, ADMIN_EMAIL);
    await page.goto(orderUrl);

    // O que responde ao acompanhamento fica aberto.
    await expect(page.getByTestId("customer-card")).toBeVisible();
    await expect(page.getByTestId("diagnostic-panel")).toBeVisible();
    await expect(page.getByTestId("service-description")).toBeVisible();

    /*
      O que descreve COMO o dado foi obtido não. Isso não é falta de
      permissão — as seções estão na página, fechadas.
    */
    for (const id of ["integration-section", "admin-details-section"]) {
      const secao = page.getByTestId(id);
      await expect(secao).toBeVisible();
      expect(
        await secao.evaluate((el) => el.hasAttribute("open")),
        id,
      ).toBe(false);
    }

    // Fechadas, o conteúdo não está na tela.
    await expect(page.getByTestId("order-internal-id")).toBeHidden();
    await expect(page.getByTestId("load-receitanet-context")).toBeHidden();
  });

  test("abrir a integração revela identificadores e a consulta ao provedor", async ({
    page,
  }) => {
    await login(page, ADMIN_EMAIL);
    await page.goto(orderUrl);

    await page.getByTestId("integration-section").locator("summary").click();

    await expect(page.getByTestId("order-internal-id")).toBeVisible();
    await expect(page.getByTestId("order-internal-id")).toHaveText(orderId);
    // A consulta continua sob demanda: abrir a seção não dispara requisição.
    await expect(page.getByTestId("load-receitanet-context")).toBeVisible();
    await expect(page.getByText("Fonte do diagnóstico")).toHaveCount(
      // Só aparece quando existe snapshot; a fixture não tem um.
      await page.getByText("Fonte do diagnóstico").count(),
    );
  });

  test("detalhes administrativos abrem, e campo vazio não aparece", async ({
    page,
  }) => {
    await login(page, ADMIN_EMAIL);
    await page.goto(orderUrl);

    await page
      .getByTestId("admin-details-section")
      .locator("summary")
      .click();

    const secao = page.getByTestId("admin-details-section");
    await expect(secao.getByText("Origem", { exact: true })).toBeVisible();
    await expect(secao.getByText("Atribuída em")).toBeVisible();

    /*
      A fixture não tem agendamento nem início. As linhas não podem existir
      com travessão — o operador não distingue "não tem" de "não carregou".
    */
    await expect(secao.getByText("Agendamento")).toHaveCount(0);
    await expect(secao.getByText("Iniciada em")).toHaveCount(0);
    await expect(secao.getByText("—", { exact: true })).toHaveCount(0);
  });

  /** Compactar não removeu capability administrativa nenhuma. */
  test("o ADMIN mantém Gerenciar acesso", async ({ page }) => {
    await login(page, ADMIN_EMAIL);
    await page.goto(orderUrl);

    await expect(
      page.getByRole("link", { name: "Gerenciar acesso" }),
    ).toBeVisible();
  });

  /** O diagnóstico do ADMIN ficou tão enxuto quanto o do técnico. */
  test("o diagnóstico não mostra tecnologia nem fonte na visão principal", async ({
    page,
  }) => {
    await login(page, ADMIN_EMAIL);
    await page.goto(orderUrl);

    const painel = page.getByTestId("diagnostic-panel");
    await expect(painel.getByTestId("diagnostic-technology")).toHaveCount(0);
    await expect(painel.getByTestId("diagnostic-maintenance")).toHaveCount(0);
    await expect(painel.getByText("Sem manutenção informada")).toHaveCount(0);
    await expect(painel.getByText("Fonte", { exact: true })).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// Inspeção visual automatizada
// ---------------------------------------------------------------------------

/**
 * Auditoria de contraste rodada DENTRO da página.
 *
 * Mede a cor computada de cada elemento com texto visível contra o fundo
 * efetivo — subindo a árvore até achar algo opaco. Assertar nome de classe
 * provaria que a classe está lá, não que ela pinta algo legível.
 */
const AUDITORIA = () => {
  const lum = (c: number[]) => {
    const f = (v: number) => {
      const x = v / 255;
      return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const parse = (valor: string) => {
    const m = /rgba?\(([^)]+)\)/.exec(valor);
    if (!m) return null;
    const p = m[1].split(",").map(Number);
    return { rgb: [p[0], p[1], p[2]], a: p.length > 3 ? p[3] : 1 };
  };
  const razao = (a: number[], b: number[]) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  const fundo = (el: Element): number[] => {
    let n: Element | null = el;
    while (n && n !== document.documentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c.a >= 0.95) return c.rgb;
      n = n.parentElement;
    }
    return parse(getComputedStyle(document.body).backgroundColor)!.rgb;
  };

  const problemas: string[] = [];
  let inspecionados = 0;

  document.querySelectorAll("body *").forEach((el) => {
    const texto = Array.from(el.childNodes)
      .filter((n) => n.nodeType === 3)
      .map((n) => (n.textContent ?? "").trim())
      .join(" ")
      .trim();
    if (!texto) return;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none") return;
    if (Number(cs.opacity) === 0) return;
    const caixa = el.getBoundingClientRect();
    if (!caixa.width || !caixa.height) return;
    const fg = parse(cs.color);
    if (!fg || fg.a < 0.5) return;
    inspecionados++;

    const px = parseFloat(cs.fontSize);
    const peso = parseInt(cs.fontWeight, 10) || 400;
    const grande = px >= 24 || (px >= 18.66 && peso >= 700);
    const minimo = grande ? 3 : 4.5;
    const r = razao(fg.rgb, fundo(el));
    if (r < minimo) {
      problemas.push(
        `${r.toFixed(2)}:1 (min ${minimo}) ${Math.round(px)}px "${texto.slice(0, 40)}"`,
      );
    }

    // Elemento cortado pela borda direita da janela.
    if (caixa.right > window.innerWidth + 1) {
      problemas.push(`cortado à direita: "${texto.slice(0, 40)}"`);
    }
  });

  return {
    inspecionados,
    problemas,
    overflow:
      document.documentElement.scrollWidth > window.innerWidth + 1
        ? `${document.documentElement.scrollWidth} > ${window.innerWidth}`
        : null,
  };
};

const LARGURAS = [320, 375, 768, 1280];

for (const tema of ["light", "dark"] as const) {
  test.describe(`medições — tema ${tema}`, () => {
    test.use({ colorScheme: tema });

    for (const [perfil, email] of [
      ["técnico", TECH_EMAIL],
      ["admin", ADMIN_EMAIL],
    ] as const) {
    test(`a OS do ${perfil} se comporta em ${LARGURAS.join(", ")}px`, async ({
      page,
    }) => {
      await login(page, email);

      for (const largura of LARGURAS) {
        await page.setViewportSize({ width: largura, height: 900 });
        await page.goto(orderUrl, { waitUntil: "networkidle" });

        /*
          Para o admin, as seções recolhidas são ABERTAS antes de medir.
          Fechadas, o conteúdo delas nunca entraria na auditoria de
          contraste — e é justamente ali que mora texto pequeno em fonte
          monoespaçada.
        */
        if (perfil === "admin") {
          for (const id of [
            "integration-section",
            "admin-details-section",
          ]) {
            const secao = page.getByTestId(id);
            if ((await secao.count()) > 0) {
              await secao.locator("summary").click();
            }
          }
        }

        // O tema resolvido tem de ser o emulado — sem preferência gravada,
        // `system` segue o aparelho.
        expect(
          await page.evaluate(
            () => document.documentElement.dataset.theme ?? null,
          ),
        ).toBe(tema);

        const r = await page.evaluate(AUDITORIA);

        expect(
          r.inspecionados,
          `${perfil} ${tema}/${largura}px sem conteúdo`,
        ).toBeGreaterThan(10);
        expect(
          r.overflow,
          `${perfil} ${tema}/${largura}px overflow`,
        ).toBeNull();
        expect(
          r.problemas,
          `${perfil} ${tema}/${largura}px:\n  ${r.problemas.join("\n  ")}`,
        ).toEqual([]);
      }
    });
    }
  });
}
