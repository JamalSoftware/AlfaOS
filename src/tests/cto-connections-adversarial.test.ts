import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { POST as connectRoute, GET as networkRoute } from "@/app/api/cto-connections/route";
import { POST as disconnectRoute } from "@/app/api/cto-connections/[id]/disconnect/route";
import { POST as moveRoute } from "@/app/api/cto-connections/[id]/move/route";
import { GET as ctoDetailRoute } from "@/app/api/ctos/[id]/route";
import { createCto } from "@/lib/cto";
import { connectCustomerToPort, type ConnectionContext } from "@/lib/cto-connections";
import { createTokenFor, seedTestData, type TestFixture } from "./helpers";

/**
 * # `CTO-2.2` — ataques
 *
 * Escritos DEPOIS da implementação e contra ela. A limitação está declarada no
 * relatório: quem implementou a fase também escreveu isto, e a compensação é
 * atacar caminhos novos em vez de reler o que já passa.
 */

let fixture: TestFixture;
let adminToken: string;
let adminBToken: string;
let ctxA: ConnectionContext;
let ctxB: ConnectionContext;

beforeEach(async () => {
  fixture = await seedTestData();
  adminToken = await createTokenFor(fixture.adminA.id);
  adminBToken = await createTokenFor(fixture.adminB.id);
  await prisma.company.updateMany({
    where: { id: { in: [fixture.companyA.id, fixture.companyB.id] } },
    data: { ctoNetworkEnabled: true },
  });
  ctxA = {
    companyId: fixture.companyA.id,
    provenance: { source: "WEB", actorUserId: fixture.adminA.id },
  };
  ctxB = {
    companyId: fixture.companyB.id,
    provenance: { source: "WEB", actorUserId: fixture.adminB.id },
  };
});

const ORIGIN = "http://localhost";
let chave = 0;

function post(url: string, body: unknown, token: string, opts: { origin?: string; key?: string } = {}) {
  chave += 1;
  return new Request(`http://localhost${url}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: opts.origin ?? ORIGIN,
      Cookie: `alfaos_session=${encodeURIComponent(token)}`,
      "Idempotency-Key": opts.key ?? `adv-${Date.now()}-${chave}`,
    },
    body: JSON.stringify(body),
  });
}

function get(url: string, token: string) {
  return new Request(`http://localhost${url}`, {
    headers: { Cookie: `alfaos_session=${encodeURIComponent(token)}` },
  });
}

async function cenario() {
  const ctoA = await createCto(fixture.companyA.id, fixture.adminA.id, { name: "A", capacity: 8 });
  const ctoB = await createCto(fixture.companyB.id, fixture.adminB.id, { name: "B", capacity: 8 });
  const pA = await prisma.cTOPort.findFirstOrThrow({ where: { ctoId: ctoA.id, number: 1 } });
  const pA2 = await prisma.cTOPort.findFirstOrThrow({ where: { ctoId: ctoA.id, number: 2 } });
  const pB = await prisma.cTOPort.findFirstOrThrow({ where: { ctoId: ctoB.id, number: 1 } });
  const cA = await prisma.customer.create({ data: { companyId: fixture.companyA.id, name: "Da A" } });
  const cB = await prisma.customer.create({ data: { companyId: fixture.companyB.id, name: "Da B" } });
  return { ctoA, ctoB, pA, pA2, pB, cA, cB };
}

// ---------------------------------------------------------------------------

describe("ataques", () => {
  it("A1 — vínculo de OUTRO tenant na desconexão: 404 e nada muda", async () => {
    const { pB, cB } = await cenario();
    const daB = await connectCustomerToPort(ctxB, { customerId: cB.id, ctoPortId: pB.id });

    const res = await disconnectRoute(
      post(`/api/cto-connections/${daB.id}/disconnect`, {}, adminToken),
      { params: { id: daB.id } },
    );
    expect(res.status).toBe(404);
    const linha = await prisma.customerNetworkConnection.findUniqueOrThrow({ where: { id: daB.id } });
    expect(linha.disconnectedAt).toBeNull();

    /*
      O CORPO tem de ser IDÊNTICO ao de um id que não existe em lugar nenhum.

      Só o status não basta: se o vínculo de outra empresa produzisse uma
      mensagem diferente da de um id inventado, os dois 404 formariam um oráculo
      — bastaria comparar o texto para descobrir quais ids existem. É
      exatamente o que acontece quando o `companyId` sai do predicado que
      resolve o vínculo: a recusa passa a vir do domínio, com outra frase.
    */
    const inexistente = await disconnectRoute(
      post("/api/cto-connections/nao-existe-em-lugar-nenhum/disconnect", {}, adminToken),
      { params: { id: "nao-existe-em-lugar-nenhum" } },
    );
    expect(inexistente.status).toBe(404);
    expect(await res.text()).toBe(await inexistente.text());
  });

  it("A2 — vínculo HISTÓRICO com o cliente ativo em outro lugar: 409, e o atual sobrevive", async () => {
    const { pA, pA2, cA } = await cenario();
    const antigo = await connectCustomerToPort(ctxA, { customerId: cA.id, ctoPortId: pA.id });
    await moveRoute(
      post(`/api/cto-connections/${antigo.id}/move`, { targetCtoPortId: pA2.id }, adminToken),
      { params: { id: antigo.id } },
    );

    /*
      O id existe, é do tenant certo, e está FECHADO. É o vetor mais realista:
      uma aba aberta há dez minutos. O 409 tem de vir da guarda de
      obsolescência, e não de um 404 por acaso.
    */
    const res = await disconnectRoute(
      post(`/api/cto-connections/${antigo.id}/disconnect`, {}, adminToken),
      { params: { id: antigo.id } },
    );
    expect(res.status).toBe(409);
    expect(
      await prisma.customerNetworkConnection.count({
        where: { customerId: cA.id, disconnectedAt: null },
      }),
    ).toBe(1);
    expect(
      await prisma.customerNetworkConnection.count({
        where: { ctoPortId: pA2.id, disconnectedAt: null },
      }),
    ).toBe(1);
  });

  it("A3 — porta válida de OUTRA CTO da mesma empresa é aceita; de outro tenant, não", async () => {
    const { pA, pB, cA } = await cenario();
    const outra = await createCto(fixture.companyA.id, fixture.adminA.id, { name: "OUTRA", capacity: 4 });
    const pOutra = await prisma.cTOPort.findFirstOrThrow({ where: { ctoId: outra.id, number: 1 } });

    // Controle POSITIVO: outra CTO da MESMA empresa é destino legítimo.
    const ok = await connectRoute(
      post("/api/cto-connections", { customerId: cA.id, ctoPortId: pOutra.id }, adminToken),
    );
    expect(ok.status).toBe(201);

    // Porta de outro tenant: inexistente.
    const outroCliente = await prisma.customer.create({
      data: { companyId: fixture.companyA.id, name: "Outro" },
    });
    const res = await connectRoute(
      post("/api/cto-connections", { customerId: outroCliente.id, ctoPortId: pB.id }, adminToken),
    );
    expect(res.status).toBe(404);
    expect(await prisma.customerNetworkConnection.count({ where: { ctoPortId: pB.id } })).toBe(0);
    expect(await prisma.customerNetworkConnection.count({ where: { ctoPortId: pA.id } })).toBe(0);
  });

  it("A4 / A5 / A6 — companyId, source e procedência no corpo: 400 e zero escrita", async () => {
    const { pA, cA } = await cenario();
    const base = { customerId: cA.id, ctoPortId: pA.id };
    const venenos = [
      { ...base, companyId: fixture.companyB.id },
      { ...base, source: "FIELD" },
      { ...base, technicianId: "forjado" },
      { ...base, serviceOrderId: "forjado" },
    ];
    for (const v of venenos) {
      expect((await connectRoute(post("/api/cto-connections", v, adminToken))).status, JSON.stringify(v)).toBe(400);
    }
    expect(await prisma.customerNetworkConnection.count()).toBe(0);

    // Controle positivo: sem os campos extras, a mesma requisição funciona.
    expect((await connectRoute(post("/api/cto-connections", base, adminToken))).status).toBe(201);
  });

  it("A7 — mesma chave com payload alterado é recusada", async () => {
    const { pA, pA2, cA } = await cenario();
    const key = `adv-fixa-${Date.now()}`;
    expect(
      (await connectRoute(post("/api/cto-connections", { customerId: cA.id, ctoPortId: pA.id }, adminToken, { key }))).status,
    ).toBe(201);

    const outro = await prisma.customer.create({
      data: { companyId: fixture.companyA.id, name: "Outro" },
    });
    const res = await connectRoute(
      post("/api/cto-connections", { customerId: outro.id, ctoPortId: pA2.id }, adminToken, { key }),
    );
    expect(res.status).toBe(409);
    // E o segundo cliente NÃO foi conectado por engano.
    expect(await prisma.customerNetworkConnection.count({ where: { customerId: outro.id } })).toBe(0);
  });

  it("A8 — POST cross-site nas TRÊS rotas: 403 e zero mutação", async () => {
    const { pA, pA2, cA } = await cenario();
    const ativo = await connectCustomerToPort(ctxA, { customerId: cA.id, ctoPortId: pA.id });
    const mau = { origin: "https://evil.example" };

    const outro = await prisma.customer.create({
      data: { companyId: fixture.companyA.id, name: "Outro" },
    });
    expect(
      (await connectRoute(post("/api/cto-connections", { customerId: outro.id, ctoPortId: pA2.id }, adminToken, mau))).status,
    ).toBe(403);
    expect(
      (await disconnectRoute(post(`/api/cto-connections/${ativo.id}/disconnect`, {}, adminToken, mau), { params: { id: ativo.id } })).status,
    ).toBe(403);
    expect(
      (await moveRoute(post(`/api/cto-connections/${ativo.id}/move`, { targetCtoPortId: pA2.id }, adminToken, mau), { params: { id: ativo.id } })).status,
    ).toBe(403);

    const linha = await prisma.customerNetworkConnection.findUniqueOrThrow({ where: { id: ativo.id } });
    expect(linha.disconnectedAt).toBeNull();
    expect(linha.ctoPortId).toBe(pA.id);
    expect(await prisma.customerNetworkConnection.count()).toBe(1);
  });

  it("A9 — ADMIN de A lendo o detalhe da CTO de B: 404, sem vazar porta nem ocupante", async () => {
    const { ctoB, pB, cB } = await cenario();
    await connectCustomerToPort(ctxB, { customerId: cB.id, ctoPortId: pB.id });

    const res = await ctoDetailRoute(get(`/api/ctos/${ctoB.id}`, adminToken), {
      params: { id: ctoB.id },
    });
    expect(res.status).toBe(404);
    const texto = await res.text();
    expect(texto).not.toContain("Da B");
    expect(texto).not.toContain(pB.id);
    expect(texto).not.toContain(fixture.companyB.id);

    // Controle positivo: o ADMIN de B lê normalmente.
    const legitimo = await ctoDetailRoute(get(`/api/ctos/${ctoB.id}`, adminBToken), {
      params: { id: ctoB.id },
    });
    expect(legitimo.status).toBe(200);
    expect(await legitimo.text()).toContain("Da B");
  });

  it("A9b — a leitura da rede de um cliente de outro tenant volta vazia, não vaza", async () => {
    const { pB, cB } = await cenario();
    await connectCustomerToPort(ctxB, { customerId: cB.id, ctoPortId: pB.id });

    const res = await networkRoute(get(`/api/cto-connections?customerId=${cB.id}`, adminToken));
    expect(res.status).toBe(200);
    const texto = await res.text();
    expect(texto).not.toContain(pB.id);
    expect(texto).not.toContain("Da B");
  });

  it("A10 — 256 portas com 100 ocupadas: uma consulta de ocupação, não 257", async () => {
    const cheia = await createCto(fixture.companyA.id, fixture.adminA.id, {
      name: "CHEIA",
      capacity: 256,
    });
    const portas = await prisma.cTOPort.findMany({
      where: { ctoId: cheia.id },
      orderBy: { number: "asc" },
      take: 100,
    });
    for (let i = 0; i < portas.length; i += 1) {
      const p = portas[i];
      const c = await prisma.customer.create({
        data: { companyId: fixture.companyA.id, name: `C${i}` },
      });
      await connectCustomerToPort(ctxA, { customerId: c.id, ctoPortId: p.id });
    }

    const res = await ctoDetailRoute(get(`/api/ctos/${cheia.id}`, adminToken), {
      params: { id: cheia.id },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { cto: { ports: unknown[]; summary: Record<string, number> } };
    };
    expect(body.data.cto.ports.length).toBe(256);
    expect(body.data.cto.summary.occupied).toBe(100);
    expect(body.data.cto.summary.free).toBe(156);
  });
});
