import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  getConnectivityForCustomers,
  getCustomerDiagnostic,
} from "@/lib/customer-diagnostics";
import {
  CUSTOMER_MAP_MAX_MARKERS,
  getCtoOperationalSummaries,
  getCtoPortCustomers,
  getCustomerMapView,
  getServiceOrderMapView,
} from "@/lib/operational-map";
import { getCtoMapView } from "@/lib/cto-map";
import { searchOperationalMap } from "@/lib/map-search";
import {
  OPEN_SERVICE_ORDER_STATUSES,
  SERVICE_ORDER_TERMINAL_STATUSES,
  isOpenServiceOrder,
} from "@/lib/service-order-labels";
import { createCto } from "@/lib/cto";
import {
  DEFAULT_MAP_LAYERS,
  buildMapViewQuery,
  parseMapViewParams,
} from "@/lib/map-view-params";
import {
  apiRequest,
  createTokenFor,
  seedTestData,
  type TestFixture,
} from "./helpers";

/**
 * # `CTO-3.2.2` — clientes, conectividade e OS abertas no mapa
 *
 * ## A afirmação que atravessa este arquivo
 *
 * **O mapa não decide conectividade.** Ele lê a mesma autoridade que a tela da
 * OS lê — `CustomerDiagnosticSnapshot`, por `customer-diagnostics` — e a única
 * coisa que a fase acrescentou foi uma leitura em LOTE sobre a mesma tabela e o
 * mesmo DTO. Por isso o primeiro bloco compara as duas saídas cliente a
 * cliente: se elas divergirem em qualquer campo, existem duas semânticas, e a
 * fase falhou no seu ponto central.
 *
 * A segunda afirmação é sobre o que NÃO acontece: nenhuma leitura de mapa fala
 * com provider. Abrir, arrastar ou dar zoom não dispara atualização externa e
 * não consome a cota de refresh da OS.
 */

let fixture: TestFixture;

const BASE = { lat: -20.5, lng: -41.5 };
const BBOX = {
  north: BASE.lat + 0.05,
  south: BASE.lat - 0.05,
  east: BASE.lng + 0.05,
  west: BASE.lng - 0.05,
};

let contador = 0;

beforeEach(async () => {
  fixture = await seedTestData();
  contador = 0;
  for (const id of [fixture.companyA.id, fixture.companyB.id]) {
    await prisma.company.update({
      where: { id },
      data: { ctoNetworkEnabled: true },
    });
  }
});

/** Cliente com localização opcional, na autoridade correta. */
async function criarCliente(opcoes: {
  nome: string;
  companyId?: string;
  ativo?: boolean;
  lat?: number | null;
  lng?: number | null;
}) {
  const companyId = opcoes.companyId ?? fixture.companyA.id;
  const cliente = await prisma.customer.create({
    data: {
      companyId,
      name: opcoes.nome,
      active: opcoes.ativo ?? true,
    },
  });
  if (opcoes.lat !== null && opcoes.lat !== undefined) {
    await prisma.customerLocation.create({
      data: {
        companyId,
        customerId: cliente.id,
        latitude: opcoes.lat,
        longitude: opcoes.lng ?? BASE.lng,
        source: "MANUAL",
      },
    });
  }
  return cliente;
}

/** Um snapshot de conectividade — a MESMA tabela que a tela da OS consulta. */
async function gravarLeitura(
  customerId: string,
  status: "ONLINE" | "OFFLINE" | "UNKNOWN",
  companyId = fixture.companyA.id,
  observedAt = new Date(),
) {
  return prisma.customerDiagnosticSnapshot.create({
    data: {
      companyId,
      customerId,
      externalProvider: "MOCK",
      connectivityStatus: status,
      observedAt,
      statusSince: observedAt,
      technology: "1",
    },
  });
}

async function criarOs(
  customerId: string,
  status: "PENDING" | "ASSIGNED" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED",
  companyId = fixture.companyA.id,
  priority: "LOW" | "NORMAL" | "HIGH" | "URGENT" = "NORMAL",
) {
  contador += 1;
  return prisma.serviceOrder.create({
    data: {
      companyId,
      number: 7000 + contador,
      customerId,
      type: "INSTALACAO",
      description: "os de teste",
      status,
      priority,
      ...(status === "COMPLETED" ? { completedAt: new Date() } : {}),
    },
  });
}

/** Uma caixa com portas, e opcionalmente clientes vinculados. */
async function criarCaixaComClientes(
  nome: string,
  clientes: { id: string; porta: number }[],
  companyId = fixture.companyA.id,
  autorId = fixture.adminA.id,
) {
  const cto = await createCto(companyId, autorId, {
    name: nome,
    capacity: 8,
    latitude: BASE.lat,
    longitude: BASE.lng,
  });
  for (const vinculo of clientes) {
    const porta = await prisma.cTOPort.findFirstOrThrow({
      where: { ctoId: cto.id, number: vinculo.porta },
    });
    await prisma.customerNetworkConnection.create({
      data: {
        companyId,
        customerId: vinculo.id,
        ctoPortId: porta.id,
        source: "WEB",
        connectedAt: new Date(),
      },
    });
  }
  return cto;
}

// ---------------------------------------------------------------------------
// CONN-MAP — a autoridade é UMA
// ---------------------------------------------------------------------------

describe("CONN-MAP-01..09 — a leitura em lote amplia a autoridade", () => {
  it("CONN-MAP-01/02/03/04/05 · lote e individual devolvem o MESMO para cada cliente", async () => {
    const online = await criarCliente({ nome: "ONLINE" });
    const offline = await criarCliente({ nome: "OFFLINE" });
    const unknown = await criarCliente({ nome: "UNKNOWN" });
    const semLeitura = await criarCliente({ nome: "SEM LEITURA" });

    await gravarLeitura(online.id, "ONLINE");
    await gravarLeitura(offline.id, "OFFLINE");
    await gravarLeitura(unknown.id, "UNKNOWN");

    const ids = [online.id, offline.id, unknown.id, semLeitura.id];
    const lote = await getConnectivityForCustomers(fixture.companyA.id, ids);

    /*
      Campo a campo, e não só o status.

      `observedAt`, `provider`, `technology` e `serverMaintenance` fazem parte do
      DTO, e uma divergência em qualquer um deles significaria que existem duas
      semânticas — que é exatamente o que esta fase não pode ter criado.
    */
    for (const id of ids) {
      const individual = await getCustomerDiagnostic(fixture.companyA.id, id);
      const emLote = lote.get(id) ?? null;
      expect(emLote, `divergência para ${id}`).toEqual(individual);
    }

    // E os três estados chegam como são — inclusive UNKNOWN, que é um valor
    // positivo do enum e não a ausência de linha.
    expect(lote.get(online.id)!.connectivityStatus).toBe("ONLINE");
    expect(lote.get(offline.id)!.connectivityStatus).toBe("OFFLINE");
    expect(lote.get(unknown.id)!.connectivityStatus).toBe("UNKNOWN");
    // Sem leitura nenhuma, o cliente simplesmente não está no mapa devolvido.
    expect(lote.has(semLeitura.id)).toBe(false);
  });

  it("CONN-MAP-05b · o desempate entre providers é o mesmo dos dois lados", async () => {
    /*
      `@@unique([companyId, customerId, externalProvider])` permite duas linhas
      por cliente numa empresa que trocou de ERP. A leitura individual resolve
      com `observedAt desc`; o lote precisa resolver igual, senão o mapa mostra
      um provider e a tela da OS mostra outro para o mesmo cliente.
    */
    const cliente = await criarCliente({ nome: "DOIS PROVIDERS" });
    const antiga = new Date(Date.now() - 3_600_000);
    await prisma.customerDiagnosticSnapshot.create({
      data: {
        companyId: fixture.companyA.id,
        customerId: cliente.id,
        externalProvider: "RECEITANET",
        connectivityStatus: "OFFLINE",
        observedAt: antiga,
        statusSince: antiga,
      },
    });
    await gravarLeitura(cliente.id, "ONLINE");

    const lote = await getConnectivityForCustomers(fixture.companyA.id, [
      cliente.id,
    ]);
    const individual = await getCustomerDiagnostic(
      fixture.companyA.id,
      cliente.id,
    );

    expect(lote.get(cliente.id)).toEqual(individual);
    expect(lote.get(cliente.id)!.connectivityStatus).toBe("ONLINE");
  });

  it("CONN-MAP-06 · ausência de snapshot vira UNKNOWN, e NUNCA OFFLINE", async () => {
    /*
      O invariante central do módulo de diagnóstico, verificado do lado do mapa.

      Falha de integração é afirmação sobre a INTEGRAÇÃO, nunca sobre o cliente.
      No mapa isso aparece como: cliente sem leitura nenhuma é desenhado como
      "sem leitura", e não pintado de vermelho.
    */
    const cliente = await criarCliente({ nome: "NUNCA CONSULTADO", lat: BASE.lat });
    const vista = await getCustomerMapView(fixture.companyA.id, { bbox: BBOX });

    const marcador = vista.markers.find((m) => m.id === cliente.id)!;
    expect(marcador.connectivityStatus).toBe("UNKNOWN");
    expect(marcador.connectivityStatus).not.toBe("OFFLINE");
    expect(marcador.connectivityObservedAt).toBeNull();
  });

  it("CONN-MAP-07 · o lote NÃO fala com provider nenhum", async () => {
    /*
      Estrutural, sobre o grafo de imports: se o módulo do mapa alcançasse um
      adapter de ERP, arrastar o mapa poderia disparar chamada externa e queimar
      a cota de refresh da OS.
    */
    const fonte = await import("node:fs").then((fs) =>
      fs.readFileSync("src/lib/operational-map.ts", "utf8"),
    );
    const semComentarios = fonte.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const proibido of [
      "erp-adapter",
      "resolveCompanyAdapter",
      "receitanet",
      "ReceitaNet",
      "Sgp",
      "integrations/",
      "refreshCustomerDiagnostic",
    ]) {
      expect(semComentarios, `o mapa alcança ${proibido}`).not.toContain(
        proibido,
      );
    }
  });

  it("CONN-MAP-08 · o lote é tenant-scoped", async () => {
    const meu = await criarCliente({ nome: "MEU" });
    const alheio = await criarCliente({
      nome: "ALHEIO",
      companyId: fixture.companyB.id,
    });
    await gravarLeitura(meu.id, "ONLINE");
    await gravarLeitura(alheio.id, "OFFLINE", fixture.companyB.id);

    const lote = await getConnectivityForCustomers(fixture.companyA.id, [
      meu.id,
      alheio.id,
    ]);

    expect(lote.has(meu.id)).toBe(true);
    expect(lote.has(alheio.id), "conectividade de outra empresa vazou").toBe(
      false,
    );

    // Controle positivo: a empresa B vê o próprio cliente.
    const loteB = await getConnectivityForCustomers(fixture.companyB.id, [
      alheio.id,
    ]);
    expect(loteB.get(alheio.id)!.connectivityStatus).toBe("OFFLINE");
  });

  it("CONN-MAP-09 · o lote é UMA consulta, qualquer que seja o número de clientes", async () => {
    const espiao = vi.spyOn(prisma.customerDiagnosticSnapshot, "findMany");
    const ids = Array.from({ length: 40 }, (_, i) => `cliente-${i}`);

    await getConnectivityForCustomers(fixture.companyA.id, ids);

    // Quarenta clientes, uma consulta. O laço ingênuo daria quarenta.
    expect(espiao).toHaveBeenCalledTimes(1);
    const argumentos = espiao.mock.calls[0]?.[0] as {
      where?: { companyId?: string; customerId?: { in?: string[] } };
    };
    expect(argumentos.where?.companyId).toBe(fixture.companyA.id);
    expect(argumentos.where?.customerId?.in).toHaveLength(40);
    espiao.mockRestore();
  });

  it("CONN-MAP-09b · lista vazia não consulta nada", async () => {
    const espiao = vi.spyOn(prisma.customerDiagnosticSnapshot, "findMany");
    const vazio = await getConnectivityForCustomers(fixture.companyA.id, []);
    expect(vazio.size).toBe(0);
    expect(espiao).not.toHaveBeenCalled();
    espiao.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// OS aberta — o predicado compartilhado
// ---------------------------------------------------------------------------

describe("OSMAP-08 — o predicado de OS aberta é UM", () => {
  it("os terminais são COMPLETED e CANCELLED, e os abertos derivam deles", () => {
    expect([...SERVICE_ORDER_TERMINAL_STATUSES].sort()).toEqual([
      "CANCELLED",
      "COMPLETED",
    ]);
    expect([...OPEN_SERVICE_ORDER_STATUSES].sort()).toEqual([
      "ASSIGNED",
      "IN_PROGRESS",
      "PENDING",
    ]);

    /*
      A lista é a dos FECHADOS, e é isso que a faz envelhecer bem: um estado novo
      na taxonomia nasce FORA dela, portanto aberto. Nascer fechado o faria sumir
      do mapa em silêncio, e sumir é o defeito que ninguém percebe.
    */
    expect(isOpenServiceOrder("PENDING")).toBe(true);
    expect(isOpenServiceOrder("ASSIGNED")).toBe(true);
    expect(isOpenServiceOrder("IN_PROGRESS")).toBe(true);
    expect(isOpenServiceOrder("COMPLETED")).toBe(false);
    expect(isOpenServiceOrder("CANCELLED")).toBe(false);
  });

  it("o predicado NÃO está duplicado nos módulos do mapa", async () => {
    const fs = await import("node:fs");
    for (const arquivo of [
      "src/lib/operational-map.ts",
      "src/lib/map-search.ts",
    ]) {
      const fonte = fs
        .readFileSync(arquivo, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "");
      expect(fonte, `${arquivo} importa o predicado`).toContain(
        "OPEN_SERVICE_ORDER_STATUSES",
      );
      // Nenhuma lista de status escrita à mão ao lado do predicado.
      expect(fonte, `${arquivo} tem lista própria de status`).not.toMatch(
        /\[\s*"PENDING"\s*,\s*"ASSIGNED"/,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// CUSTMAP — a camada de clientes
// ---------------------------------------------------------------------------

describe("CUSTMAP-01..13 — camada de clientes ativos", () => {
  it("CUSTMAP-01/02/03 · ativo com coordenada aparece; inativo e sem local não", async () => {
    const ativo = await criarCliente({ nome: "ATIVO COM LOCAL", lat: BASE.lat });
    const inativo = await criarCliente({
      nome: "INATIVO",
      ativo: false,
      lat: BASE.lat,
    });
    const semLocal = await criarCliente({ nome: "SEM LOCAL", lat: null });

    const vista = await getCustomerMapView(fixture.companyA.id, { bbox: BBOX });
    const ids = vista.markers.map((m) => m.id);

    expect(ids).toContain(ativo.id);
    // Cadastro e conectividade são eixos diferentes; a camada é a do CADASTRO.
    expect(ids, "cliente inativo entrou na camada de ativos").not.toContain(
      inativo.id,
    );
    // Sem coordenada NÃO vira marcador — e nunca `0,0`.
    expect(ids, "cliente sem localização virou marcador").not.toContain(
      semLocal.id,
    );
    expect(vista.missingLocationCount).toBeGreaterThanOrEqual(1);
  });

  it("CUSTMAP-04 · cliente de outra empresa não vaza, nem como coordenada", async () => {
    const meu = await criarCliente({ nome: "MEU", lat: BASE.lat });
    const alheio = await criarCliente({
      nome: "ALHEIO",
      companyId: fixture.companyB.id,
      lat: BASE.lat,
    });

    const vista = await getCustomerMapView(fixture.companyA.id, { bbox: BBOX });
    const ids = vista.markers.map((m) => m.id);
    expect(ids).toContain(meu.id);
    expect(ids).not.toContain(alheio.id);

    // Nem o nome, nem a coordenada: uma coordenada isolada já é vazamento.
    const textoInteiro = JSON.stringify(vista);
    expect(textoInteiro).not.toContain("ALHEIO");
    expect(textoInteiro).not.toContain(alheio.id);

    // Controle positivo.
    const vistaB = await getCustomerMapView(fixture.companyB.id, { bbox: BBOX });
    expect(vistaB.markers.map((m) => m.id)).toContain(alheio.id);
  });

  it("CUSTMAP-05 · o recorte e o tenant estão no WHERE, não em memória", async () => {
    /*
      A `CTO-3.1` mediu que filtrar em memória produz a MESMA lista — nenhum
      teste de resultado distingue os dois. O que muda é o banco devolver a
      carteira inteira antes, então a asserção precisa ser sobre a CONSULTA.
    */
    const espiao = vi
      .spyOn(prisma.customer, "findMany")
      .mockResolvedValue([] as never);

    await getCustomerMapView("empresa-x", { bbox: BBOX });

    const argumentos = espiao.mock.calls[0]?.[0] as {
      where?: Record<string, unknown>;
      take?: number;
      select?: Record<string, unknown>;
    };
    expect(argumentos.where?.companyId).toBe("empresa-x");
    expect(argumentos.where?.active).toBe(true);
    expect(argumentos.where?.location).toBeDefined();
    expect(argumentos.take).toBe(CUSTOMER_MAP_MAX_MARKERS + 1);

    // O `select` é a primeira barreira do DTO mínimo.
    expect(Object.keys(argumentos.select ?? {}).sort()).toEqual([
      "id",
      "location",
      "name",
    ]);
    espiao.mockRestore();
  });

  it("CUSTMAP-06/07 · o teto é do servidor, e o truncamento é dito", async () => {
    const vista = await getCustomerMapView(fixture.companyA.id, {
      bbox: BBOX,
      // Pedir mais que o teto não amplia nada: quem manda é o servidor.
      limit: 99_999,
    });
    expect(vista.limit).toBe(CUSTOMER_MAP_MAX_MARKERS);

    // Com poucos clientes, nada é truncado — o sinal não é decorativo.
    expect(vista.truncated).toBe(false);
  });

  it("CUSTMAP-08 · o DTO é mínimo, afirmado por igualdade de chaves", async () => {
    const cliente = await criarCliente({ nome: "DTO", lat: BASE.lat });
    await gravarLeitura(cliente.id, "ONLINE");

    const vista = await getCustomerMapView(fixture.companyA.id, { bbox: BBOX });
    const marcador = vista.markers.find((m) => m.id === cliente.id)!;

    expect(Object.keys(marcador).sort()).toEqual([
      "connectivityObservedAt",
      "connectivityStatus",
      "cto",
      "hasUrgentOpenServiceOrder",
      "id",
      "latitude",
      "longitude",
      "name",
      "openServiceOrderCount",
    ]);

    /*
      E nada de dado sensível sobrando no payload inteiro. O Prisma traz o que o
      `select` pede, mas um `include` acrescentado sem cuidado no futuro
      passaria por aqui — este teste é a rede para isso.
    */
    const texto = JSON.stringify(vista);
    for (const proibido of [
      "document",
      "email",
      "phone",
      "password",
      "companyId",
      "externalId",
    ]) {
      expect(texto, `o DTO vaza ${proibido}`).not.toContain(proibido);
    }
  });

  it("CUSTMAP-09/10/11/12 · os três estados, e a OS não apaga o estado", async () => {
    const online = await criarCliente({ nome: "C ONLINE", lat: BASE.lat });
    const offline = await criarCliente({ nome: "C OFFLINE", lat: BASE.lat });
    const sem = await criarCliente({ nome: "C SEM LEITURA", lat: BASE.lat });
    await gravarLeitura(online.id, "ONLINE");
    await gravarLeitura(offline.id, "OFFLINE");

    // O offline também tem OS aberta: os dois sinais precisam conviver.
    await criarOs(offline.id, "ASSIGNED");

    const vista = await getCustomerMapView(fixture.companyA.id, { bbox: BBOX });
    const porId = new Map(vista.markers.map((m) => [m.id, m]));

    expect(porId.get(online.id)!.connectivityStatus).toBe("ONLINE");
    expect(porId.get(offline.id)!.connectivityStatus).toBe("OFFLINE");
    expect(porId.get(sem.id)!.connectivityStatus).toBe("UNKNOWN");

    /*
      CUSTMAP-12: OS aberta e conectividade são dimensões independentes.

      Precisamos enxergar `OFFLINE` **e** `OS ABERTA` ao mesmo tempo — um
      marcador que trocasse o estado por "tem OS" esconderia justamente a
      informação que explica a OS.
    */
    const comOs = porId.get(offline.id)!;
    expect(comOs.openServiceOrderCount).toBe(1);
    expect(comOs.connectivityStatus).toBe("OFFLINE");

    // E quem não tem OS mostra zero, sem deixar de ter estado.
    expect(porId.get(online.id)!.openServiceOrderCount).toBe(0);
    expect(porId.get(online.id)!.connectivityStatus).toBe("ONLINE");
  });

  it("CUSTMAP-09b · só OS ABERTA conta; concluída e cancelada não", async () => {
    const cliente = await criarCliente({ nome: "CONTAGEM", lat: BASE.lat });
    await criarOs(cliente.id, "PENDING");
    await criarOs(cliente.id, "IN_PROGRESS");
    await criarOs(cliente.id, "COMPLETED");
    await criarOs(cliente.id, "CANCELLED");

    const vista = await getCustomerMapView(fixture.companyA.id, { bbox: BBOX });
    expect(
      vista.markers.find((m) => m.id === cliente.id)!.openServiceOrderCount,
    ).toBe(2);
  });

  /*
    URGCLIENT — o cliente com OS URGENTE aberta (`CTO-3.2.2e`).

    A autoridade é UMA: `ServiceOrder.priority === URGENT`, entre as OS que o
    predicado consolidado considera abertas. Cada teste abaixo é um caminho
    pelo qual alguém poderia "deduzir" urgência de outra coisa — e prova que
    o mapa não deduz.
  */
  it("URGCLIENT-01 · OS URGENT aberta marca o cliente, sem apagar o estado", async () => {
    const cliente = await criarCliente({ nome: "URG ABERTA", lat: BASE.lat });
    await gravarLeitura(cliente.id, "ONLINE");
    await criarOs(cliente.id, "ASSIGNED", fixture.companyA.id, "URGENT");

    const vista = await getCustomerMapView(fixture.companyA.id, { bbox: BBOX });
    const m = vista.markers.find((x) => x.id === cliente.id)!;
    expect(m.hasUrgentOpenServiceOrder).toBe(true);
    // ADICIONAL ao estado, nunca substituto: o online continua online.
    expect(m.connectivityStatus).toBe("ONLINE");
    expect(m.openServiceOrderCount).toBe(1);
  });

  it("URGCLIENT-02 · OS URGENT concluída ou cancelada NÃO marca", async () => {
    const cliente = await criarCliente({ nome: "URG FECHADA", lat: BASE.lat });
    await criarOs(cliente.id, "COMPLETED", fixture.companyA.id, "URGENT");
    await criarOs(cliente.id, "CANCELLED", fixture.companyA.id, "URGENT");
    // E uma aberta NORMAL, para provar que "tem OS aberta" ≠ "tem urgente".
    await criarOs(cliente.id, "PENDING", fixture.companyA.id, "NORMAL");

    const vista = await getCustomerMapView(fixture.companyA.id, { bbox: BBOX });
    const m = vista.markers.find((x) => x.id === cliente.id)!;
    expect(m.openServiceOrderCount).toBe(1);
    expect(m.hasUrgentOpenServiceOrder).toBe(false);
  });

  it("URGCLIENT-03 · HIGH não é urgente — nem LOW, nem NORMAL", async () => {
    const cliente = await criarCliente({ nome: "URG ALTA", lat: BASE.lat });
    await criarOs(cliente.id, "ASSIGNED", fixture.companyA.id, "HIGH");
    await criarOs(cliente.id, "IN_PROGRESS", fixture.companyA.id, "LOW");
    await criarOs(cliente.id, "PENDING", fixture.companyA.id, "NORMAL");

    const vista = await getCustomerMapView(fixture.companyA.id, { bbox: BBOX });
    const m = vista.markers.find((x) => x.id === cliente.id)!;
    expect(m.openServiceOrderCount).toBe(3);
    expect(m.hasUrgentOpenServiceOrder).toBe(false);
  });

  it("URGCLIENT-03b · a urgência de UM cliente não vaza para o vizinho", async () => {
    const urgente = await criarCliente({ nome: "URG A", lat: BASE.lat });
    const vizinho = await criarCliente({ nome: "URG B", lat: BASE.lat });
    await criarOs(urgente.id, "ASSIGNED", fixture.companyA.id, "URGENT");
    await criarOs(vizinho.id, "ASSIGNED", fixture.companyA.id, "NORMAL");

    const vista = await getCustomerMapView(fixture.companyA.id, { bbox: BBOX });
    const porId = new Map(vista.markers.map((m) => [m.id, m]));
    expect(porId.get(urgente.id)!.hasUrgentOpenServiceOrder).toBe(true);
    expect(porId.get(vizinho.id)!.hasUrgentOpenServiceOrder).toBe(false);
  });

  it("URGCLIENT-07 · a urgência sai da MESMA consulta que conta as abertas — zero N+1", async () => {
    const espiaoGroupBy = vi.spyOn(prisma.serviceOrder, "groupBy");
    const espiaoFindMany = vi.spyOn(prisma.serviceOrder, "findMany");
    const espiaoCount = vi.spyOn(prisma.serviceOrder, "count");

    const clientes = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        criarCliente({ nome: `URG N ${i}`, lat: BASE.lat }),
      ),
    );
    for (let i = 0; i < clientes.length; i += 1) {
      await criarOs(clientes[i].id, "ASSIGNED", fixture.companyA.id, i % 2 === 0 ? "URGENT" : "NORMAL");
    }

    espiaoGroupBy.mockClear();
    espiaoFindMany.mockClear();
    espiaoCount.mockClear();

    const vista = await getCustomerMapView(fixture.companyA.id, { bbox: BBOX });

    /*
      OITO clientes, UMA consulta de OS. O caminho ingênuo — para cada
      cliente, "tem urgente?" — daria oito a mais; uma segunda agregação só
      para a urgência daria uma a mais. Nem uma, nem outra.
    */
    expect(espiaoGroupBy).toHaveBeenCalledTimes(1);
    expect(espiaoFindMany).not.toHaveBeenCalled();
    expect(espiaoCount).not.toHaveBeenCalled();

    // E a resposta está certa, senão "uma consulta" seria uma consulta errada.
    const porId = new Map(vista.markers.map((m) => [m.id, m]));
    for (let i = 0; i < clientes.length; i += 1) {
      expect(porId.get(clientes[i].id)!.hasUrgentOpenServiceOrder, `cliente ${i}`).toBe(
        i % 2 === 0,
      );
    }

    espiaoGroupBy.mockRestore();
    espiaoFindMany.mockRestore();
    espiaoCount.mockRestore();
  });

  it("CUSTMAP-14 · o vínculo de CTO vem do registro, nunca de proximidade", async () => {
    const cliente = await criarCliente({ nome: "VINCULADO", lat: BASE.lat });
    const solto = await criarCliente({ nome: "SOLTO", lat: BASE.lat });
    const cto = await criarCaixaComClientes("CX VINCULO", [
      { id: cliente.id, porta: 3 },
    ]);

    const vista = await getCustomerMapView(fixture.companyA.id, { bbox: BBOX });
    const porId = new Map(vista.markers.map((m) => [m.id, m]));

    expect(porId.get(cliente.id)!.cto).toEqual({
      ctoId: cto.id,
      ctoName: "CX VINCULO",
      portNumber: 3,
    });

    /*
      O cliente SOLTO está na mesma coordenada da caixa e não recebe vínculo.

      É a prova de que a relação vem de `CustomerNetworkConnection`, e não de
      distância: se fosse geográfica, os dois teriam a mesma resposta.
    */
    expect(porId.get(solto.id)!.cto).toBeNull();
  });

  it("CUSTMAP-15 · filtros de conectividade e de OS aberta", async () => {
    const online = await criarCliente({ nome: "F ONLINE", lat: BASE.lat });
    const offline = await criarCliente({ nome: "F OFFLINE", lat: BASE.lat });
    await gravarLeitura(online.id, "ONLINE");
    await gravarLeitura(offline.id, "OFFLINE");
    await criarOs(offline.id, "PENDING");

    const soOffline = await getCustomerMapView(fixture.companyA.id, {
      bbox: BBOX,
      connectivity: ["OFFLINE"],
    });
    expect(soOffline.markers.map((m) => m.id)).toEqual([offline.id]);

    const comOs = await getCustomerMapView(fixture.companyA.id, {
      bbox: BBOX,
      withOpenServiceOrder: true,
    });
    expect(comOs.markers.map((m) => m.id)).toEqual([offline.id]);

    const semOs = await getCustomerMapView(fixture.companyA.id, {
      bbox: BBOX,
      withOpenServiceOrder: false,
    });
    expect(semOs.markers.map((m) => m.id)).toEqual([online.id]);
  });
});

// ---------------------------------------------------------------------------
// OSMAP — a camada de OS abertas
// ---------------------------------------------------------------------------

describe("OSMAP-01..07 — camada de OS abertas", () => {
  it("OSMAP-01/02 · OS aberta aparece; fechada não", async () => {
    const cliente = await criarCliente({ nome: "CLI OS", lat: BASE.lat });
    const aberta = await criarOs(cliente.id, "ASSIGNED");
    const fechada = await criarOs(cliente.id, "COMPLETED");
    const cancelada = await criarOs(cliente.id, "CANCELLED");

    const vista = await getServiceOrderMapView(fixture.companyA.id, {
      bbox: BBOX,
    });
    const ids = vista.markers.map((m) => m.id);

    expect(ids).toContain(aberta.id);
    expect(ids).not.toContain(fechada.id);
    expect(ids).not.toContain(cancelada.id);
  });

  it("OSMAP-03 · OS de outra empresa não vaza", async () => {
    const meu = await criarCliente({ nome: "CLI A", lat: BASE.lat });
    const alheio = await criarCliente({
      nome: "CLI B",
      companyId: fixture.companyB.id,
      lat: BASE.lat,
    });
    const minha = await criarOs(meu.id, "PENDING");
    const dela = await criarOs(alheio.id, "PENDING", fixture.companyB.id);

    const vista = await getServiceOrderMapView(fixture.companyA.id, {
      bbox: BBOX,
    });
    expect(vista.markers.map((m) => m.id)).toContain(minha.id);
    expect(vista.markers.map((m) => m.id)).not.toContain(dela.id);
    expect(JSON.stringify(vista)).not.toContain("CLI B");

    const vistaB = await getServiceOrderMapView(fixture.companyB.id, {
      bbox: BBOX,
    });
    expect(vistaB.markers.map((m) => m.id)).toContain(dela.id);
  });

  it("OSMAP-04 · OS sem cliente localizável NÃO recebe marcador falso", async () => {
    /*
      `ServiceOrder` não tem coordenada própria — a posição vem do cliente. Sem
      localização, a OS entra no CONTADOR, e nunca na posição da CTO nem no
      centro do bairro.
    */
    const semLocal = await criarCliente({ nome: "CLI SEM LOCAL", lat: null });
    const os = await criarOs(semLocal.id, "PENDING");

    const vista = await getServiceOrderMapView(fixture.companyA.id, {
      bbox: BBOX,
    });
    expect(vista.markers.map((m) => m.id)).not.toContain(os.id);
    expect(vista.missingLocationCount).toBeGreaterThanOrEqual(1);
  });

  it("OSMAP-05 · o DTO é mínimo", async () => {
    const cliente = await criarCliente({ nome: "CLI DTO", lat: BASE.lat });
    await gravarLeitura(cliente.id, "OFFLINE");
    await criarOs(cliente.id, "ASSIGNED");

    const vista = await getServiceOrderMapView(fixture.companyA.id, {
      bbox: BBOX,
    });
    expect(Object.keys(vista.markers[0]).sort()).toEqual([
      "connectivityObservedAt",
      "connectivityStatus",
      "cto",
      "customerId",
      "customerName",
      "id",
      "latitude",
      "longitude",
      "number",
      "openedAt",
      // A `CTO-3.2.2c` passou a carregar a prioridade: ela é a ÚNICA autoridade
      // de urgência, e sem ela o mapa teria de deduzir — que é o que se proíbe.
      "priority",
      "status",
      "technicianName",
      "typeName",
    ]);

    const texto = JSON.stringify(vista);
    for (const proibido of ["document", "password", "companyId", "version"]) {
      expect(texto, `o DTO da OS vaza ${proibido}`).not.toContain(proibido);
    }
  });

  it("OSMAP-06 · a OS carrega a conectividade do cliente, da mesma autoridade", async () => {
    const cliente = await criarCliente({ nome: "CLI CONN", lat: BASE.lat });
    await gravarLeitura(cliente.id, "OFFLINE");
    await criarOs(cliente.id, "IN_PROGRESS");

    const vista = await getServiceOrderMapView(fixture.companyA.id, {
      bbox: BBOX,
    });
    const marcador = vista.markers[0];

    // Os dois sinais ao mesmo tempo: OS aberta E cliente offline.
    expect(marcador.status).toBe("IN_PROGRESS");
    expect(marcador.connectivityStatus).toBe("OFFLINE");

    // E é a MESMA autoridade que a tela da OS consulta.
    const individual = await getCustomerDiagnostic(
      fixture.companyA.id,
      cliente.id,
    );
    expect(marcador.connectivityStatus).toBe(individual!.connectivityStatus);
  });

  it("OSMAP-07 · o teto é do servidor", async () => {
    const vista = await getServiceOrderMapView(fixture.companyA.id, {
      bbox: BBOX,
      limit: 99_999,
    });
    expect(vista.limit).toBeLessThanOrEqual(200);
  });
});

// ---------------------------------------------------------------------------
// CTOSUM — o resumo operacional da caixa
// ---------------------------------------------------------------------------

describe("CTOSUM-01..10 — resumo operacional por CTO", () => {
  it("CTOSUM-01..05 · as cinco contagens saem certas", async () => {
    const online = await criarCliente({ nome: "S ONLINE", lat: BASE.lat });
    const offline = await criarCliente({ nome: "S OFFLINE", lat: BASE.lat });
    const sem = await criarCliente({ nome: "S SEM", lat: BASE.lat });
    await gravarLeitura(online.id, "ONLINE");
    await gravarLeitura(offline.id, "OFFLINE");
    await criarOs(offline.id, "PENDING");
    await criarOs(sem.id, "ASSIGNED");
    await criarOs(sem.id, "COMPLETED");

    const cto = await criarCaixaComClientes("CX RESUMO", [
      { id: online.id, porta: 1 },
      { id: offline.id, porta: 2 },
      { id: sem.id, porta: 3 },
    ]);

    const resumo = (
      await getCtoOperationalSummaries(fixture.companyA.id, [cto.id])
    ).summaries.get(cto.id)!;

    expect(resumo.activeCustomerCount).toBe(3);
    expect(resumo.onlineCount).toBe(1);
    expect(resumo.offlineCount).toBe(1);
    // Sem leitura conta como UNKNOWN, e nunca engorda o offline.
    expect(resumo.unknownCount).toBe(1);
    // Só as abertas: a concluída do terceiro cliente não entra.
    expect(resumo.openServiceOrderCount).toBe(2);
  });

  it("CTOSUM-06/07/08 · mover, desconectar e histórico", async () => {
    const cliente = await criarCliente({ nome: "S MOVEL", lat: BASE.lat });
    const origem = await criarCaixaComClientes("CX ORIGEM", [
      { id: cliente.id, porta: 1 },
    ]);
    const destino = await criarCaixaComClientes("CX DESTINO", []);

    const antesReadout = await getCtoOperationalSummaries(fixture.companyA.id, [
      origem.id,
      destino.id,
    ]);
    const antes = antesReadout.summaries;
    expect(antes.get(origem.id)!.activeCustomerCount).toBe(1);
    expect(antes.get(destino.id)!.activeCustomerCount).toBe(0);

    /*
      Mover é FECHAR o vínculo antigo e ABRIR o novo — a história é preservada.
      O resumo precisa contar só o vínculo ATIVO: se lesse o histórico, a caixa
      de origem continuaria contando um cliente que já saiu dela.
    */
    await prisma.customerNetworkConnection.updateMany({
      where: { customerId: cliente.id, disconnectedAt: null },
      data: { disconnectedAt: new Date() },
    });
    const portaDestino = await prisma.cTOPort.findFirstOrThrow({
      where: { ctoId: destino.id, number: 1 },
    });
    await prisma.customerNetworkConnection.create({
      data: {
        companyId: fixture.companyA.id,
        customerId: cliente.id,
        ctoPortId: portaDestino.id,
        source: "WEB",
        connectedAt: new Date(),
      },
    });

    const depoisReadout = await getCtoOperationalSummaries(fixture.companyA.id, [
      origem.id,
      destino.id,
    ]);
    const depois = depoisReadout.summaries;
    expect(depois.get(origem.id)!.activeCustomerCount).toBe(0);
    expect(depois.get(destino.id)!.activeCustomerCount).toBe(1);

    // E desconectar de vez zera os dois.
    await prisma.customerNetworkConnection.updateMany({
      where: { customerId: cliente.id, disconnectedAt: null },
      data: { disconnectedAt: new Date() },
    });
    const finalReadout = await getCtoOperationalSummaries(fixture.companyA.id, [
      origem.id,
      destino.id,
    ]);
    const final = finalReadout.summaries;
    expect(final.get(destino.id)!.activeCustomerCount).toBe(0);
  });

  it("CTOSUM-06b · cliente INATIVO não conta como cliente ativo", async () => {
    const inativo = await criarCliente({
      nome: "S INATIVO",
      ativo: false,
      lat: BASE.lat,
    });
    const cto = await criarCaixaComClientes("CX INATIVO", [
      { id: inativo.id, porta: 1 },
    ]);

    const resumo = (
      await getCtoOperationalSummaries(fixture.companyA.id, [cto.id])
    ).summaries.get(cto.id)!;

    /*
      A porta continua OCUPADA — o cabo está lá — e o cliente não conta como
      ativo. Os dois números respondem perguntas diferentes, e colapsá-los
      esconderia exatamente este caso.
    */
    expect(resumo.activeCustomerCount).toBe(0);

    const mapa = await getCtoMapView(fixture.companyA.id, { bbox: BBOX });
    const marcador = mapa.markers.find((m) => m.id === cto.id)!;
    expect(marcador.summary.occupied).toBe(1);
    expect(marcador.operational.activeCustomerCount).toBe(0);
  });

  it("CTOSUM-09 · o resumo é constante em consultas, não N+1", async () => {
    const espiaoVinculo = vi.spyOn(prisma.customerNetworkConnection, "findMany");
    const espiaoSnapshot = vi.spyOn(prisma.customerDiagnosticSnapshot, "findMany");
    const espiaoOs = vi.spyOn(prisma.serviceOrder, "groupBy");

    const clientes = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        criarCliente({ nome: `N1 ${i}`, lat: BASE.lat }),
      ),
    );
    const ctos = await Promise.all(
      clientes.map((c, i) =>
        criarCaixaComClientes(`CX N ${i}`, [{ id: c.id, porta: 1 }]),
      ),
    );

    espiaoVinculo.mockClear();
    espiaoSnapshot.mockClear();
    espiaoOs.mockClear();

    await getCtoOperationalSummaries(
      fixture.companyA.id,
      ctos.map((c) => c.id),
    );

    /*
      SEIS caixas, UMA consulta de cada tipo. O caminho ingênuo — percorrer as
      caixas perguntando vínculos, depois cada vínculo perguntando conectividade
      — daria dezoito.
    */
    expect(espiaoVinculo).toHaveBeenCalledTimes(1);
    expect(espiaoSnapshot).toHaveBeenCalledTimes(1);
    expect(espiaoOs).toHaveBeenCalledTimes(1);

    espiaoVinculo.mockRestore();
    espiaoSnapshot.mockRestore();
    espiaoOs.mockRestore();
  });

  it("CTOSUM-10 · nenhuma contagem é persistida", async () => {
    /*
      O resumo é derivado na leitura. Se virasse coluna, seria um segundo lugar
      que precisa concordar com o vínculo e com o snapshot — e o que diverge é
      sempre o que ninguém revisou. É a mesma razão de `OCCUPIED` nunca ter
      virado coluna.
    */
    const fs = await import("node:fs");
    const schema = fs.readFileSync("prisma/schema.prisma", "utf8");
    for (const proibido of [
      "onlineCount",
      "offlineCount",
      "unknownCount",
      "openServiceOrderCount",
      "activeCustomerCount",
    ]) {
      expect(schema, `o schema ganhou ${proibido}`).not.toContain(proibido);
    }
  });
});

// ---------------------------------------------------------------------------
// PORTCLIENT — clientes por porta
// ---------------------------------------------------------------------------

describe("PORTCLIENT-01..08 — clientes por porta da CTO", () => {
  it("PORTCLIENT-01/02/03 · vínculo ativo aparece; vazio e histórico não", async () => {
    const atual = await criarCliente({ nome: "P ATUAL", lat: BASE.lat });
    const antigo = await criarCliente({ nome: "P ANTIGO", lat: BASE.lat });
    const cto = await criarCaixaComClientes("CX PORTAS", [
      { id: atual.id, porta: 2 },
    ]);

    // Um vínculo histórico na porta 5, já encerrado.
    const porta5 = await prisma.cTOPort.findFirstOrThrow({
      where: { ctoId: cto.id, number: 5 },
    });
    await prisma.customerNetworkConnection.create({
      data: {
        companyId: fixture.companyA.id,
        customerId: antigo.id,
        ctoPortId: porta5.id,
        source: "WEB",
        connectedAt: new Date(Date.now() - 86_400_000),
        disconnectedAt: new Date(),
      },
    });

    const lista = await getCtoPortCustomers(fixture.companyA.id, cto.id);

    expect(lista).toHaveLength(1);
    expect(lista[0].portNumber).toBe(2);
    expect(lista[0].customerId).toBe(atual.id);
    // Histórico não é presença: a porta 5 não aparece com o cliente antigo.
    expect(lista.map((c) => c.customerId)).not.toContain(antigo.id);
  });

  it("PORTCLIENT-04/05/06 · cadastro, conectividade e OS convivem", async () => {
    const ativo = await criarCliente({ nome: "P ATIVO", lat: BASE.lat });
    const inativo = await criarCliente({
      nome: "P INATIVO",
      ativo: false,
      lat: BASE.lat,
    });
    await gravarLeitura(ativo.id, "OFFLINE");
    await criarOs(ativo.id, "ASSIGNED");

    const cto = await criarCaixaComClientes("CX MISTA", [
      { id: ativo.id, porta: 1 },
      { id: inativo.id, porta: 2 },
    ]);

    const lista = await getCtoPortCustomers(fixture.companyA.id, cto.id);
    const porPorta = new Map(lista.map((c) => [c.portNumber, c]));

    /*
      O cliente INATIVO aparece na lista da porta, e aparece marcado.

      A porta está ocupada — o cabo está lá —, e omiti-lo faria a porta parecer
      livre. O que a lista faz é dizer a situação CADASTRAL ao lado da
      conectividade, que são eixos diferentes.
    */
    expect(porPorta.get(2)!.customerActive).toBe(false);
    expect(porPorta.get(1)!.customerActive).toBe(true);

    expect(porPorta.get(1)!.connectivityStatus).toBe("OFFLINE");
    expect(porPorta.get(1)!.openServiceOrderCount).toBe(1);
    // Sem leitura é UNKNOWN, nunca OFFLINE.
    expect(porPorta.get(2)!.connectivityStatus).toBe("UNKNOWN");
  });

  it("PORTCLIENT-07/08 · tenant isolado e DTO mínimo", async () => {
    const alheio = await criarCliente({
      nome: "P ALHEIO",
      companyId: fixture.companyB.id,
      lat: BASE.lat,
    });
    const ctoB = await criarCaixaComClientes(
      "CX DA B",
      [{ id: alheio.id, porta: 1 }],
      fixture.companyB.id,
      fixture.adminB.id,
    );

    // A empresa A pedindo a caixa da B não recebe nada.
    const cruzado = await getCtoPortCustomers(fixture.companyA.id, ctoB.id);
    expect(cruzado).toEqual([]);

    // Controle positivo.
    const proprio = await getCtoPortCustomers(fixture.companyB.id, ctoB.id);
    expect(proprio).toHaveLength(1);

    expect(Object.keys(proprio[0]).sort()).toEqual([
      "connectivityObservedAt",
      "connectivityStatus",
      "customerActive",
      "customerId",
      "customerName",
      "openServiceOrderCount",
      "portNumber",
    ]);
  });
});

// ---------------------------------------------------------------------------
// MAPSEARCH — a busca operacional
// ---------------------------------------------------------------------------

describe("MAPSEARCH-01..10 — busca de CTO, cliente e OS", () => {
  it("MAPSEARCH-01/02/03/07 · os três tipos, com o tipo correto", async () => {
    const cliente = await criarCliente({ nome: "ALVO CLIENTE", lat: BASE.lat });
    await criarCaixaComClientes("ALVO CAIXA", []);
    const os = await criarOs(cliente.id, "PENDING");

    const porNome = await searchOperationalMap(fixture.companyA.id, "ALVO");
    const tipos = new Map(porNome.hits.map((h) => [h.type, h]));

    expect(tipos.get("CTO")!.label).toBe("ALVO CAIXA");
    expect(tipos.get("CUSTOMER")!.label).toBe("ALVO CLIENTE");

    // A OS é achada pelo NÚMERO, que é como as pessoas falam dela.
    const porNumero = await searchOperationalMap(
      fixture.companyA.id,
      String(os.number),
    );
    const hitOs = porNumero.hits.find((h) => h.type === "SERVICE_ORDER")!;
    expect(hitOs.id).toBe(os.id);
    expect(hitOs.label).toBe(`OS Nº ${os.number}`);
  });

  it("MAPSEARCH-04 · a busca de A não encontra nada de B", async () => {
    await criarCliente({
      nome: "SEGREDO DA B",
      companyId: fixture.companyB.id,
      lat: BASE.lat,
    });
    await criarCaixaComClientes(
      "SEGREDO CAIXA B",
      [],
      fixture.companyB.id,
      fixture.adminB.id,
    );

    const resultado = await searchOperationalMap(fixture.companyA.id, "SEGREDO");
    expect(resultado.hits).toEqual([]);

    // Controle positivo: a B encontra os próprios.
    const daB = await searchOperationalMap(fixture.companyB.id, "SEGREDO");
    expect(daB.hits.length).toBeGreaterThanOrEqual(2);
  });

  it("MAPSEARCH-05/06 · com coordenada centraliza; sem coordenada não inventa", async () => {
    const comLocal = await criarCliente({ nome: "BUSCA COM", lat: BASE.lat });
    const semLocal = await criarCliente({ nome: "BUSCA SEM", lat: null });

    const resultado = await searchOperationalMap(fixture.companyA.id, "BUSCA");
    const porId = new Map(resultado.hits.map((h) => [h.id, h]));

    expect(porId.get(comLocal.id)!.latitude).toBeCloseTo(BASE.lat, 5);
    // Sem localização: aparece na busca, e NÃO recebe posição inventada.
    expect(porId.get(semLocal.id)).toBeDefined();
    expect(porId.get(semLocal.id)!.latitude).toBeNull();
    expect(porId.get(semLocal.id)!.longitude).toBeNull();
  });

  it("MAPSEARCH-08/09 · só cliente ATIVO e só OS ABERTA entram", async () => {
    const inativo = await criarCliente({
      nome: "BUSCA INATIVO",
      ativo: false,
      lat: BASE.lat,
    });
    const cliente = await criarCliente({ nome: "BUSCA ATIVO", lat: BASE.lat });
    const fechada = await criarOs(cliente.id, "COMPLETED");

    const porNome = await searchOperationalMap(fixture.companyA.id, "BUSCA");
    expect(porNome.hits.map((h) => h.id)).not.toContain(inativo.id);

    const porNumero = await searchOperationalMap(
      fixture.companyA.id,
      String(fechada.number),
    );
    expect(porNumero.hits.map((h) => h.id)).not.toContain(fechada.id);
  });

  it("MAPSEARCH-10 · o DTO da busca é mínimo e uniforme entre os tipos", async () => {
    const cliente = await criarCliente({ nome: "ENVELOPE", lat: BASE.lat });
    await criarCaixaComClientes("ENVELOPE CX", []);
    await criarOs(cliente.id, "PENDING");

    const resultado = await searchOperationalMap(
      fixture.companyA.id,
      "ENVELOPE",
    );
    expect(resultado.hits.length).toBeGreaterThanOrEqual(2);

    for (const hit of resultado.hits) {
      expect(Object.keys(hit).sort()).toEqual([
        "id",
        "label",
        "latitude",
        "longitude",
        "secondaryLabel",
        "type",
      ]);
    }

    const texto = JSON.stringify(resultado);
    for (const proibido of ["document", "companyId", "password", "email"]) {
      expect(texto, `a busca vaza ${proibido}`).not.toContain(proibido);
    }
  });

  it("MAPSEARCH-11 · termo não numérico não consulta OS", async () => {
    /*
      `ServiceOrder.number` é inteiro, e `contains` não se aplica. Tentar
      converter "João" produziria `NaN` numa consulta que o banco recusaria — e
      a busca inteira falharia por causa de um tipo que nunca ia casar.
    */
    const espiao = vi.spyOn(prisma.serviceOrder, "findMany");
    await searchOperationalMap(fixture.companyA.id, "Joao da Silva");
    expect(espiao).not.toHaveBeenCalled();
    espiao.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// As ROTAS — quem pode, e o que sai
// ---------------------------------------------------------------------------

describe("MAPAPI — permissões e tenancy pelas rotas", () => {
  const ORIGIN = { Origin: "http://localhost" };

  async function chamar(
    rota: (r: Request) => Promise<Response>,
    caminho: string,
    token: string,
  ) {
    const res = await rota(
      apiRequest(caminho, { headers: { ...ORIGIN } }, token),
    );
    return { status: res.status, body: await res.json() };
  }

  const RECORTE = `north=${BBOX.north}&south=${BBOX.south}&east=${BBOX.east}&west=${BBOX.west}`;

  it("MAPAPI-01 · a camada de clientes é de ADMIN — e só", async () => {
    const { GET } = await import("@/app/api/map/customers/route");
    await criarCliente({ nome: "API CLIENTE", lat: BASE.lat });

    const admin = await createTokenFor(fixture.adminA.id);
    const dispatcher = await createTokenFor(fixture.dispatcherA.id);
    const tecnico = await createTokenFor(fixture.techA.id);

    expect((await chamar(GET, `/api/map/customers?${RECORTE}`, admin)).status).toBe(
      200,
    );

    /*
      403 para o DISPATCHER, e a decisão é de PRIVACIDADE, não de conveniência.

      Ele lê o mapa de caixas e de OS abertas — o trabalho dele. Mostrar onde
      cada assinante mora é superfície de dado pessoal que nenhuma decisão
      aprovada estendeu ao despacho, e ampliar por efeito colateral de uma fase
      de mapa seria decidir política dentro de uma implementação.
    */
    expect(
      (await chamar(GET, `/api/map/customers?${RECORTE}`, dispatcher)).status,
    ).toBe(403);
    expect(
      (await chamar(GET, `/api/map/customers?${RECORTE}`, tecnico)).status,
    ).toBe(403);

    // Esconder o controle na tela não é segurança: a chamada direta é barrada.
    const semSessao = await GET(new Request(`http://localhost/api/map/customers?${RECORTE}`));
    expect(semSessao.status).toBe(401);
  });

  it("MAPAPI-02 · a camada de OS acompanha o mapa de caixas", async () => {
    const { GET } = await import("@/app/api/map/service-orders/route");
    const cliente = await criarCliente({ nome: "API OS", lat: BASE.lat });
    await criarOs(cliente.id, "PENDING");

    const admin = await createTokenFor(fixture.adminA.id);
    const dispatcher = await createTokenFor(fixture.dispatcherA.id);
    const tecnico = await createTokenFor(fixture.techA.id);

    // OS aberta é o objeto de trabalho do despacho: esconder dele onde estão os
    // atendimentos seria esconder a própria função da tela.
    expect(
      (await chamar(GET, `/api/map/service-orders?${RECORTE}`, admin)).status,
    ).toBe(200);
    expect(
      (await chamar(GET, `/api/map/service-orders?${RECORTE}`, dispatcher)).status,
    ).toBe(200);
    expect(
      (await chamar(GET, `/api/map/service-orders?${RECORTE}`, tecnico)).status,
    ).toBe(403);
  });

  it("MAPAPI-03 · a busca não devolve CLIENTE ao DISPATCHER", async () => {
    const { GET } = await import("@/app/api/map/search/route");
    await criarCliente({ nome: "SIGILO CLIENTE", lat: BASE.lat });
    await criarCaixaComClientes("SIGILO CAIXA", []);

    const admin = await createTokenFor(fixture.adminA.id);
    const dispatcher = await createTokenFor(fixture.dispatcherA.id);

    const doAdmin = await chamar(GET, "/api/map/search?q=SIGILO", admin);
    expect(doAdmin.status).toBe(200);
    expect(
      doAdmin.body.data.search.hits.map((h: { type: string }) => h.type),
    ).toContain("CUSTOMER");

    /*
      O corte é do SERVIDOR, e não da tela.

      Filtrar no navegador não resolveria nada: o nome e a coordenada já teriam
      saído pela porta. A busca é a porta dos fundos mais fácil de esquecer
      quando a decisão de perfil mora só na camada que desenha.
    */
    const doDispatcher = await chamar(GET, "/api/map/search?q=SIGILO", dispatcher);
    expect(doDispatcher.status).toBe(200);
    const tipos = doDispatcher.body.data.search.hits.map(
      (h: { type: string }) => h.type,
    );
    expect(tipos).not.toContain("CUSTOMER");
    expect(tipos).toContain("CTO");
    expect(JSON.stringify(doDispatcher.body)).not.toContain("SIGILO CLIENTE");
  });

  it("MAPAPI-04 · a lista por porta é de ADMIN, e o id de outra empresa é 404", async () => {
    const { GET } = await import("@/app/api/ctos/[id]/customers/route");
    const cliente = await criarCliente({ nome: "API PORTA", lat: BASE.lat });
    const minha = await criarCaixaComClientes("CX API", [
      { id: cliente.id, porta: 1 },
    ]);
    const alheia = await criarCaixaComClientes(
      "CX ALHEIA",
      [],
      fixture.companyB.id,
      fixture.adminB.id,
    );

    const admin = await createTokenFor(fixture.adminA.id);
    const dispatcher = await createTokenFor(fixture.dispatcherA.id);

    const ok = await GET(
      apiRequest(`/api/ctos/${minha.id}/customers`, { headers: { ...ORIGIN } }, admin),
      { params: { id: minha.id } },
    );
    expect(ok.status).toBe(200);
    expect((await ok.json()).data.customers).toHaveLength(1);

    const negado = await GET(
      apiRequest(
        `/api/ctos/${minha.id}/customers`,
        { headers: { ...ORIGIN } },
        dispatcher,
      ),
      { params: { id: minha.id } },
    );
    expect(negado.status).toBe(403);

    /*
      404 para a caixa de outra empresa, e não uma lista vazia.

      Lista vazia é indistinguível de "esta caixa não tem ninguém" — e essa
      diferença confirma a existência da caixa alheia para quem varrer ids.
    */
    const cruzado = await GET(
      apiRequest(
        `/api/ctos/${alheia.id}/customers`,
        { headers: { ...ORIGIN } },
        admin,
      ),
      { params: { id: alheia.id } },
    );
    expect(cruzado.status).toBe(404);
  });

  it("MAPAPI-05 · o teto e o recorte não são negociáveis pelo cliente", async () => {
    const { GET } = await import("@/app/api/map/customers/route");
    const admin = await createTokenFor(fixture.adminA.id);

    // Sem recorte não há leitura: um mapa sem bbox é a carteira inteira.
    expect((await chamar(GET, "/api/map/customers", admin)).status).toBe(400);

    // Recorte fora do planeta é recusado com mensagem própria.
    const invalido = await chamar(
      GET,
      "/api/map/customers?north=999&south=0&east=0&west=0",
      admin,
    );
    expect(invalido.status).toBe(400);
    for (const proibido of ["prisma", "SELECT", "at Object", "customers"]) {
      expect(invalido.body.error ?? "").not.toContain(proibido);
    }

    // O teto que sai na resposta é o do servidor, mesmo pedindo mais.
    const comLimite = await chamar(
      GET,
      `/api/map/customers?${RECORTE}&limit=99999`,
      admin,
    );
    expect(comLimite.body.data.map.limit).toBe(CUSTOMER_MAP_MAX_MARKERS);
  });

  it("MAPAPI-06 · filtro inválido é RECUSADO, e não ignorado", async () => {
    const { GET } = await import("@/app/api/map/customers/route");
    const admin = await createTokenFor(fixture.adminA.id);

    /*
      Ignorar em silêncio devolveria a lista inteira para quem pediu um
      subconjunto — e a tela concluiria que o filtro não tem nada a esconder,
      quando na verdade ele nunca foi aplicado.
    */
    expect(
      (await chamar(GET, `/api/map/customers?${RECORTE}&connectivity=TALVEZ`, admin))
        .status,
    ).toBe(400);
    expect(
      (await chamar(GET, `/api/map/customers?${RECORTE}&openOs=quem+sabe`, admin))
        .status,
    ).toBe(400);
  });

  it("MAPAPI-07 · capability desligada some com as rotas, sem revelar o módulo", async () => {
    const { GET } = await import("@/app/api/map/customers/route");
    await prisma.company.update({
      where: { id: fixture.companyA.id },
      data: { ctoNetworkEnabled: false },
    });
    const admin = await createTokenFor(fixture.adminA.id);

    /*
      404, e não 403: 403 significa "isto existe, você é que não pode", e a
      empresa descobriria pela mensagem de erro que há um módulo que ela não
      contratou. A capability é verificada ANTES do perfil, como em todo o
      módulo.
    */
    expect((await chamar(GET, `/api/map/customers?${RECORTE}`, admin)).status).toBe(
      404,
    );
  });
});

// ---------------------------------------------------------------------------
// O padrão das camadas — CTO-3.2.2
// ---------------------------------------------------------------------------

describe("LAYERDEF — o estado padrão das camadas", () => {
  it("LAYERDEF-01 · clientes nasce DESLIGADA; caixas e OS, ligadas", () => {
    /*
      Não é preferência de tela: é a diferença entre um mapa que abre
      informativo e um que abre poluído.

      Clientes é a camada de milhares de pontos. Ligada por padrão, ela cobriria
      a rede de bolinhas antes de alguém pedir, e a infraestrutura — que é o que
      o despacho precisa ver primeiro — sumiria embaixo dela. Caixas e OS
      abertas são poucas o bastante para caber na tela, e são o trabalho.
    */
    expect(DEFAULT_MAP_LAYERS.CTOS).toBe(true);
    expect(DEFAULT_MAP_LAYERS.ORDERS).toBe(true);
    expect(
      DEFAULT_MAP_LAYERS.CUSTOMERS,
      "a camada de clientes não pode nascer ligada",
    ).toBe(false);
  });

  it("LAYERDEF-02 · a URL carrega só ESTADO, nunca conteúdo", () => {
    /*
      Camadas e filtro viajam na barra de endereço para que
      `Mapa → cliente → voltar` devolva o mapa **como estava**. O que NÃO viaja é
      payload: nenhum array de marcadores, nenhum nome, nenhuma coordenada de
      cliente. A URL descreve a vista; ela não guarda o conteúdo dela.
    */
    const query = buildMapViewQuery({
      latitude: -20.5,
      longitude: -41.5,
      zoom: 16,
      mode: "HYBRID",
      layers: { CTOS: true, ORDERS: false, CUSTOMERS: true },
      customerFilter: "OFFLINE",
    });
    const params = new URLSearchParams(query);
    expect(params.get("layers")).toBe("CTOS,CUSTOMERS");
    expect(params.get("cf")).toBe("OFFLINE");

    // Ida e volta: o que é escrito é exatamente o que consegue ser lido.
    const devolta = parseMapViewParams(Object.fromEntries(params.entries()));
    expect(devolta.layers).toEqual({
      CTOS: true,
      ORDERS: false,
      CUSTOMERS: true,
    });
    expect(devolta.customerFilter).toBe("OFFLINE");

    // O PADRÃO é omitido: quem não mexeu em nada tem a URL limpa.
    const padrao = buildMapViewQuery({
      zoom: 16,
      layers: { ...DEFAULT_MAP_LAYERS },
      customerFilter: "ALL",
    });
    expect(new URLSearchParams(padrao).has("layers")).toBe(false);
    expect(new URLSearchParams(padrao).has("cf")).toBe(false);

    // Camada inventada na URL não liga nada.
    const hostil = parseMapViewParams({ layers: "CTOS,INVENTADA" });
    expect(hostil.layers).toEqual({
      CTOS: true,
      ORDERS: false,
      CUSTOMERS: false,
    });
  });
});
