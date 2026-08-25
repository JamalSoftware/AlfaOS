import { describe, it, expect, beforeEach, vi } from "vitest";
import { ReceitanetAdapter } from "@/integrations/ReceitanetAdapter";
import type { FetchLike } from "@/integrations/receitanet/CallCenterClient";
import { prisma } from "@/lib/prisma";
import {
  deriveDocumentLast4,
  derivePolicyPassword,
  provisionPppoeFromErp,
  restoreDefaultPassword,
} from "@/lib/pppoe-provisioning";
import { revealConnectionPasswordForOrder } from "@/lib/customer-connections";
import { PATCH as patchConnection } from "@/app/api/customers/[id]/connections/[connectionId]/route";
import {
  allocateTestServiceOrderNumber,
  apiRequest,
  createTokenFor,
  seedTestData,
  type TestFixture,
} from "./helpers";

/**
 * Provisionamento automático do acesso PPPoE.
 *
 * Nenhum teste toca o ReceitaNet real — o transporte é injetado. E nenhum
 * documento real aparece aqui: os CPFs abaixo são sequências inventadas com o
 * único requisito de terem 11 dígitos, porque é o comprimento que a regra
 * examina.
 */

/** CPF fictício. Só o comprimento e os 4 últimos dígitos importam à regra. */
const CPF_FICTICIO = "10020030044";
const CPF_LAST4 = "0044";
/** CNPJ fictício: 14 dígitos, para provar que a regra de CPF não o alcança. */
const CNPJ_FICTICIO = "10020030004455";

const LOGIN_ERP = "cliente.exemplo";

let fixture: TestFixture;
beforeEach(async () => {
  fixture = await seedTestData();
});

async function customerWith(
  companyId: string,
  overrides: Record<string, unknown> = {},
) {
  return prisma.customer.create({
    data: {
      companyId,
      name: "Cliente de Teste",
      document: CPF_FICTICIO,
      ...overrides,
    },
  });
}

async function policy(companyId: string, value: "MANUAL_ONLY" | "DOCUMENT_LAST4") {
  await prisma.company.update({
    where: { id: companyId },
    data: { pppoePasswordPolicy: value },
  });
}

// ---------------------------------------------------------------------------
// Derivação pura
// ---------------------------------------------------------------------------

describe("Derivação da senha padrão", () => {
  it("CONTROLE POSITIVO: CPF de 11 dígitos gera os 4 últimos", () => {
    expect(deriveDocumentLast4(CPF_FICTICIO)).toBe(CPF_LAST4);
  });

  it("máscara não altera a derivação", () => {
    expect(deriveDocumentLast4("100.200.300-44")).toBe(CPF_LAST4);
  });

  it.each([
    ["CNPJ (14 dígitos)", CNPJ_FICTICIO],
    ["curto demais", "123"],
    ["longo demais", "1002003004455667"],
    ["vazio", ""],
    ["só máscara", "..-/"],
    ["nulo", null],
    ["indefinido", undefined],
  ])("não deriva senha: %s", (_label, doc) => {
    expect(deriveDocumentLast4(doc as string | null | undefined)).toBeNull();
  });

  it("política MANUAL_ONLY nunca deriva, mesmo com CPF válido", () => {
    expect(derivePolicyPassword("MANUAL_ONLY", CPF_FICTICIO)).toBeNull();
    expect(derivePolicyPassword("DOCUMENT_LAST4", CPF_FICTICIO)).toBe(CPF_LAST4);
  });
});

// ---------------------------------------------------------------------------
// Provisionamento a partir do ERP
// ---------------------------------------------------------------------------

describe("Provisionamento PPPoE a partir do ERP", () => {
  it("cria a conexão com o login do ERP quando não existe nenhuma", async () => {
    await policy(fixture.companyA.id, "DOCUMENT_LAST4");
    const customer = await customerWith(fixture.companyA.id);

    const outcome = await provisionPppoeFromErp(fixture.companyA.id, fixture.adminA.id, {
      customerId: customer.id,
      login: LOGIN_ERP,
      document: CPF_FICTICIO,
    });

    expect(outcome).toBe("CREATED");
    const row = await prisma.customerConnection.findFirstOrThrow({
      where: { customerId: customer.id },
    });
    expect(row.username).toBe(LOGIN_ERP);
    expect(row.usernameSource).toBe("RECEITANET_CALLCENTER");
    expect(row.passwordSource).toBe("AUTO_DOCUMENT_LAST4");
    expect(row.credentialCiphertext).not.toBeNull();
  });

  it("CPF inválido: cria o usuário mas NÃO configura senha", async () => {
    await policy(fixture.companyA.id, "DOCUMENT_LAST4");
    const customer = await customerWith(fixture.companyA.id, { document: "123" });

    expect(
      await provisionPppoeFromErp(fixture.companyA.id, fixture.adminA.id, {
        customerId: customer.id,
        login: LOGIN_ERP,
        document: "123",
      }),
    ).toBe("CREATED");

    const row = await prisma.customerConnection.findFirstOrThrow({
      where: { customerId: customer.id },
    });
    expect(row.username).toBe(LOGIN_ERP);
    expect(row.credentialCiphertext).toBeNull();
    // Sem derivação, a procedência da senha é MANUAL — nada automático a marcar.
    expect(row.passwordSource).toBe("MANUAL");
  });

  it("CNPJ não recebe a regra de CPF por analogia", async () => {
    await policy(fixture.companyA.id, "DOCUMENT_LAST4");
    const customer = await customerWith(fixture.companyA.id, { document: CNPJ_FICTICIO });

    await provisionPppoeFromErp(fixture.companyA.id, fixture.adminA.id, {
      customerId: customer.id,
      login: LOGIN_ERP,
      document: CNPJ_FICTICIO,
    });

    const row = await prisma.customerConnection.findFirstOrThrow({
      where: { customerId: customer.id },
    });
    expect(row.credentialCiphertext).toBeNull();
  });

  it("empresa sem política não ganha senha automática", async () => {
    await policy(fixture.companyA.id, "MANUAL_ONLY");
    const customer = await customerWith(fixture.companyA.id);

    await provisionPppoeFromErp(fixture.companyA.id, fixture.adminA.id, {
      customerId: customer.id,
      login: LOGIN_ERP,
      document: CPF_FICTICIO,
    });

    const row = await prisma.customerConnection.findFirstOrThrow({
      where: { customerId: customer.id },
    });
    expect(row.credentialCiphertext).toBeNull();
    expect(row.passwordSource).toBe("MANUAL");
  });

  it("provider sem login não provisiona nada", async () => {
    const customer = await customerWith(fixture.companyA.id);

    expect(
      await provisionPppoeFromErp(fixture.companyA.id, fixture.adminA.id, {
        customerId: customer.id,
        login: null,
        document: CPF_FICTICIO,
      }),
    ).toBe("SKIPPED_NO_LOGIN");
    expect(await prisma.customerConnection.count({ where: { customerId: customer.id } })).toBe(0);
  });

  it("login em branco conta como ausente", async () => {
    const customer = await customerWith(fixture.companyA.id);
    expect(
      await provisionPppoeFromErp(fixture.companyA.id, fixture.adminA.id, {
        customerId: customer.id,
        login: "   ",
        document: CPF_FICTICIO,
      }),
    ).toBe("SKIPPED_NO_LOGIN");
  });
});

// ---------------------------------------------------------------------------
// A regra central: MANUAL é intocável
// ---------------------------------------------------------------------------

describe("MANUAL nunca é sobrescrito pela automação", () => {
  it("REGRESSÃO: senha manual sobrevive a uma nova importação", async () => {
    await policy(fixture.companyA.id, "DOCUMENT_LAST4");
    const customer = await customerWith(fixture.companyA.id);

    // Conexão com senha definida à mão.
    await provisionPppoeFromErp(fixture.companyA.id, fixture.adminA.id, {
      customerId: customer.id,
      login: LOGIN_ERP,
      document: CPF_FICTICIO,
    });
    const created = await prisma.customerConnection.findFirstOrThrow({
      where: { customerId: customer.id },
    });
    const { updateCustomerConnection } = await import("@/lib/customer-connections");
    await updateCustomerConnection(fixture.companyA.id, created.id, fixture.adminA.id, {
      password: "1122",
      passwordSource: "MANUAL",
    });
    const antes = await prisma.customerConnection.findFirstOrThrow({
      where: { id: created.id },
    });

    // Nova importação do MESMO cliente.
    await provisionPppoeFromErp(fixture.companyA.id, fixture.adminA.id, {
      customerId: customer.id,
      login: LOGIN_ERP,
      document: CPF_FICTICIO,
    });

    const depois = await prisma.customerConnection.findFirstOrThrow({
      where: { id: created.id },
    });
    expect(depois.passwordSource).toBe("MANUAL");
    expect(depois.credentialCiphertext).toBe(antes.credentialCiphertext);
    expect(depois.credentialIv).toBe(antes.credentialIv);
    expect(depois.credentialUpdatedAt?.getTime()).toBe(antes.credentialUpdatedAt?.getTime());
  });

  it("REGRESSÃO: usuário manual não é sobrescrito pelo login do ERP", async () => {
    const customer = await customerWith(fixture.companyA.id);
    const { createCustomerConnection } = await import("@/lib/customer-connections");
    await createCustomerConnection(fixture.companyA.id, fixture.adminA.id, {
      customerId: customer.id,
      username: "definido.a.mao",
      // sem usernameSource => MANUAL
    });

    expect(
      await provisionPppoeFromErp(fixture.companyA.id, fixture.adminA.id, {
        customerId: customer.id,
        login: LOGIN_ERP,
        document: CPF_FICTICIO,
      }),
    ).toBe("SKIPPED_MANUAL");

    const row = await prisma.customerConnection.findFirstOrThrow({
      where: { customerId: customer.id },
    });
    expect(row.username).toBe("definido.a.mao");
  });

  it("usuário de origem RECEITANET acompanha a mudança do login", async () => {
    const customer = await customerWith(fixture.companyA.id);
    await provisionPppoeFromErp(fixture.companyA.id, fixture.adminA.id, {
      customerId: customer.id,
      login: LOGIN_ERP,
      document: CPF_FICTICIO,
    });

    expect(
      await provisionPppoeFromErp(fixture.companyA.id, fixture.adminA.id, {
        customerId: customer.id,
        login: "novo.login",
        document: CPF_FICTICIO,
      }),
    ).toBe("USERNAME_UPDATED");

    const row = await prisma.customerConnection.findFirstOrThrow({
      where: { customerId: customer.id },
    });
    expect(row.username).toBe("novo.login");
    expect(row.usernameSource).toBe("RECEITANET_CALLCENTER");
  });

  it("login igual não produz escrita desnecessária", async () => {
    const customer = await customerWith(fixture.companyA.id);
    await provisionPppoeFromErp(fixture.companyA.id, fixture.adminA.id, {
      customerId: customer.id,
      login: LOGIN_ERP,
      document: CPF_FICTICIO,
    });
    const antes = await prisma.customerConnection.findFirstOrThrow({
      where: { customerId: customer.id },
    });

    expect(
      await provisionPppoeFromErp(fixture.companyA.id, fixture.adminA.id, {
        customerId: customer.id,
        login: LOGIN_ERP,
        document: CPF_FICTICIO,
      }),
    ).toBe("UNCHANGED");

    const depois = await prisma.customerConnection.findFirstOrThrow({
      where: { customerId: customer.id },
    });
    expect(depois.updatedAt.getTime()).toBe(antes.updatedAt.getTime());
  });

  it("múltiplas conexões: a automação desiste em vez de escolher", async () => {
    const customer = await customerWith(fixture.companyA.id);
    const { createCustomerConnection } = await import("@/lib/customer-connections");
    await createCustomerConnection(fixture.companyA.id, fixture.adminA.id, {
      customerId: customer.id,
      username: "conexao.um",
    });
    await createCustomerConnection(fixture.companyA.id, fixture.adminA.id, {
      customerId: customer.id,
      username: "conexao.dois",
    });

    expect(
      await provisionPppoeFromErp(fixture.companyA.id, fixture.adminA.id, {
        customerId: customer.id,
        login: LOGIN_ERP,
        document: CPF_FICTICIO,
      }),
    ).toBe("SKIPPED_AMBIGUOUS");

    const rows = await prisma.customerConnection.findMany({
      where: { customerId: customer.id },
      orderBy: { username: "asc" },
    });
    expect(rows.map((r) => r.username)).toEqual(["conexao.dois", "conexao.um"]);
  });
});

// ---------------------------------------------------------------------------
// Restaurar padrão — a única recalculação
// ---------------------------------------------------------------------------

describe("Restaurar senha padrão da empresa", () => {
  async function connectionFor(companyId: string, doc: string | null) {
    const customer = await customerWith(companyId, { document: doc });
    await provisionPppoeFromErp(companyId, fixture.adminA.id, {
      customerId: customer.id,
      login: LOGIN_ERP,
      document: doc,
    });
    return prisma.customerConnection.findFirstOrThrow({
      where: { customerId: customer.id },
    });
  }

  it("volta para os 4 últimos do CPF e marca a procedência", async () => {
    await policy(fixture.companyA.id, "DOCUMENT_LAST4");
    const conn = await connectionFor(fixture.companyA.id, CPF_FICTICIO);
    const { updateCustomerConnection } = await import("@/lib/customer-connections");
    await updateCustomerConnection(fixture.companyA.id, conn.id, fixture.adminA.id, {
      password: "1122",
      passwordSource: "MANUAL",
    });

    const result = await restoreDefaultPassword(
      fixture.companyA.id,
      conn.id,
      fixture.adminA.id,
    );

    expect(result.applied).toBe(true);
    const row = await prisma.customerConnection.findFirstOrThrow({ where: { id: conn.id } });
    expect(row.passwordSource).toBe("AUTO_DOCUMENT_LAST4");
  });

  it("sem política da empresa, não restaura nada", async () => {
    await policy(fixture.companyA.id, "MANUAL_ONLY");
    const conn = await connectionFor(fixture.companyA.id, CPF_FICTICIO);

    const result = await restoreDefaultPassword(
      fixture.companyA.id,
      conn.id,
      fixture.adminA.id,
    );
    expect(result.applied).toBe(false);
    expect(result.reason).toBe("NO_POLICY");
  });

  it("sem CPF válido, não restaura nada", async () => {
    await policy(fixture.companyA.id, "DOCUMENT_LAST4");
    const conn = await connectionFor(fixture.companyA.id, CNPJ_FICTICIO);

    const result = await restoreDefaultPassword(
      fixture.companyA.id,
      conn.id,
      fixture.adminA.id,
    );
    expect(result.applied).toBe(false);
    expect(result.reason).toBe("NO_DOCUMENT");
  });

  it("conexão de outra empresa é invisível", async () => {
    await policy(fixture.companyA.id, "DOCUMENT_LAST4");
    const conn = await connectionFor(fixture.companyA.id, CPF_FICTICIO);

    // Empresa B tentando restaurar a conexão da empresa A.
    const result = await restoreDefaultPassword(
      fixture.companyB.id,
      conn.id,
      fixture.adminB.id,
    );
    expect(result.applied).toBe(false);
    expect(result.reason).toBe("NOT_FOUND");
  });
});

// ---------------------------------------------------------------------------
// A senha derivada é a que o técnico realmente recebe
// ---------------------------------------------------------------------------

describe("A senha derivada chega ao técnico pelo fluxo seguro existente", () => {
  it("CONTROLE POSITIVO: reveal devolve exatamente os 4 últimos do CPF", async () => {
    await policy(fixture.companyA.id, "DOCUMENT_LAST4");
    const customer = await customerWith(fixture.companyA.id);
    await provisionPppoeFromErp(fixture.companyA.id, fixture.adminA.id, {
      customerId: customer.id,
      login: LOGIN_ERP,
      document: CPF_FICTICIO,
    });
    const conn = await prisma.customerConnection.findFirstOrThrow({
      where: { customerId: customer.id },
    });

    const technician = await prisma.technician.create({
      data: { companyId: fixture.companyA.id, userId: fixture.techA.id },
    });
    const order = await prisma.serviceOrder.create({
      data: {
        companyId: fixture.companyA.id,
        number: await allocateTestServiceOrderNumber(fixture.companyA.id),
        customerId: customer.id,
        technicianId: technician.id,
        type: "Manutenção",
        status: "ASSIGNED",
        description: "OS para validar a revelação da senha derivada.",
      },
    });

    const revealed = await revealConnectionPasswordForOrder(
      fixture.companyA.id,
      { userId: fixture.techA.id, profile: "TECHNICIAN" },
      order.id,
      conn.id,
    );

    // Prova de ponta a ponta: a política derivou, o cifrador gravou, e o
    // técnico leu o mesmo valor.
    expect(revealed).toBe(CPF_LAST4);
  });
});

// ---------------------------------------------------------------------------
// Integração com a importação real (transporte falso)
// ---------------------------------------------------------------------------

describe("Importação do ERP provisiona o PPPoE", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  const DETALHE = {
    idCliente: 15678,
    razaoSocial: "Cliente Importado",
    cpfCnpj: CPF_FICTICIO,
    login: LOGIN_ERP,
    contratoStatusDisplay: "Ativo",
    cidade: "Cidade",
    uf: "SP",
  };

  async function importWith(body: string) {
    const fetchImpl: FetchLike = async () => ({
      ok: true,
      status: 200,
      text: async () => body,
    });
    vi.doMock("@/lib/erp-adapter", () => ({
      resolveCompanyAdapter: async () =>
        new ReceitanetAdapter({ token: "t", fetchImpl }),
    }));
    const mod = await import("@/lib/erp-customer-lookup");
    return mod.importErpCustomer(fixture.companyA.id, fixture.adminA.id, "15678");
  }

  beforeEach(async () => {
    await prisma.eRPIntegration.create({
      data: {
        companyId: fixture.companyA.id,
        provider: "RECEITANET",
        name: "RN",
        enabled: true,
      },
    });
    await policy(fixture.companyA.id, "DOCUMENT_LAST4");
  });

  it("importar cria o cliente E o acesso PPPoE", async () => {
    const result = await importWith(JSON.stringify(DETALHE));

    expect(result.outcome).toBe("CREATED");
    expect(result.pppoe).toBe("CREATED");

    const conn = await prisma.customerConnection.findFirstOrThrow({
      where: { customerId: result.customerId },
    });
    expect(conn.username).toBe(LOGIN_ERP);
    expect(conn.usernameSource).toBe("RECEITANET_CALLCENTER");
    expect(conn.passwordSource).toBe("AUTO_DOCUMENT_LAST4");
  });

  it("provider sem login importa o cliente e reporta o motivo", async () => {
    const semLogin = { ...DETALHE, login: undefined };
    const result = await importWith(JSON.stringify(semLogin));

    expect(result.outcome).toBe("CREATED");
    expect(result.pppoe).toBe("SKIPPED_NO_LOGIN");
    expect(
      await prisma.customerConnection.count({ where: { customerId: result.customerId } }),
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Rota administrativa — procedência é decidida pelo servidor
// ---------------------------------------------------------------------------

describe("PATCH da conexão: restaurar padrão e procedência", () => {
  async function setup(policyValue: "MANUAL_ONLY" | "DOCUMENT_LAST4" = "DOCUMENT_LAST4") {
    await policy(fixture.companyA.id, policyValue);
    const customer = await customerWith(fixture.companyA.id);
    await provisionPppoeFromErp(fixture.companyA.id, fixture.adminA.id, {
      customerId: customer.id,
      login: LOGIN_ERP,
      document: CPF_FICTICIO,
    });
    const connection = await prisma.customerConnection.findFirstOrThrow({
      where: { customerId: customer.id },
    });
    return { customer, connection };
  }

  async function patch(
    userId: string,
    customerId: string,
    connectionId: string,
    body: Record<string, unknown>,
  ) {
    const token = await createTokenFor(userId);
    return patchConnection(
      apiRequest(
        `/api/customers/${customerId}/connections/${connectionId}`,
        { method: "PATCH", body },
        token,
      ),
      { params: { id: customerId, connectionId } },
    );
  }

  it("CONTROLE POSITIVO: ADMIN restaura o padrão e a procedência muda", async () => {
    const { customer, connection } = await setup();
    const { updateCustomerConnection } = await import("@/lib/customer-connections");
    await updateCustomerConnection(fixture.companyA.id, connection.id, fixture.adminA.id, {
      password: "1122",
      passwordSource: "MANUAL",
    });

    const res = await patch(fixture.adminA.id, customer.id, connection.id, {
      restoreDefaultPassword: true,
    });

    expect(res.status).toBe(200);
    const row = await prisma.customerConnection.findFirstOrThrow({
      where: { id: connection.id },
    });
    expect(row.passwordSource).toBe("AUTO_DOCUMENT_LAST4");
  });

  it("senha digitada pelo ADMIN é marcada MANUAL pelo SERVIDOR", async () => {
    const { customer, connection } = await setup();

    const res = await patch(fixture.adminA.id, customer.id, connection.id, {
      password: "senha-escolhida-a-mao",
    });

    expect(res.status).toBe(200);
    const row = await prisma.customerConnection.findFirstOrThrow({
      where: { id: connection.id },
    });
    expect(row.passwordSource).toBe("MANUAL");
    // E o corpo da resposta nunca devolve a senha.
    expect(await res.text()).not.toContain("senha-escolhida-a-mao");
  });

  it("usuário digitado pelo ADMIN deixa de acompanhar o provider", async () => {
    const { customer, connection } = await setup();

    const res = await patch(fixture.adminA.id, customer.id, connection.id, {
      username: "definido.a.mao",
    });

    expect(res.status).toBe(200);
    const row = await prisma.customerConnection.findFirstOrThrow({
      where: { id: connection.id },
    });
    expect(row.usernameSource).toBe("MANUAL");
  });

  /**
   * O ataque que a procedência convida: marcar uma senha digitada como
   * automática autorizaria a política da empresa a sobrescrevê-la depois.
   */
  it.each([
    ["passwordSource", { passwordSource: "AUTO_DOCUMENT_LAST4" }],
    ["usernameSource", { usernameSource: "RECEITANET" }],
    ["os dois", { passwordSource: "MANUAL", usernameSource: "MANUAL" }],
  ])("REGRESSÃO: cliente NAO escolhe a procedência (%s) => 400", async (_l, body) => {
    const { customer, connection } = await setup();
    const res = await patch(fixture.adminA.id, customer.id, connection.id, body);
    expect(res.status).toBe(400);
  });

  it("definir e restaurar na mesma requisição é recusado", async () => {
    const { customer, connection } = await setup();
    const res = await patch(fixture.adminA.id, customer.id, connection.id, {
      password: "abcd",
      restoreDefaultPassword: true,
    });
    expect(res.status).toBe(400);
  });

  it("sem política da empresa, restaurar responde 400 e não altera nada", async () => {
    const { customer, connection } = await setup("MANUAL_ONLY");
    const antes = await prisma.customerConnection.findFirstOrThrow({
      where: { id: connection.id },
    });

    const res = await patch(fixture.adminA.id, customer.id, connection.id, {
      restoreDefaultPassword: true,
    });

    expect(res.status).toBe(400);
    const depois = await prisma.customerConnection.findFirstOrThrow({
      where: { id: connection.id },
    });
    expect(depois.updatedAt.getTime()).toBe(antes.updatedAt.getTime());
  });

  it.each([
    ["DISPATCHER", "dispatcherA"],
    ["TECHNICIAN", "techA"],
  ])("%s não restaura senha padrão", async (_label, key) => {
    const { customer, connection } = await setup();
    const userId = (fixture as unknown as Record<string, { id: string }>)[key].id;

    const res = await patch(userId, customer.id, connection.id, {
      restoreDefaultPassword: true,
    });

    expect(res.status).toBe(403);
  });

  it("conexão de outra empresa responde 404, não 403", async () => {
    const { customer, connection } = await setup();

    const res = await patch(fixture.adminB.id, customer.id, connection.id, {
      restoreDefaultPassword: true,
    });

    // 404 e nao 403: 403 confirmaria que o id existe.
    expect(res.status).toBe(404);
  });
});
