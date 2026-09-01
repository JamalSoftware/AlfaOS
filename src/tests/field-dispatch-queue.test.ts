import { describe, it, expect, beforeEach } from "vitest";
import type { ServiceOrderPriority } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { GET as fieldQueue } from "@/app/api/field/v1/dispatch-queue/route";
import { POST as reorder } from "@/app/api/dispatch/technicians/[technicianId]/queue/reorder/route";
import { POST as changePriority } from "@/app/api/service-orders/[id]/priority/route";
import { assignTechnician, startServiceOrder } from "@/lib/service-orders";
import {
  apiRequest,
  createTokenFor,
  fieldRequest,
  registerTestDevice,
  seedTestData,
  type TestFixture,
} from "./helpers";

/**
 * # Fila operacional — contrato de leitura do Field (DQ-5)
 *
 * O que esta fase entrega é **superfície externa**, e é ela que o Flutter vai
 * consumir em DQ-6. Testar só o serviço deixaria autenticação, derivação do
 * técnico, cabeçalho de cache e o formato do DTO sem cobertura.
 *
 * O teste que importa mais é o de INTEGRAÇÃO (`FQ-4`): reordenar pela Web e
 * ler pelo Field. É exatamente o que o piloto observou — o despachante move a
 * OS e o aplicativo continua na ordem antiga —, e é a única prova de que as
 * duas superfícies leem a MESMA fila.
 */

let fixture: TestFixture;
let adminToken: string;
let fieldToken: string;
let techA1: { id: string; userId: string };
let techA2: { id: string };

beforeEach(async () => {
  fixture = await seedTestData();
  adminToken = await createTokenFor(fixture.adminA.id);
  techA1 = await prisma.technician.create({
    data: { companyId: fixture.companyA.id, userId: fixture.techA.id },
    select: { id: true, userId: true },
  });
  techA2 = await prisma.technician.create({
    data: { companyId: fixture.companyA.id, userId: fixture.techB.id },
    select: { id: true },
  });
  fieldToken = (await registerTestDevice(fixture.techA.id)).token;
});

let seq = 0;

async function makeOrder(
  priority: ServiceOrderPriority,
  options: { companyId?: string; scheduledAt?: Date | null } = {},
): Promise<{ id: string; number: number }> {
  const companyId = options.companyId ?? fixture.companyA.id;
  const customer = await prisma.customer.create({
    data: {
      companyId,
      name: `Cliente ${(seq += 1)}`,
      document: "111.222.333-44",
      phone: "28999990000",
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
      scheduledAt: options.scheduledAt ?? null,
    },
    select: { id: true, number: true },
  });
}

async function assign(orderId: string, technicianId: string): Promise<void> {
  await assignTechnician(
    fixture.companyA.id,
    fixture.adminA.id,
    orderId,
    technicianId,
  );
}

/** A fila como o APLICATIVO a recebe. */
async function fieldRead(token = fieldToken) {
  const res = await fieldQueue(
    fieldRequest("/api/field/v1/dispatch-queue", { token }),
  );
  return { res, body: await res.json() };
}

async function queuedNumbers(): Promise<number[]> {
  const { body } = await fieldRead();
  return body.data.queued.map((i: { number: number }) => i.number);
}

/** Reordena pela rota ADMINISTRATIVA — o caminho que o despachante usa. */
async function webReorder(
  technicianId: string,
  serviceOrderId: string,
  targetPosition: number,
): Promise<number> {
  const atual = await prisma.technicianDispatchQueue.findFirstOrThrow({
    where: { companyId: fixture.companyA.id, technicianId },
    select: { version: true },
  });
  const res = await reorder(
    apiRequest(
      `/api/dispatch/technicians/${technicianId}/queue/reorder`,
      {
        method: "POST",
        body: {
          serviceOrderId,
          targetPosition,
          expectedQueueVersion: atual.version,
        },
        headers: { "Idempotency-Key": `web-${(seq += 1)}-${Date.now()}` },
      },
      adminToken,
    ),
    { params: { technicianId } },
  );
  return res.status;
}

// ---------------------------------------------------------------------------

describe("FQ-1, FQ-2, FQ-3 · o técnico lê a PRÓPRIA fila, ordenada", () => {
  it("queued vem 1..N na ordem do backend", async () => {
    const n1 = await makeOrder("NORMAL");
    const u1 = await makeOrder("URGENT");
    const l1 = await makeOrder("LOW");
    for (const os of [n1, u1, l1]) await assign(os.id, techA1.id);

    const { res, body } = await fieldRead();
    expect(res.status).toBe(200);

    expect(body.data.queued.map((i: { position: number }) => i.position)).toEqual(
      [1, 2, 3],
    );
    expect(body.data.queued.map((i: { number: number }) => i.number)).toEqual([
      u1.number,
      n1.number,
      l1.number,
    ]);
    expect(body.data.queueVersion).toBeGreaterThan(0);
  });

  it("a fila de OUTRO técnico não vaza para esta leitura", async () => {
    const minha = await makeOrder("NORMAL");
    const doOutro = await makeOrder("URGENT");
    await assign(minha.id, techA1.id);
    await assign(doOutro.id, techA2.id);

    // Controle positivo + negativo na mesma asserção: a própria aparece, a do
    // colega não — e o endpoint não tem parâmetro que permita pedir a dele.
    expect(await queuedNumbers()).toEqual([minha.number]);
  });

  it("`?technicianId=` é ignorado, não honrado", async () => {
    const minha = await makeOrder("NORMAL");
    await assign(minha.id, techA1.id);
    const doOutro = await makeOrder("URGENT");
    await assign(doOutro.id, techA2.id);

    const res = await fieldQueue(
      fieldRequest(
        `/api/field/v1/dispatch-queue?technicianId=${techA2.id}&companyId=${fixture.companyB.id}`,
        { token: fieldToken },
      ),
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    // O dono vem do TOKEN. O parâmetro não é lido — e a prova é que a resposta
    // continua sendo a fila de quem está com o aparelho.
    expect(body.data.queued.map((i: { number: number }) => i.number)).toEqual([
      minha.number,
    ]);
  });
});

describe("FQ-4 · reorder na Web muda o GET do Field", () => {
  it("o caminho inteiro: despachante reordena, aplicativo relê", async () => {
    /*
      O teste que o piloto pediu.

      Não é o serviço chamado direto: é a rota administrativa que o painel usa,
      commit, e depois a rota do Field. Se as duas superfícies lessem filas
      diferentes — ou se o Field reordenasse por conta —, é aqui que apareceria.
    */
    const a = await makeOrder("NORMAL");
    const b = await makeOrder("NORMAL");
    const c = await makeOrder("NORMAL");
    for (const os of [a, b, c]) await assign(os.id, techA1.id);
    expect(await queuedNumbers()).toEqual([a.number, b.number, c.number]);

    expect(await webReorder(techA1.id, c.id, 1)).toBe(200);
    expect(await queuedNumbers()).toEqual([c.number, a.number, b.number]);

    // E de volta: a ordem acompanha em qualquer sentido, não só numa direção.
    expect(await webReorder(techA1.id, a.id, 1)).toBe(200);
    expect(await queuedNumbers()).toEqual([a.number, c.number, b.number]);
  });

  it("o Field NÃO reordena por conta própria", async () => {
    /*
      A fila persistida é a autoridade. Se o Field aplicasse `DISPATCH_BAND`
      de novo na leitura, uma NORMAL que o despachante pôs na frente de outra
      NORMAL voltaria para a ordem "natural" — e a decisão dele sumiria.
    */
    const a = await makeOrder("NORMAL");
    const b = await makeOrder("NORMAL");
    for (const os of [a, b]) await assign(os.id, techA1.id);

    await webReorder(techA1.id, b.id, 1);

    // `b` tem número MAIOR e prioridade IGUAL: só a posição persistida explica
    // ela vir primeiro.
    expect(await queuedNumbers()).toEqual([b.number, a.number]);
  });
});

describe("FQ-5 · mudança de prioridade aparece no Field", () => {
  it("NORMAL → URGENT reposiciona, e o enum chega inteiro", async () => {
    const u1 = await makeOrder("URGENT");
    const n1 = await makeOrder("NORMAL");
    const n2 = await makeOrder("NORMAL");
    for (const os of [u1, n1, n2]) await assign(os.id, techA1.id);

    const os = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: n2.id },
      select: { version: true },
    });
    const fila = await prisma.technicianDispatchQueue.findFirstOrThrow({
      where: { companyId: fixture.companyA.id, technicianId: techA1.id },
      select: { version: true },
    });
    const res = await changePriority(
      apiRequest(
        `/api/service-orders/${n2.id}/priority`,
        {
          method: "POST",
          body: {
            priority: "URGENT",
            expectedVersion: os.version,
            expectedQueueVersion: fila.version,
          },
          headers: { "Idempotency-Key": `prio-${Date.now()}` },
        },
        adminToken,
      ),
      { params: { id: n2.id } },
    );
    expect(res.status).toBe(200);

    expect(await queuedNumbers()).toEqual([u1.number, n2.number, n1.number]);
  });

  it("os QUATRO valores chegam sem colapso", async () => {
    // O Field mapeia visualmente; o contrato não decide por ele.
    const ordens = [];
    for (const p of ["LOW", "NORMAL", "HIGH", "URGENT"] as const) {
      const os = await makeOrder(p);
      await assign(os.id, techA1.id);
      ordens.push(os);
    }
    const { body } = await fieldRead();
    expect(body.data.queued.map((i: { priority: string }) => i.priority)).toEqual(
      ["URGENT", "HIGH", "NORMAL", "LOW"],
    );
  });
});

describe("FQ-6 · IN_PROGRESS é coleção, e fica fora da fila", () => {
  it("duas em atendimento, ambas com position nulo", async () => {
    const a = await makeOrder("NORMAL");
    const b = await makeOrder("NORMAL");
    const c = await makeOrder("NORMAL");
    for (const os of [a, b, c]) await assign(os.id, techA1.id);

    for (const os of [a, b]) {
      const fresh = await prisma.serviceOrder.findUniqueOrThrow({
        where: { id: os.id },
        select: { version: true },
      });
      await startServiceOrder(
        fixture.companyA.id,
        techA1.userId,
        os.id,
        fresh.version,
      );
    }

    const { body } = await fieldRead();
    expect(body.data.inProgress).toHaveLength(2);
    expect(
      body.data.inProgress.every((i: { position: null }) => i.position === null),
    ).toBe(true);
    expect(body.data.queued.map((i: { number: number }) => i.number)).toEqual([
      c.number,
    ]);
  });
});

describe("FQ-7 · fila vazia", () => {
  it("técnico sem fila recebe estado vazio coerente, e nada é criado", async () => {
    const { res, body } = await fieldRead();
    expect(res.status).toBe(200);
    expect(body.data).toEqual({ queueVersion: 0, inProgress: [], queued: [] });

    // Leitura pura: um GET não cria fila.
    expect(await prisma.technicianDispatchQueue.count()).toBe(0);
  });

  it("sem fila NÃO devolve ranking calculado no servidor", async () => {
    /*
      Sem fallback aqui, de propósito.

      Uma OS atribuída direto no banco — estado anterior à capability — não tem
      entrada de fila. Devolvê-la em `queued` faria o aplicativo achar que está
      obedecendo ao despacho quando o despacho não disse nada. O fallback é
      decisão do CLIENTE em DQ-6, pela ausência de `position`.
    */
    const orfa = await makeOrder("URGENT");
    await prisma.serviceOrder.update({
      where: { id: orfa.id },
      data: { technicianId: techA1.id, status: "ASSIGNED" },
    });

    const { body } = await fieldRead();
    expect(body.data.queued).toEqual([]);
  });
});

describe("FQ-8, FQ-9 · autenticação e tenant", () => {
  it("sem token é 401", async () => {
    const res = await fieldQueue(fieldRequest("/api/field/v1/dispatch-queue"));
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("UNAUTHENTICATED");
  });

  it("token inválido é 401", async () => {
    const res = await fieldQueue(
      fieldRequest("/api/field/v1/dispatch-queue", { token: "inventado" }),
    );
    expect(res.status).toBe(401);
  });

  it("aparelho REVOGADO não lê a fila", async () => {
    const os = await makeOrder("NORMAL");
    await assign(os.id, techA1.id);
    // Controle positivo: antes de revogar, a leitura funciona.
    expect(await queuedNumbers()).toEqual([os.number]);

    await prisma.mobileDevice.updateMany({
      where: { userId: fixture.techA.id },
      data: { status: "REVOKED", revokedAt: new Date() },
    });

    const { res } = await fieldRead();
    expect(res.status).toBe(401);
  });

  it("OS de outra empresa nunca entra na fila lida pelo Field", async () => {
    const minha = await makeOrder("NORMAL");
    await assign(minha.id, techA1.id);

    // Ataque: a entrada é forjada direto no banco com a OS da empresa B, e o
    // predicado da leitura precisa recusá-la pelo `companyId`.
    const daB = await makeOrder("URGENT", { companyId: fixture.companyB.id });
    const fila = await prisma.technicianDispatchQueue.findFirstOrThrow({
      where: { technicianId: techA1.id },
      select: { id: true },
    });
    await prisma.technicianDispatchQueueEntry.create({
      data: {
        companyId: fixture.companyB.id,
        queueId: fila.id,
        serviceOrderId: daB.id,
        position: 99,
      },
    });

    expect(await queuedNumbers()).toEqual([minha.number]);
  });
});

describe("FQ-10 · o DTO não carrega o que não deve", () => {
  it("lista de campos fechada, sem PII nova e sem campo de provider", async () => {
    const os = await makeOrder("NORMAL", {
      scheduledAt: new Date("2026-09-01T13:00:00.000Z"),
    });
    await assign(os.id, techA1.id);

    const { body } = await fieldRead();
    const item = body.data.queued[0];

    expect(Object.keys(item).sort()).toEqual(
      [
        "city",
        "customerName",
        "district",
        "hasLocation",
        "id",
        "number",
        "position",
        "priority",
        "scheduledAt",
        "status",
        "subtype",
        "type",
        "updatedAt",
        "version",
      ].sort(),
    );

    /*
      A ausência é a garantia (PRD §257).

      Sem `origin`, `externalProvider`, `externalId` nem `externalNumber` não
      existe `if (RECEITANET)` possível no aplicativo — uma OS importada é
      indistinguível de uma interna, inclusive na fila.
    */
    const serializado = JSON.stringify(body.data);
    for (const proibido of [
      "origin",
      "externalProvider",
      "externalId",
      "externalNumber",
      "document",
      "phone",
      "latitude",
      "longitude",
      "credentialCiphertext",
      "pppoe",
    ]) {
      expect(serializado).not.toContain(proibido);
    }
  });

  it("scheduledAt viaja, e é outra coisa que a posição", async () => {
    const agendada = await makeOrder("NORMAL", {
      scheduledAt: new Date("2026-09-01T13:00:00.000Z"),
    });
    const semHora = await makeOrder("URGENT");
    for (const os of [agendada, semHora]) await assign(os.id, techA1.id);

    const { body } = await fieldRead();
    // A 1ª da fila NÃO tem agendamento; a 2ª tem. As duas frases são
    // independentes (PRD §324), e o contrato não as funde num campo só.
    expect(body.data.queued[0].number).toBe(semHora.number);
    expect(body.data.queued[0].scheduledAt).toBeNull();
    expect(body.data.queued[1].scheduledAt).toBe("2026-09-01T13:00:00.000Z");
  });

  it("não existe rota de escrita da fila no Field", async () => {
    // O técnico recebe a ordem; não a negocia. Uma segunda porta faria ele e o
    // despachante disputarem a mesma fila.
    const rota = (await import("@/app/api/field/v1/dispatch-queue/route")) as Record<
      string,
      unknown
    >;
    expect(Object.keys(rota).sort()).toEqual(["GET", "dynamic"]);
  });
});

describe("FQ-11 · cache", () => {
  it("a resposta é no-store", async () => {
    /*
      Uma lista de OS servida do cache mostra dado velho e a pessoa percebe.
      Uma FILA servida do cache faz o técnico trabalhar na ORDEM ERRADA, sem
      nenhum sinal de que está desatualizada.
    */
    const { res } = await fieldRead();
    expect(res.headers.get("Cache-Control")).toContain("no-store");
  });
});
