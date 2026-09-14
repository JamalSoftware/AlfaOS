import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  applyImportedCustomerLocation,
  confirmCustomerLocation,
  correctCustomerLocation,
} from "@/lib/customer-locations";
import { getCustomerTimeline } from "@/lib/customer-timeline";
import { presentTimelineItem } from "@/lib/customer-timeline-presentation";
import { startServiceOrder } from "@/lib/service-orders";
import {
  allocateTestServiceOrderNumber,
  seedTestData,
  type TestFixture,
} from "./helpers";

/**
 * # RC-LOC-02 — a timeline do cliente diz A QUE DISTÂNCIA se confirmou
 *
 * Antes da RC-1C a linha dizia "Localização confirmada em campo" e nada mais —
 * inclusive para o caso que originou a fase, confirmado a ~2,3 km. O dono pediu
 * contexto humano: "Confirmada a 32 m do ponto cadastrado." Nunca a coordenada.
 *
 * A distância vem do registro TIPADO da confirmação (o evento
 * `LOCATION_CONFIRMED`, gravado na mesma transação), e não da nota da linha de
 * histórico: a timeline não faz parsing de frase (TL-1).
 */

let fixture: TestFixture;

beforeEach(async () => {
  fixture = await seedTestData();
});

const EARTH_RADIUS_M = 6_371_008.8;
const P = { latitude: -20.3155, longitude: -40.3128 };
const aNorte = (metros: number) => ({
  latitude: P.latitude + ((metros / EARTH_RADIUS_M) * 180) / Math.PI,
  longitude: P.longitude,
});

async function atendimento() {
  const companyId = fixture.companyA.id;
  const technician = await prisma.technician.upsert({
    where: { userId: fixture.techA.id },
    update: {},
    create: { companyId, userId: fixture.techA.id },
  });
  const customer = await prisma.customer.create({
    data: { companyId, name: "Cliente QA Timeline Localização", city: "Cidade Teste" },
  });
  await prisma.$transaction((tx) => applyImportedCustomerLocation(tx, companyId, customer.id, P));
  const order = await prisma.serviceOrder.create({
    data: {
      companyId,
      number: await allocateTestServiceOrderNumber(companyId),
      customerId: customer.id,
      technicianId: technician.id,
      type: "Instalação",
      description: "OS de fixture.",
      status: "ASSIGNED",
      assignedAt: new Date(),
    },
  });
  await startServiceOrder(companyId, fixture.techA.id, order.id, order.version);
  const location = await prisma.customerLocation.findUniqueOrThrow({
    where: { customerId: customer.id },
  });
  return { companyId, technician, customer, order, location };
}

async function linhaDeConfirmacao(customerId: string) {
  const timeline = await getCustomerTimeline(
    { companyId: fixture.companyA.id, profile: "ADMIN" },
    customerId,
  );
  const item = timeline.items.find((i) => i.kind === "LOCATION_CONFIRMED");
  expect(item, "a confirmação deveria estar na timeline").toBeDefined();
  return { item: item!, timeline };
}

/**
 * Uma confirmação ANTIGA, como o escritor anterior à RC-1C a gravava: a linha
 * de histórico com a assinatura de confirmação e o evento com a distância
 * (ou `null`, sem GPS). Existem no banco real — o caso que originou a fase é
 * uma delas —, e a timeline precisa contá-las com honestidade.
 */
async function confirmacaoAntiga(
  s: Awaited<ReturnType<typeof atendimento>>,
  distanceMeters: number | null,
) {
  const agora = new Date();
  await prisma.customerLocationHistory.create({
    data: {
      companyId: s.companyId,
      customerId: s.customer.id,
      serviceOrderId: s.order.id,
      kind: "COORDINATES",
      reason: "OTHER",
      note: "Localização confirmada em campo.",
      previousLatitude: s.location.latitude,
      previousLongitude: s.location.longitude,
      previousSource: "IMPORTED",
      previousVerified: false,
      newLatitude: s.location.latitude,
      newLongitude: s.location.longitude,
      newSource: "IMPORTED",
      newVerified: true,
      changedByUserId: fixture.techA.id,
      technicianId: s.technician.id,
      createdAt: agora,
    },
  });
  await prisma.serviceOrderEvent.create({
    data: {
      companyId: s.companyId,
      serviceOrderId: s.order.id,
      userId: fixture.techA.id,
      event: "LOCATION_CONFIRMED",
      metadata: { technicianId: s.technician.id, distanceMeters, accuracyMeters: null, source: "IMPORTED" },
      createdAt: agora,
    },
  });
}

describe("RC-LOC-02 — distância da confirmação na timeline do cliente", () => {
  it("confirmação medida: 'Confirmada a 32 m do ponto cadastrado.'", async () => {
    const s = await atendimento();
    const o = aNorte(32);
    await confirmCustomerLocation(s.companyId, fixture.techA.id, s.order.id, {
      expectedVersion: s.location.version,
      observedLatitude: o.latitude,
      observedLongitude: o.longitude,
      observedAccuracyMeters: 11,
    });

    const { item } = await linhaDeConfirmacao(s.customer.id);
    const p = presentTimelineItem(item);
    expect(p.title).toBe("Localização confirmada em campo");
    expect(p.description).toBe("Confirmada a 32 m do ponto cadastrado.");
  });

  it("confirmação ANTIGA a ~2,3 km: a discrepância aparece, com o limite atual", async () => {
    const s = await atendimento();
    await confirmacaoAntiga(s, 2357);
    const { item } = await linhaDeConfirmacao(s.customer.id);
    expect(presentTimelineItem(item).description).toBe(
      "Confirmada a 2,36 km do ponto cadastrado, acima do limite de 100 m.",
    );
  });

  it("confirmação ANTIGA sem GPS: diz que foi sem a posição do aparelho", async () => {
    const s = await atendimento();
    await confirmacaoAntiga(s, null);
    const { item } = await linhaDeConfirmacao(s.customer.id);
    expect(presentTimelineItem(item).description).toBe("Confirmada sem a posição do aparelho.");
  });

  it("nenhuma coordenada — nem a do ponto, nem a do aparelho — sai na timeline", async () => {
    const s = await atendimento();
    const o = aNorte(47);
    await confirmCustomerLocation(s.companyId, fixture.techA.id, s.order.id, {
      expectedVersion: s.location.version,
      observedLatitude: o.latitude,
      observedLongitude: o.longitude,
    });
    const { timeline } = await linhaDeConfirmacao(s.customer.id);
    const texto = JSON.stringify(timeline.items.map((i) => ({ i, p: presentTimelineItem(i) })));
    expect(texto).not.toContain("20.31");
    expect(texto).not.toContain("40.31");
    expect(texto).not.toContain(String(o.latitude).slice(0, 8));
  });

  it("a correção continua 'Localização corrigida' com o motivo — sem distância", async () => {
    const s = await atendimento();
    await correctCustomerLocation(s.companyId, fixture.techA.id, s.order.id, {
      expectedVersion: s.location.version,
      reason: "CUSTOMER_MOVED",
      latitude: aNorte(400).latitude,
      longitude: P.longitude,
      source: "TECHNICIAN_GPS",
    });
    const timeline = await getCustomerTimeline(
      { companyId: fixture.companyA.id, profile: "ADMIN" },
      s.customer.id,
    );
    const item = timeline.items.find((i) => i.kind === "LOCATION_CORRECTED")!;
    const p = presentTimelineItem(item);
    expect(p.title).toBe("Localização corrigida");
    expect(p.description).toBe("Cliente mudou de endereço");
  });

  it("um evento de OUTRA empresa apontando para a OS não fornece a distância", async () => {
    const s = await atendimento();
    const o = aNorte(32);
    await confirmCustomerLocation(s.companyId, fixture.techA.id, s.order.id, {
      expectedVersion: s.location.version,
      observedLatitude: o.latitude,
      observedLongitude: o.longitude,
    });
    const linha = await prisma.customerLocationHistory.findFirstOrThrow({
      where: { customerId: s.customer.id },
    });
    // O evento verdadeiro fica 2 s depois da linha; o hostil, no MESMO instante
    // dela. Sem o tenant no predicado, o mais próximo — o hostil — venceria.
    await prisma.serviceOrderEvent.updateMany({
      where: { serviceOrderId: s.order.id, event: "LOCATION_CONFIRMED" },
      data: { createdAt: new Date(linha.createdAt.getTime() + 2000) },
    });
    await prisma.serviceOrderEvent.create({
      data: {
        companyId: fixture.companyB.id,
        serviceOrderId: s.order.id,
        event: "LOCATION_CONFIRMED",
        metadata: { distanceMeters: 5 },
        createdAt: linha.createdAt,
      },
    });

    const { item } = await linhaDeConfirmacao(s.customer.id);
    expect(presentTimelineItem(item).description).toBe("Confirmada a 32 m do ponto cadastrado.");
  });
});
