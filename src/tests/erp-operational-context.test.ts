import { describe, it, expect, beforeEach, vi } from "vitest";
import { GET as receitanetContext } from "@/app/api/service-orders/[id]/receitanet-context/route";
import { ReceitanetAdapter } from "@/integrations/ReceitanetAdapter";
import type { FetchLike } from "@/integrations/receitanet/CallCenterClient";
import { isIntegrationError } from "@/integrations/errors";
import {
  formatBrazilianPhone,
  parseTicketContactPhone,
} from "@/integrations/service-tickets";
import { prisma } from "@/lib/prisma";
import {
  allocateTestServiceOrderNumber,
  apiRequest,
  createTokenFor,
  seedTestData,
  type TestFixture,
} from "./helpers";

/**
 * Contexto operacional ReceitaNet: chamados abertos e dados de contrato.
 *
 * Tudo com transporte injetado — nenhuma chamada sai para o ReceitaNet real, e
 * nenhum endpoint mutante é exercitado nem por acidente.
 */

let fixture: TestFixture;
beforeEach(async () => {
  fixture = await seedTestData();
});

const CHAMADO = {
  idSuporte: 9876,
  numero: 123,
  protocolo: "20260630134500",
  descricao: "Sem conexão.\n\nProtocolo de atendimento: 20260630134500\nContato: 18999998888",
  tipo: 1,
  data_previsao: "2026-07-03 13:45:00",
};

function adapterWith(respond: (url: string) => { status: number; body: string }) {
  const fetchImpl: FetchLike = async (url) => {
    const r = respond(url);
    return { ok: r.status < 300, status: r.status, text: async () => r.body };
  };
  return new ReceitanetAdapter({ token: "t", fetchImpl });
}

// ---------------------------------------------------------------------------
// A semântica que diverge de /v1/clientes
// ---------------------------------------------------------------------------

describe("/v1/chamados — success:false é ZERO, não erro", () => {
  async function tickets(status: number, body: string) {
    const adapter = adapterWith(() => ({ status, body }));
    try {
      return { ok: true as const, result: await adapter.listOpenTickets("15678") };
    } catch (error) {
      return {
        ok: false as const,
        code: isIntegrationError(error) ? error.code : "desconhecido",
      };
    }
  }

  it("CONTROLE POSITIVO: array com chamado é normalizado", async () => {
    const r = await tickets(200, JSON.stringify([CHAMADO]));

    expect(r.ok).toBe(true);
    expect(r.ok && r.result.tickets).toHaveLength(1);
    expect(r.ok && r.result.tickets[0]).toMatchObject({
      externalId: "9876",
      externalNumber: "123",
      protocol: "20260630134500",
      typeCode: "1",
    });
  });

  it("array vazio é zero chamados", async () => {
    const r = await tickets(200, "[]");
    expect(r.ok && r.result.tickets).toEqual([]);
  });

  /**
   * A regressão que dá nome ao bloco. Esta MESMA forma, em `/v1/clientes`,
   * é `INVALID_RESPONSE` desde a v0.6.1. Aqui o contrato a usa PARA dizer
   * vazio — e o caso é o comum, não a exceção.
   */
  it("REGRESSÃO: 'Nenhum chamado localizado.' vira lista vazia, não erro", async () => {
    const r = await tickets(
      200,
      JSON.stringify({ success: false, message: "Nenhum chamado localizado." }),
    );

    expect(r.ok).toBe(true);
    expect(r.ok && r.result.tickets).toEqual([]);
  });

  it("mas falha real do provider continua erro", async () => {
    const r = await tickets(500, JSON.stringify({ success: false }));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.code).toBe("UPSTREAM_UNAVAILABLE");
  });

  it("401 continua AUTHENTICATION_FAILED", async () => {
    const r = await tickets(401, "{}");
    expect(!r.ok && r.code).toBe("AUTHENTICATION_FAILED");
  });

  it("objeto fora do contrato continua INVALID_RESPONSE", async () => {
    const r = await tickets(200, JSON.stringify({ total: 3, dados: [] }));
    expect(!r.ok && r.code).toBe("INVALID_RESPONSE");
  });

  it("o teto do provider viaja junto com a lista", async () => {
    const r = await tickets(200, JSON.stringify([CHAMADO]));
    // Sem isto, "3 chamados" e "10 de talvez 14" apareceriam iguais na tela.
    expect(r.ok && r.result.cap).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Parser de contato — estreito de propósito
// ---------------------------------------------------------------------------

describe("Contato extraído da descrição do chamado", () => {
  it("CONTROLE POSITIVO: extrai o celular rotulado", () => {
    expect(parseTicketContactPhone(CHAMADO.descricao)).toBe("18999998888");
  });

  it("aceita fixo com DDD e máscara", () => {
    expect(parseTicketContactPhone("Contato: (18) 3333-4444")).toBe("1833334444");
  });

  it.each([
    ["número solto sem rótulo", "Cliente ligou do 18999998888 hoje"],
    ["rótulo sem número", "Contato: não informado"],
    ["curto demais", "Contato: 1234"],
    ["longo demais", "Contato: 1899999888877665"],
    ["descrição vazia", ""],
    ["nula", null],
  ])("recusa: %s", (_label, desc) => {
    expect(parseTicketContactPhone(desc as string | null)).toBeNull();
  });

  it("formata só para apresentação", () => {
    expect(formatBrazilianPhone("18999998888")).toBe("(18) 99999-8888");
    expect(formatBrazilianPhone("1833334444")).toBe("(18) 3333-4444");
    expect(formatBrazilianPhone(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Autorização da rota
// ---------------------------------------------------------------------------

describe("Rota de contexto operacional", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  async function scenario() {
    const customer = await prisma.customer.create({
      data: {
        companyId: fixture.companyA.id,
        name: "Cliente Vinculado",
        externalProvider: "RECEITANET",
        externalId: "15678",
        phone: "1833334444",
      },
    });
    const technician = await prisma.technician.create({
      data: { companyId: fixture.companyA.id, userId: fixture.techA.id },
    });
    const order = await prisma.serviceOrder.create({
      data: {
        companyId: fixture.companyA.id,
        number: await allocateTestServiceOrderNumber(fixture.companyA.id),
        customerId: customer.id,
        technicianId: technician.id,
        type: "Manutenção",
        status: "ASSIGNED",
        description: "OS de contexto operacional.",
      },
    });
    return { customer, order };
  }

  async function call(userId: string, orderId: string) {
    const token = await createTokenFor(userId);
    return receitanetContext(
      apiRequest(`/api/service-orders/${orderId}/receitanet-context`, {}, token),
      { params: { id: orderId } },
    );
  }

  it.each([
    ["ADMIN", "adminA"],
    ["DISPATCHER", "dispatcherA"],
  ])("CONTROLE POSITIVO: %s recebe o contexto", async (_l, key) => {
    const { order } = await scenario();
    const userId = (fixture as unknown as Record<string, { id: string }>)[key].id;

    const res = await call(userId, order.id);
    expect(res.status).toBe(200);
  });

  /**
   * O bloco carrega valor em aberto, faturas e promessa de pagamento. Levar
   * isso para o celular do técnico amplia a superfície sem ganho operacional.
   */
  it("REGRESSÃO: TECHNICIAN não acessa o contexto operacional", async () => {
    const { order } = await scenario();
    const res = await call(fixture.techA.id, order.id);
    expect(res.status).toBe(403);
  });

  it("sem sessão responde 401", async () => {
    const { order } = await scenario();
    const res = await receitanetContext(
      apiRequest(`/api/service-orders/${order.id}/receitanet-context`, {}),
      { params: { id: order.id } },
    );
    expect(res.status).toBe(401);
  });

  it("OS de outra empresa responde 404, não 403", async () => {
    const { order } = await scenario();
    const res = await call(fixture.adminB.id, order.id);
    // 404 e não 403: 403 confirmaria que a OS existe.
    expect(res.status).toBe(404);
  });

  it("cliente sem vínculo externo responde 200 com linked=false", async () => {
    const customer = await prisma.customer.create({
      data: { companyId: fixture.companyA.id, name: "Cliente Local" },
    });
    const order = await prisma.serviceOrder.create({
      data: {
        companyId: fixture.companyA.id,
        number: await allocateTestServiceOrderNumber(fixture.companyA.id),
        customerId: customer.id,
        type: "Manutenção",
        status: "PENDING",
        description: "Cliente sem ERP.",
      },
    });

    const res = await call(fixture.adminA.id, order.id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.context.linked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Falha parcial não apaga o que já chegou
// ---------------------------------------------------------------------------

describe("Detalhe e chamados falham de forma independente", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  async function loadWith(respond: (url: string) => { status: number; body: string }) {
    const customer = await prisma.customer.create({
      data: {
        companyId: fixture.companyA.id,
        name: "Cliente Vinculado",
        externalProvider: "RECEITANET",
        externalId: "15678",
      },
    });
    /*
      O ReceitaNet precisa estar ATIVO, e não só constar no histórico do
      cliente (`SEC-008`).

      Estes quatro testes passavam SEM esta linha, com a empresa não tendo
      integração de ERP nenhuma — porque o módulo escolhia o adapter por
      `customer.externalProvider`, que é registro de ORIGEM. Eles não
      conseguiam distinguir "provider ativo" de "rótulo histórico", que é
      exatamente a distinção que o achado é.
    */
    await prisma.eRPIntegration.create({
      data: {
        companyId: fixture.companyA.id,
        provider: "RECEITANET",
        enabled: true,
      },
    });
    vi.doMock("@/lib/erp-adapter", () => ({
      resolveCompanyAdapter: async () => {
        /**
         * O adapter precisa nascer DENTRO do grafo de módulos recriado por
         * `resetModules`. Construído no grafo do arquivo de teste, o
         * `IntegrationError` que ele lança é de outra classe que a do módulo
         * sob teste: `instanceof` cruza registries, falha, e todo erro viraria
         * UNKNOWN — escondendo exatamente o que estes testes medem.
         */
        const { ReceitanetAdapter: Fresh } = await import(
          "@/integrations/ReceitanetAdapter"
        );
        const fetchImpl: FetchLike = async (url) => {
          const r = respond(url);
          return { ok: r.status < 300, status: r.status, text: async () => r.body };
        };
        return new Fresh({ token: "t", fetchImpl });
      },
    }));
    const mod = await import("@/lib/erp-operational-context");
    return mod.loadErpOperationalContext(fixture.companyA.id, customer.id);
  }

  const DETALHE = JSON.stringify({
    idCliente: 15678,
    razaoSocial: "Cliente Vinculado",
    contratoStatusDisplay: "Ativo",
    planos: [{ descricao: "Plano Fibra 500M" }],
    tecnologia: 3,
    servidor: { manutencao: false },
  });

  it("CONTROLE POSITIVO: as duas leituras funcionando", async () => {
    const ctx = await loadWith((url) =>
      url.includes("/v1/chamados")
        ? { status: 200, body: JSON.stringify([CHAMADO]) }
        : { status: 200, body: DETALHE },
    );

    expect(ctx.contract.status).toBe("Ativo");
    expect(ctx.contract.plan).toBe("Plano Fibra 500M");
    expect(ctx.tickets.items).toHaveLength(1);
  });

  it("chamados falhando NÃO apaga o contrato que já veio", async () => {
    const ctx = await loadWith((url) =>
      url.includes("/v1/chamados")
        ? { status: 500, body: "{}" }
        : { status: 200, body: DETALHE },
    );

    expect(ctx.contract.status).toBe("Ativo");
    expect(ctx.contract.error).toBeNull();
    expect(ctx.tickets.error).toBe("UPSTREAM_UNAVAILABLE");
  });

  it("detalhe falhando NÃO apaga os chamados que já vieram", async () => {
    const ctx = await loadWith((url) =>
      url.includes("/v1/chamados")
        ? { status: 200, body: JSON.stringify([CHAMADO]) }
        : { status: 500, body: "{}" },
    );

    expect(ctx.tickets.items).toHaveLength(1);
    expect(ctx.contract.error).toBe("UPSTREAM_UNAVAILABLE");
  });

  it("tecnologia fica como CÓDIGO, sem rótulo inventado", async () => {
    const ctx = await loadWith((url) =>
      url.includes("/v1/chamados")
        ? { status: 200, body: "[]" }
        : { status: 200, body: DETALHE },
    );

    // O contrato declara inteiro e não publica o significado dos valores.
    expect(ctx.contract.technologyCode).toBe("3");
    expect(JSON.stringify(ctx)).not.toContain("GPON");
    expect(JSON.stringify(ctx)).not.toContain("Fibra ótica");
  });
});

// ---------------------------------------------------------------------------
// SEC-008 — chamada ao vivo não sai para provider DESATIVADO
// ---------------------------------------------------------------------------

/**
 * # `SEC-008` · o adapter vem do ERP ATIVO, não do histórico do cliente
 *
 * `Customer.externalProvider` é registro de ORIGEM, não seleção: uma OS
 * importada do ReceitaNet continua ReceitaNet depois da troca de ERP, por
 * decisão de produto. Este módulo escolhia o adapter por esse campo, então uma
 * empresa que já migrou continuava mandando dado operacional de cliente para o
 * provider desativado — usando a credencial que a troca preserva ociosa de
 * propósito, para permitir rollback.
 *
 * A prova aqui é sobre a CHAMADA, não sobre o texto da resposta: o transporte
 * conta quantas requisições saíram. Um teste que só olhasse o DTO passaria
 * mesmo com a requisição vazando, porque o DTO vazio é o mesmo nos dois casos.
 */
describe("SEC-008 — provider desativado não recebe chamada", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  /** Monta a empresa, o cliente e a integração, e CONTA as requisições. */
  async function carregar(opcoes: {
    historicoDoCliente: string;
    integracao: { provider: "RECEITANET" | "MOCK"; enabled: boolean } | null;
  }) {
    const customer = await prisma.customer.create({
      data: {
        companyId: fixture.companyA.id,
        name: "Cliente Migrado",
        externalProvider: opcoes.historicoDoCliente,
        externalId: "15678",
      },
    });
    if (opcoes.integracao) {
      await prisma.eRPIntegration.create({
        data: { companyId: fixture.companyA.id, ...opcoes.integracao },
      });
    }

    const requisicoes: string[] = [];
    vi.doMock("@/lib/erp-adapter", () => ({
      resolveCompanyAdapter: async () => {
        const { ReceitanetAdapter: Fresh } = await import(
          "@/integrations/ReceitanetAdapter"
        );
        const fetchImpl: FetchLike = async (url) => {
          requisicoes.push(String(url));
          return { ok: true, status: 200, text: async () => "[]" };
        };
        return new Fresh({ token: "t", fetchImpl });
      },
    }));
    const mod = await import("@/lib/erp-operational-context");
    const contexto = await mod.loadErpOperationalContext(
      fixture.companyA.id,
      customer.id,
    );
    return { contexto, requisicoes };
  }

  it("SEC-008-01 · empresa que migrou não fala com o ERP anterior", async () => {
    // Histórico diz RECEITANET; o ERP ativo agora é outro.
    const { contexto, requisicoes } = await carregar({
      historicoDoCliente: "RECEITANET",
      integracao: { provider: "MOCK", enabled: true },
    });

    expect(requisicoes, "vazou requisição para o provider desativado").toEqual([]);
    expect(contexto.linked).toBe(false);
    expect(contexto.provider).toBeNull();
  });

  it("SEC-008-02 · integração DESABILITADA não recebe chamada", async () => {
    const { contexto, requisicoes } = await carregar({
      historicoDoCliente: "RECEITANET",
      integracao: { provider: "RECEITANET", enabled: false },
    });

    expect(requisicoes).toEqual([]);
    expect(contexto.linked).toBe(false);
  });

  it("SEC-008-03 · empresa sem integração nenhuma não recebe chamada", async () => {
    const { contexto, requisicoes } = await carregar({
      historicoDoCliente: "RECEITANET",
      integracao: null,
    });

    expect(requisicoes).toEqual([]);
    expect(contexto.linked).toBe(false);
  });

  it("SEC-008-04 · CONTROLE POSITIVO: com o ERP ativo, a chamada sai", async () => {
    /*
      Sem este controle, a correção passaria mesmo se alguém tivesse parado de
      consultar o ERP em qualquer circunstância — o contexto operacional
      inteiro ficaria vazio e os três testes acima continuariam verdes.
    */
    const { contexto, requisicoes } = await carregar({
      historicoDoCliente: "RECEITANET",
      integracao: { provider: "RECEITANET", enabled: true },
    });

    expect(requisicoes.length).toBeGreaterThan(0);
    expect(contexto.linked).toBe(true);
    expect(contexto.provider).toBe("RECEITANET");
  });

  it("SEC-008-05 · o histórico do cliente é PRESERVADO", async () => {
    /*
      A correção é sobre a chamada ao vivo, e nada mais. Apagar ou converter
      `externalProvider` destruiria a informação de qual sistema originou cada
      atendimento — proibido pelo próprio contrato do produto (§33).
    */
    const customer = await prisma.customer.create({
      data: {
        companyId: fixture.companyA.id,
        name: "Cliente Migrado",
        externalProvider: "RECEITANET",
        externalId: "15678",
      },
    });
    await prisma.eRPIntegration.create({
      data: { companyId: fixture.companyA.id, provider: "MOCK", enabled: true },
    });

    const mod = await import("@/lib/erp-operational-context");
    await mod.loadErpOperationalContext(fixture.companyA.id, customer.id);

    const depois = await prisma.customer.findUniqueOrThrow({
      where: { id: customer.id },
      select: { externalProvider: true, externalId: true },
    });
    expect(depois.externalProvider).toBe("RECEITANET");
    expect(depois.externalId).toBe("15678");
  });
});
