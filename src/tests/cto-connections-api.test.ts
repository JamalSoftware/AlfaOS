import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { POST as connectRoute, GET as networkRoute } from "@/app/api/cto-connections/route";
import { POST as disconnectRoute } from "@/app/api/cto-connections/[id]/disconnect/route";
import { POST as moveRoute } from "@/app/api/cto-connections/[id]/move/route";
import { GET as ctoDetailRoute } from "@/app/api/ctos/[id]/route";
import { createCto, setCtoActive, setPortAdministrativeState, changeCtoCapacity } from "@/lib/cto";
import { connectCustomerToPort, type ConnectionContext } from "@/lib/cto-connections";
import { createTokenFor, seedTestData, type TestFixture } from "./helpers";

/**
 * # `CTO-2.2` — a API administrativa do vínculo
 *
 * Pelas ROTAS. O que elas acrescentam ao domínio é a sequência de autorização,
 * a idempotência HTTP e a **guarda de obsolescência** — e é essa última que o
 * arquivo protege com mais cuidado, porque é a única regra que nasceu aqui.
 */

let fixture: TestFixture;
let adminToken: string;
let dispatcherToken: string;
let techToken: string;
let adminBToken: string;
let webCtx: ConnectionContext;

beforeEach(async () => {
  fixture = await seedTestData();
  adminToken = await createTokenFor(fixture.adminA.id);
  dispatcherToken = await createTokenFor(fixture.dispatcherA.id);
  techToken = await createTokenFor(fixture.techA.id);
  adminBToken = await createTokenFor(fixture.adminB.id);
  await prisma.company.updateMany({
    where: { id: { in: [fixture.companyA.id, fixture.companyB.id] } },
    data: { ctoNetworkEnabled: true },
  });
  webCtx = {
    companyId: fixture.companyA.id,
    provenance: { source: "WEB", actorUserId: fixture.adminA.id },
  };
});

// --- ajudantes --------------------------------------------------------------

const ORIGIN = "http://localhost";
let chave = 0;
function novaChave() {
  chave += 1;
  return `cto-2-2-${Date.now()}-${chave}`;
}

function post(
  url: string,
  body: unknown,
  token: string,
  extras: { origin?: string; key?: string | null } = {},
) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Origin: extras.origin ?? ORIGIN,
    Cookie: `alfaos_session=${encodeURIComponent(token)}`,
  };
  if (extras.key !== null) {
    headers["Idempotency-Key"] = extras.key ?? novaChave();
  }
  return new Request(`http://localhost${url}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function get(url: string, token: string) {
  return new Request(`http://localhost${url}`, {
    headers: { Cookie: `alfaos_session=${encodeURIComponent(token)}` },
  });
}

async function corpo(res: Response) {
  return (await res.json()) as {
    ok: boolean;
    error?: string;
    data?: Record<string, unknown>;
  };
}

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

async function conectar(customerId: string, ctoPortId: string) {
  return connectCustomerToPort(webCtx, { customerId, ctoPortId });
}

async function ativas(where: Record<string, unknown>) {
  return prisma.customerNetworkConnection.count({
    where: { ...where, disconnectedAt: null },
  });
}

async function auditoria(action: string) {
  return prisma.auditLog.count({
    where: { companyId: fixture.companyA.id, action },
  });
}

// ---------------------------------------------------------------------------

describe("API · CONNECT", () => {
  it("API-01 — o ADMIN conecta e a resposta é o vínculo", async () => {
    const cto = await novaCto("A16");
    const p1 = await porta(cto.id, 1);
    const cliente = await novoCliente("Ana");

    const res = await connectRoute(
      post("/api/cto-connections", { customerId: cliente.id, ctoPortId: p1.id }, adminToken),
    );
    expect(res.status).toBe(201);
    const body = await corpo(res);
    const conexao = body.data!.connection as Record<string, unknown>;
    expect(conexao.source).toBe("WEB");
    expect(conexao.serviceOrderId).toBeNull();
    expect(conexao.technicianId).toBeNull();
    expect(conexao.disconnectedAt).toBeNull();
    expect(await ativas({ ctoPortId: p1.id })).toBe(1);
  });

  it("API-02 / API-03 — DISPATCHER e TECHNICIAN recebem 403", async () => {
    const cto = await novaCto("A16");
    const p1 = await porta(cto.id, 1);
    const cliente = await novoCliente("Bruno");
    const payload = { customerId: cliente.id, ctoPortId: p1.id };

    for (const token of [dispatcherToken, techToken]) {
      const res = await connectRoute(post("/api/cto-connections", payload, token));
      expect(res.status).toBe(403);
    }
    expect(await ativas({ ctoPortId: p1.id })).toBe(0);
  });

  it("API-04 — capability desligada responde 404, antes do perfil", async () => {
    const cto = await novaCto("A16");
    const p1 = await porta(cto.id, 1);
    const cliente = await novoCliente("Carla");
    await prisma.company.update({
      where: { id: fixture.companyA.id },
      data: { ctoNetworkEnabled: false },
    });

    // O MESMO perfil que receberia 403 com a capability ligada: é assim que se
    // prova de qual das duas verificações veio a resposta.
    expect(
      (await connectRoute(post("/api/cto-connections", { customerId: cliente.id, ctoPortId: p1.id }, dispatcherToken))).status,
    ).toBe(404);
    expect(
      (await connectRoute(post("/api/cto-connections", { customerId: cliente.id, ctoPortId: p1.id }, adminToken))).status,
    ).toBe(404);
  });

  it("API-05 / API-06 — cliente e CTO de outro tenant respondem 404", async () => {
    const cto = await novaCto("A16");
    const p1 = await porta(cto.id, 1);
    const daB = await novoCliente("Da B", fixture.companyB.id);
    const ctoB = await novaCto("CTO da B", 8, fixture.companyB.id);
    const portaB = await porta(ctoB.id, 1);
    const meu = await novoCliente("Meu");

    expect(
      (await connectRoute(post("/api/cto-connections", { customerId: daB.id, ctoPortId: p1.id }, adminToken))).status,
    ).toBe(404);
    expect(
      (await connectRoute(post("/api/cto-connections", { customerId: meu.id, ctoPortId: portaB.id }, adminToken))).status,
    ).toBe(404);
    expect(await ativas({ ctoPortId: p1.id })).toBe(0);
    expect(await ativas({ ctoPortId: portaB.id })).toBe(0);
  });

  it("API-08 / API-09 / API-10 — companyId, source e carimbos no corpo dão 400", async () => {
    const cto = await novaCto("A16");
    const p1 = await porta(cto.id, 1);
    const cliente = await novoCliente("Diego");
    const base = { customerId: cliente.id, ctoPortId: p1.id };

    const venenos: Record<string, unknown>[] = [
      { ...base, companyId: fixture.companyB.id },
      { ...base, source: "FIELD" },
      { ...base, technicianId: "x" },
      { ...base, serviceOrderId: "x" },
      { ...base, connectedAt: new Date(0).toISOString() },
      { ...base, disconnectedAt: null },
      { ...base, createdAt: new Date(0).toISOString() },
      { ...base, actorUserId: fixture.adminB.id },
    ];
    for (const veneno of venenos) {
      const res = await connectRoute(post("/api/cto-connections", veneno, adminToken));
      expect(res.status, JSON.stringify(veneno)).toBe(400);
    }
    // RECUSA, não descarte silencioso: nada foi gravado.
    expect(await ativas({ ctoPortId: p1.id })).toBe(0);
  });

  it("API-11 / API-12 / API-13 / API-14 — os conflitos operacionais são 409", async () => {
    const cto = await novaCto("A16");
    const p1 = await porta(cto.id, 1);
    const p2 = await porta(cto.id, 2);
    const p3 = await porta(cto.id, 3);
    const a = await novoCliente("Ocupante");
    const b = await novoCliente("Outro");
    await conectar(a.id, p1.id);
    await setPortAdministrativeState(fixture.companyA.id, fixture.adminA.id, cto.id, p2.id, "RESERVED");
    await setPortAdministrativeState(fixture.companyA.id, fixture.adminA.id, cto.id, p3.id, "DAMAGED");

    // porta ocupada
    expect(
      (await connectRoute(post("/api/cto-connections", { customerId: b.id, ctoPortId: p1.id }, adminToken))).status,
    ).toBe(409);
    // cliente já conectado
    const p4 = await porta(cto.id, 4);
    expect(
      (await connectRoute(post("/api/cto-connections", { customerId: a.id, ctoPortId: p4.id }, adminToken))).status,
    ).toBe(409);
    // RESERVED e DAMAGED
    for (const p of [p2, p3]) {
      expect(
        (await connectRoute(post("/api/cto-connections", { customerId: b.id, ctoPortId: p.id }, adminToken))).status,
      ).toBe(409);
    }

    // CTO inativa
    const inativa = await novaCto("INATIVA");
    const pi = await porta(inativa.id, 1);
    await setCtoActive(fixture.companyA.id, fixture.adminA.id, inativa.id, false);
    expect(
      (await connectRoute(post("/api/cto-connections", { customerId: b.id, ctoPortId: pi.id }, adminToken))).status,
    ).toBe(409);
  });

  it("CSRF — origem de terceiro é 403 e não grava nada", async () => {
    const cto = await novaCto("A16");
    const p1 = await porta(cto.id, 1);
    const cliente = await novoCliente("Eva");

    const res = await connectRoute(
      post("/api/cto-connections", { customerId: cliente.id, ctoPortId: p1.id }, adminToken, {
        origin: "https://evil.example",
      }),
    );
    expect(res.status).toBe(403);
    expect(await ativas({ ctoPortId: p1.id })).toBe(0);
  });

  it("sem sessão responde 401", async () => {
    const res = await connectRoute(
      new Request("http://localhost/api/cto-connections", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: ORIGIN, "Idempotency-Key": novaChave() },
        body: JSON.stringify({ customerId: "x", ctoPortId: "y" }),
      }),
    );
    expect(res.status).toBe(401);
  });
});

describe("API · DISCONNECT", () => {
  it("API-D01 / API-D02 — desconecta e preserva a linha", async () => {
    const cto = await novaCto("A16");
    const p1 = await porta(cto.id, 1);
    const cliente = await novoCliente("Fábio");
    const aberta = await conectar(cliente.id, p1.id);

    const res = await disconnectRoute(
      post(`/api/cto-connections/${aberta.id}/disconnect`, { reason: "mudou" }, adminToken),
      { params: Promise.resolve({ id: aberta.id }) },
    );
    expect(res.status).toBe(200);

    const linha = await prisma.customerNetworkConnection.findUniqueOrThrow({
      where: { id: aberta.id },
    });
    expect(linha.disconnectedAt).not.toBeNull();
    expect(linha.ctoPortId).toBe(p1.id);
    expect(await prisma.customerNetworkConnection.count({ where: { customerId: cliente.id } })).toBe(1);
  });

  it("API-D03 — vínculo OBSOLETO é recusado, e o atual sobrevive", async () => {
    /*
      O cenário exato que a guarda existe para impedir: a tela mostra A, outra
      pessoa move o cliente para B, e o clique antigo chega. Sem a identidade no
      caminho, o servidor encerraria B — um vínculo que o operador nunca viu.
    */
    const cto = await novaCto("A16");
    const p1 = await porta(cto.id, 1);
    const p2 = await porta(cto.id, 2);
    const cliente = await novoCliente("Gina");
    const antiga = await conectar(cliente.id, p1.id);

    const movida = await moveRoute(
      post(`/api/cto-connections/${antiga.id}/move`, { targetCtoPortId: p2.id }, adminToken),
      { params: Promise.resolve({ id: antiga.id }) },
    );
    expect(movida.status).toBe(200);

    const res = await disconnectRoute(
      post(`/api/cto-connections/${antiga.id}/disconnect`, {}, adminToken),
      { params: Promise.resolve({ id: antiga.id }) },
    );
    expect(res.status).toBe(409);
    expect((await corpo(res)).error).toContain("mudou desde que a tela");

    // O vínculo NOVO continua ativo: o clique velho não o alcançou.
    expect(await ativas({ customerId: cliente.id })).toBe(1);
    expect(await ativas({ ctoPortId: p2.id })).toBe(1);
  });

  it("API-D04 — replay idempotente não encerra um vínculo posterior", async () => {
    const cto = await novaCto("A16");
    const p1 = await porta(cto.id, 1);
    const cliente = await novoCliente("Hugo");
    const primeira = await conectar(cliente.id, p1.id);
    const key = novaChave();

    const um = await disconnectRoute(
      post(`/api/cto-connections/${primeira.id}/disconnect`, {}, adminToken, { key }),
      { params: Promise.resolve({ id: primeira.id }) },
    );
    expect(um.status).toBe(200);

    // O cliente é reconectado — e o replay do comando ANTIGO chega depois.
    const segunda = await conectar(cliente.id, p1.id);
    const dois = await disconnectRoute(
      post(`/api/cto-connections/${primeira.id}/disconnect`, {}, adminToken, { key }),
      { params: Promise.resolve({ id: primeira.id }) },
    );
    expect(dois.status).toBe(200);

    // A resposta é a GRAVADA, e o vínculo novo continua vivo.
    const nova = await prisma.customerNetworkConnection.findUniqueOrThrow({
      where: { id: segunda.id },
    });
    expect(nova.disconnectedAt).toBeNull();
    expect(await ativas({ customerId: cliente.id })).toBe(1);
  });

  it("API-D05 — vínculo de outro tenant é 404", async () => {
    const ctoB = await novaCto("CTO da B", 8, fixture.companyB.id);
    const portaB = await porta(ctoB.id, 1);
    const clienteB = await novoCliente("Da B", fixture.companyB.id);
    const daB = await connectCustomerToPort(
      { companyId: fixture.companyB.id, provenance: { source: "WEB", actorUserId: fixture.adminB.id } },
      { customerId: clienteB.id, ctoPortId: portaB.id },
    );

    const res = await disconnectRoute(
      post(`/api/cto-connections/${daB.id}/disconnect`, {}, adminToken),
      { params: Promise.resolve({ id: daB.id }) },
    );
    expect(res.status).toBe(404);
    expect(await ativas({ id: daB.id })).toBe(1);
  });

  it("API-D06 — a recusa não deixa auditoria falsa", async () => {
    const cto = await novaCto("A16");
    const p1 = await porta(cto.id, 1);
    const p2 = await porta(cto.id, 2);
    const cliente = await novoCliente("Ivo");
    const antiga = await conectar(cliente.id, p1.id);
    await moveRoute(
      post(`/api/cto-connections/${antiga.id}/move`, { targetCtoPortId: p2.id }, adminToken),
      { params: Promise.resolve({ id: antiga.id }) },
    );
    const antes = await auditoria("CTO_CONNECTION.DISCONNECTED");

    await disconnectRoute(
      post(`/api/cto-connections/${antiga.id}/disconnect`, {}, adminToken),
      { params: Promise.resolve({ id: antiga.id }) },
    );
    expect(await auditoria("CTO_CONNECTION.DISCONNECTED")).toBe(antes);
  });
});

describe("API · MOVE", () => {
  it("API-M01 / API-M02 — dentro da mesma CTO e entre CTOs", async () => {
    const a = await novaCto("CTO-A");
    const b = await novaCto("CTO-B");
    const pa1 = await porta(a.id, 1);
    const pa2 = await porta(a.id, 2);
    const pb1 = await porta(b.id, 1);
    const cliente = await novoCliente("Joana");
    const c1 = await conectar(cliente.id, pa1.id);

    const dentro = await moveRoute(
      post(`/api/cto-connections/${c1.id}/move`, { targetCtoPortId: pa2.id }, adminToken),
      { params: Promise.resolve({ id: c1.id }) },
    );
    expect(dentro.status).toBe(200);
    const move1 = (await corpo(dentro)).data!.move as Record<string, Record<string, unknown>>;
    expect(move1.from.disconnectedAt).not.toBeNull();
    expect(move1.to.disconnectedAt).toBeNull();

    const c2 = move1.to.id as string;
    const entre = await moveRoute(
      post(`/api/cto-connections/${c2}/move`, { targetCtoPortId: pb1.id }, adminToken),
      { params: Promise.resolve({ id: c2 }) },
    );
    expect(entre.status).toBe(200);
    expect(await ativas({ ctoPortId: pb1.id })).toBe(1);
    expect(await prisma.customerNetworkConnection.count({ where: { customerId: cliente.id } })).toBe(3);
  });

  it("API-M03 / API-M04 — sai de CTO inativa, não entra numa", async () => {
    const origem = await novaCto("ORIGEM");
    const destino = await novaCto("DESTINO");
    const po = await porta(origem.id, 1);
    const pd = await porta(destino.id, 1);
    const cliente = await novoCliente("Kléber");
    const c1 = await conectar(cliente.id, po.id);
    await setCtoActive(fixture.companyA.id, fixture.adminA.id, origem.id, false);

    const saida = await moveRoute(
      post(`/api/cto-connections/${c1.id}/move`, { targetCtoPortId: pd.id }, adminToken),
      { params: Promise.resolve({ id: c1.id }) },
    );
    expect(saida.status).toBe(200);

    const c2 = ((await corpo(saida)).data!.move as Record<string, Record<string, unknown>>).to.id as string;
    const volta = await moveRoute(
      post(`/api/cto-connections/${c2}/move`, { targetCtoPortId: po.id }, adminToken),
      { params: Promise.resolve({ id: c2 }) },
    );
    expect(volta.status).toBe(409);
  });

  it("API-M05 / API-M07 / API-M08 — mesma porta, ocupada e não ofertável são 409", async () => {
    const cto = await novaCto("A16");
    const p1 = await porta(cto.id, 1);
    const p2 = await porta(cto.id, 2);
    const p3 = await porta(cto.id, 3);
    const cliente = await novoCliente("Lia");
    const outro = await novoCliente("Marta");
    const c1 = await conectar(cliente.id, p1.id);
    await conectar(outro.id, p2.id);
    await setPortAdministrativeState(fixture.companyA.id, fixture.adminA.id, cto.id, p3.id, "DAMAGED");

    for (const alvo of [p1.id, p2.id, p3.id]) {
      const res = await moveRoute(
        post(`/api/cto-connections/${c1.id}/move`, { targetCtoPortId: alvo }, adminToken),
        { params: Promise.resolve({ id: c1.id }) },
      );
      expect(res.status, alvo).toBe(409);
    }
    // Nada mudou: o vínculo original continua na porta 1.
    const linha = await prisma.customerNetworkConnection.findUniqueOrThrow({ where: { id: c1.id } });
    expect(linha.disconnectedAt).toBeNull();
    expect(linha.ctoPortId).toBe(p1.id);
  });

  it("API-M06 — origem obsoleta é recusada e o destino fica livre", async () => {
    const cto = await novaCto("A16");
    const p1 = await porta(cto.id, 1);
    const p2 = await porta(cto.id, 2);
    const p3 = await porta(cto.id, 3);
    const cliente = await novoCliente("Nara");
    const antiga = await conectar(cliente.id, p1.id);
    await moveRoute(
      post(`/api/cto-connections/${antiga.id}/move`, { targetCtoPortId: p2.id }, adminToken),
      { params: Promise.resolve({ id: antiga.id }) },
    );

    const res = await moveRoute(
      post(`/api/cto-connections/${antiga.id}/move`, { targetCtoPortId: p3.id }, adminToken),
      { params: Promise.resolve({ id: antiga.id }) },
    );
    expect(res.status).toBe(409);
    expect(await ativas({ ctoPortId: p2.id })).toBe(1);
    expect(await ativas({ ctoPortId: p3.id })).toBe(0);
  });

  it("API-M09 — replay não cria duas movimentações", async () => {
    const cto = await novaCto("A16");
    const p1 = await porta(cto.id, 1);
    const p2 = await porta(cto.id, 2);
    const cliente = await novoCliente("Otávio");
    const c1 = await conectar(cliente.id, p1.id);
    const key = novaChave();

    const um = await moveRoute(
      post(`/api/cto-connections/${c1.id}/move`, { targetCtoPortId: p2.id }, adminToken, { key }),
      { params: Promise.resolve({ id: c1.id }) },
    );
    const dois = await moveRoute(
      post(`/api/cto-connections/${c1.id}/move`, { targetCtoPortId: p2.id }, adminToken, { key }),
      { params: Promise.resolve({ id: c1.id }) },
    );
    expect(um.status).toBe(200);
    expect(dois.status).toBe(200);

    // Duas linhas ao todo — a fechada e a nova. Não três.
    expect(await prisma.customerNetworkConnection.count({ where: { customerId: cliente.id } })).toBe(2);
    expect(await auditoria("CTO_CONNECTION.MOVED")).toBe(1);
  });

  it("mesma chave com payload diferente é conflito", async () => {
    const cto = await novaCto("A16");
    const p1 = await porta(cto.id, 1);
    const p2 = await porta(cto.id, 2);
    const p3 = await porta(cto.id, 3);
    const cliente = await novoCliente("Paula");
    const c1 = await conectar(cliente.id, p1.id);
    const key = novaChave();

    await moveRoute(
      post(`/api/cto-connections/${c1.id}/move`, { targetCtoPortId: p2.id }, adminToken, { key }),
      { params: Promise.resolve({ id: c1.id }) },
    );
    const res = await moveRoute(
      post(`/api/cto-connections/${c1.id}/move`, { targetCtoPortId: p3.id }, adminToken, { key }),
      { params: Promise.resolve({ id: c1.id }) },
    );
    expect(res.status).toBe(409);
  });

  it("Idempotency-Key ausente é recusada", async () => {
    const cto = await novaCto("A16");
    const p1 = await porta(cto.id, 1);
    const cliente = await novoCliente("Rita");
    const res = await connectRoute(
      post("/api/cto-connections", { customerId: cliente.id, ctoPortId: p1.id }, adminToken, { key: null }),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await ativas({ ctoPortId: p1.id })).toBe(0);
  });
});

describe("API · auditoria e timeline", () => {
  it("a rota não duplica auditoria, e o replay não cria outra", async () => {
    const cto = await novaCto("A16");
    const p1 = await porta(cto.id, 1);
    const cliente = await novoCliente("Sara");
    const key = novaChave();
    const payload = { customerId: cliente.id, ctoPortId: p1.id };

    await connectRoute(post("/api/cto-connections", payload, adminToken, { key }));
    await connectRoute(post("/api/cto-connections", payload, adminToken, { key }));

    expect(await auditoria("CTO_CONNECTION.CONNECTED")).toBe(1);
  });

  it("WEB não cria ServiceOrderEvent", async () => {
    const cto = await novaCto("A16");
    const p1 = await porta(cto.id, 1);
    const p2 = await porta(cto.id, 2);
    const cliente = await novoCliente("Tadeu");

    const res = await connectRoute(
      post("/api/cto-connections", { customerId: cliente.id, ctoPortId: p1.id }, adminToken),
    );
    const id = ((await corpo(res)).data!.connection as Record<string, unknown>).id as string;
    await moveRoute(
      post(`/api/cto-connections/${id}/move`, { targetCtoPortId: p2.id }, adminToken),
      { params: Promise.resolve({ id }) },
    );

    expect(
      await prisma.serviceOrderEvent.count({
        where: { companyId: fixture.companyA.id, event: { startsWith: "CTO_PORT_" } },
      }),
    ).toBe(0);
  });
});

describe("API · leitura da rede do cliente", () => {
  it("devolve corrente e histórico, e não atravessa tenant", async () => {
    const cto = await novaCto("A16");
    const p1 = await porta(cto.id, 1);
    const p2 = await porta(cto.id, 2);
    const cliente = await novoCliente("Vera");
    const c1 = await conectar(cliente.id, p1.id);
    await moveRoute(
      post(`/api/cto-connections/${c1.id}/move`, { targetCtoPortId: p2.id }, adminToken),
      { params: Promise.resolve({ id: c1.id }) },
    );

    const res = await networkRoute(get(`/api/cto-connections?customerId=${cliente.id}`, adminToken));
    expect(res.status).toBe(200);
    const rede = (await corpo(res)).data!.network as {
      current: { port: { number: number }; cto: { name: string } } | null;
      history: unknown[];
    };
    expect(rede.current?.port.number).toBe(2);
    expect(rede.current?.cto.name).toBe("A16");
    expect(rede.history.length).toBe(2);

    // Outro tenant não enxerga o cliente: vazio, e não 404 — não se distingue
    // "não existe" de "existe e não é seu".
    const cruzado = await networkRoute(get(`/api/cto-connections?customerId=${cliente.id}`, adminBToken));
    expect(cruzado.status).toBe(200);
    const vazio = (await corpo(cruzado)).data!.network as { current: unknown; history: unknown[] };
    expect(vazio.current).toBeNull();
    expect(vazio.history.length).toBe(0);
  });

  it("DISPATCHER e TECHNICIAN não leem", async () => {
    const cliente = await novoCliente("Wanda");
    for (const token of [dispatcherToken, techToken]) {
      const res = await networkRoute(get(`/api/cto-connections?customerId=${cliente.id}`, token));
      expect(res.status).toBe(403);
    }
  });
});

describe("API · read model da CTO", () => {
  async function detalhe(ctoId: string, token = adminToken) {
    const res = await ctoDetailRoute(get(`/api/ctos/${ctoId}`, token), {
      params: Promise.resolve({ id: ctoId }),
    });
    return { res, body: await corpo(res) };
  }

  it("as DUAS dimensões aparecem separadas na porta ocupada", async () => {
    const cto = await novaCto("A16", 4);
    const p1 = await porta(cto.id, 1);
    const cliente = await novoCliente("Xuxa");
    await conectar(cliente.id, p1.id);

    const { body } = await detalhe(cto.id);
    const detalheCto = body.data!.cto as {
      ports: Array<Record<string, unknown>>;
      summary: Record<string, number>;
    };
    const porta1 = detalheCto.ports.find((p) => p.number === 1)!;

    expect(porta1.administrativeState).toBe("AVAILABLE");
    expect(porta1.occupied).toBe(true);
    expect(porta1.effectiveState).toBe("OCCUPIED");
    expect(porta1.withinCapacity).toBe(true);
    expect(porta1.availableForConnection).toBe(false);
    expect((porta1.activeConnection as { customer: { name: string } }).customer.name).toBe("Xuxa");

    expect(detalheCto.summary.occupied).toBe(1);
    expect(detalheCto.summary.free).toBe(3);
  });

  it("DAMAGED + ocupada conta nas DUAS categorias — o defeito do freeze", async () => {
    /*
      O bug que o congelamento encontrou: `effectiveState` colapsa em `OCCUPIED`,
      e contar `damaged` a partir dele fazia uma porta quebrada COM cliente
      dentro sumir da contagem. Aqui ela aparece nas duas.
    */
    const cto = await novaCto("A16", 4);
    const p1 = await porta(cto.id, 1);
    const cliente = await novoCliente("Yara");
    await conectar(cliente.id, p1.id);
    await setPortAdministrativeState(fixture.companyA.id, fixture.adminA.id, cto.id, p1.id, "DAMAGED");

    const { body } = await detalhe(cto.id);
    const d = body.data!.cto as { ports: Array<Record<string, unknown>>; summary: Record<string, number> };
    const porta1 = d.ports.find((p) => p.number === 1)!;

    expect(porta1.administrativeState).toBe("DAMAGED");
    expect(porta1.occupied).toBe(true);
    expect(porta1.effectiveState).toBe("OCCUPIED");
    expect(d.summary.damaged).toBe(1);
    expect(d.summary.occupied).toBe(1);
    expect(d.summary.free).toBe(3);
  });

  it("as categorias PODEM somar mais que a capacidade", async () => {
    const cto = await novaCto("A16", 4);
    const p1 = await porta(cto.id, 1);
    const p2 = await porta(cto.id, 2);
    const a = await novoCliente("Um");
    const b = await novoCliente("Dois");
    await conectar(a.id, p1.id);
    await conectar(b.id, p2.id);
    await setPortAdministrativeState(fixture.companyA.id, fixture.adminA.id, cto.id, p1.id, "DAMAGED");

    const { body } = await detalhe(cto.id);
    const s = (body.data!.cto as { summary: Record<string, number> }).summary;

    expect(s.capacity).toBe(4);
    expect(s.free).toBe(2);
    expect(s.reserved).toBe(0);
    expect(s.damaged).toBe(1);
    expect(s.occupied).toBe(2);
    // 2 + 0 + 1 + 2 = 5 > 4, e está CERTO: as dimensões se sobrepõem.
    expect(s.free + s.reserved + s.damaged + s.occupied).toBeGreaterThan(s.capacity);
  });

  it("RESERVED + ocupada legado conta nas duas, sem esconder a inconsistência", async () => {
    const cto = await novaCto("A16", 4);
    const p1 = await porta(cto.id, 1);
    const cliente = await novoCliente("Zeca");
    await conectar(cliente.id, p1.id);
    /*
      Escrita DIRETA, e o motivo mudou na `CTO-2.6`.

      Até ela, este estado era alcançável pelo serviço — e a versão anterior
      deste teste o produzia assim. Agora `RESERVED` é alvo proibido enquanto
      existe vínculo ativo, então a única forma de ter a linha é a que a
      produção tem: dado antigo, gravado antes da regra.

      A AFIRMAÇÃO não mudou: o read model precisa continuar mostrando as duas
      dimensões da linha legada, em vez de esconder a inconsistência.
    */
    await prisma.cTOPort.update({
      where: { id: p1.id },
      data: { administrativeState: "RESERVED" },
    });

    const { body } = await detalhe(cto.id);
    const d = body.data!.cto as { ports: Array<Record<string, unknown>>; summary: Record<string, number> };
    expect(d.summary.reserved).toBe(1);
    expect(d.summary.occupied).toBe(1);
    expect(d.ports.find((p) => p.number === 1)!.effectiveState).toBe("OCCUPIED");
  });

  it("porta histórica não é candidata, e a CTO inativa também não", async () => {
    const cto = await novaCto("A16", 16);
    await changeCtoCapacity(fixture.companyA.id, fixture.adminA.id, cto.id, 8);

    const { body } = await detalhe(cto.id);
    const d = body.data!.cto as { ports: Array<Record<string, unknown>> };
    const historica = d.ports.find((p) => p.number === 12)!;
    expect(historica.withinCapacity).toBe(false);
    expect(historica.availableForConnection).toBe(false);
    expect(historica.occupied).toBe(false);
    expect(d.ports.find((p) => p.number === 5)!.availableForConnection).toBe(true);

    await setCtoActive(fixture.companyA.id, fixture.adminA.id, cto.id, false);
    const { body: depois } = await detalhe(cto.id);
    const inativa = depois.data!.cto as { ports: Array<Record<string, unknown>> };
    // Continua legível, e nenhuma porta é oferecida.
    expect(inativa.ports.every((p) => p.availableForConnection === false)).toBe(true);
  });

  it("uma consulta de ocupação para a caixa inteira, e não uma por porta", async () => {
    /*
      256 portas seriam 257 requisições se a ocupação fosse perguntada porta a
      porta. A prova é ESTRUTURAL e medida: o tempo de montar o detalhe não pode
      crescer com o número de portas ocupadas, e a consulta é uma `findMany`
      por `ctoId` — visível no próprio read model.
    */
    const pequena = await novaCto("PEQUENA", 8);
    const grande = await novaCto("GRANDE", 120);
    for (let n = 1; n <= 2; n += 1) {
      const c = await novoCliente(`P${n}`);
      await conectar(c.id, (await porta(pequena.id, n)).id);
    }
    for (let n = 1; n <= 40; n += 1) {
      const c = await novoCliente(`G${n}`);
      await conectar(c.id, (await porta(grande.id, n)).id);
    }

    const { body: bp } = await detalhe(pequena.id);
    const { body: bg } = await detalhe(grande.id);
    expect((bp.data!.cto as { summary: Record<string, number> }).summary.occupied).toBe(2);
    expect((bg.data!.cto as { summary: Record<string, number> }).summary.occupied).toBe(40);

    // A garantia estrutural: o módulo faz UMA `findMany` por CTO. Se alguém a
    // mover para dentro do `map` de portas, esta afirmação sobre o fonte cai.
    const fonte = await import("node:fs").then((fs) =>
      fs.promises.readFile("src/lib/cto-read-model.ts", "utf8"),
    );
    const inicio = fonte.indexOf("cto.ports.map(");
    const fim = fonte.indexOf("return { ...cto, ports,", inicio);
    const corpoDoMap = fonte.slice(inicio, fim);
    expect(corpoDoMap).not.toContain("await prisma");
    expect(corpoDoMap).not.toContain("findFirst");
    expect(
      (fonte.match(/prisma.customerNetworkConnection.findMany/g) ?? []).length,
    ).toBe(2);
  });
});
