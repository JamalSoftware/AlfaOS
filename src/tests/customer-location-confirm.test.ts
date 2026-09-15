import { describe, it, expect, beforeEach } from "vitest";
import { POST as confirmRoute } from "@/app/api/field/v1/service-orders/[id]/location/confirm/route";
import { GET as executionRoute } from "@/app/api/field/v1/service-orders/[id]/execution/route";
import { prisma } from "@/lib/prisma";
import { DomainError } from "@/lib/errors";
import { distanceInMeters } from "@/lib/geo";
import {
  LOCATION_CONFIRM_MAX_DISTANCE_M,
  LOCATION_GPS_MAX_ACCURACY_M,
  applyImportedCustomerLocation,
  confirmCustomerLocation,
  isConfirmDistanceAllowed,
  isGpsAccuracyAllowed,
} from "@/lib/customer-locations";
import { formatAccuracyMeters } from "@/lib/customer-location-presentation";
import { classificarLocalizacao } from "@/lib/customer-timeline";
import { startServiceOrder } from "@/lib/service-orders";
import {
  allocateTestServiceOrderNumber,
  fieldRequest,
  registerTestDevice,
  seedTestData,
  type TestFixture,
} from "./helpers";

/**
 * # RC-1C — o contrato de "Confirmar localização" (RC-LOC-01)
 *
 * O caso que originou a fase: um técnico CONFIRMOU o ponto importado estando a
 * ~2,3 km dele. O sistema não moveu a coordenada, marcou `verified = true`, não
 * mostrou a distância e não bloqueou — e com o GPS negado confirmava do mesmo
 * jeito.
 *
 * O contrato aprovado pelo dono:
 *
 * - confirmar EXIGE a posição válida do aparelho;
 * - a distância é calculada NO SERVIDOR, e o limite é 100 m, inclusivo;
 * - acima dele, nada é gravado — a saída é "Corrigir localização";
 * - confirmar não move o ponto; ele só passa a valer `verified = true`;
 * - a distância fica registrada para auditoria.
 *
 * Os testes entram pelo serviço E pela rota: um `.strict()` esquecido ou uma
 * distância aceita do corpo só aparecem do lado da rota.
 */

let fixture: TestFixture;

beforeEach(async () => {
  fixture = await seedTestData();
});

/** O raio que `geo.ts` usa — os pontos de teste são gerados com o mesmo. */
const EARTH_RADIUS_M = 6_371_008.8;

/** O ponto cadastrado de todos os cenários. Fictício. */
const P = { latitude: -20.3155, longitude: -40.3128 };

/**
 * Um ponto a `metros` ao NORTE de `p`.
 *
 * Mesma longitude: a haversine se reduz a `R · Δφ`, então a distância que o
 * servidor calcula é exatamente a pedida (a menos de ruído de ponto flutuante,
 * que o arredondamento para metro inteiro absorve).
 */
function aNorte(p: { latitude: number; longitude: number }, metros: number) {
  return {
    latitude: p.latitude + ((metros / EARTH_RADIUS_M) * 180) / Math.PI,
    longitude: p.longitude,
  };
}

async function tecnico(userId: string, companyId: string) {
  return prisma.technician.upsert({
    where: { userId },
    update: {},
    create: { companyId, userId },
  });
}

/**
 * Cliente com ponto IMPORTADO (não verificado) e uma OS do técnico A em
 * atendimento. O ponto entra pelo escritor real de importação, que também
 * mantém a projeção de `Customer` — é o estado de um cliente vindo do ERP.
 */
async function atendimento(status: "IN_PROGRESS" | "ASSIGNED" = "IN_PROGRESS") {
  const companyId = fixture.companyA.id;
  const technician = await tecnico(fixture.techA.id, companyId);
  await tecnico(fixture.techB.id, companyId);
  const customer = await prisma.customer.create({
    data: { companyId, name: "Cliente QA Localização", city: "Cidade Teste" },
  });
  await prisma.$transaction((tx) =>
    applyImportedCustomerLocation(tx, companyId, customer.id, P),
  );
  const order = await prisma.serviceOrder.create({
    data: {
      companyId,
      number: await allocateTestServiceOrderNumber(companyId),
      customerId: customer.id,
      technicianId: technician.id,
      type: "Instalação",
      description: "OS de fixture da RC-1C.",
      status: "ASSIGNED",
      assignedAt: new Date(),
    },
  });
  if (status === "IN_PROGRESS") {
    await startServiceOrder(companyId, fixture.techA.id, order.id, order.version);
  }
  const location = await prisma.customerLocation.findUniqueOrThrow({
    where: { customerId: customer.id },
  });
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

/** Nada da confirmação pode ter sobrado — nem ponto, nem trilha, nem evento. */
async function nadaGravado(s: Awaited<ReturnType<typeof atendimento>>) {
  const ponto = await prisma.customerLocation.findUniqueOrThrow({
    where: { id: s.location.id },
  });
  expect(ponto.verified).toBe(false);
  expect(ponto.verifiedAt).toBeNull();
  expect(ponto.verifiedByTechnicianId).toBeNull();
  expect(ponto.version).toBe(s.location.version);
  expect(ponto.latitude.equals(s.location.latitude)).toBe(true);
  expect(ponto.longitude.equals(s.location.longitude)).toBe(true);
  expect(
    await prisma.customerLocationHistory.count({ where: { customerId: s.customer.id } }),
  ).toBe(0);
  expect(
    await prisma.serviceOrderEvent.count({
      where: { serviceOrderId: s.order.id, event: "LOCATION_CONFIRMED" },
    }),
  ).toBe(0);
  expect(
    await prisma.auditLog.count({ where: { action: "CUSTOMER_LOCATION.CONFIRMED" } }),
  ).toBe(0);
  const projecao = await prisma.customer.findUniqueOrThrow({ where: { id: s.customer.id } });
  expect(projecao.locationVerified).toBe(false);
}

/**
 * Confirma com a posição `observado`.
 *
 * A precisão tem um padrão VÁLIDO (8 m) desde a RC-1C-HOTFIX, que passou a
 * exigi-la: os cenários da RC-1C falam de distância, de GPS ausente e de
 * posse, e cada um continua recusado — ou aceito — pelo motivo que nomeia. Os
 * cenários de precisão a sobrescrevem explicitamente.
 */
function confirmar(
  s: Awaited<ReturnType<typeof atendimento>>,
  observado: Record<string, unknown>,
  userId = fixture.techA.id,
  companyId = s.companyId,
) {
  return confirmCustomerLocation(companyId, userId, s.order.id, {
    expectedVersion: s.location.version,
    observedAccuracyMeters: 8,
    ...observado,
  });
}

// ---------------------------------------------------------------------------
// A distância
// ---------------------------------------------------------------------------

describe("distância geográfica — haversine no servidor, em metros", () => {
  it.each([0, 20, 99, 100, 101, 500, 2357])(
    "um ponto %i m ao norte mede %i m",
    (metros) => {
      expect(distanceInMeters(P, aNorte(P, metros))).toBe(metros);
    },
  );

  it("não é diferença simples de latitude/longitude (leste–oeste encolhe com a latitude)", () => {
    // 0,001° de longitude a ~23,55° S são ~102 m, não os ~111 m do equador.
    const a = { latitude: -23.55, longitude: -46.63 };
    const b = { latitude: -23.55, longitude: -46.631 };
    const d = distanceInMeters(a, b);
    expect(d).toBeGreaterThanOrEqual(101);
    expect(d).toBeLessThanOrEqual(103);
  });

  it("é geodésica em escala real: São Paulo–Rio fica perto de 360 km, não dos ~392 km planos", () => {
    const sp = { latitude: -23.5505, longitude: -46.6333 };
    const rio = { latitude: -22.9068, longitude: -43.1729 };
    const d = distanceInMeters(sp, rio);
    expect(d).toBeGreaterThan(355_000);
    expect(d).toBeLessThan(365_000);
  });
});

describe("o limite de 100 m — inclusivo, sobre o metro que o técnico vê", () => {
  it("o limite é 100 m", () => {
    expect(LOCATION_CONFIRM_MAX_DISTANCE_M).toBe(100);
  });

  it.each([
    [0, true],
    [20, true],
    [99, true],
    [100, true],
    [101, false],
    [500, false],
    [2357, false],
  ])("%i m → permitido: %s", (metros, permitido) => {
    expect(isConfirmDistanceAllowed(metros)).toBe(permitido);
  });

  it("a comparação usa o metro ARREDONDADO: 100,4 m vira 100 e passa; 100,6 m vira 101 e não", () => {
    // Mostrar "100 m" e recusar, ou mostrar "101 m" e aceitar, seria a tela e a
    // regra discordando na frente do técnico.
    expect(isConfirmDistanceAllowed(distanceInMeters(P, aNorte(P, 100.4)))).toBe(true);
    expect(isConfirmDistanceAllowed(distanceInMeters(P, aNorte(P, 100.6)))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// LOC-C01..C05 — o limite, pelo serviço
// ---------------------------------------------------------------------------

describe("LOC-C01..C03 — até 100 m, confirma", () => {
  it.each([
    ["LOC-C01", 0],
    ["LOC-C02", 99],
    ["LOC-C03", 100],
  ])("%s · a %i m do ponto: confirma e registra a distância", async (_id, metros) => {
    const s = await atendimento();
    const o = aNorte(P, metros);
    const r = await confirmar(s, {
      observedLatitude: o.latitude,
      observedLongitude: o.longitude,
      observedAccuracyMeters: 8,
    });
    expect(r.location.verified).toBe(true);
    expect(r.distanceMeters).toBe(metros);
  });
});

describe("LOC-C04/C05 — acima de 100 m, recusa e NÃO grava nada", () => {
  it("LOC-C04 · a 101 m: 400, e a mensagem manda corrigir", async () => {
    const s = await atendimento();
    const o = aNorte(P, 101);
    const e = await erro(
      confirmar(s, { observedLatitude: o.latitude, observedLongitude: o.longitude }),
    );
    expect(e.status).toBe(400);
    expect(e.message).toBe("Você está a 101 m do ponto cadastrado. Use Corrigir localização.");
    await nadaGravado(s);
  });

  it("LOC-C05 · a ~2,3 km (o caso que originou a fase): 400, em quilômetros", async () => {
    const s = await atendimento();
    const o = aNorte(P, 2357);
    const e = await erro(
      confirmar(s, {
        observedLatitude: o.latitude,
        observedLongitude: o.longitude,
        observedAccuracyMeters: 12,
      }),
    );
    expect(e.status).toBe(400);
    expect(e.message).toBe("Você está a 2,36 km do ponto cadastrado. Use Corrigir localização.");
    await nadaGravado(s);
  });
});

// ---------------------------------------------------------------------------
// LOC-C06..C08 — sem GPS válido, não há confirmação
// ---------------------------------------------------------------------------

describe("LOC-C06..C08 — sem a posição do aparelho não se confirma", () => {
  it("LOC-C06 · GPS negado (o aparelho não manda coordenada): 400, nada gravado", async () => {
    const s = await atendimento();
    const e = await erro(confirmar(s, {}));
    expect(e.status).toBe(400);
    expect(e.message).toMatch(/localização do aparelho/i);
    await nadaGravado(s);
  });

  it.each([
    ["nulas", { observedLatitude: null, observedLongitude: null }],
    ["só a latitude", { observedLatitude: P.latitude }],
    ["só a longitude", { observedLongitude: P.longitude }],
  ])("LOC-C07 · GPS ausente (%s): 400, nada gravado", async (_label, observado) => {
    const s = await atendimento();
    expect((await erro(confirmar(s, observado))).status).toBe(400);
    await nadaGravado(s);
  });

  it.each([
    ["latitude acima de 90", 91, P.longitude],
    ["longitude abaixo de -180", P.latitude, -181],
    ["a ilha nula (0, 0)", 0, 0],
    ["NaN", Number.NaN, P.longitude],
    ["infinito", P.latitude, Number.POSITIVE_INFINITY],
  ])("LOC-C08 · coordenada inválida (%s): 400, nada gravado", async (_label, lat, lng) => {
    const s = await atendimento();
    const e = await erro(confirmar(s, { observedLatitude: lat, observedLongitude: lng }));
    expect(e.status).toBe(400);
    await nadaGravado(s);
  });

  it("RC-1C-HOTFIX · 60 m de precisão a 20 m do ponto NÃO confirma mais — o dono aprovou o limite de 50 m", async () => {
    // Até a RC-1C este cenário confirmava: não havia limite de precisão
    // aprovado. A validação física mostrou o preço, e o dono decidiu.
    const s = await atendimento();
    const o = aNorte(P, 20);
    const e = await erro(
      confirmar(s, {
        observedLatitude: o.latitude,
        observedLongitude: o.longitude,
        observedAccuracyMeters: 60,
      }),
    );
    expect(e.status).toBe(400);
    expect(e.message).toBe(
      "Precisão do GPS insuficiente: 60 m. Aguarde alguns segundos em um local mais aberto e tente novamente.",
    );
    await nadaGravado(s);
  });
});

// ---------------------------------------------------------------------------
// LOC-C09..C11 — o que uma confirmação válida grava
// ---------------------------------------------------------------------------

describe("LOC-C09..C11 — a confirmação válida", () => {
  it("LOC-C09 · a coordenada NÃO se move — nem na autoridade, nem na projeção", async () => {
    const s = await atendimento();
    const o = aNorte(P, 35);
    await confirmar(s, { observedLatitude: o.latitude, observedLongitude: o.longitude });

    const ponto = await prisma.customerLocation.findUniqueOrThrow({ where: { id: s.location.id } });
    expect(ponto.latitude.equals(s.location.latitude)).toBe(true);
    expect(ponto.longitude.equals(s.location.longitude)).toBe(true);
    // A origem também é a de antes: confirmar não reescreve procedência.
    expect(ponto.source).toBe("IMPORTED");
    expect(ponto.accuracyMeters).toBe(s.location.accuracyMeters);

    const projecao = await prisma.customer.findUniqueOrThrow({ where: { id: s.customer.id } });
    expect(projecao.latitude?.equals(s.location.latitude)).toBe(true);
    expect(projecao.longitude?.equals(s.location.longitude)).toBe(true);
  });

  it("LOC-C10 · verified = true, com quem e quando — e a versão anda uma vez", async () => {
    const s = await atendimento();
    const o = aNorte(P, 35);
    await confirmar(s, { observedLatitude: o.latitude, observedLongitude: o.longitude });

    const ponto = await prisma.customerLocation.findUniqueOrThrow({ where: { id: s.location.id } });
    expect(ponto.verified).toBe(true);
    expect(ponto.verifiedAt).not.toBeNull();
    expect(ponto.verifiedByUserId).toBe(fixture.techA.id);
    expect(ponto.verifiedByTechnicianId).toBe(s.technician.id);
    expect(ponto.version).toBe(s.location.version + 1);
    const projecao = await prisma.customer.findUniqueOrThrow({ where: { id: s.customer.id } });
    expect(projecao.locationVerified).toBe(true);
  });

  it("LOC-C11 · a distância, a posição do aparelho e a precisão ficam registradas", async () => {
    const s = await atendimento();
    const o = aNorte(P, 32);
    await confirmar(s, {
      observedLatitude: o.latitude,
      observedLongitude: o.longitude,
      observedAccuracyMeters: 14,
    });

    // A trilha imutável: a assinatura de confirmação que a timeline e o pacote
    // técnico leem — técnico, OS, instante, de não verificado para verificado.
    const linhas = await prisma.customerLocationHistory.findMany({
      where: { customerId: s.customer.id },
      include: {
        changedBy: { select: { name: true } },
        technician: { select: { user: { select: { name: true } } } },
      },
    });
    expect(linhas).toHaveLength(1);
    const linha = linhas[0];
    expect(classificarLocalizacao(linha)).toBe("LOCATION_CONFIRMED");
    expect(linha.serviceOrderId).toBe(s.order.id);
    expect(linha.technicianId).toBe(s.technician.id);
    expect(linha.changedByUserId).toBe(fixture.techA.id);

    // Os VALORES, tipados: distância calculada no servidor, a posição de onde
    // se confirmou, a precisão declarada e o limite vigente.
    const evento = await prisma.serviceOrderEvent.findFirstOrThrow({
      where: { serviceOrderId: s.order.id, event: "LOCATION_CONFIRMED" },
    });
    const meta = evento.metadata as Record<string, unknown>;
    expect(meta.distanceMeters).toBe(32);
    expect(meta.accuracyMeters).toBe(14);
    expect(meta.observedLatitude).toBeCloseTo(o.latitude, 7);
    expect(meta.observedLongitude).toBeCloseTo(o.longitude, 7);
    expect(meta.confirmMaxDistanceMeters).toBe(100);
    expect(meta.technicianId).toBe(s.technician.id);

    const auditoria = await prisma.auditLog.findFirstOrThrow({
      where: { action: "CUSTOMER_LOCATION.CONFIRMED" },
    });
    expect(auditoria.details).toContain("32 m");
  });

  it("ponto já confirmado não se confirma de novo (409), mesmo perto", async () => {
    const s = await atendimento();
    const o = aNorte(P, 10);
    await confirmar(s, { observedLatitude: o.latitude, observedLongitude: o.longitude });
    const e = await erro(
      confirmCustomerLocation(s.companyId, fixture.techA.id, s.order.id, {
        expectedVersion: s.location.version + 1,
        observedLatitude: o.latitude,
        observedLongitude: o.longitude,
        observedAccuracyMeters: 8,
      }),
    );
    expect(e.status).toBe(409);
  });

  it("sem ponto cadastrado não há o que confirmar (404), mesmo com GPS válido", async () => {
    const s = await atendimento();
    await prisma.customerLocation.delete({ where: { id: s.location.id } });
    const e = await erro(
      confirmCustomerLocation(s.companyId, fixture.techA.id, s.order.id, {
        expectedVersion: 0,
        observedLatitude: P.latitude,
        observedLongitude: P.longitude,
        observedAccuracyMeters: 8,
      }),
    );
    expect(e.status).toBe(404);
    expect(e.message).toMatch(/correção/i);
  });

  it("a distância enviada pelo cliente é ignorada pelo serviço", async () => {
    const s = await atendimento();
    const longe = aNorte(P, 800);
    const e = await erro(
      confirmar(s, {
        observedLatitude: longe.latitude,
        observedLongitude: longe.longitude,
        // Um aparelho hostil "avaliando a si mesmo".
        distanceMeters: 5,
      }),
    );
    expect(e.status).toBe(400);
    await nadaGravado(s);
  });
});

// ---------------------------------------------------------------------------
// LOC-C12..C15 — quem e quando
// ---------------------------------------------------------------------------

describe("LOC-C12/C13 — tenant e posse", () => {
  async function tecnicoDaEmpresaB() {
    const user = await prisma.user.create({
      data: {
        companyId: fixture.companyB.id,
        name: "Tecnico Empresa B",
        email: "tech-rc1c@empresab.test",
        profile: "TECHNICIAN",
        passwordHash: "x",
      },
    });
    const tech = await tecnico(user.id, fixture.companyB.id);
    return { user, tech };
  }

  it("LOC-C12a · técnico da EMPRESA B com o id da OS da A e GPS no ponto: 404, nada gravado", async () => {
    const s = await atendimento();
    const { user } = await tecnicoDaEmpresaB();
    const e = await erro(
      confirmar(s, { observedLatitude: P.latitude, observedLongitude: P.longitude }, user.id, fixture.companyB.id),
    );
    expect(e.status).toBe(404);
    await nadaGravado(s);
  });

  it("LOC-C12b · o vetor da DQ-7.1 (OS da A apontando técnico da B): 404 GENÉRICO, nada gravado", async () => {
    const s = await atendimento();
    const { user, tech } = await tecnicoDaEmpresaB();
    // FK simples: nenhuma constraint `(companyId, technicianId)` impede isto.
    await prisma.serviceOrder.update({ where: { id: s.order.id }, data: { technicianId: tech.id } });

    const e = await erro(
      confirmar(s, { observedLatitude: P.latitude, observedLongitude: P.longitude }, user.id, fixture.companyB.id),
    );
    expect(e.status).toBe(404);
    // A recusa vem da porta da OS, e o corpo não conta que existe um cliente
    // ou um ponto do outro lado.
    expect(e.message).toBe("Ordem de serviço não encontrada.");
    await nadaGravado(s);
  });

  it("LOC-C13 · técnico da MESMA empresa que não é o dono, com GPS no ponto: 404, nada gravado", async () => {
    const s = await atendimento();
    const e = await erro(
      confirmar(s, { observedLatitude: P.latitude, observedLongitude: P.longitude }, fixture.techB.id),
    );
    expect(e.status).toBe(404);
    await nadaGravado(s);
  });

  it("controle positivo: o dono, no ponto, confirma", async () => {
    const s = await atendimento();
    const r = await confirmar(s, { observedLatitude: P.latitude, observedLongitude: P.longitude });
    expect(r.location.verified).toBe(true);
    expect(r.distanceMeters).toBe(0);
  });
});

describe("LOC-C14/C15 — só durante o atendimento", () => {
  it("LOC-C14 · OS ASSIGNED (não iniciada): 409, nada gravado", async () => {
    const s = await atendimento("ASSIGNED");
    const e = await erro(
      confirmar(s, { observedLatitude: P.latitude, observedLongitude: P.longitude }),
    );
    expect(e.status).toBe(409);
    await nadaGravado(s);
  });

  it("LOC-C15 · OS COMPLETED: 409, nada gravado", async () => {
    const s = await atendimento();
    await prisma.$executeRawUnsafe(
      `UPDATE service_orders SET status = 'COMPLETED', "completedAt" = now(), version = version + 1 WHERE id = $1`,
      s.order.id,
    );
    const e = await erro(
      confirmar(s, { observedLatitude: P.latitude, observedLongitude: P.longitude }),
    );
    expect(e.status).toBe(409);
    await nadaGravado(s);
  });
});

// ---------------------------------------------------------------------------
// Pela rota — por onde um aparelho entra
// ---------------------------------------------------------------------------

async function corpo(response: Response) {
  return (await response.json()) as {
    ok: boolean;
    data?: Record<string, unknown>;
    error?: { code: string; message: string; retryable: boolean; conflict: boolean };
  };
}

describe("a rota de confirmação", () => {
  function pedir(orderId: string, token: string, body: Record<string, unknown>) {
    return confirmRoute(
      fieldRequest(`/api/field/v1/service-orders/${orderId}/location/confirm`, {
        method: "POST",
        token,
        idempotencyKey: `rc1c-${Date.now()}-${Math.random()}`,
        body,
      }),
      { params: { id: orderId } },
    );
  }

  it("perto: 200, com a distância calculada no servidor", async () => {
    const s = await atendimento();
    const { token } = await registerTestDevice(fixture.techA.id);
    const o = aNorte(P, 45);
    const r = await pedir(s.order.id, token, {
      expectedVersion: s.location.version,
      observedLatitude: o.latitude,
      observedLongitude: o.longitude,
      observedAccuracyMeters: 9,
    });
    expect(r.status).toBe(200);
    const b = await corpo(r);
    expect(b.data?.distanceMeters).toBe(45);
    expect((b.data?.location as { verified: boolean }).verified).toBe(true);
  });

  it("longe: 400 VALIDATION_ERROR, nem retentável nem conflito — o app não recarrega nem insiste", async () => {
    const s = await atendimento();
    const { token } = await registerTestDevice(fixture.techA.id);
    const o = aNorte(P, 2357);
    const r = await pedir(s.order.id, token, {
      expectedVersion: s.location.version,
      observedLatitude: o.latitude,
      observedLongitude: o.longitude,
      observedAccuracyMeters: 12,
    });
    expect(r.status).toBe(400);
    const b = await corpo(r);
    expect(b.error?.code).toBe("VALIDATION_ERROR");
    expect(b.error?.retryable).toBe(false);
    expect(b.error?.conflict).toBe(false);
    expect(b.error?.message).toBe("Você está a 2,36 km do ponto cadastrado. Use Corrigir localização.");
    await nadaGravado(s);
  });

  it("sem GPS: 400, nada gravado", async () => {
    const s = await atendimento();
    const { token } = await registerTestDevice(fixture.techA.id);
    const r = await pedir(s.order.id, token, { expectedVersion: s.location.version });
    expect(r.status).toBe(400);
    await nadaGravado(s);
  });

  it("uma distância no corpo é recusada (.strict()), e o ponto longe continua não confirmado", async () => {
    const s = await atendimento();
    const { token } = await registerTestDevice(fixture.techA.id);
    const longe = aNorte(P, 900);
    const r = await pedir(s.order.id, token, {
      expectedVersion: s.location.version,
      observedLatitude: longe.latitude,
      observedLongitude: longe.longitude,
      observedAccuracyMeters: 12,
      distanceMeters: 3,
    });
    expect(r.status).toBe(400);
    await nadaGravado(s);
  });

  it("o pacote de execução diz ao aplicativo qual é o limite — a regra mora no servidor", async () => {
    const s = await atendimento();
    const { token } = await registerTestDevice(fixture.techA.id);
    const r = await executionRoute(
      fieldRequest(`/api/field/v1/service-orders/${s.order.id}/execution`, { token }),
      { params: { id: s.order.id } },
    );
    expect(r.status).toBe(200);
    const b = await corpo(r);
    const location = b.data?.location as Record<string, unknown>;
    expect(location.confirmMaxDistanceMeters).toBe(100);
    expect(location.status).toBe("UNCONFIRMED");
  });
});

// ---------------------------------------------------------------------------
// RC-1C-HOTFIX — precisão do GPS ≤ 50 m, antes da distância
// ---------------------------------------------------------------------------

/**
 * O caso físico que abriu a hotfix: no mesmo telefone, o Google Maps acertou o
 * lugar e o AlfaOS gravou um ponto a mais de 1 km. O aparelho tinha só a
 * permissão APROXIMADA, e o Android entrega essa posição com precisão de 2000 m
 * — o número que ficou gravado. A precisão era registrada e nunca exigida.
 *
 * Duas regras independentes: precisão ≤ 50 m E distância ≤ 100 m.
 */
describe("RC-1C-HOTFIX — o limite de precisão", () => {
  it("o limite é 50 m", () => {
    expect(LOCATION_GPS_MAX_ACCURACY_M).toBe(50);
  });

  it.each([
    [0.5, true],
    [12, true],
    [49.9, true],
    [50, true],
    [50.0001, false],
    [50.1, false],
    [50.6, false],
    [74, false],
    [1200, false],
    [2000, false],
  ])("%s m → aceita: %s — sobre o valor REAL, sem arredondar", (precisao, aceita) => {
    expect(isGpsAccuracyAllowed(precisao)).toBe(aceita);
  });

  it.each([
    [74, "74 m"],
    [50, "50 m"],
    [50.04, "50,1 m"],
    [50.6, "50,6 m"],
    [18.3, "18,3 m"],
    [184.2, "185 m"],
    [2000, "2000 m"],
  ])("a mensagem escreve %s como %s — arredondando PARA CIMA", (precisao, texto) => {
    // Para cima: "50 m" numa recusa de 50,04 m faria a regra parecer errada.
    expect(formatAccuracyMeters(precisao)).toBe(texto);
  });
});

describe("RC-1C-HOTFIX — confirmar exige precisão ≤ 50 m", () => {
  it("ACC-C01 · precisão 12 m a 80 m do ponto: confirma", async () => {
    const s = await atendimento();
    const o = aNorte(P, 80);
    const r = await confirmar(s, {
      observedLatitude: o.latitude,
      observedLongitude: o.longitude,
      observedAccuracyMeters: 12,
    });
    expect(r.location.verified).toBe(true);
    expect(r.distanceMeters).toBe(80);
  });

  it("ACC-C02 · precisão 70 m a 10 m do ponto: 400 pela PRECISÃO, nada gravado", async () => {
    const s = await atendimento();
    const o = aNorte(P, 10);
    const e = await erro(
      confirmar(s, {
        observedLatitude: o.latitude,
        observedLongitude: o.longitude,
        observedAccuracyMeters: 70,
      }),
    );
    expect(e.status).toBe(400);
    expect(e.message).toBe(
      "Precisão do GPS insuficiente: 70 m. Aguarde alguns segundos em um local mais aberto e tente novamente.",
    );
    await nadaGravado(s);
  });

  it("ACC-C03 · precisão 12 m a 120 m do ponto: 400 pelos 100 m — GPS bom não libera longe", async () => {
    const s = await atendimento();
    const o = aNorte(P, 120);
    const e = await erro(
      confirmar(s, {
        observedLatitude: o.latitude,
        observedLongitude: o.longitude,
        observedAccuracyMeters: 12,
      }),
    );
    expect(e.status).toBe(400);
    expect(e.message).toBe("Você está a 120 m do ponto cadastrado. Use Corrigir localização.");
    await nadaGravado(s);
  });

  it("ACC-C04 · precisão 220 m: a distância NÃO importa — a recusa é da precisão", async () => {
    const s = await atendimento();
    const longe = aNorte(P, 2357);
    const e = await erro(
      confirmar(s, {
        observedLatitude: longe.latitude,
        observedLongitude: longe.longitude,
        observedAccuracyMeters: 220,
      }),
    );
    expect(e.message).toMatch(/^Precisão do GPS insuficiente: 220 m\./);
    expect(e.message).not.toMatch(/ponto cadastrado/);
    await nadaGravado(s);
  });

  it("ACC-C05 · precisão AUSENTE: 400, nada gravado — não é 'sem limite'", async () => {
    const s = await atendimento();
    const e = await erro(
      confirmar(s, {
        observedLatitude: P.latitude,
        observedLongitude: P.longitude,
        observedAccuracyMeters: null,
      }),
    );
    expect(e.status).toBe(400);
    expect(e.message).toBe(
      "Não é possível confirmar sem a precisão do GPS. Obtenha a posição novamente e tente outra vez.",
    );
    await nadaGravado(s);
  });

  it.each([
    ["zero (o 'não medido' do plugin)", 0],
    ["negativa", -1],
    ["NaN", Number.NaN],
    ["infinita", Number.POSITIVE_INFINITY],
  ])("ACC-C06 · precisão inválida (%s): 400, nada gravado", async (_label, precisao) => {
    const s = await atendimento();
    const e = await erro(
      confirmar(s, {
        observedLatitude: P.latitude,
        observedLongitude: P.longitude,
        observedAccuracyMeters: precisao,
      }),
    );
    expect(e.status).toBe(400);
    expect(e.message).toBe("Precisão de localização inválida.");
    await nadaGravado(s);
  });

  it("ACC-C07a · 50,0 m — exatamente o limite — confirma", async () => {
    const limite = await atendimento();
    const r = await confirmar(limite, {
      observedLatitude: P.latitude,
      observedLongitude: P.longitude,
      observedAccuracyMeters: 50,
    });
    expect(r.location.verified).toBe(true);
  });

  it("ACC-C07b · 50,1 m não confirma — e a mensagem não escreve '50 m'", async () => {
    const acima = await atendimento();
    const e = await erro(
      confirmar(acima, {
        observedLatitude: P.latitude,
        observedLongitude: P.longitude,
        observedAccuracyMeters: 50.1,
      }),
    );
    expect(e.status).toBe(400);
    expect(e.message).toContain("50,1 m");
    await nadaGravado(acima);
  });

  it("ACC-C08 · o caso físico: precisão 2000 m (posição APROXIMADA do Android) no próprio ponto: 400", async () => {
    const s = await atendimento();
    const e = await erro(
      confirmar(s, {
        observedLatitude: P.latitude,
        observedLongitude: P.longitude,
        observedAccuracyMeters: 2000,
      }),
    );
    expect(e.status).toBe(400);
    expect(e.message).toContain("2000 m");
    await nadaGravado(s);
  });

  it("a ordem do contrato continua: técnico que não é o dono, com precisão ruim, recebe o 404 da OS", async () => {
    // A precisão não pode virar um oráculo: quem não pode mexer na OS não
    // descobre, pela mensagem de GPS, que existe um ponto do outro lado.
    const s = await atendimento();
    const e = await erro(
      confirmar(
        s,
        { observedLatitude: P.latitude, observedLongitude: P.longitude, observedAccuracyMeters: 1500 },
        fixture.techB.id,
      ),
    );
    expect(e.status).toBe(404);
    await nadaGravado(s);
  });

  it("o limite vigente fica registrado no evento, ao lado do de distância", async () => {
    const s = await atendimento();
    await confirmar(s, {
      observedLatitude: P.latitude,
      observedLongitude: P.longitude,
      observedAccuracyMeters: 18.4,
    });
    const evento = await prisma.serviceOrderEvent.findFirstOrThrow({
      where: { serviceOrderId: s.order.id, event: "LOCATION_CONFIRMED" },
    });
    const meta = evento.metadata as Record<string, unknown>;
    expect(meta.gpsMaxAccuracyMeters).toBe(50);
    // A coluna guarda metro inteiro; a regra foi decidida sobre o valor bruto.
    expect(meta.accuracyMeters).toBe(18);
  });
});

describe("RC-1C-HOTFIX — pela rota: um cliente sabotado não contorna a precisão", () => {
  function pedir(orderId: string, token: string, body: Record<string, unknown>) {
    return confirmRoute(
      fieldRequest(`/api/field/v1/service-orders/${orderId}/location/confirm`, {
        method: "POST",
        token,
        idempotencyKey: `hotfix-${Date.now()}-${Math.random()}`,
        body,
      }),
      { params: { id: orderId } },
    );
  }

  it("coordenada válida NO ponto com precisão 1500 m: 400 VALIDATION_ERROR, nada gravado", async () => {
    const s = await atendimento();
    const { token } = await registerTestDevice(fixture.techA.id);
    const r = await pedir(s.order.id, token, {
      expectedVersion: s.location.version,
      observedLatitude: P.latitude,
      observedLongitude: P.longitude,
      observedAccuracyMeters: 1500,
    });
    expect(r.status).toBe(400);
    const b = await corpo(r);
    expect(b.error?.code).toBe("VALIDATION_ERROR");
    expect(b.error?.retryable).toBe(false);
    expect(b.error?.message).toBe(
      "Precisão do GPS insuficiente: 1500 m. Aguarde alguns segundos em um local mais aberto e tente novamente.",
    );
    await nadaGravado(s);
  });

  it("um APK que não manda precisão: 400, nada gravado", async () => {
    const s = await atendimento();
    const { token } = await registerTestDevice(fixture.techA.id);
    const r = await pedir(s.order.id, token, {
      expectedVersion: s.location.version,
      observedLatitude: P.latitude,
      observedLongitude: P.longitude,
    });
    expect(r.status).toBe(400);
    await nadaGravado(s);
  });

  it("controle positivo: a mesma requisição com 9 m confirma", async () => {
    const s = await atendimento();
    const { token } = await registerTestDevice(fixture.techA.id);
    const r = await pedir(s.order.id, token, {
      expectedVersion: s.location.version,
      observedLatitude: P.latitude,
      observedLongitude: P.longitude,
      observedAccuracyMeters: 9,
    });
    expect(r.status).toBe(200);
  });

  it("o pacote de execução diz ao aplicativo qual é o limite de precisão", async () => {
    const s = await atendimento();
    const { token } = await registerTestDevice(fixture.techA.id);
    const r = await executionRoute(
      fieldRequest(`/api/field/v1/service-orders/${s.order.id}/execution`, { token }),
      { params: { id: s.order.id } },
    );
    const b = await corpo(r);
    expect((b.data?.location as Record<string, unknown>).gpsMaxAccuracyMeters).toBe(50);
  });
});
