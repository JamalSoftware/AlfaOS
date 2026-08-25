import { describe, it, expect, beforeEach } from "vitest";
import { POST as syncOrders } from "@/app/api/integrations/sync/route";
import {
  GET as listTypes,
  POST as createType,
} from "@/app/api/service-order-types/route";
import { PATCH as patchType } from "@/app/api/service-order-types/[id]/route";
import { POST as testConnection } from "@/app/api/integrations/test-connection/route";
import { POST as createCustomerRoute } from "@/app/api/customers/route";
import { PATCH as patchCustomer } from "@/app/api/customers/[id]/route";
import { prisma } from "@/lib/prisma";
import {
  createManualServiceOrder,
  importServiceOrder,
  listRecentCompletedForTechnician,
  listServiceOrdersForTechnician,
} from "@/lib/service-orders";
import {
  getCredential,
  getCredentialStatus,
  saveCredential,
} from "@/lib/erp-credentials";
import {
  getCredentialFor,
  listCredentialStatus,
  saveCredentialFor,
} from "@/lib/erp-credential-store";
import { DomainError } from "@/lib/errors";
import {
  allocateTestServiceOrderNumber,
  apiRequest,
  createTokenFor,
  seedTestData,
  type TestFixture,
} from "./helpers";

let fixture: TestFixture;

beforeEach(async () => {
  fixture = await seedTestData();
});

async function createCustomer(companyId: string, name = "Cliente Teste") {
  return prisma.customer.create({ data: { companyId, name } });
}

async function enableMockERP(companyId: string): Promise<void> {
  await prisma.eRPIntegration.upsert({
    where: { companyId },
    update: { enabled: true, provider: "MOCK" },
    create: { companyId, provider: "MOCK", name: "Mock ERP", enabled: true },
  });
}

async function expectDomainError(
  promise: Promise<unknown>,
  status: number,
): Promise<DomainError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).status).toBe(status);
    return error as DomainError;
  }
  throw new Error(`Esperava DomainError ${status}, mas nada foi lançado.`);
}

// ---------------------------------------------------------------------------
// Origem
// ---------------------------------------------------------------------------

describe("Origem da OS", () => {
  it("OS criada no AlfaOS nasce INTERNAL e sem identidade externa", async () => {
    const customer = await createCustomer(fixture.companyA.id);

    const order = await createManualServiceOrder(
      fixture.companyA.id,
      fixture.adminA.id,
      {
        customerId: customer.id,
        typeId: fixture.typeA.id,
        description: "Instalação de fibra.",
        priority: "NORMAL",
      },
    );

    expect(order.origin).toBe("INTERNAL");
    expect(order.externalProvider).toBeNull();

    const row = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(row.externalId).toBeNull();
  });

  it("OS importada do MockERP nasce EXTERNAL com identidade externa", async () => {
    await enableMockERP(fixture.companyA.id);
    const token = await createTokenFor(fixture.adminA.id);

    const res = await syncOrders(
      apiRequest("/api/integrations/sync", { method: "POST" }, token),
    );
    expect(res.status).toBe(200);

    const imported = await prisma.serviceOrder.findMany({
      where: { companyId: fixture.companyA.id },
    });
    expect(imported.length).toBeGreaterThan(0);
    for (const order of imported) {
      expect(order.origin).toBe("EXTERNAL");
      expect(order.externalProvider).toBe("MOCK");
      expect(order.externalId).not.toBeNull();
    }
  });

  /**
   * O ponto central do PRD §122: origem é onde a OS NASCEU, não um reflexo dos
   * campos externos. Se fosse derivada de `externalId`, este cenário —
   * uma OS interna que depois ganha vínculo com o ERP — passaria a mentir
   * sobre a própria procedência.
   */
  it("vincular identidade externa a uma OS INTERNAL não muda a origem", async () => {
    const customer = await createCustomer(fixture.companyA.id);
    const order = await createManualServiceOrder(
      fixture.companyA.id,
      fixture.adminA.id,
      {
        customerId: customer.id,
        typeId: fixture.typeA.id,
        description: "Nasceu no AlfaOS.",
        priority: "NORMAL",
      },
    );

    await prisma.serviceOrder.update({
      where: { id: order.id },
      data: { externalProvider: "MOCK", externalId: "VINCULO-POSTERIOR-1" },
    });

    const row = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(row.externalId).toBe("VINCULO-POSTERIOR-1");
    expect(row.origin).toBe("INTERNAL");
  });

  it("o banco recusa OS EXTERNAL sem identidade externa", async () => {
    const customer = await createCustomer(fixture.companyA.id);

    // Ataque pelo caminho mais baixo disponível: Prisma direto, sem passar por
    // nenhuma validação de aplicação. O CHECK é a última linha e precisa segurar.
    await expect(
      prisma.serviceOrder.create({
        data: {
          companyId: fixture.companyA.id,
          number: await allocateTestServiceOrderNumber(fixture.companyA.id),
          customerId: customer.id,
          type: "Instalação",
          description: "EXTERNAL sem provider nem id.",
          origin: "EXTERNAL",
        },
      }),
    ).rejects.toThrow();

    expect(
      await prisma.serviceOrder.count({ where: { companyId: fixture.companyA.id } }),
    ).toBe(0);
  });

  it("reimportar a mesma OS externa continua idempotente e mantém a origem", async () => {
    const input = {
      externalProvider: "MOCK",
      externalId: "IDEMP-1",
      externalNumber: "9001",
      type: "Manutenção",
      description: "Primeira importação.",
      priority: "NORMAL" as const,
      customer: { externalId: "CUST-IDEMP-1", name: "Cliente Externo" },
    };

    const first = await importServiceOrder(
      fixture.companyA.id,
      fixture.adminA.id,
      input,
    );
    const second = await importServiceOrder(
      fixture.companyA.id,
      fixture.adminA.id,
      { ...input, description: "Reimportada." },
    );

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.serviceOrder.id).toBe(first.serviceOrder.id);
    expect(second.serviceOrder.origin).toBe("EXTERNAL");

    expect(
      await prisma.serviceOrder.count({ where: { companyId: fixture.companyA.id } }),
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// ServiceOrderType
// ---------------------------------------------------------------------------

describe("Tipos de OS", () => {
  it("ADMIN cria tipo; DISPATCHER lê; TECHNICIAN não alcança", async () => {
    const adminToken = await createTokenFor(fixture.adminA.id);
    const dispatcherToken = await createTokenFor(fixture.dispatcherA.id);
    const techToken = await createTokenFor(fixture.techA.id);

    const created = await createType(
      apiRequest(
        "/api/service-order-types",
        { method: "POST", body: { name: "Troca de ONU", sortOrder: 5 } },
        adminToken,
      ),
    );
    expect(created.status).toBe(201);

    const read = await listTypes(
      apiRequest("/api/service-order-types", {}, dispatcherToken),
    );
    expect(read.status).toBe(200);
    const payload = await read.json();
    expect(payload.data.types.map((t: { name: string }) => t.name)).toContain(
      "Troca de ONU",
    );

    const denied = await listTypes(
      apiRequest("/api/service-order-types", {}, techToken),
    );
    expect(denied.status).toBe(403);

    const deniedWrite = await createType(
      apiRequest(
        "/api/service-order-types",
        { method: "POST", body: { name: "Proibido" } },
        dispatcherToken,
      ),
    );
    expect(deniedWrite.status).toBe(403);
  });

  it("o catálogo é isolado por empresa", async () => {
    const tokenB = await createTokenFor(fixture.adminB.id);

    await prisma.serviceOrderType.create({
      data: { companyId: fixture.companyA.id, name: "Só da A" },
    });

    const res = await listTypes(
      apiRequest("/api/service-order-types?includeInactive=true", {}, tokenB),
    );
    const payload = await res.json();
    const names = payload.data.types.map((t: { name: string }) => t.name);
    expect(names).not.toContain("Só da A");
  });

  it("empresa B não altera tipo da empresa A (404, não 403)", async () => {
    const tokenB = await createTokenFor(fixture.adminB.id);

    const res = await patchType(
      apiRequest(
        `/api/service-order-types/${fixture.typeA.id}`,
        { method: "PATCH", body: { name: "Sequestrado" } },
        tokenB,
      ),
      { params: { id: fixture.typeA.id } },
    );
    expect(res.status).toBe(404);

    const untouched = await prisma.serviceOrderType.findUniqueOrThrow({
      where: { id: fixture.typeA.id },
    });
    expect(untouched.name).toBe("Instalação");
  });

  it("nome duplicado na mesma empresa é recusado, inclusive variando caixa", async () => {
    const token = await createTokenFor(fixture.adminA.id);

    const res = await createType(
      apiRequest(
        "/api/service-order-types",
        { method: "POST", body: { name: "instalação" } },
        token,
      ),
    );
    expect(res.status).toBe(409);

    // Controle positivo: o mesmo nome EM OUTRA empresa é livre — a unicidade
    // é por tenant, não global.
    const tokenB = await createTokenFor(fixture.adminB.id);
    const okB = await createType(
      apiRequest(
        "/api/service-order-types",
        { method: "POST", body: { name: "Instalação Extra" } },
        tokenB,
      ),
    );
    expect(okB.status).toBe(201);
  });

  it("mass assignment de companyId é bloqueado (schema strict)", async () => {
    const token = await createTokenFor(fixture.adminA.id);

    const res = await createType(
      apiRequest(
        "/api/service-order-types",
        {
          method: "POST",
          body: { name: "Injetado", companyId: fixture.companyB.id },
        },
        token,
      ),
    );
    expect(res.status).toBe(400);
    expect(
      await prisma.serviceOrderType.count({
        where: { companyId: fixture.companyB.id, name: "Injetado" },
      }),
    ).toBe(0);
  });

  it("criar OS exige tipo da própria empresa", async () => {
    const customer = await createCustomer(fixture.companyA.id);

    await expectDomainError(
      createManualServiceOrder(fixture.companyA.id, fixture.adminA.id, {
        customerId: customer.id,
        // Tipo real, mas da empresa B.
        typeId: fixture.typeB.id,
        description: "Tentando usar tipo alheio.",
        priority: "NORMAL",
      }),
      404,
    );

    expect(
      await prisma.serviceOrder.count({ where: { companyId: fixture.companyA.id } }),
    ).toBe(0);
  });

  /**
   * O motivo de `ServiceOrder.type` continuar sendo texto: desativar ou
   * renomear um tipo não pode reescrever o que já foi executado.
   */
  it("desativar um tipo não quebra nem altera OS histórica", async () => {
    const customer = await createCustomer(fixture.companyA.id);
    const order = await createManualServiceOrder(
      fixture.companyA.id,
      fixture.adminA.id,
      {
        customerId: customer.id,
        typeId: fixture.typeA.id,
        description: "Feita quando o tipo estava ativo.",
        priority: "NORMAL",
      },
    );
    expect(order.type).toBe("Instalação");

    const token = await createTokenFor(fixture.adminA.id);
    const res = await patchType(
      apiRequest(
        `/api/service-order-types/${fixture.typeA.id}`,
        { method: "PATCH", body: { active: false, name: "Instalação (antiga)" } },
        token,
      ),
      { params: { id: fixture.typeA.id } },
    );
    expect(res.status).toBe(200);

    const after = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: order.id },
    });
    // Rótulo intacto e vínculo preservado: nada do histórico foi reescrito.
    expect(after.type).toBe("Instalação");
    expect(after.typeId).toBe(fixture.typeA.id);

    // Mas o tipo desativado não serve para OS nova.
    await expectDomainError(
      createManualServiceOrder(fixture.companyA.id, fixture.adminA.id, {
        customerId: customer.id,
        typeId: fixture.typeA.id,
        description: "Não deveria passar.",
        priority: "NORMAL",
      }),
      400,
    );
  });
});

// ---------------------------------------------------------------------------
// Identidade externa do Customer
// ---------------------------------------------------------------------------

describe("Customer externalId", () => {
  it("é opcional e o provider vem do servidor, nunca do request", async () => {
    await enableMockERP(fixture.companyA.id);
    const token = await createTokenFor(fixture.adminA.id);

    const semId = await createCustomerRoute(
      apiRequest(
        "/api/customers",
        { method: "POST", body: { name: "Sem contrato" } },
        token,
      ),
    );
    expect(semId.status).toBe(201);
    expect((await semId.json()).data.customer.externalId).toBeNull();

    const comId = await createCustomerRoute(
      apiRequest(
        "/api/customers",
        { method: "POST", body: { name: "Com contrato", externalId: "15678" } },
        token,
      ),
    );
    expect(comId.status).toBe(201);
    const created = (await comId.json()).data.customer;
    expect(created.externalId).toBe("15678");
    // Derivado da integração da empresa, não enviado pelo cliente.
    expect(created.externalProvider).toBe("MOCK");
  });

  it("enviar externalProvider no corpo é recusado (400)", async () => {
    await enableMockERP(fixture.companyA.id);
    const token = await createTokenFor(fixture.adminA.id);

    const res = await createCustomerRoute(
      apiRequest(
        "/api/customers",
        {
          method: "POST",
          body: {
            name: "Forjado",
            externalId: "1",
            externalProvider: "RECEITANET",
          },
        },
        token,
      ),
    );
    expect(res.status).toBe(400);
    expect(await prisma.customer.count()).toBe(0);
  });

  it("colisão de identidade externa na mesma empresa é 409", async () => {
    await enableMockERP(fixture.companyA.id);
    const token = await createTokenFor(fixture.adminA.id);

    const first = await createCustomerRoute(
      apiRequest(
        "/api/customers",
        { method: "POST", body: { name: "Primeiro", externalId: "DUP-1" } },
        token,
      ),
    );
    expect(first.status).toBe(201);

    const second = await createCustomerRoute(
      apiRequest(
        "/api/customers",
        { method: "POST", body: { name: "Segundo", externalId: "DUP-1" } },
        token,
      ),
    );
    expect(second.status).toBe(409);
    expect(await prisma.customer.count()).toBe(1);
  });

  it("o mesmo externalId em outra empresa é permitido", async () => {
    await enableMockERP(fixture.companyA.id);
    await enableMockERP(fixture.companyB.id);

    const tokenA = await createTokenFor(fixture.adminA.id);
    const tokenB = await createTokenFor(fixture.adminB.id);

    const a = await createCustomerRoute(
      apiRequest(
        "/api/customers",
        { method: "POST", body: { name: "Cliente A", externalId: "MESMO-ID" } },
        tokenA,
      ),
    );
    const b = await createCustomerRoute(
      apiRequest(
        "/api/customers",
        { method: "POST", body: { name: "Cliente B", externalId: "MESMO-ID" } },
        tokenB,
      ),
    );

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(await prisma.customer.count()).toBe(2);
  });

  it("limpar o campo remove id e provider juntos", async () => {
    await enableMockERP(fixture.companyA.id);
    const token = await createTokenFor(fixture.adminA.id);

    const customer = await prisma.customer.create({
      data: {
        companyId: fixture.companyA.id,
        name: "Com vínculo",
        externalProvider: "MOCK",
        externalId: "LIMPAR-1",
      },
    });

    const res = await patchCustomer(
      apiRequest(
        `/api/customers/${customer.id}`,
        { method: "PATCH", body: { externalId: "" } },
        token,
      ),
      { params: { id: customer.id } },
    );
    expect(res.status).toBe(200);

    const after = await prisma.customer.findUniqueOrThrow({
      where: { id: customer.id },
    });
    expect(after.externalId).toBeNull();
    // Um provider órfão afirmaria pertencer a um sistema sem dizer com que id.
    expect(after.externalProvider).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Histórico do técnico
// ---------------------------------------------------------------------------

describe("Concluídas recentes do técnico", () => {
  async function scenario() {
    const customer = await createCustomer(fixture.companyA.id);
    const techOne = await prisma.technician.create({
      data: { companyId: fixture.companyA.id, userId: fixture.techA.id },
    });
    const techTwo = await prisma.technician.create({
      data: { companyId: fixture.companyA.id, userId: fixture.techB.id },
    });

    const mine = await prisma.serviceOrder.create({
      data: {
        companyId: fixture.companyA.id,
        number: await allocateTestServiceOrderNumber(fixture.companyA.id),
        customerId: customer.id,
        technicianId: techOne.id,
        type: "Instalação",
        description: "Concluída por mim.",
        status: "COMPLETED",
        completedAt: new Date(),
      },
    });
    const theirs = await prisma.serviceOrder.create({
      data: {
        companyId: fixture.companyA.id,
        number: await allocateTestServiceOrderNumber(fixture.companyA.id),
        customerId: customer.id,
        technicianId: techTwo.id,
        type: "Instalação",
        description: "Concluída pelo outro.",
        status: "COMPLETED",
        completedAt: new Date(),
      },
    });

    return { techOne, techTwo, mine, theirs, customer };
  }

  it("o técnico vê as próprias concluídas e não as do colega", async () => {
    const { techOne, mine, theirs } = await scenario();

    const completed = await listRecentCompletedForTechnician(
      fixture.companyA.id,
      techOne.id,
    );

    const ids = completed.map((o) => o.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(theirs.id);
    expect(completed).toHaveLength(1);
  });

  it("a fila operacional continua sem concluídas", async () => {
    const { techOne, customer } = await scenario();
    await prisma.serviceOrder.create({
      data: {
        companyId: fixture.companyA.id,
        customerId: customer.id,
        number: await allocateTestServiceOrderNumber(fixture.companyA.id),
        technicianId: techOne.id,
        type: "Instalação",
        description: "Ainda atribuída.",
        status: "ASSIGNED",
      },
    });

    const queue = await listServiceOrdersForTechnician(
      fixture.companyA.id,
      techOne.id,
    );
    const all = [...queue.inProgress, ...queue.today, ...queue.upcoming];

    expect(all).toHaveLength(1);
    expect(all.every((o) => o.status !== "COMPLETED")).toBe(true);
  });

  it("não atravessa empresa mesmo com o technicianId correto", async () => {
    const { techOne } = await scenario();

    // O mesmo técnico, consultado sob o tenant errado, não devolve nada.
    const leaked = await listRecentCompletedForTechnician(
      fixture.companyB.id,
      techOne.id,
    );
    expect(leaked).toHaveLength(0);
  });

  it("ignora concluídas fora da janela recente", async () => {
    const { techOne, customer } = await scenario();
    const antiga = new Date();
    antiga.setDate(antiga.getDate() - 90);

    await prisma.serviceOrder.create({
      data: {
        companyId: fixture.companyA.id,
        customerId: customer.id,
        number: await allocateTestServiceOrderNumber(fixture.companyA.id),
        technicianId: techOne.id,
        type: "Instalação",
        description: "Concluída há três meses.",
        status: "COMPLETED",
        completedAt: antiga,
      },
    });

    const completed = await listRecentCompletedForTechnician(
      fixture.companyA.id,
      techOne.id,
    );
    expect(completed).toHaveLength(1);
    expect(completed[0].description).toBe("Concluída por mim.");
  });
});

// ---------------------------------------------------------------------------
// Provider x credencial
// ---------------------------------------------------------------------------

describe("Troca de provider invalida a credencial", () => {
  it("limpa a credencial e informa, sem deixar last4 aparentando validade", async () => {
    await prisma.eRPIntegration.create({
      data: {
        companyId: fixture.companyA.id,
        provider: "MOCK",
        name: "Mock ERP",
        enabled: true,
      },
    });

    /**
     * Store OPERACIONAL, nao o legado.
     *
     * O invariante que este teste protege nao mudou -- trocar de provider nao
     * pode deixar para tras uma credencial que a tela anuncia como valida e
     * nenhum adapter consegue usar. O que mudou foi ONDE a credencial mora,
     * e um teste apontado para o lugar antigo deixaria o novo desprotegido.
     */
    await saveCredentialFor(
      fixture.companyA.id,
      fixture.adminA.id,
      "MOCK",
      "CALLCENTER",
      "token-secreto-do-mock-1234",
    );

    const [before] = await listCredentialStatus(fixture.companyA.id, "MOCK", [
      "CALLCENTER",
    ]);
    expect(before.configured).toBe(true);
    expect(before.last4).toBe("1234");
    expect(
      await getCredentialFor(fixture.companyA.id, "MOCK", "CALLCENTER"),
    ).toBe("token-secreto-do-mock-1234");

    const token = await createTokenFor(fixture.adminA.id);
    const res = await testConnection(
      apiRequest(
        "/api/integrations/test-connection",
        { method: "POST", body: { provider: "RECEITANET" } },
        token,
      ),
    );
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.data.invalidatedCredential).toBe(true);
    expect(payload.data.integration.provider).toBe("RECEITANET");

    const [afterCallCenter] = await listCredentialStatus(
      fixture.companyA.id,
      "RECEITANET",
      ["CALLCENTER"],
    );
    // Antes da v0.5.1 estas continuavam anunciando uma credencial que nao
    // decriptava mais.
    expect(afterCallCenter.configured).toBe(false);
    expect(afterCallCenter.last4).toBeNull();

    // Ausente, nao corrompida: nada a decriptar significa `null`, nao erro.
    expect(
      await getCredentialFor(fixture.companyA.id, "RECEITANET", "CALLCENTER"),
    ).toBeNull();
    // E a linha do provider ANTIGO foi de fato removida.
    expect(
      await prisma.eRPCredential.count({
        where: { companyId: fixture.companyA.id, provider: "MOCK" },
      }),
    ).toBe(0);

    const row = await prisma.eRPIntegration.findUniqueOrThrow({
      where: { companyId: fixture.companyA.id },
    });
    expect(row.credentialCiphertext).toBeNull();
    expect(row.credentialIv).toBeNull();
    expect(row.credentialAuthTag).toBeNull();
    expect(row.apiKey).toBeNull();
  });

  it("registra a invalidação em auditoria sem vazar segredo", async () => {
    await prisma.eRPIntegration.create({
      data: { companyId: fixture.companyA.id, provider: "MOCK", name: "Mock" },
    });
    const secret = "token-secreto-do-mock-1234";
    await saveCredentialFor(
      fixture.companyA.id,
      fixture.adminA.id,
      "MOCK",
      "CALLCENTER",
      secret,
    );

    const token = await createTokenFor(fixture.adminA.id);
    await testConnection(
      apiRequest(
        "/api/integrations/test-connection",
        { method: "POST", body: { provider: "RECEITANET" } },
        token,
      ),
    );

    const logs = await prisma.auditLog.findMany({
      where: { companyId: fixture.companyA.id },
    });
    const invalidation = logs.find(
      (l) => l.action === "ERP_CREDENTIAL_INVALIDATED",
    );
    expect(invalidation).toBeDefined();
    expect(invalidation?.details).toContain("MOCK");
    expect(invalidation?.details).toContain("RECEITANET");

    const dump = JSON.stringify(logs);
    expect(dump).not.toContain(secret);
    expect(dump).not.toContain("1234");
  });

  it("testar o MESMO provider não mexe na credencial", async () => {
    await prisma.eRPIntegration.create({
      data: { companyId: fixture.companyA.id, provider: "MOCK", name: "Mock" },
    });
    await saveCredential(
      fixture.companyA.id,
      fixture.adminA.id,
      "token-secreto-do-mock-1234",
    );

    const token = await createTokenFor(fixture.adminA.id);
    const res = await testConnection(
      apiRequest(
        "/api/integrations/test-connection",
        { method: "POST", body: { provider: "MOCK" } },
        token,
      ),
    );
    const payload = await res.json();
    expect(payload.data.invalidatedCredential).toBe(false);

    // Controle positivo do teste anterior: a limpeza acontece pela TROCA, não
    // por qualquer chamada ao endpoint.
    const status = await getCredentialStatus(fixture.companyA.id);
    expect(status.configured).toBe(true);
    expect(status.last4).toBe("1234");
    expect(await getCredential(fixture.companyA.id, "MOCK")).toBe(
      "token-secreto-do-mock-1234",
    );
  });
});
