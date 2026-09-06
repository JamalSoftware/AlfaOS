import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { POST as createRoute } from "@/app/api/ctos/route";
import { PATCH as patchRoute } from "@/app/api/ctos/[id]/route";
import { POST as capacityRoute } from "@/app/api/ctos/[id]/capacity/route";
import {
  CTO_CAPACITY_MAX,
  CTO_CAPACITY_MIN,
  changeCtoCapacity,
  createCto,
  updateCto,
} from "@/lib/cto";
import {
  apiRequest,
  createTokenFor,
  seedTestData,
  type TestFixture,
} from "./helpers";

/**
 * # CTO-1.1 — faixa de capacidade e coordenada não-finita
 *
 * Duas ambiguidades que sobraram da `CTO-1`, e as duas tinham metade fechada:
 *
 * 1. o teto de capacidade existia no `zod` e no domínio, e **não no banco**;
 * 2. a guarda de coordenada do cliente usava `Number.isNaN`, que fecha `"abc"`
 *    e **deixa `"Infinity"` passar inteiro**.
 *
 * O segundo é o mais interessante, e a razão dele é do transporte:
 * `JSON.stringify` converte `NaN` **e** `Infinity` em `null`, e `null` é a
 * forma legítima de dizer "remova a coordenada". O servidor recebe os dois
 * casos como a mesma coisa e não tem como distingui-los — a guarda precisa
 * existir antes de o JSON ser montado.
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

function criar(body: Record<string, unknown>) {
  return createRoute(
    apiRequest(
      "/api/ctos",
      { method: "POST", body, headers: { ...ORIGIN } },
      adminToken,
    ),
  );
}

async function ctoDeExemplo(capacity = 8) {
  return createCto(fixture.companyA.id, fixture.adminA.id, {
    name: "A16",
    capacity,
  });
}

async function nadaFoiCriado() {
  expect(await prisma.cTO.count()).toBe(0);
  expect(await prisma.cTOPort.count()).toBe(0);
  expect(
    await prisma.auditLog.count({ where: { action: { startsWith: "CTO." } } }),
  ).toBe(0);
}

// ---------------------------------------------------------------------------
// Capacidade
// ---------------------------------------------------------------------------

describe("CTO1H-01 / CTO1H-02 · a faixa é recusada nas duas pontas", () => {
  it("capacity = 0 é 400, sem mutação", async () => {
    const res = await criar({ name: "A16", capacity: 0 });
    expect(res.status).toBe(400);
    await nadaFoiCriado();
  });

  it("capacity negativa é 400, sem mutação", async () => {
    const res = await criar({ name: "A16", capacity: -1 });
    expect(res.status).toBe(400);
    await nadaFoiCriado();
  });

  it("capacity = 257 é 400, sem mutação", async () => {
    const res = await criar({ name: "A16", capacity: CTO_CAPACITY_MAX + 1 });
    expect(res.status).toBe(400);
    await nadaFoiCriado();
  });

  it("capacity fracionária é 400", async () => {
    const res = await criar({ name: "A16", capacity: 8.5 });
    expect(res.status).toBe(400);
    await nadaFoiCriado();
  });

  it("o SERVIÇO recusa sozinho, sem depender do zod da rota", async () => {
    /*
      A rota não é a única porta: o serviço é superfície pública do módulo e
      será o caminho da `CTO-2`. Testar só pela rota deixaria a validação de
      domínio sem rede — e é ela que sobrevive a um chamador novo.
    */
    for (const capacity of [0, -1, 257, 8.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        createCto(fixture.companyA.id, fixture.adminA.id, {
          name: `X-${capacity}`,
          capacity,
        }),
      ).rejects.toMatchObject({ status: 400 });
    }
    await nadaFoiCriado();
  });
});

describe("CTO1H-03 · valor enorme é recusado ANTES de qualquer trabalho", () => {
  it("capacity = 1.000.000 não cria porta nenhuma e não demora", async () => {
    /*
      A prova de que a validação vem antes do trabalho proporcional é dupla:
      nada foi criado, E a recusa é imediata.

      O teto de tempo é folgado de propósito (1 s). Não é medição de desempenho:
      é a diferença de ordem de grandeza entre "recusou de cara" e "montou um
      array de um milhão e tentou inserir num `createMany` dentro de uma
      transação segurando o lock da CTO" — o segundo leva dezenas de segundos.
    */
    const inicio = Date.now();
    const res = await criar({ name: "A16", capacity: 1_000_000 });
    const duracao = Date.now() - inicio;

    expect(res.status).toBe(400);
    expect(duracao).toBeLessThan(1_000);
    await nadaFoiCriado();
  });
});

describe("CTO1H-04 · alteração de capacidade respeita a faixa", () => {
  it("257 é recusado e a CTO fica intacta", async () => {
    const cto = await ctoDeExemplo();
    const antes = await prisma.cTOPort.count({ where: { ctoId: cto.id } });

    const res = await capacityRoute(
      apiRequest(
        `/api/ctos/${cto.id}/capacity`,
        {
          method: "POST",
          body: { capacity: CTO_CAPACITY_MAX + 1 },
          headers: { ...ORIGIN },
        },
        adminToken,
      ),
      { params: { id: cto.id } },
    );

    expect(res.status).toBe(400);
    const atual = await prisma.cTO.findUniqueOrThrow({ where: { id: cto.id } });
    expect(atual.capacity).toBe(8);
    expect(await prisma.cTOPort.count({ where: { ctoId: cto.id } })).toBe(antes);
    expect(
      await prisma.auditLog.count({ where: { action: "CTO.CAPACITY_CHANGED" } }),
    ).toBe(0);
  });

  it("0 e 1.000.000 também são recusados pelo serviço, sem tocar as portas", async () => {
    const cto = await ctoDeExemplo();
    for (const capacity of [0, -1, 1_000_000]) {
      await expect(
        changeCtoCapacity(
          fixture.companyA.id,
          fixture.adminA.id,
          cto.id,
          capacity,
        ),
      ).rejects.toMatchObject({ status: 400 });
    }
    expect(await prisma.cTOPort.count({ where: { ctoId: cto.id } })).toBe(8);
  });
});

describe("CTO1H-05 · o limite é aceitável, e é exatamente ele", () => {
  it("capacity = 256 cria 256 portas", async () => {
    const res = await criar({ name: "A16", capacity: CTO_CAPACITY_MAX });
    expect(res.status).toBe(201);

    const cto = await prisma.cTO.findFirstOrThrow({ where: { name: "A16" } });
    expect(cto.capacity).toBe(256);
    const portas = await prisma.cTOPort.findMany({ where: { ctoId: cto.id } });
    expect(portas).toHaveLength(256);
    expect(new Set(portas.map((p) => p.number)).size).toBe(256);
    expect(Math.min(...portas.map((p) => p.number))).toBe(CTO_CAPACITY_MIN);
    expect(Math.max(...portas.map((p) => p.number))).toBe(256);
  });

  it("capacity = 1 também é válida", async () => {
    const res = await criar({ name: "UNICA", capacity: CTO_CAPACITY_MIN });
    expect(res.status).toBe(201);
    const cto = await prisma.cTO.findFirstOrThrow({ where: { name: "UNICA" } });
    expect(await prisma.cTOPort.count({ where: { ctoId: cto.id } })).toBe(1);
  });
});

describe("o BANCO também guarda a faixa", () => {
  /*
    A validação de aplicação é a primeira linha; esta é a que sobrevive a um
    caminho de escrita novo que esqueça as duas anteriores. Por isso o ataque
    passa POR FORA do serviço, direto no Prisma.
  */
  it("CHECK recusa capacity acima do teto", async () => {
    await expect(
      prisma.cTO.create({
        data: { companyId: fixture.companyA.id, name: "BYPASS", capacity: 257 },
      }),
    ).rejects.toThrow();
    expect(await prisma.cTO.count({ where: { name: "BYPASS" } })).toBe(0);
  });

  it("CHECK recusa capacity zero ou negativa", async () => {
    for (const capacity of [0, -5]) {
      await expect(
        prisma.cTO.create({
          data: { companyId: fixture.companyA.id, name: `B-${capacity}`, capacity },
        }),
      ).rejects.toThrow();
    }
  });

  it("controle positivo: 256 passa pelo CHECK", async () => {
    // Sem isto, os dois testes acima passariam mesmo que o CHECK recusasse
    // tudo — inclusive o que deve aceitar.
    const cto = await prisma.cTO.create({
      data: { companyId: fixture.companyA.id, name: "LIMITE", capacity: 256 },
    });
    expect(cto.capacity).toBe(256);
  });
});

// ---------------------------------------------------------------------------
// Coordenadas
// ---------------------------------------------------------------------------

describe("CTO1H-06 / CTO1H-07 · coordenada inválida não apaga a existente", () => {
  async function comCoordenada() {
    return createCto(fixture.companyA.id, fixture.adminA.id, {
      name: "A16",
      capacity: 8,
      latitude: -23.5505199,
      longitude: -46.6333094,
    });
  }

  async function coordenadaIntacta(ctoId: string) {
    const linha = await prisma.cTO.findUniqueOrThrow({ where: { id: ctoId } });
    expect(linha.latitude?.toString()).toBe("-23.5505199");
    expect(linha.longitude?.toString()).toBe("-46.6333094");
  }

  it("texto no lugar da latitude é 400, e a coordenada anterior fica", async () => {
    const cto = await comCoordenada();
    for (const valor of ["abc", "--", "1,2,3", "Infinity", "NaN", ""]) {
      const res = await patchRoute(
        apiRequest(
          `/api/ctos/${cto.id}`,
          {
            method: "PATCH",
            body: { latitude: valor, longitude: -46.6333094 },
            headers: { ...ORIGIN },
          },
          adminToken,
        ),
        { params: { id: cto.id } },
      );
      expect(res.status).toBe(400);
    }
    await coordenadaIntacta(cto.id);
  });

  it("texto no lugar da longitude é 400, e a coordenada anterior fica", async () => {
    const cto = await comCoordenada();
    const res = await patchRoute(
      apiRequest(
        `/api/ctos/${cto.id}`,
        {
          method: "PATCH",
          body: { latitude: -23.5505199, longitude: "abc" },
          headers: { ...ORIGIN },
        },
        adminToken,
      ),
      { params: { id: cto.id } },
    );
    expect(res.status).toBe(400);
    await coordenadaIntacta(cto.id);
  });

  it("meia coordenada é 400, e não apaga a outra metade", async () => {
    // O caso que o cliente produz ao limpar só um dos campos.
    const cto = await comCoordenada();
    const res = await patchRoute(
      apiRequest(
        `/api/ctos/${cto.id}`,
        {
          method: "PATCH",
          body: { latitude: null, longitude: -46.6333094 },
          headers: { ...ORIGIN },
        },
        adminToken,
      ),
      { params: { id: cto.id } },
    );
    expect(res.status).toBe(400);
    await coordenadaIntacta(cto.id);
  });

  it("NaN e Infinity são recusados pelo SERVIÇO, e não só pelo zod", async () => {
    /*
      A guarda de domínio é a que fecha a chamada direta.

      Ela não é redundante com o teste de faixa: comparação com `NaN` é sempre
      falsa, então `NaN < -90` e `NaN > 90` são os dois `false` e um teste de
      faixa SOZINHO deixa `NaN` passar. Era exatamente esse o estado antes
      desta fase.
    */
    const cto = await comCoordenada();
    const invalidos = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ];
    for (const valor of invalidos) {
      await expect(
        updateCto(fixture.companyA.id, fixture.adminA.id, cto.id, {
          latitude: valor,
          longitude: -46.6333094,
        }),
      ).rejects.toMatchObject({ status: 400 });
      await expect(
        updateCto(fixture.companyA.id, fixture.adminA.id, cto.id, {
          latitude: -23.5505199,
          longitude: valor,
        }),
      ).rejects.toMatchObject({ status: 400 });
    }
    await coordenadaIntacta(cto.id);
  });

  it("criar com NaN também é recusado", async () => {
    await expect(
      createCto(fixture.companyA.id, fixture.adminA.id, {
        name: "NAO_NASCE",
        capacity: 4,
        latitude: Number.NaN,
        longitude: Number.NaN,
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(await prisma.cTO.count({ where: { name: "NAO_NASCE" } })).toBe(0);
  });
});

describe("CTO1H-08 / CTO1H-09 · faixa geográfica", () => {
  it("latitude 91 e -91 são recusadas", async () => {
    for (const latitude of [91, -91]) {
      const res = await criar({ name: "A16", capacity: 4, latitude, longitude: 0 });
      expect(res.status).toBe(400);
    }
    await nadaFoiCriado();
  });

  it("longitude -181 e 181 são recusadas", async () => {
    for (const longitude of [-181, 181]) {
      const res = await criar({ name: "A16", capacity: 4, latitude: 0, longitude });
      expect(res.status).toBe(400);
    }
    await nadaFoiCriado();
  });

  it("controle positivo: os extremos válidos são aceitos", async () => {
    const res = await criar({
      name: "EXTREMO",
      capacity: 4,
      latitude: -90,
      longitude: 180,
    });
    expect(res.status).toBe(201);
  });
});

describe("CTO1H-10 · campo realmente vazio remove a coordenada", () => {
  it("os DOIS nulos limpam, e isso é o comportamento documentado", async () => {
    /*
      Este é o contrato que torna a guarda do cliente necessária: `null` nos
      dois campos é a forma legítima de dizer "esta caixa não tem coordenada".
      O servidor não tem como distinguir isso de um `JSON.stringify(NaN)`, e é
      por isso que a validação de texto acontece antes de o JSON ser montado.
    */
    const cto = await createCto(fixture.companyA.id, fixture.adminA.id, {
      name: "A16",
      capacity: 8,
      latitude: -23.5505199,
      longitude: -46.6333094,
    });

    const res = await patchRoute(
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

    expect(res.status).toBe(200);
    const linha = await prisma.cTO.findUniqueOrThrow({ where: { id: cto.id } });
    expect(linha.latitude).toBeNull();
    expect(linha.longitude).toBeNull();
  });

  it("não enviar os campos não mexe na coordenada", async () => {
    // Ausente é "não mexa"; nulo é "limpe". A distinção precisa sobreviver ao
    // PATCH, senão salvar uma observação apagaria a localização da caixa.
    const cto = await createCto(fixture.companyA.id, fixture.adminA.id, {
      name: "A16",
      capacity: 8,
      latitude: -23.5505199,
      longitude: -46.6333094,
    });

    const res = await patchRoute(
      apiRequest(
        `/api/ctos/${cto.id}`,
        {
          method: "PATCH",
          body: { notes: "só a observação" },
          headers: { ...ORIGIN },
        },
        adminToken,
      ),
      { params: { id: cto.id } },
    );

    expect(res.status).toBe(200);
    const linha = await prisma.cTO.findUniqueOrThrow({ where: { id: cto.id } });
    expect(linha.latitude?.toString()).toBe("-23.5505199");
    expect(linha.longitude?.toString()).toBe("-46.6333094");
  });
});
