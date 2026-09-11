import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET as searchRoute } from "@/app/api/map/search/route";
import { createCto } from "@/lib/cto";
import {
  CTO_MAP_SEARCH_MAX_RESULTS,
  normalizeMapSearchQuery,
  searchCtosForMap,
} from "@/lib/cto-map";
import {
  CTO_MAP_SEARCH_MAX_QUERY,
  CTO_MAP_SEARCH_MIN_QUERY,
} from "@/lib/cto-map-presentation";
import { DomainError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import {
  apiRequest,
  createTokenFor,
  seedTestData,
  type TestFixture,
} from "./helpers";

/**
 * # `CTO-3.2` — a busca do Mapa Operacional
 *
 * Contrato **separado** do recorte, por decisão do dono: procurar por nome ou
 * código vale em toda a rede, e não apenas na área visível.
 *
 * O que estes testes protegem, em ordem de gravidade:
 *
 * ```text
 * tenancy      empresa A nunca acha caixa de B — nem o nome, nem a coordenada
 * teto         dez resultados, e o teto não é negociável pelo cliente
 * DTO mínimo   nem resumo, nem estado, nem porta, nem cliente
 * enumeração   termo vazio ou curinga não vira listagem da carteira
 * ```
 *
 * Coordenadas fictícias, na mesma faixa do Atlântico sul que a `CTO-3.1` usa,
 * para não coincidirem com endereço de ninguém.
 */

let fixture: TestFixture;
let adminA: string;
let dispatcherA: string;
let technicianA: string;
let adminB: string;

const DENTRO = { latitude: -20.5, longitude: -41.5 };

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
});

async function novaCto(
  nome: string,
  opcoes: {
    code?: string | null;
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
    code: opcoes.code ?? null,
    capacity: 8,
    latitude: opcoes.latitude === undefined ? DENTRO.latitude : opcoes.latitude,
    longitude:
      opcoes.longitude === undefined ? DENTRO.longitude : opcoes.longitude,
  });
}

function buscar(token: string, q?: string) {
  const url =
    q === undefined
      ? "/api/map/search"
      : `/api/map/search?q=${encodeURIComponent(q)}`;
  return searchRoute(apiRequest(url, {}, token));
}

async function corpo(resposta: Response) {
  return (await resposta.json()) as {
    ok: boolean;
    data?: {
      search: {
        hits: {
          id: string;
          name: string;
          code: string | null;
          latitude: number | null;
          longitude: number | null;
        }[];
        truncated: boolean;
        limit: number;
      };
    };
    error?: string;
  };
}

/** Atalho: a busca dentro do envelope `{ ok, data }` do projeto. */
async function busca(resposta: Response) {
  return (await corpo(resposta)).data?.search;
}

// ---------------------------------------------------------------------------
// SEARCH-01 / SEARCH-02 — encontrar
// ---------------------------------------------------------------------------

describe("SEARCH-01/02 — nome e código", () => {
  it("SEARCH-01 · acha a CTO do tenant pelo nome", async () => {
    await novaCto("CTO QA FIELD 01");
    await novaCto("Poste da Praça");

    const resultado = await searchCtosForMap(fixture.companyA.id, "qa field");

    expect(resultado.hits.map((h) => h.name)).toEqual(["CTO QA FIELD 01"]);
  });

  it("SEARCH-02 · acha pelo código, e o código é case-insensitive", async () => {
    await novaCto("Caixa do mercado", { code: "CX-0042" });

    const maiuscula = await searchCtosForMap(fixture.companyA.id, "CX-0042");
    const minuscula = await searchCtosForMap(fixture.companyA.id, "cx-0042");

    expect(maiuscula.hits.map((h) => h.code)).toEqual(["CX-0042"]);
    expect(minuscula.hits.map((h) => h.code)).toEqual(["CX-0042"]);
  });

  it("SEARCH-02b · o nome também é case-insensitive", async () => {
    await novaCto("Alameda Norte");

    const r = await searchCtosForMap(fixture.companyA.id, "ALAMEDA");

    expect(r.hits).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// SEARCH-03 — tenancy
// ---------------------------------------------------------------------------

describe("SEARCH-03 — tenancy", () => {
  it("SEARCH-03 · a empresa A não acha a CTO da empresa B", async () => {
    const daB = await novaCto("Compartilhada", {
      companyId: fixture.companyB.id,
    });

    const vistoPorA = await searchCtosForMap(
      fixture.companyA.id,
      "Compartilhada",
    );

    expect(vistoPorA.hits).toHaveLength(0);

    // CONTROLE POSITIVO: sem ele, o teste acima passaria se a busca estivesse
    // simplesmente quebrada e nunca achasse nada.
    const vistoPorB = await searchCtosForMap(
      fixture.companyB.id,
      "Compartilhada",
    );
    expect(vistoPorB.hits.map((h) => h.id)).toEqual([daB.id]);
  });

  it("SEARCH-03b · nem a coordenada da CTO alheia aparece no corpo da resposta", async () => {
    await novaCto("Sigilosa", {
      companyId: fixture.companyB.id,
      latitude: -20.7654321,
      longitude: -41.1234567,
    });

    const resposta = await buscar(adminA, "Sigilosa");
    const texto = await resposta.text();

    /*
      Varre o corpo INTEIRO, e não a lista de resultados.

      Uma coordenada isolada já é vazamento (§200): saber que existe uma caixa
      em -20,7654321 / -41,1234567 basta para mapear a rede do concorrente.
      Procurar dentro de `hits` deixaria passar um vazamento por qualquer outro
      campo que alguém acrescentasse depois.
    */
    expect(texto).not.toContain("20.7654321");
    expect(texto).not.toContain("41.1234567");
    expect(texto).not.toContain("Sigilosa");
  });

  it("SEARCH-03c · `companyId` do query string é ignorado", async () => {
    await novaCto("Alvo", { companyId: fixture.companyB.id });

    const resposta = await searchRoute(
      apiRequest(
        `/api/map/search?q=Alvo&companyId=${fixture.companyB.id}&tenantId=${fixture.companyB.id}`,
        {},
        adminA,
      ),
    );

    expect(resposta.status).toBe(200);
    expect((await busca(resposta))?.hits).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// SEARCH-04 — validação do termo
// ---------------------------------------------------------------------------

describe("SEARCH-04 — o termo é validado", () => {
  it("SEARCH-04 · termo acima do teto de tamanho é 400", async () => {
    const resposta = await buscar(adminA, "a".repeat(CTO_MAP_SEARCH_MAX_QUERY + 1));

    expect(resposta.status).toBe(400);
    expect(await busca(resposta)).toBeUndefined();
  });

  it("SEARCH-04b · termo no teto exato passa", async () => {
    const resposta = await buscar(adminA, "a".repeat(CTO_MAP_SEARCH_MAX_QUERY));

    expect(resposta.status).toBe(200);
  });

  it("SEARCH-04c · termo ausente devolve lista vazia, e NÃO a carteira", async () => {
    await novaCto("Uma");
    await novaCto("Outra");

    const resposta = await buscar(adminA);

    expect(resposta.status).toBe(200);
    expect((await busca(resposta))?.hits).toEqual([]);
  });

  it("SEARCH-04d · termo em branco devolve lista vazia", async () => {
    await novaCto("Uma");

    const resposta = await buscar(adminA, "    ");

    expect((await busca(resposta))?.hits).toEqual([]);
  });

  it("SEARCH-04e · o termo é aparado antes de consultar", async () => {
    await novaCto("Alameda Norte");

    const r = await searchCtosForMap(
      fixture.companyA.id,
      normalizeMapSearchQuery("  Alameda  ") as string,
    );

    expect(r.hits).toHaveLength(1);
  });

  /*
    O ataque de curinga.

    `contains` do Prisma repassa `%` e `_` ao `LIKE` do Postgres. Um termo de
    dois caracteres feito só de curinga satisfaria o mínimo e casaria com
    TUDO — a busca viraria a exportação da carteira, pelo endpoint que não tem
    recorte para limitá-la.
  */
  it("SEARCH-04f · `%%` não vira listagem da carteira", async () => {
    await novaCto("Uma");
    await novaCto("Outra");
    await novaCto("Mais uma");

    const resposta = await buscar(adminA, "%%");

    expect((await busca(resposta))?.hits).toEqual([]);
  });

  it("SEARCH-04g · `_` sozinho também não", async () => {
    await novaCto("Uma");
    await novaCto("Outra");

    expect(normalizeMapSearchQuery("__")).toBeNull();
    expect((await busca(await buscar(adminA, "__")))?.hits).toEqual([]);
  });

  it("SEARCH-04h · um código legítimo com `_` continua encontrável", async () => {
    await novaCto("Caixa da esquina", { code: "CTO_01" });

    const r = await searchCtosForMap(fixture.companyA.id, "CTO_01");

    expect(r.hits.map((h) => h.code)).toEqual(["CTO_01"]);
  });

  it("SEARCH-04i · termo não textual é recusado", () => {
    expect(() => normalizeMapSearchQuery(42)).toThrow(DomainError);
    expect(() => normalizeMapSearchQuery({ q: "x" })).toThrow(DomainError);
  });

  it("SEARCH-04j · o mínimo do domínio é o mesmo que a tela usa", () => {
    expect(normalizeMapSearchQuery("a".repeat(CTO_MAP_SEARCH_MIN_QUERY - 1)))
      .toBeNull();
    expect(
      normalizeMapSearchQuery("a".repeat(CTO_MAP_SEARCH_MIN_QUERY)),
    ).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SEARCH-05 — o teto
// ---------------------------------------------------------------------------

describe("SEARCH-05 — teto de resultados", () => {
  it("SEARCH-05 · devolve no máximo o teto, e diz que cortou", async () => {
    for (let i = 0; i < CTO_MAP_SEARCH_MAX_RESULTS + 3; i += 1) {
      await novaCto(`Poste ${String(i).padStart(2, "0")}`);
    }

    const r = await searchCtosForMap(fixture.companyA.id, "Poste");

    expect(r.hits).toHaveLength(CTO_MAP_SEARCH_MAX_RESULTS);
    expect(r.truncated).toBe(true);
    expect(r.limit).toBe(CTO_MAP_SEARCH_MAX_RESULTS);
  });

  it("SEARCH-05b · abaixo do teto não é marcado como truncado", async () => {
    await novaCto("Poste A");
    await novaCto("Poste B");

    const r = await searchCtosForMap(fixture.companyA.id, "Poste");

    expect(r.hits).toHaveLength(2);
    expect(r.truncated).toBe(false);
  });

  it("SEARCH-05c · o cliente não consegue pedir mais que o teto", async () => {
    for (let i = 0; i < CTO_MAP_SEARCH_MAX_RESULTS + 5; i += 1) {
      await novaCto(`Poste ${String(i).padStart(2, "0")}`);
    }

    // Nem `limit`, nem `take`, nem `perPage`: a rota não lê nenhum deles.
    const resposta = await searchRoute(
      apiRequest(
        "/api/map/search?q=Poste&limit=500&take=500&perPage=500",
        {},
        adminA,
      ),
    );

    expect((await busca(resposta))?.hits).toHaveLength(
      CTO_MAP_SEARCH_MAX_RESULTS,
    );
  });
});

// ---------------------------------------------------------------------------
// SEARCH-06 — CTO sem coordenada
// ---------------------------------------------------------------------------

describe("SEARCH-06 — sem localização", () => {
  it("SEARCH-06 · é encontrada, e vem com as duas coordenadas nulas", async () => {
    await novaCto("Sem GPS", { latitude: null, longitude: null });

    const r = await searchCtosForMap(fixture.companyA.id, "Sem GPS");

    expect(r.hits).toHaveLength(1);
    expect(r.hits[0].latitude).toBeNull();
    expect(r.hits[0].longitude).toBeNull();
  });

  it("SEARCH-06b · nunca aparece em 0,0", async () => {
    await novaCto("Sem GPS", { latitude: null, longitude: null });

    const resposta = await buscar(adminA, "Sem GPS");
    const hit = (await busca(resposta))?.hits[0] as unknown as {
      latitude: unknown;
      longitude: unknown;
    };

    expect(hit.latitude).toBeNull();
    expect(hit.longitude).toBeNull();
    expect(hit.latitude).not.toBe(0);
    expect(hit.longitude).not.toBe(0);
  });

  /*
    Meia coordenada é o caso que a `CTO-1.1` mostrou existir: latitude gravada e
    longitude nula. O recorte nunca a vê (o `where` exige as duas), mas a busca
    não filtra por coordenada — então é aqui que ela precisa ser neutralizada.
  */
  it("SEARCH-06c · meia coordenada sai como SEM localização, não como metade", async () => {
    const cto = await novaCto("Metade", { latitude: null, longitude: null });
    // Direto no banco: o domínio recusa o par incompleto, e é assim que dado
    // antigo ou importado existiria.
    await prisma.cTO.update({
      where: { id: cto.id },
      data: { latitude: -20.5, longitude: null },
    });

    const r = await searchCtosForMap(fixture.companyA.id, "Metade");

    expect(r.hits[0].latitude).toBeNull();
    expect(r.hits[0].longitude).toBeNull();
  });

  it("SEARCH-06d · CTO inativa continua encontrável", async () => {
    const cto = await novaCto("Desativada");
    await prisma.cTO.update({
      where: { id: cto.id },
      data: { active: false },
    });

    const r = await searchCtosForMap(fixture.companyA.id, "Desativada");

    expect(r.hits).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// SEARCH-07 — DTO mínimo
// ---------------------------------------------------------------------------

describe("SEARCH-07 — o DTO é mínimo", () => {
  it("SEARCH-07 · exatamente cinco campos, e nada além deles", async () => {
    await novaCto("Alvo", { code: "CX-1" });

    const r = await searchCtosForMap(fixture.companyA.id, "Alvo");

    expect(Object.keys(r.hits[0]).sort()).toEqual([
      "code",
      "id",
      "latitude",
      "longitude",
      "name",
    ]);
  });

  it("SEARCH-07b · não carrega resumo, estado, porta nem campo interno", async () => {
    const cto = await novaCto("Alvo", { code: "CX-1" });
    await prisma.cTO.update({
      where: { id: cto.id },
      data: {
        notes: "OBSERVACAO-ADMINISTRATIVA-SECRETA",
        addressReference: "REFERENCIA-INTERNA",
      },
    });

    const texto = await (await buscar(adminA, "Alvo")).text();

    for (const proibido of [
      "OBSERVACAO-ADMINISTRATIVA-SECRETA",
      "REFERENCIA-INTERNA",
      "companyId",
      "summary",
      "capacity",
      "ports",
      "photo",
      "createdBy",
      "status",
      "active",
    ]) {
      expect(texto).not.toContain(proibido);
    }
  });

  it("SEARCH-07c · nenhum nome de cliente conectado escapa pela busca", async () => {
    const cto = await novaCto("Com cliente");
    const cliente = await prisma.customer.create({
      data: { companyId: fixture.companyA.id, name: "MARIA-DA-SILVA-TESTE" },
    });
    const porta = await prisma.cTOPort.findFirstOrThrow({
      where: { ctoId: cto.id, number: 1 },
    });
    await prisma.customerNetworkConnection.create({
      data: {
        companyId: fixture.companyA.id,
        customerId: cliente.id,
        ctoPortId: porta.id,
        source: "WEB",
        connectedAt: new Date(),
      },
    });

    const texto = await (await buscar(adminA, "Com cliente")).text();

    expect(texto).not.toContain("MARIA-DA-SILVA-TESTE");
    expect(texto).not.toContain(cliente.id);
  });
});

// ---------------------------------------------------------------------------
// Portão — o mesmo do recorte
// ---------------------------------------------------------------------------

describe("SEARCH — portão de acesso", () => {
  it("sem sessão é 401", async () => {
    const resposta = await searchRoute(
      apiRequest("/api/map/search?q=Alvo"),
    );
    expect(resposta.status).toBe(401);
  });

  it("DISPATCHER lê a busca, como lê o recorte", async () => {
    await novaCto("Alvo");
    const resposta = await buscar(dispatcherA, "Alvo");

    expect(resposta.status).toBe(200);
    expect((await busca(resposta))?.hits).toHaveLength(1);
  });

  it("TECHNICIAN não lê", async () => {
    const resposta = await buscar(technicianA, "Alvo");
    expect(resposta.status).toBe(403);
  });

  /*
    Capability ANTES de perfil, e o par usa o MESMO perfil.

    404 com a capability desligada e 403 com ela ligada é o que prova de qual
    das duas verificações cada resposta veio. Um par com perfis diferentes
    provaria só que as duas existem.
  */
  it("capability desligada é 404, e vem antes do perfil", async () => {
    await prisma.company.update({
      where: { id: fixture.companyA.id },
      data: { ctoNetworkEnabled: false },
    });

    expect((await buscar(technicianA, "Alvo")).status).toBe(404);
    expect((await buscar(adminA, "Alvo")).status).toBe(404);

    await prisma.company.update({
      where: { id: fixture.companyA.id },
      data: { ctoNetworkEnabled: true },
    });
    expect((await buscar(technicianA, "Alvo")).status).toBe(403);
  });

  it("a capability é da empresa de QUEM CHAMA", async () => {
    await prisma.company.update({
      where: { id: fixture.companyB.id },
      data: { ctoNetworkEnabled: false },
    });

    expect((await buscar(adminB, "Alvo")).status).toBe(404);
    expect((await buscar(adminA, "Alvo")).status).toBe(200);
  });

  it("a rota exporta somente GET — a busca não escreve", async () => {
    const modulo = await import("@/app/api/map/search/route");
    const verbos = Object.keys(modulo).filter((k) =>
      ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(k),
    );
    expect(verbos).toEqual(["GET"]);
  });

  it("a mensagem de erro não vaza SQL, tabela nem stack", async () => {
    const resposta = await buscar(adminA, "a".repeat(200));
    const payload = await corpo(resposta);

    expect(resposta.status).toBe(400);
    for (const proibido of ["prisma", "SELECT", "cto", "at ", "Error:"]) {
      expect(payload.error ?? "").not.toContain(proibido);
    }
  });
});

// ---------------------------------------------------------------------------
// Estrutura da consulta
// ---------------------------------------------------------------------------

/**
 * O tenant participa do `where` — afirmado sobre a CONSULTA.
 *
 * A `CTO-3.1` mediu que filtrar em memória depois de buscar produz **a mesma
 * lista**: nenhum teste de resultado distingue os dois. O que muda é o banco
 * devolver a carteira alheia antes. Numa busca sem recorte isso é ainda mais
 * grave, então a asserção precisa ser sobre o pedido, não sobre a resposta.
 */
describe("SEARCH — estrutura da consulta", () => {
  it("o `companyId` e o teto estão no `where`/`take` do Prisma", async () => {
    const espiao = vi
      .spyOn(prisma.cTO, "findMany")
      .mockResolvedValue([] as never);

    await searchCtosForMap("empresa-x", "Alvo");

    const argumentos = espiao.mock.calls[0]?.[0] as {
      where?: Record<string, unknown>;
      take?: number;
      select?: Record<string, unknown>;
    };

    expect(argumentos.where?.companyId).toBe("empresa-x");
    expect(argumentos.take).toBe(CTO_MAP_SEARCH_MAX_RESULTS + 1);
    // O `select` é a primeira barreira do DTO mínimo: o que não é lido não
    // vaza por descuido de serialização depois.
    expect(Object.keys(argumentos.select ?? {}).sort()).toEqual([
      "code",
      "id",
      "latitude",
      "longitude",
      "name",
    ]);

    espiao.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Caracterização — o que o `contains` do Prisma faz com curinga
// ---------------------------------------------------------------------------

/**
 * A guarda de `usefulSearchLength` foi escrita sobre uma HIPÓTESE: a de que o
 * `contains` do Prisma repassa `%` e `_` ao `LIKE` do Postgres sem escapar.
 *
 * Este teste mede. O resultado decide como o `CTO-3.2` deve ser relatado — se o
 * Prisma escapa, a guarda é defesa em profundidade; se não escapa, ela fecha um
 * vetor real. Em qualquer dos dois casos ele é o alarme de uma mudança de
 * comportamento numa atualização futura do Prisma.
 */
describe("Caracterização — curinga de `LIKE` no `contains`", () => {
  it("mede se `%` é literal ou curinga", async () => {
    await novaCto("Alfa");
    await novaCto("Beta");

    const literal = await prisma.cTO.count({
      where: {
        companyId: fixture.companyA.id,
        name: { contains: "%", mode: "insensitive" },
      },
    });

    const todas = await prisma.cTO.count({
      where: { companyId: fixture.companyA.id },
    });

    /*
      `literal === 0` → o Prisma escapa: `%` procura o caractere `%` no nome.
      `literal === todas` → o Prisma NÃO escapa: `%` é curinga e casa com tudo.

      Nenhum outro desfecho faz sentido, e é isso que a asserção fixa: qualquer
      terceiro comportamento numa versão futura derruba este teste em vez de
      passar despercebido.
    */
    expect([0, todas]).toContain(literal);
    expect(todas).toBe(2);

    // O registro do que foi MEDIDO nesta versão do Prisma. Se a linha abaixo
    // falhar numa atualização, a guarda de `usefulSearchLength` mudou de
    // categoria — e o relatório de segurança precisa mudar junto.
    expect(literal).toBe(todas);
  });
});
