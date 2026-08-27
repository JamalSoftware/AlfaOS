import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { FieldError } from "@/lib/field/errors";
import {
  IDEMPOTENCY_LEASE_MS,
  withIdempotency,
} from "@/lib/field/idempotency";
import type { FieldPrincipal } from "@/lib/field/auth";
import { seedTestData, type TestFixture } from "./helpers";

/**
 * `withIdempotency` testado DIRETO, sem passar por rota.
 *
 * ## Por que este arquivo existe
 *
 * A suíte já tinha corrida de idempotência — mas pela rota `start`, onde o
 * compare-and-set do domínio arbitra primeiro. Isso mascarava a camada: com a
 * arbitragem da reserva quebrada, o CAS ainda deixaria só uma OS iniciar, e o
 * teste continuaria verde enquanto o helper executava o handler oito vezes.
 *
 * Um teste que passa por um motivo diferente do que ele afirma testar é pior
 * que nenhum teste — ele dá confiança sobre uma propriedade que ninguém
 * verificou. Aqui o handler é um contador: se a arbitragem falhar, o número
 * sobe, e nada mais no caminho pode disfarçar isso.
 */

let fixture: TestFixture;

beforeEach(async () => {
  fixture = await seedTestData();
});

/**
 * `withIdempotency` só lê empresa e usuário do principal. Montar o objeto à mão
 * mantém o teste na camada que ele audita, sem arrastar token nem dispositivo.
 */
function principalFor(companyId: string, userId: string): FieldPrincipal {
  return {
    user: { id: userId, companyId, name: "Tecnico", email: "t@a.test" },
    technician: { id: "tech-fake", active: true, executionIssue: null },
    device: { id: "device-fake", platform: "ANDROID" },
  };
}

const PAYLOAD = { orderId: "os-1", expectedVersion: 0 };

describe("TEST-01 · a arbitragem é do helper, não do domínio", () => {
  it("dez chamadas PARALELAS com a mesma chave executam o handler UMA vez", async () => {
    const principal = principalFor(fixture.companyA.id, fixture.techA.id);
    let execucoes = 0;

    const chamada = () =>
      withIdempotency(
        principal,
        "teste.contador",
        "core-paralelo-000001",
        PAYLOAD,
        async () => {
          execucoes += 1;
          // Uma janela real: sem ela, dez chamadas "paralelas" poderiam
          // serializar sozinhas e a corrida nunca aconteceria.
          await new Promise((r) => setTimeout(r, 25));
          return { status: 200, body: { execucoes } };
        },
      );

    const resultados = await Promise.allSettled(
      Array.from({ length: 10 }, chamada),
    );

    // A asserção que importa: PROÍBE o desfecho ruim, não o tolera.
    expect(execucoes).toBe(1);

    const oks = resultados.filter((r) => r.status === "fulfilled");
    expect(oks.length).toBeGreaterThanOrEqual(1);

    // Uma única linha de reserva, com o desfecho gravado.
    const registros = await prisma.idempotencyRecord.findMany({
      where: { key: "core-paralelo-000001" },
    });
    expect(registros).toHaveLength(1);
    expect(registros[0].status).toBe(200);
  });

  it("chamadas SEQUENCIAIS com a mesma chave também executam uma vez", async () => {
    const principal = principalFor(fixture.companyA.id, fixture.techA.id);
    let execucoes = 0;

    for (let i = 0; i < 5; i += 1) {
      await withIdempotency(
        principal,
        "teste.contador",
        "core-sequencial-0001",
        PAYLOAD,
        async () => {
          execucoes += 1;
          return { status: 200, body: { ok: true } };
        },
      );
    }

    expect(execucoes).toBe(1);
  });

  it("chaves de usuários diferentes não se bloqueiam", async () => {
    let execucoes = 0;
    const handler = async () => {
      execucoes += 1;
      return { status: 200, body: { ok: true } };
    };

    await withIdempotency(
      principalFor(fixture.companyA.id, fixture.techA.id),
      "teste.contador",
      "core-mesma-chave-001",
      PAYLOAD,
      handler,
    );
    await withIdempotency(
      principalFor(fixture.companyA.id, fixture.techB.id),
      "teste.contador",
      "core-mesma-chave-001",
      PAYLOAD,
      handler,
    );

    // Duas pessoas, duas execuções. Bloquear a segunda seria negar a operação
    // dela por causa de uma chave que ela nem escolheu.
    expect(execucoes).toBe(2);
  });

  it("empresas diferentes ficam isoladas", async () => {
    let execucoes = 0;
    const handler = async () => {
      execucoes += 1;
      return { status: 200, body: { ok: true } };
    };

    await withIdempotency(
      principalFor(fixture.companyA.id, fixture.adminA.id),
      "teste.contador",
      "core-cross-company-1",
      PAYLOAD,
      handler,
    );
    await withIdempotency(
      principalFor(fixture.companyB.id, fixture.adminB.id),
      "teste.contador",
      "core-cross-company-1",
      PAYLOAD,
      handler,
    );

    expect(execucoes).toBe(2);
    const registros = await prisma.idempotencyRecord.findMany({
      where: { key: "core-cross-company-1" },
    });
    expect(new Set(registros.map((r) => r.companyId)).size).toBe(2);
  });

  it("mesma chave com payload diferente continua sendo conflito", async () => {
    const principal = principalFor(fixture.companyA.id, fixture.techA.id);
    let execucoes = 0;
    const handler = async () => {
      execucoes += 1;
      return { status: 200, body: { ok: true } };
    };

    await withIdempotency(
      principal,
      "teste.contador",
      "core-payload-difere1",
      { a: 1 },
      handler,
    );

    await expect(
      withIdempotency(
        principal,
        "teste.contador",
        "core-payload-difere1",
        { a: 2 },
        handler,
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

    expect(execucoes).toBe(1);
  });

  it("falha não fica memorizada — a chave volta a ser usável", async () => {
    const principal = principalFor(fixture.companyA.id, fixture.techA.id);
    const key = "core-falha-depois-ok";

    await expect(
      withIdempotency(principal, "teste.contador", key, PAYLOAD, async () => {
        throw new FieldError("CONFLICT", "recusa temporária");
      }),
    ).rejects.toBeInstanceOf(FieldError);

    expect(await prisma.idempotencyRecord.count({ where: { key } })).toBe(0);

    const ok = await withIdempotency(
      principal,
      "teste.contador",
      key,
      PAYLOAD,
      async () => ({ status: 200, body: { ok: true } }),
    );
    expect(ok.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// IDM-01 — reserva abandonada
// ---------------------------------------------------------------------------

describe("IDM-01 · reserva IN_FLIGHT não trava a chave para sempre", () => {
  /** Cria a linha `IN_FLIGHT` que um processo morto deixaria para trás. */
  async function reservaAbandonada(
    companyId: string,
    userId: string,
    key: string,
    fingerprint: string,
    leaseExpiresAt: Date | null,
    createdAt = new Date(),
  ) {
    return prisma.idempotencyRecord.create({
      data: {
        companyId,
        userId,
        operation: "teste.contador",
        key,
        fingerprint,
        status: 0,
        response: {},
        leaseExpiresAt,
        createdAt,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });
  }

  /**
   * A impressão digital que `withIdempotency` calcularia para `PAYLOAD`.
   *
   * Obtida executando o helper uma vez e lendo o que ele gravou — em vez de
   * reimplementar a canonicalização aqui, que testaria a cópia e não o código.
   */
  async function fingerprintDoPayload(): Promise<string> {
    const principal = principalFor(fixture.companyB.id, fixture.adminB.id);
    await withIdempotency(
      principal,
      "teste.contador",
      "core-fingerprint-ref1",
      PAYLOAD,
      async () => ({ status: 200, body: {} }),
    );
    const row = await prisma.idempotencyRecord.findFirstOrThrow({
      where: { key: "core-fingerprint-ref1" },
    });
    return row.fingerprint;
  }

  it("lease AINDA VÁLIDO bloqueia — a primeira requisição está rodando", async () => {
    const fp = await fingerprintDoPayload();
    const key = "core-lease-vivo-0001";
    await reservaAbandonada(
      fixture.companyA.id,
      fixture.techA.id,
      key,
      fp,
      new Date(Date.now() + IDEMPOTENCY_LEASE_MS),
    );

    let execucoes = 0;
    await expect(
      withIdempotency(
        principalFor(fixture.companyA.id, fixture.techA.id),
        "teste.contador",
        key,
        PAYLOAD,
        async () => {
          execucoes += 1;
          return { status: 200, body: {} };
        },
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(execucoes).toBe(0);
  });

  it("lease VENCIDO é assumido e a operação anda", async () => {
    const fp = await fingerprintDoPayload();
    const key = "core-lease-vencido-1";
    await reservaAbandonada(
      fixture.companyA.id,
      fixture.techA.id,
      key,
      fp,
      new Date(Date.now() - 1000),
    );

    let execucoes = 0;
    const result = await withIdempotency(
      principalFor(fixture.companyA.id, fixture.techA.id),
      "teste.contador",
      key,
      PAYLOAD,
      async () => {
        execucoes += 1;
        return { status: 200, body: { retomado: true } };
      },
    );

    expect(execucoes).toBe(1);
    expect(result.status).toBe(200);

    const row = await prisma.idempotencyRecord.findFirstOrThrow({
      where: { key },
    });
    expect(row.status).toBe(200);
    expect(row.leaseExpiresAt).toBeNull();
  });

  it("reserva ANTIGA sem lease usa createdAt como idade", async () => {
    // Linha gravada antes de a coluna existir: `leaseExpiresAt` nulo. Sem o
    // fallback ela ficaria presa até a expiração de 24 h.
    const fp = await fingerprintDoPayload();
    const key = "core-lease-legado-01";
    await reservaAbandonada(
      fixture.companyA.id,
      fixture.techA.id,
      key,
      fp,
      null,
      new Date(Date.now() - IDEMPOTENCY_LEASE_MS - 60_000),
    );

    let execucoes = 0;
    await withIdempotency(
      principalFor(fixture.companyA.id, fixture.techA.id),
      "teste.contador",
      key,
      PAYLOAD,
      async () => {
        execucoes += 1;
        return { status: 200, body: {} };
      },
    );
    expect(execucoes).toBe(1);
  });

  it("duas requisições disputando a MESMA reserva vencida: só uma assume", async () => {
    const fp = await fingerprintDoPayload();
    const key = "core-lease-disputa-1";
    await reservaAbandonada(
      fixture.companyA.id,
      fixture.techA.id,
      key,
      fp,
      new Date(Date.now() - 1000),
    );

    let execucoes = 0;
    const chamada = () =>
      withIdempotency(
        principalFor(fixture.companyA.id, fixture.techA.id),
        "teste.contador",
        key,
        PAYLOAD,
        async () => {
          execucoes += 1;
          await new Promise((r) => setTimeout(r, 25));
          return { status: 200, body: {} };
        },
      );

    await Promise.allSettled([chamada(), chamada(), chamada()]);

    // A tomada é arbitrada pelo banco: três viram o lease vencido, uma assume.
    expect(execucoes).toBe(1);
  });

  it("reserva vencida cujo payload difere continua sendo conflito de chave", async () => {
    const key = "core-lease-outro-pay";
    await reservaAbandonada(
      fixture.companyA.id,
      fixture.techA.id,
      key,
      "impressao-digital-de-outro-conteudo",
      new Date(Date.now() - 1000),
    );

    let execucoes = 0;
    await expect(
      withIdempotency(
        principalFor(fixture.companyA.id, fixture.techA.id),
        "teste.contador",
        key,
        PAYLOAD,
        async () => {
          execucoes += 1;
          return { status: 200, body: {} };
        },
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

    // A impressão digital é checada ANTES do lease: chave reaproveitada para
    // outro conteúdo não vira tomada silenciosa.
    expect(execucoes).toBe(0);
  });
});
