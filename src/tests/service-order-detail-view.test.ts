import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  createCustomerConnection,
  updateCustomerConnection,
} from "@/lib/customer-connections";
import { createManualServiceOrder } from "@/lib/service-orders";
import {
  createTokenFor,
  seedTestData,
  type TestFixture,
} from "./helpers";

/**
 * Tela da OS: número operacional e acesso PPPoE.
 *
 * Este arquivo renderiza o SERVER COMPONENT e inspeciona a árvore que ele
 * devolve — que é literalmente o payload enviado ao browser. É onde um
 * "só o técnico vê a senha" implementado com `hidden` no CSS, ou uma senha
 * passada como prop e escondida na renderização, seria pego: a árvore carrega
 * a prop mesmo quando a tela não a desenha.
 *
 * O que ESTE arquivo não testa (e outros testam): a autorização de verdade,
 * que é de `revealConnectionPasswordForOrder` e está coberta em
 * `customer-connections.test.ts`. Aqui o alvo é o payload inicial.
 */

const session = vi.hoisted(() => ({ token: null as string | null }));

vi.mock("next/headers", () => ({
  cookies: () => ({
    get: (name: string) =>
      session.token ? { name, value: session.token } : undefined,
  }),
}));

const PPPOE_PASSWORD = "Sen#aPPPoE-Unit-9xQ2";
const PPPOE_USERNAME = "cliente-unit@provedor";

let fixture: TestFixture;

beforeEach(async () => {
  fixture = await seedTestData();
  session.token = null;
});

// ---------------------------------------------------------------------------
// Inspeção da árvore devolvida pelo Server Component
// ---------------------------------------------------------------------------

interface ElementLike {
  type?: unknown;
  props?: Record<string, unknown>;
}

function isElementLike(value: unknown): value is ElementLike {
  return typeof value === "object" && value !== null && "props" in value;
}

/** Todo nó da árvore, em ordem de profundidade. */
function walk(node: unknown, seen = new Set<object>()): ElementLike[] {
  if (node === null || node === undefined || typeof node === "boolean") {
    return [];
  }
  if (Array.isArray(node)) {
    return node.flatMap((child) => walk(child, seen));
  }
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

/**
 * Texto e valores primitivos de props de TODA a árvore.
 *
 * É o equivalente unitário do `page.content()` do E2E: se um segredo estiver
 * em qualquer prop, de qualquer profundidade, ele aparece aqui.
 */
function flatten(node: unknown, seen = new Set<object>()): string {
  if (node === null || node === undefined || typeof node === "boolean") {
    return "";
  }
  if (typeof node === "string" || typeof node === "number") {
    return ` ${node} `;
  }
  if (Array.isArray(node)) {
    return node.map((child) => flatten(child, seen)).join("");
  }
  if (typeof node !== "object") return "";
  if (seen.has(node)) return "";
  seen.add(node);

  if (!isElementLike(node)) return "";
  return Object.entries(node.props ?? {})
    .map(([key, value]) => `${key}:${flatten(value, seen)}`)
    .join(" ");
}

function pppoePanels(tree: unknown): Record<string, unknown>[] {
  return walk(tree)
    .filter(
      (node) =>
        typeof node.type === "function" &&
        (node.type as { name?: string }).name === "PppoeAccessPanel",
    )
    .map((node) => node.props ?? {});
}

async function renderOrderPage(orderId: string) {
  const { default: OrderDetailPage } = await import(
    "@/app/(app)/ordens/[id]/page"
  );
  return OrderDetailPage({ params: { id: orderId } });
}

async function expectNotFound(run: () => Promise<unknown>): Promise<void> {
  await expect(run()).rejects.toMatchObject({ digest: "NEXT_NOT_FOUND" });
}

// ---------------------------------------------------------------------------
// Cenário
// ---------------------------------------------------------------------------

interface Scenario {
  orderId: string;
  customerId: string;
  connectionId: string;
  technicianId: string;
  number: number;
}

async function scenario(
  options: {
    withConnection?: boolean;
    withPassword?: boolean;
    status?: "ASSIGNED" | "IN_PROGRESS" | "COMPLETED";
  } = {},
): Promise<Scenario> {
  const {
    withConnection = true,
    withPassword = true,
    status = "ASSIGNED",
  } = options;

  const customer = await prisma.customer.create({
    data: { companyId: fixture.companyA.id, name: "Cliente da OS" },
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
      description: "OS da tela.",
      priority: "NORMAL",
    },
  );

  await prisma.serviceOrder.update({
    where: { id: order.id },
    data: {
      technicianId: technician.id,
      status,
      assignedAt: new Date(),
      startedAt: status === "ASSIGNED" ? null : new Date(),
      completedAt: status === "COMPLETED" ? new Date() : null,
    },
  });

  let connectionId = "";
  if (withConnection) {
    const connection = await createCustomerConnection(
      fixture.companyA.id,
      fixture.adminA.id,
      {
        customerId: customer.id,
        username: PPPOE_USERNAME,
        password: withPassword ? PPPOE_PASSWORD : null,
      },
    );
    connectionId = connection.id;
  }

  return {
    orderId: order.id,
    customerId: customer.id,
    connectionId,
    technicianId: technician.id,
    number: order.number,
  };
}

// ---------------------------------------------------------------------------
// Número operacional na tela
// ---------------------------------------------------------------------------

describe("Identificação da OS na tela", () => {
  it("o cabeçalho mostra o número operacional, não o id técnico", async () => {
    const s = await scenario();
    session.token = await createTokenFor(fixture.adminA.id);

    const tree = await renderOrderPage(s.orderId);
    const heading = walk(tree).find(
      (node) => node.props?.["data-testid"] === "order-number",
    );

    expect(heading).toBeDefined();
    expect(flatten(heading)).toContain(`OS Nº ${s.number}`);
    // O cuid não é a identificação operacional — ele não entra no cabeçalho.
    expect(flatten(heading)).not.toContain(s.orderId);
  });

  it("o id técnico continua disponível, mas fora do cabeçalho", async () => {
    const s = await scenario();
    session.token = await createTokenFor(fixture.adminA.id);

    const tree = await renderOrderPage(s.orderId);
    const whole = flatten(tree);

    // Continua na página (diagnóstico) e no href, apenas não como identificação.
    expect(whole).toContain(s.orderId);
    expect(whole).toContain("ID técnico");
  });

  it("a tela do técnico dono também mostra o número operacional", async () => {
    const s = await scenario();
    session.token = await createTokenFor(fixture.techA.id);

    const tree = await renderOrderPage(s.orderId);
    expect(flatten(tree)).toContain(`OS Nº ${s.number}`);
  });
});

// ---------------------------------------------------------------------------
// PPPoE — visão administrativa
// ---------------------------------------------------------------------------

describe("Acesso do cliente — ADMIN", () => {
  it("vê usuário e o estado da senha, nunca o texto claro", async () => {
    const s = await scenario();
    session.token = await createTokenFor(fixture.adminA.id);

    const tree = await renderOrderPage(s.orderId);
    const panels = pppoePanels(tree);

    expect(panels).toHaveLength(1);
    expect(panels[0]).toMatchObject({
      variant: "admin",
      username: PPPOE_USERNAME,
      passwordConfigured: true,
      connectionId: s.connectionId,
    });

    /**
     * O ponto central: a senha não está em NENHUMA prop da árvore. Se ela
     * chegasse aqui, chegaria também ao HTML servido e ao payload do Server
     * Component — visível em "ver código-fonte", sem clique nenhum e sem
     * auditoria.
     */
    expect(flatten(tree)).not.toContain(PPPOE_PASSWORD);
    expect(flatten(tree)).toContain("Acesso do cliente");
    /*
      Controle positivo do `not.toContain` acima: `flatten` REALMENTE alcança
      as props do painel. O `username` chega até lá pelo mesmo caminho que a
      senha percorreria — se a travessia estivesse quebrada, o teste negativo
      estaria passando por vazio.
    */
    expect(flatten(tree)).toContain(PPPOE_USERNAME);
  });

  it("ADMIN mantém a capacidade de revelar, inclusive com a OS concluída", async () => {
    // PRD §132: depois de COMPLETED o TÉCNICO não revela mais; o ADMIN mantém
    // a capacidade administrativa.
    const s = await scenario({ status: "COMPLETED" });
    session.token = await createTokenFor(fixture.adminA.id);

    const panels = pppoePanels(await renderOrderPage(s.orderId));
    expect(panels[0]).toMatchObject({ variant: "admin", canReveal: true });
  });

  it("sem conexão cadastrada, a seção diz que o acesso não está configurado", async () => {
    const s = await scenario({ withConnection: false });
    session.token = await createTokenFor(fixture.adminA.id);

    const tree = await renderOrderPage(s.orderId);

    expect(pppoePanels(tree)).toHaveLength(0);
    expect(flatten(tree)).toContain("Acesso PPPoE não configurado.");
    // E o atalho para cadastrar, que só o ADMIN pode usar.
    expect(flatten(tree)).toContain(`/clientes/${s.customerId}/editar`);
  });

  it("usuário cadastrado sem senha aparece como não configurada", async () => {
    const s = await scenario({ withPassword: false });
    session.token = await createTokenFor(fixture.adminA.id);

    const panels = pppoePanels(await renderOrderPage(s.orderId));
    expect(panels[0]).toMatchObject({
      username: PPPOE_USERNAME,
      passwordConfigured: false,
    });
  });

  it("DISPATCHER não recebe nem o usuário PPPoE", async () => {
    const s = await scenario();
    session.token = await createTokenFor(fixture.dispatcherA.id);

    const tree = await renderOrderPage(s.orderId);

    expect(pppoePanels(tree)).toHaveLength(0);
    expect(flatten(tree)).not.toContain(PPPOE_USERNAME);
    expect(flatten(tree)).not.toContain(PPPOE_PASSWORD);
    // A seção inteira some — não é um card vazio dizendo que existe algo ali.
    expect(flatten(tree)).not.toContain("Acesso do cliente");
    // Controle positivo: o DISPATCHER de fato abriu a OS.
    expect(flatten(tree)).toContain(`OS Nº ${s.number}`);
  });
});

// ---------------------------------------------------------------------------
// PPPoE — visão do técnico
// ---------------------------------------------------------------------------

describe("Acesso do cliente — técnico", () => {
  for (const status of ["ASSIGNED", "IN_PROGRESS"] as const) {
    it(`o técnico dono recebe os controles com a OS em ${status}`, async () => {
      const s = await scenario({ status });
      session.token = await createTokenFor(fixture.techA.id);

      const tree = await renderOrderPage(s.orderId);
      const panels = pppoePanels(tree);

      expect(panels).toHaveLength(1);
      expect(panels[0]).toMatchObject({
        variant: "technician",
        username: PPPOE_USERNAME,
        passwordConfigured: true,
        canReveal: true,
        revealBlockedReason: null,
      });
      expect(flatten(tree)).not.toContain(PPPOE_PASSWORD);
    });
  }

  it("com a OS concluída o técnico perde a ação, mas não o painel", async () => {
    const s = await scenario({ status: "COMPLETED" });
    session.token = await createTokenFor(fixture.techA.id);

    const tree = await renderOrderPage(s.orderId);
    const panels = pppoePanels(tree);

    expect(panels[0]).toMatchObject({
      variant: "technician",
      username: PPPOE_USERNAME,
      canReveal: false,
      revealBlockedReason:
        "A senha só pode ser revelada enquanto o atendimento estiver em andamento.",
    });
    expect(flatten(tree)).not.toContain(PPPOE_PASSWORD);
  });

  it("técnico DESATIVADO não recebe ação, e o motivo é a elegibilidade", async () => {
    const s = await scenario({ status: "IN_PROGRESS" });
    await prisma.technician.update({
      where: { id: s.technicianId },
      data: { active: false },
    });
    session.token = await createTokenFor(fixture.techA.id);

    const panels = pppoePanels(await renderOrderPage(s.orderId));

    expect(panels[0]).toMatchObject({ canReveal: false });
    // Elegibilidade ANTES de status, igual à ordem em que o servidor avalia.
    expect(String(panels[0].revealBlockedReason)).toContain(
      "perfil técnico está inativo",
    );

    // Controle positivo: reativado, a ação volta.
    await prisma.technician.update({
      where: { id: s.technicianId },
      data: { active: true },
    });
    const again = pppoePanels(await renderOrderPage(s.orderId));
    expect(again[0]).toMatchObject({ canReveal: true });
  });

  it("técnico que não é dono da OS não chega à tela (404)", async () => {
    const s = await scenario();
    await prisma.technician.create({
      data: { companyId: fixture.companyA.id, userId: fixture.techB.id },
    });
    session.token = await createTokenFor(fixture.techB.id);

    await expectNotFound(() => renderOrderPage(s.orderId));
  });
});

// ---------------------------------------------------------------------------
// Múltiplas conexões
// ---------------------------------------------------------------------------

describe("Múltiplas conexões do cliente", () => {
  it("todas as conexões ATIVAS aparecem, cada uma com o seu connectionId", async () => {
    const s = await scenario();
    const second = await createCustomerConnection(
      fixture.companyA.id,
      fixture.adminA.id,
      {
        customerId: s.customerId,
        username: "segunda-conexao@provedor",
        password: "OutraSenha#2026",
      },
    );
    session.token = await createTokenFor(fixture.techA.id);

    const panels = pppoePanels(await renderOrderPage(s.orderId));

    expect(panels).toHaveLength(2);
    expect(panels.map((p) => p.connectionId).sort()).toEqual(
      [s.connectionId, second.id].sort(),
    );
    expect(panels.map((p) => p.username).sort()).toEqual(
      [PPPOE_USERNAME, "segunda-conexao@provedor"].sort(),
    );
    // Nenhuma delas carrega senha.
    expect(panels.some((p) => "password" in p)).toBe(false);
  });

  it("conexão DESATIVADA não é oferecida — o reveal a recusaria de qualquer forma", async () => {
    const s = await scenario();
    await updateCustomerConnection(
      fixture.companyA.id,
      s.connectionId,
      fixture.adminA.id,
      { active: false },
    );
    session.token = await createTokenFor(fixture.techA.id);

    const tree = await renderOrderPage(s.orderId);

    expect(pppoePanels(tree)).toHaveLength(0);
    expect(flatten(tree)).not.toContain(PPPOE_USERNAME);
  });

  it("conexão de OUTRO cliente da mesma empresa não vaza para esta OS", async () => {
    const s = await scenario();
    const otherCustomer = await prisma.customer.create({
      data: { companyId: fixture.companyA.id, name: "Outro cliente" },
    });
    await createCustomerConnection(fixture.companyA.id, fixture.adminA.id, {
      customerId: otherCustomer.id,
      username: "nao-deve-aparecer@provedor",
      password: "SenhaDoOutro#1",
    });
    session.token = await createTokenFor(fixture.techA.id);

    const tree = await renderOrderPage(s.orderId);
    const panels = pppoePanels(tree);

    expect(panels).toHaveLength(1);
    expect(panels[0]).toMatchObject({ username: PPPOE_USERNAME });
    expect(flatten(tree)).not.toContain("nao-deve-aparecer@provedor");
  });
});
