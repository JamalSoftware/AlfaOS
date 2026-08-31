import { describe, it, expect, beforeEach } from "vitest";
import type { ServiceOrderPriority } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { GET as getQueue } from "@/app/api/dispatch/technicians/[technicianId]/queue/route";
import { POST as reorder } from "@/app/api/dispatch/technicians/[technicianId]/queue/reorder/route";
import { POST as changePriority } from "@/app/api/service-orders/[id]/priority/route";
import { POST as assignRoute } from "@/app/api/service-orders/[id]/assign/route";
import {
  apiRequest,
  createTokenFor,
  seedTestData,
  type TestFixture,
} from "./helpers";

/**
 * # Fila operacional — API administrativa (DQ-3)
 *
 * Pelas ROTAS, não pelo serviço: o que esta fase entrega é superfície externa,
 * e é ela que a DQ-4 vai consumir. Testar só a primitiva provaria o domínio e
 * deixaria RBAC, zod e idempotência sem cobertura.
 *
 * `T-S1`–`T-S8` e `T-C6` são os cenários literais de `docs/DISPATCH-QUEUE.md`.
 */

let fixture: TestFixture;
let adminToken: string;
let dispatcherToken: string;
let technicianToken: string;
let techA1: { id: string; userId: string };
let techA2: { id: string };
let techB1: { id: string };

beforeEach(async () => {
  fixture = await seedTestData();
  adminToken = await createTokenFor(fixture.adminA.id);
  dispatcherToken = await createTokenFor(fixture.dispatcherA.id);
  technicianToken = await createTokenFor(fixture.techA.id);
  techA1 = await prisma.technician.create({
    data: { companyId: fixture.companyA.id, userId: fixture.techA.id },
    select: { id: true, userId: true },
  });
  techA2 = await prisma.technician.create({
    data: { companyId: fixture.companyA.id, userId: fixture.techB.id },
    select: { id: true },
  });
  techB1 = await prisma.technician.create({
    data: { companyId: fixture.companyB.id, userId: fixture.adminB.id },
    select: { id: true },
  });
});

let seq = 0;

async function makeOrder(
  priority: ServiceOrderPriority,
  companyId = fixture.companyA.id,
): Promise<{ id: string; number: number }> {
  const customer = await prisma.customer.create({
    data: {
      companyId,
      name: `Cliente ${(seq += 1)}`,
      district: "Centro",
      city: "Guaçuí",
    },
  });
  const counter = await prisma.serviceOrderCounter.upsert({
    where: { companyId },
    create: { companyId, lastNumber: 1 },
    update: { lastNumber: { increment: 1 } },
  });
  return prisma.serviceOrder.create({
    data: {
      companyId,
      customerId: customer.id,
      number: counter.lastNumber,
      type: "Instalação",
      description: "OS de teste",
      priority,
      status: "PENDING",
    },
    select: { id: true, number: true },
  });
}

let keySeq = 0;
/** Chave única por chamada, salvo quando o teste quer repetir de propósito. */
function newKey(prefix = "dq3"): string {
  return `${prefix}-key-${(keySeq += 1)}`;
}

function callGet(technicianId: string, token: string) {
  return getQueue(
    apiRequest(`/api/dispatch/technicians/${technicianId}/queue`, {}, token),
    { params: { technicianId } },
  );
}

function callReorder(
  technicianId: string,
  token: string,
  body: unknown,
  key = newKey("reorder"),
) {
  return reorder(
    apiRequest(
      `/api/dispatch/technicians/${technicianId}/queue/reorder`,
      { method: "POST", body, headers: { "Idempotency-Key": key } },
      token,
    ),
    { params: { technicianId } },
  );
}

function callPriority(
  orderId: string,
  token: string,
  body: unknown,
  key = newKey("prio"),
) {
  return changePriority(
    apiRequest(
      `/api/service-orders/${orderId}/priority`,
      { method: "POST", body, headers: { "Idempotency-Key": key } },
      token,
    ),
    { params: { id: orderId } },
  );
}

function callAssign(orderId: string, token: string, body: unknown) {
  return assignRoute(
    apiRequest(
      `/api/service-orders/${orderId}/assign`,
      { method: "POST", body },
      token,
    ),
    { params: { id: orderId } },
  );
}

async function assign(orderId: string, technicianId: string): Promise<void> {
  const res = await callAssign(orderId, adminToken, { technicianId });
  expect(res.status).toBe(200);
}

async function queueOf(technicianId: string) {
  const res = await callGet(technicianId, adminToken);
  expect(res.status).toBe(200);
  return (await res.json()).data.queue;
}

async function orderVersion(id: string): Promise<number> {
  const os = await prisma.serviceOrder.findUniqueOrThrow({
    where: { id },
    select: { version: true },
  });
  return os.version;
}

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

describe("GET da fila", () => {
  it("ADMIN e DISPATCHER leem; TECHNICIAN recebe 403", async () => {
    expect((await callGet(techA1.id, adminToken)).status).toBe(200);
    expect((await callGet(techA1.id, dispatcherToken)).status).toBe(200);
    expect((await callGet(techA1.id, technicianToken)).status).toBe(403);
  });

  it("sem sessão é 401", async () => {
    const res = await getQueue(
      apiRequest(`/api/dispatch/technicians/${techA1.id}/queue`),
      { params: { technicianId: techA1.id } },
    );
    expect(res.status).toBe(401);
  });

  it("técnico inexistente é 404", async () => {
    expect((await callGet("nao-existe", adminToken)).status).toBe(404);
  });

  it("fila vazia devolve queueVersion 0, sem criar linha", async () => {
    const queue = await queueOf(techA1.id);
    expect(queue.queueVersion).toBe(0);
    expect(queue.queued).toEqual([]);
    expect(queue.inProgress).toEqual([]);

    // Leitura pura: abrir a tela não pode escrever no banco.
    const filas = await prisma.technicianDispatchQueue.count();
    expect(filas).toBe(0);
  });

  it("queued vem ordenado por position, 1..N", async () => {
    const n = await makeOrder("NORMAL");
    const u = await makeOrder("URGENT");
    const l = await makeOrder("LOW");
    for (const os of [n, u, l]) await assign(os.id, techA1.id);

    const queue = await queueOf(techA1.id);
    expect(queue.queued.map((i: { position: number }) => i.position)).toEqual([
      1, 2, 3,
    ]);
    expect(queue.queued.map((i: { number: number }) => i.number)).toEqual([
      u.number,
      n.number,
      l.number,
    ]);
  });

  it("inProgress é COLEÇÃO e representa mais de uma", async () => {
    const a = await makeOrder("NORMAL");
    const b = await makeOrder("NORMAL");
    for (const os of [a, b]) await assign(os.id, techA1.id);

    const { startServiceOrder } = await import("@/lib/service-orders");
    for (const os of [a, b]) {
      await startServiceOrder(
        fixture.companyA.id,
        techA1.userId,
        os.id,
        await orderVersion(os.id),
      );
    }

    const queue = await queueOf(techA1.id);
    // O AlfaOS permite mais de uma IN_PROGRESS; a API não escolhe uma.
    expect(queue.inProgress).toHaveLength(2);
    expect(
      queue.inProgress.every((i: { position: null }) => i.position === null),
    ).toBe(true);
    expect(queue.queued).toEqual([]);
  });

  it("não devolve PII além do necessário", async () => {
    const os = await makeOrder("NORMAL");
    await assign(os.id, techA1.id);

    const queue = await queueOf(techA1.id);
    const item = queue.queued[0];
    const permitidos = [
      "serviceOrderId",
      "number",
      "status",
      "priority",
      "position",
      "type",
      "customerName",
      "district",
      "city",
      "scheduledAt",
      "version",
    ].sort();
    expect(Object.keys(item).sort()).toEqual(permitidos);
  });
});

// ---------------------------------------------------------------------------
// T-S — tenant, RBAC, auditoria
// ---------------------------------------------------------------------------

describe("T-S1 · empresa A não lê a fila de B", () => {
  it("404 com technicianId válido de B, e controle positivo", async () => {
    // Controle positivo primeiro: o caminho autorizado devolve a fila, então o
    // negativo abaixo não está passando por vazio.
    const os = await makeOrder("NORMAL");
    await assign(os.id, techA1.id);
    const propria = await queueOf(techA1.id);
    expect(propria.queued).toHaveLength(1);

    expect((await callGet(techB1.id, adminToken)).status).toBe(404);
  });
});

describe("T-S2 · empresa A não reordena a fila de B", () => {
  it("404", async () => {
    const res = await callReorder(techB1.id, adminToken, {
      serviceOrderId: "qualquer",
      targetPosition: 1,
      expectedQueueVersion: 0,
    });
    expect(res.status).toBe(404);
  });
});

describe("T-S3 · OS de B não entra na fila de A", () => {
  it("404 no reorder, e controle positivo com OS da própria empresa", async () => {
    const daA = await makeOrder("NORMAL");
    await assign(daA.id, techA1.id);
    const v = (await queueOf(techA1.id)).queueVersion;

    const ok = await callReorder(techA1.id, adminToken, {
      serviceOrderId: daA.id,
      targetPosition: 1,
      expectedQueueVersion: v,
    });
    expect(ok.status).toBe(200);

    const daB = await makeOrder("NORMAL", fixture.companyB.id);
    const res = await callReorder(techA1.id, adminToken, {
      serviceOrderId: daB.id,
      targetPosition: 1,
      expectedQueueVersion: (await queueOf(techA1.id)).queueVersion,
    });
    expect(res.status).toBe(404);
  });

  it("prioridade de OS de outra empresa é 404", async () => {
    const daB = await makeOrder("NORMAL", fixture.companyB.id);
    const res = await callPriority(daB.id, adminToken, {
      priority: "URGENT",
      expectedVersion: 0,
    });
    expect(res.status).toBe(404);
  });
});

describe("T-S4 · TECHNICIAN recebe 403", () => {
  it("em priority e em reorder", async () => {
    const os = await makeOrder("NORMAL");
    await assign(os.id, techA1.id);

    const prio = await callPriority(os.id, technicianToken, {
      priority: "URGENT",
      expectedVersion: await orderVersion(os.id),
    });
    expect(prio.status).toBe(403);

    const reord = await callReorder(techA1.id, technicianToken, {
      serviceOrderId: os.id,
      targetPosition: 1,
      expectedQueueVersion: 1,
    });
    expect(reord.status).toBe(403);
  });
});

describe("T-S5 · campo desconhecido é rejeitado", () => {
  it("400 no reorder e no priority", async () => {
    const os = await makeOrder("NORMAL");
    await assign(os.id, techA1.id);

    const reord = await callReorder(techA1.id, adminToken, {
      serviceOrderId: os.id,
      targetPosition: 1,
      expectedQueueVersion: 1,
      position: 99,
    });
    expect(reord.status).toBe(400);

    const prio = await callPriority(os.id, adminToken, {
      priority: "URGENT",
      expectedVersion: await orderVersion(os.id),
      status: "COMPLETED",
    });
    expect(prio.status).toBe(400);
  });

  it("assign também rejeita campo desconhecido", async () => {
    const os = await makeOrder("NORMAL");
    const res = await callAssign(os.id, adminToken, {
      technicianId: techA1.id,
      origin: "EXTERNAL",
    });
    expect(res.status).toBe(400);
  });
});

describe("T-S6 · companyId no corpo nunca é honrado", () => {
  it("é rejeitado pelo schema estrito, não ignorado em silêncio", async () => {
    const os = await makeOrder("NORMAL");
    await assign(os.id, techA1.id);

    for (const [nome, res] of [
      [
        "reorder",
        await callReorder(techA1.id, adminToken, {
          serviceOrderId: os.id,
          targetPosition: 1,
          expectedQueueVersion: 1,
          companyId: fixture.companyB.id,
        }),
      ],
      [
        "priority",
        await callPriority(os.id, adminToken, {
          priority: "URGENT",
          expectedVersion: await orderVersion(os.id),
          companyId: fixture.companyB.id,
        }),
      ],
    ] as const) {
      expect(res.status, nome).toBe(400);
    }

    // E nada vazou para a outra empresa.
    const filasB = await prisma.technicianDispatchQueue.count({
      where: { companyId: fixture.companyB.id },
    });
    expect(filasB).toBe(0);
  });
});

describe("T-S7 · reorder escreve UM evento de timeline", () => {
  it("cinco OS deslocadas, um evento só", async () => {
    /*
      A renumeração colateral não é fato operacional. Um evento por OS
      deslocada inundaria a timeline de quem ninguém tocou — e a timeline da OS
      é lida por técnico e por atendimento, não por auditor (PRD §322).
    */
    const ordens = [];
    for (let i = 0; i < 5; i += 1) ordens.push(await makeOrder("NORMAL"));
    for (const os of ordens) await assign(os.id, techA1.id);

    const antes = await prisma.serviceOrderEvent.count({
      where: { companyId: fixture.companyA.id, event: "PRIORITY_CHANGED" },
    });

    const ultima = ordens[4];
    const res = await callPriority(ultima.id, adminToken, {
      priority: "URGENT",
      expectedVersion: await orderVersion(ultima.id),
      expectedQueueVersion: (await queueOf(techA1.id)).queueVersion,
    });
    expect(res.status).toBe(200);

    const depois = await prisma.serviceOrderEvent.count({
      where: { companyId: fixture.companyA.id, event: "PRIORITY_CHANGED" },
    });
    expect(depois - antes).toBe(1);

    // E o evento está na OS que o humano nomeou, não nas deslocadas.
    const naOutra = await prisma.serviceOrderEvent.count({
      where: { serviceOrderId: ordens[0].id, event: "PRIORITY_CHANGED" },
    });
    expect(naOutra).toBe(0);
  });
});

describe("T-S8 · AuditLog registra actor, before e after", () => {
  it("com o antes e o depois legíveis", async () => {
    const os = await makeOrder("NORMAL");
    await assign(os.id, techA1.id);

    await callPriority(os.id, adminToken, {
      priority: "URGENT",
      expectedVersion: await orderVersion(os.id),
      expectedQueueVersion: (await queueOf(techA1.id)).queueVersion,
    });

    const log = await prisma.auditLog.findFirst({
      where: {
        companyId: fixture.companyA.id,
        action: "SERVICE_ORDER.PRIORITY_CHANGED",
        entityId: os.id,
      },
    });
    expect(log).not.toBeNull();
    expect(log?.userId).toBe(fixture.adminA.id);
    expect(log?.details).toContain("Normal");
    expect(log?.details).toContain("Urgente");
  });

  it("no-op de mesma prioridade NÃO gera auditoria nem evento", async () => {
    const os = await makeOrder("NORMAL");
    await assign(os.id, techA1.id);

    const res = await callPriority(os.id, adminToken, {
      priority: "NORMAL",
      expectedVersion: await orderVersion(os.id),
      expectedQueueVersion: (await queueOf(techA1.id)).queueVersion,
    });
    expect(res.status).toBe(200);
    expect((await res.json()).data.changed).toBe(false);

    expect(
      await prisma.auditLog.count({
        where: { action: "SERVICE_ORDER.PRIORITY_CHANGED" },
      }),
    ).toBe(0);
    expect(
      await prisma.serviceOrderEvent.count({ where: { event: "PRIORITY_CHANGED" } }),
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Prioridade
// ---------------------------------------------------------------------------

describe("mutação de prioridade", () => {
  it("aceita os QUATRO valores do domínio, não só dois", async () => {
    const os = await makeOrder("NORMAL");
    await assign(os.id, techA1.id);

    for (const alvo of ["URGENT", "NORMAL", "HIGH", "LOW"] as const) {
      const res = await callPriority(os.id, adminToken, {
        priority: alvo,
        expectedVersion: await orderVersion(os.id),
        expectedQueueVersion: (await queueOf(techA1.id)).queueVersion,
      });
      expect(res.status, alvo).toBe(200);
      const atual = await prisma.serviceOrder.findUniqueOrThrow({
        where: { id: os.id },
        select: { priority: true },
      });
      expect(atual.priority).toBe(alvo);
    }
  });

  it("NORMAL → URGENT vai para o FIM das urgentes, não para a posição 1", async () => {
    const u1 = await makeOrder("URGENT");
    const u2 = await makeOrder("URGENT");
    const n1 = await makeOrder("NORMAL");
    for (const os of [u1, u2, n1]) await assign(os.id, techA1.id);

    const res = await callPriority(n1.id, adminToken, {
      priority: "URGENT",
      expectedVersion: await orderVersion(n1.id),
      expectedQueueVersion: (await queueOf(techA1.id)).queueVersion,
    });
    expect(res.status).toBe(200);

    const queue = (await res.json()).data.queue;
    expect(queue.queued.map((i: { number: number }) => i.number)).toEqual([
      u1.number,
      u2.number,
      n1.number,
    ]);
  });

  it("com targetPosition, aplica a posição pedida na mesma operação", async () => {
    const u1 = await makeOrder("URGENT");
    const n1 = await makeOrder("NORMAL");
    for (const os of [u1, n1]) await assign(os.id, techA1.id);

    const res = await callPriority(n1.id, adminToken, {
      priority: "URGENT",
      expectedVersion: await orderVersion(n1.id),
      expectedQueueVersion: (await queueOf(techA1.id)).queueVersion,
      targetPosition: 1,
    });
    expect(res.status).toBe(200);
    expect(
      (await res.json()).data.queue.queued.map((i: { number: number }) => i.number),
    ).toEqual([n1.number, u1.number]);
  });

  it("OS sem técnico muda de prioridade sem expectedQueueVersion", async () => {
    // Não há fila a comparar, e exigir o token bloquearia um caso legítimo.
    const os = await makeOrder("NORMAL");
    const res = await callPriority(os.id, adminToken, {
      priority: "URGENT",
      expectedVersion: await orderVersion(os.id),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).data.queue).toBeNull();
  });

  it("OS EM FILA sem expectedQueueVersion é recusada com 400", async () => {
    const os = await makeOrder("NORMAL");
    await assign(os.id, techA1.id);
    const res = await callPriority(os.id, adminToken, {
      priority: "URGENT",
      expectedVersion: await orderVersion(os.id),
    });
    expect(res.status).toBe(400);
  });

  it("expectedVersion da OS obsoleta é 409", async () => {
    const os = await makeOrder("NORMAL");
    await assign(os.id, techA1.id);
    const res = await callPriority(os.id, adminToken, {
      priority: "URGENT",
      expectedVersion: 0,
      expectedQueueVersion: (await queueOf(techA1.id)).queueVersion,
    });
    expect(res.status).toBe(409);
  });

  it("expectedQueueVersion obsoleta é 409, e a prioridade NÃO é gravada", async () => {
    const os = await makeOrder("NORMAL");
    await assign(os.id, techA1.id);
    const res = await callPriority(os.id, adminToken, {
      priority: "URGENT",
      expectedVersion: await orderVersion(os.id),
      expectedQueueVersion: 99,
    });
    expect(res.status).toBe(409);

    // Os dois agregados voltam juntos: a transação inteira desfez.
    const atual = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: os.id },
      select: { priority: true },
    });
    expect(atual.priority).toBe("NORMAL");
  });
});

// ---------------------------------------------------------------------------
// Reorder
// ---------------------------------------------------------------------------

describe("reorder", () => {
  async function filaDeQuatro() {
    const a = await makeOrder("NORMAL");
    const b = await makeOrder("NORMAL");
    const c = await makeOrder("NORMAL");
    const d = await makeOrder("NORMAL");
    for (const os of [a, b, c, d]) await assign(os.id, techA1.id);
    return { a, b, c, d };
  }

  it("move 4 → 1", async () => {
    const { a, b, c, d } = await filaDeQuatro();
    const res = await callReorder(techA1.id, adminToken, {
      serviceOrderId: d.id,
      targetPosition: 1,
      expectedQueueVersion: (await queueOf(techA1.id)).queueVersion,
    });
    expect(res.status).toBe(200);
    expect(
      (await res.json()).data.queue.queued.map((i: { number: number }) => i.number),
    ).toEqual([d.number, a.number, b.number, c.number]);
  });

  it("move 1 → 4", async () => {
    const { a, b, c, d } = await filaDeQuatro();
    const res = await callReorder(techA1.id, adminToken, {
      serviceOrderId: a.id,
      targetPosition: 4,
      expectedQueueVersion: (await queueOf(techA1.id)).queueVersion,
    });
    expect(res.status).toBe(200);
    expect(
      (await res.json()).data.queue.queued.map((i: { number: number }) => i.number),
    ).toEqual([b.number, c.number, d.number, a.number]);
  });

  it("mover para a mesma posição é 200 e não muda nada", async () => {
    const { a } = await filaDeQuatro();
    const antes = await queueOf(techA1.id);
    const res = await callReorder(techA1.id, adminToken, {
      serviceOrderId: a.id,
      targetPosition: 1,
      expectedQueueVersion: antes.queueVersion,
    });
    expect(res.status).toBe(200);
    const depois = (await res.json()).data.queue;
    expect(depois.queueVersion).toBe(antes.queueVersion);
  });

  it("targetPosition 0 é 400 (fora do contrato), acima de N é acomodado", async () => {
    const { a } = await filaDeQuatro();
    const v = (await queueOf(techA1.id)).queueVersion;

    const zero = await callReorder(techA1.id, adminToken, {
      serviceOrderId: a.id,
      targetPosition: 0,
      expectedQueueVersion: v,
    });
    expect(zero.status).toBe(400);

    const alto = await callReorder(techA1.id, adminToken, {
      serviceOrderId: a.id,
      targetPosition: 99,
      expectedQueueVersion: v,
    });
    expect(alto.status).toBe(200);
    const queue = (await alto.json()).data.queue;
    expect(queue.queued[3].number).toBe(a.number);
  });

  it("acomoda a banda: NORMAL pedindo 1 fica atrás das urgentes", async () => {
    const u = await makeOrder("URGENT");
    const n1 = await makeOrder("NORMAL");
    const n2 = await makeOrder("NORMAL");
    for (const os of [u, n1, n2]) await assign(os.id, techA1.id);

    const res = await callReorder(techA1.id, adminToken, {
      serviceOrderId: n2.id,
      targetPosition: 1,
      expectedQueueVersion: (await queueOf(techA1.id)).queueVersion,
    });
    expect(res.status).toBe(200);

    const queue = (await res.json()).data.queue;
    expect(queue.queued.map((i: { number: number }) => i.number)).toEqual([
      u.number,
      n2.number,
      n1.number,
    ]);
    // A resposta traz a posição EFETIVA, não a pedida.
    const movida = queue.queued.find(
      (i: { number: number }) => i.number === n2.number,
    );
    expect(movida.position).toBe(2);
  });

  it("expectedQueueVersion obsoleta é 409", async () => {
    const { a } = await filaDeQuatro();
    const res = await callReorder(techA1.id, adminToken, {
      serviceOrderId: a.id,
      targetPosition: 4,
      expectedQueueVersion: 0,
    });
    expect(res.status).toBe(409);
  });

  it("OS que não é da fila deste técnico é 404", async () => {
    const { a } = await filaDeQuatro();
    const res = await callReorder(techA2.id, adminToken, {
      serviceOrderId: a.id,
      targetPosition: 1,
      expectedQueueVersion: 0,
    });
    expect(res.status).toBe(404);
  });

  it("sem Idempotency-Key é 400", async () => {
    const { a } = await filaDeQuatro();
    const res = await reorder(
      apiRequest(
        `/api/dispatch/technicians/${techA1.id}/queue/reorder`,
        {
          method: "POST",
          body: {
            serviceOrderId: a.id,
            targetPosition: 1,
            expectedQueueVersion: 1,
          },
        },
        adminToken,
      ),
      { params: { technicianId: techA1.id } },
    );
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// T-C6 e concorrência de API
// ---------------------------------------------------------------------------

describe("T-C6 · mesma Idempotency-Key duas vezes", () => {
  it("um efeito, um evento, uma linha de auditoria", async () => {
    const u1 = await makeOrder("URGENT");
    const n1 = await makeOrder("NORMAL");
    for (const os of [u1, n1]) await assign(os.id, techA1.id);

    const key = "tc6-mesma-chave";
    const body = {
      priority: "URGENT" as const,
      expectedVersion: await orderVersion(n1.id),
      expectedQueueVersion: (await queueOf(techA1.id)).queueVersion,
    };

    const primeira = await callPriority(n1.id, adminToken, body, key);
    expect(primeira.status).toBe(200);
    const filaApos1 = (await primeira.json()).data.queue;

    // O retry chega com a MESMA versão da primeira tentativa, que já está
    // obsoleta — e é justamente isso que a idempotência precisa absorver: o
    // CAS não pode derrubar um retry legítimo antes de a camada reconhecê-lo.
    const segunda = await callPriority(n1.id, adminToken, body, key);
    expect(segunda.status).toBe(200);
    const filaApos2 = (await segunda.json()).data.queue;

    expect(filaApos2).toEqual(filaApos1);
    expect(
      await prisma.serviceOrderEvent.count({ where: { event: "PRIORITY_CHANGED" } }),
    ).toBe(1);
    expect(
      await prisma.auditLog.count({
        where: { action: "SERVICE_ORDER.PRIORITY_CHANGED" },
      }),
    ).toBe(1);
  });

  it("reorder repetido com a mesma chave não move duas vezes", async () => {
    const a = await makeOrder("NORMAL");
    const b = await makeOrder("NORMAL");
    const c = await makeOrder("NORMAL");
    for (const os of [a, b, c]) await assign(os.id, techA1.id);

    const key = "tc6-reorder";
    const body = {
      serviceOrderId: c.id,
      targetPosition: 1,
      expectedQueueVersion: (await queueOf(techA1.id)).queueVersion,
    };

    const um = await callReorder(techA1.id, adminToken, body, key);
    const dois = await callReorder(techA1.id, adminToken, body, key);
    expect(um.status).toBe(200);
    expect(dois.status).toBe(200);

    const fila = await queueOf(techA1.id);
    expect(fila.queued.map((i: { number: number }) => i.number)).toEqual([
      c.number,
      a.number,
      b.number,
    ]);
  });

  it("mesma chave com conteúdo DIFERENTE é conflito, não aceite silencioso", async () => {
    const a = await makeOrder("NORMAL");
    const b = await makeOrder("NORMAL");
    for (const os of [a, b]) await assign(os.id, techA1.id);

    const key = "tc6-chave-reciclada";
    const v = (await queueOf(techA1.id)).queueVersion;

    const um = await callReorder(
      techA1.id,
      adminToken,
      { serviceOrderId: b.id, targetPosition: 1, expectedQueueVersion: v },
      key,
    );
    expect(um.status).toBe(200);

    const outro = await callReorder(
      techA1.id,
      adminToken,
      { serviceOrderId: a.id, targetPosition: 1, expectedQueueVersion: v + 1 },
      key,
    );
    expect(outro.status).toBe(409);
  });
});

describe("concorrência pela API", () => {
  it("dois despachantes reordenando com a MESMA versão: um 200, um 409", async () => {
    const a = await makeOrder("NORMAL");
    const b = await makeOrder("NORMAL");
    const c = await makeOrder("URGENT");
    const d = await makeOrder("NORMAL");
    for (const os of [a, b, c, d]) await assign(os.id, techA1.id);

    const v = (await queueOf(techA1.id)).queueVersion;

    /*
      As DUAS movimentações precisam mudar a fila de verdade.

      Uma que caísse na posição em que a OS já está seria no-op — não
      incrementaria `version`, e o segundo pedido passaria no CAS legitimamente,
      porque nada mudou desde a leitura dele. A corrida estaria montada errada e
      o teste falharia acusando o código.

      Fila inicial: c(1,URGENT) · a(2) · b(3) · d(4).
    */
    const results = await Promise.allSettled([
      callReorder(
        techA1.id,
        adminToken,
        { serviceOrderId: d.id, targetPosition: 2, expectedQueueVersion: v },
        "corrida-a",
      ),
      callReorder(
        techA1.id,
        dispatcherToken,
        { serviceOrderId: a.id, targetPosition: 4, expectedQueueVersion: v },
        "corrida-b",
      ),
    ]);

    const status = await Promise.all(
      results.map(async (r) =>
        r.status === "fulfilled" ? r.value.status : 500,
      ),
    );
    expect(status.filter((s) => s === 200)).toHaveLength(1);
    expect(status.filter((s) => s === 409)).toHaveLength(1);

    // Nunca dois 200 com fila inválida.
    const fila = await queueOf(techA1.id);
    expect(fila.queued.map((i: { position: number }) => i.position)).toEqual([
      1, 2, 3, 4,
    ]);
    const urgentes = fila.queued.filter(
      (i: { priority: string }) => i.priority === "URGENT",
    );
    expect(urgentes[0].position).toBe(1);
  });

  it("reorder que NÃO muda nada não consome a versão da fila", async () => {
    /*
      Propriedade descoberta ao montar a corrida acima, e que vale registrar.

      Um pedido acomodado para a posição em que a OS já está é no-op: não
      escreve e não incrementa `version`. A consequência é correta e não óbvia
      — um segundo despachante com a MESMA versão continua podendo agir, porque
      de fato nada mudou desde a leitura dele. Invalidar o CAS de todo mundo por
      causa de um clique que não mexeu na fila seria ruído.
    */
    const u = await makeOrder("URGENT");
    const n = await makeOrder("NORMAL");
    for (const os of [u, n]) await assign(os.id, techA1.id);

    const v = (await queueOf(techA1.id)).queueVersion;

    // `n` é NORMAL e já está na posição 2; pedir 1 é acomodado para 2.
    const noop = await callReorder(techA1.id, adminToken, {
      serviceOrderId: n.id,
      targetPosition: 1,
      expectedQueueVersion: v,
    });
    expect(noop.status).toBe(200);
    expect((await noop.json()).data.queue.queueVersion).toBe(v);

    // E a mesma versão continua válida para o pedido seguinte.
    const depois = await callReorder(techA1.id, adminToken, {
      serviceOrderId: u.id,
      targetPosition: 2,
      expectedQueueVersion: v,
    });
    expect(depois.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Assign
// ---------------------------------------------------------------------------

describe("assign — evolução sem quebra", () => {
  it("a resposta continua sendo { serviceOrder }", async () => {
    const os = await makeOrder("NORMAL");
    const res = await callAssign(os.id, adminToken, { technicianId: techA1.id });
    expect(res.status).toBe(200);
    const data = (await res.json()).data;
    expect(Object.keys(data)).toEqual(["serviceOrder"]);
    expect(data.serviceOrder.id).toBe(os.id);
  });

  it("nova atribuição entra na fila certa", async () => {
    const os = await makeOrder("URGENT");
    await assign(os.id, techA1.id);
    const fila = await queueOf(techA1.id);
    expect(fila.queued).toHaveLength(1);
    expect(fila.queued[0].number).toBe(os.number);
  });

  it("reatribuição move entre as filas", async () => {
    const os = await makeOrder("NORMAL");
    await assign(os.id, techA1.id);
    await assign(os.id, techA2.id);

    expect((await queueOf(techA1.id)).queued).toHaveLength(0);
    expect((await queueOf(techA2.id)).queued).toHaveLength(1);
  });

  it("targetPosition opcional posiciona na mesma requisição", async () => {
    const a = await makeOrder("NORMAL");
    const b = await makeOrder("NORMAL");
    await assign(a.id, techA1.id);

    const res = await callAssign(b.id, adminToken, {
      technicianId: techA1.id,
      targetPosition: 1,
    });
    expect(res.status).toBe(200);

    const fila = await queueOf(techA1.id);
    expect(fila.queued.map((i: { number: number }) => i.number)).toEqual([
      b.number,
      a.number,
    ]);
  });

  it("técnico de outra empresa é 404", async () => {
    const os = await makeOrder("NORMAL");
    const res = await callAssign(os.id, adminToken, { technicianId: techB1.id });
    expect(res.status).toBe(404);
  });
});
