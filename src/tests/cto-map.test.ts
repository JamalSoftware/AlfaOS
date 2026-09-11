import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET as mapRoute } from "@/app/api/ctos/map/route";
import {
  changeCtoCapacity,
  createCto,
  setCtoActive,
  setPortAdministrativeState,
} from "@/lib/cto";
import {
  CTO_MAP_MAX_MARKERS,
  assertBoundingBox,
  deriveCtoMapStatus,
  getCtoMapView,
  type CtoMapView,
} from "@/lib/cto-map";
import {
  connectCustomerToPort,
  type ConnectionContext,
} from "@/lib/cto-connections";
import { DomainError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import {
  apiRequest,
  createTokenFor,
  seedTestData,
  type TestFixture,
} from "./helpers";

/**
 * # `CTO-3.1` — o contrato de leitura geográfica
 *
 * A primeira camada do Mapa Operacional, **sem mapa**. O que esta fase entrega
 * é o contrato de dados, e é nele que moram os três lugares onde um mapa
 * costuma quebrar: tenancy, teto e `N+1`.
 *
 * As coordenadas são fictícias, escolhidas numa faixa arbitrária do Atlântico
 * sul para não coincidirem com endereço de ninguém.
 */

let fixture: TestFixture;
let ctxA: ConnectionContext;
let adminA: string;
let dispatcherA: string;
let technicianA: string;
let adminB: string;

beforeEach(async () => {
  fixture = await seedTestData();
  await prisma.company.updateMany({
    where: { id: { in: [fixture.companyA.id, fixture.companyB.id] } },
    data: { ctoNetworkEnabled: true },
  });
  adminA = await createTokenFor(fixture.adminA.id);
  dispatcherA = await createTokenFor(fixture.dispatcherA.id);
  technicianA = await createTokenFor(fixture.techA.id);
  adminB = await createTokenFor(fixture.adminB.id);
  ctxA = {
    companyId: fixture.companyA.id,
    provenance: { source: "WEB", actorUserId: fixture.adminA.id },
  };
});

// --- ajudantes --------------------------------------------------------------

/** Recorte largo que contém todas as caixas fictícias deste arquivo. */
const RECORTE = { north: -20, south: -21, east: -41, west: -42 };
const DENTRO = { latitude: -20.5, longitude: -41.5 };

async function novaCto(
  nome: string,
  opcoes: {
    capacity?: number;
    latitude?: number | null;
    longitude?: number | null;
    companyId?: string;
  } = {},
) {
  const companyId = opcoes.companyId ?? fixture.companyA.id;
  const ator =
    companyId === fixture.companyA.id ? fixture.adminA.id : fixture.adminB.id;
  return createCto(companyId, ator, {
    name: nome,
    capacity: opcoes.capacity ?? 8,
    latitude: opcoes.latitude === undefined ? DENTRO.latitude : opcoes.latitude,
    longitude:
      opcoes.longitude === undefined ? DENTRO.longitude : opcoes.longitude,
  });
}

const porta = (ctoId: string, numero: number) =>
  prisma.cTOPort.findFirstOrThrow({ where: { ctoId, number: numero } });

const novoCliente = (nome: string) =>
  prisma.customer.create({
    data: { companyId: fixture.companyA.id, name: nome },
  });

async function ocupar(ctoId: string, numero: number, nome: string) {
  const p = await porta(ctoId, numero);
  const cliente = await novoCliente(nome);
  await connectCustomerToPort(ctxA, {
    customerId: cliente.id,
    ctoPortId: p.id,
  });
  return { port: p, customerId: cliente.id };
}

const marcar = (
  ctoId: string,
  portId: string,
  estado: "AVAILABLE" | "RESERVED" | "DAMAGED",
) =>
  setPortAdministrativeState(
    fixture.companyA.id,
    fixture.adminA.id,
    ctoId,
    portId,
    estado,
  );

const ver = (companyId = fixture.companyA.id, limit?: number) =>
  getCtoMapView(companyId, { bbox: RECORTE, limit });

function pedir(
  token: string,
  query: Record<string, string | number> = {},
) {
  const params = new URLSearchParams({
    north: String(RECORTE.north),
    south: String(RECORTE.south),
    east: String(RECORTE.east),
    west: String(RECORTE.west),
    ...Object.fromEntries(
      Object.entries(query).map(([k, v]) => [k, String(v)]),
    ),
  });
  return mapRoute(
    apiRequest(`/api/ctos/map?${params.toString()}`, {}, token),
  );
}

async function corpo(res: Response) {
  return (await res.json()) as {
    ok: boolean;
    error?: string;
    data?: { map: CtoMapView };
  };
}

// ---------------------------------------------------------------------------
// Recorte
// ---------------------------------------------------------------------------

describe("CTO-3.1 · bounding box", () => {
  it("MAP-01 devolve a caixa que está dentro do recorte", async () => {
    const cto = await novaCto("CX-MAP-01");
    const view = await ver();
    expect(view.markers.map((m) => m.id)).toEqual([cto.id]);
    expect(view.markers[0].latitude).toBe(DENTRO.latitude);
    expect(view.markers[0].longitude).toBe(DENTRO.longitude);
  });

  it("MAP-02 não devolve a caixa que está fora", async () => {
    const dentro = await novaCto("CX-DENTRO");
    await novaCto("CX-NORTE", { latitude: -10, longitude: -41.5 });
    await novaCto("CX-LESTE", { latitude: -20.5, longitude: -30 });

    const view = await ver();
    expect(view.markers.map((m) => m.id)).toEqual([dentro.id]);
  });

  it("MAP-02b as bordas do recorte são INCLUSIVAS", async () => {
    const norte = await novaCto("CX-BORDA-N", {
      latitude: RECORTE.north,
      longitude: RECORTE.west,
    });
    const sul = await novaCto("CX-BORDA-S", {
      latitude: RECORTE.south,
      longitude: RECORTE.east,
    });
    const view = await ver();
    expect(view.markers.map((m) => m.id).sort()).toEqual(
      [norte.id, sul.id].sort(),
    );
  });

  it.each([
    ["MAP-06 latitude fora da faixa", { north: 91 }],
    ["MAP-06b latitude negativa fora da faixa", { south: -91 }],
    ["MAP-07 longitude fora da faixa", { east: 181 }],
    ["MAP-07b longitude negativa fora da faixa", { west: -181 }],
    ["MAP-08 north menor que south", { north: -30, south: -20 }],
  ])("%s é recusado com 400", async (_caso, sobrepor) => {
    await novaCto("CX-INVALIDO");
    const res = await pedir(adminA, sobrepor as Record<string, number>);
    expect(res.status).toBe(400);
  });

  it("MAP-06c valor não numérico é recusado, e a mensagem não é de faixa", async () => {
    const res = await mapRoute(
      apiRequest(
        "/api/ctos/map?north=abc&south=-21&east=-41&west=-42",
        {},
        adminA,
      ),
    );
    expect(res.status).toBe(400);
    expect((await corpo(res)).error).toContain("north");
  });

  it("MAP-06d parâmetro ausente é recusado", async () => {
    const res = await mapRoute(
      apiRequest("/api/ctos/map?north=-20&south=-21&east=-41", {}, adminA),
    );
    expect(res.status).toBe(400);
  });

  it("MAP-08b recorte que cruza o antimeridiano é RECUSADO, não vazio", async () => {
    /*
      Um `200` com lista vazia faria o mapa concluir que não há caixas na
      região. A recusa diz a verdade: isto ainda não é oferecido.
    */
    let erro: unknown;
    try {
      assertBoundingBox({ north: 10, south: -10, east: -179, west: 179 });
    } catch (e) {
      erro = e;
    }
    expect(erro).toBeInstanceOf(DomainError);
    expect((erro as DomainError).status).toBe(400);
    expect((erro as DomainError).message).toContain("antimeridiano");
  });

  it("MAP-08c latitudes iguais são um recorte válido, ainda que degenerado", () => {
    expect(assertBoundingBox({ north: -20, south: -20, east: -41, west: -41 }))
      .toEqual({ north: -20, south: -20, east: -41, west: -41 });
  });
});

// ---------------------------------------------------------------------------
// Tenancy
// ---------------------------------------------------------------------------

describe("CTO-3.1 · tenancy", () => {
  it("MAP-03 a empresa A nunca recebe caixa da empresa B", async () => {
    const daA = await novaCto("CX-A");
    const daB = await novaCto("CX-B", { companyId: fixture.companyB.id });

    const view = await ver(fixture.companyA.id);
    expect(view.markers.map((m) => m.id)).toEqual([daA.id]);

    // Controle positivo: a caixa de B existe, no MESMO recorte, e B a vê.
    const deB = await getCtoMapView(fixture.companyB.id, { bbox: RECORTE });
    expect(deB.markers.map((m) => m.id)).toEqual([daB.id]);
  });

  it("MAP-03b nem a coordenada de outra empresa atravessa a resposta", async () => {
    await novaCto("CX-A");
    await novaCto("CX-SEGREDO-B", {
      companyId: fixture.companyB.id,
      latitude: -20.777777,
      longitude: -41.666666,
    });

    const res = await pedir(adminA);
    const texto = await res.text();
    // Uma coordenada isolada já é vazamento.
    expect(texto).not.toContain("-20.777777");
    expect(texto).not.toContain("-41.666666");
    expect(texto).not.toContain("CX-SEGREDO-B");
  });

  it("MAP-04 recorte do planeta inteiro continua isolado pelo tenant", async () => {
    const daA = await novaCto("CX-A");
    await novaCto("CX-B", { companyId: fixture.companyB.id });

    const global = await getCtoMapView(fixture.companyA.id, {
      bbox: { north: 90, south: -90, east: 180, west: -180 },
    });
    expect(global.markers.map((m) => m.id)).toEqual([daA.id]);
  });

  it("MAP-04b companyId na query NÃO é autoridade", async () => {
    await novaCto("CX-A");
    const daB = await novaCto("CX-B", { companyId: fixture.companyB.id });

    const res = await pedir(adminA, { companyId: fixture.companyB.id });
    const view = (await corpo(res)).data!.map;
    // O parâmetro é simplesmente ignorado: o tenant vem da sessão.
    expect(view.markers.map((m) => m.id)).not.toContain(daB.id);
    expect(view.markers).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Caixa sem coordenada
// ---------------------------------------------------------------------------

describe("CTO-3.1 · sem localização", () => {
  it("MAP-05 caixa sem coordenada não vira marcador", async () => {
    const comGps = await novaCto("CX-COM-GPS");
    await novaCto("CX-SEM-GPS", { latitude: null, longitude: null });

    const view = await ver();
    expect(view.markers.map((m) => m.id)).toEqual([comGps.id]);
    // E nada de 0,0 inventado.
    expect(view.markers.every((m) => m.latitude !== 0)).toBe(true);
  });

  it("MAP-05b ela é CONTADA à parte, para o mapa poder oferecê-la", async () => {
    await novaCto("CX-COM-GPS");
    await novaCto("CX-SEM-1", { latitude: null, longitude: null });
    await novaCto("CX-SEM-2", { latitude: null, longitude: null });

    const view = await ver();
    expect(view.missingLocationCount).toBe(2);
  });

  it("MAP-05c meia coordenada não posiciona nada", async () => {
    await prisma.cTO.create({
      data: {
        companyId: fixture.companyA.id,
        name: "CX-META",
        capacity: 4,
        latitude: DENTRO.latitude,
        longitude: null,
      },
    });
    const view = await ver();
    expect(view.markers).toHaveLength(0);
    expect(view.missingLocationCount).toBe(1);
  });

  it("MAP-05d a contagem não é do recorte, é da empresa", async () => {
    await novaCto("CX-SEM", { latitude: null, longitude: null });
    const longe = await getCtoMapView(fixture.companyA.id, {
      bbox: { north: 10, south: 9, east: 10, west: 9 },
    });
    // Uma caixa sem coordenada não está em região nenhuma.
    expect(longe.markers).toHaveLength(0);
    expect(longe.missingLocationCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Teto
// ---------------------------------------------------------------------------

describe("CTO-3.1 · teto", () => {
  it("MAP-09 o servidor aplica o teto mesmo quando o cliente pede mais", async () => {
    for (let i = 0; i < 4; i += 1) await novaCto(`CX-TETO-${i}`, { capacity: 1 });

    const view = await ver(fixture.companyA.id, 2);
    expect(view.markers).toHaveLength(2);
    expect(view.limit).toBe(2);
    // Informado, nunca silencioso.
    expect(view.truncated).toBe(true);
  });

  it("MAP-09b limit acima do máximo é reduzido ao máximo", async () => {
    await novaCto("CX-UM", { capacity: 1 });
    const res = await pedir(adminA, { limit: 100_000 });
    const view = (await corpo(res)).data!.map;
    expect(view.limit).toBe(CTO_MAP_MAX_MARKERS);
    expect(view.truncated).toBe(false);
  });

it("MAP-09d o teto do DOMÍNIO vale sozinho, sem a rota na frente", async () => {
    /*
      A sabotagem `S4` — remover o teto do domínio — passou por 40 testes, e a
      culpa era deles: o `MAP-09b` pede pela ROTA, que já limita antes de
      chamar o domínio. O guarda de dentro nunca era exercido.

      Ele importa por si: quem chamar `getCtoMapView` direto — outra camada do
      motor de mapa, um job, um teste — não passa pela rota, e o teto é a única
      coisa entre um mapa e a carteira inteira.
    */
    await novaCto("CX-TETO-DOMINIO", { capacity: 1 });
    const espia = vi.spyOn(prisma.cTO, "findMany");

    const view = await getCtoMapView(fixture.companyA.id, {
      bbox: RECORTE,
      limit: 100_000,
    });

    expect(view.limit).toBe(CTO_MAP_MAX_MARKERS);
    // E o teto viaja para o banco: não adianta limitar só o que se devolve.
    expect(espia.mock.calls[0]?.[0]?.take).toBe(CTO_MAP_MAX_MARKERS + 1);
    espia.mockRestore();
  });

  it("MAP-09e limite zero ou negativo não vira consulta ilimitada", async () => {
    await novaCto("CX-TETO-ZERO", { capacity: 1 });
    for (const pedido of [0, -1, -100]) {
      const view = await getCtoMapView(fixture.companyA.id, {
        bbox: RECORTE,
        limit: pedido,
      });
      expect(view.limit).toBeGreaterThanOrEqual(1);
      expect(view.limit).toBeLessThanOrEqual(CTO_MAP_MAX_MARKERS);
    }
  });

  it("MAP-09c sem corte, truncated é falso", async () => {
    await novaCto("CX-UM", { capacity: 1 });
    await novaCto("CX-DOIS", { capacity: 1 });
    const view = await ver(fixture.companyA.id, 2);
    expect(view.markers).toHaveLength(2);
    expect(view.truncated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Agregação
// ---------------------------------------------------------------------------

describe("CTO-3.1 · contagens", () => {
  it("MAP-10 o resumo reflete a ocupação real", async () => {
    const cto = await novaCto("CX-AGG", { capacity: 8 });
    await ocupar(cto.id, 1, "Cliente 1");
    await ocupar(cto.id, 2, "Cliente 2");
    await marcar(cto.id, (await porta(cto.id, 3)).id, "RESERVED");
    await marcar(cto.id, (await porta(cto.id, 4)).id, "DAMAGED");

    const [marker] = (await ver()).markers;
    expect(marker.summary).toEqual({
      capacity: 8,
      free: 4,
      occupied: 2,
      reserved: 1,
      damaged: 1,
      historical: 0,
    });
  });

  it("MAP-11 a ocupação deriva do VÍNCULO, não do estado administrativo", async () => {
    const cto = await novaCto("CX-DERIVA", { capacity: 4 });
    const { port } = await ocupar(cto.id, 1, "Cliente");

    // A porta ocupada continua AVAILABLE no eixo administrativo.
    expect((await porta(cto.id, 1)).administrativeState).toBe("AVAILABLE");
    expect((await ver()).markers[0].summary.occupied).toBe(1);

    // Encerrado o vínculo, a ocupação some — sem ninguém tocar na porta.
    const vinculo = await prisma.customerNetworkConnection.findFirstOrThrow({
      where: { ctoPortId: port.id, disconnectedAt: null },
    });
    await prisma.customerNetworkConnection.update({
      where: { id: vinculo.id },
      data: { disconnectedAt: new Date() },
    });
    expect((await ver()).markers[0].summary.occupied).toBe(0);
    expect((await porta(cto.id, 1)).administrativeState).toBe("AVAILABLE");
  });

  it("MAP-12 DANIFICADA e OCUPADA conta nas DUAS dimensões", async () => {
    const cto = await novaCto("CX-DUPLA", { capacity: 4 });
    const { port } = await ocupar(cto.id, 1, "Cliente");
    await marcar(cto.id, port.id, "DAMAGED");

    const { summary } = (await ver()).markers[0];
    expect(summary.damaged).toBe(1);
    expect(summary.occupied).toBe(1);
    // As categorias se sobrepõem, e a soma pode passar da capacidade.
    expect(
      summary.free + summary.reserved + summary.damaged + summary.occupied,
    ).toBeGreaterThan(summary.capacity);
  });

it("MAP-12b porta histórica DANIFICADA não conta como dano operacional", async () => {
    /*
      O estado histórico é gravado DIRETO, e não pelo serviço, porque o serviço
      recusa as duas pontas: a `CTO-1.9` tornou a porta fora da capacidade
      read-only, e a `CTO-2.6` recusa reduzir capacidade com `DAMAGED` acima
      do limite. A linha existe assim mesmo — dado anterior às regras —, e é
      dela que o teste precisa.

      A versão anterior deixava a porta histórica `AVAILABLE` e passava sem
      exercer nada: o nome prometia dano histórico e a asserção não o tinha.
    */
    const cto = await novaCto("CX-HIST", { capacity: 8 });
    await changeCtoCapacity(fixture.companyA.id, fixture.adminA.id, cto.id, 4);
    await prisma.cTOPort.update({
      where: { id: (await porta(cto.id, 8)).id },
      data: { administrativeState: "DAMAGED" },
    });

    const marker = (await ver()).markers[0];
    expect(marker.summary.capacity).toBe(4);
    expect(marker.summary.historical).toBe(4);
    // A porta 8 já não é ofertada: ela não põe a caixa em manutenção.
    expect(marker.summary.damaged).toBe(0);
    expect(marker.summary.free).toBe(4);
    expect(marker.status).toBe("AVAILABLE");
  });

it("MAP-20 o recorte e o tenant PARTICIPAM da consulta ao banco", async () => {
    /*
      Asserção sobre a CONSULTA, e não sobre o resultado — e é deliberado.

      Filtrar o recorte em memória depois de buscar produz exatamente a mesma
      lista, então nenhum teste de resultado consegue distinguir os dois. O que
      muda é que o banco passa a devolver a carteira inteira antes: o oposto do
      objetivo da §200, e um vazamento de tenant esperando uma refatoração
      distraída.

      Foi a sabotagem `S2` que mostrou a lacuna: ela passou por 39 testes.
    */
    await novaCto("CX-QUERY", { capacity: 2 });
    const espia = vi.spyOn(prisma.cTO, "findMany");

    await ver();

    const where = espia.mock.calls[0]?.[0]?.where as
      | Record<string, unknown>
      | undefined;
    expect(where?.companyId).toBe(fixture.companyA.id);
    expect(where?.latitude).toEqual({
      gte: RECORTE.south,
      lte: RECORTE.north,
    });
    expect(where?.longitude).toEqual({ gte: RECORTE.west, lte: RECORTE.east });
    // E o teto viaja com a consulta, não é aplicado depois.
    const take = espia.mock.calls[0]?.[0]?.take;
    expect(typeof take).toBe("number");
    expect(take as number).toBeLessThanOrEqual(CTO_MAP_MAX_MARKERS + 1);

    espia.mockRestore();
  });

  it("MAP-19 uma consulta de portas e uma de vínculos para TODAS as caixas", async () => {
    for (let i = 0; i < 5; i += 1) {
      const cto = await novaCto(`CX-N1-${i}`, { capacity: 8 });
      await ocupar(cto.id, 1, `Cliente ${i}`);
    }

    const portas = vi.spyOn(prisma.cTOPort, "findMany");
    const vinculos = vi.spyOn(prisma.customerNetworkConnection, "findMany");
    const view = await ver();

    expect(view.markers).toHaveLength(5);
    // `N+1` num mapa não é uma tela lenta: é uma rajada a cada arrasto.
    expect(portas).toHaveBeenCalledTimes(1);
    expect(vinculos).toHaveBeenCalledTimes(1);
    portas.mockRestore();
    vinculos.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Status derivado
// ---------------------------------------------------------------------------

describe("CTO-3.1 · status do marcador", () => {
  const resumo = (over: Partial<CtoMapView["markers"][number]["summary"]>) => ({
    capacity: 8,
    free: 4,
    occupied: 0,
    reserved: 0,
    damaged: 0,
    historical: 0,
    ...over,
  });

  it("MAP-13 INACTIVE vence tudo", async () => {
    const cto = await novaCto("CX-INATIVA", { capacity: 4 });
    await ocupar(cto.id, 1, "Cliente");
    await marcar(cto.id, (await porta(cto.id, 2)).id, "DAMAGED");
    await setCtoActive(fixture.companyA.id, fixture.adminA.id, cto.id, false);

    expect((await ver()).markers[0].status).toBe("INACTIVE");
    // A precedência é do STATUS; a caixa inativa continua legível.
    expect(deriveCtoMapStatus(false, resumo({ damaged: 1, free: 0 }))).toBe(
      "INACTIVE",
    );
  });

  it("MAP-14 DAMAGED vence FULL", async () => {
    const cto = await novaCto("CX-DANIFICADA", { capacity: 2 });
    await ocupar(cto.id, 1, "Cliente");
    await marcar(cto.id, (await porta(cto.id, 2)).id, "DAMAGED");

    // Sem porta livre E com defeito: manutenção é o que faz alguém se deslocar.
    const marker = (await ver()).markers[0];
    expect(marker.summary.free).toBe(0);
    expect(marker.status).toBe("DAMAGED");
  });

  it("MAP-15 FULL quando não cabe mais ninguém e não há defeito", async () => {
    const cto = await novaCto("CX-LOTADA", { capacity: 2 });
    await ocupar(cto.id, 1, "Cliente 1");
    await ocupar(cto.id, 2, "Cliente 2");

    expect((await ver()).markers[0].status).toBe("FULL");
  });

  it("MAP-15b reservada também tira a vaga: lotada sem ninguém dentro", async () => {
    const cto = await novaCto("CX-RESERVADA", { capacity: 2 });
    await marcar(cto.id, (await porta(cto.id, 1)).id, "RESERVED");
    await marcar(cto.id, (await porta(cto.id, 2)).id, "RESERVED");

    const marker = (await ver()).markers[0];
    expect(marker.summary.occupied).toBe(0);
    expect(marker.summary.free).toBe(0);
    // `free = capacity - occupied` estaria errado aqui, e é o ponto do teste.
    expect(marker.status).toBe("FULL");
  });

  it("MAP-16 AVAILABLE quando há vaga", async () => {
    const cto = await novaCto("CX-LIVRE", { capacity: 4 });
    await ocupar(cto.id, 1, "Cliente");
    expect((await ver()).markers[0].status).toBe("AVAILABLE");
  });

  it("MAP-16b o status NÃO é persistido em lugar nenhum", async () => {
    const cto = await novaCto("CX-SEM-COLUNA", { capacity: 2 });
    const linha = await prisma.cTO.findUniqueOrThrow({ where: { id: cto.id } });
    for (const campo of Object.keys(linha)) {
      expect(campo.toLowerCase()).not.toContain("mapstatus");
      expect(campo.toLowerCase()).not.toContain("status");
    }
  });
});

// ---------------------------------------------------------------------------
// Rota
// ---------------------------------------------------------------------------

describe("CTO-3.1 · rota", () => {
  it("MAP-17 ADMIN e DISPATCHER leem; TECHNICIAN não", async () => {
    await novaCto("CX-PERFIL");

    expect((await pedir(adminA)).status).toBe(200);
    // O mapa é do despacho: é esta a fase que abre a leitura (C-07).
    expect((await pedir(dispatcherA)).status).toBe(200);
    // O técnico lê CTO pelo Field, dentro de uma OS dele.
    expect((await pedir(technicianA)).status).toBe(403);
  });

  it("MAP-17b sem sessão é 401, e a empresa B não vê nada de A", async () => {
    await novaCto("CX-A");
    expect(
      (
        await mapRoute(
          apiRequest(
            "/api/ctos/map?north=-20&south=-21&east=-41&west=-42",
            {},
          ),
        )
      ).status,
    ).toBe(401);

    const res = await pedir(adminB);
    expect(res.status).toBe(200);
    expect((await corpo(res)).data!.map.markers).toHaveLength(0);
  });

  it("MAP-17c capability desligada responde 404, ANTES do perfil", async () => {
    await novaCto("CX-CAP");
    await prisma.company.update({
      where: { id: fixture.companyA.id },
      data: { ctoNetworkEnabled: false },
    });
    // O mesmo perfil que levaria 403 leva 404: a empresa não descobre pela
    // mensagem de erro que existe um módulo que ela não contratou.
    expect((await pedir(technicianA)).status).toBe(404);
    expect((await pedir(adminA)).status).toBe(404);
  });

  it("MAP-18 o DTO não carrega cliente, vínculo nem campo interno", async () => {
    const cto = await novaCto("CX-DTO", { capacity: 4 });
    await ocupar(cto.id, 1, "Fulano Que Nao Deve Aparecer");
    await prisma.cTO.update({
      where: { id: cto.id },
      data: {
        notes: "OBSERVACAO ADMINISTRATIVA SECRETA",
        addressReference: "REFERENCIA INTERNA",
        photoStorageKey: "chave/secreta/da/foto.jpg",
      },
    });

    const texto = await (await pedir(adminA)).text();
    for (const proibido of [
      "Fulano Que Nao Deve Aparecer",
      "OBSERVACAO ADMINISTRATIVA SECRETA",
      "REFERENCIA INTERNA",
      "chave/secreta/da/foto.jpg",
      "photoStorageKey",
      "connectionId",
      "serviceOrderId",
      "customerId",
      fixture.companyA.id,
    ]) {
      expect(texto).not.toContain(proibido);
    }

    /*
      O DTO ganhou `operational` na `CTO-3.2.2` — e ele é só CONTAGEM.

      A afirmação deste teste não mudou: nome de cliente, observação
      administrativa, chave de foto e id de vínculo continuam fora, e a lista de
      proibidos acima é quem garante isso. O que entrou foram cinco números
      derivados — quantos clientes ativos, em que estado, com quanta OS aberta —
      sem nenhuma identidade junto. A lista nominal vive noutra rota, que é
      pedida ao clicar numa caixa.
    */
    const marker = JSON.parse(texto).data.map.markers[0];
    expect(Object.keys(marker.operational).sort()).toEqual([
      "activeCustomerCount",
      "offlineCount",
      "onlineCount",
      "openServiceOrderCount",
      "unknownCount",
    ]);
    expect(Object.keys(marker).sort()).toEqual([
      "active",
      "code",
      "id",
      "latitude",
      "longitude",
      "name",
      "operational",
      "status",
      "summary",
    ]);
  });

  it("MAP-18b o erro não vaza stack, SQL nem nome de tabela", async () => {
    const res = await pedir(adminA, { north: 999 });
    expect(res.status).toBe(400);
    const texto = await res.text();
    for (const proibido of [
      "at Object",
      "node_modules",
      "SELECT",
      "cto_ports",
      "customer_network_connections",
      "prisma",
    ]) {
      expect(texto).not.toContain(proibido);
    }
  });
});
