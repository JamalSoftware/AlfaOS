import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  AccessProfile,
  type EvidenceCategory,
  type EvidenceStatus,
  type Prisma,
  type ServiceOrderStatus,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { createCto } from "@/lib/cto";
import {
  connectCustomerToPort,
  disconnectCustomer,
  moveCustomerToPort,
} from "@/lib/cto-connections";
import {
  applyImportedCustomerLocation,
  confirmCustomerLocation,
  correctCustomerLocation,
} from "@/lib/customer-locations";
import {
  CUSTOMER_TIMELINE_MAX,
  CUSTOMER_TIMELINE_PAGE_SIZE,
  TIMELINE_OBSERVATIONS_MAX,
  getCustomerTimeline,
  loadCustomerTimeline,
  parseTimelineLimit,
  sortTimelineItems,
  type CustomerTimelineItem,
  type CustomerTimelineViewer,
} from "@/lib/customer-timeline";
import { seedTestData, type TestFixture } from "./helpers";

/**
 * # TL-1 — a timeline do cliente
 *
 * A timeline não cria fatos: cada item é lido da tabela que já é a autoridade
 * dele. Por isso os testes que importam passam pelos ESCRITORES reais onde a
 * classificação depende do que eles gravam (vínculo de porta, localização) —
 * se um escritor mudar o que grava, a timeline tem de quebrar aqui, e não
 * mostrar outra coisa em silêncio.
 *
 * As demais fontes são linhas montadas com instantes controlados, porque o que
 * se prova nelas é QUAL coluna é o instante do fato, e isso exige que as
 * colunas candidatas difiram.
 */

let fixture: TestFixture;
let tecnicoA: { id: string };
let clienteA: { id: string };
let numero = 0;

const TZ_A = "America/Manaus";
const BASE = new Date("2026-09-10T12:00:00.000Z");
const MIN = 60_000;
/** Um instante a `m` minutos da base. */
const t = (m: number) => new Date(BASE.getTime() + m * MIN);

const comoAdmin = () => ({ companyId: fixture.companyA.id, profile: AccessProfile.ADMIN });
const comoDespacho = () => ({
  companyId: fixture.companyA.id,
  profile: AccessProfile.DISPATCHER,
});

beforeEach(async () => {
  fixture = await seedTestData();
  numero = 0;
  await prisma.company.update({
    where: { id: fixture.companyA.id },
    data: { timezone: TZ_A, ctoNetworkEnabled: true },
  });
  await prisma.company.update({
    where: { id: fixture.companyB.id },
    data: { ctoNetworkEnabled: true },
  });
  tecnicoA = await prisma.technician.create({
    data: { companyId: fixture.companyA.id, userId: fixture.techA.id },
  });
  clienteA = await cliente("QA TL Cliente");
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

async function cliente(nome: string, companyId?: string) {
  return prisma.customer.create({
    data: { companyId: companyId ?? fixture.companyA.id, name: nome },
  });
}

async function os(
  customerId: string,
  opcoes: {
    companyId?: string;
    status?: ServiceOrderStatus;
    technicianId?: string | null;
    subtype?: string | null;
  } = {},
) {
  numero += 1;
  const status = opcoes.status ?? "ASSIGNED";
  return prisma.serviceOrder.create({
    data: {
      companyId: opcoes.companyId ?? fixture.companyA.id,
      number: 9000 + numero,
      customerId,
      type: "Instalação",
      subtype: opcoes.subtype ?? null,
      description: "QA TL",
      status,
      technicianId: opcoes.technicianId === undefined ? tecnicoA.id : opcoes.technicianId,
      ...(status === "IN_PROGRESS" ? { startedAt: BASE } : {}),
      ...(status === "COMPLETED" ? { startedAt: BASE, completedAt: BASE } : {}),
    },
  });
}

async function evento(
  serviceOrderId: string,
  event: string,
  em: Date,
  opcoes: { companyId?: string; userId?: string | null; metadata?: Prisma.InputJsonValue } = {},
) {
  return prisma.serviceOrderEvent.create({
    data: {
      companyId: opcoes.companyId ?? fixture.companyA.id,
      serviceOrderId,
      userId: opcoes.userId === undefined ? fixture.adminA.id : opcoes.userId,
      event,
      metadata: opcoes.metadata,
      createdAt: em,
    },
  });
}

async function foto(
  serviceOrderId: string,
  category: EvidenceCategory,
  em: Date,
  opcoes: { companyId?: string; status?: EvidenceStatus } = {},
) {
  numero += 1;
  return prisma.serviceOrderEvidence.create({
    data: {
      companyId: opcoes.companyId ?? fixture.companyA.id,
      serviceOrderId,
      uploadedByUserId: fixture.techA.id,
      category,
      storageKey: `qa-tl/${numero}-${Date.now()}.jpg`,
      originalName: "qa-tl.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 10,
      createdAt: em,
      status: opcoes.status ?? "COMMITTED",
    },
  });
}

async function contato(serviceOrderId: string, em: Date, companyId?: string) {
  return prisma.serviceOrderContactAttempt.create({
    data: {
      companyId: companyId ?? fixture.companyA.id,
      serviceOrderId,
      technicianId: tecnicoA.id,
      channel: "WHATSAPP",
      result: "NO_ANSWER",
      notes: "nota interna do técnico",
      attemptedAt: em,
      createdAt: t(9999),
    },
  });
}

async function caixa(nome: string, companyId?: string) {
  const empresa = companyId ?? fixture.companyA.id;
  const cto = await createCto(
    empresa,
    empresa === fixture.companyA.id ? fixture.adminA.id : fixture.adminB.id,
    { name: nome, capacity: 8 },
  );
  const porta = async (n: number) =>
    prisma.cTOPort.findFirstOrThrow({ where: { ctoId: cto.id, number: n } });
  return { cto, porta };
}

const web = () => ({
  companyId: fixture.companyA.id,
  provenance: { source: "WEB" as const, actorUserId: fixture.adminA.id },
});

async function timeline(
  viewer: CustomerTimelineViewer = comoAdmin(),
  customerId = clienteA.id,
  limit = CUSTOMER_TIMELINE_PAGE_SIZE,
) {
  return getCustomerTimeline(viewer, customerId, limit);
}

const kinds = (items: CustomerTimelineItem[]) => items.map((i) => i.kind);
const doTipo = <K extends CustomerTimelineItem["kind"]>(items: CustomerTimelineItem[], kind: K) =>
  items.filter((i): i is Extract<CustomerTimelineItem, { kind: K }> => i.kind === kind);

// ---------------------------------------------------------------------------
// TL-DOM — o contrato
// ---------------------------------------------------------------------------

describe("TL-DOM — ordem, tenant, perfil, instante, fuso, duplicação e fonte", () => {
  it("TL-DOM-01 — mais recente primeiro, atravessando fontes diferentes", async () => {
    const ordem = await os(clienteA.id);
    await evento(ordem.id, "SERVICE_ORDER_CREATED", t(0));
    await evento(ordem.id, "TECHNICIAN_ASSIGNED", t(10), {
      metadata: { technicianName: "Tecnico Alfa" },
    });
    await contato(ordem.id, t(20));
    await evento(ordem.id, "OS_STARTED", t(30));
    await foto(ordem.id, "CTO", t(40));
    await evento(ordem.id, "OS_COMPLETED", t(50));

    const { items } = await timeline();

    expect(kinds(items)).toEqual([
      "OS_COMPLETED",
      "PHOTOS",
      "OS_STARTED",
      "CONTACT_ATTEMPT",
      "OS_ASSIGNED",
      "OS_CREATED",
    ]);
    for (let i = 1; i < items.length; i++) {
      expect(items[i - 1].occurredAt.getTime()).toBeGreaterThanOrEqual(
        items[i].occurredAt.getTime(),
      );
    }
  });

  it("TL-DOM-02 — empate no mesmo instante é resolvido pelo id do item, sempre igual", async () => {
    const ordem = await os(clienteA.id);
    const mesmo = t(5);
    await evento(ordem.id, "SERVICE_ORDER_CREATED", mesmo);
    await evento(ordem.id, "TECHNICIAN_ASSIGNED", mesmo);
    await contato(ordem.id, mesmo);
    await contato(ordem.id, mesmo);
    await foto(ordem.id, "SPEED_TEST", mesmo);

    const primeira = await timeline();
    const segunda = await timeline();
    const ids = primeira.items.map((i) => i.id);

    expect(ids).toHaveLength(5);
    expect(segunda.items.map((i) => i.id)).toEqual(ids);
    expect(ids).toEqual([...ids].sort().reverse());

    // A função pura não depende da ordem de chegada.
    const embaralhado = [...primeira.items].reverse();
    expect(sortTimelineItems(embaralhado).map((i) => i.id)).toEqual(ids);
  });

  it("TL-DOM-03 — tenant: a empresa B não entra, nem com uma OS que aponte para o cliente de A", async () => {
    // Controle positivo: a OS de A aparece.
    const deA = await os(clienteA.id);
    await evento(deA.id, "SERVICE_ORDER_CREATED", t(1));

    // O vetor da DQ-7.1: `customerId` é FK simples, então a empresa B consegue
    // gravar uma OS dela apontando para o cliente de A.
    const tecnicoB = await prisma.technician.create({
      data: {
        companyId: fixture.companyB.id,
        userId: (
          await prisma.user.create({
            data: {
              companyId: fixture.companyB.id,
              name: "Tecnico B",
              email: `tl.b.${Date.now()}@sintetico.local`,
              profile: "TECHNICIAN",
              passwordHash: "x",
            },
          })
        ).id,
      },
    });
    const cruzada = await os(clienteA.id, {
      companyId: fixture.companyB.id,
      technicianId: tecnicoB.id,
    });
    await evento(cruzada.id, "SERVICE_ORDER_CREATED", t(2), {
      companyId: fixture.companyB.id,
      userId: fixture.adminB.id,
    });
    await prisma.serviceOrderCheckIn.create({
      data: {
        companyId: fixture.companyB.id,
        serviceOrderId: cruzada.id,
        technicianId: tecnicoB.id,
        source: "UNAVAILABLE",
        checkedInAt: t(3),
      },
    });
    await foto(cruzada.id, "CTO", t(4), { companyId: fixture.companyB.id });
    await foto(cruzada.id, "SPEED_TEST", t(5), { companyId: fixture.companyB.id });
    await prisma.serviceOrderEquipment.create({
      data: {
        companyId: fixture.companyB.id,
        serviceOrderId: cruzada.id,
        customerId: clienteA.id,
        equipmentType: "ONU",
        createdAt: t(6),
      },
    });
    await prisma.customerLocationHistory.create({
      data: {
        companyId: fixture.companyB.id,
        customerId: clienteA.id,
        kind: "ADDRESS",
        reason: "INCORRECT_ADDRESS",
        changedByUserId: fixture.adminB.id,
        createdAt: t(7),
      },
    });
    const { porta } = await caixa("QA TL B", fixture.companyB.id);
    await prisma.customerNetworkConnection.create({
      data: {
        companyId: fixture.companyB.id,
        customerId: clienteA.id,
        ctoPortId: (await porta(1)).id,
        source: "WEB",
        connectedAt: t(8),
      },
    });

    const deA_ = await timeline();
    expect(deA_.items.map((i) => i.id)).toEqual([expect.stringMatching(/^os-event:/)]);
    expect(deA_.items[0].order?.id).toBe(deA.id);

    // E quem é da empresa B não enxerga o cliente de A — nem as próprias
    // linhas que apontam para ele.
    const deB = await getCustomerTimeline(
      { companyId: fixture.companyB.id, profile: AccessProfile.ADMIN },
      clienteA.id,
      CUSTOMER_TIMELINE_PAGE_SIZE,
    );
    expect(deB.items).toEqual([]);
    expect(deB.hasMore).toBe(false);
  });

  it("TL-DOM-04 — CTO e porta só para ADMIN com a capability ligada; o DISPATCHER vê o resto", async () => {
    const ordem = await os(clienteA.id);
    await evento(ordem.id, "SERVICE_ORDER_CREATED", t(1));
    const { porta } = await caixa("QA TL Caixa");
    await connectCustomerToPort(web(), { customerId: clienteA.id, ctoPortId: (await porta(2)).id });

    // Controle positivo.
    const admin = await timeline(comoAdmin());
    expect(kinds(admin.items)).toContain("NETWORK_CONNECTED");

    const despacho = await timeline(comoDespacho());
    expect(kinds(despacho.items)).toEqual(["OS_CREATED"]);

    await prisma.company.update({
      where: { id: fixture.companyA.id },
      data: { ctoNetworkEnabled: false },
    });
    const semCapability = await timeline(comoAdmin());
    expect(kinds(semCapability.items)).toEqual(["OS_CREATED"]);
  });

  it("TL-DOM-04b — sem permissão de rede, a consulta de vínculo nem é feita", async () => {
    const vinculos = vi.spyOn(prisma.customerNetworkConnection, "findMany");
    await timeline(comoDespacho());
    expect(vinculos).not.toHaveBeenCalled();
    await timeline(comoAdmin());
    expect(vinculos).toHaveBeenCalledTimes(2);
  });

  it("TL-DOM-05 — o instante é o do FATO, não o de gravação nem o de edição", async () => {
    const ordem = await os(clienteA.id, { status: "IN_PROGRESS" });
    await prisma.serviceOrderCheckIn.create({
      data: {
        companyId: fixture.companyA.id,
        serviceOrderId: ordem.id,
        technicianId: tecnicoA.id,
        source: "DEVICE_GPS",
        checkedInAt: t(11),
        createdAt: t(500),
      },
    });
    await contato(ordem.id, t(12));
    await prisma.serviceOrderImpediment.create({
      data: {
        companyId: fixture.companyA.id,
        serviceOrderId: ordem.id,
        technicianId: tecnicoA.id,
        reason: "NO_ACCESS",
        reportedAt: t(13),
        createdAt: t(501),
      },
    });
    await prisma.serviceOrderSignature.create({
      data: {
        companyId: fixture.companyA.id,
        serviceOrderId: ordem.id,
        signerName: "QA TL Assinante",
        storageKey: `qa-tl/assinatura-${Date.now()}.png`,
        mimeType: "image/png",
        sizeBytes: 10,
        signedAt: t(14),
        capturedByUserId: fixture.techA.id,
      },
    });
    const aparelho = await prisma.serviceOrderEquipment.create({
      data: {
        companyId: fixture.companyA.id,
        serviceOrderId: ordem.id,
        customerId: clienteA.id,
        equipmentType: "ONU",
        createdAt: t(15),
      },
    });
    // Editar o equipamento move `updatedAt`, e não o instante da instalação.
    await prisma.serviceOrderEquipment.update({
      where: { id: aparelho.id },
      data: { model: "HG8245" },
    });

    const { items } = await timeline();
    const em = (kind: CustomerTimelineItem["kind"]) =>
      items.find((i) => i.kind === kind)?.occurredAt.toISOString();

    expect(em("VISIT")).toBe(t(11).toISOString());
    expect(em("CONTACT_ATTEMPT")).toBe(t(12).toISOString());
    expect(em("IMPEDIMENT")).toBe(t(13).toISOString());
    expect(em("SIGNATURE")).toBe(t(14).toISOString());
    expect(em("EQUIPMENT_INSTALLED")).toBe(t(15).toISOString());
  });

  it("TL-DOM-06 — o fuso devolvido é o da EMPRESA, não o do processo", async () => {
    const processo = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(processo).not.toBe(TZ_A); // pré-condição: senão o teste não distingue

    const a = await timeline();
    expect(a.timezone).toBe(TZ_A);

    await prisma.company.update({
      where: { id: fixture.companyA.id },
      data: { timezone: "Asia/Tokyo" },
    });
    expect((await timeline()).timezone).toBe("Asia/Tokyo");
  });

  it("TL-DOM-07 — nada duplica: evento de OS que repete fato de tabela própria fica fora", async () => {
    const ordem = await os(clienteA.id, { status: "IN_PROGRESS" });
    // A operação de campo grava a linha E um ServiceOrderEvent CTO_PORT_*.
    const { porta } = await caixa("QA TL Campo");
    await connectCustomerToPort(
      {
        companyId: fixture.companyA.id,
        provenance: {
          source: "FIELD",
          actorUserId: fixture.techA.id,
          technicianId: tecnicoA.id,
          serviceOrderId: ordem.id,
        },
      },
      { customerId: clienteA.id, ctoPortId: (await porta(4)).id },
    );
    // Eventos que repetem o fato de uma tabela própria.
    for (const codigo of [
      "CHECKED_IN",
      "CONTACT_ATTEMPTED",
      "IMPEDIMENT_REPORTED",
      "EQUIPMENT_INSTALLED",
      "SIGNATURE_CAPTURED",
      "LOCATION_CONFIRMED",
      "PRIORITY_CHANGED",
      "MATERIAL_USED",
    ]) {
      await evento(ordem.id, codigo, t(1));
    }
    await evento(ordem.id, "OS_STARTED", t(2));
    // Três fotos de uma OS são UM item.
    await foto(ordem.id, "CTO", t(3));
    await foto(ordem.id, "CTO", t(4));
    await foto(ordem.id, "ROUTER", t(5));

    expect(
      await prisma.serviceOrderEvent.count({
        where: { serviceOrderId: ordem.id, event: "CTO_PORT_CONNECTED" },
      }),
    ).toBe(1);

    const { items } = await timeline();
    expect(kinds(items).sort()).toEqual(["NETWORK_CONNECTED", "OS_STARTED", "PHOTOS"].sort());
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
  });

  it("TL-DOM-08 — cada item vem da sua fonte, com o conteúdo dela", async () => {
    const ordem = await os(clienteA.id, { status: "COMPLETED", subtype: "Fibra" });
    await evento(ordem.id, "SERVICE_ORDER_IMPORTED", t(0), { userId: null });
    await evento(ordem.id, "TECHNICIAN_CHANGED", t(1), {
      metadata: { technicianName: "Tecnico Alfa", previousTechnicianName: "Tecnico Beta" },
    });
    await evento(ordem.id, "OS_COMPLETED", t(2), { userId: fixture.techA.id });
    await prisma.serviceOrderExecution.create({
      data: {
        companyId: fixture.companyA.id,
        serviceOrderId: ordem.id,
        notes: "  Cliente   pediu\n para voltar sábado. " + "x".repeat(400),
      },
    });

    const { items } = await timeline();
    const [concluida, alterada, importada] = items;

    expect(importada).toMatchObject({
      kind: "OS_IMPORTED",
      actorName: null,
      order: { id: ordem.id, number: ordem.number, type: "Instalação", subtype: "Fibra" },
    });
    expect(alterada).toMatchObject({
      kind: "OS_REASSIGNED",
      technicianName: "Tecnico Alfa",
      previousTechnicianName: "Tecnico Beta",
      actorName: "Administrador Alfa",
    });
    expect(concluida.kind).toBe("OS_COMPLETED");
    const obs = (concluida as Extract<CustomerTimelineItem, { kind: "OS_COMPLETED" }>).observations;
    expect(obs?.startsWith("Cliente pediu para voltar sábado.")).toBe(true);
    expect(obs?.length).toBe(TIMELINE_OBSERVATIONS_MAX);
    expect(obs?.endsWith("…")).toBe(true);
    expect(concluida.actorName).toBe("Tecnico Alfa");
  });
});

// ---------------------------------------------------------------------------
// uma fonte por vez
// ---------------------------------------------------------------------------

describe("TL-SRC — cada fonte aparece, com conteúdo, instante e dono certos", () => {
  it("TL-SRC-01 — visita: check-in com e sem a localização do aparelho", async () => {
    const com = await os(clienteA.id);
    const sem = await os(clienteA.id);
    for (const [ordem, source, m] of [
      [com, "DEVICE_GPS", 1],
      [sem, "UNAVAILABLE", 2],
    ] as const) {
      await prisma.serviceOrderCheckIn.create({
        data: {
          companyId: fixture.companyA.id,
          serviceOrderId: ordem.id,
          technicianId: tecnicoA.id,
          source,
          latitude: -3.1,
          longitude: -60.02,
          checkedInAt: t(m),
        },
      });
    }
    const outro = await cliente("QA TL Outro");
    const doOutro = await os(outro.id);
    await prisma.serviceOrderCheckIn.create({
      data: {
        companyId: fixture.companyA.id,
        serviceOrderId: doOutro.id,
        technicianId: tecnicoA.id,
        source: "DEVICE_GPS",
        checkedInAt: t(3),
      },
    });

    const visitas = doTipo((await timeline()).items, "VISIT");
    expect(visitas.map((v) => [v.order.id, v.withDeviceLocation, v.actorName])).toEqual([
      [sem.id, false, "Tecnico Alfa"],
      [com.id, true, "Tecnico Alfa"],
    ]);
    // Nenhuma coordenada viaja no item.
    expect(JSON.stringify(visitas)).not.toMatch(/-3\.1|-60\.02|latitude|longitude/);
  });

  it("TL-SRC-02 — contato e impedimento: canal, resultado e motivo; a nota do técnico não", async () => {
    const ordem = await os(clienteA.id);
    await contato(ordem.id, t(1));
    await prisma.serviceOrderImpediment.create({
      data: {
        companyId: fixture.companyA.id,
        serviceOrderId: ordem.id,
        technicianId: tecnicoA.id,
        reason: "CUSTOMER_ABSENT",
        notes: "nota interna do técnico",
        reportedAt: t(2),
      },
    });
    const outra = await os((await cliente("QA TL Outro")).id);
    await contato(outra.id, t(3));

    const { items } = await timeline();
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: "IMPEDIMENT", reason: "CUSTOMER_ABSENT" });
    expect(items[1]).toMatchObject({
      kind: "CONTACT_ATTEMPT",
      channel: "WHATSAPP",
      result: "NO_ANSWER",
      actorName: "Tecnico Alfa",
    });
    expect(JSON.stringify(items)).not.toContain("nota interna");
  });

  it("TL-SRC-03 — fotos: um item por OS, no instante da última, sem as temporárias e sem as medições", async () => {
    const ordem = await os(clienteA.id);
    await foto(ordem.id, "CTO", t(1));
    await foto(ordem.id, "CTO", t(2));
    await foto(ordem.id, "ROUTER", t(3));
    await foto(ordem.id, "EQUIPMENT_LABEL", t(9), { status: "TEMPORARY" });
    await foto(ordem.id, "SPEED_TEST", t(4));
    await foto(ordem.id, "OPTICAL_READING", t(5));
    await foto(ordem.id, "OPTICAL_READING", t(6), { status: "TEMPORARY" });
    const outra = await os((await cliente("QA TL Outro")).id);
    await foto(outra.id, "CTO", t(7));

    const { items } = await timeline();
    expect(kinds(items)).toEqual(["OPTICAL_READING", "SPEED_TEST", "PHOTOS"]);
    const [fotos] = doTipo(items, "PHOTOS");
    expect(fotos.occurredAt.toISOString()).toBe(t(3).toISOString());
    expect(fotos.total).toBe(3);
    expect(fotos.categories).toEqual([
      { category: "CTO", count: 2 },
      { category: "ROUTER", count: 1 },
    ]);
    expect(fotos.id).toBe(`photos:${ordem.id}`);
    expect(items.find((i) => i.kind === "SPEED_TEST")?.occurredAt.toISOString()).toBe(
      t(4).toISOString(),
    );
    // Nenhuma chave de armazenamento chega à tela.
    expect(JSON.stringify(items)).not.toContain("qa-tl/");
  });

  it("TL-SRC-04 — assinatura e equipamento; equipamento removido no atendimento não aparece", async () => {
    const ordem = await os(clienteA.id, { status: "IN_PROGRESS" });
    await prisma.serviceOrderSignature.create({
      data: {
        companyId: fixture.companyA.id,
        serviceOrderId: ordem.id,
        signerName: "Maria QA TL",
        storageKey: `qa-tl/sig-${Date.now()}.png`,
        mimeType: "image/png",
        sizeBytes: 10,
        signedAt: t(3),
        capturedByUserId: fixture.techA.id,
      },
    });
    await prisma.serviceOrderEquipment.create({
      data: {
        companyId: fixture.companyA.id,
        serviceOrderId: ordem.id,
        customerId: clienteA.id,
        equipmentType: "Roteador",
        manufacturer: "TP-Link",
        model: "Archer C6",
        serial: "QA-TL-SERIE-1",
        macAddress: "AA:BB:CC:DD:EE:01",
        installedByUserId: fixture.techA.id,
        createdAt: t(1),
      },
    });
    const removido = await prisma.serviceOrderEquipment.create({
      data: {
        companyId: fixture.companyA.id,
        serviceOrderId: ordem.id,
        customerId: clienteA.id,
        equipmentType: "ONU",
        createdAt: t(2),
      },
    });
    await prisma.serviceOrderEquipment.delete({ where: { id: removido.id } });

    const { items } = await timeline();
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      kind: "SIGNATURE",
      signerName: "Maria QA TL",
      actorName: "Tecnico Alfa",
    });
    expect(items[1]).toMatchObject({
      kind: "EQUIPMENT_INSTALLED",
      equipmentType: "Roteador",
      manufacturer: "TP-Link",
      model: "Archer C6",
      serial: "QA-TL-SERIE-1",
    });
    // O MAC não é contexto operacional da história.
    expect(JSON.stringify(items)).not.toContain("AA:BB:CC");
  });

  it("TL-SRC-05 — vínculo de rede: entradas, saídas e VOLTA à mesma porta são itens distintos", async () => {
    const { cto, porta } = await caixa("QA TL Rede");
    const p3 = await porta(3);
    const p5 = await porta(5);

    const primeira = await connectCustomerToPort(web(), { customerId: clienteA.id, ctoPortId: p3.id });
    await disconnectCustomer(web(), {
      customerId: clienteA.id,
      expectedConnectionId: primeira.id,
      reason: "  Cliente   suspenso  ",
    });
    const volta = await connectCustomerToPort(web(), { customerId: clienteA.id, ctoPortId: p3.id });
    const movida = await moveCustomerToPort(web(), {
      customerId: clienteA.id,
      expectedConnectionId: volta.id,
      targetCtoPortId: p5.id,
    });

    const linhas = await prisma.customerNetworkConnection.findMany({
      where: { customerId: clienteA.id },
    });
    expect(linhas).toHaveLength(3);

    const rede = (await timeline()).items.filter((i) => i.kind.startsWith("NETWORK_"));
    expect(rede.map((i) => i.id).sort()).toEqual(
      [
        `network:${primeira.id}:on`,
        `network:${primeira.id}:off`,
        `network:${volta.id}:on`,
        `network:${volta.id}:off`,
        `network:${movida.to.id}:on`,
      ].sort(),
    );
    for (const linha of linhas) {
      const on = rede.find((i) => i.id === `network:${linha.id}:on`);
      expect(on?.occurredAt.getTime()).toBe(linha.connectedAt.getTime());
      if (linha.disconnectedAt) {
        const off = rede.find((i) => i.id === `network:${linha.id}:off`);
        expect(off?.occurredAt.getTime()).toBe(linha.disconnectedAt.getTime());
      }
    }
    const saida = rede.find((i) => i.id === `network:${primeira.id}:off`);
    expect(saida).toMatchObject({
      cto: { id: cto.id, name: "QA TL Rede" },
      portNumber: 3,
      source: "WEB",
      reason: "Cliente suspenso",
      order: null,
    });
    // A entrada não carrega o motivo da saída.
    expect(
      (rede.find((i) => i.id === `network:${primeira.id}:on`) as { reason: string | null }).reason,
    ).toBeNull();
  });

  it("TL-SRC-06 — localização: os quatro escritores reais, classificados pelos dados e sem coordenada", async () => {
    const ordem = await os(clienteA.id, { status: "IN_PROGRESS" });
    const companyId = fixture.companyA.id;
    const versao = async () =>
      (await prisma.customerLocation.findFirstOrThrow({ where: { customerId: clienteA.id } })).version;

    // Cada passo tem de gravar exatamente UMA linha, e é ela que se confere —
    // pela diferença de conjuntos, sem depender da ordem de `createdAt`.
    const vistas = new Set<string>();
    const passos: { linha: string; kind: string; order: string | null }[] = [];
    async function passo(kind: string | null, order: string | null, fazer: () => Promise<unknown>) {
      await fazer();
      const novas = (
        await prisma.customerLocationHistory.findMany({
          where: { customerId: clienteA.id },
          select: { id: true },
        })
      ).filter((l) => !vistas.has(l.id));
      expect(novas).toHaveLength(kind === null ? 0 : 1);
      for (const l of novas) vistas.add(l.id);
      if (kind !== null) passos.push({ linha: novas[0].id, kind, order });
    }

    // 1. ponto inicial pela geocodificação — não gera linha de histórico
    await passo(null, null, () =>
      prisma.$transaction((tx) =>
        applyImportedCustomerLocation(tx, companyId, clienteA.id, {
          latitude: -3.1,
          longitude: -60.02,
          source: "GEOCODED",
        }),
      ),
    );
    // 2. a importação vence a geocodificação — ATUALIZA o ponto
    await passo("LOCATION_FROM_INTEGRATION", null, () =>
      prisma.$transaction((tx) =>
        applyImportedCustomerLocation(tx, companyId, clienteA.id, {
          latitude: -3.11,
          longitude: -60.03,
        }),
      ),
    );
    // 3. o técnico confirma em campo
    await passo("LOCATION_CONFIRMED", ordem.id, async () =>
      confirmCustomerLocation(companyId, fixture.techA.id, ordem.id, {
        expectedVersion: await versao(),
      }),
    );
    // 4. a importação traz outro ponto, longe — a verificada é PRESERVADA, e a
    //    linha grava o ponto do PROVEDOR como "novo"
    await passo("LOCATION_DIVERGENCE_FROM_INTEGRATION", null, () =>
      prisma.$transaction((tx) =>
        applyImportedCustomerLocation(tx, companyId, clienteA.id, {
          latitude: -3.2,
          longitude: -60.2,
        }),
      ),
    );
    // 5, 6, 7. correções em campo
    await passo("LOCATION_CORRECTED", ordem.id, async () =>
      correctCustomerLocation(companyId, fixture.techA.id, ordem.id, {
        expectedVersion: await versao(),
        reason: "INCORRECT_LOCATION",
        latitude: -3.12,
        longitude: -60.04,
      }),
    );
    await passo("ADDRESS_CORRECTED", ordem.id, async () =>
      correctCustomerLocation(companyId, fixture.techA.id, ordem.id, {
        expectedVersion: await versao(),
        reason: "INCORRECT_ADDRESS",
        address: { address: "Rua QA TL" },
      }),
    );
    await passo("LOCATION_AND_ADDRESS_CORRECTED", ordem.id, async () =>
      correctCustomerLocation(companyId, fixture.techA.id, ordem.id, {
        expectedVersion: await versao(),
        reason: "CUSTOMER_MOVED",
        latitude: -3.13,
        longitude: -60.05,
        address: { address: "Avenida QA TL" },
      }),
    );

    const { items } = await timeline();
    const porLinha = new Map(items.map((i) => [i.id, i]));
    expect(
      passos.map((p) => {
        const item = porLinha.get(`location:${p.linha}`);
        return [item?.kind, item?.order?.id ?? null];
      }),
    ).toEqual(passos.map((p) => [p.kind, p.order]));

    // Os eventos de OS que esses escritores gravam não viram item de novo.
    expect(items).toHaveLength(6);

    // Coordenada nenhuma, e nenhum texto de nota.
    const texto = JSON.stringify(items);
    expect(texto).not.toMatch(/-3\.1|-60\.0|-3\.2|-60\.2|latitude|longitude/);
    expect(texto).not.toContain("Divergência preservada");
  });

  it("TL-SRC-07 — correção para o MESMO ponto de uma localização já verificada continua sendo correção", async () => {
    const ordem = await os(clienteA.id, { status: "IN_PROGRESS" });
    const companyId = fixture.companyA.id;
    await correctCustomerLocation(companyId, fixture.techA.id, ordem.id, {
      expectedVersion: null,
      reason: "INCOMPLETE_REGISTRATION",
      latitude: -3.14,
      longitude: -60.06,
    });
    const versao = (
      await prisma.customerLocation.findFirstOrThrow({ where: { customerId: clienteA.id } })
    ).version;
    await correctCustomerLocation(companyId, fixture.techA.id, ordem.id, {
      expectedVersion: versao,
      reason: "OTHER",
      note: "conferido de novo",
      latitude: -3.14,
      longitude: -60.06,
    });

    expect(kinds((await timeline()).items)).toEqual(["LOCATION_CORRECTED", "LOCATION_CORRECTED"]);
  });
});

// ---------------------------------------------------------------------------
// página, limite, erro, consultas
// ---------------------------------------------------------------------------

describe("TL-PAGE — 50 por vez, até 500, sem duplicar nem pular", () => {
  it("TL-PAGE-01 — `?historico=` vira 50..500 em passos de 50", () => {
    expect(parseTimelineLimit(undefined)).toBe(50);
    expect(parseTimelineLimit(["100"])).toBe(50);
    expect(parseTimelineLimit("abc")).toBe(50);
    expect(parseTimelineLimit("Infinity")).toBe(50);
    expect(parseTimelineLimit("0")).toBe(50);
    expect(parseTimelineLimit("-100")).toBe(50);
    expect(parseTimelineLimit("50")).toBe(50);
    expect(parseTimelineLimit("51")).toBe(100);
    expect(parseTimelineLimit("100")).toBe(100);
    expect(parseTimelineLimit("9999")).toBe(CUSTOMER_TIMELINE_MAX);
  });

  it("TL-PAGE-02 — a página maior começa exatamente pela menor, com fontes intercaladas e empates", async () => {
    const ordem = await os(clienteA.id);
    // 70 eventos e 60 contatos, intercalados, com 20 instantes repetidos
    // entre as duas fontes — o corte tem de ser o mesmo da lista inteira.
    await prisma.serviceOrderEvent.createMany({
      data: Array.from({ length: 70 }, (_, i) => ({
        companyId: fixture.companyA.id,
        serviceOrderId: ordem.id,
        userId: fixture.adminA.id,
        event: "TECHNICIAN_ASSIGNED",
        createdAt: t(i * 2),
      })),
    });
    await prisma.serviceOrderContactAttempt.createMany({
      data: Array.from({ length: 60 }, (_, i) => ({
        companyId: fixture.companyA.id,
        serviceOrderId: ordem.id,
        technicianId: tecnicoA.id,
        channel: "PHONE_CALL" as const,
        result: "BUSY" as const,
        attemptedAt: i < 20 ? t(i * 2) : t(i * 2 + 1),
      })),
    });

    const tudo = await timeline(comoAdmin(), clienteA.id, CUSTOMER_TIMELINE_MAX);
    expect(tudo.items).toHaveLength(130);
    expect(tudo.hasMore).toBe(false);

    const p50 = await timeline(comoAdmin(), clienteA.id, 50);
    const p100 = await timeline(comoAdmin(), clienteA.id, 100);
    const p150 = await timeline(comoAdmin(), clienteA.id, 150);

    const ids = (x: { items: CustomerTimelineItem[] }) => x.items.map((i) => i.id);
    expect(ids(p50)).toEqual(ids(tudo).slice(0, 50));
    expect(ids(p100)).toEqual(ids(tudo).slice(0, 100));
    expect(ids(p100).slice(0, 50)).toEqual(ids(p50));
    expect(ids(p150)).toEqual(ids(tudo));
    expect(new Set(ids(p100)).size).toBe(100);
    expect([p50.hasMore, p100.hasMore, p150.hasMore]).toEqual([true, true, false]);
  });

  it("TL-PAGE-03 — no teto de 500, sobra item e `hasMore` diz isso", async () => {
    const ordem = await os(clienteA.id);
    await prisma.serviceOrderEvent.createMany({
      data: Array.from({ length: CUSTOMER_TIMELINE_MAX + 5 }, (_, i) => ({
        companyId: fixture.companyA.id,
        serviceOrderId: ordem.id,
        event: "TECHNICIAN_ASSIGNED",
        createdAt: t(i),
      })),
    });
    const r = await timeline(comoAdmin(), clienteA.id, parseTimelineLimit("100000"));
    expect(r.limit).toBe(CUSTOMER_TIMELINE_MAX);
    expect(r.items).toHaveLength(CUSTOMER_TIMELINE_MAX);
    expect(r.hasMore).toBe(true);
  });

  it("TL-PAGE-04 — toda fonte é lida com teto (`limit + 1`), e a segunda leva só pelos ids da primeira", async () => {
    const ordem = await os(clienteA.id);
    await evento(ordem.id, "OS_COMPLETED", t(1));
    await foto(ordem.id, "CTO", t(2));

    const leituras = [
      vi.spyOn(prisma.serviceOrderEvent, "findMany"),
      vi.spyOn(prisma.serviceOrderCheckIn, "findMany"),
      vi.spyOn(prisma.serviceOrderContactAttempt, "findMany"),
      vi.spyOn(prisma.serviceOrderImpediment, "findMany"),
      vi.spyOn(prisma.serviceOrderSignature, "findMany"),
      vi.spyOn(prisma.serviceOrderEquipment, "findMany"),
      vi.spyOn(prisma.customerNetworkConnection, "findMany"),
      vi.spyOn(prisma.customerLocationHistory, "findMany"),
    ];
    const evidencias = vi.spyOn(prisma.serviceOrderEvidence, "findMany");
    const grupos = vi.spyOn(prisma.serviceOrderEvidence, "groupBy");
    const execucoes = vi.spyOn(prisma.serviceOrderExecution, "findMany");
    const ordens = vi.spyOn(prisma.serviceOrder, "findMany");

    await timeline(comoAdmin(), clienteA.id, 100);

    const argsDe = (espiao: { mock: { calls: unknown[][] } }) =>
      espiao.mock.calls.map((c) => c[0] as { take?: number; where?: Record<string, unknown> });
    for (const espiao of leituras) {
      const chamadas = argsDe(espiao);
      expect(chamadas.length).toBeGreaterThan(0);
      for (const a of chamadas) expect(a.take).toBe(101);
    }
    for (const a of argsDe(evidencias)) expect(a.take).toBe(101);
    // O agrupamento por OS tem teto; o por categoria é restrito às OS dele.
    const [porOs, porCategoria] = argsDe(grupos);
    expect(porOs.take).toBe(101);
    expect(porCategoria.where).toMatchObject({ serviceOrderId: { in: [ordem.id] } });
    expect(argsDe(execucoes)[0].where).toMatchObject({ serviceOrderId: { in: [ordem.id] } });
    expect(argsDe(ordens)[0].where).toMatchObject({ id: { in: [ordem.id] } });
  });

  it("TL-PAGE-05 — número de consultas é o mesmo para 2 itens e para 32 (sem N+1)", async () => {
    const consultas = () => {
      const delegados = [
        prisma.company,
        prisma.customer,
        prisma.serviceOrder,
        prisma.serviceOrderEvent,
        prisma.serviceOrderCheckIn,
        prisma.serviceOrderContactAttempt,
        prisma.serviceOrderImpediment,
        prisma.serviceOrderEvidence,
        prisma.serviceOrderSignature,
        prisma.serviceOrderEquipment,
        prisma.serviceOrderExecution,
        prisma.customerNetworkConnection,
        prisma.customerLocationHistory,
        prisma.technician,
        prisma.user,
        prisma.cTO,
        prisma.cTOPort,
      ] as unknown as Record<string, (...args: unknown[]) => unknown>[];
      const espioes = delegados.flatMap((d) =>
        ["findMany", "findFirst", "findUnique", "groupBy", "count", "aggregate"]
          .filter((m) => typeof d[m] === "function")
          .map((m) => vi.spyOn(d, m)),
      );
      return () => espioes.reduce((soma, e) => soma + e.mock.calls.length, 0);
    };

    const pequeno = await os(clienteA.id);
    await evento(pequeno.id, "OS_COMPLETED", t(1));
    await foto(pequeno.id, "CTO", t(2));

    let total = consultas();
    await timeline();
    const comDois = total();
    vi.restoreAllMocks();

    const grande = await cliente("QA TL Grande");
    const { porta } = await caixa("QA TL Grande");
    for (let i = 0; i < 6; i++) {
      const ordem = await os(grande.id, { status: "COMPLETED" });
      await evento(ordem.id, "OS_COMPLETED", t(10 + i));
      await evento(ordem.id, "TECHNICIAN_ASSIGNED", t(20 + i));
      await foto(ordem.id, "CTO", t(30 + i));
      await foto(ordem.id, "SPEED_TEST", t(40 + i));
      await contato(ordem.id, t(50 + i));
    }
    const vinculo = await connectCustomerToPort(web(), {
      customerId: grande.id,
      ctoPortId: (await porta(1)).id,
    });
    await disconnectCustomer(web(), { customerId: grande.id, expectedConnectionId: vinculo.id });

    total = consultas();
    const r = await timeline(comoAdmin(), grande.id);
    const comQuarenta = total();

    expect(r.items.length).toBe(32);
    expect(comQuarenta).toBe(comDois);
    expect(comDois).toBeLessThanOrEqual(16);
  });
});

describe("TL-CONN — uma conexão por visita", () => {
  it("TL-CONN-01 — as leituras vão em lotes sequenciais, e o principal num instante só", async () => {
    const ordem = await os(clienteA.id, { status: "COMPLETED" });
    await evento(ordem.id, "OS_COMPLETED", t(1));
    await foto(ordem.id, "CTO", t(2));
    const lotes = vi.spyOn(prisma, "$transaction");

    await timeline(comoAdmin());

    const chamadas = lotes.mock.calls as unknown as [unknown[], { isolationLevel?: string }?][];
    // empresa+cliente · fontes (+ rede) · segunda leva
    expect(chamadas.map(([consultas]) => consultas.length)).toEqual([2, 11, 3]);
    expect(chamadas[1][1]?.isolationLevel).toBe("RepeatableRead");

    lotes.mockClear();
    await timeline(comoDespacho());
    expect((lotes.mock.calls as unknown as [unknown[]][]).map(([c]) => c.length)).toEqual([2, 9, 3]);
  });

  it("TL-CONN-02 — o módulo não dispara leituras em paralelo (`Promise.all`)", () => {
    const fonte = readFileSync(path.join(process.cwd(), "src/lib/customer-timeline.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
    expect(fonte).not.toMatch(/Promise\.all/);
  });
});

describe("TL-ERR — erro não vira histórico vazio", () => {
  it("TL-ERR-01 — uma fonte que falha no banco derruba a seção para `error`, e o nosso log não leva a mensagem", async () => {
    const ordem = await os(clienteA.id);
    await evento(ordem.id, "SERVICE_ORDER_CREATED", t(1));
    // Uma falha REAL de SQL dentro do lote, no lugar da leitura de assinaturas.
    vi.spyOn(prisma.serviceOrderSignature, "findMany").mockImplementationOnce(
      () => prisma.$queryRawUnsafe("select * from tabela_secreta_tl1") as never,
    );
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    const secao = await loadCustomerTimeline(comoAdmin(), clienteA.id, 50);

    expect(secao).toEqual({ state: "error" });
    const nossos = log.mock.calls.filter((c) => String(c[0]).startsWith("[customer-timeline]"));
    expect(nossos).toHaveLength(1);
    expect(JSON.stringify(nossos)).not.toContain("tabela_secreta");
  });

  it("TL-ERR-02 — sem falha, a mesma chamada devolve os itens (controle positivo)", async () => {
    const ordem = await os(clienteA.id);
    await evento(ordem.id, "SERVICE_ORDER_CREATED", t(1));
    const secao = await loadCustomerTimeline(comoAdmin(), clienteA.id, 50);
    expect(secao.state).toBe("ok");
    expect(secao.state === "ok" && secao.data.items).toHaveLength(1);
  });

  it("TL-ERR-03 — cliente sem nenhum registro é lista vazia, não erro", async () => {
    const secao = await loadCustomerTimeline(comoAdmin(), clienteA.id, 50);
    expect(secao).toEqual({
      state: "ok",
      data: { items: [], hasMore: false, limit: 50, timezone: TZ_A },
    });
  });
});
