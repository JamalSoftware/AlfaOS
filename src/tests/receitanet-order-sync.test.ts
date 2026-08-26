import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  createTokenFor,
  seedTestData,
  apiRequest,
  type TestFixture,
} from "./helpers";

/**
 * Sincronização de OS do ReceitaNet, por cliente conhecido.
 *
 * Nenhum teste toca a API real — o transporte é injetado. E nenhum documento
 * real aparece: os CPFs são sequências inventadas com o único requisito de ter
 * 11 dígitos.
 *
 * O alvo é o que não pode dar errado: idempotência, corrida, isolamento de
 * tenant e **preservação do trabalho local**. O provider é a origem do
 * chamado; a execução é do AlfaOS.
 */

let fixture: TestFixture;

beforeEach(async () => {
  fixture = await seedTestData();
  vi.doUnmock("@/lib/erp-adapter");
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock("@/lib/erp-adapter");
  vi.resetModules();
});

const ID_CLIENTE = "15678";

/** Um chamado como `/v1/chamados` o devolve. */
function chamado(over: Record<string, unknown> = {}) {
  return {
    idSuporte: 9876,
    numero: 1428,
    protocolo: "20260630134500",
    descricao: "Sem conexão desde ontem.",
    tipo: 1,
    data_previsao: "2026-07-03 13:45:00",
    ...over,
  };
}

/**
 * Roda o sync REAL com o transporte falso.
 *
 * `body` é o que o CallCenter responde a `/v1/chamados`; passar uma função
 * permite variar entre chamadas para simular o chamado que some.
 */
async function runSync(
  customerId: string,
  body: unknown | (() => unknown),
  options: { companyId?: string; actorId?: string } = {},
) {
  /*
    Sem isto o `import()` abaixo devolve o modulo em cache da chamada
    ANTERIOR, que fechou sobre o corpo anterior — e o teste passa a medir a si
    mesmo em vez do produto.
  */
  vi.resetModules();
  vi.doMock("@/lib/erp-adapter", async () => {
    const { ReceitanetAdapter } = await import(
      "@/integrations/ReceitanetAdapter"
    );
    return {
      resolveCompanyAdapter: async () =>
        new ReceitanetAdapter({
          token: "t",
          fetchImpl: async () => ({
            ok: true,
            status: 200,
            text: async () =>
              JSON.stringify(typeof body === "function" ? (body as () => unknown)() : body),
            contentType: "application/json",
          }),
        }),
    };
  });

  const { syncReceitaNetServiceOrdersForCustomer } = await import(
    "@/lib/receitanet-order-sync"
  );
  return syncReceitaNetServiceOrdersForCustomer(
    options.companyId ?? fixture.companyA.id,
    options.actorId ?? fixture.adminA.id,
    customerId,
  );
}

async function clienteVinculado(
  companyId = fixture.companyA.id,
  externalId = ID_CLIENTE,
) {
  return prisma.customer.create({
    data: {
      companyId,
      name: "Cliente ReceitaNet",
      document: "10020030044",
      phone: "27999887766",
      externalProvider: "RECEITANET",
      externalId,
    },
  });
}

// ---------------------------------------------------------------------------
// Mapeamento
// ---------------------------------------------------------------------------

describe("mapeamento do chamado para ServiceOrder", () => {
  it("idSuporte vira identidade externa; numero vira número do ERP", async () => {
    const cliente = await clienteVinculado();
    const r = await runSync(cliente.id, [chamado()]);

    expect(r).toMatchObject({ fetched: 1, created: 1, updated: 0 });

    const os = await prisma.serviceOrder.findFirstOrThrow({
      where: { customerId: cliente.id },
    });

    expect(os.externalProvider).toBe("RECEITANET");
    // `idSuporte`, a chave técnica do provider.
    expect(os.externalId).toBe("9876");
    // `numero`, o número que o atendente do provedor cita.
    expect(os.externalNumber).toBe("1428");
    expect(os.origin).toBe("EXTERNAL");
    expect(os.status).toBe("PENDING");
    // Ninguém é atribuído: o provider não conhece o técnico do AlfaOS.
    expect(os.technicianId).toBeNull();
    expect(os.description).toContain("Sem conexão");
  });

  /**
   * O número do provider NUNCA vira o número local. São dois sistemas
   * numerando as próprias ordens, e sobrepô-los faria o técnico citar um
   * número que o atendente não encontra.
   */
  it("o número local é do AlfaOS e não é o do ReceitaNet", async () => {
    const cliente = await clienteVinculado();
    await runSync(cliente.id, [chamado({ numero: 999999 })]);

    const os = await prisma.serviceOrder.findFirstOrThrow({
      where: { customerId: cliente.id },
    });
    expect(os.number).not.toBe(999999);
    expect(os.number).toBeGreaterThan(0);
    expect(os.externalNumber).toBe("999999");
  });

  /**
   * `tipo` é inteiro sem tabela de significado publicada. Traduzir produziria
   * uma tela que parece informada e mente.
   */
  it("o tipo não é traduzido nem vira ServiceOrderType do catálogo", async () => {
    const cliente = await clienteVinculado();
    await runSync(cliente.id, [chamado({ tipo: 4 })]);

    const os = await prisma.serviceOrder.findFirstOrThrow({
      where: { customerId: cliente.id },
    });
    expect(os.type).toBe("Chamado ReceitaNet");
    expect(os.typeId).toBeNull();
    for (const inventado of ["Instalação", "Manutenção", "Retirada"]) {
      expect(os.type).not.toContain(inventado);
    }
  });

  /**
   * Previsão do provider não é compromisso combinado. Virar `scheduledAt`
   * faria a agenda exibir horários que ninguém marcou.
   */
  it("data_previsao NÃO vira agendamento", async () => {
    const cliente = await clienteVinculado();
    await runSync(cliente.id, [chamado()]);

    const os = await prisma.serviceOrder.findFirstOrThrow({
      where: { customerId: cliente.id },
    });
    expect(os.scheduledAt).toBeNull();
  });

  it("um evento de importação é registrado, sem payload bruto", async () => {
    const cliente = await clienteVinculado();
    await runSync(cliente.id, [chamado()]);

    const os = await prisma.serviceOrder.findFirstOrThrow({
      where: { customerId: cliente.id },
    });
    const eventos = await prisma.serviceOrderEvent.findMany({
      where: { serviceOrderId: os.id },
    });
    expect(eventos).toHaveLength(1);
    expect(eventos[0].event).toBe("SERVICE_ORDER_IMPORTED");
    const meta = JSON.stringify(eventos[0].metadata);
    expect(meta).not.toContain("Sem conexão");
    expect(meta).not.toContain("20260630134500");
  });

  it("vários chamados viram várias OS, cada uma com seu número", async () => {
    const cliente = await clienteVinculado();
    const r = await runSync(cliente.id, [
      chamado({ idSuporte: 1, numero: 10 }),
      chamado({ idSuporte: 2, numero: 20 }),
      chamado({ idSuporte: 3, numero: 30 }),
    ]);

    expect(r).toMatchObject({ fetched: 3, created: 3 });
    const ordens = await prisma.serviceOrder.findMany({
      where: { customerId: cliente.id },
    });
    expect(new Set(ordens.map((o) => o.number)).size).toBe(3);
    expect(new Set(ordens.map((o) => o.externalId))).toEqual(
      new Set(["1", "2", "3"]),
    );
  });
});

// ---------------------------------------------------------------------------
// Zero chamados e teto
// ---------------------------------------------------------------------------

describe("resposta vazia e teto do provider", () => {
  /**
   * `success:false` em `/v1/chamados` significa ZERO RESULTADOS, não erro —
   * é a armadilha documentada na homologação. Tratá-lo como falha faria todo
   * cliente sem chamado aberto parecer indisponibilidade do provedor.
   */
  it("success:false é lista vazia, não erro", async () => {
    const cliente = await clienteVinculado();
    const r = await runSync(cliente.id, {
      success: false,
      message: "Nenhum chamado localizado.",
    });

    expect(r).toMatchObject({
      fetched: 0,
      created: 0,
      updated: 0,
      possiblyTruncated: false,
    });
    expect(
      await prisma.serviceOrder.count({ where: { customerId: cliente.id } }),
    ).toBe(0);
  });

  it("lista vazia também é desfecho normal", async () => {
    const cliente = await clienteVinculado();
    expect(await runSync(cliente.id, [])).toMatchObject({
      fetched: 0,
      possiblyTruncated: false,
    });
  });

  /**
   * O provider limita a 10 e não pagina. Com 10 na resposta não há como saber
   * se são todos — e afirmar "sincronizado" seria afirmar o que ninguém
   * verificou. Sem paginação inventada.
   */
  it("exatamente 10 marca possível truncamento", async () => {
    const cliente = await clienteVinculado();
    const dez = Array.from({ length: 10 }, (_, i) =>
      chamado({ idSuporte: 100 + i, numero: 200 + i }),
    );
    const r = await runSync(cliente.id, dez);

    expect(r.fetched).toBe(10);
    expect(r.possiblyTruncated).toBe(true);
  });

  it("nove NÃO marca truncamento", async () => {
    const cliente = await clienteVinculado();
    const nove = Array.from({ length: 9 }, (_, i) =>
      chamado({ idSuporte: 300 + i, numero: 400 + i }),
    );
    expect((await runSync(cliente.id, nove)).possiblyTruncated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Idempotência e corrida
// ---------------------------------------------------------------------------

describe("idempotência", () => {
  it.each([2, 10])("sincronizar %i vezes produz UMA OS", async (vezes) => {
    const cliente = await clienteVinculado();
    for (let i = 0; i < vezes; i++) {
      await runSync(cliente.id, [chamado()]);
    }

    expect(
      await prisma.serviceOrder.count({ where: { customerId: cliente.id } }),
    ).toBe(1);
    // E um único evento de importação — nada de timeline poluída.
    const os = await prisma.serviceOrder.findFirstOrThrow({
      where: { customerId: cliente.id },
    });
    expect(
      await prisma.serviceOrderEvent.count({
        where: { serviceOrderId: os.id, event: "SERVICE_ORDER_IMPORTED" },
      }),
    ).toBe(1);
  });

  /**
   * Dois despachantes sincronizando o mesmo cliente ao mesmo tempo. A corrida
   * é real (`Promise.all`), e a asserção PROÍBE o desfecho ruim.
   */
  it("corrida concorrente não duplica", async () => {
    const cliente = await clienteVinculado();
    const resultados = await Promise.allSettled([
      runSync(cliente.id, [chamado()]),
      runSync(cliente.id, [chamado()]),
      runSync(cliente.id, [chamado()]),
    ]);

    expect(resultados.every((r) => r.status === "fulfilled")).toBe(true);
    expect(
      await prisma.serviceOrder.count({ where: { customerId: cliente.id } }),
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// O trabalho local sobrevive — o ponto mais importante desta versão
// ---------------------------------------------------------------------------

describe("preservação do estado local", () => {
  /**
   * O ReceitaNet é a origem do chamado. Depois de importado, **o AlfaOS é a
   * fonte de verdade da execução** — uma sincronização não pode apagar o
   * trabalho de um técnico que já está em campo.
   */
  it("re-sync não destrói técnico, status nem versão avançada", async () => {
    const cliente = await clienteVinculado();
    await runSync(cliente.id, [chamado()]);

    const os = await prisma.serviceOrder.findFirstOrThrow({
      where: { customerId: cliente.id },
    });
    const tecnico = await prisma.technician.create({
      data: { companyId: fixture.companyA.id, userId: fixture.techA.id },
    });

    // O despachante atribui e o técnico começa.
    await prisma.serviceOrder.update({
      where: { id: os.id },
      data: {
        technicianId: tecnico.id,
        status: "IN_PROGRESS",
        assignedAt: new Date(),
        startedAt: new Date(),
      },
    });
    await prisma.serviceOrderExecution.create({
      data: {
        companyId: fixture.companyA.id,
        serviceOrderId: os.id,
        diagnosis: "Fibra rompida no poste.",
        workPerformed: "Emenda refeita.",
      },
    });

    // O provider muda a descrição e sincronizamos de novo.
    await runSync(cliente.id, [
      chamado({ descricao: "Texto novo vindo do provider." }),
    ]);

    const depois = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: os.id },
    });
    expect(depois.technicianId).toBe(tecnico.id);
    expect(depois.status).toBe("IN_PROGRESS");
    expect(depois.assignedAt).not.toBeNull();
    expect(depois.startedAt).not.toBeNull();
    // O que É do provider acompanha.
    expect(depois.description).toBe("Texto novo vindo do provider.");

    const execucao = await prisma.serviceOrderExecution.findFirstOrThrow({
      where: { serviceOrderId: os.id },
    });
    expect(execucao.diagnosis).toBe("Fibra rompida no poste.");
    expect(execucao.workPerformed).toBe("Emenda refeita.");
  });

  /**
   * Ausência não é prova de fechamento: `/v1/chamados` só devolve abertos,
   * tem teto de 10, e pode omitir. Deletar ou concluir por ausência apagaria
   * uma OS que talvez esteja sendo atendida agora.
   */
  it("chamado que some da resposta NÃO é apagado nem concluído", async () => {
    const cliente = await clienteVinculado();
    await runSync(cliente.id, [
      chamado({ idSuporte: 111, numero: 11 }),
      chamado({ idSuporte: 222, numero: 22 }),
    ]);
    expect(
      await prisma.serviceOrder.count({ where: { customerId: cliente.id } }),
    ).toBe(2);

    // Na leitura seguinte o 222 não aparece.
    const r = await runSync(cliente.id, [chamado({ idSuporte: 111, numero: 11 })]);
    expect(r).toMatchObject({ fetched: 1, created: 0, updated: 1 });

    const ordens = await prisma.serviceOrder.findMany({
      where: { customerId: cliente.id },
    });
    expect(ordens).toHaveLength(2);
    const sumido = ordens.find((o) => o.externalId === "222")!;
    expect(sumido.status).toBe("PENDING");
    expect(sumido.cancelledAt).toBeNull();
    expect(sumido.completedAt).toBeNull();
  });

  /** O cadastro do cliente não é tocado: o chamado não traz dado cadastral. */
  it("re-sync não mexe no cadastro do cliente", async () => {
    const cliente = await clienteVinculado();
    const antes = await prisma.customer.findUniqueOrThrow({
      where: { id: cliente.id },
    });

    await runSync(cliente.id, [chamado()]);

    const depois = await prisma.customer.findUniqueOrThrow({
      where: { id: cliente.id },
    });
    expect(depois.name).toBe(antes.name);
    expect(depois.phone).toBe(antes.phone);
    expect(depois.updatedAt.getTime()).toBe(antes.updatedAt.getTime());
  });
});

// ---------------------------------------------------------------------------
// Tenancy e pré-condições
// ---------------------------------------------------------------------------

describe("isolamento e pré-condições", () => {
  it("cliente de outra empresa é invisível", async () => {
    const daEmpresaB = await clienteVinculado(fixture.companyB.id, "99999");

    await expect(runSync(daEmpresaB.id, [chamado()])).rejects.toMatchObject({
      status: 404,
    });
    expect(
      await prisma.serviceOrder.count({ where: { customerId: daEmpresaB.id } }),
    ).toBe(0);
  });

  it("cliente sem vínculo ReceitaNet recusa com motivo, não com lista vazia", async () => {
    const semVinculo = await prisma.customer.create({
      data: { companyId: fixture.companyA.id, name: "Só local" },
    });

    await expect(runSync(semVinculo.id, [chamado()])).rejects.toMatchObject({
      status: 400,
    });
  });

  it("cliente vinculado a OUTRO provider não é consultado no ReceitaNet", async () => {
    const doMock = await prisma.customer.create({
      data: {
        companyId: fixture.companyA.id,
        name: "Cliente do Mock",
        externalProvider: "MOCK",
        externalId: "1",
      },
    });

    await expect(runSync(doMock.id, [chamado()])).rejects.toMatchObject({
      status: 400,
    });
  });
});

// ---------------------------------------------------------------------------
// Falhas do provider
// ---------------------------------------------------------------------------

describe("falhas do provider", () => {
  async function runComTransporte(
    customerId: string,
    resposta: { ok: boolean; status: number; text: string; contentType?: string },
  ) {
    /*
    Sem isto o `import()` abaixo devolve o modulo em cache da chamada
    ANTERIOR, que fechou sobre o corpo anterior — e o teste passa a medir a si
    mesmo em vez do produto.
  */
  vi.resetModules();
  vi.doMock("@/lib/erp-adapter", async () => {
      const { ReceitanetAdapter } = await import(
        "@/integrations/ReceitanetAdapter"
      );
      return {
        resolveCompanyAdapter: async () =>
          new ReceitanetAdapter({
            token: "t",
            fetchImpl: async () => ({
              ok: resposta.ok,
              status: resposta.status,
              text: async () => resposta.text,
              contentType: resposta.contentType ?? "application/json",
            }),
          }),
      };
    });
    const { syncReceitaNetServiceOrdersForCustomer } = await import(
      "@/lib/receitanet-order-sync"
    );
    return syncReceitaNetServiceOrdersForCustomer(
      fixture.companyA.id,
      fixture.adminA.id,
      customerId,
    );
  }

  it.each([
    ["credencial recusada", { ok: false, status: 401, text: "{}" }],
    ["provider indisponível", { ok: false, status: 503, text: "{}" }],
    ["resposta malformada", { ok: true, status: 200, text: "não é json" }],
    [
      "content-type errado",
      { ok: true, status: 200, text: "<html/>", contentType: "text/html" },
    ],
  ])("%s: erro operacional seguro, sem criar OS", async (_rotulo, resposta) => {
    const cliente = await clienteVinculado();

    await expect(runComTransporte(cliente.id, resposta)).rejects.toMatchObject({
      status: 400,
    });
    expect(
      await prisma.serviceOrder.count({ where: { customerId: cliente.id } }),
    ).toBe(0);
  });

  it("a mensagem de erro não vaza token, URL nem corpo do provider", async () => {
    const cliente = await clienteVinculado();
    const erro = await runComTransporte(cliente.id, {
      ok: false,
      status: 401,
      text: JSON.stringify({ token: "SEGREDO", detail: "interno" }),
    }).catch((e) => e);

    const texto = String(erro?.message ?? "");
    expect(texto).not.toContain("SEGREDO");
    expect(texto).not.toContain("api.receitanet.net");
    expect(texto).not.toContain("interno");
  });
});

// ---------------------------------------------------------------------------
// A rota
// ---------------------------------------------------------------------------

describe("rota de sincronização", () => {
  async function chamarRota(customerId: string, token?: string) {
    /*
    Sem isto o `import()` abaixo devolve o modulo em cache da chamada
    ANTERIOR, que fechou sobre o corpo anterior — e o teste passa a medir a si
    mesmo em vez do produto.
  */
  vi.resetModules();
  vi.doMock("@/lib/erp-adapter", async () => {
      const { ReceitanetAdapter } = await import(
        "@/integrations/ReceitanetAdapter"
      );
      return {
        resolveCompanyAdapter: async () =>
          new ReceitanetAdapter({
            token: "t",
            fetchImpl: async () => ({
              ok: true,
              status: 200,
              text: async () => JSON.stringify([chamado()]),
              contentType: "application/json",
            }),
          }),
      };
    });
    const { POST } = await import(
      "@/app/api/customers/[id]/receitanet-orders/route"
    );
    return POST(
      apiRequest(
        `/api/customers/${customerId}/receitanet-orders`,
        { method: "POST", headers: { Origin: "http://localhost" } },
        token,
      ),
      { params: { id: customerId } },
    );
  }

  it("ADMIN sincroniza", async () => {
    const cliente = await clienteVinculado();
    const res = await chamarRota(
      cliente.id,
      await createTokenFor(fixture.adminA.id),
    );
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.data.sync).toMatchObject({ created: 1 });
  });

  it("DISPATCHER sincroniza", async () => {
    const cliente = await clienteVinculado();
    const res = await chamarRota(
      cliente.id,
      await createTokenFor(fixture.dispatcherA.id),
    );
    expect(res.status).toBe(200);
  });

  /** Sincronização é ação administrativa; o técnico consome a OS depois. */
  it("TECHNICIAN recebe 403", async () => {
    const cliente = await clienteVinculado();
    const res = await chamarRota(
      cliente.id,
      await createTokenFor(fixture.techA.id),
    );
    expect(res.status).toBe(403);
  });

  it("sem sessão recebe 401", async () => {
    const cliente = await clienteVinculado();
    expect((await chamarRota(cliente.id)).status).toBe(401);
  });

  it("origem de terceiro recebe 403 e não sincroniza", async () => {
    const cliente = await clienteVinculado();
    vi.doMock("@/lib/erp-adapter", async () => ({
      resolveCompanyAdapter: async () => {
        throw new Error("não deveria ter sido chamado");
      },
    }));
    const { POST } = await import(
      "@/app/api/customers/[id]/receitanet-orders/route"
    );
    const res = await POST(
      apiRequest(
        `/api/customers/${cliente.id}/receitanet-orders`,
        { method: "POST", headers: { Origin: "https://evil.example" } },
        await createTokenFor(fixture.adminA.id),
      ),
      { params: { id: cliente.id } },
    );

    expect(res.status).toBe(403);
    expect(
      await prisma.serviceOrder.count({ where: { customerId: cliente.id } }),
    ).toBe(0);
  });

  it("cliente de outra empresa recebe 404, não 403", async () => {
    const daEmpresaB = await clienteVinculado(fixture.companyB.id, "88888");
    const res = await chamarRota(
      daEmpresaB.id,
      await createTokenFor(fixture.adminA.id),
    );
    expect(res.status).toBe(404);
  });
});
