import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { logoutField, revokeDevice } from "@/lib/field/devices";
import { handleOutboxEvent } from "@/lib/outbox-handlers";
import { OUTBOX_EVENTS } from "@/lib/outbox";
import { NOTIFICATION_TYPES } from "@/lib/notifications";
import {
  resetPushProvider,
  setPushProvider,
  type PushDeliveryResult,
  type PushMessage,
  type PushNotificationProvider,
} from "@/lib/push/provider";
import { seedTestData, type TestFixture } from "./helpers";

/**
 * # O aparelho de onde o técnico saiu para de ser alvo (`NF-1`)
 *
 * Defeito encontrado no levantamento do `NF-0`: `logoutField` zerava o token de
 * sessão e **mantinha o `pushToken`**, com `status: ACTIVE` e `revokedAt: null`
 * — exatamente o predicado que o worker usa para escolher destinos.
 *
 * O token de push é da **instalação**, não da pessoa. Quem entrasse depois no
 * mesmo aparelho leria, na própria tela, a notificação do técnico anterior. Só
 * não acontecia porque o provider era inerte.
 */

class Espia implements PushNotificationProvider {
  readonly name = "espia";
  readonly enviados: PushMessage[] = [];
  async send(message: PushMessage): Promise<PushDeliveryResult> {
    this.enviados.push(message);
    return {
      delivered: message.tokens.length,
      invalidTokens: [],
      retryableFailures: 0,
    };
  }
}

let fixture: TestFixture;
let push: Espia;

beforeEach(async () => {
  fixture = await seedTestData();
  push = new Espia();
  setPushProvider(push);
});

afterEach(() => {
  resetPushProvider();
});

async function device(
  installationId: string,
  pushToken: string,
  userId?: string,
): Promise<{ id: string }> {
  return prisma.mobileDevice.create({
    data: {
      companyId: fixture.companyA.id,
      userId: userId ?? fixture.techA.id,
      platform: "ANDROID",
      installationId,
      pushToken,
      tokenHash: `hash-${installationId}`,
      tokenIssuedAt: new Date(),
      tokenExpiresAt: new Date(Date.now() + 3_600_000),
      status: "ACTIVE",
    },
    select: { id: true },
  });
}

function principalDe(deviceId: string, userId?: string) {
  return {
    user: { id: userId ?? fixture.techA.id, companyId: fixture.companyA.id },
    device: { id: deviceId },
  } as Parameters<typeof logoutField>[0];
}

async function estadoDe(id: string) {
  return prisma.mobileDevice.findUniqueOrThrow({
    where: { id },
    select: {
      pushToken: true,
      tokenHash: true,
      status: true,
      revokedAt: true,
    },
  });
}

async function eventoPara(userId: string) {
  const n = await prisma.notification.create({
    data: {
      companyId: fixture.companyA.id,
      userId,
      type: NOTIFICATION_TYPES.SERVICE_ORDER_ASSIGNED,
      title: "Nova OS atribuída",
      body: "OS Nº 7 · Instalação",
      resourceType: "ServiceOrder",
      resourceId: "os-7",
    },
    select: { id: true },
  });
  return {
    companyId: fixture.companyA.id,
    eventType: OUTBOX_EVENTS.SERVICE_ORDER_ASSIGNED,
    aggregateType: "ServiceOrder",
    aggregateId: "os-7",
    payload: { notificationId: n.id },
    attempts: 1,
  };
}

// ---------------------------------------------------------------------------

describe("LOGOUT-PUSH-01 · sair do aplicativo tira o token de push", () => {
  it("o `pushToken` fica nulo, e o aparelho continua ACTIVE", async () => {
    const d = await device("i1", "tok-1");

    await logoutField(principalDe(d.id));

    const depois = await estadoDe(d.id);
    expect(depois.pushToken).toBeNull();
    expect(depois.tokenHash).toBeNull();
    /*
      Limpar o token NÃO é revogar. Sair do aplicativo não é o mesmo que perder
      o aparelho: a linha continua reaproveitável, e o próximo login registra um
      token novo pelo caminho que já existe.
    */
    expect(depois.status).toBe("ACTIVE");
    expect(depois.revokedAt).toBeNull();
  });

  it("depois do logout o aparelho deixa de ser alvo do push", async () => {
    const d = await device("i1", "tok-1");
    await logoutField(principalDe(d.id));

    await handleOutboxEvent(await eventoPara(fixture.techA.id));

    // Este é o defeito, na sua forma observável.
    expect(push.enviados).toHaveLength(0);
  });

  it("o técnico SEGUINTE no mesmo aparelho não lê o push do anterior", async () => {
    /*
      O cenário que dá nome ao achado. O token de push pertence à INSTALAÇÃO:
      sem a limpeza, uma OS atribuída ao técnico A depois do logout chegaria na
      tela do técnico B, que está com o aparelho na mão.
    */
    const daA = await device("i-compartilhada", "tok-aparelho");
    await logoutField(principalDe(daA.id));

    // O técnico B entra no mesmo aparelho e registra o mesmo token.
    await device("i-compartilhada", "tok-aparelho", fixture.techB.id);

    await handleOutboxEvent(await eventoPara(fixture.techA.id));

    expect(push.enviados).toHaveLength(0);
  });
});

describe("LOGOUT-PUSH-02 · o logout é DESTE aparelho, e só dele", () => {
  it("o outro aparelho do mesmo usuário continua recebendo", async () => {
    const saindo = await device("i1", "tok-1");
    const ficando = await device("i2", "tok-2");

    await logoutField(principalDe(saindo.id));

    expect((await estadoDe(saindo.id)).pushToken).toBeNull();
    expect((await estadoDe(ficando.id)).pushToken).toBe("tok-2");

    await handleOutboxEvent(await eventoPara(fixture.techA.id));
    expect(push.enviados[0].tokens).toEqual(["tok-2"]);
  });
});

describe("LOGOUT-PUSH-03 · a revogação continua sendo mais forte", () => {
  it("revogar limpa o token E marca o aparelho", async () => {
    const d = await device("i1", "tok-1");

    await revokeDevice(fixture.companyA.id, fixture.adminA.id, d.id);

    const depois = await estadoDe(d.id);
    expect(depois.pushToken).toBeNull();
    expect(depois.tokenHash).toBeNull();
    // A diferença para o logout: aqui o aparelho PERDE o direito de voltar.
    expect(depois.status).toBe("REVOKED");
    expect(depois.revokedAt).not.toBeNull();
  });
});
