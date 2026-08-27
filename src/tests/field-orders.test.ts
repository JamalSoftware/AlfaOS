import { describe, it, expect, beforeEach } from "vitest";
import { GET as listOrders } from "@/app/api/field/v1/service-orders/route";
import { GET as getOrder } from "@/app/api/field/v1/service-orders/[id]/route";
import { POST as startOrder } from "@/app/api/field/v1/service-orders/[id]/start/route";
import { POST as revealPassword } from "@/app/api/field/v1/service-orders/[id]/pppoe/reveal/route";
import { prisma } from "@/lib/prisma";
import { resetCapabilityLimits } from "@/lib/capability-rate-limit";
import {
  allocateTestServiceOrderNumber,
  fieldRequest,
  registerTestDevice,
  seedTestData,
  type TestFixture,
} from "./helpers";

/**
 * Listagem, detalhe e posse no Field.
 *
 * O eixo destes testes é: **o token decide de quem é a OS**. Nenhum parâmetro,
 * corpo ou cabeçalho pode trocar o dono, e OS alheia responde 404 — nunca 403,
 * que confirmaria a existência do id.
 */

let fixture: TestFixture;

beforeEach(async () => {
  fixture = await seedTestData();
  resetCapabilityLimits();
});

async function body(response: Response) {
  return (await response.json()) as {
    ok: boolean;
    data?: Record<string, unknown>;
    error?: { code: string; message: string; conflict: boolean };
  };
}

/** Cliente com TODOS os campos sensíveis preenchidos, para provar o que não sai. */
async function createCustomer(companyId: string, name = "Cliente Teste") {
  return prisma.customer.create({
    data: {
      companyId,
      name,
      document: "12345678901",
      phone: "(28) 99999-0001",
      secondaryPhone: "(28) 99999-0002",
      email: "cliente@exemplo.test",
      address: "Rua das Flores",
      number: "84",
      complement: "fundos",
      district: "Centro",
      city: "Guaçuí",
      state: "ES",
      zipCode: "29560-000",
      latitude: -20.7746,
      longitude: -41.6789,
    },
  });
}

async function createOrder(options: {
  companyId: string;
  customerId: string;
  technicianId?: string | null;
  status?: "PENDING" | "ASSIGNED" | "IN_PROGRESS" | "COMPLETED";
  origin?: "INTERNAL" | "EXTERNAL";
}) {
  return prisma.serviceOrder.create({
    data: {
      companyId: options.companyId,
      number: await allocateTestServiceOrderNumber(options.companyId),
      customerId: options.customerId,
      technicianId: options.technicianId ?? null,
      type: "Instalação",
      description: "Instalação de fibra óptica.",
      priority: "NORMAL",
      status: options.status ?? "ASSIGNED",
      assignedAt: options.technicianId ? new Date() : null,
      ...(options.origin === "EXTERNAL"
        ? {
            origin: "EXTERNAL" as const,
            externalProvider: "RECEITANET",
            externalId: "4629208",
            externalNumber: "1434",
          }
        : {}),
    },
  });
}

/** Técnico A da empresa A, com aparelho registrado e uma OS atribuída. */
async function scenario() {
  const technicianA = await prisma.technician.create({
    data: { companyId: fixture.companyA.id, userId: fixture.techA.id },
  });
  const technicianB = await prisma.technician.create({
    data: { companyId: fixture.companyA.id, userId: fixture.techB.id },
  });
  const customer = await createCustomer(fixture.companyA.id);
  const order = await createOrder({
    companyId: fixture.companyA.id,
    customerId: customer.id,
    technicianId: technicianA.id,
  });
  const { token } = await registerTestDevice(fixture.techA.id);
  return { technicianA, technicianB, customer, order, token };
}

// ---------------------------------------------------------------------------
// Minhas OS
// ---------------------------------------------------------------------------

describe("GET /service-orders — a fila é do portador do token", () => {
  it("lista apenas as OS do próprio técnico", async () => {
    const s = await scenario();
    const outroCliente = await createCustomer(fixture.companyA.id, "Outro");
    await createOrder({
      companyId: fixture.companyA.id,
      customerId: outroCliente.id,
      technicianId: s.technicianB.id,
    });

    const response = await listOrders(
      fieldRequest("/api/field/v1/service-orders", { token: s.token }),
    );
    expect(response.status).toBe(200);

    const data = (await body(response)).data as {
      items: Array<{ id: string }>;
    };
    expect(data.items).toHaveLength(1);
    expect(data.items[0].id).toBe(s.order.id);
  });

  it("technicianId na query NÃO troca o dono", async () => {
    const s = await scenario();
    const outroCliente = await createCustomer(fixture.companyA.id, "Outro");
    const daOutra = await createOrder({
      companyId: fixture.companyA.id,
      customerId: outroCliente.id,
      technicianId: s.technicianB.id,
    });

    const response = await listOrders(
      fieldRequest(
        `/api/field/v1/service-orders?technicianId=${s.technicianB.id}`,
        { token: s.token },
      ),
    );

    const data = (await body(response)).data as { items: Array<{ id: string }> };
    expect(data.items).toHaveLength(1);
    expect(data.items[0].id).toBe(s.order.id);
    expect(data.items.map((i) => i.id)).not.toContain(daOutra.id);
  });

  it("a fila traz ASSIGNED e IN_PROGRESS, não PENDING nem COMPLETED", async () => {
    const s = await scenario();
    const c2 = await createCustomer(fixture.companyA.id, "C2");
    const c3 = await createCustomer(fixture.companyA.id, "C3");
    await createOrder({
      companyId: fixture.companyA.id,
      customerId: c2.id,
      technicianId: s.technicianA.id,
      status: "IN_PROGRESS",
    });
    await createOrder({
      companyId: fixture.companyA.id,
      customerId: c3.id,
      technicianId: s.technicianA.id,
      status: "COMPLETED",
    });

    const response = await listOrders(
      fieldRequest("/api/field/v1/service-orders", { token: s.token }),
    );
    const data = (await body(response)).data as {
      items: Array<{ status: string }>;
    };
    expect(data.items).toHaveLength(2);
    expect(data.items.map((i) => i.status).sort()).toEqual([
      "ASSIGNED",
      "IN_PROGRESS",
    ]);
  });

  it("o payload da lista é compacto e não carrega dado pessoal", async () => {
    const s = await scenario();

    const response = await listOrders(
      fieldRequest("/api/field/v1/service-orders", { token: s.token }),
    );
    const data = (await body(response)).data as {
      items: Array<Record<string, unknown>>;
    };
    const item = data.items[0];

    // Tem o necessário para a tela decidir o dia.
    expect(item).toHaveProperty("number");
    expect(item).toHaveProperty("customerName");
    expect(item).toHaveProperty("version");
    expect(item.hasLocation).toBe(true);

    // E não tem nada além disso.
    const serial = JSON.stringify(item);
    expect(serial).not.toContain("12345678901"); // CPF
    expect(serial).not.toContain("99999-0001"); // telefone
    expect(serial).not.toContain("Rua das Flores"); // endereço
    expect(item).not.toHaveProperty("customer");
    // Coordenada da carteira inteira não desce para a lista.
    expect(item).not.toHaveProperty("latitude");
    expect(item).not.toHaveProperty("longitude");
  });

  it("paginação por cursor não repete nem pula", async () => {
    const s = await scenario();
    for (let i = 0; i < 4; i += 1) {
      const c = await createCustomer(fixture.companyA.id, `Cliente ${i}`);
      await createOrder({
        companyId: fixture.companyA.id,
        customerId: c.id,
        technicianId: s.technicianA.id,
      });
    }

    const first = (await body(
      await listOrders(
        fieldRequest("/api/field/v1/service-orders?limit=2", { token: s.token }),
      ),
    )).data as { items: Array<{ id: string }>; nextCursor: string | null };

    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();

    const second = (await body(
      await listOrders(
        fieldRequest(
          `/api/field/v1/service-orders?limit=2&cursor=${first.nextCursor}`,
          { token: s.token },
        ),
      ),
    )).data as { items: Array<{ id: string }>; nextCursor: string | null };

    const ids = [...first.items, ...second.items].map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ---------------------------------------------------------------------------
// Detalhe
// ---------------------------------------------------------------------------

describe("GET /service-orders/:id — posse e minimização", () => {
  it("o dono recebe o detalhe operacional", async () => {
    const s = await scenario();
    const response = await getOrder(
      fieldRequest(`/api/field/v1/service-orders/${s.order.id}`, {
        token: s.token,
      }),
      { params: { id: s.order.id } },
    );
    expect(response.status).toBe(200);

    const data = (await body(response)).data as {
      serviceOrder: {
        number: number;
        customer: Record<string, unknown>;
        version: number;
      };
    };
    // O que o técnico precisa para chegar e falar com o cliente.
    expect(data.serviceOrder.customer.phone).toBe("(28) 99999-0001");
    expect(data.serviceOrder.customer.secondaryPhone).toBe("(28) 99999-0002");
    expect(data.serviceOrder.customer.latitude).toBeCloseTo(-20.7746, 4);
    expect(data.serviceOrder.customer.longitude).toBeCloseTo(-41.6789, 4);
    expect(typeof data.serviceOrder.version).toBe("number");
  });

  it("o CPF do cliente NUNCA sai no detalhe", async () => {
    const s = await scenario();
    const response = await getOrder(
      fieldRequest(`/api/field/v1/service-orders/${s.order.id}`, {
        token: s.token,
      }),
      { params: { id: s.order.id } },
    );

    const serial = JSON.stringify(await body(response));
    expect(serial).not.toContain("12345678901");
    expect(serial).not.toContain("document");
  });

  it("OS de outro técnico é 404, não 403", async () => {
    const s = await scenario();
    const outroCliente = await createCustomer(fixture.companyA.id, "Outro");
    const daOutra = await createOrder({
      companyId: fixture.companyA.id,
      customerId: outroCliente.id,
      technicianId: s.technicianB.id,
    });

    const response = await getOrder(
      fieldRequest(`/api/field/v1/service-orders/${daOutra.id}`, {
        token: s.token,
      }),
      { params: { id: daOutra.id } },
    );
    expect(response.status).toBe(404);
    expect((await body(response)).error?.code).toBe("NOT_FOUND");
  });

  it("OS de outra EMPRESA é 404", async () => {
    const s = await scenario();
    const techDaB = await prisma.technician.create({
      data: { companyId: fixture.companyB.id, userId: fixture.adminB.id },
    });
    const clienteB = await createCustomer(fixture.companyB.id, "Cliente B");
    const ordemB = await createOrder({
      companyId: fixture.companyB.id,
      customerId: clienteB.id,
      technicianId: techDaB.id,
    });

    const response = await getOrder(
      fieldRequest(`/api/field/v1/service-orders/${ordemB.id}`, {
        token: s.token,
      }),
      { params: { id: ordemB.id } },
    );
    expect(response.status).toBe(404);
  });

  it("OS importada do ReceitaNet chega idêntica a uma interna", async () => {
    const s = await scenario();
    const cliente = await createCustomer(fixture.companyA.id, "Cliente RN");
    const externa = await createOrder({
      companyId: fixture.companyA.id,
      customerId: cliente.id,
      technicianId: s.technicianA.id,
      origin: "EXTERNAL",
    });

    const response = await getOrder(
      fieldRequest(`/api/field/v1/service-orders/${externa.id}`, {
        token: s.token,
      }),
      { params: { id: externa.id } },
    );
    expect(response.status).toBe(200);

    const serial = JSON.stringify(await body(response));
    /*
      Nada de provider chega ao aplicativo.

      Não é só minimização: como o dado não desce, não existe `if (RECEITANET)`
      possível do lado do Flutter. A ausência é a garantia de que uma OS
      importada se comporta como qualquer outra depois de atribuída.
    */
    expect(serial).not.toContain("RECEITANET");
    expect(serial).not.toContain("4629208");
    expect(serial).not.toContain("1434");
    expect(serial).not.toContain("externalProvider");
    expect(serial).not.toContain("externalId");
  });

  it("a conexão vem como metadado, nunca com a senha", async () => {
    const s = await scenario();
    await prisma.customerConnection.create({
      data: {
        companyId: fixture.companyA.id,
        customerId: s.customer.id,
        type: "PPPOE",
        username: "11-teixeira-ftth",
        credentialCiphertext: "ciphertext-que-nao-pode-vazar",
        credentialIv: "iv",
        credentialAuthTag: "tag",
        active: true,
      },
    });

    const response = await getOrder(
      fieldRequest(`/api/field/v1/service-orders/${s.order.id}`, {
        token: s.token,
      }),
      { params: { id: s.order.id } },
    );

    /*
      UMA leitura do corpo, e todas as asserções sobre ela.

      O corpo de um `Response` só pode ser consumido uma vez. Ler duas vezes e
      engolir o erro da segunda produziria um `{}` — e um `expect(...).not
      .toContain(segredo)` sobre string vazia passa sempre, documentando uma
      proteção que ninguém verificou.
    */
    const payload = await body(response);
    const serial = JSON.stringify(payload);

    const data = payload.data as {
      serviceOrder: {
        connection: { username: string; passwordConfigured: boolean };
      };
    };
    expect(data.serviceOrder.connection.username).toBe("11-teixeira-ftth");
    expect(data.serviceOrder.connection.passwordConfigured).toBe(true);

    // Controle positivo: a serialização REALMENTE tem conteúdo, então os
    // `not.toContain` abaixo estão olhando para alguma coisa.
    expect(serial).toContain("11-teixeira-ftth");
    expect(serial).not.toContain("ciphertext-que-nao-pode-vazar");
    expect(serial).not.toContain("credentialCiphertext");
    expect(serial).not.toContain("credentialIv");
  });
});

// ---------------------------------------------------------------------------
// Comandos: posse
// ---------------------------------------------------------------------------

describe("comandos respeitam posse", () => {
  it("técnico não inicia OS de colega", async () => {
    const s = await scenario();
    const outroCliente = await createCustomer(fixture.companyA.id, "Outro");
    const daOutra = await createOrder({
      companyId: fixture.companyA.id,
      customerId: outroCliente.id,
      technicianId: s.technicianB.id,
    });

    const response = await startOrder(
      fieldRequest(`/api/field/v1/service-orders/${daOutra.id}/start`, {
        method: "POST",
        token: s.token,
        idempotencyKey: "start-alheia-0001",
        body: { expectedVersion: daOutra.version },
      }),
      { params: { id: daOutra.id } },
    );
    expect(response.status).toBe(404);

    const depois = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: daOutra.id },
    });
    expect(depois.status).toBe("ASSIGNED");
    expect(depois.startedAt).toBeNull();
  });

  it("técnico não revela senha PPPoE de OS de colega", async () => {
    const s = await scenario();
    const outroCliente = await createCustomer(fixture.companyA.id, "Outro");
    const conexao = await prisma.customerConnection.create({
      data: {
        companyId: fixture.companyA.id,
        customerId: outroCliente.id,
        type: "PPPOE",
        username: "alheio",
        active: true,
      },
    });
    const daOutra = await createOrder({
      companyId: fixture.companyA.id,
      customerId: outroCliente.id,
      technicianId: s.technicianB.id,
    });

    const response = await revealPassword(
      fieldRequest(`/api/field/v1/service-orders/${daOutra.id}/pppoe/reveal`, {
        method: "POST",
        token: s.token,
        body: { connectionId: conexao.id },
      }),
      { params: { id: daOutra.id } },
    );
    expect(response.status).toBe(404);
  });

  it("revelar exige token do Field — sem ele é 401 antes de tudo", async () => {
    const s = await scenario();
    const response = await revealPassword(
      fieldRequest(`/api/field/v1/service-orders/${s.order.id}/pppoe/reveal`, {
        method: "POST",
        body: { connectionId: "qualquer" },
      }),
      { params: { id: s.order.id } },
    );
    expect(response.status).toBe(401);
  });
});
