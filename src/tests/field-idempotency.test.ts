import { describe, it, expect, beforeEach } from "vitest";
import { POST as startOrder } from "@/app/api/field/v1/service-orders/[id]/start/route";
import { prisma } from "@/lib/prisma";
import { fingerprintOf } from "@/lib/field/idempotency";
import {
  allocateTestServiceOrderNumber,
  fieldRequest,
  registerTestDevice,
  seedTestData,
  type TestFixture,
} from "./helpers";

/**
 * Idempotência e conflito nos comandos do Field.
 *
 * As duas proteções cobrem perguntas diferentes, e os testes tratam disso:
 *
 * - `Idempotency-Key` → "isto já aconteceu?" (o app reenviou a fila local)
 * - `expectedVersion`  → "o mundo ainda é o que eu vi?" (alguém mexeu)
 *
 * O desfecho errado seria o app somar as duas e concluir "falhou" quando a
 * operação deu certo da primeira vez.
 */

let fixture: TestFixture;

beforeEach(async () => {
  fixture = await seedTestData();
});

async function body(response: Response) {
  return (await response.json()) as {
    ok: boolean;
    data?: Record<string, unknown>;
    error?: { code: string; message: string; retryable: boolean; conflict: boolean };
  };
}

async function scenario() {
  const technicianA = await prisma.technician.create({
    data: { companyId: fixture.companyA.id, userId: fixture.techA.id },
  });
  const technicianB = await prisma.technician.create({
    data: { companyId: fixture.companyA.id, userId: fixture.techB.id },
  });
  const customer = await prisma.customer.create({
    data: { companyId: fixture.companyA.id, name: "Cliente", city: "Guaçuí" },
  });
  const order = await prisma.serviceOrder.create({
    data: {
      companyId: fixture.companyA.id,
      number: await allocateTestServiceOrderNumber(fixture.companyA.id),
      customerId: customer.id,
      technicianId: technicianA.id,
      type: "Instalação",
      description: "Instalação de fibra.",
      priority: "NORMAL",
      status: "ASSIGNED",
      assignedAt: new Date(),
    },
  });
  const { token } = await registerTestDevice(fixture.techA.id);
  return { technicianA, technicianB, customer, order, token };
}

function startRequest(
  orderId: string,
  token: string,
  key: string,
  expectedVersion: number,
) {
  return fieldRequest(`/api/field/v1/service-orders/${orderId}/start`, {
    method: "POST",
    token,
    idempotencyKey: key,
    body: { expectedVersion },
  });
}

async function callStart(
  orderId: string,
  token: string,
  key: string,
  expectedVersion: number,
) {
  return startOrder(startRequest(orderId, token, key, expectedVersion), {
    params: { id: orderId },
  });
}

// ---------------------------------------------------------------------------
// Repetição
// ---------------------------------------------------------------------------

describe("mesma chave, mesmo payload — uma única mutação", () => {
  it("dez reenvios produzem UM start", async () => {
    const s = await scenario();
    const key = "start-fila-local-000001";

    const statuses: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      const response = await callStart(s.order.id, s.token, key, s.order.version);
      statuses.push(response.status);
    }

    // Todas as dez respostas são o MESMO sucesso. É isso que impede o app de
    // ler a retentativa como falha e marcar a operação como CONFLICT na fila.
    expect(statuses).toEqual(Array(10).fill(200));

    const order = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: s.order.id },
    });
    expect(order.status).toBe("IN_PROGRESS");
    // Uma única escrita: a versão andou exatamente um.
    expect(order.version).toBe(s.order.version + 1);

    // Um começo, uma execução, um evento.
    expect(
      await prisma.serviceOrderExecution.count({
        where: { serviceOrderId: s.order.id },
      }),
    ).toBe(1);
    expect(
      await prisma.serviceOrderEvent.count({
        where: { serviceOrderId: s.order.id, event: "OS_STARTED" },
      }),
    ).toBe(1);
  });

  it("a repetição devolve o MESMO corpo, não um novo", async () => {
    const s = await scenario();
    const key = "start-corpo-identico-01";

    const primeiro = (await body(
      await callStart(s.order.id, s.token, key, s.order.version),
    )).data;
    const segundo = (await body(
      await callStart(s.order.id, s.token, key, s.order.version),
    )).data;

    expect(segundo).toEqual(primeiro);
  });

  it("sem a chave, o comando é recusado", async () => {
    const s = await scenario();

    const response = await startOrder(
      fieldRequest(`/api/field/v1/service-orders/${s.order.id}/start`, {
        method: "POST",
        token: s.token,
        body: { expectedVersion: s.order.version },
      }),
      { params: { id: s.order.id } },
    );

    expect(response.status).toBe(400);
    expect((await body(response)).error?.code).toBe("VALIDATION_ERROR");

    const order = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: s.order.id },
    });
    expect(order.status).toBe("ASSIGNED");
  });

  it("chave malformada é recusada", async () => {
    const s = await scenario();
    for (const key of ["curta", "com espaço aqui", "x".repeat(300)]) {
      const response = await callStart(
        s.order.id,
        s.token,
        key,
        s.order.version,
      );
      expect(response.status).toBe(400);
    }
  });
});

// ---------------------------------------------------------------------------
// Mesma chave, outro conteúdo
// ---------------------------------------------------------------------------

describe("mesma chave com payload diferente é conflito", () => {
  it("reaproveitar a chave para outra versão devolve IDEMPOTENCY_CONFLICT", async () => {
    const s = await scenario();
    const key = "start-reaproveitada-01";

    const ok = await callStart(s.order.id, s.token, key, s.order.version);
    expect(ok.status).toBe(200);

    const conflito = await callStart(
      s.order.id,
      s.token,
      key,
      s.order.version + 5,
    );
    expect(conflito.status).toBe(409);

    const payload = await body(conflito);
    expect(payload.error?.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(payload.error?.conflict).toBe(true);
    expect(payload.error?.retryable).toBe(false);
  });

  it("a mesma chave em OUTRA OS é conflito, não execução silenciosa", async () => {
    const s = await scenario();
    const outroCliente = await prisma.customer.create({
      data: { companyId: fixture.companyA.id, name: "Outro" },
    });
    const outraOrdem = await prisma.serviceOrder.create({
      data: {
        companyId: fixture.companyA.id,
        number: await allocateTestServiceOrderNumber(fixture.companyA.id),
        customerId: outroCliente.id,
        technicianId: s.technicianA.id,
        type: "Instalação",
        description: "Outra.",
        priority: "NORMAL",
        status: "ASSIGNED",
        assignedAt: new Date(),
      },
    });

    const key = "start-mesma-chave-0001";
    expect((await callStart(s.order.id, s.token, key, s.order.version)).status).toBe(200);

    const segunda = await callStart(
      outraOrdem.id,
      s.token,
      key,
      outraOrdem.version,
    );
    expect(segunda.status).toBe(409);
    expect((await body(segunda)).error?.code).toBe("IDEMPOTENCY_CONFLICT");

    // E a segunda OS não foi iniciada por tabela.
    const intacta = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: outraOrdem.id },
    });
    expect(intacta.status).toBe("ASSIGNED");
  });

  it("a impressão digital ignora a ORDEM das chaves do JSON", async () => {
    // Duas serializações do mesmo conteúdo têm de gerar a mesma impressão,
    // senão uma retentativa com as chaves em outra ordem viraria "conflito".
    expect(fingerprintOf({ a: 1, b: 2 })).toBe(fingerprintOf({ b: 2, a: 1 }));
    expect(fingerprintOf({ a: { x: 1, y: 2 } })).toBe(
      fingerprintOf({ a: { y: 2, x: 1 } }),
    );
    // E conteúdo diferente continua diferente.
    expect(fingerprintOf({ a: 1 })).not.toBe(fingerprintOf({ a: 2 }));
  });
});

// ---------------------------------------------------------------------------
// Isolamento da chave
// ---------------------------------------------------------------------------

describe("a chave é escopada por empresa e por pessoa", () => {
  it("a chave de um técnico não devolve o resultado do outro", async () => {
    const s = await scenario();
    const key = "start-chave-compartilhada";

    // Técnico A executa e memoriza o desfecho.
    expect((await callStart(s.order.id, s.token, key, s.order.version)).status).toBe(200);

    // Técnico B, com a MESMA chave, na PRÓPRIA OS.
    const clienteB = await prisma.customer.create({
      data: { companyId: fixture.companyA.id, name: "Cliente do B" },
    });
    const ordemB = await prisma.serviceOrder.create({
      data: {
        companyId: fixture.companyA.id,
        number: await allocateTestServiceOrderNumber(fixture.companyA.id),
        customerId: clienteB.id,
        technicianId: s.technicianB.id,
        type: "Instalação",
        description: "Do B.",
        priority: "NORMAL",
        status: "ASSIGNED",
        assignedAt: new Date(),
      },
    });
    const { token: tokenB } = await registerTestDevice(fixture.techB.id);

    const response = await callStart(ordemB.id, tokenB, key, ordemB.version);

    /*
      B executa normalmente: a chave dele é dele.

      Se o escopo fosse só `(operação, chave)`, B receberia o desfecho gravado
      por A — um oráculo sobre a operação de um colega. O contrário também
      seria ruim: B ficaria bloqueado por uma chave que nunca usou.
    */
    expect(response.status).toBe(200);
    const iniciada = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: ordemB.id },
    });
    expect(iniciada.status).toBe("IN_PROGRESS");

    // Duas reservas distintas, uma por pessoa.
    const registros = await prisma.idempotencyRecord.findMany({ where: { key } });
    expect(registros).toHaveLength(2);
    expect(new Set(registros.map((r) => r.userId)).size).toBe(2);
  });

  it("o registro de idempotência carrega a empresa do dono", async () => {
    const s = await scenario();
    const key = "start-escopo-empresa-1";
    await callStart(s.order.id, s.token, key, s.order.version);

    const registro = await prisma.idempotencyRecord.findFirstOrThrow({
      where: { key },
    });
    expect(registro.companyId).toBe(fixture.companyA.id);
    expect(registro.userId).toBe(fixture.techA.id);
    // A impressão digital não guarda segredo: só o payload do comando.
    expect(registro.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// Conflito de versão
// ---------------------------------------------------------------------------

describe("expectedVersion — CAS de ponta a ponta", () => {
  it("versão correta passa", async () => {
    const s = await scenario();
    const response = await callStart(
      s.order.id,
      s.token,
      "start-versao-certa-01",
      s.order.version,
    );
    expect(response.status).toBe(200);
  });

  it("versão velha é 409 com conflict: true", async () => {
    const s = await scenario();

    // Alguém mexeu na OS enquanto o técnico estava sem rede.
    await prisma.serviceOrder.update({
      where: { id: s.order.id },
      data: { priority: "HIGH", version: { increment: 1 } },
    });

    const response = await callStart(
      s.order.id,
      s.token,
      "start-versao-velha-01",
      s.order.version,
    );

    expect(response.status).toBe(409);
    const payload = await body(response);
    expect(payload.error?.code).toBe("CONFLICT");
    // É o sinal para o app RECARREGAR, não para reenviar.
    expect(payload.error?.conflict).toBe(true);
    expect(payload.error?.retryable).toBe(false);

    const order = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: s.order.id },
    });
    expect(order.status).toBe("ASSIGNED");
    expect(order.startedAt).toBeNull();
  });

  it("falha não fica memorizada — a mesma chave pode ser reenviada depois", async () => {
    const s = await scenario();
    const key = "start-falha-depois-ok1";

    // Primeira tentativa com versão errada: recusada.
    const ruim = await callStart(s.order.id, s.token, key, s.order.version + 9);
    expect(ruim.status).toBe(409);

    // A reserva não pode ter sobrado, senão a chave ficaria queimada para
    // sempre e o app teria uma operação impossível de completar.
    expect(await prisma.idempotencyRecord.count({ where: { key } })).toBe(0);

    // Agora com a versão certa: passa.
    const bom = await callStart(s.order.id, s.token, key, s.order.version);
    expect(bom.status).toBe(200);
  });

  it("duas requisições SIMULTÂNEAS iniciam a OS uma única vez", async () => {
    const s = await scenario();

    // Chaves diferentes de propósito: aqui quem tem de arbitrar é o
    // compare-and-set, não a desduplicação.
    const [a, b] = await Promise.all([
      callStart(s.order.id, s.token, "start-corrida-aaaa01", s.order.version),
      callStart(s.order.id, s.token, "start-corrida-bbbb02", s.order.version),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);

    const order = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: s.order.id },
    });
    expect(order.version).toBe(s.order.version + 1);
    expect(
      await prisma.serviceOrderExecution.count({
        where: { serviceOrderId: s.order.id },
      }),
    ).toBe(1);
    expect(
      await prisma.serviceOrderEvent.count({
        where: { serviceOrderId: s.order.id, event: "OS_STARTED" },
      }),
    ).toBe(1);
  });
});
