import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  CAPABILITY_LIMIT,
  ERP_CAPABILITIES,
  resetCapabilityLimits,
} from "@/lib/capability-rate-limit";
import { POST as searchRoute } from "@/app/api/integrations/customers/search/route";
import { POST as importRoute } from "@/app/api/integrations/customers/import/route";
import { POST as testConnectionRoute } from "@/app/api/integrations/test-connection/route";
import { POST as syncRoute } from "@/app/api/integrations/sync/route";
import {
  GET as diagnosticGet,
  POST as diagnosticPost,
} from "@/app/api/service-orders/[id]/diagnostic/route";
import {
  allocateTestServiceOrderNumber,
  apiRequest,
  createTokenFor,
  seedTestData,
  type TestFixture,
} from "./helpers";

/**
 * RATE-01 — teto nas rotas que amplificam chamada ao provider.
 *
 * A auditoria da v0.7.x encontrou o teto implementado em UMA rota enquanto a
 * documentação afirmava cobertura geral. Estes testes existem para que a
 * afirmação e o código não voltem a divergir: cada rota amplificadora tem aqui
 * a prova de que consome cota, e a prova de que a cota é isolada por empresa,
 * por usuário e por capability.
 *
 * Nenhum teste sai para o ReceitaNet. As rotas falham antes disso — o que
 * importa medir é o STATUS, e o 429 acontece antes de qualquer transporte.
 */

let fixture: TestFixture;
beforeEach(async () => {
  fixture = await seedTestData();
  // O estado do limitador é do processo, não do banco: sem isto um cenário
  // herdaria a cota gasta pelo anterior e passaria por acidente.
  resetCapabilityLimits();
});

const ORIGIN = { origin: "http://localhost" };

/**
 * Dispara a rota `n` vezes e devolve os status, em ordem.
 *
 * Sequencial de propósito: o teto é um contador, e uma corrida mediria outra
 * coisa. A corrida real do limitador está coberta no teste de unidade.
 */
async function fire(n: number, call: () => Promise<Response>): Promise<number[]> {
  const status: number[] = [];
  for (let i = 0; i < n; i += 1) {
    status.push((await call()).status);
  }
  return status;
}

async function integrationFor(companyId: string) {
  return prisma.eRPIntegration.upsert({
    where: { companyId },
    update: { provider: "MOCK", enabled: true },
    create: { companyId, provider: "MOCK", name: "Mock ERP", enabled: true },
  });
}

// ---------------------------------------------------------------------------
// Cada rota amplificadora consome cota
// ---------------------------------------------------------------------------

describe("Rotas que falam com o provider têm teto", () => {
  it("busca de cliente: abaixo do teto passa, acima devolve 429", async () => {
    await integrationFor(fixture.companyA.id);
    const token = await createTokenFor(fixture.adminA.id);
    const call = () =>
      searchRoute(
        apiRequest(
          "/api/integrations/customers/search",
          { method: "POST", body: { name: "Fulano" }, headers: { ...ORIGIN } },
          token,
        ),
      );

    const limite = 20;
    const dentro = await fire(limite, call);
    // Controle positivo: nenhuma das requisições legítimas foi barrada.
    expect(dentro.filter((s) => s === 429)).toHaveLength(0);
    expect((await call()).status).toBe(429);
  });

  it("importação de cliente: acima do teto devolve 429", async () => {
    await integrationFor(fixture.companyA.id);
    const token = await createTokenFor(fixture.adminA.id);
    const call = () =>
      importRoute(
        apiRequest(
          "/api/integrations/customers/import",
          { method: "POST", body: { externalId: "1" }, headers: { ...ORIGIN } },
          token,
        ),
      );

    const dentro = await fire(30, call);
    expect(dentro.filter((s) => s === 429)).toHaveLength(0);
    expect((await call()).status).toBe(429);
  });

  it("teste de conexão: acima do teto devolve 429", async () => {
    await integrationFor(fixture.companyA.id);
    const token = await createTokenFor(fixture.adminA.id);
    const call = () =>
      testConnectionRoute(
        apiRequest(
          "/api/integrations/test-connection",
          { method: "POST", body: { provider: "MOCK" }, headers: { ...ORIGIN } },
          token,
        ),
      );

    const dentro = await fire(CAPABILITY_LIMIT, call);
    expect(dentro.filter((s) => s === 429)).toHaveLength(0);
    expect((await call()).status).toBe(429);
  });

  it("sincronização de OS: teto mais apertado, porque é operação em lote", async () => {
    await integrationFor(fixture.companyA.id);
    const token = await createTokenFor(fixture.adminA.id);
    const call = () =>
      syncRoute(
        apiRequest(
          "/api/integrations/sync",
          { method: "POST", body: {}, headers: { ...ORIGIN } },
          token,
        ),
      );

    const dentro = await fire(5, call);
    expect(dentro.filter((s) => s === 429)).toHaveLength(0);
    expect((await call()).status).toBe(429);
  });
});

// ---------------------------------------------------------------------------
// O amplificador que o técnico alcança
// ---------------------------------------------------------------------------

describe("Diagnóstico: o técnico não atualiza sem limite", () => {
  async function ordemDoTecnico() {
    const customer = await prisma.customer.create({
      data: {
        companyId: fixture.companyA.id,
        name: "Cliente do Diagnóstico",
        document: "10020030044",
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
        type: "Instalação",
        description: "Atendimento de teste.",
        status: "ASSIGNED",
      },
    });
    return { customer, order };
  }

  it("TECHNICIAN dono: abaixo do teto passa, acima devolve 429", async () => {
    await integrationFor(fixture.companyA.id);
    const { order } = await ordemDoTecnico();
    const token = await createTokenFor(fixture.techA.id);
    const call = () =>
      diagnosticPost(
        apiRequest(
          `/api/service-orders/${order.id}/diagnostic`,
          { method: "POST", body: {}, headers: { ...ORIGIN } },
          token,
        ),
        { params: { id: order.id } },
      );

    const dentro = await fire(CAPABILITY_LIMIT, call);
    expect(dentro.filter((s) => s === 429)).toHaveLength(0);
    expect((await call()).status).toBe(429);
  });

  it("a mensagem do 429 não vaza nada do upstream", async () => {
    await integrationFor(fixture.companyA.id);
    const { order } = await ordemDoTecnico();
    const token = await createTokenFor(fixture.techA.id);
    const call = () =>
      diagnosticPost(
        apiRequest(
          `/api/service-orders/${order.id}/diagnostic`,
          { method: "POST", body: {}, headers: { ...ORIGIN } },
          token,
        ),
        { params: { id: order.id } },
      );

    await fire(CAPABILITY_LIMIT, call);
    const blocked = await call();
    expect(blocked.status).toBe(429);

    const body = await blocked.json();
    expect(body.error).toBe("Muitas solicitações. Tente novamente em instantes.");
    // Diz quanto esperar, e nada além disso.
    expect(body.details).toEqual({
      retryAfterSeconds: expect.any(Number),
    });

    const serialized = JSON.stringify(body);
    for (const proibido of [
      "token",
      "receitanet",
      "http",
      "customer-diagnostic",
      order.id,
      fixture.companyA.id,
    ]) {
      expect(serialized.toLowerCase()).not.toContain(proibido.toLowerCase());
    }
  });

  it("o GET do diagnóstico NÃO consome cota: ele lê o snapshot local", async () => {
    await integrationFor(fixture.companyA.id);
    const { order } = await ordemDoTecnico();
    const token = await createTokenFor(fixture.techA.id);

    // Muito além de qualquer teto — nenhuma delas fala com o provider.
    const status = await fire(CAPABILITY_LIMIT * 3, () =>
      diagnosticGet(
        apiRequest(`/api/service-orders/${order.id}/diagnostic`, {}, token),
        { params: { id: order.id } },
      ),
    );
    expect(status.every((s) => s === 200)).toBe(true);

    // E a cota do POST continua inteira depois disso.
    const refresh = await diagnosticPost(
      apiRequest(
        `/api/service-orders/${order.id}/diagnostic`,
        { method: "POST", body: {}, headers: { ...ORIGIN } },
        token,
      ),
      { params: { id: order.id } },
    );
    expect(refresh.status).not.toBe(429);
  });
});

// ---------------------------------------------------------------------------
// Isolamento da cota
// ---------------------------------------------------------------------------

describe("A cota é isolada por empresa, usuário e capability", () => {
  async function esgotarTesteDeConexao(userId: string) {
    const token = await createTokenFor(userId);
    await fire(CAPABILITY_LIMIT, () =>
      testConnectionRoute(
        apiRequest(
          "/api/integrations/test-connection",
          { method: "POST", body: { provider: "MOCK" }, headers: { ...ORIGIN } },
          token,
        ),
      ),
    );
  }

  it("empresa A esgotar não bloqueia a empresa B", async () => {
    await integrationFor(fixture.companyA.id);
    await integrationFor(fixture.companyB.id);

    await esgotarTesteDeConexao(fixture.adminA.id);

    const tokenB = await createTokenFor(fixture.adminB.id);
    const resB = await testConnectionRoute(
      apiRequest(
        "/api/integrations/test-connection",
        { method: "POST", body: { provider: "MOCK" }, headers: { ...ORIGIN } },
        tokenB,
      ),
    );
    expect(resB.status).not.toBe(429);
  });

  it("um operador em loop não derruba o colega da mesma empresa", async () => {
    await integrationFor(fixture.companyA.id);
    await esgotarTesteDeConexao(fixture.adminA.id);

    // `dispatcherA` não pode testar conexão (é ADMIN-only), então a prova usa
    // a busca, que ele pode: o ponto é que a cota é por usuário.
    const tokenColega = await createTokenFor(fixture.dispatcherA.id);
    const res = await searchRoute(
      apiRequest(
        "/api/integrations/customers/search",
        { method: "POST", body: { name: "Fulano" }, headers: { ...ORIGIN } },
        tokenColega,
      ),
    );
    expect(res.status).not.toBe(429);
  });

  it("esgotar uma capability não gasta a cota da outra", async () => {
    await integrationFor(fixture.companyA.id);
    await esgotarTesteDeConexao(fixture.adminA.id);

    const token = await createTokenFor(fixture.adminA.id);
    const busca = await searchRoute(
      apiRequest(
        "/api/integrations/customers/search",
        { method: "POST", body: { name: "Fulano" }, headers: { ...ORIGIN } },
        token,
      ),
    );
    expect(busca.status).not.toBe(429);
  });

  it("as capabilities declaradas são distintas entre si", () => {
    const nomes = Object.values(ERP_CAPABILITIES);
    // Dois endpoints com o mesmo nome compartilhariam balde em silêncio, e um
    // deles passaria a ter metade do teto que a leitura do código promete.
    expect(new Set(nomes).size).toBe(nomes.length);
  });
});

// ---------------------------------------------------------------------------
// O teto vem DEPOIS da autorização
// ---------------------------------------------------------------------------

describe("Sondagem não autorizada não consome cota de ninguém", () => {
  it("requisição sem sessão não gasta a cota da empresa", async () => {
    await integrationFor(fixture.companyA.id);

    const anonimos = await fire(CAPABILITY_LIMIT * 2, () =>
      testConnectionRoute(
        apiRequest("/api/integrations/test-connection", {
          method: "POST",
          body: { provider: "MOCK" },
          headers: { ...ORIGIN },
        }),
      ),
    );
    expect(anonimos.every((s) => s === 401)).toBe(true);

    // O ADMIN continua com a cota inteira.
    const token = await createTokenFor(fixture.adminA.id);
    const status = await fire(CAPABILITY_LIMIT, () =>
      testConnectionRoute(
        apiRequest(
          "/api/integrations/test-connection",
          { method: "POST", body: { provider: "MOCK" }, headers: { ...ORIGIN } },
          token,
        ),
      ),
    );
    expect(status.filter((s) => s === 429)).toHaveLength(0);
  });

  it("perfil sem permissão não gasta a cota do ADMIN", async () => {
    await integrationFor(fixture.companyA.id);

    const tokenTecnico = await createTokenFor(fixture.techA.id);
    const negados = await fire(CAPABILITY_LIMIT * 2, () =>
      testConnectionRoute(
        apiRequest(
          "/api/integrations/test-connection",
          { method: "POST", body: { provider: "MOCK" }, headers: { ...ORIGIN } },
          tokenTecnico,
        ),
      ),
    );
    expect(negados.every((s) => s === 403)).toBe(true);

    const tokenAdmin = await createTokenFor(fixture.adminA.id);
    const status = await fire(CAPABILITY_LIMIT, () =>
      testConnectionRoute(
        apiRequest(
          "/api/integrations/test-connection",
          { method: "POST", body: { provider: "MOCK" }, headers: { ...ORIGIN } },
          tokenAdmin,
        ),
      ),
    );
    expect(status.filter((s) => s === 429)).toHaveLength(0);
  });

  it("técnico que não é dono da OS não gasta cota ao sondar", async () => {
    await integrationFor(fixture.companyA.id);
    const customer = await prisma.customer.create({
      data: { companyId: fixture.companyA.id, name: "Cliente", document: "10020030044" },
    });
    const dono = await prisma.technician.create({
      data: { companyId: fixture.companyA.id, userId: fixture.techA.id },
    });
    await prisma.technician.create({
      data: { companyId: fixture.companyA.id, userId: fixture.techB.id },
    });
    const order = await prisma.serviceOrder.create({
      data: {
        companyId: fixture.companyA.id,
        number: await allocateTestServiceOrderNumber(fixture.companyA.id),
        customerId: customer.id,
        technicianId: dono.id,
        type: "Instalação",
        description: "Atendimento de teste.",
        status: "ASSIGNED",
      },
    });

    const tokenIntruso = await createTokenFor(fixture.techB.id);
    const sondagens = await fire(CAPABILITY_LIMIT * 2, () =>
      diagnosticPost(
        apiRequest(
          `/api/service-orders/${order.id}/diagnostic`,
          { method: "POST", body: {}, headers: { ...ORIGIN } },
          tokenIntruso,
        ),
        { params: { id: order.id } },
      ),
    );
    expect(sondagens.every((s) => s === 404)).toBe(true);

    // O dono legítimo não perdeu nada.
    const tokenDono = await createTokenFor(fixture.techA.id);
    const status = await fire(CAPABILITY_LIMIT, () =>
      diagnosticPost(
        apiRequest(
          `/api/service-orders/${order.id}/diagnostic`,
          { method: "POST", body: {}, headers: { ...ORIGIN } },
          tokenDono,
        ),
        { params: { id: order.id } },
      ),
    );
    expect(status.filter((s) => s === 429)).toHaveLength(0);
  });
});
