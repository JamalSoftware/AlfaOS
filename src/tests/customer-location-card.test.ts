import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  applyImportedCustomerLocation,
  confirmCustomerLocation,
  correctCustomerLocation,
} from "@/lib/customer-locations";
import { getCustomerLocationCard } from "@/lib/customer-location-card";
import { parseMapViewParams } from "@/lib/map-view-params";
import { startServiceOrder } from "@/lib/service-orders";
import {
  allocateTestServiceOrderNumber,
  seedTestData,
  type TestFixture,
} from "./helpers";

/**
 * # RC-LOC-03 — o cartão "Localização do cliente" na ficha (ADMIN)
 *
 * Somente leitura, e alimentado pela AUTORIDADE (`CustomerLocation`). Responde
 * o que o dono pediu: existe ponto? onde? com que precisão? de onde veio? foi
 * conferido? quando mudou? quem e em que OS? — e "Ver no mapa".
 *
 * A projeção de `Customer` nunca alimenta o cartão. O legado do RC-LOC-04
 * (projeção sem autoridade) aparece como o que ele é: SEM localização, com uma
 * nota — e sem a coordenada antiga.
 */

let fixture: TestFixture;

beforeEach(async () => {
  fixture = await seedTestData();
});

const A = { latitude: -20.3155, longitude: -40.3128 };
const B = { latitude: -20.3105, longitude: -40.3128 };

async function tecnicoA() {
  return prisma.technician.upsert({
    where: { userId: fixture.techA.id },
    update: {},
    create: { companyId: fixture.companyA.id, userId: fixture.techA.id },
  });
}

async function cliente(data: Record<string, unknown> = {}) {
  return prisma.customer.create({
    data: {
      companyId: fixture.companyA.id,
      name: "Cliente QA Cartão",
      address: "Rua QA",
      city: "Cidade Teste",
      ...data,
    },
  });
}

async function comPontoImportado() {
  const c = await cliente();
  await prisma.$transaction((tx) => applyImportedCustomerLocation(tx, fixture.companyA.id, c.id, A));
  return c;
}

async function osEmAtendimento(customerId: string) {
  const technician = await tecnicoA();
  const order = await prisma.serviceOrder.create({
    data: {
      companyId: fixture.companyA.id,
      number: await allocateTestServiceOrderNumber(fixture.companyA.id),
      customerId,
      technicianId: technician.id,
      type: "Reparo",
      description: "OS de fixture.",
      status: "ASSIGNED",
      assignedAt: new Date(),
    },
  });
  await startServiceOrder(fixture.companyA.id, fixture.techA.id, order.id, order.version);
  return { order, technician };
}

async function ligarMapa(ligado = true) {
  await prisma.company.update({
    where: { id: fixture.companyA.id },
    data: { ctoNetworkEnabled: ligado },
  });
}

describe("RC-LOC-03 — o cartão lê a autoridade", () => {
  it("sem CustomerLocation e com endereço: SEM localização, e diz que o endereço existe", async () => {
    const c = await cliente();
    const card = await getCustomerLocationCard(fixture.companyA.id, c.id);
    expect(card).toEqual({ state: "MISSING", hasAddress: true, hasLegacyProjection: false });
  });

  it("sem endereço nenhum: SEM localização, sem afirmar que há endereço", async () => {
    const c = await cliente({ address: null, city: null });
    const card = await getCustomerLocationCard(fixture.companyA.id, c.id);
    expect(card).toMatchObject({ state: "MISSING", hasAddress: false });
  });

  it("legado (projeção sem autoridade): SEM localização, com nota — e a coordenada antiga NÃO sai", async () => {
    const c = await cliente({ latitude: A.latitude, longitude: A.longitude, locationSource: "IMPORTED" });
    const card = await getCustomerLocationCard(fixture.companyA.id, c.id);
    expect(card).toEqual({ state: "MISSING", hasAddress: true, hasLegacyProjection: true });
    expect(JSON.stringify(card)).not.toContain("20.31");
  });

  it("ponto importado: coordenada, origem, não verificada, sem técnico nem OS", async () => {
    const c = await comPontoImportado();
    const card = await getCustomerLocationCard(fixture.companyA.id, c.id);
    expect(card?.state).toBe("PRESENT");
    if (card?.state !== "PRESENT") return;
    expect(card.latitude).toBeCloseTo(A.latitude, 7);
    expect(card.longitude).toBeCloseTo(A.longitude, 7);
    expect(card.accuracyMeters).toBeNull();
    expect(card.source).toBe("IMPORTED");
    expect(card.verified).toBe(false);
    expect(card.technicianName).toBeNull();
    expect(card.order).toBeNull();
    expect(card.updatedAt).toBeInstanceOf(Date);
  });

  it("corrigido com GPS: o ponto novo, a precisão, verificada, o técnico e a OS", async () => {
    const c = await comPontoImportado();
    const { order } = await osEmAtendimento(c.id);
    const antes = await prisma.customerLocation.findUniqueOrThrow({ where: { customerId: c.id } });
    await correctCustomerLocation(fixture.companyA.id, fixture.techA.id, order.id, {
      expectedVersion: antes.version,
      reason: "INCORRECT_LOCATION",
      latitude: B.latitude,
      longitude: B.longitude,
      accuracyMeters: 7,
      source: "TECHNICIAN_GPS",
    });

    const card = await getCustomerLocationCard(fixture.companyA.id, c.id);
    if (card?.state !== "PRESENT") throw new Error("esperava PRESENT");
    expect(card.latitude).toBeCloseTo(B.latitude, 7);
    expect(card.accuracyMeters).toBe(7);
    expect(card.source).toBe("TECHNICIAN_GPS");
    expect(card.verified).toBe(true);
    const tecnico = await prisma.user.findUniqueOrThrow({ where: { id: fixture.techA.id } });
    expect(card.technicianName).toBe(tecnico.name);
    expect(card.order).toEqual({ id: order.id, number: order.number });
  });

  it("confirmado: a origem continua a de antes; técnico e OS são os da confirmação", async () => {
    const c = await comPontoImportado();
    const { order } = await osEmAtendimento(c.id);
    const antes = await prisma.customerLocation.findUniqueOrThrow({ where: { customerId: c.id } });
    await confirmCustomerLocation(fixture.companyA.id, fixture.techA.id, order.id, {
      expectedVersion: antes.version,
      observedLatitude: A.latitude,
      observedLongitude: A.longitude,
    });
    const card = await getCustomerLocationCard(fixture.companyA.id, c.id);
    if (card?.state !== "PRESENT") throw new Error("esperava PRESENT");
    expect(card.source).toBe("IMPORTED");
    expect(card.verified).toBe(true);
    expect(card.order?.id).toBe(order.id);
    expect(card.technicianName).not.toBeNull();
  });

  it("autoridade em A e projeção em B: o cartão mostra A", async () => {
    const c = await comPontoImportado();
    await prisma.customer.update({
      where: { id: c.id },
      data: { latitude: B.latitude, longitude: B.longitude },
    });
    const card = await getCustomerLocationCard(fixture.companyA.id, c.id);
    if (card?.state !== "PRESENT") throw new Error("esperava PRESENT");
    expect(card.latitude).toBeCloseTo(A.latitude, 7);
    expect(card.longitude).toBeCloseTo(A.longitude, 7);
  });
});

describe("RC-LOC-03 — tenant e defesa em profundidade", () => {
  it("empresa B pedindo o cliente da A: nada (null)", async () => {
    const c = await comPontoImportado();
    expect(await getCustomerLocationCard(fixture.companyB.id, c.id)).toBeNull();
  });

  it("técnico verificador de OUTRA empresa (FK simples corrompida): o nome não aparece", async () => {
    const c = await comPontoImportado();
    const userB = await prisma.user.create({
      data: {
        companyId: fixture.companyB.id,
        name: "Nome Da Empresa B",
        email: "tech-card@empresab.test",
        profile: "TECHNICIAN",
        passwordHash: "x",
      },
    });
    const techB = await prisma.technician.create({
      data: { companyId: fixture.companyB.id, userId: userB.id },
    });
    await prisma.customerLocation.update({
      where: { customerId: c.id },
      data: { verified: true, verifiedByTechnicianId: techB.id },
    });
    const card = await getCustomerLocationCard(fixture.companyA.id, c.id);
    if (card?.state !== "PRESENT") throw new Error("esperava PRESENT");
    expect(card.technicianName).toBeNull();
    expect(JSON.stringify(card)).not.toContain("Empresa B");
  });

  it("linha de histórico apontando OS de outra empresa: a OS não aparece", async () => {
    const c = await comPontoImportado();
    const tech = await tecnicoA();
    const clienteB = await prisma.customer.create({
      data: { companyId: fixture.companyB.id, name: "Cliente B" },
    });
    const osB = await prisma.serviceOrder.create({
      data: {
        companyId: fixture.companyB.id,
        number: await allocateTestServiceOrderNumber(fixture.companyB.id),
        customerId: clienteB.id,
        type: "Reparo",
        description: "OS da B.",
        status: "PENDING",
      },
    });
    await prisma.customerLocation.update({
      where: { customerId: c.id },
      data: { verified: true, verifiedByTechnicianId: tech.id },
    });
    await prisma.customerLocationHistory.create({
      data: {
        companyId: fixture.companyA.id,
        customerId: c.id,
        serviceOrderId: osB.id,
        kind: "COORDINATES",
        reason: "INCORRECT_LOCATION",
        technicianId: tech.id,
        changedByUserId: fixture.techA.id,
        newLatitude: A.latitude,
        newLongitude: A.longitude,
        newVerified: true,
      },
    });
    const card = await getCustomerLocationCard(fixture.companyA.id, c.id);
    if (card?.state !== "PRESENT") throw new Error("esperava PRESENT");
    expect(card.order).toBeNull();
  });
});

describe("RC-LOC-03 — Ver no mapa e fuso", () => {
  it("com o Mapa Operacional ligado: o link centraliza no ponto, com a camada de clientes ligada", async () => {
    await ligarMapa(true);
    const c = await comPontoImportado();
    const card = await getCustomerLocationCard(fixture.companyA.id, c.id);
    if (card?.state !== "PRESENT") throw new Error("esperava PRESENT");
    expect(card.mapHref).toMatch(/^\/mapa\?/);
    const vista = parseMapViewParams(
      Object.fromEntries(new URLSearchParams(card.mapHref!.split("?")[1])),
    );
    expect(vista.latitude).toBeCloseTo(A.latitude, 5);
    expect(vista.longitude).toBeCloseTo(A.longitude, 5);
    expect(vista.layers?.CUSTOMERS).toBe(true);
    expect(vista.zoom).toBeGreaterThanOrEqual(17);
  });

  it("sem o módulo de mapa: nenhum link (a página responderia 404)", async () => {
    await ligarMapa(false);
    const c = await comPontoImportado();
    const card = await getCustomerLocationCard(fixture.companyA.id, c.id);
    if (card?.state !== "PRESENT") throw new Error("esperava PRESENT");
    expect(card.mapHref).toBeNull();
  });

  it("o fuso é o da EMPRESA", async () => {
    await prisma.company.update({
      where: { id: fixture.companyA.id },
      data: { timezone: "America/Manaus" },
    });
    const c = await comPontoImportado();
    const card = await getCustomerLocationCard(fixture.companyA.id, c.id);
    if (card?.state !== "PRESENT") throw new Error("esperava PRESENT");
    expect(card.timezone).toBe("America/Manaus");
  });
});
