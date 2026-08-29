import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { DomainError } from "@/lib/errors";
import { LocalFileStorageAdapter, setFileStorage } from "@/lib/storage";
import {
  applyImportedCustomerLocation,
  automaticWriteWins,
  confirmCustomerLocation,
  correctCustomerLocation,
  locationPrecedenceRank,
  normalizeAddressValue,
} from "@/lib/customer-locations";
import { checkInServiceOrder } from "@/lib/service-order-work-events";
import {
  answerChecklistItem,
  getOrderChecklist,
  putChecklistTemplate,
} from "@/lib/checklists";
import {
  consumeInventoryForOrder,
  createInventoryItem,
  getTechnicianStockBalance,
  listTechnicianStock,
  receiveStock,
} from "@/lib/inventory";
import { addServiceOrderEquipment } from "@/lib/service-order-equipment";
import {
  addEvidence,
  completeServiceOrder,
  putSignature,
  removeEvidence,
} from "@/lib/service-order-closing";
import {
  CompletionBlockedError,
  putCompletionPolicy,
} from "@/lib/service-order-completion";
import { startServiceOrder, updateServiceOrderExecution } from "@/lib/service-orders";
import {
  allocateTestServiceOrderNumber,
  seedTestData,
  type TestFixture,
} from "./helpers";

/**
 * # Execução e fechamento em campo (v0.10)
 *
 * Regressões permanentes dos invariantes que a v0.10 introduz. Todas as
 * fixtures são FICTÍCIAS — nenhum nome, telefone, endereço ou credencial real
 * aparece aqui.
 *
 * O que cada bloco existe para impedir está no comentário do próprio bloco: um
 * teste que só descreve o que faz não diz a quem o quebrar por que ele
 * importava.
 */

let fixture: TestFixture;
let storageRoot: string;

beforeAll(async () => {
  storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "alfaos-v010-test-"));
  setFileStorage(new LocalFileStorageAdapter(storageRoot));
});

afterAll(async () => {
  setFileStorage(null);
  await fs.rm(storageRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  fixture = await seedTestData();
});

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 1),
]);

async function expectDomainError(
  run: () => Promise<unknown>,
  status: number,
): Promise<DomainError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).status).toBe(status);
    return error as DomainError;
  }
  throw new Error(`Esperava DomainError ${status}, mas nada foi lançado.`);
}

interface Scenario {
  customerId: string;
  technicianId: string;
  orderId: string;
  orderVersion: number;
  executionVersion: number;
}

/**
 * Uma OS em andamento, do técnico A, com relatório preenchido.
 *
 * `withExecutionText: false` deixa diagnóstico e serviço vazios, para os testes
 * que provam que a conclusão os exige.
 */
async function scenario(
  options: {
    withExecutionText?: boolean;
    typeId?: string | null;
    userId?: string;
    customerId?: string;
  } = {},
): Promise<Scenario> {
  const userId = options.userId ?? fixture.techA.id;
  const customer =
    options.customerId ??
    (
      await prisma.customer.create({
        data: {
          companyId: fixture.companyA.id,
          name: "Cliente Ficticio da Silva",
          address: "Rua das Palmeiras",
          number: "100",
          district: "Centro",
          city: "Cidade Teste",
          state: "SP",
        },
      })
    ).id;

  const technician = await prisma.technician.upsert({
    where: { userId },
    update: {},
    create: { companyId: fixture.companyA.id, userId },
  });

  const order = await prisma.serviceOrder.create({
    data: {
      companyId: fixture.companyA.id,
      number: await allocateTestServiceOrderNumber(fixture.companyA.id),
      customerId: customer,
      technicianId: technician.id,
      type: "Instalação",
      typeId: options.typeId === undefined ? fixture.typeA.id : options.typeId,
      description: "Instalação de fibra (fixture).",
      status: "ASSIGNED",
      assignedAt: new Date(),
    },
  });

  const started = await startServiceOrder(
    fixture.companyA.id,
    userId,
    order.id,
    order.version,
  );

  let executionVersion = started.execution.version;
  if (options.withExecutionText !== false) {
    const saved = await updateServiceOrderExecution(
      fixture.companyA.id,
      userId,
      order.id,
      executionVersion,
      {
        diagnosis: "Atenuação alta no conector.",
        workPerformed: "Conector refeito e testado.",
      },
    );
    executionVersion = saved.version;
  }

  const current = await prisma.serviceOrder.findUniqueOrThrow({
    where: { id: order.id },
    select: { version: true },
  });

  return {
    customerId: customer,
    technicianId: technician.id,
    orderId: order.id,
    orderVersion: current.version,
    executionVersion,
  };
}

/**
 * Garante que o usuário TEM vínculo de técnico na empresa A.
 *
 * Existe por causa de um defeito real encontrado na prova de reversão da posse:
 * sem esta linha, `resolveActingTechnician` recusa com 404 ANTES de a posse ser
 * conferida — e um teste de "não acessa OS alheia" passaria por não haver
 * técnico, não por a posse ser verificada. O teste continuaria verde mesmo com
 * a checagem de posse removida do código.
 *
 * Todo teste de posse chama isto primeiro, para que o 404 esperado só possa vir
 * da comparação de `technicianId`.
 */
async function ensureTechnician(userId: string): Promise<string> {
  const technician = await prisma.technician.upsert({
    where: { userId },
    update: {},
    create: { companyId: fixture.companyA.id, userId },
  });
  return technician.id;
}

async function orderVersionOf(orderId: string): Promise<number> {
  const row = await prisma.serviceOrder.findUniqueOrThrow({
    where: { id: orderId },
    select: { version: true },
  });
  return row.version;
}

// ---------------------------------------------------------------------------
// Precedência de localização
// ---------------------------------------------------------------------------

describe("Precedência de localização (§197)", () => {
  it("verified domina o eixo source, sem exceção", () => {
    // Uma GEOCODED verificada tem de vencer QUALQUER origem não verificada —
    // inclusive a mais forte delas. É o que "verified domina source" quer dizer,
    // e é a propriedade que um bônus pequeno quebraria.
    expect(locationPrecedenceRank("GEOCODED", true)).toBeGreaterThan(
      locationPrecedenceRank("TECHNICIAN_GPS", false),
    );
    expect(locationPrecedenceRank("GEOCODED", true)).toBeGreaterThan(
      locationPrecedenceRank("MANUAL", false),
    );
  });

  it("ordena as origens não verificadas conforme a escada da §197", () => {
    expect(locationPrecedenceRank("MANUAL", false)).toBeGreaterThan(
      locationPrecedenceRank("IMPORTED", false),
    );
    expect(locationPrecedenceRank("IMPORTED", false)).toBeGreaterThan(
      locationPrecedenceRank("GEOCODED", false),
    );
  });

  it("escrita automática nunca vence coordenada verificada", () => {
    for (const source of ["MANUAL", "IMPORTED", "GEOCODED", "TECHNICIAN_GPS"] as const) {
      expect(
        automaticWriteWins(
          { source: "IMPORTED", verified: false },
          { source, verified: true },
        ),
        `IMPORTED não pode sobrescrever ${source} verificada`,
      ).toBe(false);
    }
  });

  it("importação preenche quem não tem coordenada e substitui GEOCODED", () => {
    expect(automaticWriteWins({ source: "IMPORTED", verified: false }, null)).toBe(
      true,
    );
    expect(
      automaticWriteWins(
        { source: "IMPORTED", verified: false },
        { source: "GEOCODED", verified: false },
      ),
    ).toBe(true);
  });

  it("importação NÃO substitui MANUAL nem TECHNICIAN_GPS não verificadas", () => {
    expect(
      automaticWriteWins(
        { source: "IMPORTED", verified: false },
        { source: "MANUAL", verified: false },
      ),
    ).toBe(false);
    expect(
      automaticWriteWins(
        { source: "IMPORTED", verified: false },
        { source: "TECHNICIAN_GPS", verified: false },
      ),
    ).toBe(false);
  });
});

describe("Importação × localização verificada", () => {
  /**
   * O caso concreto da §197: o técnico corrige o ponto em campo e três dias
   * depois uma releitura do ERP traz a coordenada velha do cadastro. Sem
   * precedência, a sincronização desfaz o trabalho de campo em silêncio.
   */
  it("preserva a coordenada verificada e registra a divergência", async () => {
    const s = await scenario();

    await correctCustomerLocation(fixture.companyA.id, fixture.techA.id, s.orderId, {
      expectedVersion: null,
      reason: "INCORRECT_LOCATION",
      latitude: -23.5505,
      longitude: -46.6333,
      source: "TECHNICIAN_GPS",
    });

    const outcome = await applyImportedCustomerLocation(
      prisma,
      fixture.companyA.id,
      s.customerId,
      { latitude: -23.6, longitude: -46.7 },
    );

    expect(outcome).toBe("PRESERVED_DIVERGENT");

    const location = await prisma.customerLocation.findUniqueOrThrow({
      where: { customerId: s.customerId },
    });
    expect(location.verified).toBe(true);
    expect(location.source).toBe("TECHNICIAN_GPS");
    expect(Number(location.latitude)).toBeCloseTo(-23.5505, 4);

    // A projeção em Customer acompanha — as duas nunca podem discordar.
    const customer = await prisma.customer.findUniqueOrThrow({
      where: { id: s.customerId },
    });
    expect(customer.locationVerified).toBe(true);
    expect(Number(customer.latitude)).toBeCloseTo(-23.5505, 4);

    const divergence = await prisma.customerLocationHistory.findFirst({
      where: { customerId: s.customerId, reason: "OTHER" },
      orderBy: { createdAt: "desc" },
    });
    expect(divergence?.note).toContain("Divergência preservada");
  });

  it("não acumula uma linha de divergência por sincronização", async () => {
    const s = await scenario();
    await correctCustomerLocation(fixture.companyA.id, fixture.techA.id, s.orderId, {
      expectedVersion: null,
      reason: "INCORRECT_LOCATION",
      latitude: -23.5505,
      longitude: -46.6333,
      source: "TECHNICIAN_GPS",
    });

    for (let i = 0; i < 3; i++) {
      await applyImportedCustomerLocation(prisma, fixture.companyA.id, s.customerId, {
        latitude: -23.6,
        longitude: -46.7,
      });
    }

    const divergences = await prisma.customerLocationHistory.count({
      where: { customerId: s.customerId, reason: "OTHER" },
    });
    // Uma só: releitura idêntica não é informação nova.
    expect(divergences).toBe(1);
  });

  it("importação entra como IMPORTED e NÃO verificada", async () => {
    const s = await scenario();
    const outcome = await applyImportedCustomerLocation(
      prisma,
      fixture.companyA.id,
      s.customerId,
      { latitude: -23.5, longitude: -46.6 },
    );
    expect(outcome).toBe("CREATED");

    const location = await prisma.customerLocation.findUniqueOrThrow({
      where: { customerId: s.customerId },
    });
    expect(location.source).toBe("IMPORTED");
    // Marcar verificado por ter vindo de um cadastro afirmaria uma checagem que
    // ninguém fez.
    expect(location.verified).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Confirmação e correção
// ---------------------------------------------------------------------------

describe("Confirmação de localização", () => {
  it("confirma sem mover o ponto e registra a distância observada", async () => {
    const s = await scenario();
    await applyImportedCustomerLocation(prisma, fixture.companyA.id, s.customerId, {
      latitude: -23.5505,
      longitude: -46.6333,
    });
    const before = await prisma.customerLocation.findUniqueOrThrow({
      where: { customerId: s.customerId },
    });

    const result = await confirmCustomerLocation(
      fixture.companyA.id,
      fixture.techA.id,
      s.orderId,
      {
        expectedVersion: before.version,
        observedLatitude: -23.5506,
        observedLongitude: -46.6334,
        observedAccuracyMeters: 12,
      },
    );

    expect(result.location.verified).toBe(true);
    // Confirmar NÃO move: a origem e as coordenadas continuam as mesmas.
    expect(result.location.source).toBe("IMPORTED");
    expect(result.location.latitude).toBeCloseTo(-23.5505, 4);
    expect(result.distanceMeters).not.toBeNull();
    expect(result.distanceMeters!).toBeLessThan(100);
  });

  it("recusa confirmar quando não há localização cadastrada", async () => {
    const s = await scenario();
    await expectDomainError(
      () =>
        confirmCustomerLocation(fixture.companyA.id, fixture.techA.id, s.orderId, {
          expectedVersion: 0,
        }),
      404,
    );
  });

  it("recusa versão velha (CAS)", async () => {
    const s = await scenario();
    await applyImportedCustomerLocation(prisma, fixture.companyA.id, s.customerId, {
      latitude: -23.55,
      longitude: -46.63,
    });
    await expectDomainError(
      () =>
        confirmCustomerLocation(fixture.companyA.id, fixture.techA.id, s.orderId, {
          expectedVersion: 999,
        }),
      409,
    );
  });

  it("GPS do aparelho NÃO é aceito como confirmação implícita", async () => {
    const s = await scenario();
    await applyImportedCustomerLocation(prisma, fixture.companyA.id, s.customerId, {
      latitude: -23.55,
      longitude: -46.63,
    });

    // Um check-in COM coordenada não pode marcar a localização como verificada.
    await checkInServiceOrder(fixture.companyA.id, fixture.techA.id, s.orderId, {
      expectedOrderVersion: s.orderVersion,
      latitude: -23.55,
      longitude: -46.63,
      accuracyMeters: 8,
    });

    const location = await prisma.customerLocation.findUniqueOrThrow({
      where: { customerId: s.customerId },
    });
    expect(location.verified).toBe(false);
  });
});

describe("Correção de localização e endereço", () => {
  it("preserva histórico com valor anterior, novo, motivo e ator", async () => {
    const s = await scenario();
    await applyImportedCustomerLocation(prisma, fixture.companyA.id, s.customerId, {
      latitude: -23.5,
      longitude: -46.6,
    });
    const before = await prisma.customerLocation.findUniqueOrThrow({
      where: { customerId: s.customerId },
    });

    await correctCustomerLocation(fixture.companyA.id, fixture.techA.id, s.orderId, {
      expectedVersion: before.version,
      reason: "CUSTOMER_MOVED",
      latitude: -23.4,
      longitude: -46.5,
      source: "TECHNICIAN_GPS",
      address: { address: "Rua Nova Ficticia", number: "42" },
    });

    const history = await prisma.customerLocationHistory.findFirst({
      where: { customerId: s.customerId, reason: "CUSTOMER_MOVED" },
      orderBy: { createdAt: "desc" },
    });

    expect(history).not.toBeNull();
    expect(history!.kind).toBe("BOTH");
    expect(Number(history!.previousLatitude)).toBeCloseTo(-23.5, 4);
    expect(Number(history!.newLatitude)).toBeCloseTo(-23.4, 4);
    expect(history!.previousSource).toBe("IMPORTED");
    expect(history!.newSource).toBe("TECHNICIAN_GPS");
    expect(history!.changedByUserId).toBe(fixture.techA.id);
    expect(history!.technicianId).toBe(s.technicianId);
    expect(history!.serviceOrderId).toBe(s.orderId);
    expect(history!.companyId).toBe(fixture.companyA.id);
    expect(
      (history!.previousAddress as Record<string, unknown>).address,
    ).toBe("Rua das Palmeiras");
    expect((history!.newAddress as Record<string, unknown>).address).toBe(
      "Rua Nova Ficticia",
    );
  });

  it("motivo OTHER exige nota", async () => {
    const s = await scenario();
    await expectDomainError(
      () =>
        correctCustomerLocation(fixture.companyA.id, fixture.techA.id, s.orderId, {
          expectedVersion: null,
          reason: "OTHER",
          latitude: -23.4,
          longitude: -46.5,
        }),
      400,
    );
  });

  it("corrigir só o endereço não marca a localização como verificada", async () => {
    const s = await scenario();
    await applyImportedCustomerLocation(prisma, fixture.companyA.id, s.customerId, {
      latitude: -23.5,
      longitude: -46.6,
    });
    const before = await prisma.customerLocation.findUniqueOrThrow({
      where: { customerId: s.customerId },
    });

    await correctCustomerLocation(fixture.companyA.id, fixture.techA.id, s.orderId, {
      expectedVersion: before.version,
      reason: "INCORRECT_ADDRESS",
      address: { number: "500" },
    });

    const after = await prisma.customerLocation.findUniqueOrThrow({
      where: { customerId: s.customerId },
    });
    // O texto estar errado não diz nada sobre o ponto no mapa.
    expect(after.verified).toBe(false);
  });

  it("corpo parcial não apaga o resto do endereço", async () => {
    const s = await scenario();
    await correctCustomerLocation(fixture.companyA.id, fixture.techA.id, s.orderId, {
      expectedVersion: null,
      reason: "INCORRECT_ADDRESS",
      address: { number: "999" },
    });
    const customer = await prisma.customer.findUniqueOrThrow({
      where: { id: s.customerId },
    });
    expect(customer.number).toBe("999");
    expect(customer.address).toBe("Rua das Palmeiras");
    expect(customer.district).toBe("Centro");
  });

  it('nunca grava as strings "null" ou "undefined" como endereço', () => {
    expect(normalizeAddressValue("null", 200)).toBeNull();
    expect(normalizeAddressValue("undefined", 200)).toBeNull();
    expect(normalizeAddressValue("NULL", 200)).toBeNull();
    expect(normalizeAddressValue("   ", 200)).toBeNull();
    expect(normalizeAddressValue("Rua Nula", 200)).toBe("Rua Nula");
  });

  it.each([
    ["latitude acima de 90", 91, -46.6],
    ["longitude acima de 180", -23.5, 181],
    ["NaN", Number.NaN, -46.6],
    ["infinito", Number.POSITIVE_INFINITY, -46.6],
    ["ilha nula (0,0)", 0, 0],
  ])("recusa coordenada inválida: %s", async (_label, lat, lng) => {
    const s = await scenario();
    await expectDomainError(
      () =>
        correctCustomerLocation(fixture.companyA.id, fixture.techA.id, s.orderId, {
          expectedVersion: null,
          reason: "INCORRECT_LOCATION",
          latitude: lat,
          longitude: lng,
        }),
      400,
    );
  });

  it("recusa precisão negativa", async () => {
    const s = await scenario();
    await expectDomainError(
      () =>
        correctCustomerLocation(fixture.companyA.id, fixture.techA.id, s.orderId, {
          expectedVersion: null,
          reason: "INCORRECT_LOCATION",
          latitude: -23.5,
          longitude: -46.6,
          accuracyMeters: -10,
        }),
      400,
    );
  });
});

describe("Posse e tenancy na correção de cadastro", () => {
  /**
   * O ataque da §60: o técnico A usa uma OS SUA para corrigir o cliente de
   * outra OS. O `customerId` nunca vem do corpo — é derivado da OS —, então a
   * única forma de alcançar um cliente é através de uma OS que se possui.
   */
  it("técnico não corrige cliente de OS de outro técnico", async () => {
    await ensureTechnician(fixture.techA.id);
    const alheia = await scenario({ userId: fixture.techB.id });
    await expectDomainError(
      () =>
        correctCustomerLocation(
          fixture.companyA.id,
          fixture.techA.id,
          alheia.orderId,
          {
            expectedVersion: null,
            reason: "INCORRECT_LOCATION",
            latitude: -23.4,
            longitude: -46.5,
          },
        ),
      404,
    );
  });

  it("empresa B não alcança OS da empresa A", async () => {
    const s = await scenario();
    await expectDomainError(
      () =>
        correctCustomerLocation(fixture.companyB.id, fixture.techA.id, s.orderId, {
          expectedVersion: null,
          reason: "INCORRECT_LOCATION",
          latitude: -23.4,
          longitude: -46.5,
        }),
      404,
    );
  });

  it("recusa correção em OS já concluída", async () => {
    const s = await scenario();
    await completeServiceOrder(fixture.companyA.id, fixture.techA.id, s.orderId, {
      expectedOrderVersion: s.orderVersion,
      expectedExecutionVersion: s.executionVersion,
    });
    await expectDomainError(
      () =>
        correctCustomerLocation(fixture.companyA.id, fixture.techA.id, s.orderId, {
          expectedVersion: null,
          reason: "INCORRECT_LOCATION",
          latitude: -23.4,
          longitude: -46.5,
        }),
      409,
    );
  });
});

// ---------------------------------------------------------------------------
// Check-in
// ---------------------------------------------------------------------------

describe("Check-in", () => {
  it("registra chegada com GPS e calcula a distância no servidor", async () => {
    const s = await scenario();
    await applyImportedCustomerLocation(prisma, fixture.companyA.id, s.customerId, {
      latitude: -23.5505,
      longitude: -46.6333,
    });

    const result = await checkInServiceOrder(
      fixture.companyA.id,
      fixture.techA.id,
      s.orderId,
      {
        expectedOrderVersion: s.orderVersion,
        latitude: -23.5515,
        longitude: -46.6333,
        accuracyMeters: 10,
      },
    );

    expect(result.hasCoordinate).toBe(true);
    // ~111 m por 0,001° de latitude.
    expect(result.distanceMeters).toBeGreaterThan(80);
    expect(result.distanceMeters).toBeLessThan(150);
  });

  it("aceita check-in sem GPS e marca a origem como UNAVAILABLE", async () => {
    const s = await scenario();
    const result = await checkInServiceOrder(
      fixture.companyA.id,
      fixture.techA.id,
      s.orderId,
      { expectedOrderVersion: s.orderVersion },
    );

    expect(result.hasCoordinate).toBe(false);
    expect(result.distanceMeters).toBeNull();

    const row = await prisma.serviceOrderCheckIn.findUniqueOrThrow({
      where: { serviceOrderId: s.orderId },
    });
    // A chegada é o fato; a coordenada é o detalhe. Recusar por falta de GPS
    // deixaria o despachante sem a informação que importa.
    expect(row.source).toBe("UNAVAILABLE");
  });

  it("recusa segundo check-in na mesma OS", async () => {
    const s = await scenario();
    await checkInServiceOrder(fixture.companyA.id, fixture.techA.id, s.orderId, {
      expectedOrderVersion: s.orderVersion,
    });
    const nextVersion = await orderVersionOf(s.orderId);
    await expectDomainError(
      () =>
        checkInServiceOrder(fixture.companyA.id, fixture.techA.id, s.orderId, {
          expectedOrderVersion: nextVersion,
        }),
      409,
    );
  });

  it("não bloqueia atendimento por distância grande", async () => {
    const s = await scenario();
    await applyImportedCustomerLocation(prisma, fixture.companyA.id, s.customerId, {
      latitude: -23.55,
      longitude: -46.63,
    });
    // Outro estado, centenas de quilômetros. Registra e segue: geofence
    // bloqueante impediria atendimento real por GPS impreciso (§167).
    const result = await checkInServiceOrder(
      fixture.companyA.id,
      fixture.techA.id,
      s.orderId,
      {
        expectedOrderVersion: s.orderVersion,
        latitude: -22.9,
        longitude: -43.2,
      },
    );
    expect(result.distanceMeters).toBeGreaterThan(300_000);
  });

  it("técnico não faz check-in em OS alheia", async () => {
    await ensureTechnician(fixture.techA.id);
    const alheia = await scenario({ userId: fixture.techB.id });
    await expectDomainError(
      () =>
        checkInServiceOrder(fixture.companyA.id, fixture.techA.id, alheia.orderId, {
          expectedOrderVersion: alheia.orderVersion,
        }),
      404,
    );
  });
});

// ---------------------------------------------------------------------------
// Checklist
// ---------------------------------------------------------------------------

async function seedTemplate(items?: Parameters<typeof putChecklistTemplate>[2]["items"]) {
  return putChecklistTemplate(fixture.companyA.id, fixture.adminA.id, {
    serviceOrderTypeId: fixture.typeA.id,
    name: "Checklist de instalação",
    items: items ?? [
      { label: "Cabo testado?", type: "BOOLEAN", required: true },
      { label: "Potência óptica (dBm)", type: "NUMBER", required: false },
      {
        label: "Padrão do acabamento",
        type: "SELECT",
        required: false,
        options: ["Aparente", "Embutido"],
      },
    ],
  });
}

describe("Checklist dinâmico e snapshot", () => {
  it("copia o template para a OS no início do atendimento", async () => {
    await seedTemplate();
    const s = await scenario();

    const checklist = await getOrderChecklist(fixture.companyA.id, s.orderId);
    expect(checklist).toHaveLength(3);
    expect(checklist[0].label).toBe("Cabo testado?");
    expect(checklist[0].required).toBe(true);

    const execution = await prisma.serviceOrderExecution.findUniqueOrThrow({
      where: { serviceOrderId: s.orderId },
    });
    expect(execution.checklistTemplateId).not.toBeNull();
    expect(execution.checklistTemplateVersion).toBe(1);
  });

  /**
   * O invariante mais fácil de desfazer sem perceber. Se a OS apontasse para o
   * template, editar o catálogo mudaria retroativamente o checklist de OS já
   * iniciada — e o relatório de conformidade do passado mudaria sozinho.
   */
  it("editar o template NÃO altera OS já iniciada", async () => {
    await seedTemplate();
    const s = await scenario();

    await seedTemplate([
      { label: "Pergunta completamente nova", type: "TEXT", required: true },
    ]);

    const checklist = await getOrderChecklist(fixture.companyA.id, s.orderId);
    expect(checklist).toHaveLength(3);
    expect(checklist.map((i) => i.label)).not.toContain(
      "Pergunta completamente nova",
    );

    // A OS SEGUINTE recebe o template novo.
    const nova = await scenario();
    const novaChecklist = await getOrderChecklist(fixture.companyA.id, nova.orderId);
    expect(novaChecklist).toHaveLength(1);
    expect(novaChecklist[0].label).toBe("Pergunta completamente nova");
  });

  it("valida o tipo da resposta contra o snapshot", async () => {
    await seedTemplate();
    const s = await scenario();
    const checklist = await getOrderChecklist(fixture.companyA.id, s.orderId);
    const booleano = checklist.find((i) => i.type === "BOOLEAN")!;

    await expectDomainError(
      () =>
        answerChecklistItem(fixture.companyA.id, fixture.techA.id, s.orderId, {
          itemId: booleano.id,
          expectedOrderVersion: s.orderVersion,
          valueText: "talvez",
        }),
      400,
    );
  });

  it("recusa opção fora da lista do snapshot", async () => {
    await seedTemplate();
    const s = await scenario();
    const checklist = await getOrderChecklist(fixture.companyA.id, s.orderId);
    const select = checklist.find((i) => i.type === "SELECT")!;

    await expectDomainError(
      () =>
        answerChecklistItem(fixture.companyA.id, fixture.techA.id, s.orderId, {
          itemId: select.id,
          expectedOrderVersion: s.orderVersion,
          valueText: "Opção inventada",
        }),
      400,
    );
  });

  it("grava a resposta e incrementa a versão da OS", async () => {
    await seedTemplate();
    const s = await scenario();
    const checklist = await getOrderChecklist(fixture.companyA.id, s.orderId);
    const booleano = checklist.find((i) => i.type === "BOOLEAN")!;

    const answered = await answerChecklistItem(
      fixture.companyA.id,
      fixture.techA.id,
      s.orderId,
      {
        itemId: booleano.id,
        expectedOrderVersion: s.orderVersion,
        valueBoolean: true,
      },
    );

    expect(answered.valueBoolean).toBe(true);
    expect(answered.answeredAt).not.toBeNull();
    expect(await orderVersionOf(s.orderId)).toBe(s.orderVersion + 1);
  });

  it("item de outra OS não é alcançável", async () => {
    await seedTemplate();
    const alheia = await scenario({ userId: fixture.techB.id });
    const minha = await scenario();
    const checklistAlheio = await getOrderChecklist(
      fixture.companyA.id,
      alheia.orderId,
    );

    await expectDomainError(
      () =>
        answerChecklistItem(fixture.companyA.id, fixture.techA.id, minha.orderId, {
          itemId: checklistAlheio[0].id,
          expectedOrderVersion: minha.orderVersion,
          valueBoolean: true,
        }),
      404,
    );
  });
});

// ---------------------------------------------------------------------------
// Inventário
// ---------------------------------------------------------------------------

async function seedStock(quantity: number, unit: "UNIT" | "METER" = "METER") {
  const item = await createInventoryItem(fixture.companyA.id, fixture.adminA.id, {
    code: "CABO-DROP",
    name: "Cabo drop óptico",
    unit,
  });
  const technician = await prisma.technician.upsert({
    where: { userId: fixture.techA.id },
    update: {},
    create: { companyId: fixture.companyA.id, userId: fixture.techA.id },
  });
  await receiveStock(fixture.companyA.id, fixture.adminA.id, {
    itemId: item.id,
    technicianId: technician.id,
    quantity,
  });
  return { item, technicianId: technician.id };
}

describe("Ledger de inventário", () => {
  it("saldo é derivado dos movimentos, não de uma coluna", async () => {
    const { item, technicianId } = await seedStock(100);
    const balance = await getTechnicianStockBalance(
      prisma,
      fixture.companyA.id,
      item.id,
      technicianId,
    );
    expect(balance.toString()).toBe("100");

    const s = await scenario();
    await consumeInventoryForOrder(fixture.companyA.id, fixture.techA.id, s.orderId, {
      itemId: item.id,
      quantity: 30.5,
      expectedOrderVersion: s.orderVersion,
    });

    const after = await getTechnicianStockBalance(
      prisma,
      fixture.companyA.id,
      item.id,
      technicianId,
    );
    expect(after.toString()).toBe("69.5");

    // O movimento é imutável e ligado à OS.
    const movement = await prisma.inventoryMovement.findFirstOrThrow({
      where: { serviceOrderId: s.orderId },
    });
    expect(movement.type).toBe("TECHNICIAN_TO_CUSTOMER");
    expect(movement.quantity.toString()).toBe("30.5");
    expect(movement.technicianId).toBe(technicianId);
  });

  it("consumo cria a linha de uso ligada ao movimento — uma lista só", async () => {
    const { item } = await seedStock(50);
    const s = await scenario();
    await consumeInventoryForOrder(fixture.companyA.id, fixture.techA.id, s.orderId, {
      itemId: item.id,
      quantity: 10,
      expectedOrderVersion: s.orderVersion,
    });

    const usages = await prisma.serviceOrderMaterialUsage.findMany({
      where: { serviceOrderId: s.orderId },
    });
    expect(usages).toHaveLength(1);
    expect(usages[0].inventoryItemId).toBe(item.id);
    expect(usages[0].inventoryMovementId).not.toBeNull();
  });

  it("recusa saldo insuficiente", async () => {
    const { item } = await seedStock(5);
    const s = await scenario();
    await expectDomainError(
      () =>
        consumeInventoryForOrder(fixture.companyA.id, fixture.techA.id, s.orderId, {
          itemId: item.id,
          quantity: 10,
          expectedOrderVersion: s.orderVersion,
        }),
      409,
    );
  });

  it.each([
    ["negativa", -5],
    ["zero", 0],
    ["não finita", Number.NaN],
  ])("recusa quantidade %s", async (_label, quantity) => {
    const { item } = await seedStock(50);
    const s = await scenario();
    await expectDomainError(
      () =>
        consumeInventoryForOrder(fixture.companyA.id, fixture.techA.id, s.orderId, {
          itemId: item.id,
          quantity,
          expectedOrderVersion: s.orderVersion,
        }),
      400,
    );
  });

  it("recusa fração em item contado por unidade", async () => {
    const { item } = await seedStock(50, "UNIT");
    const s = await scenario();
    await expectDomainError(
      () =>
        consumeInventoryForOrder(fixture.companyA.id, fixture.techA.id, s.orderId, {
          itemId: item.id,
          quantity: 2.5,
          expectedOrderVersion: s.orderVersion,
        }),
      400,
    );
  });

  it("recusa mais de três casas decimais", async () => {
    const { item } = await seedStock(50);
    const s = await scenario();
    await expectDomainError(
      () =>
        consumeInventoryForOrder(fixture.companyA.id, fixture.techA.id, s.orderId, {
          itemId: item.id,
          quantity: 1.00005,
          expectedOrderVersion: s.orderVersion,
        }),
      400,
    );
  });

  it("item de outra empresa não é alcançável", async () => {
    const alheio = await createInventoryItem(
      fixture.companyB.id,
      fixture.adminB.id,
      { code: "CABO-B", name: "Cabo da empresa B", unit: "METER" },
    );
    const s = await scenario();
    await expectDomainError(
      () =>
        consumeInventoryForOrder(fixture.companyA.id, fixture.techA.id, s.orderId, {
          itemId: alheio.id,
          quantity: 1,
          expectedOrderVersion: s.orderVersion,
        }),
      404,
    );
  });

  it("técnico não consome o estoque de outro técnico", async () => {
    const item = await createInventoryItem(fixture.companyA.id, fixture.adminA.id, {
      code: "CONECTOR",
      name: "Conector",
      unit: "UNIT",
    });
    const techB = await prisma.technician.upsert({
      where: { userId: fixture.techB.id },
      update: {},
      create: { companyId: fixture.companyA.id, userId: fixture.techB.id },
    });
    // Só o técnico B recebeu material.
    await receiveStock(fixture.companyA.id, fixture.adminA.id, {
      itemId: item.id,
      technicianId: techB.id,
      quantity: 100,
    });

    const s = await scenario({ userId: fixture.techA.id });
    await expectDomainError(
      () =>
        consumeInventoryForOrder(fixture.companyA.id, fixture.techA.id, s.orderId, {
          itemId: item.id,
          quantity: 1,
          expectedOrderVersion: s.orderVersion,
        }),
      409,
    );
  });

  it("lista só itens com saldo positivo", async () => {
    const { item, technicianId } = await seedStock(10);
    const zerado = await createInventoryItem(fixture.companyA.id, fixture.adminA.id, {
      code: "ZERADO",
      name: "Item sem saldo",
      unit: "UNIT",
    });

    const stock = await listTechnicianStock(fixture.companyA.id, technicianId);
    const codes = stock.map((line) => line.code);
    expect(codes).toContain(item.code);
    expect(codes).not.toContain(zerado.code);
  });

  /**
   * A corrida da §62. As duas baixas partem de OS DIFERENTES do mesmo técnico,
   * de propósito: assim o compare-and-set da OS não arbitra nada — quem tem de
   * arbitrar é o lock de estoque. Sem ele, as duas leem o mesmo saldo, as duas
   * se acham autorizadas e o saldo termina negativo.
   */
  it("duas baixas concorrentes não furam o saldo", async () => {
    const ROUNDS = 3;
    for (let round = 0; round < ROUNDS; round++) {
      fixture = await seedTestData();
      const { item, technicianId } = await seedStock(10, "UNIT");

      const a = await scenario();
      const b = await scenario();

      const results = await Promise.allSettled([
        consumeInventoryForOrder(fixture.companyA.id, fixture.techA.id, a.orderId, {
          itemId: item.id,
          quantity: 10,
          expectedOrderVersion: a.orderVersion,
        }),
        consumeInventoryForOrder(fixture.companyA.id, fixture.techA.id, b.orderId, {
          itemId: item.id,
          quantity: 10,
          expectedOrderVersion: b.orderVersion,
        }),
      ]);

      const ok = results.filter((r) => r.status === "fulfilled");
      expect(ok, `rodada ${round}: exatamente uma baixa pode vencer`).toHaveLength(
        1,
      );

      const balance = await getTechnicianStockBalance(
        prisma,
        fixture.companyA.id,
        item.id,
        technicianId,
      );
      expect(
        balance.greaterThanOrEqualTo(0),
        `rodada ${round}: saldo ficou negativo (${balance.toString()})`,
      ).toBe(true);
      expect(balance.toString()).toBe("0");
    }
  });
});

// ---------------------------------------------------------------------------
// Equipamento
// ---------------------------------------------------------------------------

/**
 * Anexa a foto da etiqueta e devolve o que o registro do equipamento precisa.
 *
 * Desde a v0.10.1 a identificação do equipamento é a FOTO, não o texto
 * digitado: série e MAC viraram opcionais. Toda chamada de registro passa por
 * aqui — e a versão devolvida já é a de DEPOIS do anexo, porque anexar a
 * evidência move a versão da OS.
 */
async function comEtiqueta(
  orderId: string,
  userId: string = fixture.techA.id,
): Promise<{ labelEvidenceId: string; expectedOrderVersion: number }> {
  const evidence = await addEvidence(fixture.companyA.id, userId, orderId, {
    data: PNG,
    declaredMimeType: "image/png",
    originalName: "etiqueta.png",
    expectedOrderVersion: await orderVersionOf(orderId),
    category: "EQUIPMENT_LABEL",
  });
  return {
    labelEvidenceId: evidence.id,
    expectedOrderVersion: await orderVersionOf(orderId),
  };
}

describe("Equipamento instalado", () => {
  it("registra e recusa serial duplicado na mesma empresa", async () => {
    const a = await scenario();
    await addServiceOrderEquipment(fixture.companyA.id, fixture.techA.id, a.orderId, {
      ...(await comEtiqueta(a.orderId)),
      equipmentType: "ONU",
      serial: "FICT12345678",
    });

    const b = await scenario();
    const etiquetaB = await comEtiqueta(b.orderId);
    await expectDomainError(
      () =>
        addServiceOrderEquipment(fixture.companyA.id, fixture.techA.id, b.orderId, {
          ...etiquetaB,
          equipmentType: "ONU",
          serial: "FICT12345678",
        }),
      409,
    );
  });

  it("sem série e sem MAC é VÁLIDO quando há foto da etiqueta", async () => {
    const s = await scenario();

    /*
      A mudança de produto da v0.10.1, no ponto exato onde ela vive.

      Antes isto era 400 ("informe ao menos o número de série ou o endereço
      MAC"). O técnico agachado dentro de um armário transcrevia doze
      caracteres de um adesivo — a origem mais comum de equipamento vinculado
      ao cliente errado. Agora a câmera lê o mesmo adesivo, e quem precisar do
      texto o extrai depois, no escritório.
    */
    const equipamento = await addServiceOrderEquipment(
      fixture.companyA.id,
      fixture.techA.id,
      s.orderId,
      { ...(await comEtiqueta(s.orderId)), equipmentType: "ONU" },
    );

    expect(equipamento.serial).toBeNull();
    expect(equipamento.macAddress).toBeNull();
    expect(equipamento.labelEvidenceId).toBeTruthy();
  });

  it("MAC vazio não é MAC inválido", async () => {
    const s = await scenario();

    // String vazia é AUSÊNCIA. Recusá-la com "Endereço MAC inválido" diria ao
    // técnico que ele errou o formato de um campo que ele nem preencheu.
    const equipamento = await addServiceOrderEquipment(
      fixture.companyA.id,
      fixture.techA.id,
      s.orderId,
      {
        ...(await comEtiqueta(s.orderId)),
        equipmentType: "ONU",
        serial: "",
        macAddress: "",
      },
    );

    expect(equipamento.macAddress).toBeNull();
  });

  it("sem foto da etiqueta é recusado", async () => {
    const s = await scenario();
    await expectDomainError(
      () =>
        addServiceOrderEquipment(fixture.companyA.id, fixture.techA.id, s.orderId, {
          expectedOrderVersion: s.orderVersion,
          equipmentType: "ONU",
          serial: "FICTSEMFOTO1",
          labelEvidenceId: "evidencia-que-nao-existe",
        }),
      400,
    );

    expect(
      await prisma.serviceOrderEquipment.count({ where: { serviceOrderId: s.orderId } }),
    ).toBe(0);
  });

  it("foto de OUTRA categoria não serve de etiqueta", async () => {
    const s = await scenario();
    const outra = await addEvidence(fixture.companyA.id, fixture.techA.id, s.orderId, {
      data: PNG,
      declaredMimeType: "image/png",
      originalName: "velocidade.png",
      expectedOrderVersion: await orderVersionOf(s.orderId),
      category: "SPEED_TEST",
    });

    // Sem a conferência de categoria, o campo viraria um ponteiro para
    // qualquer foto da OS — e "identificado pela etiqueta" seria falso.
    const versao = await orderVersionOf(s.orderId);
    await expectDomainError(
      () =>
        addServiceOrderEquipment(fixture.companyA.id, fixture.techA.id, s.orderId, {
          expectedOrderVersion: versao,
          equipmentType: "ONU",
          labelEvidenceId: outra.id,
        }),
      400,
    );
  });

  it("etiqueta de OUTRA OS não serve", async () => {
    const alheia = await scenario();
    const etiquetaAlheia = await comEtiqueta(alheia.orderId);

    const s = await scenario();
    const versao = await orderVersionOf(s.orderId);
    await expectDomainError(
      () =>
        addServiceOrderEquipment(fixture.companyA.id, fixture.techA.id, s.orderId, {
          expectedOrderVersion: versao,
          equipmentType: "ONU",
          labelEvidenceId: etiquetaAlheia.labelEvidenceId,
        }),
      400,
    );
  });

  it("a etiqueta em uso não pode ser apagada", async () => {
    const s = await scenario();
    const etiqueta = await comEtiqueta(s.orderId);
    await addServiceOrderEquipment(fixture.companyA.id, fixture.techA.id, s.orderId, {
      ...etiqueta,
      equipmentType: "ONU",
    });

    /*
      Apagar a foto deixaria para trás um equipamento sem série, sem MAC e sem
      etiqueta — um registro que não responde mais a pergunta que ele existe
      para responder. A FK `Restrict` já recusaria; a conferência explícita
      existe para o técnico receber uma frase que diz o que fazer.
    */
    const depois = await orderVersionOf(s.orderId);
    await expectDomainError(
      () =>
        removeEvidence(
          fixture.companyA.id,
          fixture.techA.id,
          s.orderId,
          etiqueta.labelEvidenceId,
          depois,
        ),
      409,
    );

    expect(
      await prisma.serviceOrderEvidence.count({
        where: { id: etiqueta.labelEvidenceId },
      }),
    ).toBe(1);
  });

  it("normaliza o MAC antes de comparar duplicidade", async () => {
    const a = await scenario();
    await addServiceOrderEquipment(fixture.companyA.id, fixture.techA.id, a.orderId, {
      ...(await comEtiqueta(a.orderId)),
      equipmentType: "ONU",
      macAddress: "a1:b2:c3:d4:e5:f6",
    });

    const b = await scenario();
    const etiquetaB = await comEtiqueta(b.orderId);
    // Mesmo endereço, outro separador. Sem normalização, passaria.
    await expectDomainError(
      () =>
        addServiceOrderEquipment(fixture.companyA.id, fixture.techA.id, b.orderId, {
          ...etiquetaB,
          equipmentType: "ONU",
          macAddress: "A1-B2-C3-D4-E5-F6",
        }),
      409,
    );
  });

  it("recusa MAC malformado quando ele VEM preenchido", async () => {
    const s = await scenario();
    const etiqueta = await comEtiqueta(s.orderId);
    await expectDomainError(
      () =>
        addServiceOrderEquipment(fixture.companyA.id, fixture.techA.id, s.orderId, {
          ...etiqueta,
          equipmentType: "ONU",
          macAddress: "nao-e-um-mac",
        }),
      400,
    );
  });

  it("serial igual em empresas diferentes é permitido", async () => {
    const s = await scenario();
    await addServiceOrderEquipment(fixture.companyA.id, fixture.techA.id, s.orderId, {
      ...(await comEtiqueta(s.orderId)),
      equipmentType: "ONU",
      serial: "COMPARTILHADO1",
    });

    // A unique é POR EMPRESA: o mesmo serial noutra empresa é outro aparelho.
    const created = await prisma.serviceOrderEquipment.create({
      data: {
        companyId: fixture.companyB.id,
        serviceOrderId: s.orderId,
        customerId: s.customerId,
        equipmentType: "ONU",
        serial: "COMPARTILHADO1",
      },
    });
    expect(created.id).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Assinatura
// ---------------------------------------------------------------------------

describe("Assinatura vinculada ao fechamento", () => {
  it("grava o resumo do conteúdo assinado", async () => {
    const s = await scenario();
    await putSignature(fixture.companyA.id, fixture.techA.id, s.orderId, {
      signerName: "Cliente Ficticio",
      data: PNG,
      declaredMimeType: "image/png",
      expectedOrderVersion: s.orderVersion,
    });

    const signature = await prisma.serviceOrderSignature.findUniqueOrThrow({
      where: { serviceOrderId: s.orderId },
    });
    expect(signature.signedContentHash).not.toBeNull();
    expect(signature.signedOrderVersion).toBe(s.orderVersion + 1);
  });

  /**
   * §37: sem este vínculo, o técnico colheria a assinatura e só depois
   * acrescentaria material ou trocaria o serviço realizado — e o fechamento
   * sairia com o cliente aparentemente concordando com algo que nunca viu.
   */
  it("mudar o atendimento depois da assinatura impede concluir", async () => {
    const s = await scenario();
    await putSignature(fixture.companyA.id, fixture.techA.id, s.orderId, {
      signerName: "Cliente Ficticio",
      data: PNG,
      declaredMimeType: "image/png",
      expectedOrderVersion: s.orderVersion,
    });

    // Conteúdo muda DEPOIS da assinatura.
    await addServiceOrderEquipment(fixture.companyA.id, fixture.techA.id, s.orderId, {
      ...(await comEtiqueta(s.orderId)),
      equipmentType: "ONU",
      serial: "APOSASSINATURA1",
    });

    const currentVersion = await orderVersionOf(s.orderId);
    const error = await expectDomainError(
      () =>
        completeServiceOrder(fixture.companyA.id, fixture.techA.id, s.orderId, {
          expectedOrderVersion: currentVersion,
          expectedExecutionVersion: s.executionVersion,
        }),
      400,
    );
    expect(error).toBeInstanceOf(CompletionBlockedError);
    expect(
      (error as CompletionBlockedError).pendencies.map((p) => p.code),
    ).toContain("SIGNATURE_STALE");
  });

  it("recolher a assinatura de novo libera a conclusão", async () => {
    const s = await scenario();
    await addServiceOrderEquipment(fixture.companyA.id, fixture.techA.id, s.orderId, {
      ...(await comEtiqueta(s.orderId)),
      equipmentType: "ONU",
      serial: "ANTESASSINATURA",
    });
    await putSignature(fixture.companyA.id, fixture.techA.id, s.orderId, {
      signerName: "Cliente Ficticio",
      data: PNG,
      declaredMimeType: "image/png",
      expectedOrderVersion: await orderVersionOf(s.orderId),
    });

    await completeServiceOrder(fixture.companyA.id, fixture.techA.id, s.orderId, {
      expectedOrderVersion: await orderVersionOf(s.orderId),
      expectedExecutionVersion: s.executionVersion,
    });

    const order = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: s.orderId },
    });
    expect(order.status).toBe("COMPLETED");
  });

  it("recusa assinatura vazia", async () => {
    const s = await scenario();
    await expectDomainError(
      () =>
        putSignature(fixture.companyA.id, fixture.techA.id, s.orderId, {
          signerName: "Cliente Ficticio",
          data: Buffer.alloc(0),
          declaredMimeType: "image/png",
          expectedOrderVersion: s.orderVersion,
        }),
      400,
    );
  });

  it("técnico não assina OS alheia", async () => {
    await ensureTechnician(fixture.techA.id);
    const alheia = await scenario({ userId: fixture.techB.id });
    await expectDomainError(
      () =>
        putSignature(fixture.companyA.id, fixture.techA.id, alheia.orderId, {
          signerName: "Cliente Ficticio",
          data: PNG,
          declaredMimeType: "image/png",
          expectedOrderVersion: alheia.orderVersion,
        }),
      404,
    );
  });
});

// ---------------------------------------------------------------------------
// Conclusão
// ---------------------------------------------------------------------------

describe("Validação de conclusão por tipo de OS", () => {
  async function policy(overrides: Partial<Parameters<typeof putCompletionPolicy>[3]> = {}) {
    return putCompletionPolicy(
      fixture.companyA.id,
      fixture.adminA.id,
      fixture.typeA.id,
      {
        requireChecklist: false,
        requireSignature: false,
        requireMaterials: false,
        requireEquipment: false,
        requireCheckIn: false,
        minEvidenceCount: 0,
        requiredEvidenceCategories: [],
        ...overrides,
      },
    );
  }

  it("sem política, conclui como na v0.4", async () => {
    const s = await scenario();
    await completeServiceOrder(fixture.companyA.id, fixture.techA.id, s.orderId, {
      expectedOrderVersion: s.orderVersion,
      expectedExecutionVersion: s.executionVersion,
    });
    const order = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: s.orderId },
    });
    expect(order.status).toBe("COMPLETED");
  });

  it("devolve a lista COMPLETA de pendências, não a primeira", async () => {
    await policy({
      requireSignature: true,
      requireEquipment: true,
      requireCheckIn: true,
      minEvidenceCount: 2,
    });
    const s = await scenario({ withExecutionText: false });

    const error = await expectDomainError(
      () =>
        completeServiceOrder(fixture.companyA.id, fixture.techA.id, s.orderId, {
          expectedOrderVersion: s.orderVersion,
          expectedExecutionVersion: s.executionVersion,
        }),
      400,
    );

    const codes = (error as CompletionBlockedError).pendencies.map((p) => p.code);
    expect(codes).toContain("EXECUTION_DIAGNOSIS_REQUIRED");
    expect(codes).toContain("EXECUTION_WORK_REQUIRED");
    expect(codes).toContain("SIGNATURE_REQUIRED");
    expect(codes).toContain("EQUIPMENT_REQUIRED");
    expect(codes).toContain("CHECK_IN_REQUIRED");
    expect(codes).toContain("EVIDENCE_COUNT_BELOW_MINIMUM");
  });

  it("exige a categoria de foto configurada", async () => {
    await policy({ requiredEvidenceCategories: ["ONU_ONT"] });
    const s = await scenario();

    // Uma foto existe, mas na categoria errada.
    await addEvidence(fixture.companyA.id, fixture.techA.id, s.orderId, {
      data: PNG,
      declaredMimeType: "image/png",
      originalName: "antes.png",
      expectedOrderVersion: s.orderVersion,
      category: "BEFORE_SERVICE",
    });

    const afterPhoto = await orderVersionOf(s.orderId);
    const error = await expectDomainError(
      () =>
        completeServiceOrder(fixture.companyA.id, fixture.techA.id, s.orderId, {
          expectedOrderVersion: afterPhoto,
          expectedExecutionVersion: s.executionVersion,
        }),
      400,
    );
    const pendencies = (error as CompletionBlockedError).pendencies;
    expect(pendencies.some((p) => p.code === "EVIDENCE_CATEGORY_MISSING")).toBe(
      true,
    );
    expect(pendencies.find((p) => p.code === "EVIDENCE_CATEGORY_MISSING")?.category).toBe(
      "ONU_ONT",
    );
  });

  it("item obrigatório de checklist bloqueia a conclusão", async () => {
    await seedTemplate();
    await policy({ requireChecklist: true });
    const s = await scenario();

    const error = await expectDomainError(
      () =>
        completeServiceOrder(fixture.companyA.id, fixture.techA.id, s.orderId, {
          expectedOrderVersion: s.orderVersion,
          expectedExecutionVersion: s.executionVersion,
        }),
      400,
    );
    const pendencies = (error as CompletionBlockedError).pendencies;
    expect(pendencies.some((p) => p.code === "CHECKLIST_ITEM_PENDING")).toBe(true);

    // Respondido, libera.
    const checklist = await getOrderChecklist(fixture.companyA.id, s.orderId);
    const obrigatorio = checklist.find((i) => i.required)!;
    await answerChecklistItem(fixture.companyA.id, fixture.techA.id, s.orderId, {
      itemId: obrigatorio.id,
      expectedOrderVersion: await orderVersionOf(s.orderId),
      valueBoolean: true,
    });

    await completeServiceOrder(fixture.companyA.id, fixture.techA.id, s.orderId, {
      expectedOrderVersion: await orderVersionOf(s.orderId),
      expectedExecutionVersion: s.executionVersion,
    });
    const order = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: s.orderId },
    });
    expect(order.status).toBe("COMPLETED");
  });


  /*
    Regressão do TEST-COV-01, apontado pela auditoria independente da v0.10.

    Sabotando o ramo `if (policy.requireChecklist)` em
    `validateServiceOrderCompletion`, a suíte inteira acusava UM único teste —
    o de cima. Uma proteção com uma testemunha só é uma proteção que some sem
    ninguém ver.

    Os três abaixo cobrem o que aquele não cobre: que é a FLAG quem bloqueia,
    que item opcional não é o que segura, e que responder parcialmente não
    libera.
  */
  it("é a flag que bloqueia: com requireChecklist=false o mesmo item pendente NÃO impede", async () => {
    await seedTemplate();
    await policy({ requireChecklist: false });
    const s = await scenario();

    // Controle positivo do estado: o item obrigatório está mesmo sem resposta.
    const checklist = await getOrderChecklist(fixture.companyA.id, s.orderId);
    const obrigatorio = checklist.find((i) => i.required)!;
    expect(obrigatorio.answeredAt).toBeNull();

    await completeServiceOrder(fixture.companyA.id, fixture.techA.id, s.orderId, {
      expectedOrderVersion: s.orderVersion,
      expectedExecutionVersion: s.executionVersion,
    });
    expect(
      (
        await prisma.serviceOrder.findUniqueOrThrow({
          where: { id: s.orderId },
          select: { status: true },
        })
      ).status,
    ).toBe("COMPLETED");
  });

  it("responder o item OPCIONAL não libera enquanto o obrigatório estiver pendente", async () => {
    await seedTemplate();
    await policy({ requireChecklist: true });
    const s = await scenario();

    const checklist = await getOrderChecklist(fixture.companyA.id, s.orderId);
    const opcional = checklist.find((i) => !i.required && i.type === "NUMBER")!;
    await answerChecklistItem(fixture.companyA.id, fixture.techA.id, s.orderId, {
      itemId: opcional.id,
      expectedOrderVersion: await orderVersionOf(s.orderId),
      valueNumber: -21.4,
    });

    const versaoAntes = await orderVersionOf(s.orderId);
    const error = await expectDomainError(
      () =>
        completeServiceOrder(fixture.companyA.id, fixture.techA.id, s.orderId, {
          expectedOrderVersion: versaoAntes,
          expectedExecutionVersion: s.executionVersion,
        }),
      400,
    );
    const pendencies = (error as CompletionBlockedError).pendencies;
    expect(pendencies.map((p) => p.code)).toContain("CHECKLIST_ITEM_PENDING");

    // A pendência aponta o item CERTO — é o que leva o técnico direto a ele.
    const obrigatorio = checklist.find((i) => i.required)!;
    expect(
      pendencies.find((p) => p.code === "CHECKLIST_ITEM_PENDING")?.itemId,
    ).toBe(obrigatorio.id);

    // E a recusa não sela nada nem consome a versão.
    expect(
      await prisma.serviceOrderCompletion.count({
        where: { serviceOrderId: s.orderId },
      }),
    ).toBe(0);
    expect(await orderVersionOf(s.orderId)).toBe(versaoAntes);
  });

  it("dois obrigatórios pendentes viram DUAS pendências, e uma resposta só não fecha", async () => {
    await seedTemplate([
      { label: "Cabo testado?", type: "BOOLEAN", required: true },
      { label: "Rota do cabo descrita", type: "TEXT", required: true },
    ]);
    await policy({ requireChecklist: true });
    const s = await scenario();

    const primeiro = await expectDomainError(
      () =>
        completeServiceOrder(fixture.companyA.id, fixture.techA.id, s.orderId, {
          expectedOrderVersion: s.orderVersion,
          expectedExecutionVersion: s.executionVersion,
        }),
      400,
    );
    expect(
      (primeiro as CompletionBlockedError).pendencies.filter(
        (p) => p.code === "CHECKLIST_ITEM_PENDING",
      ),
    ).toHaveLength(2);

    const checklist = await getOrderChecklist(fixture.companyA.id, s.orderId);
    await answerChecklistItem(fixture.companyA.id, fixture.techA.id, s.orderId, {
      itemId: checklist[0].id,
      expectedOrderVersion: await orderVersionOf(s.orderId),
      valueBoolean: true,
    });

    const versaoDepoisDaPrimeiraResposta = await orderVersionOf(s.orderId);
    const segundo = await expectDomainError(
      () =>
        completeServiceOrder(fixture.companyA.id, fixture.techA.id, s.orderId, {
          expectedOrderVersion: versaoDepoisDaPrimeiraResposta,
          expectedExecutionVersion: s.executionVersion,
        }),
      400,
    );
    expect(
      (segundo as CompletionBlockedError).pendencies.filter(
        (p) => p.code === "CHECKLIST_ITEM_PENDING",
      ),
    ).toHaveLength(1);

    // Respondido o segundo, fecha.
    await answerChecklistItem(fixture.companyA.id, fixture.techA.id, s.orderId, {
      itemId: checklist[1].id,
      expectedOrderVersion: await orderVersionOf(s.orderId),
      valueText: "Pelo forro, saindo na sala.",
    });
    await completeServiceOrder(fixture.companyA.id, fixture.techA.id, s.orderId, {
      expectedOrderVersion: await orderVersionOf(s.orderId),
      expectedExecutionVersion: s.executionVersion,
    });
    expect(
      (
        await prisma.serviceOrder.findUniqueOrThrow({
          where: { id: s.orderId },
          select: { status: true },
        })
      ).status,
    ).toBe("COMPLETED");
  });

  it("item PHOTO é satisfeito pela evidência, não por uma resposta", async () => {
    await putChecklistTemplate(fixture.companyA.id, fixture.adminA.id, {
      serviceOrderTypeId: fixture.typeA.id,
      name: "Checklist com foto",
      items: [
        {
          label: "Foto da ONU",
          type: "PHOTO",
          required: true,
          evidenceCategory: "ONU_ONT",
        },
      ],
    });
    await policy({ requireChecklist: true });
    const s = await scenario();

    const checklist = await getOrderChecklist(fixture.companyA.id, s.orderId);
    // Não é respondível: marcar "sim, tirei" sem a foto existir seria mentira.
    await expectDomainError(
      () =>
        answerChecklistItem(fixture.companyA.id, fixture.techA.id, s.orderId, {
          itemId: checklist[0].id,
          expectedOrderVersion: s.orderVersion,
          valueBoolean: true,
        }),
      400,
    );

    await addEvidence(fixture.companyA.id, fixture.techA.id, s.orderId, {
      data: PNG,
      declaredMimeType: "image/png",
      originalName: "onu.png",
      expectedOrderVersion: await orderVersionOf(s.orderId),
      category: "ONU_ONT",
    });

    await completeServiceOrder(fixture.companyA.id, fixture.techA.id, s.orderId, {
      expectedOrderVersion: await orderVersionOf(s.orderId),
      expectedExecutionVersion: s.executionVersion,
    });
    const order = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: s.orderId },
    });
    expect(order.status).toBe("COMPLETED");
  });

  it("política de outra empresa não é aplicável", async () => {
    await expectDomainError(
      () =>
        putCompletionPolicy(fixture.companyB.id, fixture.adminB.id, fixture.typeA.id, {
          requireChecklist: true,
          requireSignature: true,
          requireMaterials: false,
          requireEquipment: false,
          requireCheckIn: false,
          minEvidenceCount: 0,
          requiredEvidenceCategories: [],
        }),
      404,
    );
  });
});

describe("Conclusão — transação, CAS e snapshot", () => {
  it("grava o snapshot de fechamento na mesma transação", async () => {
    const { item } = await seedStock(50);
    const s = await scenario();
    await consumeInventoryForOrder(fixture.companyA.id, fixture.techA.id, s.orderId, {
      itemId: item.id,
      quantity: 12,
      expectedOrderVersion: s.orderVersion,
    });
    await addServiceOrderEquipment(fixture.companyA.id, fixture.techA.id, s.orderId, {
      ...(await comEtiqueta(s.orderId)),
      equipmentType: "ONU",
      serial: "SNAPSHOT0001",
    });

    await completeServiceOrder(fixture.companyA.id, fixture.techA.id, s.orderId, {
      expectedOrderVersion: await orderVersionOf(s.orderId),
      expectedExecutionVersion: s.executionVersion,
    });

    const completion = await prisma.serviceOrderCompletion.findUniqueOrThrow({
      where: { serviceOrderId: s.orderId },
    });
    expect(completion.contentHash).toHaveLength(64);
    const snapshot = completion.snapshot as Record<string, unknown>;
    expect((snapshot.materials as unknown[])).toHaveLength(1);
    expect((snapshot.equipments as unknown[])).toHaveLength(1);
    expect(completion.technicianId).toBe(s.technicianId);
  });

  it("recusa conclusão com versão velha", async () => {
    const s = await scenario();
    await expectDomainError(
      () =>
        completeServiceOrder(fixture.companyA.id, fixture.techA.id, s.orderId, {
          expectedOrderVersion: s.orderVersion - 1,
          expectedExecutionVersion: s.executionVersion,
        }),
      409,
    );
  });

  it("recusa conclusão com versão de execução velha", async () => {
    const s = await scenario();
    await expectDomainError(
      () =>
        completeServiceOrder(fixture.companyA.id, fixture.techA.id, s.orderId, {
          expectedOrderVersion: s.orderVersion,
          expectedExecutionVersion: s.executionVersion + 5,
        }),
      409,
    );
  });

  it("segunda conclusão é recusada", async () => {
    const s = await scenario();
    await completeServiceOrder(fixture.companyA.id, fixture.techA.id, s.orderId, {
      expectedOrderVersion: s.orderVersion,
      expectedExecutionVersion: s.executionVersion,
    });

    const afterComplete = await orderVersionOf(s.orderId);
    await expectDomainError(
      () =>
        completeServiceOrder(fixture.companyA.id, fixture.techA.id, s.orderId, {
          expectedOrderVersion: afterComplete,
          expectedExecutionVersion: s.executionVersion + 1,
        }),
      409,
    );

    const completions = await prisma.serviceOrderCompletion.count({
      where: { serviceOrderId: s.orderId },
    });
    expect(completions).toBe(1);
  });

  it("duas conclusões concorrentes produzem exatamente uma", async () => {
    const s = await scenario();
    const results = await Promise.allSettled([
      completeServiceOrder(fixture.companyA.id, fixture.techA.id, s.orderId, {
        expectedOrderVersion: s.orderVersion,
        expectedExecutionVersion: s.executionVersion,
      }),
      completeServiceOrder(fixture.companyA.id, fixture.techA.id, s.orderId, {
        expectedOrderVersion: s.orderVersion,
        expectedExecutionVersion: s.executionVersion,
      }),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      await prisma.serviceOrderCompletion.count({
        where: { serviceOrderId: s.orderId },
      }),
    ).toBe(1);
    expect(
      await prisma.serviceOrderEvent.count({
        where: { serviceOrderId: s.orderId, event: "OS_COMPLETED" },
      }),
    ).toBe(1);
  });

  it("técnico não conclui OS alheia", async () => {
    await ensureTechnician(fixture.techA.id);
    const alheia = await scenario({ userId: fixture.techB.id });
    await expectDomainError(
      () =>
        completeServiceOrder(fixture.companyA.id, fixture.techA.id, alheia.orderId, {
          expectedOrderVersion: alheia.orderVersion,
          expectedExecutionVersion: alheia.executionVersion,
        }),
      404,
    );
  });

  it("empresa B não conclui OS da empresa A", async () => {
    const s = await scenario();
    await expectDomainError(
      () =>
        completeServiceOrder(fixture.companyB.id, fixture.techA.id, s.orderId, {
          expectedOrderVersion: s.orderVersion,
          expectedExecutionVersion: s.executionVersion,
        }),
      404,
    );
  });

  it("uma pendência não deixa efeito colateral gravado", async () => {
    await putCompletionPolicy(
      fixture.companyA.id,
      fixture.adminA.id,
      fixture.typeA.id,
      {
        requireChecklist: false,
        requireSignature: true,
        requireMaterials: false,
        requireEquipment: false,
        requireCheckIn: false,
        minEvidenceCount: 0,
        requiredEvidenceCategories: [],
      },
    );
    const s = await scenario();
    const versionBefore = await orderVersionOf(s.orderId);

    await expectDomainError(
      () =>
        completeServiceOrder(fixture.companyA.id, fixture.techA.id, s.orderId, {
          expectedOrderVersion: versionBefore,
          expectedExecutionVersion: s.executionVersion,
        }),
      400,
    );

    // A transação inteira volta atrás: nada de OS meio concluída.
    const order = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: s.orderId },
    });
    expect(order.status).toBe("IN_PROGRESS");
    expect(order.completedAt).toBeNull();
    expect(order.version).toBe(versionBefore);
    expect(
      await prisma.serviceOrderCompletion.count({
        where: { serviceOrderId: s.orderId },
      }),
    ).toBe(0);
  });
});
