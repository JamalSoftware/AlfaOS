import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { POST as createRoute } from "@/app/api/ctos/route";
import { GET as getCtoRoute, PATCH as patchRoute } from "@/app/api/ctos/[id]/route";
import { POST as capacityRoute } from "@/app/api/ctos/[id]/capacity/route";
import {
  apiRequest,
  createTokenFor,
  seedTestData,
  type TestFixture,
} from "./helpers";

/**
 * # CTO-1.2 — coordenada ausente permanece ausente
 *
 * Achado relatado na validação humana: uma CTO criada **sem** coordenada
 * aparentava, na tela de detalhe, ter latitude `-23.5505199` e longitude
 * `-46.6333094`.
 *
 * A investigação mostrou que **o banco tem `NULL`** — as duas, confirmadas por
 * SQL cru, com `createdAt == updatedAt` provando que a linha nunca foi editada.
 * O que a tela mostrava era o `placeholder` dos campos, que usava uma
 * coordenada real e completa e por isso é visualmente indistinguível de um
 * valor gravado.
 *
 * Ou seja: **não houve coordenada fantasma persistida**. Estes testes existem
 * para que isso continue sendo verdade — eles fixam, no nível do dado e do
 * contrato, aquilo que a tela conseguiu deixar ambíguo.
 */

let fixture: TestFixture;
let adminToken: string;

const ORIGIN = { Origin: "http://localhost" };

beforeEach(async () => {
  fixture = await seedTestData();
  adminToken = await createTokenFor(fixture.adminA.id);
  await prisma.company.update({
    where: { id: fixture.companyA.id },
    data: { ctoNetworkEnabled: true },
  });
});

/**
 * Cria pela ROTA, com o payload exato do fluxo real: os campos de coordenada
 * são **omitidos**, não enviados como `null` nem como zero.
 */
async function criarSemCoordenada(name = "CTO QA 01") {
  const res = await createRoute(
    apiRequest(
      "/api/ctos",
      {
        method: "POST",
        body: {
          name,
          capacity: 8,
          addressReference: "Poste QA em frente ao nº 340",
        },
        headers: { ...ORIGIN },
      },
      adminToken,
    ),
  );
  return res;
}

async function linhaDe(name = "CTO QA 01") {
  return prisma.cTO.findFirstOrThrow({
    where: { companyId: fixture.companyA.id, name },
  });
}

describe("CTO1PV-01 · criar sem coordenada persiste NULL", () => {
  it("o banco fica com latitude e longitude nulas", async () => {
    const res = await criarSemCoordenada();
    expect(res.status).toBe(201);

    const linha = await linhaDe();
    expect(linha.latitude).toBeNull();
    expect(linha.longitude).toBeNull();
  });

  it("nem zero, nem string vazia, nem qualquer número — NULL no SQL cru", async () => {
    /*
      Leitura crua porque o objetivo é descartar tradução do client: `0` e
      `null` viram coisas diferentes no `Decimal` do Prisma, e uma checagem
      só pelo objeto poderia mascarar um zero gravado.
    */
    await criarSemCoordenada();
    const cru = await prisma.$queryRawUnsafe<
      { latitude: unknown; longitude: unknown }[]
    >(
      `SELECT "latitude", "longitude" FROM "ctos" WHERE "companyId" = $1 AND "name" = $2`,
      fixture.companyA.id,
      "CTO QA 01",
    );
    expect(cru).toHaveLength(1);
    expect(cru[0].latitude).toBeNull();
    expect(cru[0].longitude).toBeNull();
  });
});

describe("CTO1PV-02 · a resposta da criação não inventa coordenada", () => {
  it("o DTO devolve null nas duas", async () => {
    const res = await criarSemCoordenada();
    const body = await res.json();
    expect(body.data.cto.latitude).toBeNull();
    expect(body.data.cto.longitude).toBeNull();
  });

  it("nenhuma coordenada de exemplo aparece na resposta", async () => {
    // A busca é pelo TEXTO: se um default de São Paulo entrasse por qualquer
    // caminho — serviço, DTO, serialização — ele apareceria aqui.
    const res = await criarSemCoordenada();
    const texto = JSON.stringify(await res.json());
    expect(texto).not.toContain("23.5505199");
    expect(texto).not.toContain("46.6333094");
  });
});

describe("CTO1PV-03 · o detalhe também devolve null", () => {
  it("GET do detalhe não preenche coordenada", async () => {
    await criarSemCoordenada();
    const cto = await linhaDe();

    const res = await getCtoRoute(
      apiRequest(`/api/ctos/${cto.id}`, {}, adminToken),
      { params: { id: cto.id } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.cto.latitude).toBeNull();
    expect(body.data.cto.longitude).toBeNull();
  });
});

describe("CTO1PV-05 / CTO1PV-06 · outras edições não preenchem coordenada", () => {
  it("editar nome, observações e referência mantém as duas nulas", async () => {
    await criarSemCoordenada();
    const cto = await linhaDe();

    const res = await patchRoute(
      apiRequest(
        `/api/ctos/${cto.id}`,
        {
          method: "PATCH",
          body: {
            name: "CTO QA 01 renomeada",
            notes: "observação nova",
            addressReference: "Poste QA, outro ponto",
          },
          headers: { ...ORIGIN },
        },
        adminToken,
      ),
      { params: { id: cto.id } },
    );
    expect(res.status).toBe(200);

    const depois = await prisma.cTO.findUniqueOrThrow({ where: { id: cto.id } });
    expect(depois.latitude).toBeNull();
    expect(depois.longitude).toBeNull();
    // Controle: a edição de fato aconteceu, então o "continua nulo" não é
    // consequência de nada ter sido gravado.
    expect(depois.name).toBe("CTO QA 01 renomeada");
  });

  it("alterar capacidade mantém as duas nulas", async () => {
    await criarSemCoordenada();
    const cto = await linhaDe();

    const res = await capacityRoute(
      apiRequest(
        `/api/ctos/${cto.id}/capacity`,
        { method: "POST", body: { capacity: 16 }, headers: { ...ORIGIN } },
        cto.id ? adminToken : adminToken,
      ),
      { params: { id: cto.id } },
    );
    expect(res.status).toBe(200);

    const depois = await prisma.cTO.findUniqueOrThrow({ where: { id: cto.id } });
    expect(depois.capacity).toBe(16);
    expect(depois.latitude).toBeNull();
    expect(depois.longitude).toBeNull();
  });

  it("enviar a foto também não mexe em coordenada", async () => {
    // O caminho da foto grava na mesma linha; um `data` montado por spread
    // poderia arrastar campos junto.
    await criarSemCoordenada();
    const cto = await linhaDe();
    await prisma.cTO.update({
      where: { id: cto.id },
      data: { photoStorageKey: "empresa/cto/abc.jpg" },
    });
    const depois = await prisma.cTO.findUniqueOrThrow({ where: { id: cto.id } });
    expect(depois.latitude).toBeNull();
    expect(depois.longitude).toBeNull();
  });
});

describe("CTO1PV-07 · coordenada explícita continua funcionando", () => {
  it("criar COM coordenada grava exatamente o que foi enviado", async () => {
    const res = await createRoute(
      apiRequest(
        "/api/ctos",
        {
          method: "POST",
          body: {
            name: "COM GPS",
            capacity: 4,
            latitude: -23.5505199,
            longitude: -46.6333094,
          },
          headers: { ...ORIGIN },
        },
        adminToken,
      ),
    );
    expect(res.status).toBe(201);

    const linha = await linhaDe("COM GPS");
    expect(linha.latitude?.toString()).toBe("-23.5505199");
    expect(linha.longitude?.toString()).toBe("-46.6333094");
  });

  it("acrescentar coordenada a uma CTO que não tinha funciona", async () => {
    await criarSemCoordenada();
    const cto = await linhaDe();

    const res = await patchRoute(
      apiRequest(
        `/api/ctos/${cto.id}`,
        {
          method: "PATCH",
          body: { latitude: -10.5, longitude: -50.25 },
          headers: { ...ORIGIN },
        },
        adminToken,
      ),
      { params: { id: cto.id } },
    );
    expect(res.status).toBe(200);

    const depois = await prisma.cTO.findUniqueOrThrow({ where: { id: cto.id } });
    expect(depois.latitude?.toString()).toBe("-10.5");
    expect(depois.longitude?.toString()).toBe("-50.25");
  });
});

describe("CTO1PV-08 · a semântica da CTO-1.1 é preservada", () => {
  it("null explícito nos dois remove a coordenada", async () => {
    // Ausência no create é NULL; null explícito no update é REMOÇÃO. As duas
    // chegam ao mesmo estado por caminhos diferentes, e nenhuma inventa valor.
    const res = await createRoute(
      apiRequest(
        "/api/ctos",
        {
          method: "POST",
          body: { name: "LIMPAR", capacity: 4, latitude: -1.5, longitude: -2.5 },
          headers: { ...ORIGIN },
        },
        adminToken,
      ),
    );
    expect(res.status).toBe(201);
    const cto = await linhaDe("LIMPAR");

    await patchRoute(
      apiRequest(
        `/api/ctos/${cto.id}`,
        {
          method: "PATCH",
          body: { latitude: null, longitude: null },
          headers: { ...ORIGIN },
        },
        adminToken,
      ),
      { params: { id: cto.id } },
    );

    const depois = await prisma.cTO.findUniqueOrThrow({ where: { id: cto.id } });
    expect(depois.latitude).toBeNull();
    expect(depois.longitude).toBeNull();
  });
});

describe("nenhuma coordenada padrão existe no domínio", () => {
  it("criar dez CTOs sem coordenada não produz nenhuma coordenada", async () => {
    /*
      A varredura larga fecha a porta para um default que dependesse de algum
      estado — contador, empresa, primeira CTO da empresa. Uma amostra de uma
      linha só não distinguiria "nunca preenche" de "preenche a partir da
      segunda".
    */
    for (let i = 0; i < 10; i += 1) {
      await criarSemCoordenada(`SEM GPS ${i}`);
    }
    const comCoordenada = await prisma.cTO.count({
      where: {
        companyId: fixture.companyA.id,
        OR: [{ latitude: { not: null } }, { longitude: { not: null } }],
      },
    });
    expect(comCoordenada).toBe(0);
  });
});
