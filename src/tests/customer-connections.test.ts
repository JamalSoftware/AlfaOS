import { describe, it, expect, beforeEach, vi } from "vitest";
import { POST as createConnection } from "@/app/api/customers/[id]/connections/route";
import { PATCH as patchConnection } from "@/app/api/customers/[id]/connections/[connectionId]/route";
import { GET as listConnectionsRoute } from "@/app/api/customers/[id]/connections/route";
import { POST as revealPassword } from "@/app/api/service-orders/[id]/connection-password/route";
import { prisma } from "@/lib/prisma";
import {
  buildConnectionCredentialAad,
  ConnectionCredentialUnavailableError,
  CONNECTION_CREDENTIAL_KEY_ENV,
  decryptConnectionCredential,
  encryptConnectionCredential,
  type ConnectionCredentialContext,
} from "@/lib/connection-credential-cipher";
import {
  createCustomerConnection,
  listCustomerConnections,
  revealConnectionPasswordForOrder,
} from "@/lib/customer-connections";
import { DomainError } from "@/lib/errors";
import {
  apiRequest,
  createTokenFor,
  seedTestData,
  type TestFixture,
} from "./helpers";

let fixture: TestFixture;

beforeEach(async () => {
  fixture = await seedTestData();
});

// Sufixo distintivo de proposito: com um final generico como "2026", a
// asserção de "nao vaza last4" casaria com o ano de qualquer timestamp e
// passaria a falhar (ou a esconder um vazamento real) por acidente.
const SECRET = "S3nh@-PPPoE-do-cliente-Zq7W";

const CTX: ConnectionCredentialContext = {
  companyId: "company-a",
  customerId: "customer-1",
  connectionId: "connection-1",
  type: "PPPOE",
};

async function createCustomer(companyId: string, name = "Cliente Teste") {
  return prisma.customer.create({ data: { companyId, name } });
}

async function scenario(options: { status?: string } = {}) {
  const customer = await createCustomer(fixture.companyA.id);
  const technician = await prisma.technician.create({
    data: { companyId: fixture.companyA.id, userId: fixture.techA.id },
  });
  // Segundo tecnico da mesma empresa: e o controle negativo de ownership.
  await prisma.technician.create({
    data: { companyId: fixture.companyA.id, userId: fixture.techB.id },
  });
  const connection = await createCustomerConnection(
    fixture.companyA.id,
    fixture.adminA.id,
    { customerId: customer.id, username: "cliente@provedor", password: SECRET },
  );
  const order = await prisma.serviceOrder.create({
    data: {
      companyId: fixture.companyA.id,
      customerId: customer.id,
      technicianId: technician.id,
      type: "Manutenção",
      description: "Sem conexão.",
      status: (options.status ?? "ASSIGNED") as "ASSIGNED",
      ...(options.status === "COMPLETED" ? { completedAt: new Date() } : {}),
    },
  });
  return { customer, technician, connection, order };
}

async function expectDomainError(
  promise: Promise<unknown>,
  status: number,
): Promise<DomainError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).status).toBe(status);
    return error as DomainError;
  }
  throw new Error(`Esperava DomainError ${status}, mas nada foi lançado.`);
}

// ---------------------------------------------------------------------------
// Cipher
// ---------------------------------------------------------------------------

describe("Cifra de credencial de conexão", () => {
  it("faz round-trip sob o mesmo contexto", () => {
    const encrypted = encryptConnectionCredential(SECRET, CTX);
    expect(decryptConnectionCredential(encrypted, CTX)).toBe(SECRET);
  });

  it("nunca guarda o plaintext no material cifrado", () => {
    const encrypted = encryptConnectionCredential(SECRET, CTX);
    const dump = JSON.stringify(encrypted);
    expect(dump).not.toContain(SECRET);
    expect(Buffer.from(encrypted.ciphertext, "base64").toString("utf8")).not.toBe(
      SECRET,
    );
  });

  it("o mesmo plaintext gera ciphertexts diferentes (IV novo a cada vez)", () => {
    const a = encryptConnectionCredential(SECRET, CTX);
    const b = encryptConnectionCredential(SECRET, CTX);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    // Controle positivo: apesar de diferentes, os dois decriptam.
    expect(decryptConnectionCredential(a, CTX)).toBe(SECRET);
    expect(decryptConnectionCredential(b, CTX)).toBe(SECRET);
  });

  it.each([
    ["companyId", { ...CTX, companyId: "company-b" }],
    ["customerId", { ...CTX, customerId: "customer-2" }],
    ["connectionId", { ...CTX, connectionId: "connection-2" }],
    ["type", { ...CTX, type: "IPOE" }],
  ])("trocar %s no contexto faz o decrypt falhar", (_campo, wrong) => {
    const encrypted = encryptConnectionCredential(SECRET, CTX);
    expect(() =>
      decryptConnectionCredential(encrypted, wrong as ConnectionCredentialContext),
    ).toThrow(ConnectionCredentialUnavailableError);
    // Controle positivo: o contexto correto continua funcionando.
    expect(decryptConnectionCredential(encrypted, CTX)).toBe(SECRET);
  });

  it.each(["ciphertext", "iv", "authTag"] as const)(
    "adulterar %s faz o decrypt falhar",
    (field) => {
      const encrypted = encryptConnectionCredential(SECRET, CTX);
      const bytes = Buffer.from(encrypted[field], "base64");
      bytes[0] = bytes[0] ^ 0xff;
      expect(() =>
        decryptConnectionCredential(
          { ...encrypted, [field]: bytes.toString("base64") },
          CTX,
        ),
      ).toThrow(ConnectionCredentialUnavailableError);
    },
  );

  it("o AAD é determinístico e não ambíguo entre campos", () => {
    const a = buildConnectionCredentialAad(CTX).toString("utf8");
    expect(buildConnectionCredentialAad({ ...CTX }).toString("utf8")).toBe(a);

    // Sem prefixo de comprimento, ("ab","c") e ("a","bc") colidiriam.
    const left = buildConnectionCredentialAad({
      ...CTX,
      customerId: "ab",
      connectionId: "c",
    });
    const right = buildConnectionCredentialAad({
      ...CTX,
      customerId: "a",
      connectionId: "bc",
    });
    expect(left.equals(right)).toBe(false);
  });

  it("o namespace é disjunto do das credenciais de ERP", () => {
    expect(buildConnectionCredentialAad(CTX).toString("utf8")).toContain(
      "alfaos:customer-connection-credential:v1:",
    );
  });

  it("sem chave configurada, falha FECHADO em vez de gravar em claro", () => {
    const saved = process.env[CONNECTION_CREDENTIAL_KEY_ENV];
    delete process.env[CONNECTION_CREDENTIAL_KEY_ENV];
    try {
      expect(() => encryptConnectionCredential(SECRET, CTX)).toThrow(
        ConnectionCredentialUnavailableError,
      );
    } finally {
      process.env[CONNECTION_CREDENTIAL_KEY_ENV] = saved;
    }
  });
});

// ---------------------------------------------------------------------------
// Persistência
// ---------------------------------------------------------------------------

describe("Armazenamento da senha", () => {
  it("nada em nenhuma coluna contém a senha em texto puro", async () => {
    const customer = await createCustomer(fixture.companyA.id);
    await createCustomerConnection(fixture.companyA.id, fixture.adminA.id, {
      customerId: customer.id,
      username: "cliente@provedor",
      password: SECRET,
    });

    // Varre a linha INTEIRA, não só as colunas que eu esperaria.
    const rows = await prisma.customerConnection.findMany();
    expect(JSON.stringify(rows)).not.toContain(SECRET);

    const row = rows[0];
    expect(row.credentialCiphertext).not.toBeNull();
    expect(row.credentialIv).not.toBeNull();
    expect(row.credentialAuthTag).not.toBeNull();
  });

  it("o shape público não carrega senha nem fragmento dela", async () => {
    const customer = await createCustomer(fixture.companyA.id);
    await createCustomerConnection(fixture.companyA.id, fixture.adminA.id, {
      customerId: customer.id,
      username: "cliente@provedor",
      password: SECRET,
    });

    const list = await listCustomerConnections(fixture.companyA.id, customer.id);
    expect(list).toHaveLength(1);
    expect(list[0].passwordConfigured).toBe(true);
    // Conjunto EXATO de campos: mais forte que procurar strings proibidas,
    // porque falha tambem se um campo novo entrar sem ninguem notar.
    expect(Object.keys(list[0]).sort()).toEqual([
      "active",
      "createdAt",
      "id",
      "passwordConfigured",
      "type",
      "updatedAt",
      "username",
    ]);

    const dump = JSON.stringify(list);
    expect(dump).not.toContain(SECRET);
    // Nem um last4: um quarto de senha ainda e senha.
    expect(dump).not.toContain(SECRET.slice(-4));
    expect(dump).not.toContain("ciphertext");
  });

  it("usuário sem senha é estado legítimo", async () => {
    const customer = await createCustomer(fixture.companyA.id);
    const created = await createCustomerConnection(
      fixture.companyA.id,
      fixture.adminA.id,
      { customerId: customer.id, username: "sem-senha@provedor" },
    );
    expect(created.passwordConfigured).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Administração
// ---------------------------------------------------------------------------

describe("Administração da conexão", () => {
  it("ADMIN cadastra e substitui; a resposta nunca devolve a senha", async () => {
    const token = await createTokenFor(fixture.adminA.id);
    const customer = await createCustomer(fixture.companyA.id);

    const created = await createConnection(
      apiRequest(
        `/api/customers/${customer.id}/connections`,
        {
          method: "POST",
          body: { username: "cliente@provedor", password: SECRET },
        },
        token,
      ),
      { params: { id: customer.id } },
    );
    expect(created.status).toBe(201);
    const createdBody = await created.text();
    expect(createdBody).not.toContain(SECRET);
    const connectionId = JSON.parse(createdBody).data.connection.id;

    const replaced = await patchConnection(
      apiRequest(
        `/api/customers/${customer.id}/connections/${connectionId}`,
        { method: "PATCH", body: { password: "outra-senha-diferente" } },
        token,
      ),
      { params: { id: customer.id, connectionId } },
    );
    expect(replaced.status).toBe(200);
    expect(await replaced.text()).not.toContain("outra-senha-diferente");

    // A substituição valeu: o valor novo é o que sai no reveal.
    const row = await prisma.customerConnection.findUniqueOrThrow({
      where: { id: connectionId },
    });
    expect(
      decryptConnectionCredential(
        {
          ciphertext: row.credentialCiphertext!,
          iv: row.credentialIv!,
          authTag: row.credentialAuthTag!,
        },
        {
          companyId: row.companyId,
          customerId: row.customerId,
          connectionId: row.id,
          type: row.type,
        },
      ),
    ).toBe("outra-senha-diferente");
  });

  it("nenhuma rota de leitura devolve a senha para preencher formulário", async () => {
    const token = await createTokenFor(fixture.adminA.id);
    const customer = await createCustomer(fixture.companyA.id);
    await createCustomerConnection(fixture.companyA.id, fixture.adminA.id, {
      customerId: customer.id,
      username: "cliente@provedor",
      password: SECRET,
    });

    const res = await listConnectionsRoute(
      apiRequest(`/api/customers/${customer.id}/connections`, {}, token),
      { params: { id: customer.id } },
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain(SECRET);
    expect(body).toContain('"passwordConfigured":true');
  });

  it("DISPATCHER e TECHNICIAN não cadastram conexão", async () => {
    const customer = await createCustomer(fixture.companyA.id);
    for (const userId of [fixture.dispatcherA.id, fixture.techA.id]) {
      const token = await createTokenFor(userId);
      const res = await createConnection(
        apiRequest(
          `/api/customers/${customer.id}/connections`,
          { method: "POST", body: { username: "x@y", password: SECRET } },
          token,
        ),
        { params: { id: customer.id } },
      );
      expect(res.status).toBe(403);
    }
    expect(await prisma.customerConnection.count()).toBe(0);
  });

  it("mass assignment de companyId/customerId/type é rejeitado", async () => {
    const token = await createTokenFor(fixture.adminA.id);
    const customer = await createCustomer(fixture.companyA.id);

    for (const extra of [
      { companyId: fixture.companyB.id },
      { customerId: "outro-cliente" },
      { type: "IPOE" },
      { active: true },
    ]) {
      const res = await createConnection(
        apiRequest(
          `/api/customers/${customer.id}/connections`,
          {
            method: "POST",
            body: { username: "cliente@provedor", password: SECRET, ...extra },
          },
          token,
        ),
        { params: { id: customer.id } },
      );
      expect(res.status).toBe(400);
    }
    expect(await prisma.customerConnection.count()).toBe(0);
  });

  it("cadastro com Origin de terceiros é rejeitado (403)", async () => {
    const token = await createTokenFor(fixture.adminA.id);
    const customer = await createCustomer(fixture.companyA.id);

    const res = await createConnection(
      apiRequest(
        `/api/customers/${customer.id}/connections`,
        {
          method: "POST",
          body: { username: "cliente@provedor", password: SECRET },
          headers: { Origin: "https://evil.example.com" },
        },
        token,
      ),
      { params: { id: customer.id } },
    );
    expect(res.status).toBe(403);
    expect(await prisma.customerConnection.count()).toBe(0);
  });

  it("ADMIN de outra empresa não alcança a conexão (404)", async () => {
    const customer = await createCustomer(fixture.companyA.id);
    const connection = await createCustomerConnection(
      fixture.companyA.id,
      fixture.adminA.id,
      { customerId: customer.id, username: "cliente@provedor", password: SECRET },
    );
    const tokenB = await createTokenFor(fixture.adminB.id);

    const res = await patchConnection(
      apiRequest(
        `/api/customers/${customer.id}/connections/${connection.id}`,
        { method: "PATCH", body: { username: "sequestrado" } },
        tokenB,
      ),
      { params: { id: customer.id, connectionId: connection.id } },
    );
    expect(res.status).toBe(404);

    const untouched = await prisma.customerConnection.findUniqueOrThrow({
      where: { id: connection.id },
    });
    expect(untouched.username).toBe("cliente@provedor");
  });

  it("conexão de outro cliente da mesma empresa não é editável pela rota (404)", async () => {
    const token = await createTokenFor(fixture.adminA.id);
    const a = await createCustomer(fixture.companyA.id, "Cliente A");
    const b = await createCustomer(fixture.companyA.id, "Cliente B");
    const connectionB = await createCustomerConnection(
      fixture.companyA.id,
      fixture.adminA.id,
      { customerId: b.id, username: "b@provedor", password: SECRET },
    );

    // Id do cliente A na URL, id de conexão do cliente B no path.
    const res = await patchConnection(
      apiRequest(
        `/api/customers/${a.id}/connections/${connectionB.id}`,
        { method: "PATCH", body: { username: "trocado" } },
        token,
      ),
      { params: { id: a.id, connectionId: connectionB.id } },
    );
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Revelação
// ---------------------------------------------------------------------------

describe("Revelação da senha", () => {
  it.each(["ASSIGNED", "IN_PROGRESS"])(
    "técnico dono revela em OS %s",
    async (status) => {
      const { order, connection } = await scenario({ status });
      const token = await createTokenFor(fixture.techA.id);

      const res = await revealPassword(
        apiRequest(
          `/api/service-orders/${order.id}/connection-password`,
          { method: "POST", body: { connectionId: connection.id } },
          token,
        ),
        { params: { id: order.id } },
      );
      expect(res.status).toBe(200);
      const payload = await res.json();
      expect(payload.data.password).toBe(SECRET);
      // Corpo mínimo: só a senha.
      expect(Object.keys(payload.data)).toEqual(["password"]);
      expect(res.headers.get("Cache-Control")).toContain("no-store");
    },
  );

  it("após COMPLETED o técnico não revela mais (403), mas ADMIN sim", async () => {
    const { order, connection } = await scenario({ status: "COMPLETED" });

    const techToken = await createTokenFor(fixture.techA.id);
    const denied = await revealPassword(
      apiRequest(
        `/api/service-orders/${order.id}/connection-password`,
        { method: "POST", body: { connectionId: connection.id } },
        techToken,
      ),
      { params: { id: order.id } },
    );
    expect(denied.status).toBe(403);
    expect(await denied.text()).not.toContain(SECRET);

    // Controle positivo: a capacidade administrativa permanece.
    const adminToken = await createTokenFor(fixture.adminA.id);
    const allowed = await revealPassword(
      apiRequest(
        `/api/service-orders/${order.id}/connection-password`,
        { method: "POST", body: { connectionId: connection.id } },
        adminToken,
      ),
      { params: { id: order.id } },
    );
    expect(allowed.status).toBe(200);
    expect((await allowed.json()).data.password).toBe(SECRET);
  });

  it("técnico que não é o dono da OS recebe 404", async () => {
    const { order, connection } = await scenario();
    const tokenOutro = await createTokenFor(fixture.techB.id);

    const res = await revealPassword(
      apiRequest(
        `/api/service-orders/${order.id}/connection-password`,
        { method: "POST", body: { connectionId: connection.id } },
        tokenOutro,
      ),
      { params: { id: order.id } },
    );
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain(SECRET);
  });

  it("cross-tenant recebe 404", async () => {
    const { order, connection } = await scenario();
    const tokenB = await createTokenFor(fixture.adminB.id);

    const res = await revealPassword(
      apiRequest(
        `/api/service-orders/${order.id}/connection-password`,
        { method: "POST", body: { connectionId: connection.id } },
        tokenB,
      ),
      { params: { id: order.id } },
    );
    expect(res.status).toBe(404);
  });

  it("conexão de OUTRO cliente, via OS legítima, recebe 404", async () => {
    const { order } = await scenario();
    const outro = await createCustomer(fixture.companyA.id, "Outro Cliente");
    const conexaoAlheia = await createCustomerConnection(
      fixture.companyA.id,
      fixture.adminA.id,
      { customerId: outro.id, username: "outro@provedor", password: "senha-alheia" },
    );

    const token = await createTokenFor(fixture.techA.id);
    const res = await revealPassword(
      apiRequest(
        `/api/service-orders/${order.id}/connection-password`,
        { method: "POST", body: { connectionId: conexaoAlheia.id } },
        token,
      ),
      { params: { id: order.id } },
    );
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("senha-alheia");
  });

  it("DISPATCHER não recebe plaintext", async () => {
    const { order, connection } = await scenario();
    const token = await createTokenFor(fixture.dispatcherA.id);

    const res = await revealPassword(
      apiRequest(
        `/api/service-orders/${order.id}/connection-password`,
        { method: "POST", body: { connectionId: connection.id } },
        token,
      ),
      { params: { id: order.id } },
    );
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain(SECRET);
  });

  it("sem sessão recebe 401", async () => {
    const { order, connection } = await scenario();
    const res = await revealPassword(
      apiRequest(`/api/service-orders/${order.id}/connection-password`, {
        method: "POST",
        body: { connectionId: connection.id },
      }),
      { params: { id: order.id } },
    );
    expect(res.status).toBe(401);
  });

  it("o schema recusa companyId, customerId e technicianId no corpo", async () => {
    const { order, connection } = await scenario();
    const token = await createTokenFor(fixture.techA.id);

    for (const extra of [
      { companyId: fixture.companyB.id },
      { customerId: "qualquer" },
      { technicianId: "qualquer" },
    ]) {
      const res = await revealPassword(
        apiRequest(
          `/api/service-orders/${order.id}/connection-password`,
          { method: "POST", body: { connectionId: connection.id, ...extra } },
          token,
        ),
        { params: { id: order.id } },
      );
      expect(res.status).toBe(400);
    }
  });

  it("Origin de terceiros é rejeitado antes de qualquer leitura (403)", async () => {
    const { order, connection } = await scenario();
    const token = await createTokenFor(fixture.techA.id);

    const res = await revealPassword(
      apiRequest(
        `/api/service-orders/${order.id}/connection-password`,
        {
          method: "POST",
          body: { connectionId: connection.id },
          headers: { Origin: "https://evil.example.com" },
        },
        token,
      ),
      { params: { id: order.id } },
    );
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain(SECRET);

    // Uma revelação bloqueada por CSRF também não pode virar evento de acesso.
    expect(
      await prisma.auditLog.count({
        where: { action: "PPPOE_CREDENTIAL_VIEWED" },
      }),
    ).toBe(0);
  });

  it("conexão desativada não revela", async () => {
    const { order, connection } = await scenario();
    await prisma.customerConnection.update({
      where: { id: connection.id },
      data: { active: false },
    });

    await expectDomainError(
      revealConnectionPasswordForOrder(
        fixture.companyA.id,
        { userId: fixture.techA.id, profile: "TECHNICIAN" },
        order.id,
        connection.id,
      ),
      404,
    );
  });
});

// ---------------------------------------------------------------------------
// Auditoria e vazamento
// ---------------------------------------------------------------------------

describe("Auditoria e vazamento", () => {
  it("registra a revelação sem nenhum segredo", async () => {
    const { order, connection, customer } = await scenario();

    await revealConnectionPasswordForOrder(
      fixture.companyA.id,
      { userId: fixture.techA.id, profile: "TECHNICIAN" },
      order.id,
      connection.id,
    );

    const logs = await prisma.auditLog.findMany({
      where: { companyId: fixture.companyA.id },
    });
    const viewed = logs.find((l) => l.action === "PPPOE_CREDENTIAL_VIEWED");
    expect(viewed).toBeDefined();
    expect(viewed?.entityId).toBe(connection.id);
    expect(viewed?.details).toContain(customer.id);
    expect(viewed?.details).toContain(order.id);

    const row = await prisma.customerConnection.findUniqueOrThrow({
      where: { id: connection.id },
    });
    const dump = JSON.stringify(logs);
    expect(dump).not.toContain(SECRET);
    expect(dump).not.toContain(row.credentialCiphertext!);
    expect(dump).not.toContain(row.credentialIv!);
    expect(dump).not.toContain(row.credentialAuthTag!);
    // Username fora da auditoria: o connectionId já identifica a conexão.
    expect(dump).not.toContain("cliente@provedor");
  });

  it("uma revelação negada não gera evento de visualização", async () => {
    const { order, connection } = await scenario({ status: "COMPLETED" });
    const token = await createTokenFor(fixture.techA.id);

    await revealPassword(
      apiRequest(
        `/api/service-orders/${order.id}/connection-password`,
        { method: "POST", body: { connectionId: connection.id } },
        token,
      ),
      { params: { id: order.id } },
    );

    expect(
      await prisma.auditLog.count({
        where: { action: "PPPOE_CREDENTIAL_VIEWED" },
      }),
    ).toBe(0);
  });

  it("a senha não aparece em console/error de nenhum caminho de falha", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { order, connection } = await scenario();
      const token = await createTokenFor(fixture.techB.id);

      // Caminho negado.
      await revealPassword(
        apiRequest(
          `/api/service-orders/${order.id}/connection-password`,
          { method: "POST", body: { connectionId: connection.id } },
          token,
        ),
        { params: { id: order.id } },
      );

      // Caminho de credencial corrompida: força o erro de decrypt.
      await prisma.customerConnection.update({
        where: { id: connection.id },
        data: { credentialAuthTag: Buffer.alloc(16, 7).toString("base64") },
      });
      const ownerToken = await createTokenFor(fixture.techA.id);
      const broken = await revealPassword(
        apiRequest(
          `/api/service-orders/${order.id}/connection-password`,
          { method: "POST", body: { connectionId: connection.id } },
          ownerToken,
        ),
        { params: { id: order.id } },
      );
      expect(broken.status).toBe(500);
      expect(await broken.text()).not.toContain(SECRET);

      const written = [...errorSpy.mock.calls, ...logSpy.mock.calls]
        .flat()
        .map(String)
        .join(" ");
      expect(written).not.toContain(SECRET);
    } finally {
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Ataque adversarial: transplante de ciphertext
// ---------------------------------------------------------------------------

describe("Transplante de ciphertext", () => {
  async function connectionRow(companyId: string, customerId: string, user: string) {
    const created = await createCustomerConnection(
      companyId,
      companyId === fixture.companyA.id ? fixture.adminA.id : fixture.adminB.id,
      { customerId, username: user, password: SECRET },
    );
    return prisma.customerConnection.findUniqueOrThrow({
      where: { id: created.id },
    });
  }

  it("mover a credencial entre CLIENTES da mesma empresa falha", async () => {
    const a = await createCustomer(fixture.companyA.id, "Cliente A");
    const b = await createCustomer(fixture.companyA.id, "Cliente B");
    const source = await connectionRow(fixture.companyA.id, a.id, "a@p");
    const target = await connectionRow(fixture.companyA.id, b.id, "b@p");

    await prisma.customerConnection.update({
      where: { id: target.id },
      data: {
        credentialCiphertext: source.credentialCiphertext,
        credentialIv: source.credentialIv,
        credentialAuthTag: source.credentialAuthTag,
      },
    });

    const moved = await prisma.customerConnection.findUniqueOrThrow({
      where: { id: target.id },
    });
    expect(() =>
      decryptConnectionCredential(
        {
          ciphertext: moved.credentialCiphertext!,
          iv: moved.credentialIv!,
          authTag: moved.credentialAuthTag!,
        },
        {
          companyId: moved.companyId,
          customerId: moved.customerId,
          connectionId: moved.id,
          type: moved.type,
        },
      ),
    ).toThrow(ConnectionCredentialUnavailableError);

    // Controle positivo: a credencial de origem continua íntegra.
    expect(
      decryptConnectionCredential(
        {
          ciphertext: source.credentialCiphertext!,
          iv: source.credentialIv!,
          authTag: source.credentialAuthTag!,
        },
        {
          companyId: source.companyId,
          customerId: source.customerId,
          connectionId: source.id,
          type: source.type,
        },
      ),
    ).toBe(SECRET);
  });

  it("mover a credencial entre CONEXÕES do mesmo cliente falha", async () => {
    const customer = await createCustomer(fixture.companyA.id);
    const first = await connectionRow(fixture.companyA.id, customer.id, "um@p");
    const second = await connectionRow(fixture.companyA.id, customer.id, "dois@p");

    expect(() =>
      decryptConnectionCredential(
        {
          ciphertext: first.credentialCiphertext!,
          iv: first.credentialIv!,
          authTag: first.credentialAuthTag!,
        },
        // Mesma empresa, mesmo cliente, mesmo tipo — só o connectionId muda.
        {
          companyId: second.companyId,
          customerId: second.customerId,
          connectionId: second.id,
          type: second.type,
        },
      ),
    ).toThrow(ConnectionCredentialUnavailableError);
  });

  it("mover a credencial entre EMPRESAS falha, e o reveal não vaza", async () => {
    const a = await createCustomer(fixture.companyA.id, "Cliente A");
    const b = await createCustomer(fixture.companyB.id, "Cliente B");
    const source = await connectionRow(fixture.companyA.id, a.id, "a@p");
    const target = await connectionRow(fixture.companyB.id, b.id, "b@p");

    await prisma.customerConnection.update({
      where: { id: target.id },
      data: {
        credentialCiphertext: source.credentialCiphertext,
        credentialIv: source.credentialIv,
        credentialAuthTag: source.credentialAuthTag,
      },
    });

    // Ataque completo, pela porta da frente: OS da empresa B, ADMIN da B.
    const technicianB = await prisma.technician.create({
      data: { companyId: fixture.companyB.id, userId: fixture.adminB.id },
    });
    const orderB = await prisma.serviceOrder.create({
      data: {
        companyId: fixture.companyB.id,
        customerId: b.id,
        technicianId: technicianB.id,
        type: "Manutenção",
        description: "OS da empresa B.",
        status: "ASSIGNED",
      },
    });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const tokenB = await createTokenFor(fixture.adminB.id);
      const res = await revealPassword(
        apiRequest(
          `/api/service-orders/${orderB.id}/connection-password`,
          { method: "POST", body: { connectionId: target.id } },
          tokenB,
        ),
        { params: { id: orderB.id } },
      );
      expect(res.status).toBe(500);
      expect(await res.text()).not.toContain(SECRET);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Constraint de origem da OS (verificacao explicita, sem alterar comportamento)
// ---------------------------------------------------------------------------

describe("Constraint de identidade externa da OS", () => {
  async function createOrder(data: Record<string, unknown>) {
    const customer = await createCustomer(fixture.companyA.id);
    return prisma.serviceOrder.create({
      data: {
        companyId: fixture.companyA.id,
        customerId: customer.id,
        type: "Manutenção",
        description: "Teste de constraint.",
        ...data,
      } as never,
    });
  }

  it("EXTERNAL exige provider E externalId", async () => {
    await expect(
      createOrder({ origin: "EXTERNAL", externalProvider: "MOCK" }),
    ).rejects.toThrow();
    await expect(
      createOrder({ origin: "EXTERNAL", externalId: "X-1" }),
    ).rejects.toThrow();
    await expect(createOrder({ origin: "EXTERNAL" })).rejects.toThrow();

    // Controle positivo: com os dois, passa.
    const ok = await createOrder({
      origin: "EXTERNAL",
      externalProvider: "MOCK",
      externalId: "X-OK",
    });
    expect(ok.origin).toBe("EXTERNAL");
  });

  it("INTERNAL aceita os dois nulos", async () => {
    const order = await createOrder({ origin: "INTERNAL" });
    expect(order.externalProvider).toBeNull();
    expect(order.externalId).toBeNull();
  });

  it("INTERNAL aceita ganhar os dois campos depois, sem deixar de ser INTERNAL", async () => {
    const order = await createOrder({ origin: "INTERNAL" });
    const linked = await prisma.serviceOrder.update({
      where: { id: order.id },
      data: { externalProvider: "MOCK", externalId: "VINCULO-1" },
    });
    expect(linked.origin).toBe("INTERNAL");
    expect(linked.externalId).toBe("VINCULO-1");
  });

  it("NUNCA aceita só um dos dois preenchido, em nenhuma origem", async () => {
    await expect(
      createOrder({ origin: "INTERNAL", externalProvider: "MOCK" }),
    ).rejects.toThrow();
    await expect(
      createOrder({ origin: "INTERNAL", externalId: "SO-ID" }),
    ).rejects.toThrow();

    // E também não aceita chegar nesse estado por UPDATE.
    const order = await createOrder({
      origin: "INTERNAL",
      externalProvider: "MOCK",
      externalId: "PAR-1",
    });
    await expect(
      prisma.serviceOrder.update({
        where: { id: order.id },
        data: { externalId: null },
      }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Regressões do endurecimento final (auditoria da v0.5.1)
// ---------------------------------------------------------------------------

describe("H-1 — elegibilidade do técnico no reveal", () => {
  /**
   * Reprodução exata do achado: o ADMIN desativa o técnico, a sessão do User
   * continua válida, a OS continua atribuída — e a senha NÃO pode mais sair.
   *
   * Antes da correção este caminho devolvia 200 com o texto claro, enquanto a
   * escrita de execução já era negada com 403. O bloqueio parcial fazia o ADMIN
   * concluir que o acesso tinha sido revogado quando não tinha.
   */
  it("ADMIN desativa o Technician: sessão segue válida e o reveal falha", async () => {
    const { order, connection, technician } = await scenario();
    const token = await createTokenFor(fixture.techA.id);

    const call = () =>
      revealPassword(
        apiRequest(
          `/api/service-orders/${order.id}/connection-password`,
          { method: "POST", body: { connectionId: connection.id } },
          token,
        ),
        { params: { id: order.id } },
      );

    // Controle positivo: enquanto ativo, revela.
    const antes = await call();
    expect(antes.status).toBe(200);
    expect((await antes.json()).data.password).toBe(SECRET);

    // ADMIN desativa SOMENTE o técnico. O User permanece ativo.
    await prisma.technician.update({
      where: { id: technician.id },
      data: { active: false },
    });
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: fixture.techA.id },
      select: { active: true },
    });
    expect(user.active).toBe(true);

    const depois = await call();
    expect(depois.status).toBe(403);
    expect(await depois.text()).not.toContain(SECRET);

    // A OS não foi reatribuída nem teve o histórico alterado.
    const row = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(row.technicianId).toBe(technician.id);
    expect(row.status).toBe("ASSIGNED");
  });

  it("reativar o Technician devolve a capacidade de revelar", async () => {
    const { order, connection, technician } = await scenario();
    const token = await createTokenFor(fixture.techA.id);
    const call = () =>
      revealPassword(
        apiRequest(
          `/api/service-orders/${order.id}/connection-password`,
          { method: "POST", body: { connectionId: connection.id } },
          token,
        ),
        { params: { id: order.id } },
      );

    await prisma.technician.update({
      where: { id: technician.id },
      data: { active: false },
    });
    expect((await call()).status).toBe(403);

    await prisma.technician.update({
      where: { id: technician.id },
      data: { active: true },
    });
    const res = await call();
    expect(res.status).toBe(200);
    expect((await res.json()).data.password).toBe(SECRET);
  });

  it("User desativado continua sendo 401, não 403", async () => {
    const { order, connection } = await scenario();
    const token = await createTokenFor(fixture.techA.id);
    await prisma.user.update({
      where: { id: fixture.techA.id },
      data: { active: false },
    });

    const res = await revealPassword(
      apiRequest(
        `/api/service-orders/${order.id}/connection-password`,
        { method: "POST", body: { connectionId: connection.id } },
        token,
      ),
      { params: { id: order.id } },
    );
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain(SECRET);
  });

  it("técnico inelegível NÃO ganha oráculo: OS de outro dono segue 404", async () => {
    const { order, connection, technician } = await scenario();
    // Desativa o dono e passa a atacar com OUTRO técnico, também inelegível.
    await prisma.technician.update({
      where: { id: technician.id },
      data: { active: false },
    });
    const outro = await prisma.technician.findFirstOrThrow({
      where: { userId: fixture.techB.id },
    });
    await prisma.technician.update({
      where: { id: outro.id },
      data: { active: false },
    });

    const token = await createTokenFor(fixture.techB.id);
    const res = await revealPassword(
      apiRequest(
        `/api/service-orders/${order.id}/connection-password`,
        { method: "POST", body: { connectionId: connection.id } },
        token,
      ),
      { params: { id: order.id } },
    );
    // 404 e não 403: a posse é checada ANTES da elegibilidade, então um técnico
    // inelegível não consegue distinguir "OS existe" de "OS não existe".
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain(SECRET);
  });
});

describe("M-1 — auditoria obrigatória no reveal", () => {
  function breakAudit() {
    const original = prisma.auditLog.create;
    // @ts-expect-error — substituição deliberada para o teste
    prisma.auditLog.create = async () => {
      throw new Error("audit storage down");
    };
    return () => {
      prisma.auditLog.create = original;
    };
  }

  it("auditoria OK: senha devolvida e exatamente UM evento", async () => {
    const { order, connection } = await scenario();
    const token = await createTokenFor(fixture.techA.id);

    const res = await revealPassword(
      apiRequest(
        `/api/service-orders/${order.id}/connection-password`,
        { method: "POST", body: { connectionId: connection.id } },
        token,
      ),
      { params: { id: order.id } },
    );
    expect(res.status).toBe(200);
    expect((await res.json()).data.password).toBe(SECRET);
    expect(
      await prisma.auditLog.count({
        where: { action: "PPPOE_CREDENTIAL_VIEWED" },
      }),
    ).toBe(1);
  });

  it("auditoria falha: a senha NÃO é devolvida", async () => {
    const { order, connection } = await scenario();
    const token = await createTokenFor(fixture.techA.id);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const restore = breakAudit();
    try {
      const res = await revealPassword(
        apiRequest(
          `/api/service-orders/${order.id}/connection-password`,
          { method: "POST", body: { connectionId: connection.id } },
          token,
        ),
        { params: { id: order.id } },
      );

      // 503: a operação era legítima, o pré-requisito de infraestrutura falhou.
      expect(res.status).toBe(503);
      const body = await res.text();
      expect(body).not.toContain(SECRET);
      // Sem fallback silencioso: nada de `password` no corpo, nem vazio.
      expect(body).not.toContain("password");
    } finally {
      restore();
      errorSpy.mockRestore();
    }
  });

  it("auditoria falha: nenhum segredo em corpo, log ou mensagem de erro", async () => {
    const { order, connection } = await scenario();
    const token = await createTokenFor(fixture.techA.id);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const restore = breakAudit();
    try {
      const res = await revealPassword(
        apiRequest(
          `/api/service-orders/${order.id}/connection-password`,
          { method: "POST", body: { connectionId: connection.id } },
          token,
        ),
        { params: { id: order.id } },
      );
      const body = await res.text();

      const written = [
        ...errorSpy.mock.calls,
        ...logSpy.mock.calls,
        ...warnSpy.mock.calls,
      ]
        .flat()
        .map((v) => (v instanceof Error ? `${v.message} ${v.stack ?? ""}` : String(v)))
        .join(" ");

      expect(written).not.toContain(SECRET);
      expect(body).not.toContain(SECRET);
      // A falha PRECISA ser observável pelo operador — silêncio seria pior.
      expect(written).toContain("PPPOE_CREDENTIAL_VIEWED");
    } finally {
      restore();
      errorSpy.mockRestore();
      logSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it("também falha fechado pelo domínio, não só pela rota", async () => {
    const { order, connection } = await scenario();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const restore = breakAudit();
    try {
      const err = await expectDomainError(
        revealConnectionPasswordForOrder(
          fixture.companyA.id,
          { userId: fixture.techA.id, profile: "TECHNICIAN" },
          order.id,
          connection.id,
        ),
        503,
      );
      expect(err.message).not.toContain(SECRET);
    } finally {
      restore();
      errorSpy.mockRestore();
    }
  });

  it("concorrência: cada revelação bem-sucedida tem o seu registro", async () => {
    const { order, connection } = await scenario();
    const token = await createTokenFor(fixture.techA.id);

    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        revealPassword(
          apiRequest(
            `/api/service-orders/${order.id}/connection-password`,
            { method: "POST", body: { connectionId: connection.id } },
            token,
          ),
          { params: { id: order.id } },
        ),
      ),
    );

    const ok = responses.filter((r) => r.status === 200).length;
    const bodies = await Promise.all(responses.map((r) => r.json()));
    expect(ok).toBe(10);
    expect(bodies.every((b) => b.data.password === SECRET)).toBe(true);

    // Um evento por revelação — nem a menos (perda de rastro) nem a mais.
    expect(
      await prisma.auditLog.count({
        where: { action: "PPPOE_CREDENTIAL_VIEWED" },
      }),
    ).toBe(ok);
  });
});

