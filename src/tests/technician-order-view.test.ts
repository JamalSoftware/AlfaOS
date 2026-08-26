import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { createCustomerConnection } from "@/lib/customer-connections";
import { createManualServiceOrder } from "@/lib/service-orders";
import { createTokenFor, seedTestData, type TestFixture } from "./helpers";

/**
 * A tela da OS pelos olhos do TÉCNICO.
 *
 * Renderiza o Server Component e inspeciona a árvore devolvida — que é o
 * payload enviado ao browser. É onde um "o técnico não vê isso" implementado
 * escondendo no CSS seria pego: a árvore carrega a prop mesmo quando a tela
 * não a desenha.
 *
 * O alvo aqui é HIERARQUIA e RUÍDO, não autorização. A autorização de verdade
 * — quem revela senha, quem alcança qual OS — está em
 * `customer-connections.test.ts` e `authorization.test.ts`, e continua valendo
 * integralmente.
 */

const session = vi.hoisted(() => ({ token: null as string | null }));

vi.mock("next/headers", () => ({
  cookies: () => ({
    get: (name: string) =>
      session.token ? { name, value: session.token } : undefined,
  }),
}));

const TELEFONE = "27999887766";
const TELEFONE_ALT = "2733224455";

let fixture: TestFixture;

beforeEach(async () => {
  fixture = await seedTestData();
  session.token = null;
});

interface ElementLike {
  type?: unknown;
  props?: Record<string, unknown>;
}

function isElementLike(value: unknown): value is ElementLike {
  return typeof value === "object" && value !== null && "props" in value;
}

/** Texto e primitivos de toda a árvore — o `page.content()` do unitário. */
function flatten(node: unknown, seen = new Set<object>()): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return ` ${node} `;
  if (Array.isArray(node)) return node.map((c) => flatten(c, seen)).join("");
  if (typeof node !== "object") return "";
  if (seen.has(node)) return "";
  seen.add(node);

  /*
    Objeto simples também entra.

    Sem isto a promessa desta função era falsa: uma prop que é objeto ou
    array de objetos — `rows={[{ label, value }]}` — passava inteira
    despercebida, e um segredo dentro dela passaria junto.
  */
  if (!isElementLike(node)) {
    return Object.entries(node as Record<string, unknown>)
      .map(([key, value]) => `${key}:${flatten(value, seen)}`)
      .join(" ");
  }
  return Object.entries(node.props ?? {})
    .map(([key, value]) => `${key}:${flatten(value, seen)}`)
    .join(" ");
}

function walk(node: unknown, seen = new Set<object>()): ElementLike[] {
  if (node === null || node === undefined || typeof node === "boolean") return [];
  if (Array.isArray(node)) return node.flatMap((c) => walk(c, seen));
  if (typeof node !== "object") return [];
  if (seen.has(node)) return [];
  seen.add(node);
  const found: ElementLike[] = [];
  if (isElementLike(node)) {
    found.push(node);
    for (const value of Object.values(node.props ?? {})) {
      found.push(...walk(value, seen));
    }
  }
  return found;
}

/** Nós com um `data-testid` específico. */
function porTestId(tree: unknown, testId: string): ElementLike[] {
  return walk(tree).filter((n) => n.props?.["data-testid"] === testId);
}

/** Props de um componente pelo nome da função. */
function propsDe(tree: unknown, nome: string): Record<string, unknown>[] {
  return walk(tree)
    .filter(
      (n) =>
        typeof n.type === "function" &&
        (n.type as { name?: string }).name === nome,
    )
    .map((n) => n.props ?? {});
}

/**
 * Renderiza o `CustomerContactCard` com as props que a PÁGINA passou.
 *
 * Na árvore devolvida pelo Server Component o card é um nó não expandido:
 * `walk` enxerga as props, nunca a saída. Assertar só nas props provaria
 * que a página entrega o dado certo — e não que o card monta o link certo.
 * Chamar a função com as props reais liga as duas pontas.
 */
function renderContactCard(tree: unknown): unknown {
  const no = walk(tree).find(
    (n) =>
      typeof n.type === "function" &&
      (n.type as { name?: string }).name === "CustomerContactCard",
  );
  if (!no) throw new Error("CustomerContactCard não está na árvore");
  return (no.type as (p: unknown) => unknown)(no.props);
}

async function renderOrderPage(orderId: string) {
  const { default: OrderDetailPage } = await import(
    "@/app/(app)/ordens/[id]/page"
  );
  return OrderDetailPage({ params: { id: orderId } });
}

interface Cenario {
  orderId: string;
  customerId: string;
  number: number;
}

async function cenario(
  opcoes: {
    phone?: string | null;
    secondaryPhone?: string | null;
    endereco?: boolean;
    coordenada?: boolean;
    comConexao?: boolean;
    scheduledAt?: Date | null;
  } = {},
): Promise<Cenario> {
  const {
    phone = TELEFONE,
    secondaryPhone = TELEFONE_ALT,
    endereco = true,
    coordenada = true,
    comConexao = true,
    scheduledAt = null,
  } = opcoes;

  const customer = await prisma.customer.create({
    data: {
      companyId: fixture.companyA.id,
      name: "Cliente da OS",
      document: "10020030044",
      phone,
      secondaryPhone,
      ...(endereco
        ? {
            address: "Rua das Palmeiras",
            number: "123",
            complement: "fundos",
            district: "Centro",
            city: "Cachoeiro",
            state: "ES",
            zipCode: "29300-000",
          }
        : {}),
      ...(coordenada ? { latitude: -20.848, longitude: -41.113 } : {}),
    },
  });

  const technician = await prisma.technician.create({
    data: { companyId: fixture.companyA.id, userId: fixture.techA.id },
  });

  const order = await createManualServiceOrder(
    fixture.companyA.id,
    fixture.adminA.id,
    {
      customerId: customer.id,
      typeId: fixture.typeA.id,
      description: "Trocar o roteador e conferir o sinal.",
      priority: "NORMAL",
    },
  );

  await prisma.serviceOrder.update({
    where: { id: order.id },
    data: {
      technicianId: technician.id,
      status: "ASSIGNED",
      assignedAt: new Date(),
      scheduledAt,
    },
  });

  if (comConexao) {
    await createCustomerConnection(fixture.companyA.id, fixture.adminA.id, {
      customerId: customer.id,
      username: "cliente-unit@provedor",
      password: "Sen#aPPPoE-Unit-9xQ2",
    });
  }

  return { orderId: order.id, customerId: customer.id, number: order.number };
}

const comoTecnico = async () => {
  session.token = await createTokenFor(fixture.techA.id);
};
const comoAdmin = async () => {
  session.token = await createTokenFor(fixture.adminA.id);
};

// ---------------------------------------------------------------------------
// Contato e localização
// ---------------------------------------------------------------------------

describe("contato do cliente", () => {
  it("os dois telefones aparecem, cada link com o SEU número", async () => {
    const c = await cenario();
    await comoTecnico();
    const card = renderContactCard(await renderOrderPage(c.orderId));

    const principal = porTestId(card, "customer-phone")[0];
    const alternativo = porTestId(card, "customer-secondary-phone")[0];

    expect(principal?.props?.href).toBe(`tel:${TELEFONE}`);
    expect(alternativo?.props?.href).toBe(`tel:${TELEFONE_ALT}`);
    // Cada link disca o próprio número — trocá-los é o defeito silencioso.
    expect(principal?.props?.href).not.toBe(alternativo?.props?.href);
  });

  /**
   * Só o alternativo preenchido é cadastro real. Em campos fixos isso
   * produziria "Telefone: não informado" logo acima de um número que existe e
   * funciona — o técnico leria a primeira linha e desistiria.
   */
  it("com apenas o alternativo, ele assume o papel de telefone", async () => {
    const c = await cenario({ phone: null });
    await comoTecnico();
    const card = renderContactCard(await renderOrderPage(c.orderId));

    expect(porTestId(card, "customer-phone")).toHaveLength(0);
    expect(porTestId(card, "customer-secondary-phone")[0]?.props?.href).toBe(
      `tel:${TELEFONE_ALT}`,
    );
    expect(flatten(card)).not.toContain("Telefone não informado");
  });

  it("sem telefone nenhum, uma única mensagem de ausência", async () => {
    const c = await cenario({ phone: null, secondaryPhone: null });
    await comoTecnico();
    const texto = flatten(renderContactCard(await renderOrderPage(c.orderId)));

    const ocorrencias = texto.split("Telefone não informado").length - 1;
    expect(ocorrencias).toBe(1);
  });

  it("o endereço chega inteiro, com o complemento", async () => {
    const c = await cenario();
    await comoTecnico();
    const endereco = porTestId(
      renderContactCard(await renderOrderPage(c.orderId)),
      "customer-address",
    )[0];

    const texto = flatten(endereco);
    expect(texto).toContain("Rua das Palmeiras");
    expect(texto).toContain("123");
    // "fundos" é o que decide se ele acha a porta.
    expect(texto).toContain("fundos");
    expect(texto).toContain("Cachoeiro/ES");
  });
});

describe("navegação", () => {
  it("Google Maps e Waze aparecem quando há coordenada", async () => {
    const c = await cenario();
    await comoTecnico();
    const card = renderContactCard(await renderOrderPage(c.orderId));

    const maps = porTestId(card, "nav-google-maps")[0];
    const waze = porTestId(card, "nav-waze")[0];
    expect(String(maps?.props?.href)).toContain("google.com/maps");
    expect(String(waze?.props?.href)).toContain("waze.com/ul");
  });

  it("sem coordenada, a navegação usa o endereço", async () => {
    const c = await cenario({ coordenada: false });
    await comoTecnico();
    const card = renderContactCard(await renderOrderPage(c.orderId));

    expect(porTestId(card, "nav-google-maps")).toHaveLength(1);
    expect(flatten(card)).toContain("sem coordenada cadastrada");
  });

  it("sem coordenada e sem endereço, nenhum botão de navegação", async () => {
    const c = await cenario({ coordenada: false, endereco: false });
    await comoTecnico();
    const card = renderContactCard(await renderOrderPage(c.orderId));

    expect(porTestId(card, "nav-google-maps")).toHaveLength(0);
    expect(porTestId(card, "nav-waze")).toHaveLength(0);
  });

  /**
   * Coordenada crua na tela não ajuda ninguém a chegar num lugar, e ocupa a
   * linha onde deveria estar o endereço. Ela vai só dentro do `href`.
   */
  it("latitude e longitude não são exibidas como texto", async () => {
    const c = await cenario();
    await comoTecnico();
    const card = renderContactCard(await renderOrderPage(c.orderId));

    // O `href` contém; o texto do endereço, não.
    const endereco = flatten(
      porTestId(card, "customer-address")[0] ?? null,
    );
    expect(endereco).not.toContain("-20.848");
    expect(endereco).not.toContain("-41.113");
  });
});

// ---------------------------------------------------------------------------
// PPPoE
// ---------------------------------------------------------------------------

describe("acesso PPPoE do técnico", () => {
  it("o painel chega na variante do técnico, e a senha não vem junto", async () => {
    const c = await cenario();
    await comoTecnico();
    const tree = await renderOrderPage(c.orderId);

    const painel = propsDe(tree, "PppoeAccessPanel")[0];
    expect(painel?.variant).toBe("technician");
    expect(painel?.username).toBe("cliente-unit@provedor");
    expect(painel?.passwordConfigured).toBe(true);
    // O que chega é um booleano. A senha só sai por requisição auditada.
    expect(flatten(tree)).not.toContain("Sen#aPPPoE-Unit-9xQ2");
  });

  /**
   * O técnico já tem na própria OS o que precisa: copiar usuário, revelar e
   * copiar senha. Mandá-lo para "Editar cliente" o levaria a uma tela de
   * administração de cadastro que ele não deve operar.
   */
  it('o técnico NÃO recebe "Gerenciar acesso"', async () => {
    const c = await cenario();
    await comoTecnico();
    expect(flatten(await renderOrderPage(c.orderId))).not.toContain(
      "Gerenciar acesso",
    );
  });

  it("nem as ações administrativas de conexão", async () => {
    const c = await cenario();
    await comoTecnico();
    const texto = flatten(await renderOrderPage(c.orderId));

    for (const acao of [
      "Trocar senha",
      "Restaurar padrão",
      "Desativar",
      "Nova conexão PPPoE",
      "Ações avançadas",
    ]) {
      expect(texto, acao).not.toContain(acao);
    }
  });

  it("o ADMIN continua recebendo o caminho administrativo", async () => {
    const c = await cenario();
    await comoAdmin();
    const tree = await renderOrderPage(c.orderId);
    const texto = flatten(tree);

    expect(texto).toContain("Gerenciar acesso");
    // E o link carrega a origem, para o botão de voltar saber de onde veio.
    expect(texto).toContain(`%2Fordens%2F${c.orderId}`);
  });
});

// ---------------------------------------------------------------------------
// Diagnóstico
// ---------------------------------------------------------------------------

describe("diagnóstico", () => {
  /**
   * A visão principal é a MESMA para os dois perfis, e compacta.
   *
   * Havia uma variante `staff` que abria código de tecnologia, provider e
   * a linha "sem manutenção informada". As três foram para "Informações de
   * integração", recolhida: permissão não é prioridade.
   */
  it("é compacto para os dois perfis", async () => {
    const c = await cenario();

    for (const entrar of [comoTecnico, comoAdmin]) {
      await entrar();
      const tree = await renderOrderPage(c.orderId);
      const painel = propsDe(tree, "CustomerDiagnosticPanel")[0];
      expect(painel).toBeDefined();
      // Sem variante: não há duas telas para divergirem.
      expect(painel?.variant).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Ruído removido
// ---------------------------------------------------------------------------

describe("ruído fora da tela do técnico", () => {
  it("nada de ReceitaNet como card próprio", async () => {
    const c = await cenario();
    await comoTecnico();
    const tree = await renderOrderPage(c.orderId);

    expect(propsDe(tree, "ReceitanetContextPanel")).toHaveLength(0);
  });

  it("nem id técnico, nem origem, nem número de ERP", async () => {
    const c = await cenario();
    await comoTecnico();
    const texto = flatten(await renderOrderPage(c.orderId));

    expect(texto).not.toContain("ID técnico");
    expect(texto).not.toContain("Origem");
    expect(texto).not.toContain("Nº no ERP");
    expect(texto).not.toContain("Interna (AlfaOS)");
  });

  /**
   * O card "Técnico" diria ao próprio dono o nome dele e "atribuída a você" —
   * informação que ele obteve ao abrir a OS a partir de Minhas OS.
   */
  it("o card do técnico não aparece para o próprio técnico", async () => {
    const c = await cenario();
    await comoTecnico();
    expect(flatten(await renderOrderPage(c.orderId))).not.toContain(
      "Esta OS está atribuída a você",
    );
  });

  it("campo de detalhe sem valor não é renderizado", async () => {
    // Sem agendamento e sem início: as duas linhas devem sumir, não virar "—".
    const c = await cenario({ scheduledAt: null });
    await comoTecnico();
    const texto = flatten(await renderOrderPage(c.orderId));

    expect(texto).not.toContain("Agendamento");
    expect(texto).not.toContain("Iniciada em");
    // A que tem valor continua.
    expect(texto).toContain("Atribuída em");
  });

  it("com agendamento, a linha aparece", async () => {
    const c = await cenario({ scheduledAt: new Date() });
    await comoTecnico();
    expect(flatten(await renderOrderPage(c.orderId))).toContain("Agendamento");
  });
});

// ---------------------------------------------------------------------------
// O que continua na tela
// ---------------------------------------------------------------------------

describe("o que o técnico continua vendo", () => {
  it("número operacional, descrição do serviço e a ação principal", async () => {
    const c = await cenario();
    await comoTecnico();
    const tree = await renderOrderPage(c.orderId);
    const texto = flatten(tree);

    expect(texto).toContain(`OS Nº ${c.number}`);
    expect(porTestId(tree, "service-description")).toHaveLength(1);
    expect(texto).toContain("Trocar o roteador e conferir o sinal.");
    // A OS está em ASSIGNED: a ação é iniciar.
    expect(propsDe(tree, "StartServiceOrderButton")).toHaveLength(1);
  });

  /**
   * Compactar não é remover. O staff continua alcançando tudo — só que
   * recolhido, sob duas seções que ele abre quando vai falar com o
   * provedor ou conferir uma data.
   */
  it("o staff mantém acesso a tudo, agora recolhido", async () => {
    const c = await cenario();
    await comoAdmin();
    const tree = await renderOrderPage(c.orderId);
    const texto = flatten(tree);

    expect(porTestId(tree, "integration-section")).toHaveLength(1);
    expect(porTestId(tree, "admin-details-section")).toHaveLength(1);

    expect(texto).toContain("ID interno da OS");
    expect(texto).toContain("Origem");
    expect(texto).toContain("Nº no ERP");
    expect(texto).toContain(c.orderId);
    expect(propsDe(tree, "ReceitanetContextPanel").length).toBeGreaterThan(0);
  });

  /**
   * Recolhido de verdade: `<details>` sem `open`. Aberto por padrão, a
   * compactação seria só reordenação.
   */
  it("as duas seções nascem fechadas", async () => {
    const c = await cenario();
    await comoAdmin();
    const tree = await renderOrderPage(c.orderId);

    for (const id of ["integration-section", "admin-details-section"]) {
      const secao = porTestId(tree, id)[0];
      expect(secao?.props?.defaultOpen, id).toBeFalsy();
    }
  });

  /** O técnico não ganha nenhuma das duas. */
  it("o técnico não recebe as seções administrativas", async () => {
    const c = await cenario();
    await comoTecnico();
    const tree = await renderOrderPage(c.orderId);

    expect(porTestId(tree, "integration-section")).toHaveLength(0);
    expect(porTestId(tree, "admin-details-section")).toHaveLength(0);
  });
});
