import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  assignTechnician,
  createManualServiceOrder,
  startServiceOrder,
} from "@/lib/service-orders";
import { putChecklistTemplate } from "@/lib/checklists";
import { confirmCustomerLocation, correctCustomerLocation } from "@/lib/customer-locations";
import { DomainError } from "@/lib/errors";
import { allocateTestServiceOrderNumber, seedTestData, type TestFixture } from "./helpers";

/**
 * RC-DB-01 / RC-TEN-01 — id válido de outra empresa não atravessa o tenant.
 *
 * O schema isola empresa por FK SIMPLES: `ServiceOrder.customerId`,
 * `ServiceOrder.technicianId` e `Technician.userId` aceitam, no banco, apontar
 * para uma linha de outra empresa (o vetor que a `DQ-7.1` explorou). Quem
 * segura é a aplicação — com o `companyId` da SESSÃO dentro do predicado,
 * inclusive nas buscas por relação. Estes testes atacam os pontos que o RC-1A
 * apontou, com controle positivo em cada um.
 */

let fixture: TestFixture;

beforeEach(async () => {
  fixture = await seedTestData();
});

async function tecnico(userId: string, companyId: string) {
  return prisma.technician.upsert({
    where: { userId },
    update: {},
    create: { companyId, userId },
  });
}

/** Um técnico de verdade na EMPRESA B — o fixture só traz técnicos da A. */
async function tecnicoDaEmpresaB() {
  const user = await prisma.user.create({
    data: {
      companyId: fixture.companyB.id,
      name: "Tecnico Empresa B",
      email: "tech@empresab.test",
      profile: "TECHNICIAN",
      passwordHash: "x",
    },
  });
  const tech = await tecnico(user.id, fixture.companyB.id);
  return { user, tech };
}

async function osPendenteNaA(nome = "Cliente A") {
  const customer = await prisma.customer.create({
    data: { companyId: fixture.companyA.id, name: nome },
  });
  const order = await prisma.serviceOrder.create({
    data: {
      companyId: fixture.companyA.id,
      number: await allocateTestServiceOrderNumber(fixture.companyA.id),
      customerId: customer.id,
      type: "Reparo",
      description: "Teste de tenancy.",
      status: "PENDING",
    },
  });
  return { customer, order };
}

async function versao(orderId: string) {
  return (await prisma.serviceOrder.findUniqueOrThrow({ where: { id: orderId } })).version;
}

async function eventoDeTroca(orderId: string) {
  return prisma.serviceOrderEvent.findFirstOrThrow({
    where: { serviceOrderId: orderId, event: "TECHNICIAN_CHANGED" },
    orderBy: { createdAt: "desc" },
  });
}

async function statusDoErro(p: Promise<unknown>): Promise<number> {
  try {
    await p;
  } catch (e) {
    if (e instanceof DomainError) return e.status;
    throw e;
  }
  throw new Error("esperava um DomainError");
}

describe("RC-TEN-01 — o técnico ANTERIOR da reatribuição é lido dentro do tenant", () => {
  it("controle positivo: reatribuir A1 → A2 registra quem era o anterior", async () => {
    const a1 = await tecnico(fixture.techA.id, fixture.companyA.id);
    const a2 = await tecnico(fixture.techB.id, fixture.companyA.id);
    const { order } = await osPendenteNaA();

    await assignTechnician(fixture.companyA.id, fixture.adminA.id, order.id, a1.id, await versao(order.id));
    await assignTechnician(fixture.companyA.id, fixture.adminA.id, order.id, a2.id, await versao(order.id));

    const meta = (await eventoDeTroca(order.id)).metadata as Record<string, unknown>;
    expect(meta.previousTechnicianId).toBe(a1.id);
    expect(meta.previousTechnicianName).toBe("Tecnico Alfa");
  });

  it("linha corrompida apontando para técnico da empresa B: o nome dele NÃO entra no evento da A", async () => {
    const a1 = await tecnico(fixture.techA.id, fixture.companyA.id);
    const a2 = await tecnico(fixture.techB.id, fixture.companyA.id);
    const { tech: b } = await tecnicoDaEmpresaB();
    const { order } = await osPendenteNaA();
    await assignTechnician(fixture.companyA.id, fixture.adminA.id, order.id, a1.id, await versao(order.id));

    // O vetor da DQ-7.1: FK simples, nenhuma constraint (companyId, technicianId).
    await prisma.serviceOrder.update({ where: { id: order.id }, data: { technicianId: b.id } });

    await assignTechnician(fixture.companyA.id, fixture.adminA.id, order.id, a2.id, await versao(order.id));

    const evento = await eventoDeTroca(order.id);
    expect(evento.companyId).toBe(fixture.companyA.id);
    const meta = evento.metadata as Record<string, unknown>;
    expect(meta.previousTechnicianName).not.toBe("Tecnico Empresa B");
    expect(meta.previousTechnicianId).not.toBe(b.id);
    expect(JSON.stringify(meta)).not.toContain("Tecnico Empresa B");
    // O que a A pediu aconteceu: a OS é do A2.
    expect((await prisma.serviceOrder.findUniqueOrThrow({ where: { id: order.id } })).technicianId).toBe(a2.id);
  });
});

describe("RC-DB-01 — ids válidos de outra empresa, pelas portas de escrita", () => {
  it("criar OS na A com o cliente da B: 404, e nenhuma OS nasce em lugar nenhum", async () => {
    const tipoA = await prisma.serviceOrderType.create({
      data: { companyId: fixture.companyA.id, name: "Tipo Tenancy A" },
    });
    const clienteB = await prisma.customer.create({
      data: { companyId: fixture.companyB.id, name: "Cliente da B" },
    });

    const status = await statusDoErro(
      createManualServiceOrder(fixture.companyA.id, fixture.adminA.id, {
        customerId: clienteB.id,
        typeId: tipoA.id,
        description: "Tentativa cruzada.",
        priority: "NORMAL",
      }),
    );
    expect(status).toBe(404);
    expect(await prisma.serviceOrder.count()).toBe(0);
  });

  it("controle positivo: com o cliente da própria empresa, a OS nasce", async () => {
    const tipoA = await prisma.serviceOrderType.create({
      data: { companyId: fixture.companyA.id, name: "Tipo Tenancy A" },
    });
    const clienteA = await prisma.customer.create({
      data: { companyId: fixture.companyA.id, name: "Cliente da A" },
    });
    const os = await createManualServiceOrder(fixture.companyA.id, fixture.adminA.id, {
      customerId: clienteA.id,
      typeId: tipoA.id,
      description: "Legítima.",
      priority: "NORMAL",
    });
    expect(os.id).toBeTruthy();
  });

  it("template de checklist da A para o TIPO da B: 404, e nenhum template nasce", async () => {
    const tipoB = await prisma.serviceOrderType.create({
      data: { companyId: fixture.companyB.id, name: "Tipo da B" },
    });
    const status = await statusDoErro(
      putChecklistTemplate(fixture.companyA.id, fixture.adminA.id, {
        serviceOrderTypeId: tipoB.id,
        name: "Checklist cruzado",
        items: [{ label: "Item", type: "BOOLEAN", required: true }],
      }),
    );
    expect(status).toBe(404);
    expect(await prisma.checklistTemplate.count()).toBe(0);

    // Controle positivo: com o tipo da própria empresa, o template nasce.
    const tipoA = await prisma.serviceOrderType.create({
      data: { companyId: fixture.companyA.id, name: "Tipo da A" },
    });
    await putChecklistTemplate(fixture.companyA.id, fixture.adminA.id, {
      serviceOrderTypeId: tipoA.id,
      name: "Checklist da A",
      items: [{ label: "Item", type: "BOOLEAN", required: true }],
    });
    expect(await prisma.checklistTemplate.count({ where: { companyId: fixture.companyA.id } })).toBe(1);
  });
});

describe("localização — confirmação e correção por quem não é o dono (lacuna do RC-1A)", () => {
  async function atendimentoComPonto() {
    const dono = await tecnico(fixture.techA.id, fixture.companyA.id);
    await tecnico(fixture.techB.id, fixture.companyA.id);
    const { customer, order } = await osPendenteNaA("Cliente Localização");
    const location = await prisma.customerLocation.create({
      data: {
        companyId: fixture.companyA.id,
        customerId: customer.id,
        latitude: -20.3,
        longitude: -40.3,
        source: "IMPORTED",
        verified: false,
      },
    });
    await assignTechnician(fixture.companyA.id, fixture.adminA.id, order.id, dono.id, await versao(order.id));
    return { order, location, customer };
  }

  it("OS ainda ATRIBUÍDA (não iniciada): confirmar e corrigir são recusados (409)", async () => {
    const { order, location } = await atendimentoComPonto();
    expect(
      await statusDoErro(
        confirmCustomerLocation(fixture.companyA.id, fixture.techA.id, order.id, {
          expectedVersion: location.version,
        }),
      ),
    ).toBe(409);
    expect(
      await statusDoErro(
        correctCustomerLocation(fixture.companyA.id, fixture.techA.id, order.id, {
          expectedVersion: location.version,
          reason: "INCORRECT_LOCATION",
          latitude: -20.31,
          longitude: -40.31,
        }),
      ),
    ).toBe(409);
    const intacta = await prisma.customerLocation.findUniqueOrThrow({ where: { id: location.id } });
    expect(intacta.verified).toBe(false);
    expect(intacta.version).toBe(location.version);
  });

  it("técnico da MESMA empresa que não é o dono: confirmar é 404, e nada muda", async () => {
    const { order, location } = await atendimentoComPonto();
    await startServiceOrder(fixture.companyA.id, fixture.techA.id, order.id, await versao(order.id));

    expect(
      await statusDoErro(
        confirmCustomerLocation(fixture.companyA.id, fixture.techB.id, order.id, {
          expectedVersion: location.version,
        }),
      ),
    ).toBe(404);
    expect(
      (await prisma.customerLocation.findUniqueOrThrow({ where: { id: location.id } })).verified,
    ).toBe(false);
  });

  it("técnico da EMPRESA B com o id da OS da A: confirmar é 404, e nada muda", async () => {
    const { order, location } = await atendimentoComPonto();
    await startServiceOrder(fixture.companyA.id, fixture.techA.id, order.id, await versao(order.id));
    const { user: userB } = await tecnicoDaEmpresaB();

    expect(
      await statusDoErro(
        confirmCustomerLocation(fixture.companyB.id, userB.id, order.id, {
          expectedVersion: location.version,
        }),
      ),
    ).toBe(404);
    const intacta = await prisma.customerLocation.findUniqueOrThrow({ where: { id: location.id } });
    expect(intacta.verified).toBe(false);
    expect(await prisma.customerLocationHistory.count()).toBe(0);
  });

  it("controle positivo: o dono, com a OS em atendimento, confirma", async () => {
    const { order, location } = await atendimentoComPonto();
    await startServiceOrder(fixture.companyA.id, fixture.techA.id, order.id, await versao(order.id));
    const r = await confirmCustomerLocation(fixture.companyA.id, fixture.techA.id, order.id, {
      expectedVersion: location.version,
    });
    expect(r.location.verified).toBe(true);
  });
});
