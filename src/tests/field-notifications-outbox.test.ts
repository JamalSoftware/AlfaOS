import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GET as listNotificationsRoute, POST as markReadRoute } from "@/app/api/field/v1/notifications/route";
import { assignTechnician } from "@/lib/service-orders";
import { DomainError } from "@/lib/errors";
import {
  OUTBOX_MAX_ATTEMPTS,
  outboxBackoffMs,
  processOutboxBatch,
  requeueFailedOutboxEvent,
} from "@/lib/outbox";
import { handleOutboxEvent } from "@/lib/outbox-handlers";
import {
  resetPushProvider,
  setPushProvider,
  type PushMessage,
  type PushNotificationProvider,
} from "@/lib/push/provider";
import { prisma } from "@/lib/prisma";
import {
  allocateTestServiceOrderNumber,
  fieldRequest,
  registerTestDevice,
  seedTestData,
  type TestFixture,
} from "./helpers";

/**
 * Notificação e outbox transacional.
 *
 * A propriedade central: **atribuir uma OS grava as quatro coisas juntas ou
 * nenhuma**. O que este arquivo impede é o par de desfechos que a §156 do PRD
 * descreve — push de uma atribuição que sofreu rollback, e atribuição gravada
 * cujo aviso se perdeu.
 */

let fixture: TestFixture;

/** Provider de teste: registra o que recebeu, sem rede. */
class FakePush implements PushNotificationProvider {
  readonly name = "fake";
  readonly sent: PushMessage[] = [];
  invalid: string[] = [];
  falhar = false;

  async send(message: PushMessage) {
    if (this.falhar) throw new Error("provider fora do ar");
    this.sent.push(message);
    return { delivered: message.tokens.length, invalidTokens: this.invalid };
  }
}

let push: FakePush;

beforeEach(async () => {
  fixture = await seedTestData();
  push = new FakePush();
  setPushProvider(push);
});

afterEach(() => {
  resetPushProvider();
});

async function body(response: Response) {
  return (await response.json()) as {
    ok: boolean;
    data?: Record<string, unknown>;
    error?: { code: string };
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
    data: {
      companyId: fixture.companyA.id,
      name: "Maria da Silva",
      document: "12345678901",
      phone: "(28) 99999-0001",
      address: "Rua das Flores",
      number: "84",
      city: "Guaçuí",
    },
  });
  const order = await prisma.serviceOrder.create({
    data: {
      companyId: fixture.companyA.id,
      number: await allocateTestServiceOrderNumber(fixture.companyA.id),
      customerId: customer.id,
      type: "Instalação",
      description: "Instalação de fibra.",
      priority: "NORMAL",
      status: "PENDING",
    },
  });
  return { technicianA, technicianB, customer, order };
}

// ---------------------------------------------------------------------------
// Atomicidade
// ---------------------------------------------------------------------------

describe("atribuir OS grava tudo na mesma transação", () => {
  it("OS + evento + notificação + outbox aparecem juntos", async () => {
    const s = await scenario();

    await assignTechnician(
      fixture.companyA.id,
      fixture.adminA.id,
      s.order.id,
      s.technicianA.id,
      s.order.version,
    );

    const order = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: s.order.id },
    });
    expect(order.status).toBe("ASSIGNED");
    expect(order.technicianId).toBe(s.technicianA.id);
    expect(order.version).toBe(s.order.version + 1);

    expect(
      await prisma.serviceOrderEvent.count({
        where: { serviceOrderId: s.order.id, event: "TECHNICIAN_ASSIGNED" },
      }),
    ).toBe(1);

    const notifications = await prisma.notification.findMany({
      where: { companyId: fixture.companyA.id },
    });
    expect(notifications).toHaveLength(1);
    expect(notifications[0].userId).toBe(fixture.techA.id);
    expect(notifications[0].technicianId).toBe(s.technicianA.id);
    expect(notifications[0].resourceId).toBe(s.order.id);
    expect(notifications[0].readAt).toBeNull();

    const outbox = await prisma.outboxEvent.findMany();
    expect(outbox).toHaveLength(1);
    expect(outbox[0].eventType).toBe("SERVICE_ORDER_ASSIGNED");
    expect(outbox[0].status).toBe("PENDING");
    expect(outbox[0].companyId).toBe(fixture.companyA.id);
    expect(outbox[0].aggregateId).toBe(s.order.id);
  });

  it("falha no compare-and-set NÃO deixa notificação nem evento de outbox", async () => {
    const s = await scenario();

    // Alguém mexeu antes: a versão que o despachante tinha ficou velha.
    await prisma.serviceOrder.update({
      where: { id: s.order.id },
      data: { priority: "HIGH", version: { increment: 1 } },
    });

    await expect(
      assignTechnician(
        fixture.companyA.id,
        fixture.adminA.id,
        s.order.id,
        s.technicianA.id,
        s.order.version,
      ),
    ).rejects.toBeInstanceOf(DomainError);

    /*
      Nada sobrou.

      É o teste que prova que a notificação está DENTRO da transação. Se ela
      estivesse fora, o técnico receberia aviso de uma atribuição que não
      aconteceu — e iria até o endereço.
    */
    expect(await prisma.notification.count()).toBe(0);
    expect(await prisma.outboxEvent.count()).toBe(0);
    expect(
      await prisma.serviceOrderEvent.count({
        where: { serviceOrderId: s.order.id },
      }),
    ).toBe(0);

    const order = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: s.order.id },
    });
    expect(order.technicianId).toBeNull();
    expect(order.status).toBe("PENDING");
  });

  it("o texto da notificação não carrega dado pessoal", async () => {
    const s = await scenario();
    await assignTechnician(
      fixture.companyA.id,
      fixture.adminA.id,
      s.order.id,
      s.technicianA.id,
      s.order.version,
    );

    const notification = await prisma.notification.findFirstOrThrow();
    const texto = `${notification.title} ${notification.body}`;

    // Controle positivo: identifica a OS pelo número operacional.
    expect(texto).toContain(String(s.order.number));

    // E não põe na tela bloqueada nada que não deva ficar dias na central
    // de notificações de um celular apoiado no painel do carro.
    expect(texto).not.toContain("Maria da Silva");
    expect(texto).not.toContain("12345678901");
    expect(texto).not.toContain("99999-0001");
    expect(texto).not.toContain("Rua das Flores");
  });

  it("o payload do outbox carrega só referências", async () => {
    const s = await scenario();
    await assignTechnician(
      fixture.companyA.id,
      fixture.adminA.id,
      s.order.id,
      s.technicianA.id,
      s.order.version,
    );

    const event = await prisma.outboxEvent.findFirstOrThrow();
    const serial = JSON.stringify(event.payload);

    // Identificadores, sim.
    expect(serial).toContain(s.order.id);
    // Conteúdo, não. A tabela vai para dump e para backup.
    expect(serial).not.toContain("Maria da Silva");
    expect(serial).not.toContain("12345678901");
    expect(serial).not.toContain("Rua das Flores");
  });

  it("na TROCA de técnico, só o novo é notificado", async () => {
    const s = await scenario();

    const depoisDoPrimeiro = await assignTechnician(
      fixture.companyA.id,
      fixture.adminA.id,
      s.order.id,
      s.technicianA.id,
      s.order.version,
    );
    await prisma.notification.deleteMany();

    await assignTechnician(
      fixture.companyA.id,
      fixture.adminA.id,
      s.order.id,
      s.technicianB.id,
      depoisDoPrimeiro.version,
    );

    const notifications = await prisma.notification.findMany();
    expect(notifications).toHaveLength(1);
    // B recebe "nova atribuição". A NÃO recebe — dizer a ele que ganhou a OS
    // que acabou de perder seria mentira. Avisar que ela SAIU dele é outra
    // mensagem, e ainda não foi decidida.
    expect(notifications[0].userId).toBe(fixture.techB.id);
  });
});

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

describe("worker do outbox", () => {
  async function atribuirComAparelho(pushToken: string | null) {
    const s = await scenario();
    await registerTestDevice(fixture.techA.id, { pushToken });
    await assignTechnician(
      fixture.companyA.id,
      fixture.adminA.id,
      s.order.id,
      s.technicianA.id,
      s.order.version,
    );
    return s;
  }

  it("processa o evento e entrega ao provider", async () => {
    await atribuirComAparelho("fcm-token-do-tecnico");

    const result = await processOutboxBatch(handleOutboxEvent);
    expect(result.claimed).toBe(1);
    expect(result.processed).toBe(1);
    expect(result.failed).toBe(0);

    expect(push.sent).toHaveLength(1);
    expect(push.sent[0].tokens).toEqual(["fcm-token-do-tecnico"]);
    expect(push.sent[0].data?.resourceType).toBe("ServiceOrder");

    const event = await prisma.outboxEvent.findFirstOrThrow();
    expect(event.status).toBe("PROCESSED");
    expect(event.processedAt).toBeInstanceOf(Date);
    expect(event.lastError).toBeNull();
  });

  it("processar duas vezes não entrega duas vezes", async () => {
    await atribuirComAparelho("fcm-token-do-tecnico");

    await processOutboxBatch(handleOutboxEvent);
    const segunda = await processOutboxBatch(handleOutboxEvent);

    expect(segunda.claimed).toBe(0);
    expect(push.sent).toHaveLength(1);
  });

  it("técnico sem aparelho não quebra o worker — a notificação já está gravada", async () => {
    await atribuirComAparelho(null);

    const result = await processOutboxBatch(handleOutboxEvent);
    expect(result.processed).toBe(1);
    expect(push.sent).toHaveLength(0);

    // O que importa sobreviveu: o técnico vê a atribuição ao abrir o app.
    expect(await prisma.notification.count()).toBe(1);
  });

  it("falha do provider adia com backoff e conta a tentativa", async () => {
    await atribuirComAparelho("fcm-token-do-tecnico");
    push.falhar = true;

    const result = await processOutboxBatch(handleOutboxEvent);
    expect(result.failed).toBe(1);
    expect(result.processed).toBe(0);

    const event = await prisma.outboxEvent.findFirstOrThrow();
    expect(event.status).toBe("PENDING");
    expect(event.attempts).toBe(1);
    expect(event.availableAt.getTime()).toBeGreaterThan(Date.now());
    expect(event.lastError).toContain("provider fora do ar");
  });

  it("evento adiado não é reivindicado antes da hora", async () => {
    await atribuirComAparelho("fcm-token-do-tecnico");
    push.falhar = true;
    await processOutboxBatch(handleOutboxEvent);

    push.falhar = false;
    const agora = await processOutboxBatch(handleOutboxEvent);
    expect(agora.claimed).toBe(0);
    expect(push.sent).toHaveLength(0);
  });

  it("esgotar as tentativas vira FAILED, visível e com motivo", async () => {
    await atribuirComAparelho("fcm-token-do-tecnico");
    push.falhar = true;

    const event = await prisma.outboxEvent.findFirstOrThrow();
    await prisma.outboxEvent.update({
      where: { id: event.id },
      data: { attempts: OUTBOX_MAX_ATTEMPTS, availableAt: new Date() },
    });

    const result = await processOutboxBatch(handleOutboxEvent);
    expect(result.exhausted).toBe(1);

    const depois = await prisma.outboxEvent.findFirstOrThrow();
    expect(depois.status).toBe("FAILED");
    expect(depois.lastError).toBeTruthy();
  });

  it("evento FAILED pode ser reprocessado depois de corrigida a causa", async () => {
    await atribuirComAparelho("fcm-token-do-tecnico");
    const event = await prisma.outboxEvent.findFirstOrThrow();
    await prisma.outboxEvent.update({
      where: { id: event.id },
      data: { status: "FAILED", attempts: OUTBOX_MAX_ATTEMPTS },
    });

    expect(
      await requeueFailedOutboxEvent(fixture.companyA.id, event.id),
    ).toBe(true);
    // Isolamento por empresa vale aqui também.
    expect(await requeueFailedOutboxEvent(fixture.companyB.id, event.id)).toBe(
      false,
    );

    const result = await processOutboxBatch(handleOutboxEvent);
    expect(result.processed).toBe(1);
  });

  it("token recusado em definitivo é limpo do aparelho", async () => {
    await atribuirComAparelho("fcm-token-morto");
    push.invalid = ["fcm-token-morto"];

    await processOutboxBatch(handleOutboxEvent);

    const device = await prisma.mobileDevice.findFirstOrThrow({
      where: { userId: fixture.techA.id },
    });
    expect(device.pushToken).toBeNull();
    // Limpar o token não revoga o acesso: é fato sobre a permissão de
    // notificação, não sobre o direito de entrar.
    expect(device.status).toBe("ACTIVE");
    expect(device.tokenHash).not.toBeNull();
  });

  it("o backoff cresce e tem teto", async () => {
    expect(outboxBackoffMs(1)).toBeLessThan(outboxBackoffMs(2));
    expect(outboxBackoffMs(2)).toBeLessThan(outboxBackoffMs(3));
    expect(outboxBackoffMs(99)).toBe(outboxBackoffMs(100));
  });
});

// ---------------------------------------------------------------------------
// Central de notificações
// ---------------------------------------------------------------------------

describe("central de notificações do técnico", () => {
  async function comDuasNotificacoes() {
    const s = await scenario();
    await assignTechnician(
      fixture.companyA.id,
      fixture.adminA.id,
      s.order.id,
      s.technicianA.id,
      s.order.version,
    );
    // Uma do colega, que nunca pode aparecer.
    await prisma.notification.create({
      data: {
        companyId: fixture.companyA.id,
        userId: fixture.techB.id,
        technicianId: s.technicianB.id,
        type: "SERVICE_ORDER_ASSIGNED",
        title: "Do colega",
        body: "Não é sua.",
      },
    });
    const { token } = await registerTestDevice(fixture.techA.id);
    return { ...s, token };
  }

  it("o técnico vê apenas as próprias", async () => {
    const s = await comDuasNotificacoes();

    const response = await listNotificationsRoute(
      fieldRequest("/api/field/v1/notifications", { token: s.token }),
    );
    expect(response.status).toBe(200);

    const data = (await body(response)).data as {
      items: Array<{ title: string }>;
      unreadCount: number;
    };
    expect(data.items).toHaveLength(1);
    expect(data.items[0].title).toBe("Nova OS atribuída");
    expect(data.unreadCount).toBe(1);
  });

  it("marcar como lida é idempotente e não mexe no carimbo original", async () => {
    const s = await comDuasNotificacoes();

    const primeira = await markReadRoute(
      fieldRequest("/api/field/v1/notifications", {
        method: "POST",
        token: s.token,
        body: {},
      }),
    );
    expect(((await body(primeira)).data as { updated: number }).updated).toBe(1);

    const marcada = await prisma.notification.findFirstOrThrow({
      where: { userId: fixture.techA.id },
    });
    const carimbo = marcada.readAt;

    const segunda = await markReadRoute(
      fieldRequest("/api/field/v1/notifications", {
        method: "POST",
        token: s.token,
        body: {},
      }),
    );
    expect(((await body(segunda)).data as { updated: number }).updated).toBe(0);

    const depois = await prisma.notification.findFirstOrThrow({
      where: { userId: fixture.techA.id },
    });
    expect(depois.readAt?.getTime()).toBe(carimbo?.getTime());
  });

  it("marcar a notificação de um colega não faz nada", async () => {
    const s = await comDuasNotificacoes();
    const doColega = await prisma.notification.findFirstOrThrow({
      where: { userId: fixture.techB.id },
    });

    const response = await markReadRoute(
      fieldRequest("/api/field/v1/notifications", {
        method: "POST",
        token: s.token,
        body: { ids: [doColega.id] },
      }),
    );

    // Nem erro, nem efeito: o id simplesmente não casa nenhuma linha do dono
    // do token. Responder 404 seria confirmar que aquele id existe.
    expect(response.status).toBe(200);
    expect(((await body(response)).data as { updated: number }).updated).toBe(0);

    const intacta = await prisma.notification.findUniqueOrThrow({
      where: { id: doColega.id },
    });
    expect(intacta.readAt).toBeNull();
  });

  it("sem token, a central não responde", async () => {
    await comDuasNotificacoes();
    const response = await listNotificationsRoute(
      fieldRequest("/api/field/v1/notifications"),
    );
    expect(response.status).toBe(401);
  });
});
