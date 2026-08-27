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
    // O 111 voltou idêntico: `unchanged`, não `updated` — nenhuma linha foi
    // escrita. Antes da correção de SYNC-03 isto contava como atualização e
    // ainda movia `version`.
    expect(r).toMatchObject({ fetched: 1, created: 0, updated: 0, unchanged: 1 });

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

// ---------------------------------------------------------------------------
// SYNC-01 — identidade externa inválida invalida o LOTE
// ---------------------------------------------------------------------------

/**
 * A auditoria focal da v0.8 reproduziu o defeito: `String(row.idSuporte)` sem
 * guarda transformava `undefined` na string `"undefined"`, e ela virava a
 * identidade externa da OS.
 *
 * O desfecho mais caro não era a OS com identidade inventada — era a COLISÃO.
 * Como a unique é `(companyId, externalProvider, externalId)` e `customerId`
 * não faz parte dela, dois chamados de CLIENTES DIFERENTES sem `idSuporte`
 * compartilhavam a mesma chave: o segundo atualizava a OS do primeiro, e a
 * tela passava a mostrar o cliente A com o problema de B. Um técnico sairia
 * para o endereço errado.
 *
 * A regra agora é: uma linha sem identidade válida recusa o lote inteiro,
 * antes de qualquer escrita.
 */
describe("SYNC-01: idSuporte inválido recusa o lote inteiro", () => {
  /** Um chamado sem a identidade, preservando o resto do contrato. */
  function semIdentidade(over: Record<string, unknown> = {}) {
    const t = { ...chamado(over) } as Record<string, unknown>;
    delete t.idSuporte;
    return t;
  }

  const invalidos: Array<[string, unknown]> = [
    ["null", null],
    ["string vazia", ""],
    ["string em branco", "   "],
    ["string numérica", "9876"],
    ["objeto", { id: 1 }],
    ["array", [1]],
    ["booleano", true],
    ["zero", 0],
    ["negativo", -1],
    ["fracionário", 12.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    /*
      Acima de 2^53 o JSON já perdeu precisão antes de o código ver o número:
      dois `idSuporte` distintos chegam iguais e produziriam a MESMA
      identidade — a colisão de SYNC-01 por outro caminho.
    */
    ["fora da faixa segura", 99999999999999999999],
    ["notação exponencial", 1e21],
  ];

  for (const [rotulo, valor] of invalidos) {
    it(`recusa idSuporte ${rotulo} e não grava nada`, async () => {
      const cliente = await clienteVinculado();
      await expect(
        runSync(cliente.id, [chamado({ idSuporte: valor })]),
      ).rejects.toThrow();
      expect(
        await prisma.serviceOrder.count({ where: { companyId: fixture.companyA.id } }),
      ).toBe(0);
    });
  }

  it("recusa idSuporte ausente e não grava nada", async () => {
    const cliente = await clienteVinculado();
    await expect(runSync(cliente.id, [semIdentidade()])).rejects.toThrow();
    expect(
      await prisma.serviceOrder.count({ where: { companyId: fixture.companyA.id } }),
    ).toBe(0);
  });

  /**
   * O caso que a auditoria chamou de mais grave: a colisão atravessava
   * clientes. Agora nenhum dos dois payloads chega a persistir.
   */
  it("REGRESSÃO: cliente A e cliente B com identidade inválida não colidem", async () => {
    const clienteA = await prisma.customer.create({
      data: {
        companyId: fixture.companyA.id,
        name: "Cliente A — Rua das Flores",
        document: "10020030044",
        externalProvider: "RECEITANET",
        externalId: "111",
      },
    });
    const clienteB = await prisma.customer.create({
      data: {
        companyId: fixture.companyA.id,
        name: "Cliente B — Avenida Central",
        document: "10020030055",
        externalProvider: "RECEITANET",
        externalId: "222",
      },
    });

    await expect(
      runSync(clienteA.id, [semIdentidade({ descricao: "Sem sinal na Rua das Flores" })]),
    ).rejects.toThrow();
    await expect(
      runSync(clienteB.id, [semIdentidade({ descricao: "Sem sinal na Avenida Central" })]),
    ).rejects.toThrow();

    // Zero OS — e, portanto, zero chance de uma carregar o problema da outra.
    expect(
      await prisma.serviceOrder.count({ where: { companyId: fixture.companyA.id } }),
    ).toBe(0);
    // E nenhuma identidade fabricada sobrou no banco.
    expect(
      await prisma.serviceOrder.count({
        where: { externalId: { in: ["undefined", "null", "NaN", "[object Object]"] } },
      }),
    ).toBe(0);
  });

  /** Lote misto: válido + inválido + válido. Nada é aproveitado. */
  it("REGRESSÃO: um inválido no meio de válidos zera o lote", async () => {
    const cliente = await clienteVinculado();
    await expect(
      runSync(cliente.id, [
        chamado({ idSuporte: 1001, descricao: "A válido" }),
        semIdentidade({ descricao: "B inválido" }),
        chamado({ idSuporte: 1003, descricao: "C válido" }),
      ]),
    ).rejects.toThrow();

    expect(
      await prisma.serviceOrder.count({ where: { companyId: fixture.companyA.id } }),
    ).toBe(0);
    expect(
      await prisma.serviceOrderEvent.count({
        where: { companyId: fixture.companyA.id },
      }),
    ).toBe(0);
  });

  /**
   * O lote inválido não pode desfazer o que já existia.
   *
   * Uma sincronização anterior bem-sucedida deixou a OS gravada; a resposta
   * corrompida seguinte não a altera, não a apaga e não move sua `version`.
   */
  it("REGRESSÃO: lote inválido não altera OS já importada", async () => {
    const cliente = await clienteVinculado();
    await runSync(cliente.id, [chamado()]);
    const antes = await prisma.serviceOrder.findFirstOrThrow({
      where: { companyId: fixture.companyA.id },
    });

    await expect(
      runSync(cliente.id, [semIdentidade({ descricao: "corrompido" })]),
    ).rejects.toThrow();

    const depois = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: antes.id },
    });
    expect(depois.description).toBe(antes.description);
    expect(depois.version).toBe(antes.version);
    expect(depois.updatedAt.getTime()).toBe(antes.updatedAt.getTime());
  });

  it("REGRESSÃO: lote inválido não toca o cadastro do cliente", async () => {
    const cliente = await clienteVinculado(fixture.companyA.id, ID_CLIENTE);
    const antes = await prisma.customer.findUniqueOrThrow({ where: { id: cliente.id } });

    await expect(runSync(cliente.id, [semIdentidade()])).rejects.toThrow();

    const depois = await prisma.customer.findUniqueOrThrow({ where: { id: cliente.id } });
    expect(depois).toEqual(antes);
  });

  it("a mensagem do lote recusado não vaza payload nem identidade bruta", async () => {
    const cliente = await clienteVinculado();
    const erro = await runSync(cliente.id, [
      semIdentidade({ descricao: "texto secreto do chamado" }),
    ]).catch((e: unknown) => e);

    const texto = erro instanceof Error ? erro.message : String(erro);
    expect(texto).toMatch(/formato inesperado/i);
    expect(texto).not.toContain("texto secreto do chamado");
    expect(texto).not.toContain("undefined");
    expect(texto.toLowerCase()).not.toContain("token");
  });

  /** O caminho feliz não pode ter sido estreitado demais. */
  it("CONTROLE POSITIVO: idSuporte válido continua importando", async () => {
    const cliente = await clienteVinculado();
    const r = await runSync(cliente.id, [chamado()]);
    expect(r.created).toBe(1);
    const os = await prisma.serviceOrder.findFirstOrThrow({
      where: { companyId: fixture.companyA.id },
    });
    expect(os.externalId).toBe("9876");
  });

  it("CONTROLE POSITIVO: mesmo idSuporte válido coexiste entre empresas", async () => {
    const a = await clienteVinculado(fixture.companyA.id, "111");
    const b = await clienteVinculado(fixture.companyB.id, "222");

    await runSync(a.id, [chamado({ idSuporte: 5555 })]);
    await runSync(b.id, [chamado({ idSuporte: 5555 })], {
      companyId: fixture.companyB.id,
      actorId: fixture.adminB.id,
    });

    const todas = await prisma.serviceOrder.findMany({ where: { externalId: "5555" } });
    expect(todas).toHaveLength(2);
    expect(new Set(todas.map((o) => o.companyId)).size).toBe(2);
  });

  it("CONTROLE POSITIVO: duplicado válido no mesmo payload segue idempotente", async () => {
    const cliente = await clienteVinculado();
    const r = await runSync(cliente.id, [
      chamado({ descricao: "primeiro" }),
      chamado({ descricao: "segundo" }),
    ]);
    expect(r.fetched).toBe(2);
    expect(
      await prisma.serviceOrder.count({ where: { companyId: fixture.companyA.id } }),
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// SYNC-03 — re-sync sem mudança não escreve
// ---------------------------------------------------------------------------

/**
 * O ramo de atualização rodava um `UPDATE` incondicional com
 * `version: { increment: 1 }`. Cinco sincronizações idênticas levavam a versão
 * de 0 a 5, e o efeito visível era um 409 espúrio: o despachante lia a tela,
 * alguém sincronizava sem mudar nada, e a atribuição falhava no
 * compare-and-set contra uma versão que avançou sozinha.
 *
 * O incremento continua onde protege — mudança real do provider ainda precisa
 * invalidar leituras anteriores.
 */
describe("SYNC-03: no-op não escreve, mudança real escreve", () => {
  it("REGRESSÃO: sync idêntico preserva version e updatedAt", async () => {
    const cliente = await clienteVinculado();
    await runSync(cliente.id, [chamado()]);
    const antes = await prisma.serviceOrder.findFirstOrThrow({
      where: { companyId: fixture.companyA.id },
    });

    const r = await runSync(cliente.id, [chamado()]);
    const depois = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: antes.id },
    });

    expect(depois.version).toBe(antes.version);
    expect(depois.updatedAt.getTime()).toBe(antes.updatedAt.getTime());
    expect(r.unchanged).toBe(1);
    expect(r.updated).toBe(0);
    expect(r.created).toBe(0);
  });

  it("REGRESSÃO: vinte syncs idênticos deixam version onde estava", async () => {
    const cliente = await clienteVinculado();
    await runSync(cliente.id, [chamado()]);
    const antes = await prisma.serviceOrder.findFirstOrThrow({
      where: { companyId: fixture.companyA.id },
    });

    for (let i = 0; i < 20; i += 1) {
      await runSync(cliente.id, [chamado()]);
    }

    const depois = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: antes.id },
    });
    expect(depois.version).toBe(antes.version);
    expect(
      await prisma.serviceOrder.count({ where: { companyId: fixture.companyA.id } }),
    ).toBe(1);
    // E nenhum evento novo: a timeline não registra o que não aconteceu.
    expect(
      await prisma.serviceOrderEvent.count({
        where: { serviceOrderId: antes.id, event: "SERVICE_ORDER_IMPORTED" },
      }),
    ).toBe(1);
  });

  it("mudança real do provider AINDA incrementa version", async () => {
    const cliente = await clienteVinculado();
    await runSync(cliente.id, [chamado({ descricao: "Sem sinal" })]);
    const antes = await prisma.serviceOrder.findFirstOrThrow({
      where: { companyId: fixture.companyA.id },
    });

    const r = await runSync(cliente.id, [chamado({ descricao: "Sem sinal desde ontem" })]);
    const depois = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: antes.id },
    });

    expect(depois.description).toBe("Sem sinal desde ontem");
    expect(depois.version).toBe(antes.version + 1);
    expect(r.updated).toBe(1);
    expect(r.unchanged).toBe(0);
  });

  it("mudança no numero do provider também dispara o update", async () => {
    const cliente = await clienteVinculado();
    await runSync(cliente.id, [chamado({ numero: 1428 })]);
    const antes = await prisma.serviceOrder.findFirstOrThrow({
      where: { companyId: fixture.companyA.id },
    });

    const r = await runSync(cliente.id, [chamado({ numero: 9999 })]);
    const depois = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: antes.id },
    });

    expect(depois.externalNumber).toBe("9999");
    expect(depois.version).toBe(antes.version + 1);
    expect(r.updated).toBe(1);
  });

  /**
   * O cenário que o defeito produzia: o CAS do despachante quebrando por causa
   * de uma sincronização que não mudou nada.
   */
  it("REGRESSÃO: no-op não invalida o compare-and-set do despachante", async () => {
    const cliente = await clienteVinculado();
    await runSync(cliente.id, [chamado()]);
    const os = await prisma.serviceOrder.findFirstOrThrow({
      where: { companyId: fixture.companyA.id },
    });
    const technician = await prisma.technician.create({
      data: { companyId: fixture.companyA.id, userId: fixture.techA.id },
    });

    // O despachante leu a OS nesta versão.
    const versaoLida = os.version;

    // Alguém sincroniza no intervalo, sem nenhuma mudança do provider.
    await runSync(cliente.id, [chamado()]);

    // A atribuição com a versão lida antes continua válida.
    const { assignTechnician } = await import("@/lib/service-orders");
    await expect(
      assignTechnician(
        fixture.companyA.id,
        fixture.adminA.id,
        os.id,
        technician.id,
        versaoLida,
      ),
    ).resolves.toBeDefined();
  });

  it("estado operacional local sobrevive ao no-op", async () => {
    const cliente = await clienteVinculado();
    await runSync(cliente.id, [chamado()]);
    const os = await prisma.serviceOrder.findFirstOrThrow({
      where: { companyId: fixture.companyA.id },
    });
    const technician = await prisma.technician.create({
      data: { companyId: fixture.companyA.id, userId: fixture.techA.id },
    });
    await prisma.serviceOrder.update({
      where: { id: os.id },
      data: {
        technicianId: technician.id,
        status: "IN_PROGRESS",
        assignedAt: new Date(),
        startedAt: new Date(),
      },
    });
    const execucao = await prisma.serviceOrderExecution.create({
      data: {
        companyId: fixture.companyA.id,
        serviceOrderId: os.id,
        diagnosis: "Cabo rompido no poste.",
      },
    });
    const comTrabalho = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: os.id },
    });

    await runSync(cliente.id, [chamado()]);

    const depois = await prisma.serviceOrder.findUniqueOrThrow({ where: { id: os.id } });
    expect(depois.status).toBe("IN_PROGRESS");
    expect(depois.technicianId).toBe(technician.id);
    expect(depois.origin).toBe("EXTERNAL");
    expect(depois.version).toBe(comTrabalho.version);
    expect(
      (await prisma.serviceOrderExecution.findUniqueOrThrow({ where: { id: execucao.id } }))
        .diagnosis,
    ).toBe("Cabo rompido no poste.");
  });
});
