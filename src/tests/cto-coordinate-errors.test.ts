import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { POST as createRoute } from "@/app/api/ctos/route";
import { PATCH as patchRoute } from "@/app/api/ctos/[id]/route";
import { DomainError } from "@/lib/errors";
import { createCto, updateCto } from "@/lib/cto";
import {
  apiRequest,
  createTokenFor,
  seedTestData,
  type TestFixture,
} from "./helpers";

/**
 * # CTO-1.6 — a recusa diz QUAL campo e POR QUÊ
 *
 * Achado da validação humana: latitude `91` com longitude válida era recusada
 * corretamente — e a tela dizia apenas **"Dados inválidos."**
 *
 * A causa era de autoridade duplicada. Rota e domínio conheciam a faixa
 * `-90..90`, e a da rota chegava primeiro: o `zod` barrava com `"Invalid
 * input"`, a resposta saía genérica, e a mensagem boa — que já existia no
 * domínio — nunca era alcançada. Duas camadas sabiam a mesma regra, e quem
 * falava era a que tinha menos a dizer.
 *
 * Agora o `zod` valida **forma** (número finito) e o domínio valida **faixa**,
 * nomeando o campo. Nada foi relaxado: todo caminho de escrita passa pelo
 * domínio, e estes testes provam isso pelas duas portas — rota e serviço.
 */

let fixture: TestFixture;
let adminToken: string;

const ORIGIN = { Origin: "http://localhost" };
const LAT_OK = -23.5505199;
const LON_OK = -46.6333094;

beforeEach(async () => {
  fixture = await seedTestData();
  adminToken = await createTokenFor(fixture.adminA.id);
  await prisma.company.update({
    where: { id: fixture.companyA.id },
    data: { ctoNetworkEnabled: true },
  });
});

async function ctoBase(name = "A16") {
  return createCto(fixture.companyA.id, fixture.adminA.id, {
    name,
    capacity: 4,
  });
}

/** PATCH pela rota, devolvendo status e corpo já lido. */
async function patch(ctoId: string, body: Record<string, unknown>) {
  const res = await patchRoute(
    apiRequest(
      `/api/ctos/${ctoId}`,
      { method: "PATCH", body, headers: { ...ORIGIN } },
      adminToken,
    ),
    { params: Promise.resolve({ id: ctoId }) },
  );
  return { status: res.status, body: await res.json() };
}

async function coordenadaNoBanco(ctoId: string) {
  const linha = await prisma.cTO.findUniqueOrThrow({ where: { id: ctoId } });
  return {
    latitude: linha.latitude?.toString() ?? null,
    longitude: linha.longitude?.toString() ?? null,
    updatedAt: linha.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------

describe("CTO1PV-COORD-01/02 · latitude fora da faixa", () => {
  it("91 é recusada com mensagem de LATITUDE e o campo nomeado", async () => {
    const cto = await ctoBase();
    const { status, body } = await patch(cto.id, {
      latitude: 91,
      longitude: LON_OK,
    });

    expect(status).toBe(400);
    expect(body.error).toBe("Latitude inválida. Informe o valor correto.");
    expect(body.field).toBe("latitude");
    // A mensagem genérica não pode voltar: era exatamente ela o achado.
    expect(body.error).not.toBe("Dados inválidos.");
  });

  it("-91 também, e a mensagem é a mesma", async () => {
    const cto = await ctoBase();
    const { status, body } = await patch(cto.id, {
      latitude: -91,
      longitude: LON_OK,
    });
    expect(status).toBe(400);
    expect(body.error).toBe("Latitude inválida. Informe o valor correto.");
    expect(body.field).toBe("latitude");
  });

  it("os extremos válidos passam — controle positivo da faixa", async () => {
    // Sem isto, uma regra que recusasse TUDO passaria nos testes acima.
    const cto = await ctoBase();
    for (const latitude of [-90, 90, 0]) {
      const { status } = await patch(cto.id, { latitude, longitude: 0 });
      expect(status).toBe(200);
    }
  });
});

describe("CTO1PV-COORD-03/04 · longitude fora da faixa", () => {
  it("181 é recusada com mensagem de LONGITUDE", async () => {
    const cto = await ctoBase();
    const { status, body } = await patch(cto.id, {
      latitude: LAT_OK,
      longitude: 181,
    });
    expect(status).toBe(400);
    expect(body.error).toBe("Longitude inválida. Informe o valor correto.");
    expect(body.field).toBe("longitude");
  });

  it("-181 também", async () => {
    const cto = await ctoBase();
    const { status, body } = await patch(cto.id, {
      latitude: LAT_OK,
      longitude: -181,
    });
    expect(status).toBe(400);
    expect(body.field).toBe("longitude");
  });

  it("os extremos válidos passam", async () => {
    const cto = await ctoBase();
    for (const longitude of [-180, 180]) {
      const { status } = await patch(cto.id, { latitude: 0, longitude });
      expect(status).toBe(200);
    }
  });

  it("uma latitude inválida não é reportada como longitude", async () => {
    /*
      A ordem da verificação importa para quem lê a tela: com os DOIS fora da
      faixa, a mensagem precisa ser de um campo só — apontar os dois de uma vez
      transformaria a correção num jogo de adivinhação.
    */
    const cto = await ctoBase();
    const { body } = await patch(cto.id, { latitude: 91, longitude: 181 });
    expect(body.field).toBe("latitude");
    expect(body.error).toMatch(/^Latitude/);
    expect(body.error).not.toMatch(/Longitude/);
  });
});

describe("CTO1PV-COORD-05/06 · par incompleto", () => {
  it("só latitude é recusado, e SEM apontar um campo", async () => {
    /*
      O erro é da combinação. Nomear um dos dois sugeriria que o problema está
      nele — e o problema é a ausência do outro. Sem `field`, a tela marca os
      dois.
    */
    const cto = await ctoBase();
    const { status, body } = await patch(cto.id, {
      latitude: LAT_OK,
      longitude: null,
    });
    expect(status).toBe(400);
    expect(body.error).toBe(
      "Coordenadas incompletas. Preencha latitude e longitude juntas ou deixe os dois campos vazios.",
    );
    expect(body.field).toBeUndefined();
  });

  it("só longitude, mesma regra", async () => {
    const cto = await ctoBase();
    const { status, body } = await patch(cto.id, {
      latitude: null,
      longitude: LON_OK,
    });
    expect(status).toBe(400);
    expect(body.field).toBeUndefined();
  });
});

describe("CTO1PV-COORD-07/08/09 · forma inválida", () => {
  it("texto no lugar do número é recusado pela ROTA", async () => {
    // Aqui o `zod` é a autoridade: "isto é um número?" é forma, não regra.
    const cto = await ctoBase();
    for (const valor of ["abc", "-23,55", "", "1e999"]) {
      const { status } = await patch(cto.id, {
        latitude: valor,
        longitude: LON_OK,
      });
      expect(status).toBe(400);
    }
  });

  it("NaN e Infinity são recusados pelo DOMÍNIO, com o campo nomeado", async () => {
    /*
      O `zod` não os alcança pela rota — `JSON.stringify` os converte em `null`
      antes de sair do cliente. Esta guarda existe para a chamada direta ao
      serviço, que é superfície pública do módulo.
    */
    const cto = await ctoBase();
    for (const valor of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      const erroLat = await updateCto(
        fixture.companyA.id,
        fixture.adminA.id,
        cto.id,
        { latitude: valor, longitude: LON_OK },
      ).catch((e: unknown) => e as DomainError);
      expect(erroLat).toBeInstanceOf(DomainError);
      expect((erroLat as DomainError).status).toBe(400);
      expect((erroLat as DomainError).field).toBe("latitude");

      const erroLon = await updateCto(
        fixture.companyA.id,
        fixture.adminA.id,
        cto.id,
        { latitude: LAT_OK, longitude: valor },
      ).catch((e: unknown) => e as DomainError);
      expect((erroLon as DomainError).field).toBe("longitude");
    }
  });

  it("a faixa é recusada pelo SERVIÇO, não só pela rota", async () => {
    // Prova de que nada foi relaxado ao tirar min/max do zod: o domínio recusa
    // igual, e é ele que todo caminho de escrita atravessa.
    const cto = await ctoBase();
    const erro = await updateCto(
      fixture.companyA.id,
      fixture.adminA.id,
      cto.id,
      { latitude: 91, longitude: LON_OK },
    ).catch((e: unknown) => e as DomainError);
    expect((erro as DomainError).message).toBe(
      "Latitude inválida. Informe o valor correto.",
    );
    expect((erro as DomainError).field).toBe("latitude");
  });

  it("criar com faixa inválida também é recusado, e não nasce nada", async () => {
    const res = await createRoute(
      apiRequest(
        "/api/ctos",
        {
          method: "POST",
          body: { name: "FORA", capacity: 4, latitude: 91, longitude: 0 },
          headers: { ...ORIGIN },
        },
        adminToken,
      ),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.field).toBe("latitude");
    expect(await prisma.cTO.count({ where: { name: "FORA" } })).toBe(0);
  });
});

describe("CTO1PV-COORD-10 · coordenada válida grava", () => {
  it("o caminho de sucesso continua funcionando", async () => {
    const cto = await ctoBase();
    const { status } = await patch(cto.id, {
      latitude: LAT_OK,
      longitude: LON_OK,
    });
    expect(status).toBe(200);
    const gravado = await coordenadaNoBanco(cto.id);
    expect(gravado.latitude).toBe(String(LAT_OK));
    expect(gravado.longitude).toBe(String(LON_OK));
  });
});

describe("CTO1PV-COORD-11/12 · nenhuma falha persiste ou audita", () => {
  it("toda entrada inválida deixa o banco e a auditoria intactos", async () => {
    const cto = await ctoBase();
    // Estado conhecido, para provar que nem sequer uma gravação parcial ocorre.
    await patch(cto.id, { latitude: LAT_OK, longitude: LON_OK });
    const antes = await coordenadaNoBanco(cto.id);
    const auditAntes = await prisma.auditLog.count({
      where: { companyId: fixture.companyA.id, action: "CTO.UPDATED" },
    });

    const invalidos: Record<string, unknown>[] = [
      { latitude: 91, longitude: LON_OK },
      { latitude: -91, longitude: LON_OK },
      { latitude: LAT_OK, longitude: 181 },
      { latitude: LAT_OK, longitude: -181 },
      { latitude: LAT_OK, longitude: null },
      { latitude: null, longitude: LON_OK },
      { latitude: "abc", longitude: LON_OK },
      { latitude: LAT_OK, longitude: "abc" },
    ];

    for (const body of invalidos) {
      const { status } = await patch(cto.id, body);
      expect(status).toBe(400);
    }

    expect(await coordenadaNoBanco(cto.id)).toEqual(antes);
    expect(
      await prisma.auditLog.count({
        where: { companyId: fixture.companyA.id, action: "CTO.UPDATED" },
      }),
    ).toBe(auditAntes);
  });
});

describe("a resposta de erro não vaza nada interno", () => {
  it("só o campo e o que fazer — nunca id, SQL, stack ou caminho", async () => {
    const cto = await ctoBase();
    const { body } = await patch(cto.id, { latitude: 91, longitude: LON_OK });
    const texto = JSON.stringify(body);

    expect(texto).not.toContain(cto.id);
    expect(texto).not.toContain(fixture.companyA.id);
    expect(texto).not.toMatch(/SELECT |UPDATE |prisma|\.ts:|at Object|C:\\/i);

    /*
      O que ele PODE dizer, e diz: qual campo está errado e o que fazer.

      A faixa saiu da mensagem por decisão de copy — antes ela trazia
      "-90 e 90". A regra continua idêntica no domínio e nos testes de limite
      logo acima; o que mudou é só o texto que a pessoa lê.
    */
    expect(body.field).toBe("latitude");
    expect(body.error).toBe("Latitude inválida. Informe o valor correto.");
  });
});
