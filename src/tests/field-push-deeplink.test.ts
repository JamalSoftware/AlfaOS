import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GET as getOrder } from "@/app/api/field/v1/service-orders/[id]/route";
import { processOutboxBatch } from "@/lib/outbox";
import { handleOutboxEvent } from "@/lib/outbox-handlers";
import { prisma } from "@/lib/prisma";
import {
  resetPushProvider,
  setPushProvider,
  type PushMessage,
  type PushNotificationProvider,
} from "@/lib/push/provider";
import { assignTechnician } from "@/lib/service-orders";
import {
  allocateTestServiceOrderNumber,
  fieldRequest,
  registerTestDevice,
  seedTestData,
  type TestFixture,
} from "./helpers";

/**
 * # O push indica destino; quem autoriza é o servidor (`NF-4`)
 *
 * O aplicativo passou a abrir uma OS a partir do toque numa notificação. O que
 * este arquivo prova é que **isso não concede acesso a nada**: o payload chega
 * pela rede, e o identificador que ele carrega passa pelo mesmo caminho
 * autenticado de sempre.
 *
 * Os dois cenários que importam são temporais e de tenant — a OS que deixou de
 * ser daquele técnico entre o envio e o toque, e a OS que nunca foi da empresa
 * dele.
 */

let fixture: TestFixture;

class FakePush implements PushNotificationProvider {
  readonly name = "fake";
  readonly sent: PushMessage[] = [];

  async send(message: PushMessage) {
    this.sent.push(message);
    return {
      delivered: message.tokens.length,
      invalidTokens: [],
      retryableFailures: 0,
    };
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
    error?: { code: string; message: string };
  };
}

async function cenario() {
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
  const device = await registerTestDevice(fixture.techA.id, {
    pushToken: "fcm-do-tecnico-A",
  });
  return { technicianA, technicianB, customer, order, device };
}

function abrir(orderId: string, token: string) {
  return getOrder(
    fieldRequest(`/api/field/v1/service-orders/${orderId}`, { token }),
    { params: { id: orderId } },
  );
}

// ---------------------------------------------------------------------------
// NF4-16 · posse vencida entre o envio e o toque
// ---------------------------------------------------------------------------

describe("NF4-16 · a OS foi reatribuída antes de o técnico tocar", () => {
  it("o push antigo não abre porta nenhuma", async () => {
    const s = await cenario();

    // 09:00 — a OS é do técnico A, e o aviso sai.
    await assignTechnician(
      fixture.companyA.id,
      fixture.dispatcherA.id,
      s.order.id,
      s.technicianA.id,
      s.order.version,
    );
    await processOutboxBatch(handleOutboxEvent);
    expect(push.sent).toHaveLength(1);

    // O payload que chegou ao aparelho de A.
    const enviado = push.sent[0].data as Record<string, string>;
    expect(enviado.resourceId).toBe(s.order.id);

    // 09:02 — o despacho reatribui para B.
    const atual = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: s.order.id },
    });
    await assignTechnician(
      fixture.companyA.id,
      fixture.dispatcherA.id,
      s.order.id,
      s.technicianB.id,
      atual.version,
    );

    // 09:03 — A toca o push, e o aplicativo abre a rota pelo caminho normal.
    const response = await abrir(enviado.resourceId, s.device.token);

    /*
      404, e não 403: confirmar a existência de uma OS que já não é dele
      revelaria que ela existe — e a lista de OS de uma empresa é informação
      operacional. É a mesma regra anti-enumeração do resto da superfície.
    */
    expect(response.status).toBe(404);
    const payload = await body(response);
    expect(payload.error?.code).toBe("NOT_FOUND");

    // E o corpo não vaza nada do que a OS continha.
    const serial = JSON.stringify(payload);
    expect(serial).not.toContain("Maria da Silva");
    expect(serial).not.toContain("12345678901");
    expect(serial).not.toContain("Rua das Flores");
  });

  it("o técnico NOVO abre a mesma OS normalmente", async () => {
    /*
      Controle positivo. Sem ele, o 404 acima poderia estar vindo de qualquer
      coisa — uma rota quebrada devolveria 404 com igual entusiasmo.
    */
    const s = await cenario();
    await assignTechnician(
      fixture.companyA.id,
      fixture.dispatcherA.id,
      s.order.id,
      s.technicianB.id,
      s.order.version,
    );
    const deB = await registerTestDevice(fixture.techB.id);

    const response = await abrir(s.order.id, deB.token);

    expect(response.status).toBe(200);
    const aberta = (await body(response)).data?.serviceOrder as {
      id: string;
    };
    expect(aberta.id).toBe(s.order.id);
  });
});

// ---------------------------------------------------------------------------
// NF4-17 · identificador de outra empresa
// ---------------------------------------------------------------------------

describe("NF4-17 · payload apontando para OS de outra empresa", () => {
  it("o identificador forjado é 404, mesmo com formato válido", async () => {
    const s = await cenario();

    const tecnicoDaB = await prisma.user.create({
      data: {
        companyId: fixture.companyB.id,
        name: "Tecnico da Empresa B",
        email: "tech@companyb.test",
        passwordHash: "hash-irrelevante-para-este-teste",
        profile: "TECHNICIAN",
      },
    });
    const technicianB = await prisma.technician.create({
      data: { companyId: fixture.companyB.id, userId: tecnicoDaB.id },
    });
    const clienteB = await prisma.customer.create({
      data: {
        companyId: fixture.companyB.id,
        name: "Cliente da B",
        document: "98765432100",
        phone: "(28) 98888-0002",
        address: "Rua B",
        number: "10",
        city: "Guaçuí",
      },
    });
    const ordemB = await prisma.serviceOrder.create({
      data: {
        companyId: fixture.companyB.id,
        number: await allocateTestServiceOrderNumber(fixture.companyB.id),
        customerId: clienteB.id,
        technicianId: technicianB.id,
        type: "Instalação",
        description: "Instalação na empresa B.",
        priority: "NORMAL",
        status: "ASSIGNED",
      },
    });

    /*
      O vetor é este: um payload forjado carrega o `resourceId` de uma OS da
      empresa B. O parser do aplicativo o aceita — o formato é legítimo, e ele
      não tem como saber de quem é a OS. Quem sabe é o servidor, e é ele que
      responde.
    */
    const response = await abrir(ordemB.id, s.device.token);

    expect(response.status).toBe(404);
    const serial = JSON.stringify(await body(response));
    expect(serial).not.toContain("Cliente da B");
    expect(serial).not.toContain("98765432100");

    // A OS da empresa B continua intacta e visível para quem é dela.
    const deB = await registerTestDevice(tecnicoDaB.id);
    const legitimo = await abrir(ordemB.id, deB.token);
    expect(legitimo.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// §39 · o payload continua mínimo
// ---------------------------------------------------------------------------

describe("o payload do push não cresceu", () => {
  it("carrega três identificadores, e nada de pessoal", async () => {
    const s = await cenario();
    await assignTechnician(
      fixture.companyA.id,
      fixture.dispatcherA.id,
      s.order.id,
      s.technicianA.id,
      s.order.version,
    );
    await processOutboxBatch(handleOutboxEvent);

    const mensagem = push.sent[0];
    const dados = mensagem.data as Record<string, string>;

    /*
      A regressão que importa: um campo útil acrescentado aqui — nome do
      cliente, telefone, endereço — chegaria à tela de bloqueio de um aparelho
      possivelmente perdido, e a notificação não tem como ser retirada de lá.
      O aplicativo usa apenas identificador, e o resto ele busca autenticado.
    */
    expect(Object.keys(dados).sort()).toEqual([
      "resourceId",
      "resourceType",
      "type",
    ]);
    expect(dados.type).toBe("SERVICE_ORDER_ASSIGNED");
    expect(dados.resourceType).toBe("ServiceOrder");
    expect(dados.resourceId).toBe(s.order.id);

    const serial = JSON.stringify(mensagem);
    expect(serial).not.toContain("Maria da Silva");
    expect(serial).not.toContain("12345678901");
    expect(serial).not.toContain("(28) 99999-0001");
    expect(serial).not.toContain("Rua das Flores");
  });

  it("o identificador é um segmento de caminho seguro", async () => {
    /*
      O parser do aplicativo recusa identificador com barra, ponto ou espaço,
      porque `resourceId` preenche UM segmento de `/orders/:id` e escapar dali
      deixaria o payload escolher a tela. Isto confirma a outra ponta: o que o
      servidor gera de fato cabe nessa regra.
    */
    const s = await cenario();
    await assignTechnician(
      fixture.companyA.id,
      fixture.dispatcherA.id,
      s.order.id,
      s.technicianA.id,
      s.order.version,
    );
    await processOutboxBatch(handleOutboxEvent);

    const id = (push.sent[0].data as Record<string, string>).resourceId;
    expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });
});
