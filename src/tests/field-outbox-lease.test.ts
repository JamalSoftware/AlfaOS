import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  OUTBOX_LEASE_MS,
  OUTBOX_MAX_ATTEMPTS,
  enqueueOutboxEvent,
  processOutboxBatch,
  requeueFailedOutboxEvent,
} from "@/lib/outbox";
import {
  resetPushProvider,
  setPushProvider,
  type PushMessage,
  type PushNotificationProvider,
} from "@/lib/push/provider";
import { seedTestData, type TestFixture } from "./helpers";

/**
 * OBX-01 — reivindicação abandonada tem de voltar para a fila.
 *
 * O defeito original: `processOutboxBatch` só procurava `PENDING` e
 * `requeueFailedOutboxEvent` só aceitava `FAILED`. Um worker que morresse entre
 * reivindicar e concluir deixava o evento em `PROCESSING` — e **ninguém mais
 * olhava para ele**. O aviso sumia em silêncio, que é exatamente o desfecho que
 * a fila existe para evitar.
 *
 * A recuperação é por lease: a reivindicação tem prazo, e prazo vencido volta a
 * ser elegível.
 */

let fixture: TestFixture;

class ContadorPush implements PushNotificationProvider {
  readonly name = "contador";
  readonly sent: PushMessage[] = [];
  async send(message: PushMessage) {
    this.sent.push(message);
    return { delivered: message.tokens.length, invalidTokens: [] };
  }
}

let push: ContadorPush;

beforeEach(async () => {
  fixture = await seedTestData();
  push = new ContadorPush();
  setPushProvider(push);
});

afterEach(() => {
  resetPushProvider();
});

/** Um evento cru, sem depender do fluxo de atribuição. */
async function enfileirar() {
  await prisma.$transaction(async (tx) => {
    await enqueueOutboxEvent(tx, {
      companyId: fixture.companyA.id,
      eventType: "SERVICE_ORDER_ASSIGNED",
      aggregateType: "ServiceOrder",
      aggregateId: "os-de-teste",
      payload: { notificationId: "nao-existe" },
    });
  });
  return prisma.outboxEvent.findFirstOrThrow();
}

/**
 * Handler que não faz nada.
 *
 * O objeto do teste é o MECANISMO de reivindicação, não o que é entregue.
 * Um handler real arrastaria notificação, dispositivo e provider para dentro de
 * um teste sobre lease.
 */
const inerte = async () => {};

/** Handler que morre — o worker que trava sem marcar nada. */
const morre = async () => {
  throw new Error("worker morreu");
};

describe("OBX-01 · lease e reclaim", () => {
  it("reivindicar grava o prazo do lease", async () => {
    const event = await enfileirar();
    const antes = Date.now();

    const result = await processOutboxBatch(inerte);
    expect(result.claimed).toBe(1);
    expect(result.processed).toBe(1);

    const depois = await prisma.outboxEvent.findUniqueOrThrow({
      where: { id: event.id },
    });
    // Concluído: o lease é liberado, senão um evento PROCESSED pareceria
    // eternamente reivindicado.
    expect(depois.status).toBe("PROCESSED");
    expect(depois.leaseExpiresAt).toBeNull();
    expect(depois.processedAt!.getTime()).toBeGreaterThanOrEqual(antes);
  });

  it("PROCESSING com lease VÁLIDO não é roubado por outro worker", async () => {
    const event = await enfileirar();
    await prisma.outboxEvent.update({
      where: { id: event.id },
      data: {
        status: "PROCESSING",
        attempts: 1,
        leaseExpiresAt: new Date(Date.now() + OUTBOX_LEASE_MS),
      },
    });

    const result = await processOutboxBatch(inerte);
    expect(result.claimed).toBe(0);
    expect(push.sent).toHaveLength(0);

    const depois = await prisma.outboxEvent.findUniqueOrThrow({
      where: { id: event.id },
    });
    expect(depois.status).toBe("PROCESSING");
    // A tentativa do dono não foi consumida por um vizinho curioso.
    expect(depois.attempts).toBe(1);
  });

  it("PROCESSING com lease VENCIDO é recuperado", async () => {
    const event = await enfileirar();
    await prisma.outboxEvent.update({
      where: { id: event.id },
      data: {
        status: "PROCESSING",
        attempts: 1,
        leaseExpiresAt: new Date(Date.now() - 1000),
      },
    });

    const result = await processOutboxBatch(inerte);
    expect(result.claimed).toBe(1);
    expect(result.processed).toBe(1);

    const depois = await prisma.outboxEvent.findUniqueOrThrow({
      where: { id: event.id },
    });
    expect(depois.status).toBe("PROCESSED");
    expect(depois.attempts).toBe(2);
  });

  it("PROCESSING antigo SEM lease usa updatedAt como idade", async () => {
    // Linha reivindicada antes de a coluna existir. Sem o fallback ela ficaria
    // presa para sempre — que é justamente o defeito relatado.
    const event = await enfileirar();
    await prisma.$executeRaw`
      UPDATE outbox_events
      SET status = 'PROCESSING', attempts = 1, "leaseExpiresAt" = NULL,
          "updatedAt" = NOW() - INTERVAL '1 hour'
      WHERE id = ${event.id}
    `;

    const result = await processOutboxBatch(inerte);
    expect(result.claimed).toBe(1);

    const depois = await prisma.outboxEvent.findUniqueOrThrow({
      where: { id: event.id },
    });
    expect(depois.status).toBe("PROCESSED");
  });

  it("PROCESSING antigo sem lease e RECENTE ainda é respeitado", async () => {
    const event = await enfileirar();
    await prisma.$executeRaw`
      UPDATE outbox_events
      SET status = 'PROCESSING', attempts = 1, "leaseExpiresAt" = NULL,
          "updatedAt" = NOW()
      WHERE id = ${event.id}
    `;

    const result = await processOutboxBatch(inerte);
    expect(result.claimed).toBe(0);
  });

  it("crash antes de concluir: o próximo ciclo recupera", async () => {
    const event = await enfileirar();

    // Ciclo 1: o handler morre. O evento volta para PENDING com backoff.
    const primeiro = await processOutboxBatch(morre);
    expect(primeiro.claimed).toBe(1);
    expect(primeiro.failed).toBe(1);

    const meio = await prisma.outboxEvent.findUniqueOrThrow({
      where: { id: event.id },
    });
    expect(meio.status).toBe("PENDING");
    expect(meio.leaseExpiresAt).toBeNull();

    // Ciclo 2, depois do backoff: entrega.
    await prisma.outboxEvent.update({
      where: { id: event.id },
      data: { availableAt: new Date(Date.now() - 1000) },
    });
    const segundo = await processOutboxBatch(inerte);
    expect(segundo.processed).toBe(1);
  });

  it("processo morto de verdade: PROCESSING órfão volta pela expiração", async () => {
    /*
      A diferença para o teste acima é o que o defeito realmente era. Ali o
      handler lançou, então o `catch` devolveu o evento para PENDING. Aqui o
      PROCESSO morreu — nenhum `catch` rodou, e a linha ficou como estava.
    */
    const event = await enfileirar();
    await prisma.outboxEvent.update({
      where: { id: event.id },
      data: {
        status: "PROCESSING",
        attempts: 1,
        leaseExpiresAt: new Date(Date.now() + OUTBOX_LEASE_MS),
      },
    });

    // Enquanto o lease vale, ninguém encosta — nem em várias passagens.
    for (let i = 0; i < 3; i += 1) {
      expect((await processOutboxBatch(inerte)).claimed).toBe(0);
    }

    // Vencido, é recuperado.
    await prisma.outboxEvent.update({
      where: { id: event.id },
      data: { leaseExpiresAt: new Date(Date.now() - 1) },
    });
    expect((await processOutboxBatch(inerte)).processed).toBe(1);
  });

  it("três workers simultâneos: o evento é processado UMA vez", async () => {
    await enfileirar();

    let execucoes = 0;
    const handler = async () => {
      execucoes += 1;
      await new Promise((r) => setTimeout(r, 20));
    };

    const resultados = await Promise.all([
      processOutboxBatch(handler),
      processOutboxBatch(handler),
      processOutboxBatch(handler),
    ]);

    expect(execucoes).toBe(1);
    expect(resultados.reduce((s, r) => s + r.claimed, 0)).toBe(1);
  });

  it("reclaim em laço não é infinito: vira FAILED ao estourar o teto", async () => {
    /*
      Um evento que derruba o processo nunca chega ao `catch`, então nunca
      viraria FAILED pelo caminho normal. Sem teto no reclaim, ele seria
      reivindicado para sempre, a cada lease vencido.
    */
    const event = await enfileirar();
    await prisma.outboxEvent.update({
      where: { id: event.id },
      data: {
        status: "PROCESSING",
        attempts: OUTBOX_MAX_ATTEMPTS,
        leaseExpiresAt: new Date(Date.now() - 1000),
      },
    });

    let execucoes = 0;
    const result = await processOutboxBatch(async () => {
      execucoes += 1;
    });

    expect(result.exhausted).toBe(1);
    // Não tentou entregar: o teto é conferido antes do handler.
    expect(execucoes).toBe(0);

    const depois = await prisma.outboxEvent.findUniqueOrThrow({
      where: { id: event.id },
    });
    expect(depois.status).toBe("FAILED");
    expect(depois.lastError).toContain("sem concluir");
    expect(depois.leaseExpiresAt).toBeNull();
  });

  it("FAILED não é reprocessado sozinho — exige requeue explícito", async () => {
    const event = await enfileirar();
    await prisma.outboxEvent.update({
      where: { id: event.id },
      data: { status: "FAILED", attempts: OUTBOX_MAX_ATTEMPTS },
    });

    expect((await processOutboxBatch(inerte)).claimed).toBe(0);

    expect(
      await requeueFailedOutboxEvent(fixture.companyA.id, event.id),
    ).toBe(true);
    expect((await processOutboxBatch(inerte)).processed).toBe(1);
  });

  it("PROCESSED nunca volta", async () => {
    const event = await enfileirar();
    await processOutboxBatch(inerte);

    for (let i = 0; i < 3; i += 1) {
      expect((await processOutboxBatch(inerte)).claimed).toBe(0);
    }
    const depois = await prisma.outboxEvent.findUniqueOrThrow({
      where: { id: event.id },
    });
    expect(depois.status).toBe("PROCESSED");
  });

  it("requeue continua isolado por empresa", async () => {
    const event = await enfileirar();
    await prisma.outboxEvent.update({
      where: { id: event.id },
      data: { status: "FAILED" },
    });

    expect(
      await requeueFailedOutboxEvent(fixture.companyB.id, event.id),
    ).toBe(false);
    expect(
      await requeueFailedOutboxEvent(fixture.companyA.id, event.id),
    ).toBe(true);
  });
});
