import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { POST as checkInRoute } from "@/app/api/field/v1/service-orders/[id]/check-in/route";
import { POST as correctLocationRoute } from "@/app/api/field/v1/service-orders/[id]/location/correct/route";
import { POST as materialsRoute } from "@/app/api/field/v1/service-orders/[id]/materials/route";
import { POST as equipmentRoute } from "@/app/api/field/v1/service-orders/[id]/equipment/route";
import { POST as removeEquipmentRoute } from "@/app/api/field/v1/service-orders/[id]/equipment/[equipmentId]/route";
import { POST as evidenceRoute } from "@/app/api/field/v1/service-orders/[id]/evidence/route";
import { POST as removeEvidenceRoute } from "@/app/api/field/v1/service-orders/[id]/evidence/[evidenceId]/route";
import { POST as completeRoute } from "@/app/api/field/v1/service-orders/[id]/complete/route";
import { GET as executionRoute } from "@/app/api/field/v1/service-orders/[id]/execution/route";
import { GET as inventoryRoute } from "@/app/api/field/v1/inventory/route";
import { prisma } from "@/lib/prisma";
import { LocalFileStorageAdapter, setFileStorage } from "@/lib/storage";
import { createInventoryItem, receiveStock } from "@/lib/inventory";
import { putCompletionPolicy } from "@/lib/service-order-completion";
import { startServiceOrder, updateServiceOrderExecution } from "@/lib/service-orders";
import {
  allocateTestServiceOrderNumber,
  fieldRequest,
  registerTestDevice,
  seedTestData,
  type TestFixture,
} from "./helpers";

/**
 * # Ataques à execução em campo (v0.10)
 *
 * Continuação de `field-security.test.ts`, que nasceu da auditoria da v0.9 pelo
 * mesmo motivo: cada bloco cobre um caminho que a suíte funcional não
 * exercita, e apagá-los ao fim da auditoria devolveria essa cobertura a zero.
 *
 * A diferença para `field-execution.test.ts` é a CAMADA. Lá os ataques entram
 * pelo serviço; aqui entram pela ROTA — que é por onde um aparelho hostil
 * entra. Um `.strict()` esquecido, um `companyId` lido do corpo ou uma cota
 * gasta antes da autorização só aparecem deste lado.
 *
 * Cada bloco descreve o ATAQUE, não a funcionalidade.
 */

let fixture: TestFixture;
let storageRoot: string;

beforeAll(async () => {
  storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "alfaos-v010-sec-"));
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

/** Um executável de verdade (cabeçalho MZ), que será renomeado para .jpg. */
const WINDOWS_EXE = Buffer.concat([
  Buffer.from([0x4d, 0x5a, 0x90, 0x00]),
  Buffer.alloc(120, 0),
]);

async function body(response: Response) {
  return (await response.json()) as {
    ok: boolean;
    data?: Record<string, unknown>;
    error?: {
      code: string;
      message: string;
      retryable: boolean;
      conflict: boolean;
      pendencies?: { code: string }[];
    };
  };
}

function formRequest(url: string, form: FormData, token: string, key: string) {
  return new Request(`http://localhost${url}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Idempotency-Key": key },
    body: form,
  });
}

interface Actor {
  token: string;
  userId: string;
  technicianId: string;
  orderId: string;
  customerId: string;
  orderVersion: number;
  executionVersion: number;
}

async function actor(userId: string, companyId = fixture.companyA.id): Promise<Actor> {
  const customer = await prisma.customer.create({
    data: {
      companyId,
      name: "Cliente Ficticio Seguranca",
      document: "000.000.000-00",
      city: "Cidade Teste",
    },
  });
  const technician = await prisma.technician.upsert({
    where: { userId },
    update: {},
    create: { companyId, userId },
  });
  const order = await prisma.serviceOrder.create({
    data: {
      companyId,
      number: await allocateTestServiceOrderNumber(companyId),
      customerId: customer.id,
      technicianId: technician.id,
      type: "Instalação",
      description: "OS de fixture para ataque.",
      status: "ASSIGNED",
      assignedAt: new Date(),
    },
  });
  const started = await startServiceOrder(companyId, userId, order.id, order.version);
  const saved = await updateServiceOrderExecution(
    companyId,
    userId,
    order.id,
    started.execution.version,
    { diagnosis: "Diagnóstico.", workPerformed: "Serviço." },
  );
  const current = await prisma.serviceOrder.findUniqueOrThrow({
    where: { id: order.id },
    select: { version: true },
  });
  const { token } = await registerTestDevice(userId);

  return {
    token,
    userId,
    technicianId: technician.id,
    orderId: order.id,
    customerId: customer.id,
    orderVersion: current.version,
    executionVersion: saved.version,
  };
}

// ---------------------------------------------------------------------------

describe("B1 · o corpo não escolhe empresa, técnico nem versão", () => {
  /**
   * Todo schema do Field é `.strict()`. A diferença entre recusar e descartar
   * em silêncio importa: um aplicativo que envia `companyId` está tentando
   * decidir autorização pelo corpo e precisa ouvir um "não", em vez de achar
   * que funcionou.
   */
  it.each([
    ["companyId", { companyId: "outra-empresa" }],
    ["technicianId", { technicianId: "outro-tecnico" }],
    ["userId", { userId: "outro-usuario" }],
    ["status", { status: "COMPLETED" }],
    ["version", { version: 99 }],
  ])("check-in recusa campo desconhecido: %s", async (_label, extra) => {
    const a = await actor(fixture.techA.id);
    const response = await checkInRoute(
      fieldRequest(`/api/field/v1/service-orders/${a.orderId}/check-in`, {
        method: "POST",
        token: a.token,
        idempotencyKey: `sec-strict-${Date.now()}-${Math.random()}`,
        body: { expectedVersion: a.orderVersion, ...extra },
      }),
      { params: { id: a.orderId } },
    );

    expect(response.status).toBe(400);
    expect((await body(response)).error?.code).toBe("VALIDATION_ERROR");

    // Controle positivo: sem o campo hostil, o MESMO comando passa. Sem isto o
    // teste poderia estar passando por qualquer outra recusa.
    const ok = await checkInRoute(
      fieldRequest(`/api/field/v1/service-orders/${a.orderId}/check-in`, {
        method: "POST",
        token: a.token,
        idempotencyKey: `sec-ok-${Date.now()}-${Math.random()}`,
        body: { expectedVersion: a.orderVersion },
      }),
      { params: { id: a.orderId } },
    );
    expect(ok.status).toBe(201);
  });

  it("material não aceita source de estoque escolhida pelo corpo", async () => {
    const a = await actor(fixture.techA.id);
    const item = await createInventoryItem(fixture.companyA.id, fixture.adminA.id, {
      code: "CABO",
      name: "Cabo",
      unit: "METER",
    });
    const response = await materialsRoute(
      fieldRequest(`/api/field/v1/service-orders/${a.orderId}/materials`, {
        method: "POST",
        token: a.token,
        idempotencyKey: `sec-mat-${Date.now()}`,
        body: {
          expectedVersion: a.orderVersion,
          itemId: item.id,
          quantity: 1,
          // Tentativa de emitir ENTRADA pelo aplicativo: se passasse, o técnico
          // criaria o próprio saldo antes de baixá-lo.
          type: "WAREHOUSE_TO_TECHNICIAN",
          technicianId: "outro",
        },
      }),
      { params: { id: a.orderId } },
    );
    expect(response.status).toBe(400);
    expect((await body(response)).error?.code).toBe("VALIDATION_ERROR");
  });

  it("correção de localização não aceita origem de processo automático", async () => {
    const a = await actor(fixture.techA.id);
    const response = await correctLocationRoute(
      fieldRequest(`/api/field/v1/service-orders/${a.orderId}/location/correct`, {
        method: "POST",
        token: a.token,
        idempotencyKey: `sec-loc-${Date.now()}`,
        body: {
          expectedVersion: null,
          reason: "INCORRECT_LOCATION",
          latitude: -23.5,
          longitude: -46.6,
          // `IMPORTED` descreve um processo do servidor. Se o aplicativo
          // pudesse alegá-la, a precedência da §197 passaria a depender do que
          // o aparelho diz sobre si mesmo.
          source: "IMPORTED",
        },
      }),
      { params: { id: a.orderId } },
    );
    expect(response.status).toBe(400);
  });
});

describe("B2 · GPS hostil pela rota", () => {
  it.each([
    ["latitude acima de 90", 91, -46.6],
    ["longitude acima de 180", -23.5, 181],
    ["ilha nula", 0, 0],
  ])("recusa %s", async (_label, latitude, longitude) => {
    const a = await actor(fixture.techA.id);
    const response = await checkInRoute(
      fieldRequest(`/api/field/v1/service-orders/${a.orderId}/check-in`, {
        method: "POST",
        token: a.token,
        idempotencyKey: `sec-gps-${Date.now()}-${Math.random()}`,
        body: { expectedVersion: a.orderVersion, latitude, longitude },
      }),
      { params: { id: a.orderId } },
    );
    expect(response.status).toBe(400);

    // E nada foi gravado: uma recusa não pode deixar check-in pela metade.
    expect(
      await prisma.serviceOrderCheckIn.count({ where: { serviceOrderId: a.orderId } }),
    ).toBe(0);
  });

  it("precisão negativa é recusada", async () => {
    const a = await actor(fixture.techA.id);
    const response = await checkInRoute(
      fieldRequest(`/api/field/v1/service-orders/${a.orderId}/check-in`, {
        method: "POST",
        token: a.token,
        idempotencyKey: `sec-acc-${Date.now()}`,
        body: {
          expectedVersion: a.orderVersion,
          latitude: -23.5,
          longitude: -46.6,
          accuracyMeters: -1,
        },
      }),
      { params: { id: a.orderId } },
    );
    expect(response.status).toBe(400);
  });
});

describe("B3 · idempotência não é oráculo sobre operação alheia", () => {
  /**
   * A chave vem do aparelho e é entrada NÃO confiável: ela evita duplicação,
   * não prova autorização. O escopo único inclui empresa e usuário justamente
   * para que reapresentar a chave de outra pessoa não devolva o resultado dela.
   */
  it("a mesma chave de outro técnico não devolve o desfecho dele", async () => {
    const a = await actor(fixture.techA.id);
    const b = await actor(fixture.techB.id);
    const sharedKey = "chave-compartilhada-1234";

    const first = await checkInRoute(
      fieldRequest(`/api/field/v1/service-orders/${a.orderId}/check-in`, {
        method: "POST",
        token: a.token,
        idempotencyKey: sharedKey,
        body: { expectedVersion: a.orderVersion },
      }),
      { params: { id: a.orderId } },
    );
    expect(first.status).toBe(201);
    const firstBody = await body(first);
    const firstCheckInId = (firstBody.data?.checkIn as { id: string }).id;

    // B reapresenta a MESMA chave, apontando para a OS DELE.
    const second = await checkInRoute(
      fieldRequest(`/api/field/v1/service-orders/${b.orderId}/check-in`, {
        method: "POST",
        token: b.token,
        idempotencyKey: sharedKey,
        body: { expectedVersion: b.orderVersion },
      }),
      { params: { id: b.orderId } },
    );
    expect(second.status).toBe(201);
    const secondBody = await body(second);
    const secondCheckInId = (secondBody.data?.checkIn as { id: string }).id;

    // Desfechos INDEPENDENTES: B recebeu o próprio check-in, não o de A.
    expect(secondCheckInId).not.toBe(firstCheckInId);
  });

  it("mesma chave com conteúdo diferente é conflito, não repetição", async () => {
    const a = await actor(fixture.techA.id);
    const key = "chave-reaproveitada-9876";

    const first = await checkInRoute(
      fieldRequest(`/api/field/v1/service-orders/${a.orderId}/check-in`, {
        method: "POST",
        token: a.token,
        idempotencyKey: key,
        body: { expectedVersion: a.orderVersion, latitude: -23.5, longitude: -46.6 },
      }),
      { params: { id: a.orderId } },
    );
    expect(first.status).toBe(201);

    const second = await checkInRoute(
      fieldRequest(`/api/field/v1/service-orders/${a.orderId}/check-in`, {
        method: "POST",
        token: a.token,
        idempotencyKey: key,
        body: { expectedVersion: a.orderVersion, latitude: -10.0, longitude: -40.0 },
      }),
      { params: { id: a.orderId } },
    );
    expect(second.status).toBe(409);
    expect((await body(second)).error?.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("retentativa idêntica reproduz o desfecho sem segundo efeito", async () => {
    const a = await actor(fixture.techA.id);
    const key = "chave-retentativa-5555";
    const payload = { expectedVersion: a.orderVersion };

    const first = await checkInRoute(
      fieldRequest(`/api/field/v1/service-orders/${a.orderId}/check-in`, {
        method: "POST",
        token: a.token,
        idempotencyKey: key,
        body: payload,
      }),
      { params: { id: a.orderId } },
    );
    const second = await checkInRoute(
      fieldRequest(`/api/field/v1/service-orders/${a.orderId}/check-in`, {
        method: "POST",
        token: a.token,
        idempotencyKey: key,
        body: payload,
      }),
      { params: { id: a.orderId } },
    );

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    // UM check-in, não dois.
    expect(
      await prisma.serviceOrderCheckIn.count({ where: { serviceOrderId: a.orderId } }),
    ).toBe(1);
  });
});

describe("B4 · upload não confia em nada que o cliente diz", () => {
  it("executável renomeado .jpg é recusado", async () => {
    const a = await actor(fixture.techA.id);
    const form = new FormData();
    form.set(
      "file",
      new File([new Uint8Array(WINDOWS_EXE)], "foto.jpg", { type: "image/jpeg" }),
    );
    form.set("expectedOrderVersion", String(a.orderVersion));

    const response = await evidenceRoute(
      formRequest(
        `/api/field/v1/service-orders/${a.orderId}/evidence`,
        form,
        a.token,
        `sec-exe-${Date.now()}`,
      ),
      { params: { id: a.orderId } },
    );

    expect(response.status).toBe(400);
    expect(
      await prisma.serviceOrderEvidence.count({ where: { serviceOrderId: a.orderId } }),
    ).toBe(0);
    // Nenhum arquivo órfão ficou no storage.
    const files = await fs.readdir(storageRoot, { recursive: true });
    expect(
      (files as string[]).filter((f) => f.endsWith(".jpg")).length,
    ).toBe(0);
  });

  it("nome com path traversal não influencia a chave de storage", async () => {
    const a = await actor(fixture.techA.id);
    const form = new FormData();
    form.set(
      "file",
      new File([new Uint8Array(PNG)], "../../../etc/passwd.png", {
        type: "image/png",
      }),
    );
    form.set("expectedOrderVersion", String(a.orderVersion));
    form.set("category", "ONU_ONT");

    const response = await evidenceRoute(
      formRequest(
        `/api/field/v1/service-orders/${a.orderId}/evidence`,
        form,
        a.token,
        `sec-trav-${Date.now()}`,
      ),
      { params: { id: a.orderId } },
    );
    expect(response.status).toBe(201);

    const evidence = await prisma.serviceOrderEvidence.findFirstOrThrow({
      where: { serviceOrderId: a.orderId },
    });
    // O nome é preservado só para exibição; a chave é gerada no servidor.
    expect(evidence.originalName).toContain("passwd");
    expect(evidence.storageKey).not.toContain("..");
    expect(evidence.storageKey).toMatch(
      /^[a-z0-9]+\/[a-z0-9]+\/[a-z0-9]+\.(jpg|png|webp)$/,
    );
    expect(evidence.storageKey.startsWith(`${fixture.companyA.id}/`)).toBe(true);
  });

  it("categoria inventada é recusada", async () => {
    const a = await actor(fixture.techA.id);
    const form = new FormData();
    form.set("file", new File([new Uint8Array(PNG)], "x.png", { type: "image/png" }));
    form.set("expectedOrderVersion", String(a.orderVersion));
    form.set("category", "CATEGORIA_INVENTADA");

    const response = await evidenceRoute(
      formRequest(
        `/api/field/v1/service-orders/${a.orderId}/evidence`,
        form,
        a.token,
        `sec-cat-${Date.now()}`,
      ),
      { params: { id: a.orderId } },
    );
    expect(response.status).toBe(400);
  });

  it("partes extras do formulário são ignoradas, não obedecidas", async () => {
    const a = await actor(fixture.techA.id);
    const form = new FormData();
    form.set("file", new File([new Uint8Array(PNG)], "x.png", { type: "image/png" }));
    form.set("expectedOrderVersion", String(a.orderVersion));
    form.set("companyId", fixture.companyB.id);
    form.set("storageKey", "../../../evil.png");
    form.set("uploadedByUserId", fixture.adminB.id);

    const response = await evidenceRoute(
      formRequest(
        `/api/field/v1/service-orders/${a.orderId}/evidence`,
        form,
        a.token,
        `sec-extra-${Date.now()}`,
      ),
      { params: { id: a.orderId } },
    );
    expect(response.status).toBe(201);

    const evidence = await prisma.serviceOrderEvidence.findFirstOrThrow({
      where: { serviceOrderId: a.orderId },
    });
    expect(evidence.companyId).toBe(fixture.companyA.id);
    expect(evidence.uploadedByUserId).toBe(a.userId);
    expect(evidence.storageKey).not.toContain("evil");
  });
});

describe("B5 · IDOR nos recursos-filhos", () => {
  it("evidência de OS alheia não é removível pelo id", async () => {
    const a = await actor(fixture.techA.id);
    const b = await actor(fixture.techB.id);

    const form = new FormData();
    form.set("file", new File([new Uint8Array(PNG)], "b.png", { type: "image/png" }));
    form.set("expectedOrderVersion", String(b.orderVersion));
    await evidenceRoute(
      formRequest(
        `/api/field/v1/service-orders/${b.orderId}/evidence`,
        form,
        b.token,
        `sec-b-${Date.now()}`,
      ),
      { params: { id: b.orderId } },
    );
    const alheia = await prisma.serviceOrderEvidence.findFirstOrThrow({
      where: { serviceOrderId: b.orderId },
    });

    // A tenta remover, apontando a PRÓPRIA OS mas o id da evidência de B.
    const response = await removeEvidenceRoute(
      fieldRequest(
        `/api/field/v1/service-orders/${a.orderId}/evidence/${alheia.id}`,
        {
          method: "POST",
          token: a.token,
          idempotencyKey: `sec-idor-${Date.now()}`,
          body: { expectedVersion: a.orderVersion },
        },
      ),
      { params: { id: a.orderId, evidenceId: alheia.id } },
    );

    expect(response.status).toBe(404);
    expect(
      await prisma.serviceOrderEvidence.count({ where: { id: alheia.id } }),
    ).toBe(1);
  });

  it("equipamento de OS alheia não é removível pelo id", async () => {
    const a = await actor(fixture.techA.id);
    const b = await actor(fixture.techB.id);

    await equipmentRoute(
      fieldRequest(`/api/field/v1/service-orders/${b.orderId}/equipment`, {
        method: "POST",
        token: b.token,
        idempotencyKey: `sec-eqb-${Date.now()}`,
        body: {
          expectedVersion: b.orderVersion,
          equipmentType: "ONU",
          serial: "ALHEIO123456",
        },
      }),
      { params: { id: b.orderId } },
    );
    const alheio = await prisma.serviceOrderEquipment.findFirstOrThrow({
      where: { serviceOrderId: b.orderId },
    });

    const response = await removeEquipmentRoute(
      fieldRequest(
        `/api/field/v1/service-orders/${a.orderId}/equipment/${alheio.id}`,
        {
          method: "POST",
          token: a.token,
          idempotencyKey: `sec-idoreq-${Date.now()}`,
          body: { expectedVersion: a.orderVersion },
        },
      ),
      { params: { id: a.orderId, equipmentId: alheio.id } },
    );

    expect(response.status).toBe(404);
    expect(
      await prisma.serviceOrderEquipment.count({ where: { id: alheio.id } }),
    ).toBe(1);
  });

  it("pacote de execução de OS alheia devolve 404, não 403", async () => {
    const a = await actor(fixture.techA.id);
    const b = await actor(fixture.techB.id);

    const response = await executionRoute(
      fieldRequest(`/api/field/v1/service-orders/${b.orderId}/execution`, {
        token: a.token,
      }),
      { params: { id: b.orderId } },
    );

    // 403 confirmaria que o id existe — o fato que um técnico sondando ids não
    // pode aprender.
    expect(response.status).toBe(404);
    const payload = await body(response);
    expect(payload.error?.code).toBe("NOT_FOUND");
    expect(JSON.stringify(payload)).not.toContain(b.customerId);
  });
});

describe("B6 · o Field não recebe o que não precisa", () => {
  it("o pacote de execução não carrega CPF nem dado de provider", async () => {
    const a = await actor(fixture.techA.id);
    const response = await executionRoute(
      fieldRequest(`/api/field/v1/service-orders/${a.orderId}/execution`, {
        token: a.token,
      }),
      { params: { id: a.orderId } },
    );
    expect(response.status).toBe(200);

    const raw = JSON.stringify(await body(response));
    // O cliente da fixture TEM documento gravado — controle positivo de que a
    // ausência abaixo é minimização, e não fixture vazia.
    const customer = await prisma.customer.findUniqueOrThrow({
      where: { id: a.customerId },
    });
    expect(customer.document).toBeTruthy();

    expect(raw).not.toContain(customer.document!);
    expect(raw).not.toContain("document");
    expect(raw).not.toContain("externalProvider");
    expect(raw).not.toContain("RECEITANET");
  });

  it("o estoque do Field é só o do próprio técnico", async () => {
    const a = await actor(fixture.techA.id);
    const b = await actor(fixture.techB.id);

    const item = await createInventoryItem(fixture.companyA.id, fixture.adminA.id, {
      code: "SO-DO-B",
      name: "Item do técnico B",
      unit: "UNIT",
    });
    await receiveStock(fixture.companyA.id, fixture.adminA.id, {
      itemId: item.id,
      technicianId: b.technicianId,
      quantity: 10,
    });

    const response = await inventoryRoute(
      fieldRequest("/api/field/v1/inventory", { token: a.token }),
    );
    expect(response.status).toBe(200);
    const payload = await body(response);
    expect((payload.data?.items as unknown[]).length).toBe(0);

    // Controle positivo: com saldo próprio, o mesmo endpoint devolve.
    await receiveStock(fixture.companyA.id, fixture.adminA.id, {
      itemId: item.id,
      technicianId: a.technicianId,
      quantity: 3,
    });
    const own = await inventoryRoute(
      fieldRequest("/api/field/v1/inventory", { token: a.token }),
    );
    expect(((await body(own)).data?.items as unknown[]).length).toBe(1);
  });
});

describe("B7 · pendências de conclusão saem estruturadas", () => {
  it("a rota devolve códigos estáveis, não só uma frase", async () => {
    const a = await actor(fixture.techA.id);
    // A OS da fixture não tem `typeId`, então a política precisa ser ligada a
    // um tipo e a OS precisa apontar para ele.
    await prisma.serviceOrder.update({
      where: { id: a.orderId },
      data: { typeId: fixture.typeA.id },
    });
    await putCompletionPolicy(
      fixture.companyA.id,
      fixture.adminA.id,
      fixture.typeA.id,
      {
        requireChecklist: false,
        requireSignature: true,
        requireMaterials: false,
        requireEquipment: true,
        requireCheckIn: true,
        minEvidenceCount: 0,
        requiredEvidenceCategories: [],
      },
    );

    const version = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: a.orderId },
      select: { version: true },
    });

    const response = await completeRoute(
      fieldRequest(`/api/field/v1/service-orders/${a.orderId}/complete`, {
        method: "POST",
        token: a.token,
        idempotencyKey: `sec-comp-${Date.now()}`,
        body: {
          expectedVersion: version.version,
          expectedExecutionVersion: a.executionVersion,
        },
      }),
      { params: { id: a.orderId } },
    );

    expect(response.status).toBe(400);
    const payload = await body(response);
    expect(payload.error?.code).toBe("VALIDATION_ERROR");
    // `conflict` false: recarregar não resolve; faltam requisitos.
    expect(payload.error?.conflict).toBe(false);
    expect(payload.error?.retryable).toBe(false);

    const codes = (payload.error?.pendencies ?? []).map((p) => p.code);
    expect(codes).toContain("SIGNATURE_REQUIRED");
    expect(codes).toContain("EQUIPMENT_REQUIRED");
    expect(codes).toContain("CHECK_IN_REQUIRED");

    // E a OS continua aberta.
    const order = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: a.orderId },
    });
    expect(order.status).toBe("IN_PROGRESS");
  });
});

describe("B8 · token", () => {
  it("nenhum comando novo aceita cookie no lugar do Bearer", async () => {
    const a = await actor(fixture.techA.id);
    // Cookie de sessão da WEB, sem Authorization. O Field só lê Bearer, então
    // esta requisição não tem identidade nenhuma — é a razão de a superfície
    // não precisar de `assertSameOrigin`.
    const request = new Request(
      `http://localhost/api/field/v1/service-orders/${a.orderId}/check-in`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `alfaos_session=qualquer-coisa`,
          "Idempotency-Key": "sec-cookie-1234",
        },
        body: JSON.stringify({ expectedVersion: a.orderVersion }),
      },
    );

    const response = await checkInRoute(request, { params: { id: a.orderId } });
    expect(response.status).toBe(401);
    expect((await body(response)).error?.code).toBe("UNAUTHENTICATED");
  });

  it("aparelho revogado perde acesso aos comandos novos imediatamente", async () => {
    const a = await actor(fixture.techA.id);
    await prisma.mobileDevice.updateMany({
      where: { userId: a.userId },
      data: { status: "REVOKED", revokedAt: new Date() },
    });

    const response = await checkInRoute(
      fieldRequest(`/api/field/v1/service-orders/${a.orderId}/check-in`, {
        method: "POST",
        token: a.token,
        idempotencyKey: "sec-revogado-1234",
        body: { expectedVersion: a.orderVersion },
      }),
      { params: { id: a.orderId } },
    );

    expect(response.status).toBe(401);
    expect(
      await prisma.serviceOrderCheckIn.count({ where: { serviceOrderId: a.orderId } }),
    ).toBe(0);
    // A revogação também não deixa reserva de idempotência para trás.
    expect(
      await prisma.idempotencyRecord.count({ where: { key: "sec-revogado-1234" } }),
    ).toBe(0);
  });
});
