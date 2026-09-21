import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { GET as listCtos, POST as createRoute } from "@/app/api/ctos/route";
import {
  GET as getCtoRoute,
  PATCH as patchRoute,
} from "@/app/api/ctos/[id]/route";
import { POST as capacityRoute } from "@/app/api/ctos/[id]/capacity/route";
import { POST as activeRoute } from "@/app/api/ctos/[id]/active/route";
import { POST as portStateRoute } from "@/app/api/ctos/[id]/ports/[portId]/state/route";
import {
  GET as photoGetRoute,
  POST as photoPostRoute,
} from "@/app/api/ctos/[id]/photo/route";
import { createCto } from "@/lib/cto";
import { montarJpeg } from "./support/jpeg-exif";
import {
  apiRequest,
  createTokenFor,
  seedTestData,
  type TestFixture,
} from "./helpers";

/**
 * # CTO-1 — rotas
 *
 * Pelas ROTAS, não pelo serviço. O que a fase entrega de superfície externa é
 * a sequência de autorização — sessão, **capability**, perfil, tenant —, e ela
 * não existe no domínio: testar só o serviço deixaria RBAC, capability e zod
 * sem cobertura nenhuma.
 */

let fixture: TestFixture;
let adminToken: string;
let dispatcherToken: string;
let technicianToken: string;
let adminBToken: string;

beforeEach(async () => {
  fixture = await seedTestData();
  adminToken = await createTokenFor(fixture.adminA.id);
  dispatcherToken = await createTokenFor(fixture.dispatcherA.id);
  technicianToken = await createTokenFor(fixture.techA.id);
  adminBToken = await createTokenFor(fixture.adminB.id);
});

/** Nenhuma empresa nasce com o módulo: habilitar é sempre explícito. */
async function habilitar(companyId: string) {
  await prisma.company.update({
    where: { id: companyId },
    data: { ctoNetworkEnabled: true },
  });
}

async function semeiaCto(companyId = fixture.companyA.id, actor?: string) {
  return createCto(companyId, actor ?? fixture.adminA.id, {
    name: "A16",
    capacity: 8,
  });
}

const ORIGIN = { Origin: "http://localhost" };

// ---------------------------------------------------------------------------

describe("CTO1-01 · capability desligada", () => {
  it("nenhuma empresa nasce com a capability ligada", async () => {
    const a = await prisma.company.findUniqueOrThrow({
      where: { id: fixture.companyA.id },
      select: { ctoNetworkEnabled: true },
    });
    const b = await prisma.company.findUniqueOrThrow({
      where: { id: fixture.companyB.id },
      select: { ctoNetworkEnabled: true },
    });
    expect(a.ctoNetworkEnabled).toBe(false);
    expect(b.ctoNetworkEnabled).toBe(false);
  });

  it("a LEITURA responde 404 com a capability desligada", async () => {
    const res = await listCtos(apiRequest("/api/ctos", {}, adminToken));
    expect(res.status).toBe(404);
  });

  it("a criação responde 404 e não grava nada", async () => {
    const res = await createRoute(
      apiRequest(
        "/api/ctos",
        { method: "POST", body: { name: "A16", capacity: 8 }, headers: { ...ORIGIN } },
        adminToken,
      ),
    );
    expect(res.status).toBe(404);
    // Zero mutação: nem CTO, nem porta, nem auditoria.
    expect(await prisma.cTO.count()).toBe(0);
    expect(await prisma.cTOPort.count()).toBe(0);
    expect(
      await prisma.auditLog.count({ where: { action: { startsWith: "CTO." } } }),
    ).toBe(0);
  });

  it("desligar depois de criar fecha o acesso ao que já existe", async () => {
    await habilitar(fixture.companyA.id);
    const cto = await semeiaCto();

    // Controle positivo: ligada, o ADMIN lê.
    const ok = await getCtoRoute(
      apiRequest(`/api/ctos/${cto.id}`, {}, adminToken),
      { params: Promise.resolve({ id: cto.id }) },
    );
    expect(ok.status).toBe(200);

    await prisma.company.update({
      where: { id: fixture.companyA.id },
      data: { ctoNetworkEnabled: false },
    });

    const depois = await getCtoRoute(
      apiRequest(`/api/ctos/${cto.id}`, {}, adminToken),
      { params: Promise.resolve({ id: cto.id }) },
    );
    expect(depois.status).toBe(404);
  });

  it("a capability é verificada ANTES do perfil — 404, não 403", async () => {
    /*
      A ordem não é estética. Com o perfil primeiro, um DISPATCHER de empresa
      sem o módulo receberia 403 — e 403 significa "isto existe, você é que não
      pode". A empresa descobriria pela mensagem de erro que há um módulo CTO
      que ela não contratou.
    */
    const res = await listCtos(apiRequest("/api/ctos", {}, dispatcherToken));
    expect(res.status).toBe(404);
  });

  it("com a capability ligada, o mesmo DISPATCHER recebe 403", async () => {
    // O par do teste acima: é o que prova que o 404 anterior veio da
    // capability, e não do perfil.
    await habilitar(fixture.companyA.id);
    const res = await listCtos(apiRequest("/api/ctos", {}, dispatcherToken));
    expect(res.status).toBe(403);
  });
});

describe("CTO1-02 · caminho autorizado", () => {
  beforeEach(async () => {
    await habilitar(fixture.companyA.id);
  });

  it("ADMIN com capability cria a CTO e recebe as portas", async () => {
    const res = await createRoute(
      apiRequest(
        "/api/ctos",
        {
          method: "POST",
          body: { name: "A16", capacity: 8, code: "CX-45" },
          headers: { ...ORIGIN },
        },
        adminToken,
      ),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.cto.name).toBe("A16");
    expect(body.data.cto.capacity).toBe(8);
    expect(body.data.cto.ports).toHaveLength(8);
    expect(body.data.cto.summary.free).toBe(8);
    expect(body.data.cto.summary.occupied).toBe(0);
  });

  it("a resposta NUNCA traz a chave de storage", async () => {
    const cto = await semeiaCto();
    const res = await getCtoRoute(
      apiRequest(`/api/ctos/${cto.id}`, {}, adminToken),
      { params: Promise.resolve({ id: cto.id }) },
    );
    const texto = JSON.stringify(await res.json());
    expect(texto).not.toContain("photoStorageKey");
    expect(texto).toContain("hasPhoto");
  });

  it("sem sessão é 401, e o 401 vem antes de tudo", async () => {
    const res = await listCtos(apiRequest("/api/ctos"));
    expect(res.status).toBe(401);
  });
});

describe("CTO1-14 / CTO1-15 · perfis que não mutam", () => {
  beforeEach(async () => {
    await habilitar(fixture.companyA.id);
  });

  const casos: [string, () => string][] = [
    ["DISPATCHER", () => dispatcherToken],
    ["TECHNICIAN", () => technicianToken],
  ];

  for (const [nome, token] of casos) {
    it(`${nome} não cria CTO`, async () => {
      const res = await createRoute(
        apiRequest(
          "/api/ctos",
          {
            method: "POST",
            body: { name: "X", capacity: 4 },
            headers: { ...ORIGIN },
          },
          token(),
        ),
      );
      expect(res.status).toBe(403);
      expect(await prisma.cTO.count()).toBe(0);
    });

    it(`${nome} não altera capacidade, estado de porta nem inativa`, async () => {
      const cto = await semeiaCto();
      const porta = await prisma.cTOPort.findFirstOrThrow({
        where: { ctoId: cto.id },
      });

      const cap = await capacityRoute(
        apiRequest(
          `/api/ctos/${cto.id}/capacity`,
          { method: "POST", body: { capacity: 16 }, headers: { ...ORIGIN } },
          token(),
        ),
        { params: Promise.resolve({ id: cto.id }) },
      );
      expect(cap.status).toBe(403);

      const est = await portStateRoute(
        apiRequest(
          `/api/ctos/${cto.id}/ports/${porta.id}/state`,
          {
            method: "POST",
            body: { administrativeState: "DAMAGED" },
            headers: { ...ORIGIN },
          },
          token(),
        ),
        { params: Promise.resolve({ id: cto.id, portId: porta.id }) },
      );
      expect(est.status).toBe(403);

      const inat = await activeRoute(
        apiRequest(
          `/api/ctos/${cto.id}/active`,
          { method: "POST", body: { active: false }, headers: { ...ORIGIN } },
          token(),
        ),
        { params: Promise.resolve({ id: cto.id }) },
      );
      expect(inat.status).toBe(403);

      const linha = await prisma.cTO.findUniqueOrThrow({ where: { id: cto.id } });
      expect(linha.capacity).toBe(8);
      expect(linha.active).toBe(true);
      const portaDepois = await prisma.cTOPort.findUniqueOrThrow({
        where: { id: porta.id },
      });
      expect(portaDepois.administrativeState).toBe("AVAILABLE");
    });
  }
});

describe("CTO1-16 · IDOR pela rota", () => {
  beforeEach(async () => {
    // As DUAS empresas com o módulo: sem isso, o 404 poderia vir da capability
    // de B e o teste não provaria nada sobre tenant.
    await habilitar(fixture.companyA.id);
    await habilitar(fixture.companyB.id);
  });

  it("o ADMIN de B recebe 404 na CTO de A", async () => {
    const cto = await semeiaCto();

    const res = await getCtoRoute(
      apiRequest(`/api/ctos/${cto.id}`, {}, adminBToken),
      { params: Promise.resolve({ id: cto.id }) },
    );
    expect(res.status).toBe(404);

    // Controle positivo: o ADMIN de A lê a mesma CTO.
    const ok = await getCtoRoute(
      apiRequest(`/api/ctos/${cto.id}`, {}, adminToken),
      { params: Promise.resolve({ id: cto.id }) },
    );
    expect(ok.status).toBe(200);
  });

  it("o ADMIN de B não edita, não muda capacidade e não inativa a CTO de A", async () => {
    const cto = await semeiaCto();

    for (const chamada of [
      () =>
        patchRoute(
          apiRequest(
            `/api/ctos/${cto.id}`,
            { method: "PATCH", body: { name: "invadida" }, headers: { ...ORIGIN } },
            adminBToken,
          ),
          { params: Promise.resolve({ id: cto.id }) },
        ),
      () =>
        capacityRoute(
          apiRequest(
            `/api/ctos/${cto.id}/capacity`,
            { method: "POST", body: { capacity: 32 }, headers: { ...ORIGIN } },
            adminBToken,
          ),
          { params: Promise.resolve({ id: cto.id }) },
        ),
      () =>
        activeRoute(
          apiRequest(
            `/api/ctos/${cto.id}/active`,
            { method: "POST", body: { active: false }, headers: { ...ORIGIN } },
            adminBToken,
          ),
          { params: Promise.resolve({ id: cto.id }) },
        ),
    ]) {
      const res = await chamada();
      expect(res.status).toBe(404);
    }

    const linha = await prisma.cTO.findUniqueOrThrow({ where: { id: cto.id } });
    expect(linha.name).toBe("A16");
    expect(linha.capacity).toBe(8);
    expect(linha.active).toBe(true);
  });

  it("a listagem de B não devolve a CTO de A", async () => {
    await semeiaCto();
    const res = await listCtos(apiRequest("/api/ctos", {}, adminBToken));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.ctos).toEqual([]);
  });

  it("a porta de outra empresa também é 404", async () => {
    const cto = await semeiaCto();
    const porta = await prisma.cTOPort.findFirstOrThrow({
      where: { ctoId: cto.id },
    });
    const res = await portStateRoute(
      apiRequest(
        `/api/ctos/${cto.id}/ports/${porta.id}/state`,
        {
          method: "POST",
          body: { administrativeState: "DAMAGED" },
          headers: { ...ORIGIN },
        },
        adminBToken,
      ),
      { params: Promise.resolve({ id: cto.id, portId: porta.id }) },
    );
    expect(res.status).toBe(404);
  });
});

describe("CTO1-17 / CTO1-18 · mass assignment", () => {
  beforeEach(async () => {
    await habilitar(fixture.companyA.id);
    await habilitar(fixture.companyB.id);
  });

  it("companyId no corpo não troca o tenant — é REJEITADO", async () => {
    /*
      O schema é `.strict()`, então o campo desconhecido derruba a requisição em
      vez de ser descartado em silêncio. Descartar deixaria quem tentou achando
      que funcionou, e apagaria o sinal de que alguém está tentando.
    */
    const res = await createRoute(
      apiRequest(
        "/api/ctos",
        {
          method: "POST",
          body: {
            name: "A16",
            capacity: 8,
            companyId: fixture.companyB.id,
          },
          headers: { ...ORIGIN },
        },
        adminToken,
      ),
    );
    expect(res.status).toBe(400);
    // E nada nasceu na empresa B — nem na A.
    expect(await prisma.cTO.count()).toBe(0);
  });

  it("id, createdAt, active e photoStorageKey são rejeitados na criação", async () => {
    for (const extra of [
      { id: "forjado" },
      { createdAt: "2020-01-01T00:00:00.000Z" },
      { active: false },
      { photoStorageKey: "../../etc/passwd" },
    ]) {
      const res = await createRoute(
        apiRequest(
          "/api/ctos",
          {
            method: "POST",
            body: { name: "A16", capacity: 8, ...extra },
            headers: { ...ORIGIN },
          },
          adminToken,
        ),
      );
      expect(res.status).toBe(400);
    }
    expect(await prisma.cTO.count()).toBe(0);
  });

  it("capacity no PATCH é rejeitado — capacidade tem rota própria", async () => {
    const cto = await semeiaCto();
    const res = await patchRoute(
      apiRequest(
        `/api/ctos/${cto.id}`,
        { method: "PATCH", body: { capacity: 64 }, headers: { ...ORIGIN } },
        adminToken,
      ),
      { params: Promise.resolve({ id: cto.id }) },
    );
    expect(res.status).toBe(400);
    const linha = await prisma.cTO.findUniqueOrThrow({ where: { id: cto.id } });
    expect(linha.capacity).toBe(8);
  });

  it("number no corpo do estado da porta é rejeitado", async () => {
    const cto = await semeiaCto();
    const porta = await prisma.cTOPort.findFirstOrThrow({
      where: { ctoId: cto.id, number: 1 },
    });
    const res = await portStateRoute(
      apiRequest(
        `/api/ctos/${cto.id}/ports/${porta.id}/state`,
        {
          method: "POST",
          body: { administrativeState: "RESERVED", number: 99 },
          headers: { ...ORIGIN },
        },
        adminToken,
      ),
      { params: Promise.resolve({ id: cto.id, portId: porta.id }) },
    );
    expect(res.status).toBe(400);
    const depois = await prisma.cTOPort.findUniqueOrThrow({
      where: { id: porta.id },
    });
    expect(depois.number).toBe(1);
    expect(depois.administrativeState).toBe("AVAILABLE");
  });

  it("OCCUPIED não é um estado aceitável na rota", async () => {
    const cto = await semeiaCto();
    const porta = await prisma.cTOPort.findFirstOrThrow({
      where: { ctoId: cto.id },
    });
    const res = await portStateRoute(
      apiRequest(
        `/api/ctos/${cto.id}/ports/${porta.id}/state`,
        {
          method: "POST",
          body: { administrativeState: "OCCUPIED" },
          headers: { ...ORIGIN },
        },
        adminToken,
      ),
      { params: Promise.resolve({ id: cto.id, portId: porta.id }) },
    );
    expect(res.status).toBe(400);
  });
});

describe("a rota de FOTO entra nas mesmas varreduras", () => {
  /*
    Achado da auditoria independente: `/api/ctos/:id/photo` não era importada
    por este arquivo, então as afirmações "capability desligada → 404 em TODAS
    as rotas" e a varredura de IDOR não a alcançavam. O comportamento estava
    correto — o que faltava era a rede que impede a regressão.

    A foto usa `multipart/form-data`, então o helper de JSON não serve.
  */
  function envioDeFoto(ctoId: string, token: string): Request {
    const form = new FormData();
    form.append(
      "file",
      new File([new Uint8Array(montarJpeg({ comGps: false }))], "cto.jpg", {
        type: "image/jpeg",
      }),
    );
    return new Request(`http://localhost/api/ctos/${ctoId}/photo`, {
      method: "POST",
      headers: {
        ...ORIGIN,
        Cookie: `alfaos_session=${encodeURIComponent(token)}`,
      },
      body: form,
    });
  }

  it("capability desligada → 404 na leitura e no envio", async () => {
    await habilitar(fixture.companyA.id);
    const cto = await semeiaCto();
    await prisma.company.update({
      where: { id: fixture.companyA.id },
      data: { ctoNetworkEnabled: false },
    });

    const get = await photoGetRoute(
      apiRequest(`/api/ctos/${cto.id}/photo`, {}, adminToken),
      { params: Promise.resolve({ id: cto.id }) },
    );
    expect(get.status).toBe(404);

    const post = await photoPostRoute(envioDeFoto(cto.id, adminToken), {
      params: Promise.resolve({ id: cto.id }),
    });
    expect(post.status).toBe(404);

    const linha = await prisma.cTO.findUniqueOrThrow({ where: { id: cto.id } });
    expect(linha.photoStorageKey).toBeNull();
  });

  it("DISPATCHER não envia nem lê foto", async () => {
    await habilitar(fixture.companyA.id);
    const cto = await semeiaCto();

    const post = await photoPostRoute(envioDeFoto(cto.id, dispatcherToken), {
      params: Promise.resolve({ id: cto.id }),
    });
    expect(post.status).toBe(403);

    const get = await photoGetRoute(
      apiRequest(`/api/ctos/${cto.id}/photo`, {}, dispatcherToken),
      { params: Promise.resolve({ id: cto.id }) },
    );
    expect(get.status).toBe(403);
  });

  it("o ADMIN de B não envia foto para a CTO de A", async () => {
    await habilitar(fixture.companyA.id);
    await habilitar(fixture.companyB.id);
    const cto = await semeiaCto();

    const post = await photoPostRoute(envioDeFoto(cto.id, adminBToken), {
      params: Promise.resolve({ id: cto.id }),
    });
    expect(post.status).toBe(404);

    const linha = await prisma.cTO.findUniqueOrThrow({ where: { id: cto.id } });
    expect(linha.photoStorageKey).toBeNull();
  });

  it("origem de terceiro é bloqueada no envio de foto", async () => {
    await habilitar(fixture.companyA.id);
    const cto = await semeiaCto();
    const form = new FormData();
    form.append(
      "file",
      new File([new Uint8Array(montarJpeg({ comGps: false }))], "cto.jpg", {
        type: "image/jpeg",
      }),
    );
    const req = new Request(`http://localhost/api/ctos/${cto.id}/photo`, {
      method: "POST",
      headers: {
        Origin: "https://evil.example",
        Cookie: `alfaos_session=${encodeURIComponent(adminToken)}`,
      },
      body: form,
    });

    const res = await photoPostRoute(req, { params: Promise.resolve({ id: cto.id }) });
    expect(res.status).toBe(403);
  });

  it("CTO sem foto responde 404, e não 500", async () => {
    await habilitar(fixture.companyA.id);
    const cto = await semeiaCto();
    const res = await photoGetRoute(
      apiRequest(`/api/ctos/${cto.id}/photo`, {}, adminToken),
      { params: Promise.resolve({ id: cto.id }) },
    );
    expect(res.status).toBe(404);
  });
});

describe("CSRF", () => {
  it("origem de terceiro é bloqueada antes de qualquer escrita", async () => {
    await habilitar(fixture.companyA.id);
    const res = await createRoute(
      apiRequest(
        "/api/ctos",
        {
          method: "POST",
          body: { name: "A16", capacity: 8 },
          headers: { Origin: "https://evil.example" },
        },
        adminToken,
      ),
    );
    expect(res.status).toBe(403);
    expect(await prisma.cTO.count()).toBe(0);
  });
});
