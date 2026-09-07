import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  connectCustomerToPort,
  disconnectCustomer,
  findActiveConnectionForCustomer,
  findActiveConnectionForPort,
  findOccupiedPortIds,
  listConnectionHistory,
  moveCustomerToPort,
  type ConnectionContext,
  type ConnectionProvenance,
} from "@/lib/cto-connections";
import { changeCtoCapacity, createCto, setCtoActive, setPortAdministrativeState } from "@/lib/cto";
import { seedTestData, type TestFixture } from "./helpers";

/**
 * # `CTO-2.1` — o vínculo cliente ↔ porta
 *
 * Pelo DOMÍNIO, que é tudo o que existe nesta fase: não há rota, tela nem Field.
 *
 * O que estes testes protegem, acima de tudo, é o **histórico**. Todo o resto da
 * capability existe para responder "quem esteve nesta porta, e quando" — e a
 * forma mais fácil de destruir isso é um `UPDATE` que parece inofensivo.
 */

let fixture: TestFixture;
let webCtx: ConnectionContext;

beforeEach(async () => {
  fixture = await seedTestData();
  await prisma.company.updateMany({
    where: { id: { in: [fixture.companyA.id, fixture.companyB.id] } },
    data: { ctoNetworkEnabled: true },
  });
  // A fixture cria o USUÁRIO técnico; a linha `Technician` é de quem precisa
  // dela, como em `field-device-admin`.
  await prisma.technician.create({
    data: { companyId: fixture.companyA.id, userId: fixture.techA.id },
  });
  webCtx = {
    companyId: fixture.companyA.id,
    provenance: { source: "WEB", actorUserId: fixture.adminA.id },
  };
});

// --- ajudantes --------------------------------------------------------------

async function novaCto(nome: string, capacidade = 8, companyId?: string) {
  const empresa = companyId ?? fixture.companyA.id;
  const ator = empresa === fixture.companyA.id ? fixture.adminA.id : fixture.adminB.id;
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

/** O `Technician` da empresa A. `fixture.techA.id` é o USER — não o técnico. */
async function tecnicoA() {
  return prisma.technician.findFirstOrThrow({ where: { userId: fixture.techA.id } });
}

/** Uma OS `IN_PROGRESS` do técnico da empresa A, para a procedência FIELD. */
async function osEmAndamento(customerId: string) {
  const contador = await prisma.serviceOrder.count({
    where: { companyId: fixture.companyA.id },
  });
  return prisma.serviceOrder.create({
    data: {
      companyId: fixture.companyA.id,
      number: 9000 + contador,
      customerId,
      technicianId: (await tecnicoA()).id,
      type: "INSTALACAO",
      description: "visita de teste",
      status: "IN_PROGRESS",
      startedAt: new Date(),
    },
  });
}

async function fieldCtx(customerId: string): Promise<ConnectionContext> {
  const os = await osEmAndamento(customerId);
  const tecnico = await tecnicoA();
  return {
    companyId: fixture.companyA.id,
    provenance: {
      source: "FIELD",
      actorUserId: fixture.techA.id,
      technicianId: tecnico.id,
      serviceOrderId: os.id,
    },
  };
}

async function ativasDoCliente(customerId: string) {
  return prisma.customerNetworkConnection.count({
    where: { customerId, disconnectedAt: null },
  });
}

async function ativasDaPorta(ctoPortId: string) {
  return prisma.customerNetworkConnection.count({
    where: { ctoPortId, disconnectedAt: null },
  });
}

async function auditoria(action: string) {
  return prisma.auditLog.count({
    where: { companyId: fixture.companyA.id, action },
  });
}

// ---------------------------------------------------------------------------

describe("CN · procedência", () => {
  it("CN-01 — WEB conecta, sem OS e sem técnico", async () => {
    const cto = await novaCto("A16");
    const p1 = await porta(cto.id, 1);
    const cliente = await novoCliente("Ana");

    const conexao = await connectCustomerToPort(webCtx, {
      customerId: cliente.id,
      ctoPortId: p1.id,
    });

    expect(conexao.disconnectedAt).toBeNull();
    expect(conexao.source).toBe("WEB");
    expect(conexao.serviceOrderId).toBeNull();
    expect(conexao.technicianId).toBeNull();
    expect(conexao.portNumber).toBe(1);
  });

  it("CN-02 — FIELD conecta carregando OS e técnico", async () => {
    const cto = await novaCto("A16");
    const p1 = await porta(cto.id, 1);
    const cliente = await novoCliente("Bruno");
    const ctx = await fieldCtx(cliente.id);

    const conexao = await connectCustomerToPort(ctx, {
      customerId: cliente.id,
      ctoPortId: p1.id,
    });

    expect(conexao.source).toBe("FIELD");
    expect(conexao.technicianId).toBe((await tecnicoA()).id);
    expect(conexao.serviceOrderId).not.toBeNull();
  });

  it("CN-03 / CN-04 — FIELD sem OS ou sem técnico é recusada", async () => {
    const cto = await novaCto("A16");
    const p1 = await porta(cto.id, 1);
    const cliente = await novoCliente("Carla");

    const semOs = {
      companyId: fixture.companyA.id,
      provenance: {
        source: "FIELD",
        actorUserId: fixture.techA.id,
        technicianId: "algum",
        serviceOrderId: "",
      } as ConnectionProvenance,
    };
    await expect(
      connectCustomerToPort(semOs, { customerId: cliente.id, ctoPortId: p1.id }),
    ).rejects.toMatchObject({ status: 400 });

    const semTecnico = {
      companyId: fixture.companyA.id,
      provenance: {
        source: "FIELD",
        actorUserId: fixture.techA.id,
        technicianId: "",
        serviceOrderId: "x",
      } as ConnectionProvenance,
    };
    await expect(
      connectCustomerToPort(semTecnico, {
        customerId: cliente.id,
        ctoPortId: p1.id,
      }),
    ).rejects.toMatchObject({ status: 400 });

    expect(await ativasDaPorta(p1.id)).toBe(0);
  });

  it("CN-05 — WEB com técnico ou OS inventados é recusada", async () => {
    const cto = await novaCto("A16");
    const p1 = await porta(cto.id, 1);
    const cliente = await novoCliente("Diego");
    const os = await osEmAndamento(cliente.id);

    /*
      O tipo discriminado já impede isto em compilação. O teste ataca o que
      atravessa a fronteira do TypeScript: um JSON de fora, um cast, uma rota
      futura montada errado.
    */
    const forjado = {
      companyId: fixture.companyA.id,
      provenance: {
        source: "WEB",
        actorUserId: fixture.adminA.id,
        technicianId: "algum",
        serviceOrderId: os.id,
      } as unknown as ConnectionProvenance,
    };
    await expect(
      connectCustomerToPort(forjado, {
        customerId: cliente.id,
        ctoPortId: p1.id,
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(await ativasDaPorta(p1.id)).toBe(0);
  });
});

describe("CN · elegibilidade da porta", () => {
  it("CN-06 — CTO inativa não recebe conexão", async () => {
    const cto = await novaCto("A16");
    const p1 = await porta(cto.id, 1);
    const cliente = await novoCliente("Eva");
    await setCtoActive(fixture.companyA.id, fixture.adminA.id, cto.id, false);

    await expect(
      connectCustomerToPort(webCtx, {
        customerId: cliente.id,
        ctoPortId: p1.id,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await ativasDaPorta(p1.id)).toBe(0);
  });

  it("CN-07 — porta fora da capacidade não recebe conexão", async () => {
    const cto = await novaCto("A16", 16);
    await changeCtoCapacity(fixture.companyA.id, fixture.adminA.id, cto.id, 8);
    const historica = await porta(cto.id, 12);
    const cliente = await novoCliente("Fábio");

    // Ela está AVAILABLE — a recusa é da FAIXA, e não do estado.
    expect(historica.administrativeState).toBe("AVAILABLE");
    await expect(
      connectCustomerToPort(webCtx, {
        customerId: cliente.id,
        ctoPortId: historica.id,
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("CN-08 / CN-09 — RESERVED e DAMAGED não recebem conexão", async () => {
    const cto = await novaCto("A16");
    const reservada = await porta(cto.id, 1);
    const danificada = await porta(cto.id, 2);
    await setPortAdministrativeState(
      fixture.companyA.id, fixture.adminA.id, cto.id, reservada.id, "RESERVED",
    );
    await setPortAdministrativeState(
      fixture.companyA.id, fixture.adminA.id, cto.id, danificada.id, "DAMAGED",
    );
    const cliente = await novoCliente("Gina");

    await expect(
      connectCustomerToPort(webCtx, { customerId: cliente.id, ctoPortId: reservada.id }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      connectCustomerToPort(webCtx, { customerId: cliente.id, ctoPortId: danificada.id }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("CN-25 — a porta conectada continua AVAILABLE, e não vira OCCUPIED", async () => {
    const cto = await novaCto("A16");
    const p1 = await porta(cto.id, 1);
    const cliente = await novoCliente("Hugo");
    await connectCustomerToPort(webCtx, { customerId: cliente.id, ctoPortId: p1.id });

    const depois = await prisma.cTOPort.findUniqueOrThrow({ where: { id: p1.id } });
    expect(depois.administrativeState).toBe("AVAILABLE");
    // A ocupação existe, e vem da conexão — não da coluna.
    expect(await findActiveConnectionForPort(fixture.companyA.id, p1.id)).not.toBeNull();
  });
});

describe("CN · unicidade do vínculo ativo", () => {
  it("CN-10 — dois clientes na mesma porta: o segundo é recusado", async () => {
    const cto = await novaCto("A16");
    const p1 = await porta(cto.id, 1);
    const a = await novoCliente("Ana");
    const b = await novoCliente("Beto");

    await connectCustomerToPort(webCtx, { customerId: a.id, ctoPortId: p1.id });
    await expect(
      connectCustomerToPort(webCtx, { customerId: b.id, ctoPortId: p1.id }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await ativasDaPorta(p1.id)).toBe(1);
  });

  it("CN-11 — o mesmo cliente em duas portas: a segunda é recusada", async () => {
    const cto = await novaCto("A16");
    const p1 = await porta(cto.id, 1);
    const p2 = await porta(cto.id, 2);
    const cliente = await novoCliente("Ivo");

    await connectCustomerToPort(webCtx, { customerId: cliente.id, ctoPortId: p1.id });
    await expect(
      connectCustomerToPort(webCtx, { customerId: cliente.id, ctoPortId: p2.id }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await ativasDoCliente(cliente.id)).toBe(1);
  });
});

describe("CN · história", () => {
  it("CN-12 — desconectar FECHA a linha e não apaga nada", async () => {
    const cto = await novaCto("A16");
    const p1 = await porta(cto.id, 1);
    const cliente = await novoCliente("Joana");
    const aberta = await connectCustomerToPort(webCtx, {
      customerId: cliente.id, ctoPortId: p1.id,
    });

    const fechada = await disconnectCustomer(webCtx, {
      customerId: cliente.id, reason: "mudança de endereço",
    });

    expect(fechada.id).toBe(aberta.id);
    expect(fechada.disconnectedAt).not.toBeNull();
    expect(fechada.reason).toBe("mudança de endereço");
    // A LINHA continua lá, e continua apontando para a porta original.
    const linha = await prisma.customerNetworkConnection.findUniqueOrThrow({
      where: { id: aberta.id },
    });
    expect(linha.ctoPortId).toBe(p1.id);
    expect(await prisma.customerNetworkConnection.count({ where: { customerId: cliente.id } })).toBe(1);
  });

  it("CN-12b — desconectar sem vínculo ativo é conflito, não sucesso mudo", async () => {
    const cliente = await novoCliente("Kléber");
    await expect(
      disconnectCustomer(webCtx, { customerId: cliente.id }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("CN-12c — desconectar de novo NÃO fecha uma linha histórica por acidente", async () => {
    const cto = await novaCto("A16");
    const p1 = await porta(cto.id, 1);
    const cliente = await novoCliente("Lia");
    const primeira = await connectCustomerToPort(webCtx, {
      customerId: cliente.id, ctoPortId: p1.id,
    });
    await disconnectCustomer(webCtx, { customerId: cliente.id });
    const carimbo = (
      await prisma.customerNetworkConnection.findUniqueOrThrow({ where: { id: primeira.id } })
    ).disconnectedAt;

    await expect(
      disconnectCustomer(webCtx, { customerId: cliente.id }),
    ).rejects.toMatchObject({ status: 409 });

    const depois = await prisma.customerNetworkConnection.findUniqueOrThrow({
      where: { id: primeira.id },
    });
    expect(depois.disconnectedAt?.getTime()).toBe(carimbo?.getTime());
  });

  it("CN-13 — reconectar cria linha NOVA; a antiga não reabre", async () => {
    const cto = await novaCto("A16");
    const p1 = await porta(cto.id, 1);
    const cliente = await novoCliente("Marcos");
    const antiga = await connectCustomerToPort(webCtx, {
      customerId: cliente.id, ctoPortId: p1.id,
    });
    await disconnectCustomer(webCtx, { customerId: cliente.id });

    const nova = await connectCustomerToPort(webCtx, {
      customerId: cliente.id, ctoPortId: p1.id,
    });

    expect(nova.id).not.toBe(antiga.id);
    expect(nova.disconnectedAt).toBeNull();
    const reconferida = await prisma.customerNetworkConnection.findUniqueOrThrow({
      where: { id: antiga.id },
    });
    expect(reconferida.disconnectedAt).not.toBeNull();
    expect(await prisma.customerNetworkConnection.count({ where: { customerId: cliente.id } })).toBe(2);
    expect(await ativasDoCliente(cliente.id)).toBe(1);
  });

  it("CN-14 — mover fecha a antiga e abre a nova, sem tocar a porta antiga", async () => {
    const cto = await novaCto("A16");
    const p1 = await porta(cto.id, 1);
    const p2 = await porta(cto.id, 2);
    const cliente = await novoCliente("Nara");
    const antes = await connectCustomerToPort(webCtx, {
      customerId: cliente.id, ctoPortId: p1.id,
    });

    const r = await moveCustomerToPort(webCtx, {
      customerId: cliente.id, targetCtoPortId: p2.id,
    });

    expect(r.from.id).toBe(antes.id);
    expect(r.from.disconnectedAt).not.toBeNull();
    expect(r.to.id).not.toBe(antes.id);
    expect(r.to.disconnectedAt).toBeNull();
    // O ponto: a linha antiga continua apontando para a porta ANTIGA.
    const historica = await prisma.customerNetworkConnection.findUniqueOrThrow({
      where: { id: antes.id },
    });
    expect(historica.ctoPortId).toBe(p1.id);
    expect(await ativasDaPorta(p1.id)).toBe(0);
    expect(await ativasDaPorta(p2.id)).toBe(1);
  });

  it("CN-14b — mover para a MESMA porta é recusado, sem auditoria falsa", async () => {
    const cto = await novaCto("A16");
    const p1 = await porta(cto.id, 1);
    const cliente = await novoCliente("Otávio");
    await connectCustomerToPort(webCtx, { customerId: cliente.id, ctoPortId: p1.id });
    const auditAntes = await auditoria("CTO_CONNECTION.MOVED");

    await expect(
      moveCustomerToPort(webCtx, { customerId: cliente.id, targetCtoPortId: p1.id }),
    ).rejects.toMatchObject({ status: 409 });

    expect(await auditoria("CTO_CONNECTION.MOVED")).toBe(auditAntes);
    expect(await prisma.customerNetworkConnection.count({ where: { customerId: cliente.id } })).toBe(1);
  });

  it("CN-15 — mover entre CTOs diferentes da mesma empresa", async () => {
    const a = await novaCto("CTO-A");
    const b = await novaCto("CTO-B");
    const pa = await porta(a.id, 1);
    const pb = await porta(b.id, 3);
    const cliente = await novoCliente("Paula");
    await connectCustomerToPort(webCtx, { customerId: cliente.id, ctoPortId: pa.id });

    const r = await moveCustomerToPort(webCtx, {
      customerId: cliente.id, targetCtoPortId: pb.id,
    });

    expect(r.to.ctoId).toBe(b.id);
    expect(r.to.portNumber).toBe(3);
    expect(await ativasDaPorta(pa.id)).toBe(0);
    expect(await ativasDaPorta(pb.id)).toBe(1);
  });

  it("CN-16 / CN-17 — sai de CTO inativa, mas não entra numa", async () => {
    const origem = await novaCto("ORIGEM");
    const destino = await novaCto("DESTINO");
    const po = await porta(origem.id, 1);
    const pd = await porta(destino.id, 1);
    const cliente = await novoCliente("Rita");
    await connectCustomerToPort(webCtx, { customerId: cliente.id, ctoPortId: po.id });

    // A origem é desativada com o cliente dentro: desativar não pode prender.
    await setCtoActive(fixture.companyA.id, fixture.adminA.id, origem.id, false);
    const r = await moveCustomerToPort(webCtx, {
      customerId: cliente.id, targetCtoPortId: pd.id,
    });
    expect(r.to.ctoId).toBe(destino.id);

    // E o caminho inverso é recusado.
    await setCtoActive(fixture.companyA.id, fixture.adminA.id, destino.id, true);
    await setCtoActive(fixture.companyA.id, fixture.adminA.id, origem.id, false);
    await expect(
      moveCustomerToPort(webCtx, { customerId: cliente.id, targetCtoPortId: po.id }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("CN-16b — desconectar funciona numa CTO inativa", async () => {
    const cto = await novaCto("A16");
    const p1 = await porta(cto.id, 1);
    const cliente = await novoCliente("Sara");
    await connectCustomerToPort(webCtx, { customerId: cliente.id, ctoPortId: p1.id });
    await setCtoActive(fixture.companyA.id, fixture.adminA.id, cto.id, false);

    const fechada = await disconnectCustomer(webCtx, { customerId: cliente.id });
    expect(fechada.disconnectedAt).not.toBeNull();
  });
});

describe("CN · tenancy", () => {
  it("CN-18 — cliente de outro tenant não é alcançável", async () => {
    const cto = await novaCto("A16");
    const p1 = await porta(cto.id, 1);
    const daB = await novoCliente("Cliente da B", fixture.companyB.id);

    await expect(
      connectCustomerToPort(webCtx, { customerId: daB.id, ctoPortId: p1.id }),
    ).rejects.toMatchObject({ status: 404 });
    expect(await ativasDaPorta(p1.id)).toBe(0);
  });

  it("CN-18b — porta de outro tenant não é alcançável", async () => {
    const daB = await novaCto("CTO da B", 8, fixture.companyB.id);
    const portaB = await porta(daB.id, 1);
    const cliente = await novoCliente("Tadeu");

    await expect(
      connectCustomerToPort(webCtx, { customerId: cliente.id, ctoPortId: portaB.id }),
    ).rejects.toMatchObject({ status: 404 });
    expect(await ativasDaPorta(portaB.id)).toBe(0);
  });

  it("CN-19 — a porta precisa pertencer à CTO resolvida, e o tenant vem do contexto", async () => {
    /*
      Controle POSITIVO junto: sem ele, o 404 acima poderia estar passando por
      qualquer motivo — inclusive por a porta não existir.
    */
    const cto = await novaCto("A16");
    const p1 = await porta(cto.id, 1);
    const cliente = await novoCliente("Ubirajara");
    const ok = await connectCustomerToPort(webCtx, {
      customerId: cliente.id, ctoPortId: p1.id,
    });
    expect(ok.ctoId).toBe(cto.id);

    // O mesmo id de porta, lido pelo contexto da empresa B: inexistente.
    const ctxB: ConnectionContext = {
      companyId: fixture.companyB.id,
      provenance: { source: "WEB", actorUserId: fixture.adminB.id },
    };
    const outro = await novoCliente("Da B", fixture.companyB.id);
    await expect(
      connectCustomerToPort(ctxB, { customerId: outro.id, ctoPortId: p1.id }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("CN · auditoria e timeline", () => {
  it("CN-20 / CN-21 / CN-22 — as três operações auditam", async () => {
    const cto = await novaCto("A16");
    const p1 = await porta(cto.id, 1);
    const p2 = await porta(cto.id, 2);
    const cliente = await novoCliente("Vera");

    await connectCustomerToPort(webCtx, { customerId: cliente.id, ctoPortId: p1.id });
    expect(await auditoria("CTO_CONNECTION.CONNECTED")).toBe(1);

    await moveCustomerToPort(webCtx, { customerId: cliente.id, targetCtoPortId: p2.id });
    expect(await auditoria("CTO_CONNECTION.MOVED")).toBe(1);

    await disconnectCustomer(webCtx, { customerId: cliente.id });
    expect(await auditoria("CTO_CONNECTION.DISCONNECTED")).toBe(1);

    const registros = await prisma.auditLog.findMany({
      where: { companyId: fixture.companyA.id, action: { startsWith: "CTO_CONNECTION." } },
    });
    for (const r of registros) {
      expect(r.userId).toBe(fixture.adminA.id);
      expect(r.entity).toBe("CustomerNetworkConnection");
      expect(r.details).not.toContain(fixture.companyA.id);
    }
  });

  it("CN-23 — FIELD grava evento na timeline da OS", async () => {
    const cto = await novaCto("A16");
    const p1 = await porta(cto.id, 1);
    const p2 = await porta(cto.id, 2);
    const cliente = await novoCliente("Wanda");
    const ctx = await fieldCtx(cliente.id);
    const osId = (ctx.provenance as { serviceOrderId: string }).serviceOrderId;

    await connectCustomerToPort(ctx, { customerId: cliente.id, ctoPortId: p1.id });
    await moveCustomerToPort(ctx, { customerId: cliente.id, targetCtoPortId: p2.id });
    await disconnectCustomer(ctx, { customerId: cliente.id });

    const eventos = await prisma.serviceOrderEvent.findMany({
      where: { serviceOrderId: osId, event: { startsWith: "CTO_PORT_" } },
      orderBy: { createdAt: "asc" },
    });
    expect(eventos.map((e) => e.event)).toEqual([
      "CTO_PORT_CONNECTED",
      "CTO_PORT_MOVED",
      "CTO_PORT_DISCONNECTED",
    ]);
    // A OS não muda de estado por causa disto: é narrativa, não transição.
    const os = await prisma.serviceOrder.findUniqueOrThrow({ where: { id: osId } });
    expect(os.status).toBe("IN_PROGRESS");
  });

  it("CN-24 — WEB não inventa visita: audita e não gera evento", async () => {
    const cto = await novaCto("A16");
    const p1 = await porta(cto.id, 1);
    const cliente = await novoCliente("Xuxa");

    await connectCustomerToPort(webCtx, { customerId: cliente.id, ctoPortId: p1.id });

    expect(await auditoria("CTO_CONNECTION.CONNECTED")).toBe(1);
    expect(
      await prisma.serviceOrderEvent.count({
        where: { companyId: fixture.companyA.id, event: { startsWith: "CTO_PORT_" } },
      }),
    ).toBe(0);
  });
});

describe("CN · estrutura", () => {
  it("CN-26 — nem OCCUPIED gravável, nem isOccupied, nem version", async () => {
    const colunas = await prisma.$queryRawUnsafe<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'customer_network_connections'`,
    );
    const nomes = colunas.map((c) => c.column_name).sort();
    expect(nomes).toEqual([
      "companyId", "connectedAt", "createdAt", "ctoPortId", "customerId",
      "disconnectedAt", "id", "reason", "serviceOrderId", "source", "technicianId",
    ]);
    expect(nomes).not.toContain("version");
    expect(nomes).not.toContain("updatedAt");
    expect(nomes).not.toContain("isOccupied");
    expect(nomes).not.toContain("equipmentId");

    const enums = await prisma.$queryRawUnsafe<{ enumlabel: string }[]>(
      `SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = 'CtoPortAdministrativeState'`,
    );
    expect(enums.map((e) => e.enumlabel).sort()).toEqual([
      "AVAILABLE", "DAMAGED", "RESERVED",
    ]);

    const portas = await prisma.$queryRawUnsafe<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'cto_ports'`,
    );
    const nomesPorta = portas.map((c) => c.column_name);
    expect(nomesPorta).not.toContain("isOccupied");
    expect(nomesPorta).not.toContain("effectiveState");
  });

  it("CN-27 / CN-28 — os índices parciais existem e BLOQUEIAM no banco", async () => {
    const cto = await novaCto("A16");
    const p1 = await porta(cto.id, 1);
    const p2 = await porta(cto.id, 2);
    const a = await novoCliente("Ana");
    const b = await novoCliente("Beto");
    const base = {
      companyId: fixture.companyA.id,
      connectedAt: new Date(),
      source: "WEB" as const,
    };

    await prisma.customerNetworkConnection.create({
      data: { ...base, customerId: a.id, ctoPortId: p1.id },
    });

    /*
      INSERT DIRETO, sem passar pelo serviço: é o que prova que a barreira é do
      BANCO. Um pré-check em código de aplicação não apareceria aqui.
    */
    await expect(
      prisma.customerNetworkConnection.create({
        data: { ...base, customerId: b.id, ctoPortId: p1.id },
      }),
    ).rejects.toMatchObject({ code: "P2002" });

    await expect(
      prisma.customerNetworkConnection.create({
        data: { ...base, customerId: a.id, ctoPortId: p2.id },
      }),
    ).rejects.toMatchObject({ code: "P2002" });

    // Fechada a primeira, as duas passam a ser permitidas: a unique é PARCIAL.
    await prisma.customerNetworkConnection.updateMany({
      where: { customerId: a.id, disconnectedAt: null },
      data: { disconnectedAt: new Date() },
    });
    await prisma.customerNetworkConnection.create({
      data: { ...base, customerId: b.id, ctoPortId: p1.id },
    });
    await prisma.customerNetworkConnection.create({
      data: { ...base, customerId: a.id, ctoPortId: p2.id },
    });

    const indices = await prisma.$queryRawUnsafe<{ indexname: string }[]>(
      `SELECT indexname FROM pg_indexes
       WHERE tablename = 'customer_network_connections' AND indexdef LIKE '%disconnectedAt%'`,
    );
    expect(indices.map((i) => i.indexname).sort()).toEqual([
      "customer_network_connections_active_customer_key",
      "customer_network_connections_active_port_key",
    ]);
  });

  it("CN-29 — o MOVE volta INTEIRO quando o destino é recusado", async () => {
    const cto = await novaCto("A16");
    const p1 = await porta(cto.id, 1);
    const p2 = await porta(cto.id, 2);
    const cliente = await novoCliente("Yara");
    const outro = await novoCliente("Zeca");
    const aberta = await connectCustomerToPort(webCtx, {
      customerId: cliente.id, ctoPortId: p1.id,
    });
    // O destino é ocupado por outra pessoa: o move tem de falhar por inteiro.
    await connectCustomerToPort(webCtx, { customerId: outro.id, ctoPortId: p2.id });

    await expect(
      moveCustomerToPort(webCtx, { customerId: cliente.id, targetCtoPortId: p2.id }),
    ).rejects.toMatchObject({ status: 409 });

    // Nada de "fechou a antiga e não abriu a nova".
    const linha = await prisma.customerNetworkConnection.findUniqueOrThrow({
      where: { id: aberta.id },
    });
    expect(linha.disconnectedAt).toBeNull();
    expect(await ativasDoCliente(cliente.id)).toBe(1);
    expect(await auditoria("CTO_CONNECTION.MOVED")).toBe(0);
  });

  it("CN-30 — o MOVE entre CTOs trava as duas caixas, em ordem de id", async () => {
    /*
      A ordem é observável pelo EFEITO: dois moves cruzados entre as mesmas duas
      CTOs, disparados juntos, não podem se travar mutuamente. Se cada operação
      travasse na ordem em que descobriu as caixas, este par seria o deadlock
      clássico A→B / B→A.

      RODA VÁRIAS VEZES, e isso não é excesso de zelo: a primeira versão deste
      teste fazia UMA rodada e deixou passar a sabotagem que remove a ordenação.
      Medido depois: sem `sort()`, 19 de 20 rodadas produzem deadlock — a
      rodada única caiu justamente na vigésima.
    */
    for (let i = 0; i < 6; i += 1) {
      const a = await novaCto(`CTO-A${i}`);
      const b = await novaCto(`CTO-B${i}`);
      const pa1 = await porta(a.id, 1);
      const pa2 = await porta(a.id, 2);
      const pb1 = await porta(b.id, 1);
      const pb2 = await porta(b.id, 2);
      const um = await novoCliente(`Um${i}`);
      const dois = await novoCliente(`Dois${i}`);
      await connectCustomerToPort(webCtx, { customerId: um.id, ctoPortId: pa1.id });
      await connectCustomerToPort(webCtx, { customerId: dois.id, ctoPortId: pb1.id });

      const r = await Promise.allSettled([
        moveCustomerToPort(webCtx, { customerId: um.id, targetCtoPortId: pb2.id }),
        moveCustomerToPort(webCtx, { customerId: dois.id, targetCtoPortId: pa2.id }),
      ]);

      for (const x of r) {
        if (x.status === "rejected") {
          expect(
            String((x.reason as Error)?.message ?? x.reason),
            `rodada ${i}`,
          ).not.toMatch(/deadlock/i);
        }
      }
      // Clientes e portas distintos: as duas TÊM de concluir.
      expect(r.filter((x) => x.status === "fulfilled").length, `rodada ${i}`).toBe(2);
      expect(await ativasDoCliente(um.id)).toBe(1);
      expect(await ativasDoCliente(dois.id)).toBe(1);
    }
  });});

describe("CN · leitura interna", () => {
  it("as três consultas devolvem o estado derivado, sem coluna de ocupação", async () => {
    const cto = await novaCto("A16");
    const p1 = await porta(cto.id, 1);
    const p2 = await porta(cto.id, 2);
    const cliente = await novoCliente("Alfa");
    await connectCustomerToPort(webCtx, { customerId: cliente.id, ctoPortId: p1.id });
    await moveCustomerToPort(webCtx, { customerId: cliente.id, targetCtoPortId: p2.id });

    const ativa = await findActiveConnectionForCustomer(fixture.companyA.id, cliente.id);
    expect(ativa?.ctoPortId).toBe(p2.id);
    expect(await findActiveConnectionForPort(fixture.companyA.id, p1.id)).toBeNull();

    const ocupadas = await findOccupiedPortIds(fixture.companyA.id, cto.id);
    expect(ocupadas.has(p2.id)).toBe(true);
    expect(ocupadas.has(p1.id)).toBe(false);

    const historia = await listConnectionHistory(fixture.companyA.id, cliente.id);
    expect(historia.length).toBe(2);
    expect(historia[0].disconnectedAt).toBeNull();
    expect(historia[1].disconnectedAt).not.toBeNull();
  });

  it("a leitura interna não atravessa tenant", async () => {
    const cto = await novaCto("A16");
    const p1 = await porta(cto.id, 1);
    const cliente = await novoCliente("Beta");
    await connectCustomerToPort(webCtx, { customerId: cliente.id, ctoPortId: p1.id });

    expect(await findActiveConnectionForCustomer(fixture.companyB.id, cliente.id)).toBeNull();
    expect(await findActiveConnectionForPort(fixture.companyB.id, p1.id)).toBeNull();
    expect((await findOccupiedPortIds(fixture.companyB.id, cto.id)).size).toBe(0);
    expect((await listConnectionHistory(fixture.companyB.id, cliente.id)).length).toBe(0);
  });
});
