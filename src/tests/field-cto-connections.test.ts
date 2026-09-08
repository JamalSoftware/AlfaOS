import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET as networkRoute } from "@/app/api/field/v1/service-orders/[id]/network/route";
import { POST as connectRoute } from "@/app/api/field/v1/service-orders/[id]/network/connect/route";
import { POST as disconnectRoute } from "@/app/api/field/v1/service-orders/[id]/network/disconnect/route";
import { POST as moveRoute } from "@/app/api/field/v1/service-orders/[id]/network/move/route";
import { GET as ctosRoute } from "@/app/api/field/v1/service-orders/[id]/network/ctos/route";
import { GET as ctoDetailRoute } from "@/app/api/field/v1/service-orders/[id]/network/ctos/[ctoId]/route";
import {
  createCto,
  setCtoActive,
  setPortAdministrativeState,
} from "@/lib/cto";
import {
  connectCustomerToPort,
  type ConnectionContext,
} from "@/lib/cto-connections";
import { prisma } from "@/lib/prisma";
import { startServiceOrder } from "@/lib/service-orders";
import {
  allocateTestServiceOrderNumber,
  createTokenFor,
  fieldRequest,
  registerTestDevice,
  seedTestData,
  type TestFixture,
} from "./helpers";

/**
 * # `CTO-2.4` — a rede de distribuição pela API do Field
 *
 * O que esta fase acrescenta ao domínio da `CTO-2.1` não é regra de rede: é
 * **quem pode mexer nela pelo aparelho**. Por isso a maior parte deste arquivo
 * ataca autorização, derivação e obsolescência, e não ocupação de porta — essa
 * já tem dono e já tem suíte.
 *
 * A regra que atravessa tudo: o técnico opera a CTO **através de uma OS
 * `IN_PROGRESS` que é dele**, e o cliente do vínculo é o cliente daquela OS.
 * Nenhum dos dois é campo de payload.
 *
 * Todas as fixtures são fictícias.
 */

let fixture: TestFixture;
let webCtx: ConnectionContext;
let tokenA: string;
let tokenB: string;
let technicianA: { id: string };
let technicianB: { id: string };

beforeEach(async () => {
  fixture = await seedTestData();
  await prisma.company.updateMany({
    where: { id: { in: [fixture.companyA.id, fixture.companyB.id] } },
    data: { ctoNetworkEnabled: true },
  });

  technicianA = await prisma.technician.create({
    data: { companyId: fixture.companyA.id, userId: fixture.techA.id },
    select: { id: true },
  });
  technicianB = await prisma.technician.create({
    data: { companyId: fixture.companyA.id, userId: fixture.techB.id },
    select: { id: true },
  });

  tokenA = (await registerTestDevice(fixture.techA.id)).token;
  tokenB = (await registerTestDevice(fixture.techB.id)).token;

  webCtx = {
    companyId: fixture.companyA.id,
    provenance: { source: "WEB", actorUserId: fixture.adminA.id },
  };
});

// --- ajudantes --------------------------------------------------------------

let chave = 0;
function novaChave() {
  chave += 1;
  return `cto-2-4-${Date.now()}-${chave}`;
}

function post(
  url: string,
  body: unknown,
  token: string,
  key: string = novaChave(),
) {
  return fieldRequest(url, {
    method: "POST",
    body,
    token,
    idempotencyKey: key,
  });
}

async function corpo(res: Response) {
  return (await res.json()) as {
    ok: boolean;
    data?: Record<string, unknown>;
    error?: { code: string; message: string };
  };
}

async function novaCto(nome: string, capacidade = 8, companyId?: string) {
  const empresa = companyId ?? fixture.companyA.id;
  const ator =
    empresa === fixture.companyA.id ? fixture.adminA.id : fixture.adminB.id;
  return createCto(empresa, ator, { name: nome, capacity: capacidade });
}

async function porta(ctoId: string, numero: number) {
  return prisma.cTOPort.findFirstOrThrow({ where: { ctoId, number: numero } });
}

async function novoCliente(nome: string, companyId?: string) {
  return prisma.customer.create({
    data: { companyId: companyId ?? fixture.companyA.id, name: nome },
  });
}

interface Cenario {
  orderId: string;
  customerId: string;
  version: number;
}

/**
 * Uma OS real do técnico A, em andamento, com cliente próprio.
 *
 * Passa por `startServiceOrder` em vez de gravar `IN_PROGRESS` na mão: o que se
 * quer provar depende do `version` que a máquina de estados produz, e um status
 * escrito por fora nasceria com uma versão que a produção nunca teria.
 */
async function cenario(
  options: {
    userId?: string;
    technicianId?: string;
    companyId?: string;
    customerId?: string;
    start?: boolean;
  } = {},
): Promise<Cenario> {
  const companyId = options.companyId ?? fixture.companyA.id;
  const userId = options.userId ?? fixture.techA.id;
  const technicianId = options.technicianId ?? technicianA.id;
  const customerId =
    options.customerId ?? (await novoCliente("Cliente Ficticio")).id;

  const order = await prisma.serviceOrder.create({
    data: {
      companyId,
      number: await allocateTestServiceOrderNumber(companyId),
      customerId,
      technicianId,
      type: "Instalação",
      description: "Instalação de fibra (fixture).",
      status: "ASSIGNED",
      assignedAt: new Date(),
    },
  });

  if (options.start === false) {
    return { orderId: order.id, customerId, version: order.version };
  }

  await startServiceOrder(companyId, userId, order.id, order.version);
  const atual = await prisma.serviceOrder.findUniqueOrThrow({
    where: { id: order.id },
    select: { version: true },
  });
  return { orderId: order.id, customerId, version: atual.version };
}

async function versaoDe(orderId: string) {
  const row = await prisma.serviceOrder.findUniqueOrThrow({
    where: { id: orderId },
    select: { version: true },
  });
  return row.version;
}

async function eventos(orderId: string) {
  return prisma.serviceOrderEvent.findMany({
    where: { serviceOrderId: orderId },
    select: { event: true },
    orderBy: { createdAt: "asc" },
  });
}

async function ativos(where: Record<string, unknown>) {
  return prisma.customerNetworkConnection.count({
    where: { ...where, disconnectedAt: null },
  });
}

// ---------------------------------------------------------------------------
// CONNECT
// ---------------------------------------------------------------------------

describe("CTO-2.4 · CONNECT", () => {
  it("FIELD-C01 conecta pela OS em andamento do próprio técnico", async () => {
    const cto = await novaCto("CX-01");
    const p = await porta(cto.id, 3);
    const c = await cenario();

    const res = await connectRoute(
      post(`/api/field/v1/service-orders/${c.orderId}/network/connect`, {
        expectedVersion: c.version,
        ctoPortId: p.id,
      }, tokenA),
      { params: { id: c.orderId } },
    );

    expect(res.status).toBe(201);
    const body = await corpo(res);
    expect(body.ok).toBe(true);
    const connection = (body.data as { connection: { portNumber: number } })
      .connection;
    expect(connection.portNumber).toBe(3);
    expect(await ativos({ customerId: c.customerId })).toBe(1);
  });

  it("FIELD-C02/C03/C04/C05 grava procedência derivada, e nada do payload", async () => {
    const cto = await novaCto("CX-02");
    const p = await porta(cto.id, 1);
    const c = await cenario();

    await connectRoute(
      post(`/api/field/v1/service-orders/${c.orderId}/network/connect`, {
        expectedVersion: c.version,
        ctoPortId: p.id,
      }, tokenA),
      { params: { id: c.orderId } },
    );

    const linha = await prisma.customerNetworkConnection.findFirstOrThrow({
      where: { companyId: fixture.companyA.id, disconnectedAt: null },
    });
    expect(linha.source).toBe("FIELD");
    expect(linha.technicianId).toBe(technicianA.id);
    expect(linha.serviceOrderId).toBe(c.orderId);
    expect(linha.customerId).toBe(c.customerId);
    expect(linha.companyId).toBe(fixture.companyA.id);
  });

  it("FIELD-C06 recusa OS PENDING", async () => {
    const cto = await novaCto("CX-06");
    const p = await porta(cto.id, 1);
    const c = await cenario({ start: false });
    await prisma.serviceOrder.update({
      where: { id: c.orderId },
      data: { status: "PENDING" },
    });

    const res = await connectRoute(
      post(`/api/field/v1/service-orders/${c.orderId}/network/connect`, {
        expectedVersion: c.version,
        ctoPortId: p.id,
      }, tokenA),
      { params: { id: c.orderId } },
    );
    expect(res.status).toBe(409);
    expect(await ativos({ customerId: c.customerId })).toBe(0);
  });

  it("FIELD-C07 recusa OS ASSIGNED", async () => {
    const cto = await novaCto("CX-07");
    const p = await porta(cto.id, 1);
    const c = await cenario({ start: false });

    const res = await connectRoute(
      post(`/api/field/v1/service-orders/${c.orderId}/network/connect`, {
        expectedVersion: c.version,
        ctoPortId: p.id,
      }, tokenA),
      { params: { id: c.orderId } },
    );
    expect(res.status).toBe(409);
    expect(await ativos({ customerId: c.customerId })).toBe(0);
  });

  it("FIELD-C08 recusa OS COMPLETED", async () => {
    const cto = await novaCto("CX-08");
    const p = await porta(cto.id, 1);
    const c = await cenario();
    await prisma.serviceOrder.update({
      where: { id: c.orderId },
      data: { status: "COMPLETED", completedAt: new Date() },
    });

    const res = await connectRoute(
      post(`/api/field/v1/service-orders/${c.orderId}/network/connect`, {
        expectedVersion: await versaoDe(c.orderId),
        ctoPortId: p.id,
      }, tokenA),
      { params: { id: c.orderId } },
    );
    expect(res.status).toBe(409);
    expect(await ativos({ customerId: c.customerId })).toBe(0);
  });

  it("FIELD-C09 recusa a OS de outro técnico da mesma empresa", async () => {
    const cto = await novaCto("CX-09");
    const p = await porta(cto.id, 1);
    const c = await cenario({
      userId: fixture.techB.id,
      technicianId: technicianB.id,
    });

    const res = await connectRoute(
      post(`/api/field/v1/service-orders/${c.orderId}/network/connect`, {
        expectedVersion: c.version,
        ctoPortId: p.id,
      }, tokenA),
      { params: { id: c.orderId } },
    );
    expect(res.status).toBe(404);
    expect(await ativos({ customerId: c.customerId })).toBe(0);
  });

  it("FIELD-C10 recusa a OS de outra empresa", async () => {
    const cto = await novaCto("CX-10");
    const p = await porta(cto.id, 1);

    const userB = await prisma.user.findUniqueOrThrow({
      where: { id: fixture.adminB.id },
      select: { companyId: true },
    });
    const techUserB = await prisma.user.create({
      data: {
        companyId: userB.companyId,
        name: "Tecnico Empresa B",
        email: "tecnico-b@companyb.test",
        profile: "TECHNICIAN",
        passwordHash: (
          await prisma.user.findUniqueOrThrow({
            where: { id: fixture.techA.id },
            select: { passwordHash: true },
          })
        ).passwordHash,
      },
    });
    const techOfB = await prisma.technician.create({
      data: { companyId: userB.companyId, userId: techUserB.id },
      select: { id: true },
    });
    const clienteB = await novoCliente("Cliente B", userB.companyId);
    const c = await cenario({
      companyId: userB.companyId,
      userId: techUserB.id,
      technicianId: techOfB.id,
      customerId: clienteB.id,
    });

    const res = await connectRoute(
      post(`/api/field/v1/service-orders/${c.orderId}/network/connect`, {
        expectedVersion: c.version,
        ctoPortId: p.id,
      }, tokenA),
      { params: { id: c.orderId } },
    );
    expect(res.status).toBe(404);
  });

  it.each([
    ["FIELD-C11", "customerId"],
    ["FIELD-C12", "technicianId"],
    ["FIELD-C13", "serviceOrderId"],
    ["FIELD-C14", "source"],
    ["FIELD-C14b", "companyId"],
    ["FIELD-C14c", "connectedAt"],
    ["FIELD-C14d", "createdAt"],
    ["FIELD-C14e", "actorUserId"],
    ["FIELD-C14f", "version"],
  ])("%s recusa %s no corpo", async (_caso, campo) => {
    const cto = await novaCto(`CX-${campo}`);
    const p = await porta(cto.id, 1);
    const c = await cenario();

    const res = await connectRoute(
      post(`/api/field/v1/service-orders/${c.orderId}/network/connect`, {
        expectedVersion: c.version,
        ctoPortId: p.id,
        [campo]: campo === "source" ? "WEB" : "valor-hostil",
      }, tokenA),
      { params: { id: c.orderId } },
    );

    expect(res.status).toBe(400);
    expect(await ativos({ companyId: fixture.companyA.id })).toBe(0);
  });

  it("FIELD-C05b ids REAIS de outro cliente e de outro técnico não são obedecidos", async () => {
    /*
      Os ataques de `FIELD-C11`/`C12` usam uma string inventada, e uma string
      inventada é recusada por qualquer caminho — inclusive por um servidor que
      obedecesse ao corpo, porque o cliente não existiria. Este manda ids que
      FUNCIONARIAM: se a rota lesse o corpo, ela conectaria o outro cliente com
      sucesso, e a asserção teria o que proibir.
    */
    const cto = await novaCto("CX-C05B");
    const alheio = await novoCliente("Cliente De Outra OS");
    const c = await cenario();

    /*
      Um campo POR VEZ, e a razão é dura: mandando os dois juntos, a recusa do
      `technicianId` chega primeiro e a asserção passa mesmo que o
      `customerId` estivesse sendo obedecido. Um teste que agrega dois ataques
      só prova que ALGUM deles foi barrado.
    */
    const comCliente = await connectRoute(
      post(`/api/field/v1/service-orders/${c.orderId}/network/connect`, {
        expectedVersion: c.version,
        ctoPortId: (await porta(cto.id, 1)).id,
        customerId: alheio.id,
      }, tokenA),
      { params: { id: c.orderId } },
    );
    expect(comCliente.status).toBe(400);
    expect(await ativos({ customerId: alheio.id })).toBe(0);

    const comTecnico = await connectRoute(
      post(`/api/field/v1/service-orders/${c.orderId}/network/connect`, {
        expectedVersion: c.version,
        ctoPortId: (await porta(cto.id, 1)).id,
        technicianId: technicianB.id,
      }, tokenA),
      { params: { id: c.orderId } },
    );
    expect(comTecnico.status).toBe(400);
    expect(await ativos({ technicianId: technicianB.id })).toBe(0);

    // Sem os campos hostis, a MESMA operação passa e grava os valores reais.
    const ok = await connectRoute(
      post(`/api/field/v1/service-orders/${c.orderId}/network/connect`, {
        expectedVersion: c.version,
        ctoPortId: (await porta(cto.id, 1)).id,
      }, tokenA),
      { params: { id: c.orderId } },
    );
    expect(ok.status).toBe(201);
    const linha = await prisma.customerNetworkConnection.findFirstOrThrow({
      where: { disconnectedAt: null },
    });
    expect(linha.customerId).toBe(c.customerId);
    expect(linha.technicianId).toBe(technicianA.id);
  });

  it("FIELD-C15 recusa CTO inativa", async () => {
    const cto = await novaCto("CX-15");
    const p = await porta(cto.id, 1);
    await setCtoActive(fixture.companyA.id, fixture.adminA.id, cto.id, false);
    const c = await cenario();

    const res = await connectRoute(
      post(`/api/field/v1/service-orders/${c.orderId}/network/connect`, {
        expectedVersion: c.version,
        ctoPortId: p.id,
      }, tokenA),
      { params: { id: c.orderId } },
    );
    expect(res.status).toBe(409);
  });

  it.each([["RESERVED"], ["DAMAGED"]] as const)(
    "FIELD-C16 recusa porta %s",
    async (estado) => {
      const cto = await novaCto("CX-16-" + estado);
      const p = await porta(cto.id, 2);
      await setPortAdministrativeState(
        fixture.companyA.id,
        fixture.adminA.id,
        cto.id,
        p.id,
        estado,
      );
      const c = await cenario();

      const res = await connectRoute(
        post(`/api/field/v1/service-orders/${c.orderId}/network/connect`, {
          expectedVersion: c.version,
          ctoPortId: p.id,
        }, tokenA),
        { params: { id: c.orderId } },
      );
      expect(res.status).toBe(409);
    },
  );

  it("FIELD-C17 recusa porta já ocupada", async () => {
    const cto = await novaCto("CX-17");
    const p = await porta(cto.id, 4);
    const outro = await novoCliente("Outro Cliente");
    await connectCustomerToPort(webCtx, {
      customerId: outro.id,
      ctoPortId: p.id,
    });
    const c = await cenario();

    const res = await connectRoute(
      post(`/api/field/v1/service-orders/${c.orderId}/network/connect`, {
        expectedVersion: c.version,
        ctoPortId: p.id,
      }, tokenA),
      { params: { id: c.orderId } },
    );
    expect(res.status).toBe(409);
    expect(await ativos({ ctoPortId: p.id })).toBe(1);
  });

  it("FIELD-C18 recusa cliente que já está conectado", async () => {
    const cto = await novaCto("CX-18");
    const c = await cenario();
    await connectCustomerToPort(webCtx, {
      customerId: c.customerId,
      ctoPortId: (await porta(cto.id, 1)).id,
    });

    const res = await connectRoute(
      post(`/api/field/v1/service-orders/${c.orderId}/network/connect`, {
        expectedVersion: c.version,
        ctoPortId: (await porta(cto.id, 2)).id,
      }, tokenA),
      { params: { id: c.orderId } },
    );
    expect(res.status).toBe(409);
    expect(await ativos({ customerId: c.customerId })).toBe(1);
  });

  it("FIELD-C19 exige Idempotency-Key", async () => {
    const cto = await novaCto("CX-19");
    const p = await porta(cto.id, 1);
    const c = await cenario();

    const res = await connectRoute(
      fieldRequest(
        `/api/field/v1/service-orders/${c.orderId}/network/connect`,
        {
          method: "POST",
          body: { expectedVersion: c.version, ctoPortId: p.id },
          token: tokenA,
        },
      ),
      { params: { id: c.orderId } },
    );
    expect(res.status).toBe(400);
  });

  it("FIELD-C20 recusa expectedVersion obsoleta", async () => {
    const cto = await novaCto("CX-20");
    const c = await cenario();

    const primeira = await connectRoute(
      post(`/api/field/v1/service-orders/${c.orderId}/network/connect`, {
        expectedVersion: c.version,
        ctoPortId: (await porta(cto.id, 1)).id,
      }, tokenA),
      { params: { id: c.orderId } },
    );
    expect(primeira.status).toBe(201);

    // Mesma versão de antes: a primeira operação já a moveu.
    const segunda = await disconnectRoute(
      post(`/api/field/v1/service-orders/${c.orderId}/network/disconnect`, {
        expectedVersion: c.version,
        expectedConnectionId: (
          await prisma.customerNetworkConnection.findFirstOrThrow({
            where: { customerId: c.customerId, disconnectedAt: null },
          })
        ).id,
      }, tokenA),
      { params: { id: c.orderId } },
    );
    expect(segunda.status).toBe(409);
    expect(await ativos({ customerId: c.customerId })).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// DISCONNECT
// ---------------------------------------------------------------------------

describe("CTO-2.4 · DISCONNECT", () => {
  async function comVinculo(nome = "CX-D") {
    const cto = await novaCto(nome);
    const p = await porta(cto.id, 2);
    const c = await cenario();
    const vinculo = await connectCustomerToPort(webCtx, {
      customerId: c.customerId,
      ctoPortId: p.id,
    });
    return { cto, port: p, c, vinculo };
  }

  it("FIELD-D01/D02 encerra sem apagar a linha", async () => {
    const { c, vinculo } = await comVinculo("CX-D01");

    const res = await disconnectRoute(
      post(`/api/field/v1/service-orders/${c.orderId}/network/disconnect`, {
        expectedVersion: c.version,
        expectedConnectionId: vinculo.id,
      }, tokenA),
      { params: { id: c.orderId } },
    );

    expect(res.status).toBe(200);
    const linha = await prisma.customerNetworkConnection.findUniqueOrThrow({
      where: { id: vinculo.id },
    });
    expect(linha.disconnectedAt).not.toBeNull();
    expect(
      await prisma.customerNetworkConnection.count({
        where: { customerId: c.customerId },
      }),
    ).toBe(1);
  });

  it("FIELD-D03 grava o evento na OS que autorizou, e só nela", async () => {
    const { c, vinculo } = await comVinculo("CX-D03");
    const outra = await cenario();

    await disconnectRoute(
      post(`/api/field/v1/service-orders/${c.orderId}/network/disconnect`, {
        expectedVersion: c.version,
        expectedConnectionId: vinculo.id,
      }, tokenA),
      { params: { id: c.orderId } },
    );

    const daOs = (await eventos(c.orderId)).map((e) => e.event);
    expect(daOs).toContain("CTO_PORT_DISCONNECTED");
    const daOutra = (await eventos(outra.orderId)).map((e) => e.event);
    expect(daOutra).not.toContain("CTO_PORT_DISCONNECTED");
  });

  it("FIELD-D04 recusa vínculo obsoleto e não atinge o novo", async () => {
    const { c, vinculo, cto } = await comVinculo("CX-D04");
    // O despacho move o cliente enquanto o técnico olha a tela antiga.
    const destino = await porta(cto.id, 5);
    const { moveCustomerToPort } = await import("@/lib/cto-connections");
    const movido = await moveCustomerToPort(webCtx, {
      customerId: c.customerId,
      expectedConnectionId: vinculo.id,
      targetCtoPortId: destino.id,
    });

    const res = await disconnectRoute(
      post(`/api/field/v1/service-orders/${c.orderId}/network/disconnect`, {
        expectedVersion: await versaoDe(c.orderId),
        expectedConnectionId: vinculo.id,
      }, tokenA),
      { params: { id: c.orderId } },
    );

    expect(res.status).toBe(409);
    const novo = await prisma.customerNetworkConnection.findUniqueOrThrow({
      where: { id: movido.to.id },
    });
    expect(novo.disconnectedAt).toBeNull();
    expect((await eventos(c.orderId)).map((e) => e.event)).not.toContain(
      "CTO_PORT_DISCONNECTED",
    );
  });

  it("FIELD-D05 não alcança o vínculo de outro cliente", async () => {
    const { c } = await comVinculo("CX-D05");
    const cto2 = await novaCto("CX-D05-B");
    const outro = await novoCliente("Cliente Alheio");
    const alheio = await connectCustomerToPort(webCtx, {
      customerId: outro.id,
      ctoPortId: (await porta(cto2.id, 1)).id,
    });

    const res = await disconnectRoute(
      post(`/api/field/v1/service-orders/${c.orderId}/network/disconnect`, {
        expectedVersion: c.version,
        expectedConnectionId: alheio.id,
      }, tokenA),
      { params: { id: c.orderId } },
    );

    expect(res.status).toBe(409);
    expect(
      (
        await prisma.customerNetworkConnection.findUniqueOrThrow({
          where: { id: alheio.id },
        })
      ).disconnectedAt,
    ).toBeNull();
  });

  it("FIELD-D06 não alcança o vínculo de outra empresa", async () => {
    const { c } = await comVinculo("CX-D06");
    const ctoB = await novaCto("CX-B", 4, fixture.companyB.id);
    const clienteB = await novoCliente("Cliente B", fixture.companyB.id);
    const vinculoB = await connectCustomerToPort(
      {
        companyId: fixture.companyB.id,
        provenance: { source: "WEB", actorUserId: fixture.adminB.id },
      },
      {
        customerId: clienteB.id,
        ctoPortId: (await porta(ctoB.id, 1)).id,
      },
    );

    const res = await disconnectRoute(
      post(`/api/field/v1/service-orders/${c.orderId}/network/disconnect`, {
        expectedVersion: c.version,
        expectedConnectionId: vinculoB.id,
      }, tokenA),
      { params: { id: c.orderId } },
    );

    expect(res.status).toBe(409);
    expect(await ativos({ companyId: fixture.companyB.id })).toBe(1);
  });

  it("FIELD-D07 recusa quando a OS é de outro técnico", async () => {
    const cto = await novaCto("CX-D07");
    const c = await cenario({
      userId: fixture.techB.id,
      technicianId: technicianB.id,
    });
    const vinculo = await connectCustomerToPort(webCtx, {
      customerId: c.customerId,
      ctoPortId: (await porta(cto.id, 1)).id,
    });

    const res = await disconnectRoute(
      post(`/api/field/v1/service-orders/${c.orderId}/network/disconnect`, {
        expectedVersion: c.version,
        expectedConnectionId: vinculo.id,
      }, tokenA),
      { params: { id: c.orderId } },
    );
    expect(res.status).toBe(404);
    expect(await ativos({ id: vinculo.id })).toBe(1);
  });

  it("FIELD-D08/D09 replay devolve a mesma resposta e não fecha o vínculo seguinte", async () => {
    const { c, vinculo, cto } = await comVinculo("CX-D08");
    const key = novaChave();
    const corpoReq = {
      expectedVersion: c.version,
      expectedConnectionId: vinculo.id,
    };

    const primeira = await disconnectRoute(
      post(
        `/api/field/v1/service-orders/${c.orderId}/network/disconnect`,
        corpoReq,
        tokenA,
        key,
      ),
      { params: { id: c.orderId } },
    );
    expect(primeira.status).toBe(200);

    // Entre o envio e a retentativa, o cliente é reconectado em outra porta.
    const novo = await connectCustomerToPort(webCtx, {
      customerId: c.customerId,
      ctoPortId: (await porta(cto.id, 6)).id,
    });

    const replay = await disconnectRoute(
      post(
        `/api/field/v1/service-orders/${c.orderId}/network/disconnect`,
        corpoReq,
        tokenA,
        key,
      ),
      { params: { id: c.orderId } },
    );
    expect(replay.status).toBe(200);

    expect(
      (
        await prisma.customerNetworkConnection.findUniqueOrThrow({
          where: { id: novo.id },
        })
      ).disconnectedAt,
    ).toBeNull();
    expect(
      (await eventos(c.orderId)).filter(
        (e) => e.event === "CTO_PORT_DISCONNECTED",
      ),
    ).toHaveLength(1);
  });

  it("FIELD-D10 desconecta mesmo com a CTO inativa", async () => {
    const { c, vinculo, cto } = await comVinculo("CX-D10");
    await setCtoActive(fixture.companyA.id, fixture.adminA.id, cto.id, false);

    const res = await disconnectRoute(
      post(`/api/field/v1/service-orders/${c.orderId}/network/disconnect`, {
        expectedVersion: c.version,
        expectedConnectionId: vinculo.id,
      }, tokenA),
      { params: { id: c.orderId } },
    );
    expect(res.status).toBe(200);
    expect(await ativos({ customerId: c.customerId })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// MOVE
// ---------------------------------------------------------------------------

describe("CTO-2.4 · MOVE", () => {
  async function comVinculo(nome: string, capacidade = 8) {
    const cto = await novaCto(nome, capacidade);
    const p = await porta(cto.id, 2);
    const c = await cenario();
    const vinculo = await connectCustomerToPort(webCtx, {
      customerId: c.customerId,
      ctoPortId: p.id,
    });
    return { cto, port: p, c, vinculo };
  }

  it("FIELD-M01/M12 move dentro da mesma CTO com exatamente um evento", async () => {
    const { c, vinculo, cto } = await comVinculo("CX-M01");
    const destino = await porta(cto.id, 7);

    const res = await moveRoute(
      post(`/api/field/v1/service-orders/${c.orderId}/network/move`, {
        expectedVersion: c.version,
        expectedConnectionId: vinculo.id,
        targetCtoPortId: destino.id,
      }, tokenA),
      { params: { id: c.orderId } },
    );

    expect(res.status).toBe(200);
    const body = await corpo(res);
    const data = body.data as {
      connection: { portNumber: number };
      previous: { portNumber: number };
    };
    expect(data.connection.portNumber).toBe(7);
    expect(data.previous.portNumber).toBe(2);

    const eventosCto = (await eventos(c.orderId)).filter((e) =>
      e.event.startsWith("CTO_PORT_"),
    );
    expect(eventosCto.map((e) => e.event)).toEqual(["CTO_PORT_MOVED"]);
  });

  it("FIELD-M02 move entre CTOs diferentes", async () => {
    const { c, vinculo } = await comVinculo("CX-M02-A");
    const outra = await novaCto("CX-M02-B");
    const destino = await porta(outra.id, 1);

    const res = await moveRoute(
      post(`/api/field/v1/service-orders/${c.orderId}/network/move`, {
        expectedVersion: c.version,
        expectedConnectionId: vinculo.id,
        targetCtoPortId: destino.id,
      }, tokenA),
      { params: { id: c.orderId } },
    );
    expect(res.status).toBe(200);
    expect(await ativos({ ctoPortId: destino.id })).toBe(1);
  });

  it("FIELD-M03 permite sair de uma CTO inativa", async () => {
    const { c, vinculo, cto } = await comVinculo("CX-M03-A");
    await setCtoActive(fixture.companyA.id, fixture.adminA.id, cto.id, false);
    const outra = await novaCto("CX-M03-B");

    const res = await moveRoute(
      post(`/api/field/v1/service-orders/${c.orderId}/network/move`, {
        expectedVersion: c.version,
        expectedConnectionId: vinculo.id,
        targetCtoPortId: (await porta(outra.id, 1)).id,
      }, tokenA),
      { params: { id: c.orderId } },
    );
    expect(res.status).toBe(200);
  });

  it("FIELD-M04 recusa destino em CTO inativa", async () => {
    const { c, vinculo } = await comVinculo("CX-M04-A");
    const outra = await novaCto("CX-M04-B");
    await setCtoActive(fixture.companyA.id, fixture.adminA.id, outra.id, false);

    const res = await moveRoute(
      post(`/api/field/v1/service-orders/${c.orderId}/network/move`, {
        expectedVersion: c.version,
        expectedConnectionId: vinculo.id,
        targetCtoPortId: (await porta(outra.id, 1)).id,
      }, tokenA),
      { params: { id: c.orderId } },
    );
    expect(res.status).toBe(409);
  });

  it("FIELD-M05 recusa a mesma porta", async () => {
    const { c, vinculo, port } = await comVinculo("CX-M05");

    const res = await moveRoute(
      post(`/api/field/v1/service-orders/${c.orderId}/network/move`, {
        expectedVersion: c.version,
        expectedConnectionId: vinculo.id,
        targetCtoPortId: port.id,
      }, tokenA),
      { params: { id: c.orderId } },
    );
    expect(res.status).toBe(409);
    expect((await eventos(c.orderId)).map((e) => e.event)).not.toContain(
      "CTO_PORT_MOVED",
    );
  });

  it("FIELD-M06 recusa origem obsoleta e preserva o vínculo real", async () => {
    const { c, vinculo, cto } = await comVinculo("CX-M06");
    const { moveCustomerToPort } = await import("@/lib/cto-connections");
    const real = await moveCustomerToPort(webCtx, {
      customerId: c.customerId,
      expectedConnectionId: vinculo.id,
      targetCtoPortId: (await porta(cto.id, 5)).id,
    });
    const terceira = await porta(cto.id, 8);

    const res = await moveRoute(
      post(`/api/field/v1/service-orders/${c.orderId}/network/move`, {
        expectedVersion: await versaoDe(c.orderId),
        expectedConnectionId: vinculo.id,
        targetCtoPortId: terceira.id,
      }, tokenA),
      { params: { id: c.orderId } },
    );

    expect(res.status).toBe(409);
    expect(await ativos({ id: real.to.id })).toBe(1);
    expect(await ativos({ ctoPortId: terceira.id })).toBe(0);
    expect((await eventos(c.orderId)).map((e) => e.event)).not.toContain(
      "CTO_PORT_MOVED",
    );
  });

  it("FIELD-M07 recusa destino ocupado", async () => {
    const { c, vinculo, cto } = await comVinculo("CX-M07");
    const destino = await porta(cto.id, 6);
    const outro = await novoCliente("Ocupante");
    await connectCustomerToPort(webCtx, {
      customerId: outro.id,
      ctoPortId: destino.id,
    });

    const res = await moveRoute(
      post(`/api/field/v1/service-orders/${c.orderId}/network/move`, {
        expectedVersion: c.version,
        expectedConnectionId: vinculo.id,
        targetCtoPortId: destino.id,
      }, tokenA),
      { params: { id: c.orderId } },
    );
    expect(res.status).toBe(409);
  });

  it.each([["RESERVED"], ["DAMAGED"]] as const)(
    "FIELD-M08/M09 recusa destino %s",
    async (estado) => {
      const { c, vinculo, cto } = await comVinculo("CX-M08-" + estado);
      const destino = await porta(cto.id, 6);
      await setPortAdministrativeState(
        fixture.companyA.id,
        fixture.adminA.id,
        cto.id,
        destino.id,
        estado,
      );

      const res = await moveRoute(
        post(`/api/field/v1/service-orders/${c.orderId}/network/move`, {
          expectedVersion: c.version,
          expectedConnectionId: vinculo.id,
          targetCtoPortId: destino.id,
        }, tokenA),
        { params: { id: c.orderId } },
      );
      expect(res.status).toBe(409);
    },
  );

  it("FIELD-M10 recusa vínculo de outro cliente com OS legítima", async () => {
    const { c, cto } = await comVinculo("CX-M10");
    const outroCliente = await novoCliente("Cliente Alheio");
    const alheio = await connectCustomerToPort(webCtx, {
      customerId: outroCliente.id,
      ctoPortId: (await porta(cto.id, 4)).id,
    });

    const res = await moveRoute(
      post(`/api/field/v1/service-orders/${c.orderId}/network/move`, {
        expectedVersion: c.version,
        expectedConnectionId: alheio.id,
        targetCtoPortId: (await porta(cto.id, 7)).id,
      }, tokenA),
      { params: { id: c.orderId } },
    );

    expect(res.status).toBe(409);
    const linha = await prisma.customerNetworkConnection.findUniqueOrThrow({
      where: { id: alheio.id },
    });
    expect(linha.disconnectedAt).toBeNull();
  });

  it("FIELD-M11 replay não duplica a história", async () => {
    const { c, vinculo, cto } = await comVinculo("CX-M11");
    const destino = await porta(cto.id, 7);
    const key = novaChave();
    const corpoReq = {
      expectedVersion: c.version,
      expectedConnectionId: vinculo.id,
      targetCtoPortId: destino.id,
    };

    await moveRoute(
      post(
        `/api/field/v1/service-orders/${c.orderId}/network/move`,
        corpoReq,
        tokenA,
        key,
      ),
      { params: { id: c.orderId } },
    );
    const replay = await moveRoute(
      post(
        `/api/field/v1/service-orders/${c.orderId}/network/move`,
        corpoReq,
        tokenA,
        key,
      ),
      { params: { id: c.orderId } },
    );
    expect(replay.status).toBe(200);

    expect(
      await prisma.customerNetworkConnection.count({
        where: { customerId: c.customerId },
      }),
    ).toBe(2);
    expect(
      (await eventos(c.orderId)).filter((e) => e.event === "CTO_PORT_MOVED"),
    ).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// LEITURA
// ---------------------------------------------------------------------------

describe("CTO-2.4 · leitura", () => {
  it("FIELD-R01 devolve o vínculo do cliente da OS", async () => {
    const cto = await novaCto("CX-R01");
    const c = await cenario();
    await connectCustomerToPort(webCtx, {
      customerId: c.customerId,
      ctoPortId: (await porta(cto.id, 3)).id,
    });

    const res = await networkRoute(
      fieldRequest(`/api/field/v1/service-orders/${c.orderId}/network`, {
        token: tokenA,
      }),
      { params: { id: c.orderId } },
    );

    expect(res.status).toBe(200);
    const data = (await corpo(res)).data as {
      connection: {
        cto: { name: string };
        port: { number: number; occupied: boolean };
      };
    };
    expect(data.connection.cto.name).toBe("CX-R01");
    expect(data.connection.port.number).toBe(3);
    expect(data.connection.port.occupied).toBe(true);
  });

  it("FIELD-R02 devolve null quando não há vínculo", async () => {
    const c = await cenario();
    const res = await networkRoute(
      fieldRequest(`/api/field/v1/service-orders/${c.orderId}/network`, {
        token: tokenA,
      }),
      { params: { id: c.orderId } },
    );
    expect(res.status).toBe(200);
    expect((await corpo(res)).data).toEqual({ connection: null });
  });

  it("FIELD-R03 ignora customerId na query — quem manda é a OS", async () => {
    const cto = await novaCto("CX-R03");
    const c = await cenario();
    await connectCustomerToPort(webCtx, {
      customerId: c.customerId,
      ctoPortId: (await porta(cto.id, 1)).id,
    });

    const alheio = await novoCliente("Cliente Alheio");
    const cto2 = await novaCto("CX-R03-ALHEIA");
    await connectCustomerToPort(webCtx, {
      customerId: alheio.id,
      ctoPortId: (await porta(cto2.id, 1)).id,
    });

    const res = await networkRoute(
      fieldRequest(
        `/api/field/v1/service-orders/${c.orderId}/network?customerId=${alheio.id}`,
        { token: tokenA },
      ),
      { params: { id: c.orderId } },
    );

    const data = (await corpo(res)).data as {
      connection: { cto: { name: string } };
    };
    expect(data.connection.cto.name).toBe("CX-R03");
  });

  it("FIELD-R04 lista apenas as CTOs do tenant da OS", async () => {
    await novaCto("CX-R04-A");
    await novaCto("CX-R04-B", 4, fixture.companyB.id);
    const c = await cenario();

    const res = await ctosRoute(
      fieldRequest(`/api/field/v1/service-orders/${c.orderId}/network/ctos`, {
        token: tokenA,
      }),
      { params: { id: c.orderId } },
    );

    const data = (await corpo(res)).data as { ctos: { name: string }[] };
    expect(data.ctos.map((x) => x.name)).toEqual(["CX-R04-A"]);
  });

  it("FIELD-R05/R06/R07 ocupada, reservada e danificada não contam como livres", async () => {
    const cto = await novaCto("CX-R05", 4);
    const outro = await novoCliente("Ocupante");
    await connectCustomerToPort(webCtx, {
      customerId: outro.id,
      ctoPortId: (await porta(cto.id, 1)).id,
    });
    await setPortAdministrativeState(
      fixture.companyA.id,
      fixture.adminA.id,
      cto.id,
      (await porta(cto.id, 2)).id,
      "RESERVED",
    );
    await setPortAdministrativeState(
      fixture.companyA.id,
      fixture.adminA.id,
      cto.id,
      (await porta(cto.id, 3)).id,
      "DAMAGED",
    );
    const c = await cenario();

    const res = await ctosRoute(
      fieldRequest(`/api/field/v1/service-orders/${c.orderId}/network/ctos`, {
        token: tokenA,
      }),
      { params: { id: c.orderId } },
    );
    const data = (await corpo(res)).data as {
      ctos: { availablePorts: number }[];
    };
    expect(data.ctos[0].availablePorts).toBe(1);
  });

  it("FIELD-R08 CTO inativa não é candidata", async () => {
    const cto = await novaCto("CX-R08");
    await setCtoActive(fixture.companyA.id, fixture.adminA.id, cto.id, false);
    const c = await cenario();

    const res = await ctosRoute(
      fieldRequest(`/api/field/v1/service-orders/${c.orderId}/network/ctos`, {
        token: tokenA,
      }),
      { params: { id: c.orderId } },
    );
    expect((await corpo(res)).data).toEqual({ ctos: [] });
  });

  it("FIELD-R09 porta DANIFICADA e OCUPADA preserva as duas dimensões", async () => {
    const cto = await novaCto("CX-R09");
    const p = await porta(cto.id, 2);
    const c = await cenario();
    await connectCustomerToPort(webCtx, {
      customerId: c.customerId,
      ctoPortId: p.id,
    });
    await setPortAdministrativeState(
      fixture.companyA.id,
      fixture.adminA.id,
      cto.id,
      p.id,
      "DAMAGED",
    );

    const res = await networkRoute(
      fieldRequest(`/api/field/v1/service-orders/${c.orderId}/network`, {
        token: tokenA,
      }),
      { params: { id: c.orderId } },
    );
    const data = (await corpo(res)).data as {
      connection: {
        port: { administrativeState: string; occupied: boolean };
      };
    };
    expect(data.connection.port.administrativeState).toBe("DAMAGED");
    expect(data.connection.port.occupied).toBe(true);
  });

  it("FIELD-R09b vínculo legado em porta RESERVADA continua legível e desconectável", async () => {
    const cto = await novaCto("CX-R09B");
    const p = await porta(cto.id, 2);
    const c = await cenario();
    const vinculo = await connectCustomerToPort(webCtx, {
      customerId: c.customerId,
      ctoPortId: p.id,
    });
    await setPortAdministrativeState(
      fixture.companyA.id,
      fixture.adminA.id,
      cto.id,
      p.id,
      "RESERVED",
    );

    const leitura = await networkRoute(
      fieldRequest(`/api/field/v1/service-orders/${c.orderId}/network`, {
        token: tokenA,
      }),
      { params: { id: c.orderId } },
    );
    const data = (await corpo(leitura)).data as {
      connection: {
        port: { administrativeState: string; occupied: boolean };
      };
    };
    expect(data.connection.port.administrativeState).toBe("RESERVED");
    expect(data.connection.port.occupied).toBe(true);

    const res = await disconnectRoute(
      post(`/api/field/v1/service-orders/${c.orderId}/network/disconnect`, {
        expectedVersion: c.version,
        expectedConnectionId: vinculo.id,
      }, tokenA),
      { params: { id: c.orderId } },
    );
    expect(res.status).toBe(200);
  });

  it("FIELD-R10 nenhuma resposta carrega segredo de PPPoE nem companyId", async () => {
    const cto = await novaCto("CX-R10");
    const c = await cenario();
    await prisma.customerConnection.create({
      data: {
        companyId: fixture.companyA.id,
        customerId: c.customerId,
        username: "pppoe-ficticio",
        credentialCiphertext: "SEGREDO-NAO-DEVE-VAZAR",
        credentialIv: "IV-FICTICIO",
        credentialAuthTag: "TAG-FICTICIA",
        credentialUpdatedAt: new Date(),
      },
    });
    await connectCustomerToPort(webCtx, {
      customerId: c.customerId,
      ctoPortId: (await porta(cto.id, 1)).id,
    });

    const respostas = await Promise.all([
      networkRoute(
        fieldRequest(`/api/field/v1/service-orders/${c.orderId}/network`, {
          token: tokenA,
        }),
        { params: { id: c.orderId } },
      ),
      ctosRoute(
        fieldRequest(`/api/field/v1/service-orders/${c.orderId}/network/ctos`, {
          token: tokenA,
        }),
        { params: { id: c.orderId } },
      ),
      ctoDetailRoute(
        fieldRequest(
          `/api/field/v1/service-orders/${c.orderId}/network/ctos/${cto.id}`,
          { token: tokenA },
        ),
        { params: { id: c.orderId, ctoId: cto.id } },
      ),
    ]);

    for (const res of respostas) {
      const texto = await res.text();
      expect(texto).not.toContain("SEGREDO-NAO-DEVE-VAZAR");
      expect(texto).not.toContain("pppoe-ficticio");
      expect(texto).not.toContain("credentialCiphertext");
      expect(texto).not.toContain(fixture.companyA.id);
    }
  });

  it("FIELD-R11 a ocupação sai de UMA consulta, não de uma por porta", async () => {
    const cto = await novaCto("CX-R11", 64);
    const c = await cenario();
    const espia = vi.spyOn(prisma.customerNetworkConnection, "findMany");

    await ctoDetailRoute(
      fieldRequest(
        `/api/field/v1/service-orders/${c.orderId}/network/ctos/${cto.id}`,
        { token: tokenA },
      ),
      { params: { id: c.orderId, ctoId: cto.id } },
    );

    expect(espia).toHaveBeenCalledTimes(1);
    espia.mockRestore();
  });

  it("FIELD-R12 o detalhe da caixa não revela QUEM ocupa a porta", async () => {
    const cto = await novaCto("CX-R12");
    const alheio = await prisma.customer.create({
      data: {
        companyId: fixture.companyA.id,
        name: "Fulano Que Nao E Desta OS",
      },
    });
    await connectCustomerToPort(webCtx, {
      customerId: alheio.id,
      ctoPortId: (await porta(cto.id, 4)).id,
    });
    const c = await cenario();

    const res = await ctoDetailRoute(
      fieldRequest(
        `/api/field/v1/service-orders/${c.orderId}/network/ctos/${cto.id}`,
        { token: tokenA },
      ),
      { params: { id: c.orderId, ctoId: cto.id } },
    );

    const texto = await res.text();
    expect(texto).not.toContain("Fulano Que Nao E Desta OS");
    expect(texto).not.toContain(alheio.id);
    expect(texto).toContain('"occupied":true');
  });

  it("FIELD-R13 leitura também exige OS em andamento", async () => {
    const c = await cenario({ start: false });
    const res = await networkRoute(
      fieldRequest(`/api/field/v1/service-orders/${c.orderId}/network`, {
        token: tokenA,
      }),
      { params: { id: c.orderId } },
    );
    expect(res.status).toBe(409);
  });

  it("FIELD-R14 porta histórica não aparece no detalhe da caixa", async () => {
    const cto = await novaCto("CX-R14", 8);
    const { changeCtoCapacity } = await import("@/lib/cto");
    await changeCtoCapacity(fixture.companyA.id, fixture.adminA.id, cto.id, 4);
    const c = await cenario();

    const res = await ctoDetailRoute(
      fieldRequest(
        `/api/field/v1/service-orders/${c.orderId}/network/ctos/${cto.id}`,
        { token: tokenA },
      ),
      { params: { id: c.orderId, ctoId: cto.id } },
    );
    const data = (await corpo(res)).data as {
      cto: { ports: { number: number }[] };
    };
    expect(data.cto.ports.map((p) => p.number)).toEqual([1, 2, 3, 4]);
  });
});

// ---------------------------------------------------------------------------
// Ataques
// ---------------------------------------------------------------------------

describe("CTO-2.4 · ataques", () => {
  it("F-A1 técnico legítimo não opera a OS de outro técnico da mesma empresa", async () => {
    const cto = await novaCto("CX-FA1");
    // A OS é do técnico A; quem ataca é o técnico B, com sessão própria,
    // aparelho próprio e perfil TECHNICIAN — mesma empresa, tudo válido.
    const c = await cenario();

    const escrita = await connectRoute(
      post(`/api/field/v1/service-orders/${c.orderId}/network/connect`, {
        expectedVersion: c.version,
        ctoPortId: (await porta(cto.id, 1)).id,
      }, tokenB),
      { params: { id: c.orderId } },
    );
    expect(escrita.status).toBe(404);

    const leitura = await networkRoute(
      fieldRequest(`/api/field/v1/service-orders/${c.orderId}/network`, {
        token: tokenB,
      }),
      { params: { id: c.orderId } },
    );
    expect(leitura.status).toBe(404);
    expect(await ativos({ customerId: c.customerId })).toBe(0);

    // Controle positivo: o dono da OS passa pelo mesmo caminho.
    const dono = await connectRoute(
      post(`/api/field/v1/service-orders/${c.orderId}/network/connect`, {
        expectedVersion: c.version,
        ctoPortId: (await porta(cto.id, 1)).id,
      }, tokenA),
      { params: { id: c.orderId } },
    );
    expect(dono.status).toBe(201);
  });

  it("F-A2/A13 o ator e o técnico gravados são os da sessão, nunca os do corpo", async () => {
    const cto = await novaCto("CX-FA2");
    const c = await cenario();

    await connectRoute(
      post(`/api/field/v1/service-orders/${c.orderId}/network/connect`, {
        expectedVersion: c.version,
        ctoPortId: (await porta(cto.id, 1)).id,
      }, tokenA),
      { params: { id: c.orderId } },
    );

    const auditoria = await prisma.auditLog.findFirstOrThrow({
      where: {
        companyId: fixture.companyA.id,
        action: "CTO_CONNECTION.CONNECTED",
      },
    });
    expect(auditoria.userId).toBe(fixture.techA.id);

    const evento = await prisma.serviceOrderEvent.findFirstOrThrow({
      where: { serviceOrderId: c.orderId, event: "CTO_PORT_CONNECTED" },
    });
    expect(evento.userId).toBe(fixture.techA.id);
    expect(evento.serviceOrderId).toBe(c.orderId);

    const linha = await prisma.customerNetworkConnection.findFirstOrThrow({
      where: { customerId: c.customerId, disconnectedAt: null },
    });
    expect(linha.technicianId).toBe(technicianA.id);
    expect(linha.technicianId).not.toBe(technicianB.id);
  });

  it("F-A5 CTO de outra empresa responde 404, com o mesmo corpo de um id inexistente", async () => {
    const ctoB = await novaCto("CX-FA5", 4, fixture.companyB.id);
    const c = await cenario();

    const doOutro = await ctoDetailRoute(
      fieldRequest(
        `/api/field/v1/service-orders/${c.orderId}/network/ctos/${ctoB.id}`,
        { token: tokenA },
      ),
      { params: { id: c.orderId, ctoId: ctoB.id } },
    );
    const inexistente = await ctoDetailRoute(
      fieldRequest(
        `/api/field/v1/service-orders/${c.orderId}/network/ctos/nao-existe`,
        { token: tokenA },
      ),
      { params: { id: c.orderId, ctoId: "nao-existe" } },
    );

    expect(doOutro.status).toBe(404);
    expect(inexistente.status).toBe(404);
    // Corpos idênticos: a diferença entre "não é seu" e "não existe" seria o
    // oráculo de enumeração que o módulo inteiro evita.
    expect(await doOutro.text()).toBe(await inexistente.text());
  });

  it("F-A5b controle positivo: a CTO da própria empresa É devolvida", async () => {
    const cto = await novaCto("CX-FA5B");
    const c = await cenario();
    const res = await ctoDetailRoute(
      fieldRequest(
        `/api/field/v1/service-orders/${c.orderId}/network/ctos/${cto.id}`,
        { token: tokenA },
      ),
      { params: { id: c.orderId, ctoId: cto.id } },
    );
    expect(res.status).toBe(200);
  });

  it("F-A6 porta de outra CTO da MESMA empresa conecta pelo caminho normal e a de outra empresa é 404", async () => {
    const minha = await novaCto("CX-FA6-A");
    const outraEmpresa = await novaCto("CX-FA6-B", 4, fixture.companyB.id);
    const c = await cenario();

    const res = await connectRoute(
      post(`/api/field/v1/service-orders/${c.orderId}/network/connect`, {
        expectedVersion: c.version,
        ctoPortId: (await porta(outraEmpresa.id, 1)).id,
      }, tokenA),
      { params: { id: c.orderId } },
    );
    expect(res.status).toBe(404);
    expect(await ativos({ customerId: c.customerId })).toBe(0);

    // Controle positivo: a porta da própria empresa passa.
    const ok = await connectRoute(
      post(`/api/field/v1/service-orders/${c.orderId}/network/connect`, {
        expectedVersion: c.version,
        ctoPortId: (await porta(minha.id, 1)).id,
      }, tokenA),
      { params: { id: c.orderId } },
    );
    expect(ok.status).toBe(201);
  });

  it("F-A7 a mesma chave em duas OS diferentes não é replay", async () => {
    const cto = await novaCto("CX-FA7");
    const a = await cenario();
    const b = await cenario();
    const key = novaChave();

    const primeira = await connectRoute(
      post(
        `/api/field/v1/service-orders/${a.orderId}/network/connect`,
        { expectedVersion: a.version, ctoPortId: (await porta(cto.id, 1)).id },
        tokenA,
        key,
      ),
      { params: { id: a.orderId } },
    );
    expect(primeira.status).toBe(201);

    const segunda = await connectRoute(
      post(
        `/api/field/v1/service-orders/${b.orderId}/network/connect`,
        { expectedVersion: b.version, ctoPortId: (await porta(cto.id, 1)).id },
        tokenA,
        key,
      ),
      { params: { id: b.orderId } },
    );

    // A OS entra na impressão digital: mesma chave, OS diferente, conflito
    // explícito em vez de devolver a resposta gravada para a outra OS.
    expect(segunda.status).toBe(409);
    const body = await corpo(segunda);
    expect(body.error?.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(await ativos({ customerId: b.customerId })).toBe(0);
  });

  it("F-A10 usuário sem Technician não autentica no Field", async () => {
    const semTecnico = await prisma.user.create({
      data: {
        companyId: fixture.companyA.id,
        name: "Tecnico Sem Registro",
        email: "sem-registro@alfa.test",
        profile: "TECHNICIAN",
        passwordHash: (
          await prisma.user.findUniqueOrThrow({
            where: { id: fixture.techA.id },
            select: { passwordHash: true },
          })
        ).passwordHash,
      },
    });
    const { token } = await registerTestDevice(semTecnico.id);
    const c = await cenario();

    const res = await networkRoute(
      fieldRequest(`/api/field/v1/service-orders/${c.orderId}/network`, {
        token,
      }),
      { params: { id: c.orderId } },
    );
    expect(res.status).toBe(401);
  });

  it("F-A11 técnico inativo é recusado na escrita e mantém a leitura", async () => {
    const cto = await novaCto("CX-FA11");
    const c = await cenario();
    await prisma.technician.update({
      where: { id: technicianA.id },
      data: { active: false },
    });

    const escrita = await connectRoute(
      post(`/api/field/v1/service-orders/${c.orderId}/network/connect`, {
        expectedVersion: c.version,
        ctoPortId: (await porta(cto.id, 1)).id,
      }, tokenA),
      { params: { id: c.orderId } },
    );
    expect(escrita.status).toBe(403);

    const leitura = await networkRoute(
      fieldRequest(`/api/field/v1/service-orders/${c.orderId}/network`, {
        token: tokenA,
      }),
      { params: { id: c.orderId } },
    );
    expect(leitura.status).toBe(200);
  });

  it("F-A12 sessão válida em OS concluída não escreve", async () => {
    const cto = await novaCto("CX-FA12");
    const c = await cenario();
    await prisma.serviceOrder.update({
      where: { id: c.orderId },
      data: { status: "COMPLETED", completedAt: new Date() },
    });

    const res = await moveRoute(
      post(`/api/field/v1/service-orders/${c.orderId}/network/move`, {
        expectedVersion: await versaoDe(c.orderId),
        expectedConnectionId: "qualquer",
        targetCtoPortId: (await porta(cto.id, 1)).id,
      }, tokenA),
      { params: { id: c.orderId } },
    );
    expect(res.status).toBe(409);
    expect((await eventos(c.orderId)).map((e) => e.event)).not.toContain(
      "CTO_PORT_MOVED",
    );
  });

  it("F-A14 leitura não enumera o vínculo de outro cliente", async () => {
    const cto = await novaCto("CX-FA14");
    const alheio = await novoCliente("Cliente Alheio");
    await connectCustomerToPort(webCtx, {
      customerId: alheio.id,
      ctoPortId: (await porta(cto.id, 1)).id,
    });
    const c = await cenario();

    const res = await networkRoute(
      fieldRequest(`/api/field/v1/service-orders/${c.orderId}/network`, {
        token: tokenA,
      }),
      { params: { id: c.orderId } },
    );
    expect((await corpo(res)).data).toEqual({ connection: null });
  });

  it("F-A18 identificador malformado é 400, nunca 500", async () => {
    /*
      Nasceu de um achado real desta fase: uma string com byte NUL atravessava
      `z.string().min(1)`, chegava ao Postgres e voltava `22021`, que a
      fronteira traduzia em `INTERNAL`. E `INTERNAL` é RETENTÁVEL — o
      aplicativo reenviaria em laço uma requisição que nunca teria como dar
      certo.

      A classe é maior que esta fase: qualquer rota que leve string do cliente
      para um `where` do Prisma tem o mesmo comportamento. O que este teste
      guarda é a fronteira nova.
    */
    const c = await cenario();
    const hostis = [
      String.fromCharCode(0),
      "' OR 1=1 --",
      "../../etc/passwd",
      "<script>alert(1)</script>",
      "x".repeat(500),
    ];

    for (const valor of hostis) {
      const res = await connectRoute(
        post(`/api/field/v1/service-orders/${c.orderId}/network/connect`, {
          expectedVersion: c.version,
          ctoPortId: valor,
        }, tokenA),
        { params: { id: c.orderId } },
      );
      expect(res.status).toBe(400);
      const body = await corpo(res);
      // VALIDATION_ERROR não é retentável; INTERNAL seria.
      expect(body.error?.code).toBe("VALIDATION_ERROR");
    }
    expect(await ativos({ companyId: fixture.companyA.id })).toBe(0);
  });

  it("F-A19 erro nenhum devolve stack, SQL ou nome de tabela", async () => {
    const c = await cenario();
    const respostas = [
      await connectRoute(
        post(`/api/field/v1/service-orders/${c.orderId}/network/connect`, {
          expectedVersion: c.version,
          ctoPortId: "inexistente",
        }, tokenA),
        { params: { id: c.orderId } },
      ),
      await disconnectRoute(
        post(`/api/field/v1/service-orders/${c.orderId}/network/disconnect`, {
          expectedVersion: c.version,
          expectedConnectionId: "inexistente",
        }, tokenA),
        { params: { id: c.orderId } },
      ),
      await ctoDetailRoute(
        fieldRequest(
          `/api/field/v1/service-orders/${c.orderId}/network/ctos/inexistente`,
          { token: tokenA },
        ),
        { params: { id: c.orderId, ctoId: "inexistente" } },
      ),
    ];
    for (const res of respostas) {
      const texto = await res.text();
      for (const proibido of [
        "at Object",
        "node_modules",
        "SELECT",
        "customer_network_connections",
        "cto_ports",
        "prisma",
      ]) {
        expect(texto).not.toContain(proibido);
      }
    }
  });

  it("F-A15 sem sessão, toda a superfície responde 401", async () => {
    const c = await cenario();
    const semToken = [
      networkRoute(
        fieldRequest(`/api/field/v1/service-orders/${c.orderId}/network`),
        { params: { id: c.orderId } },
      ),
      ctosRoute(
        fieldRequest(`/api/field/v1/service-orders/${c.orderId}/network/ctos`),
        { params: { id: c.orderId } },
      ),
      connectRoute(
        fieldRequest(
          `/api/field/v1/service-orders/${c.orderId}/network/connect`,
          {
            method: "POST",
            body: { expectedVersion: c.version, ctoPortId: "x" },
            idempotencyKey: novaChave(),
          },
        ),
        { params: { id: c.orderId } },
      ),
    ];
    for (const res of await Promise.all(semToken)) {
      expect(res.status).toBe(401);
    }
  });

  it("F-A16 com a capability desligada a superfície inteira é 404", async () => {
    const cto = await novaCto("CX-FA16");
    const c = await cenario();
    await prisma.company.update({
      where: { id: fixture.companyA.id },
      data: { ctoNetworkEnabled: false },
    });

    const respostas = await Promise.all([
      networkRoute(
        fieldRequest(`/api/field/v1/service-orders/${c.orderId}/network`, {
          token: tokenA,
        }),
        { params: { id: c.orderId } },
      ),
      ctosRoute(
        fieldRequest(`/api/field/v1/service-orders/${c.orderId}/network/ctos`, {
          token: tokenA,
        }),
        { params: { id: c.orderId } },
      ),
      connectRoute(
        post(`/api/field/v1/service-orders/${c.orderId}/network/connect`, {
          expectedVersion: c.version,
          ctoPortId: (await porta(cto.id, 1)).id,
        }, tokenA),
        { params: { id: c.orderId } },
      ),
    ]);

    for (const res of respostas) {
      expect(res.status).toBe(404);
    }
    // Nem reserva de idempotência foi gravada para uma empresa sem o módulo.
    expect(await prisma.idempotencyRecord.count()).toBe(0);
  });

  it("F-A17 o técnico não alcança a API administrativa", async () => {
    const { POST: adminConnect } = await import(
      "@/app/api/cto-connections/route"
    );
    const sessao = await createTokenFor(fixture.techA.id);
    const cto = await novaCto("CX-FA17");
    const c = await cenario();

    const res = await adminConnect(
      new Request("http://localhost/api/cto-connections", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost",
          "Idempotency-Key": novaChave(),
          Cookie: `alfaos_session=${encodeURIComponent(sessao)}`,
        },
        body: JSON.stringify({
          customerId: c.customerId,
          ctoPortId: (await porta(cto.id, 1)).id,
        }),
      }),
    );

    expect(res.status).toBe(403);
    expect(await ativos({ customerId: c.customerId })).toBe(0);
  });
});
