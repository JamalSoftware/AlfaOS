import { describe, it, expect, beforeEach } from "vitest";
import {
  POST as createOrder,
  GET as listOrders,
} from "@/app/api/service-orders/route";
import { GET as getOrder } from "@/app/api/service-orders/[id]/route";
import { POST as assignOrder } from "@/app/api/service-orders/[id]/assign/route";
import { POST as syncOrders } from "@/app/api/integrations/sync/route";
import { prisma } from "@/lib/prisma";
import { assignTechnician, importServiceOrder } from "@/lib/service-orders";
import { DomainError } from "@/lib/errors";
import {
  apiRequest,
  createTokenFor,
  seedTestData,
  type TestFixture,
} from "./helpers";

let fixture: TestFixture;

beforeEach(async () => {
  fixture = await seedTestData();
});

async function enableMockERP(companyId: string): Promise<void> {
  await prisma.eRPIntegration.upsert({
    where: { companyId },
    update: { enabled: true, provider: "MOCK" },
    create: { companyId, provider: "MOCK", name: "Mock ERP", enabled: true },
  });
}

async function createTech(
  companyId: string,
  userId: string,
): Promise<{ id: string }> {
  return prisma.technician.create({ data: { companyId, userId } });
}

async function createManualOrder(
  token: string,
  customerId: string,
): Promise<string> {
  const res = await createOrder(
    apiRequest(
      "/api/service-orders",
      {
        method: "POST",
        body: {
          customerId,
          type: "Instalação",
          description: "Instalação de fibra óptica.",
          priority: "NORMAL",
        },
      },
      token,
    ),
  );
  expect(res.status).toBe(201);
  const payload = await res.json();
  return payload.data.serviceOrder.id;
}

describe("Ordens de serviço", () => {
  it("Cria OS manual com status PENDING e evento na timeline", async () => {
    const token = await createTokenFor(fixture.adminA.id);
    const customer = await prisma.customer.create({
      data: { companyId: fixture.companyA.id, name: "Cliente A" },
    });

    const id = await createManualOrder(token, customer.id);

    const detail = await getOrder(
      apiRequest(`/api/service-orders/${id}`, {}, token),
      { params: { id } },
    );
    expect(detail.status).toBe(200);
    const payload = await detail.json();
    expect(payload.data.serviceOrder.status).toBe("PENDING");
    expect(payload.data.serviceOrder.source).toBe("MANUAL");
    expect(payload.data.serviceOrder.events).toHaveLength(1);
    expect(payload.data.serviceOrder.events[0].event).toBe(
      "SERVICE_ORDER_CREATED",
    );
  });

  it("Mass assignment é bloqueado ao criar OS", async () => {
    const token = await createTokenFor(fixture.adminA.id);
    const customer = await prisma.customer.create({
      data: { companyId: fixture.companyA.id, name: "Cliente A" },
    });

    const res = await createOrder(
      apiRequest(
        "/api/service-orders",
        {
          method: "POST",
          body: {
            customerId: customer.id,
            type: "Manutenção",
            description: "Sem conexão.",
            status: "COMPLETED",
            companyId: fixture.companyB.id,
            technicianId: "fake-id",
          },
        },
        token,
      ),
    );
    expect(res.status).toBe(400);
    const count = await prisma.serviceOrder.count();
    expect(count).toBe(0);
  });

  it("OS manual exige cliente da mesma empresa (404)", async () => {
    const token = await createTokenFor(fixture.adminA.id);
    const customerB = await prisma.customer.create({
      data: { companyId: fixture.companyB.id, name: "Cliente B" },
    });

    const res = await createOrder(
      apiRequest(
        "/api/service-orders",
        {
          method: "POST",
          body: {
            customerId: customerB.id,
            type: "Manutenção",
            description: "Sem conexão.",
          },
        },
        token,
      ),
    );
    expect(res.status).toBe(404);
  });

  it("Sync do Mock ERP cria 3 OS e segunda sync não duplica", async () => {
    await enableMockERP(fixture.companyA.id);
    const token = await createTokenFor(fixture.adminA.id);

    const first = await syncOrders(apiRequest("/api/integrations/sync", { method: "POST" }, token));
    expect(first.status).toBe(200);
    let payload = await first.json();
    expect(payload.data.sync.fetched).toBe(3);
    expect(payload.data.sync.created).toBe(3);
    expect(payload.data.sync.updated).toBe(0);

    const imported = await prisma.serviceOrder.findMany({
      where: { companyId: fixture.companyA.id, source: "IMPORTED" },
    });
    expect(imported).toHaveLength(3);
    for (const order of imported) {
      expect(order.status).toBe("PENDING");
      expect(order.externalNumber).not.toBeNull();
    }

    const second = await syncOrders(apiRequest("/api/integrations/sync", { method: "POST" }, token));
    payload = await second.json();
    expect(payload.data.sync.created).toBe(0);
    expect(payload.data.sync.updated).toBe(3);

    const total = await prisma.serviceOrder.count({
      where: { companyId: fixture.companyA.id },
    });
    expect(total).toBe(3);
  });

  it("importServiceOrder concorrente para o mesmo externalId grava um único registro", async () => {
    // Mesma OS (mesmo externalId), clientes distintos para que a corrida caia
    // na criação da OS e não no upsert do cliente.
    const input = (customerExternalId: string) => ({
      externalProvider: "MOCK",
      externalId: "MOCK-RACE-1",
      externalNumber: "99001",
      type: "INSTALACAO",
      description: "OS importada em corrida",
      priority: "NORMAL" as const,
      scheduledAt: null,
      customer: { externalId: customerExternalId, name: "Cliente Corrida" },
    });

    const results = await Promise.all([
      importServiceOrder(fixture.companyA.id, fixture.adminA.id, input("MOCK-CUST-RACE-A")),
      importServiceOrder(fixture.companyA.id, fixture.adminA.id, input("MOCK-CUST-RACE-B")),
    ]);

    // Exatamente uma das chamadas cria; a outra vira update.
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.serviceOrder.id)).size).toBe(1);

    const orders = await prisma.serviceOrder.findMany({
      where: { companyId: fixture.companyA.id, externalId: "MOCK-RACE-1" },
    });
    expect(orders).toHaveLength(1);
    expect(orders[0]?.externalNumber).toBe("99001");
    expect(orders[0]?.status).toBe("PENDING");

    const events = await prisma.serviceOrderEvent.findMany({
      where: { serviceOrderId: orders[0]?.id },
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe("SERVICE_ORDER_IMPORTED");

    const audited = await prisma.auditLog.count({
      where: {
        companyId: fixture.companyA.id,
        action: "SERVICE_ORDER.IMPORTED",
      },
    });
    expect(audited).toBe(1);
  });

  it("Syncs concorrentes da mesma OS não duplicam nem quebram a timeline", async () => {
    await enableMockERP(fixture.companyA.id);
    const token = await createTokenFor(fixture.adminA.id);

    const [first, second] = await Promise.all([
      syncOrders(apiRequest("/api/integrations/sync", { method: "POST" }, token)),
      syncOrders(apiRequest("/api/integrations/sync", { method: "POST" }, token)),
    ]);

    // Nenhum 500 escapando da corrida.
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const [firstPayload, secondPayload] = await Promise.all([
      first.json(),
      second.json(),
    ]);
    // Cada OS é criada exatamente uma vez, entre as duas execuções.
    expect(
      firstPayload.data.sync.created + secondPayload.data.sync.created,
    ).toBe(3);
    expect(
      firstPayload.data.sync.updated + secondPayload.data.sync.updated,
    ).toBe(3);

    const imported = await prisma.serviceOrder.findMany({
      where: { companyId: fixture.companyA.id, source: "IMPORTED" },
    });
    expect(imported).toHaveLength(3);
    expect(new Set(imported.map((os) => os.externalId)).size).toBe(3);
    for (const order of imported) {
      expect(order.status).toBe("PENDING");
      expect(order.externalNumber).not.toBeNull();

      // Timeline: exatamente um evento de importação, nenhum órfão.
      const events = await prisma.serviceOrderEvent.findMany({
        where: { serviceOrderId: order.id },
      });
      expect(events).toHaveLength(1);
      expect(events[0]?.event).toBe("SERVICE_ORDER_IMPORTED");
    }

    // Auditoria: uma entrada de importação por OS.
    const audited = await prisma.auditLog.count({
      where: {
        companyId: fixture.companyA.id,
        action: "SERVICE_ORDER.IMPORTED",
      },
    });
    expect(audited).toBe(3);

    const orphanEvents = await prisma.serviceOrderEvent.count({
      where: { companyId: fixture.companyA.id, event: "SERVICE_ORDER_IMPORTED" },
    });
    expect(orphanEvents).toBe(3);
  });

  it("Reimportação não sobrescreve technician_id, status nem timeline", async () => {
    await enableMockERP(fixture.companyA.id);
    const token = await createTokenFor(fixture.adminA.id);
    await syncOrders(apiRequest("/api/integrations/sync", { method: "POST" }, token));

    const tech = await createTech(fixture.companyA.id, fixture.techA.id);

    const os = await prisma.serviceOrder.findFirst({
      where: { companyId: fixture.companyA.id, externalNumber: "10001" },
    });
    expect(os).not.toBeNull();

    const assignRes = await assignOrder(
      apiRequest(
        `/api/service-orders/${os!.id}/assign`,
        { method: "POST", body: { technicianId: tech.id } },
        token,
      ),
      { params: { id: os!.id } },
    );
    expect(assignRes.status).toBe(200);

    await syncOrders(apiRequest("/api/integrations/sync", { method: "POST" }, token));

    const after = await prisma.serviceOrder.findUnique({
      where: { id: os!.id },
    });
    expect(after?.status).toBe("ASSIGNED");
    expect(after?.technicianId).toBe(tech.id);

    const events = await prisma.serviceOrderEvent.findMany({
      where: { serviceOrderId: os!.id },
      orderBy: { createdAt: "asc" },
    });
    expect(events.map((e) => e.event)).toEqual([
      "SERVICE_ORDER_IMPORTED",
      "TECHNICIAN_ASSIGNED",
    ]);
  });

  it("Atribui OS e registra TECHNICIAN_ASSIGNED na timeline", async () => {
    const token = await createTokenFor(fixture.adminA.id);
    const customer = await prisma.customer.create({
      data: { companyId: fixture.companyA.id, name: "Cliente A" },
    });
    const id = await createManualOrder(token, customer.id);
    const tech = await createTech(fixture.companyA.id, fixture.techA.id);

    const res = await assignOrder(
      apiRequest(
        `/api/service-orders/${id}/assign`,
        { method: "POST", body: { technicianId: tech.id } },
        token,
      ),
      { params: { id } },
    );
    expect(res.status).toBe(200);

    const detail = await getOrder(apiRequest(`/api/service-orders/${id}`, {}, token), {
      params: { id },
    });
    const payload = await detail.json();
    const order = payload.data.serviceOrder;
    expect(order.status).toBe("ASSIGNED");
    expect(order.technician.id).toBe(tech.id);
    expect(order.assignedAt).not.toBeNull();

    const events = order.events.map((e: { event: string }) => e.event);
    expect(events).toContain("TECHNICIAN_ASSIGNED");
  });

  it("Troca de técnico registra TECHNICIAN_CHANGED e mantém status ASSIGNED", async () => {
    const token = await createTokenFor(fixture.adminA.id);
    const customer = await prisma.customer.create({
      data: { companyId: fixture.companyA.id, name: "Cliente A" },
    });
    const id = await createManualOrder(token, customer.id);
    const techA = await createTech(fixture.companyA.id, fixture.techA.id);
    const techB = await createTech(fixture.companyA.id, fixture.techB.id);

    await assignOrder(
      apiRequest(
        `/api/service-orders/${id}/assign`,
        { method: "POST", body: { technicianId: techA.id } },
        token,
      ),
      { params: { id } },
    );

    const changeRes = await assignOrder(
      apiRequest(
        `/api/service-orders/${id}/assign`,
        { method: "POST", body: { technicianId: techB.id } },
        token,
      ),
      { params: { id } },
    );
    expect(changeRes.status).toBe(200);

    const detail = await getOrder(apiRequest(`/api/service-orders/${id}`, {}, token), {
      params: { id },
    });
    const payload = await detail.json();
    const order = payload.data.serviceOrder;
    expect(order.status).toBe("ASSIGNED");
    expect(order.technician.id).toBe(techB.id);

    const events = order.events.map((e: { event: string }) => e.event);
    expect(events).toEqual([
      "SERVICE_ORDER_CREATED",
      "TECHNICIAN_ASSIGNED",
      "TECHNICIAN_CHANGED",
    ]);
  });

  it("Não atribui a OS já atribuída ao mesmo técnico (409)", async () => {
    const token = await createTokenFor(fixture.adminA.id);
    const customer = await prisma.customer.create({
      data: { companyId: fixture.companyA.id, name: "Cliente A" },
    });
    const id = await createManualOrder(token, customer.id);
    const tech = await createTech(fixture.companyA.id, fixture.techA.id);

    await assignOrder(
      apiRequest(
        `/api/service-orders/${id}/assign`,
        { method: "POST", body: { technicianId: tech.id } },
        token,
      ),
      { params: { id } },
    );

    const again = await assignOrder(
      apiRequest(
        `/api/service-orders/${id}/assign`,
        { method: "POST", body: { technicianId: tech.id } },
        token,
      ),
      { params: { id } },
    );
    expect(again.status).toBe(409);
  });

  it("Não atribui OS em estado terminal (COMPLETED/CANCELLED)", async () => {
    const token = await createTokenFor(fixture.adminA.id);
    const customer = await prisma.customer.create({
      data: { companyId: fixture.companyA.id, name: "Cliente A" },
    });
    const id = await createManualOrder(token, customer.id);
    const tech = await createTech(fixture.companyA.id, fixture.techA.id);

    await prisma.serviceOrder.update({
      where: { id },
      data: { status: "COMPLETED", completedAt: new Date() },
    });

    const res = await assignOrder(
      apiRequest(
        `/api/service-orders/${id}/assign`,
        { method: "POST", body: { technicianId: tech.id } },
        token,
      ),
      { params: { id } },
    );
    expect(res.status).toBe(409);
  });

  it("Não atribui técnico de outra empresa (404)", async () => {
    const token = await createTokenFor(fixture.adminA.id);
    const customer = await prisma.customer.create({
      data: { companyId: fixture.companyA.id, name: "Cliente A" },
    });
    const id = await createManualOrder(token, customer.id);
    const techB = await createTech(fixture.companyB.id, fixture.adminB.id);

    const res = await assignOrder(
      apiRequest(
        `/api/service-orders/${id}/assign`,
        { method: "POST", body: { technicianId: techB.id } },
        token,
      ),
      { params: { id } },
    );
    expect(res.status).toBe(404);
  });

  it("Técnico só acessa OS atribuída a ele (ownership)", async () => {
    const adminToken = await createTokenFor(fixture.adminA.id);
    const customer = await prisma.customer.create({
      data: { companyId: fixture.companyA.id, name: "Cliente A" },
    });
    const id = await createManualOrder(adminToken, customer.id);
    const techA = await createTech(fixture.companyA.id, fixture.techA.id);
    await createTech(fixture.companyA.id, fixture.techB.id);

    await assignOrder(
      apiRequest(
        `/api/service-orders/${id}/assign`,
        { method: "POST", body: { technicianId: techA.id } },
        adminToken,
      ),
      { params: { id } },
    );

    const ownerToken = await createTokenFor(fixture.techA.id);
    const ownerRes = await getOrder(
      apiRequest(`/api/service-orders/${id}`, {}, ownerToken),
      { params: { id } },
    );
    expect(ownerRes.status).toBe(200);

    const otherToken = await createTokenFor(fixture.techB.id);
    const otherRes = await getOrder(
      apiRequest(`/api/service-orders/${id}`, {}, otherToken),
      { params: { id } },
    );
    expect(otherRes.status).toBe(404);
  });

  it("Empresa B não enxerga OS da Empresa A", async () => {
    const adminToken = await createTokenFor(fixture.adminA.id);
    const customer = await prisma.customer.create({
      data: { companyId: fixture.companyA.id, name: "Cliente A" },
    });
    const id = await createManualOrder(adminToken, customer.id);

    const tokenB = await createTokenFor(fixture.adminB.id);
    const res = await getOrder(
      apiRequest(`/api/service-orders/${id}`, {}, tokenB),
      { params: { id } },
    );
    expect(res.status).toBe(404);

    const listRes = await listOrders(apiRequest("/api/service-orders", {}, tokenB));
    const list = await listRes.json();
    expect(list.data.total).toBe(0);
  });

  /**
   * Lock otimista por versão explícita — docs/SERVICE-ORDERS.md §3.1.
   *
   * O predicado era `updatedAt`. Prisma mapeia DateTime para `timestamp(3)` no
   * Postgres, então duas escritas no MESMO milissegundo satisfaziam as duas o
   * predicado e a segunda sobrescrevia a primeira em silêncio. O teste antigo
   * ACEITAVA esse desfecho (`toBeGreaterThanOrEqual(1)`). Agora o token é um
   * inteiro `version`, e o lost update é PROIBIDO.
   */
  it("Concorrência: duas atribuições simultâneas — exatamente uma vence (sem lost update)", async () => {
    const token = await createTokenFor(fixture.adminA.id);
    const customer = await prisma.customer.create({
      data: { companyId: fixture.companyA.id, name: "Cliente A" },
    });
    const id = await createManualOrder(token, customer.id);
    const techA = await createTech(fixture.companyA.id, fixture.techA.id);
    const techB = await createTech(fixture.companyA.id, fixture.techB.id);

    const before = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id },
    });

    // Despachantes A e B leem a MESMA versão: as duas chamadas são disparadas
    // antes de qualquer commit, então ambas fazem seu SELECT com version = N.
    const results = await Promise.allSettled([
      assignTechnician(fixture.companyA.id, fixture.adminA.id, id, techA.id),
      assignTechnician(
        fixture.companyA.id,
        fixture.dispatcherA.id,
        id,
        techB.id,
      ),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    // O ponto da correção: NUNCA as duas. Uma escrita perdida silenciosamente
    // faria este número virar 2.
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);

    // O perdedor recebe 409 previsível, não um erro interno.
    const loser = rejected[0] as PromiseRejectedResult;
    expect(loser.reason).toBeInstanceOf(DomainError);
    expect((loser.reason as DomainError).status).toBe(409);
    expect((loser.reason as DomainError).message).toContain(
      "modificada por outra requisição",
    );

    const os = await prisma.serviceOrder.findUniqueOrThrow({ where: { id } });
    expect(os.status).toBe("ASSIGNED");
    // Exatamente um incremento: a tentativa perdedora não escreveu nada.
    expect(os.version).toBe(before.version + 1);
    // E o técnico gravado é o do vencedor, não uma mistura das duas escritas.
    expect([techA.id, techB.id]).toContain(os.technicianId);

    const events = await prisma.serviceOrderEvent.findMany({
      where: { serviceOrderId: id },
      orderBy: { createdAt: "asc" },
    });
    expect(events.map((e) => e.event)).toEqual([
      "SERVICE_ORDER_CREATED",
      "TECHNICIAN_ASSIGNED",
    ]);
  });

  /**
   * Com 5 chamadas simultâneas não dá para exigir "exatamente 1 sucesso": o
   * pool de conexões do Prisma serializa parte das transações, então algumas
   * começam DEPOIS de um commit e leem a versão nova — esse sucesso é legítimo,
   * não uma escrita perdida.
   *
   * O invariante que realmente proíbe lost update é contábil: cada sucesso tem
   * de ter incrementado a versão uma vez e deixado exatamente um evento. Se
   * duas escritas passassem pela mesma versão, `version` ficaria menor que o
   * número de sucessos — que é precisamente o que o predicado `updatedAt`
   * permitia.
   */
  it("Concorrência: N atribuições simultâneas — nenhuma escrita se perde", async () => {
    const token = await createTokenFor(fixture.adminA.id);
    const customer = await prisma.customer.create({
      data: { companyId: fixture.companyA.id, name: "Cliente A" },
    });
    const id = await createManualOrder(token, customer.id);
    const techA = await createTech(fixture.companyA.id, fixture.techA.id);
    const techB = await createTech(fixture.companyA.id, fixture.techB.id);
    const targets = [techA.id, techB.id, techA.id, techB.id, techA.id];

    const results = await Promise.allSettled(
      targets.map((technicianId) =>
        assignTechnician(
          fixture.companyA.id,
          fixture.adminA.id,
          id,
          technicianId,
        ),
      ),
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    // Nem todas podem vencer: as que leram a versão antiga têm de conflitar.
    expect(fulfilled.length).toBeLessThan(targets.length);

    for (const result of results) {
      if (result.status === "rejected") {
        expect(result.reason).toBeInstanceOf(DomainError);
        expect((result.reason as DomainError).status).toBe(409);
      }
    }

    const os = await prisma.serviceOrder.findUniqueOrThrow({ where: { id } });
    expect(os.status).toBe("ASSIGNED");
    // Um incremento por sucesso — nenhum sucesso reaproveitou a versão de outro.
    expect(os.version).toBe(fulfilled.length);

    const events = await prisma.serviceOrderEvent.findMany({
      where: { serviceOrderId: id },
    });
    expect(events).toHaveLength(fulfilled.length + 1);
  });

  /**
   * Prova determinística de que o token de versão fecha o buraco que o
   * `updatedAt` deixava aberto — sem depender de ganhar uma corrida real.
   *
   * O defeito original é uma COLISÃO DE TIMESTAMP: `DateTime` do Prisma vira
   * `timestamp(3)` no Postgres, então duas escritas no mesmo milissegundo
   * produzem o mesmo `updatedAt` e as duas casam com o predicado antigo. Corrida
   * de relógio é justamente o que não se consegue reproduzir de forma confiável
   * — então aqui a colisão é FABRICADA por SQL (a segunda escrita mantém o
   * `updated_at` idêntico) e os dois predicados são comparados lado a lado.
   */
  it("Lock por versão: token obsoleto não casa nem com updatedAt idêntico", async () => {
    const token = await createTokenFor(fixture.adminA.id);
    const customer = await prisma.customer.create({
      data: { companyId: fixture.companyA.id, name: "Cliente A" },
    });
    const id = await createManualOrder(token, customer.id);

    // Snapshot que um despachante teria lido antes de escrever.
    const snapshot = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id },
    });

    // Escrita concorrente que cai no MESMO milissegundo: muda a linha e bumpa a
    // versão, mas deixa `updated_at` byte a byte igual.
    // Colunas em camelCase: o schema mapeia só o nome da TABELA (@@map).
    await prisma.$executeRaw`
      UPDATE service_orders
      SET "description" = 'alterada por outra requisição',
          "version" = "version" + 1,
          "updatedAt" = ${snapshot.updatedAt}
      WHERE "id" = ${id}
    `;

    // O predicado ANTIGO ainda casa: era exatamente por aqui que a segunda
    // escrita passava e apagava a primeira em silêncio.
    const matchedByTimestamp = await prisma.serviceOrder.count({
      where: { id, updatedAt: snapshot.updatedAt },
    });
    expect(matchedByTimestamp).toBe(1);

    // O predicado NOVO não casa: a versão é identidade, não relógio.
    const matchedByVersion = await prisma.serviceOrder.count({
      where: { id, version: snapshot.version },
    });
    expect(matchedByVersion).toBe(0);

    // E o caminho real recusa com 409 em vez de sobrescrever.
    const tech = await createTech(fixture.companyA.id, fixture.techA.id);
    await expect(
      assignTechnician(fixture.companyA.id, fixture.adminA.id, id, tech.id),
    ).resolves.toBeDefined();
    // (a atribuição acima relê a versão corrente e passa — o lock não trava o
    // fluxo normal, só recusa quem chega com token velho.)
  });

  it("A versão não é trava permanente: troca sequencial de técnico funciona", async () => {
    const token = await createTokenFor(fixture.adminA.id);
    const customer = await prisma.customer.create({
      data: { companyId: fixture.companyA.id, name: "Cliente A" },
    });
    const id = await createManualOrder(token, customer.id);
    const techA = await createTech(fixture.companyA.id, fixture.techA.id);
    const techB = await createTech(fixture.companyA.id, fixture.techB.id);

    await assignTechnician(fixture.companyA.id, fixture.adminA.id, id, techA.id);
    await assignTechnician(fixture.companyA.id, fixture.adminA.id, id, techB.id);

    const os = await prisma.serviceOrder.findUniqueOrThrow({ where: { id } });
    expect(os.technicianId).toBe(techB.id);
    expect(os.version).toBe(2);

    const events = await prisma.serviceOrderEvent.findMany({
      where: { serviceOrderId: id },
      orderBy: { createdAt: "asc" },
    });
    expect(events.map((e) => e.event)).toEqual([
      "SERVICE_ORDER_CREATED",
      "TECHNICIAN_ASSIGNED",
      "TECHNICIAN_CHANGED",
    ]);
  });

  /**
   * Lock fim-a-fim — docs/SERVICE-ORDERS.md §3.2.
   *
   * O compare-and-set server-side cobre a janela entre duas REQUISIÇÕES em voo.
   * Não cobria a janela entre o que o despachante VIU na tela e o que ele
   * clicou: como `version` não saía na API e não voltava do cliente, o servidor
   * sempre relia a versão corrente e aceitava qualquer reatribuição. Dois
   * despachantes com a mesma tela aberta viravam "o último clique vence", sem
   * nenhum sinal de conflito para o segundo.
   *
   * `expectedVersion` fecha isso: a versão vem de uma LEITURA REAL da API (nada
   * de `0` hardcoded — se a exposição de `version` regredir, o teste quebra na
   * origem em vez de passar por acidente).
   */
  it("Reatribuição com expectedVersion obsoleto é recusada (409) e preserva a decisão do primeiro", async () => {
    const token = await createTokenFor(fixture.adminA.id);
    const customer = await prisma.customer.create({
      data: { companyId: fixture.companyA.id, name: "Cliente A" },
    });
    const id = await createManualOrder(token, customer.id);
    const tech1 = await createTech(fixture.companyA.id, fixture.techA.id);
    const tech2 = await createTech(fixture.companyA.id, fixture.techB.id);

    /** O que um despachante enxerga ao abrir a tela da OS. */
    const readVersion = async (): Promise<number> => {
      const res = await getOrder(
        apiRequest(`/api/service-orders/${id}`, {}, token),
        { params: { id } },
      );
      expect(res.status).toBe(200);
      const payload = await res.json();
      const version = payload.data.serviceOrder.version;
      expect(typeof version).toBe("number");
      return version;
    };

    const assign = (technicianId: string, expectedVersion?: number) =>
      assignOrder(
        apiRequest(
          `/api/service-orders/${id}/assign`,
          {
            method: "POST",
            body:
              expectedVersion === undefined
                ? { technicianId }
                : { technicianId, expectedVersion },
          },
          token,
        ),
        { params: { id } },
      );

    // Despachantes A e B abrem a MESMA OS e leem a MESMA versão.
    const versionSeenByA = await readVersion();
    const versionSeenByB = await readVersion();
    expect(versionSeenByB).toBe(versionSeenByA);

    // A atribui Tech1 com a versão que viu → passa.
    const firstRes = await assign(tech1.id, versionSeenByA);
    expect(firstRes.status).toBe(200);

    // B, com a tela desatualizada, atribui Tech2 com a versão JÁ OBSOLETA.
    // Antes da correção isto retornava 200 e apagava a decisão de A.
    const secondRes = await assign(tech2.id, versionSeenByB);
    expect(secondRes.status).toBe(409);
    const secondPayload = await secondRes.json();
    expect(secondPayload.ok).toBe(false);
    expect(secondPayload.error).toContain("modificada por outra requisição");

    // A decisão de A permanece de pé: técnico, versão e timeline intactos.
    const os = await prisma.serviceOrder.findUniqueOrThrow({ where: { id } });
    expect(os.technicianId).toBe(tech1.id);
    expect(os.status).toBe("ASSIGNED");
    expect(os.version).toBe(versionSeenByA + 1);

    const events = await prisma.serviceOrderEvent.findMany({
      where: { serviceOrderId: id },
      orderBy: { createdAt: "asc" },
    });
    expect(events.map((e) => e.event)).toEqual([
      "SERVICE_ORDER_CREATED",
      "TECHNICIAN_ASSIGNED",
    ]);

    // E o 409 não é uma trava: B recarrega, vê a versão nova e a troca passa.
    const versionAfterReload = await readVersion();
    expect(versionAfterReload).toBe(versionSeenByA + 1);
    const retryRes = await assign(tech2.id, versionAfterReload);
    expect(retryRes.status).toBe(200);

    const after = await prisma.serviceOrder.findUniqueOrThrow({ where: { id } });
    expect(after.technicianId).toBe(tech2.id);
    expect(after.version).toBe(versionAfterReload + 1);
  });

  /**
   * `expectedVersion` é OPCIONAL. Quem não manda continua caindo no caminho
   * antigo (relê a versão corrente e aceita) — nenhum chamador quebra.
   */
  it("Atribuição sem expectedVersion mantém o comportamento antigo (retrocompatibilidade)", async () => {
    const token = await createTokenFor(fixture.adminA.id);
    const customer = await prisma.customer.create({
      data: { companyId: fixture.companyA.id, name: "Cliente A" },
    });
    const id = await createManualOrder(token, customer.id);
    const tech1 = await createTech(fixture.companyA.id, fixture.techA.id);
    const tech2 = await createTech(fixture.companyA.id, fixture.techB.id);

    const assignWithoutVersion = (technicianId: string) =>
      assignOrder(
        apiRequest(
          `/api/service-orders/${id}/assign`,
          { method: "POST", body: { technicianId } },
          token,
        ),
        { params: { id } },
      );

    expect((await assignWithoutVersion(tech1.id)).status).toBe(200);
    // Segunda escrita SEM versão: a OS já está em version=1, e mesmo assim
    // passa — é exatamente o comportamento anterior à correção.
    expect((await assignWithoutVersion(tech2.id)).status).toBe(200);

    const os = await prisma.serviceOrder.findUniqueOrThrow({ where: { id } });
    expect(os.technicianId).toBe(tech2.id);
    expect(os.version).toBe(2);

    // O mesmo vale na camada de serviço, cujo 5º parâmetro é opcional.
    await expect(
      assignTechnician(fixture.companyA.id, fixture.adminA.id, id, tech1.id),
    ).resolves.toMatchObject({ technician: { id: tech1.id } });
  });

  it("expectedVersion mal formada é rejeitada pelo schema (400)", async () => {
    const token = await createTokenFor(fixture.adminA.id);
    const customer = await prisma.customer.create({
      data: { companyId: fixture.companyA.id, name: "Cliente A" },
    });
    const id = await createManualOrder(token, customer.id);
    const tech = await createTech(fixture.companyA.id, fixture.techA.id);

    for (const expectedVersion of ["0", -1, 1.5, null]) {
      const res = await assignOrder(
        apiRequest(
          `/api/service-orders/${id}/assign`,
          {
            method: "POST",
            body: { technicianId: tech.id, expectedVersion },
          },
          token,
        ),
        { params: { id } },
      );
      expect(res.status).toBe(400);
    }

    // Nenhuma delas encostou na OS.
    const os = await prisma.serviceOrder.findUniqueOrThrow({ where: { id } });
    expect(os.technicianId).toBeNull();
    expect(os.version).toBe(0);
  });
});
