import { describe, it, expect, beforeEach } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { POST as confirmRoute } from "@/app/api/field/v1/service-orders/[id]/location/confirm/route";
import { POST as correctRoute } from "@/app/api/field/v1/service-orders/[id]/location/correct/route";
import { prisma } from "@/lib/prisma";
import { DomainError } from "@/lib/errors";
import {
  applyImportedCustomerLocation,
  correctCustomerLocation,
} from "@/lib/customer-locations";
import { getCustomerMapView } from "@/lib/operational-map";
import { startServiceOrder } from "@/lib/service-orders";
import {
  allocateTestServiceOrderNumber,
  fieldRequest,
  registerTestDevice,
  seedTestData,
  type TestFixture,
} from "./helpers";

/**
 * # RC-1C — "Corrigir localização" e a autoridade do mapa
 *
 * O contrato aprovado pelo dono para a correção:
 *
 * - com GPS válido, o ponto MUDA: a autoridade (`CustomerLocation`), a trilha
 *   com o ponto anterior, o técnico, a OS, o instante, a precisão, a origem,
 *   `verified = true` e a projeção de `Customer` — e o mapa passa a desenhar o
 *   ponto novo;
 * - sem GPS, só o endereço textual: a coordenada fica onde estava, nada é
 *   inventado e nada novo é marcado como verificado.
 *
 * E a pergunta que o dono fez ao ver o caso real: "corrigi, e o mapa mudou
 * mesmo?" — respondida aqui pelo serviço do mapa e, no navegador, em
 * `e2e/customer-location.spec.ts`.
 */

let fixture: TestFixture;

beforeEach(async () => {
  fixture = await seedTestData();
});

/** Ponto A, o cadastrado; ponto B, o corrigido. ~550 m entre os dois. Fictícios. */
const A = { latitude: -20.3155, longitude: -40.3128 };
const B = { latitude: -20.3105, longitude: -40.3128 };

/** Um recorte de mapa que contém A e B com folga. */
const RECORTE = { north: -20.3, south: -20.33, east: -40.3, west: -40.33 };

async function tecnico(userId: string, companyId: string) {
  return prisma.technician.upsert({
    where: { userId },
    update: {},
    create: { companyId, userId },
  });
}

async function atendimento(
  opts: { status?: "IN_PROGRESS" | "ASSIGNED"; comPonto?: boolean } = {},
) {
  const { status = "IN_PROGRESS", comPonto = true } = opts;
  const companyId = fixture.companyA.id;
  const technician = await tecnico(fixture.techA.id, companyId);
  await tecnico(fixture.techB.id, companyId);
  const customer = await prisma.customer.create({
    data: {
      companyId,
      name: "Cliente QA Correção",
      address: "Rua QA",
      number: "10",
      district: "Bairro QA",
      city: "Cidade Teste",
      active: true,
    },
  });
  if (comPonto) {
    await prisma.$transaction((tx) =>
      applyImportedCustomerLocation(tx, companyId, customer.id, A),
    );
  }
  const order = await prisma.serviceOrder.create({
    data: {
      companyId,
      number: await allocateTestServiceOrderNumber(companyId),
      customerId: customer.id,
      technicianId: technician.id,
      type: "Reparo",
      description: "OS de fixture da RC-1C.",
      status: "ASSIGNED",
      assignedAt: new Date(),
    },
  });
  if (status === "IN_PROGRESS") {
    await startServiceOrder(companyId, fixture.techA.id, order.id, order.version);
  }
  const location = comPonto
    ? await prisma.customerLocation.findUniqueOrThrow({ where: { customerId: customer.id } })
    : null;
  return { companyId, technician, customer, order, location };
}

async function erro(p: Promise<unknown>): Promise<DomainError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof DomainError) return e;
    throw e;
  }
  throw new Error("esperava um DomainError, e a operação passou");
}

function corrigirComGps(
  s: Awaited<ReturnType<typeof atendimento>>,
  ponto = B,
  extra: Record<string, unknown> = {},
  userId = fixture.techA.id,
  companyId = s.companyId,
) {
  return correctCustomerLocation(companyId, userId, s.order.id, {
    expectedVersion: s.location?.version ?? null,
    reason: "INCORRECT_LOCATION",
    latitude: ponto.latitude,
    longitude: ponto.longitude,
    accuracyMeters: 6,
    source: "TECHNICIAN_GPS",
    ...extra,
  });
}

/** O marcador do cliente no mapa, pela MESMA função que a rota do mapa usa. */
async function marcadorNoMapa(customerId: string, bbox = RECORTE) {
  const view = await getCustomerMapView(fixture.companyA.id, { bbox });
  return view.markers.find((m) => m.id === customerId) ?? null;
}

/** Nada da correção pode ter sobrado. */
async function pontoIntacto(s: Awaited<ReturnType<typeof atendimento>>) {
  const ponto = await prisma.customerLocation.findUniqueOrThrow({
    where: { id: s.location!.id },
  });
  expect(ponto.latitude.equals(s.location!.latitude)).toBe(true);
  expect(ponto.longitude.equals(s.location!.longitude)).toBe(true);
  expect(ponto.verified).toBe(s.location!.verified);
  expect(ponto.version).toBe(s.location!.version);
  expect(
    await prisma.customerLocationHistory.count({ where: { customerId: s.customer.id } }),
  ).toBe(0);
  const projecao = await prisma.customer.findUniqueOrThrow({ where: { id: s.customer.id } });
  expect(projecao.latitude?.equals(s.location!.latitude)).toBe(true);
  expect(projecao.longitude?.equals(s.location!.longitude)).toBe(true);
}

// ---------------------------------------------------------------------------
// LOC-R01..R04 — corrigir com GPS move o ponto, e o mapa acompanha
// ---------------------------------------------------------------------------

describe("LOC-R01..R04 — corrigir com GPS", () => {
  it("LOC-R01 · o ponto muda para B, com origem, precisão, verificado e versão nova", async () => {
    const s = await atendimento();
    const r = await corrigirComGps(s);

    expect(r.kind).toBe("COORDINATES");
    const ponto = await prisma.customerLocation.findUniqueOrThrow({ where: { id: s.location!.id } });
    expect(Number(ponto.latitude)).toBeCloseTo(B.latitude, 7);
    expect(Number(ponto.longitude)).toBeCloseTo(B.longitude, 7);
    expect(ponto.source).toBe("TECHNICIAN_GPS");
    expect(ponto.accuracyMeters).toBe(6);
    expect(ponto.verified).toBe(true);
    expect(ponto.verifiedByTechnicianId).toBe(s.technician.id);
    expect(ponto.verifiedByUserId).toBe(fixture.techA.id);
    expect(ponto.verifiedAt).not.toBeNull();
    expect(ponto.version).toBe(s.location!.version + 1);
  });

  it("LOC-R02 · o ponto anterior fica na trilha: A → B, com técnico, OS e instante", async () => {
    const s = await atendimento();
    const antes = new Date();
    await corrigirComGps(s);

    const linhas = await prisma.customerLocationHistory.findMany({
      where: { customerId: s.customer.id },
    });
    expect(linhas).toHaveLength(1);
    const l = linhas[0];
    expect(l.kind).toBe("COORDINATES");
    expect(l.reason).toBe("INCORRECT_LOCATION");
    expect(l.previousLatitude?.equals(s.location!.latitude)).toBe(true);
    expect(l.previousLongitude?.equals(s.location!.longitude)).toBe(true);
    expect(l.previousSource).toBe("IMPORTED");
    expect(l.previousVerified).toBe(false);
    expect(Number(l.newLatitude)).toBeCloseTo(B.latitude, 7);
    expect(Number(l.newLongitude)).toBeCloseTo(B.longitude, 7);
    expect(l.newSource).toBe("TECHNICIAN_GPS");
    expect(l.newVerified).toBe(true);
    expect(l.technicianId).toBe(s.technician.id);
    expect(l.changedByUserId).toBe(fixture.techA.id);
    expect(l.serviceOrderId).toBe(s.order.id);
    expect(l.createdAt.getTime()).toBeGreaterThanOrEqual(antes.getTime() - 1000);

    const evento = await prisma.serviceOrderEvent.findFirstOrThrow({
      where: { serviceOrderId: s.order.id, event: "LOCATION_CORRECTED" },
    });
    expect((evento.metadata as Record<string, unknown>).coordinateChanged).toBe(true);
    expect(
      await prisma.auditLog.count({ where: { action: "CUSTOMER_LOCATION.CORRECTED" } }),
    ).toBe(1);
  });

  it("LOC-R03 · a projeção de Customer acompanha a autoridade na MESMA transação", async () => {
    const s = await atendimento();
    await corrigirComGps(s);
    const c = await prisma.customer.findUniqueOrThrow({ where: { id: s.customer.id } });
    expect(Number(c.latitude)).toBeCloseTo(B.latitude, 7);
    expect(Number(c.longitude)).toBeCloseTo(B.longitude, 7);
    expect(c.locationSource).toBe("TECHNICIAN_GPS");
    expect(c.locationVerified).toBe(true);
  });

  it("LOC-R04 · o marcador do mapa sai de A e vai para B", async () => {
    const s = await atendimento();
    const antes = await marcadorNoMapa(s.customer.id);
    expect(antes?.latitude).toBeCloseTo(A.latitude, 7);

    await corrigirComGps(s);

    const depois = await marcadorNoMapa(s.customer.id);
    expect(depois?.latitude).toBeCloseTo(B.latitude, 7);
    expect(depois?.longitude).toBeCloseTo(B.longitude, 7);
    // E um recorte só em volta de A não o encontra mais.
    const soEmA = { north: A.latitude + 0.001, south: A.latitude - 0.001, east: A.longitude + 0.001, west: A.longitude - 0.001 };
    expect(await marcadorNoMapa(s.customer.id, soEmA)).toBeNull();
  });

  it("cliente SEM ponto: a correção com GPS cria o primeiro (CAS da criação, expectedVersion null)", async () => {
    const s = await atendimento({ comPonto: false });
    await corrigirComGps(s);
    const ponto = await prisma.customerLocation.findUniqueOrThrow({
      where: { customerId: s.customer.id },
    });
    expect(ponto.verified).toBe(true);
    expect(ponto.source).toBe("TECHNICIAN_GPS");
    expect((await marcadorNoMapa(s.customer.id))?.latitude).toBeCloseTo(B.latitude, 7);
  });
});

// ---------------------------------------------------------------------------
// A autoridade do mapa
// ---------------------------------------------------------------------------

describe("o Mapa Operacional desenha a AUTORIDADE, nunca a projeção", () => {
  it("CustomerLocation em A e projeção em B: o marcador está em A", async () => {
    const s = await atendimento();
    // Divergência forçada: a projeção passa a dizer B. Nenhum escritor de
    // produção faz isto — é justamente o estado que o mapa não pode seguir.
    await prisma.customer.update({
      where: { id: s.customer.id },
      data: { latitude: B.latitude, longitude: B.longitude },
    });

    const m = await marcadorNoMapa(s.customer.id);
    expect(m?.latitude).toBeCloseTo(A.latitude, 7);
    expect(m?.longitude).toBeCloseTo(A.longitude, 7);

    const soEmB = { north: B.latitude + 0.001, south: B.latitude - 0.001, east: B.longitude + 0.001, west: B.longitude - 0.001 };
    expect(await marcadorNoMapa(s.customer.id, soEmB)).toBeNull();
  });

  it("projeção sem autoridade (o legado do RC-LOC-04): não vira marcador, e conta como sem localização", async () => {
    const s = await atendimento({ comPonto: false });
    await prisma.customer.update({
      where: { id: s.customer.id },
      data: { latitude: A.latitude, longitude: A.longitude, locationSource: "IMPORTED" },
    });
    const view = await getCustomerMapView(fixture.companyA.id, { bbox: RECORTE });
    expect(view.markers.find((m) => m.id === s.customer.id)).toBeUndefined();
    expect(view.missingLocationCount).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// LOC-R07 — só o endereço
// ---------------------------------------------------------------------------

describe("LOC-R07 — correção apenas de endereço (GPS desligado)", () => {
  it("o texto muda; o ponto, a verificação e o marcador ficam; trilha ADDRESS", async () => {
    const s = await atendimento();
    const r = await correctCustomerLocation(s.companyId, fixture.techA.id, s.order.id, {
      expectedVersion: s.location!.version,
      reason: "INCORRECT_ADDRESS",
      address: { address: "Rua Corrigida QA", number: "250" },
    });
    expect(r.kind).toBe("ADDRESS");

    const c = await prisma.customer.findUniqueOrThrow({ where: { id: s.customer.id } });
    expect(c.address).toBe("Rua Corrigida QA");
    expect(c.number).toBe("250");
    expect(c.district).toBe("Bairro QA");

    const ponto = await prisma.customerLocation.findUniqueOrThrow({ where: { id: s.location!.id } });
    expect(ponto.latitude.equals(s.location!.latitude)).toBe(true);
    expect(ponto.longitude.equals(s.location!.longitude)).toBe(true);
    expect(ponto.verified).toBe(false);
    expect(ponto.source).toBe("IMPORTED");
    expect(ponto.version).toBe(s.location!.version);

    const linha = await prisma.customerLocationHistory.findFirstOrThrow({
      where: { customerId: s.customer.id },
    });
    expect(linha.kind).toBe("ADDRESS");
    expect(linha.newLatitude).toBeNull();
    expect(linha.newLongitude).toBeNull();
    expect(linha.newVerified).toBeNull();
    expect((linha.previousAddress as Record<string, string>).address).toBe("Rua QA");
    expect((linha.newAddress as Record<string, string>).address).toBe("Rua Corrigida QA");

    const evento = await prisma.serviceOrderEvent.findFirstOrThrow({
      where: { serviceOrderId: s.order.id, event: { in: ["ADDRESS_CORRECTED", "LOCATION_CORRECTED"] } },
    });
    expect(evento.event).toBe("ADDRESS_CORRECTED");

    expect((await marcadorNoMapa(s.customer.id))?.latitude).toBeCloseTo(A.latitude, 7);
  });

  it("um ponto JÁ verificado continua verificado depois de corrigir só o endereço", async () => {
    const s = await atendimento();
    await corrigirComGps(s, A); // no mesmo lugar: vira TECHNICIAN_GPS verificado
    const verificado = await prisma.customerLocation.findUniqueOrThrow({ where: { id: s.location!.id } });
    expect(verificado.verified).toBe(true);

    await correctCustomerLocation(s.companyId, fixture.techA.id, s.order.id, {
      expectedVersion: verificado.version,
      reason: "INCORRECT_ADDRESS",
      address: { number: "99" },
    });
    const depois = await prisma.customerLocation.findUniqueOrThrow({ where: { id: s.location!.id } });
    expect(depois.verified).toBe(true);
    expect(depois.version).toBe(verificado.version);
  });

  it("sem GPS e sem endereço não há correção nenhuma (400)", async () => {
    const s = await atendimento();
    const e = await erro(
      correctCustomerLocation(s.companyId, fixture.techA.id, s.order.id, {
        expectedVersion: s.location!.version,
        reason: "INCORRECT_LOCATION",
      }),
    );
    expect(e.status).toBe(400);
    await pontoIntacto(s);
  });
});

// ---------------------------------------------------------------------------
// LOC-R08 — GPS inválido e coordenada sem GPS
// ---------------------------------------------------------------------------

describe("LOC-R08 — coordenada que não veio de um GPS válido é recusada", () => {
  it.each([
    ["latitude acima de 90", { latitude: 91, longitude: B.longitude }],
    ["a ilha nula", { latitude: 0, longitude: 0 }],
    ["NaN", { latitude: Number.NaN, longitude: B.longitude }],
    ["infinito", { latitude: B.latitude, longitude: Number.NEGATIVE_INFINITY }],
  ])("%s: 400, nada muda", async (_label, ponto) => {
    const s = await atendimento();
    expect((await erro(corrigirComGps(s, ponto))).status).toBe(400);
    await pontoIntacto(s);
  });

  it("meia coordenada (só latitude) com endereço: 400 — nada é aplicado pela metade", async () => {
    const s = await atendimento();
    const e = await erro(
      correctCustomerLocation(s.companyId, fixture.techA.id, s.order.id, {
        expectedVersion: s.location!.version,
        reason: "INCORRECT_LOCATION",
        latitude: B.latitude,
        address: { address: "Rua Pela Metade" },
      }),
    );
    expect(e.status).toBe(400);
    await pontoIntacto(s);
    const c = await prisma.customer.findUniqueOrThrow({ where: { id: s.customer.id } });
    expect(c.address).toBe("Rua QA");
  });

  it("coordenada DIGITADA (source MANUAL) não move o ponto nem o marca verificado: 400", async () => {
    const s = await atendimento();
    const e = await erro(corrigirComGps(s, B, { source: "MANUAL" }));
    expect(e.status).toBe(400);
    expect(e.message).toMatch(/GPS do aparelho/);
    await pontoIntacto(s);
  });
});

// ---------------------------------------------------------------------------
// Tenant, posse, estado
// ---------------------------------------------------------------------------

describe("correção — tenant, posse e estado", () => {
  it("o vetor da DQ-7.1 (OS da A apontando técnico da B): 404 GENÉRICO, nada muda", async () => {
    const s = await atendimento();
    const user = await prisma.user.create({
      data: {
        companyId: fixture.companyB.id,
        name: "Tecnico Empresa B",
        email: "tech-rc1c-corr@empresab.test",
        profile: "TECHNICIAN",
        passwordHash: "x",
      },
    });
    const techB = await tecnico(user.id, fixture.companyB.id);
    await prisma.serviceOrder.update({ where: { id: s.order.id }, data: { technicianId: techB.id } });

    const e = await erro(corrigirComGps(s, B, {}, user.id, fixture.companyB.id));
    expect(e.status).toBe(404);
    expect(e.message).toBe("Ordem de serviço não encontrada.");
    await pontoIntacto(s);
  });

  it("técnico da mesma empresa que não é o dono: 404, nada muda", async () => {
    const s = await atendimento();
    expect((await erro(corrigirComGps(s, B, {}, fixture.techB.id))).status).toBe(404);
    await pontoIntacto(s);
  });

  it("OS ASSIGNED: 409; OS COMPLETED: 409 — nada muda", async () => {
    const atribuida = await atendimento({ status: "ASSIGNED" });
    expect((await erro(corrigirComGps(atribuida))).status).toBe(409);
    await pontoIntacto(atribuida);
  });

  it("OS COMPLETED: 409 — nada muda", async () => {
    const s = await atendimento();
    await prisma.$executeRawUnsafe(
      `UPDATE service_orders SET status = 'COMPLETED', "completedAt" = now(), version = version + 1 WHERE id = $1`,
      s.order.id,
    );
    expect((await erro(corrigirComGps(s))).status).toBe(409);
    await pontoIntacto(s);
  });
});

// ---------------------------------------------------------------------------
// Autorização: ninguém além do técnico dono escreve localização
// ---------------------------------------------------------------------------

describe("DISPATCHER e ADMIN não ganham escrita de localização", () => {
  it.each([
    ["DISPATCHER", () => fixture.dispatcherA.id],
    ["ADMIN", () => fixture.adminA.id],
  ])("%s com token do Field: confirmar e corrigir são recusados, nada muda", async (_perfil, quem) => {
    const s = await atendimento();
    const { token } = await registerTestDevice(quem());
    const confirmar = await confirmRoute(
      fieldRequest(`/api/field/v1/service-orders/${s.order.id}/location/confirm`, {
        method: "POST",
        token,
        idempotencyKey: `rc1c-perfil-c-${Math.random()}`,
        body: { expectedVersion: s.location!.version, observedLatitude: A.latitude, observedLongitude: A.longitude },
      }),
      { params: Promise.resolve({ id: s.order.id }) },
    );
    const corrigir = await correctRoute(
      fieldRequest(`/api/field/v1/service-orders/${s.order.id}/location/correct`, {
        method: "POST",
        token,
        idempotencyKey: `rc1c-perfil-r-${Math.random()}`,
        body: {
          expectedVersion: s.location!.version,
          reason: "INCORRECT_LOCATION",
          latitude: B.latitude,
          longitude: B.longitude,
          source: "TECHNICIAN_GPS",
        },
      }),
      { params: Promise.resolve({ id: s.order.id }) },
    );
    expect([401, 403, 404]).toContain(confirmar.status);
    expect([401, 403, 404]).toContain(corrigir.status);
    await pontoIntacto(s);
  });

  it("nenhuma rota fora do Field escreve localização de cliente", () => {
    // Estrutural: as duas únicas portas de escrita humana são as rotas do
    // Field. Uma rota administrativa nova que chamasse o serviço seria uma
    // permissão de edição geográfica que ninguém aprovou (RC-1C, §24).
    const raiz = path.join(process.cwd(), "src", "app");
    const encontrados: string[] = [];
    const varrer = (dir: string) => {
      for (const nome of readdirSync(dir)) {
        const alvo = path.join(dir, nome);
        if (statSync(alvo).isDirectory()) varrer(alvo);
        else if (/\.(ts|tsx)$/.test(nome)) {
          const texto = readFileSync(alvo, "utf8");
          if (/\b(confirmCustomerLocation|correctCustomerLocation)\b/.test(texto)) {
            encontrados.push(path.relative(raiz, alvo).split(path.sep).join("/"));
          }
        }
      }
    };
    varrer(raiz);
    expect(encontrados.sort()).toEqual([
      "api/field/v1/service-orders/[id]/location/confirm/route.ts",
      "api/field/v1/service-orders/[id]/location/correct/route.ts",
    ]);
  });
});

// ---------------------------------------------------------------------------
// RC-1C-HOTFIX — mover o ponto exige precisão ≤ 50 m
// ---------------------------------------------------------------------------

/**
 * O defeito da validação física foi exatamente este caminho: "Corrigir
 * localização" com "Usar minha localização atual", e o aparelho só com a
 * permissão APROXIMADA. A posição chegou com 2000 m de precisão, foi gravada
 * como GPS do técnico, verificada — e o ponto ficou a mais de 1 km do lugar.
 */
describe("RC-1C-HOTFIX — corrigir com GPS exige precisão ≤ 50 m", () => {
  it("ACC-R01 · precisão 18 m: o ponto muda, com a precisão gravada", async () => {
    const s = await atendimento();
    await corrigirComGps(s, B, { accuracyMeters: 18 });
    const ponto = await prisma.customerLocation.findUniqueOrThrow({ where: { id: s.location!.id } });
    expect(Number(ponto.latitude)).toBeCloseTo(B.latitude, 7);
    expect(ponto.accuracyMeters).toBe(18);
    expect(ponto.verified).toBe(true);
  });

  it("ACC-R02 · precisão 1200 m: o ponto NÃO muda — nem a autoridade, nem a trilha, nem o mapa", async () => {
    const s = await atendimento();
    const e = await erro(corrigirComGps(s, B, { accuracyMeters: 1200 }));
    expect(e.status).toBe(400);
    expect(e.message).toBe(
      "Precisão do GPS insuficiente: 1200 m. Aguarde alguns segundos em um local mais aberto e tente novamente.",
    );
    await pontoIntacto(s);
    expect((await marcadorNoMapa(s.customer.id))?.latitude).toBeCloseTo(A.latitude, 7);
    expect(
      await prisma.serviceOrderEvent.count({
        where: { serviceOrderId: s.order.id, event: "LOCATION_CORRECTED" },
      }),
    ).toBe(0);
  });

  it("ACC-R03 · precisão ausente com coordenada: 400 — não há correção por GPS sem precisão", async () => {
    const s = await atendimento();
    const e = await erro(corrigirComGps(s, B, { accuracyMeters: null }));
    expect(e.status).toBe(400);
    expect(e.message).toBe(
      "Não é possível corrigir a coordenada sem a precisão do GPS. Obtenha a posição novamente e tente outra vez.",
    );
    await pontoIntacto(s);
  });

  it("ACC-R04 · GPS ruim + endereço no mesmo corpo: 400, e o endereço NÃO é aplicado sozinho", async () => {
    // Quem mandou coordenada escolheu mover o ponto. Aplicar o endereço e
    // descartar a posição em silêncio faria o técnico achar que moveu.
    const s = await atendimento();
    const e = await erro(
      corrigirComGps(s, B, {
        accuracyMeters: 900,
        address: { address: "Rua Que Não Pode Entrar" },
      }),
    );
    expect(e.status).toBe(400);
    await pontoIntacto(s);
    const c = await prisma.customer.findUniqueOrThrow({ where: { id: s.customer.id } });
    expect(c.address).toBe("Rua QA");
  });

  it("ACC-R05 · só endereço (GPS desligado) continua sem pedir precisão", async () => {
    const s = await atendimento();
    const r = await correctCustomerLocation(s.companyId, fixture.techA.id, s.order.id, {
      expectedVersion: s.location!.version,
      reason: "INCORRECT_ADDRESS",
      address: { address: "Rua Sem GPS QA" },
    });
    expect(r.kind).toBe("ADDRESS");
    const c = await prisma.customer.findUniqueOrThrow({ where: { id: s.customer.id } });
    expect(c.address).toBe("Rua Sem GPS QA");
    const ponto = await prisma.customerLocation.findUniqueOrThrow({ where: { id: s.location!.id } });
    expect(ponto.version).toBe(s.location!.version);
    expect(ponto.verified).toBe(false);
  });

  it("ACC-R06 · 50,0 m move; 50,1 m não — sem arredondar para liberar", async () => {
    const limite = await atendimento();
    await corrigirComGps(limite, B, { accuracyMeters: 50 });
    expect(
      Number(
        (await prisma.customerLocation.findUniqueOrThrow({ where: { id: limite.location!.id } }))
          .latitude,
      ),
    ).toBeCloseTo(B.latitude, 7);

    const acima = await atendimento();
    expect((await erro(corrigirComGps(acima, B, { accuracyMeters: 50.1 }))).status).toBe(400);
    await pontoIntacto(acima);
  });

  it.each([
    ["zero", 0],
    ["negativa", -3],
  ])("ACC-R07 · precisão %s: 400, nada muda", async (_label, precisao) => {
    const s = await atendimento();
    expect((await erro(corrigirComGps(s, B, { accuracyMeters: precisao }))).status).toBe(400);
    await pontoIntacto(s);
  });

  it("ACC-R08 · o caso físico: cliente SEM ponto e precisão 2000 m — nenhum ponto é criado", async () => {
    const s = await atendimento({ comPonto: false });
    expect((await erro(corrigirComGps(s, B, { accuracyMeters: 2000 }))).status).toBe(400);
    expect(await prisma.customerLocation.count({ where: { customerId: s.customer.id } })).toBe(0);
    expect(await prisma.customerLocationHistory.count({ where: { customerId: s.customer.id } })).toBe(0);
    const c = await prisma.customer.findUniqueOrThrow({ where: { id: s.customer.id } });
    expect(c.latitude).toBeNull();
    expect(await marcadorNoMapa(s.customer.id)).toBeNull();
  });

  it("pela rota: um cliente sabotado com coordenada válida e precisão 1500 m recebe 400, nada muda", async () => {
    const s = await atendimento();
    const { token } = await registerTestDevice(fixture.techA.id);
    const r = await correctRoute(
      fieldRequest(`/api/field/v1/service-orders/${s.order.id}/location/correct`, {
        method: "POST",
        token,
        idempotencyKey: `hotfix-corr-${Math.random()}`,
        body: {
          expectedVersion: s.location!.version,
          reason: "INCORRECT_LOCATION",
          latitude: B.latitude,
          longitude: B.longitude,
          accuracyMeters: 1500,
          source: "TECHNICIAN_GPS",
        },
      }),
      { params: Promise.resolve({ id: s.order.id }) },
    );
    expect(r.status).toBe(400);
    const b = (await r.json()) as { error?: { code: string } };
    expect(b.error?.code).toBe("VALIDATION_ERROR");
    await pontoIntacto(s);
  });
});
