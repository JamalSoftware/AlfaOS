import { describe, it, expect, beforeEach } from "vitest";
import { GET as orderDetailRoute } from "@/app/api/service-orders/[id]/route";
import { prisma } from "@/lib/prisma";
import {
  applyImportedCustomerLocation,
  confirmCustomerLocation,
} from "@/lib/customer-locations";
import { getCompanyServiceOrder, startServiceOrder } from "@/lib/service-orders";
import {
  allocateTestServiceOrderNumber,
  apiRequest,
  createTokenFor,
  seedTestData,
  type TestFixture,
} from "./helpers";

/**
 * # RC-1C — a posição do aparelho fica no servidor
 *
 * A confirmação registra DE ONDE o técnico confirmou — é o contrato do dono —,
 * e esse registro mora no `metadata` do evento `LOCATION_CONFIRMED`. Mas a
 * leitura da OS (`GET /api/service-orders/:id`, e a resposta da conclusão)
 * devolve a lista de eventos com o `metadata` inteiro, para ADMIN, DISPATCHER e
 * o técnico dono. Sem uma poda na saída, a posição do técnico naquele instante
 * viajaria em toda leitura da OS.
 *
 * O check-in, que é o precedente, nunca pôs coordenada no evento: ela vive na
 * linha própria, e o evento leva só distância e precisão. Aqui a coordenada fica
 * gravada e é a SAÍDA que a omite — a distância continua saindo.
 */

let fixture: TestFixture;

beforeEach(async () => {
  fixture = await seedTestData();
});

const EARTH_RADIUS_M = 6_371_008.8;
const P = { latitude: -20.3155, longitude: -40.3128 };
const O = {
  latitude: P.latitude + ((30 / EARTH_RADIUS_M) * 180) / Math.PI,
  longitude: P.longitude,
};

async function confirmada() {
  const companyId = fixture.companyA.id;
  const technician = await prisma.technician.upsert({
    where: { userId: fixture.techA.id },
    update: {},
    create: { companyId, userId: fixture.techA.id },
  });
  const customer = await prisma.customer.create({
    data: { companyId, name: "Cliente QA Privacidade", city: "Cidade Teste" },
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
  await confirmCustomerLocation(companyId, fixture.techA.id, order.id, {
    expectedVersion: location.version,
    observedLatitude: O.latitude,
    observedLongitude: O.longitude,
    observedAccuracyMeters: 11,
  });
  return { order };
}

describe("a posição do aparelho não sai na leitura da OS", () => {
  it("gravada no evento — é o registro que o contrato pede", async () => {
    const { order } = await confirmada();
    const evento = await prisma.serviceOrderEvent.findFirstOrThrow({
      where: { serviceOrderId: order.id, event: "LOCATION_CONFIRMED" },
    });
    const meta = evento.metadata as Record<string, unknown>;
    expect(meta.observedLatitude).toBeCloseTo(O.latitude, 7);
  });

  it("getCompanyServiceOrder devolve o evento com a distância e SEM a posição", async () => {
    const { order } = await confirmada();
    const detalhe = await getCompanyServiceOrder(fixture.companyA.id, order.id);
    const evento = detalhe!.events.find((e) => e.event === "LOCATION_CONFIRMED")!;
    const meta = evento.metadata as Record<string, unknown>;
    expect(meta.distanceMeters).toBe(30);
    expect(meta.accuracyMeters).toBe(11);
    expect(meta).not.toHaveProperty("observedLatitude");
    expect(meta).not.toHaveProperty("observedLongitude");
  });

  it.each([
    ["ADMIN", () => fixture.adminA.id],
    ["DISPATCHER", () => fixture.dispatcherA.id],
    ["TECHNICIAN dono", () => fixture.techA.id],
  ])("GET /api/service-orders/:id para %s não carrega a posição do aparelho", async (_perfil, quem) => {
    const { order } = await confirmada();
    const token = await createTokenFor(quem());
    const res = await orderDetailRoute(apiRequest(`/api/service-orders/${order.id}`, {}, token), {
      params: { id: order.id },
    });
    expect(res.status).toBe(200);
    const texto = await res.text();
    expect(texto).toContain("LOCATION_CONFIRMED");
    expect(texto).not.toContain("observedLatitude");
    expect(texto).not.toContain("observedLongitude");
    expect(texto).not.toContain(O.latitude.toFixed(6));
  });
});
