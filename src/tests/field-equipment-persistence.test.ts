import { describe, it, expect, beforeEach } from "vitest";
import { POST as startOrder } from "@/app/api/field/v1/service-orders/[id]/start/route";
import { GET as executionBundle } from "@/app/api/field/v1/service-orders/[id]/execution/route";
import { POST as addEquipment } from "@/app/api/field/v1/service-orders/[id]/equipment/route";
import { prisma } from "@/lib/prisma";
import {
  allocateTestServiceOrderNumber,
  fieldRequest,
  registerTestDevice,
  seedTestData,
  type TestFixture,
} from "./helpers";

/**
 * # Persistência do equipamento instalado
 *
 * Regressão do que o smoke test físico da v0.10 registrou no servidor:
 *
 * ```text
 * POST .../equipment 400
 * POST .../equipment 200
 * ```
 *
 * O técnico percebeu o formulário fechando sem o equipamento aparecer. A
 * pergunta que estes testes respondem — pelas ROTAS reais, contra Postgres
 * real — é em qual camada o dado some:
 *
 * * o POST persiste? (banco)
 * * o bundle devolve? (DTO)
 * * aparece uma vez só? (duplicação)
 *
 * O 400 é reproduzido aqui com o payload que o formulário realmente monta
 * quando ninguém digitou série nem MAC — que é o caminho em que o aplicativo
 * fechava a folha antes de saber a resposta do servidor.
 *
 * Nada de dado real: cliente, técnico e equipamento são fictícios.
 */

let fixture: TestFixture;

beforeEach(async () => {
  fixture = await seedTestData();
});

let keySeed = 0;
const key = (step: string) => `equip-${step}-${(keySeed += 1)}-${Date.now()}`;

async function body(response: Response) {
  return (await response.json()) as {
    ok: boolean;
    data?: Record<string, unknown>;
    error?: { code: string; message: string; retryable?: boolean; conflict?: boolean };
  };
}

/** OS em atendimento, com o técnico dono e um token de aparelho real. */
async function cenario() {
  const customer = await prisma.customer.create({
    data: {
      companyId: fixture.companyA.id,
      name: "Cliente Ficticio do Equipamento",
      city: "Cidade Teste",
      address: "Rua Ficticia",
    },
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
      type: "Instalação",
      typeId: fixture.typeA.id,
      description: "Instalação de fibra (equipamento).",
      status: "ASSIGNED",
      assignedAt: new Date(),
    },
  });
  const { token } = await registerTestDevice(fixture.techA.id);

  await startOrder(
    fieldRequest(`/api/field/v1/service-orders/${order.id}/start`, {
      method: "POST",
      token,
      idempotencyKey: key("start"),
      body: { expectedVersion: order.version },
    }),
    { params: { id: order.id } },
  );

  return { order, customer, technician, token };
}

async function versionOf(orderId: string) {
  const row = await prisma.serviceOrder.findUniqueOrThrow({
    where: { id: orderId },
    select: { version: true },
  });
  return row.version;
}

async function bundleOf(orderId: string, token: string) {
  const response = await executionBundle(
    fieldRequest(`/api/field/v1/service-orders/${orderId}/execution`, { token }),
    { params: { id: orderId } },
  );
  expect(response.status).toBe(200);
  const payload = await body(response);
  return payload.data as {
    version: number;
    equipments: { id: string; equipmentType: string; serial: string | null }[];
  };
}

function post(
  orderId: string,
  token: string,
  payload: Record<string, unknown>,
  idempotencyKey: string,
) {
  return addEquipment(
    fieldRequest(`/api/field/v1/service-orders/${orderId}/equipment`, {
      method: "POST",
      token,
      idempotencyKey,
      body: payload,
    }),
    { params: { id: orderId } },
  );
}

describe("Equipamento instalado — persistência pela rota real", () => {
  it("o POST válido persiste, e o bundle devolve o equipamento UMA vez", async () => {
    const { order, technician, token } = await cenario();

    const response = await post(
      order.id,
      token,
      {
        expectedVersion: await versionOf(order.id),
        equipmentType: "ONU",
        manufacturer: "Fabricante Ficticio",
        model: "MODELO-X",
        serial: "FICTSERIAL001",
      },
      key("ok"),
    );
    expect(response.status).toBe(201);

    // --- banco -------------------------------------------------------------
    const rows = await prisma.serviceOrderEquipment.findMany({
      where: { serviceOrderId: order.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].companyId).toBe(fixture.companyA.id);
    expect(rows[0].customerId).toBe(order.customerId);
    expect(rows[0].installedByUserId).toBe(fixture.techA.id);
    expect(rows[0].serial).toBe("FICTSERIAL001");
    expect(technician.id).toBe(order.technicianId);

    // --- timeline e auditoria ---------------------------------------------
    expect(
      await prisma.serviceOrderEvent.count({
        where: { serviceOrderId: order.id, event: "EQUIPMENT_INSTALLED" },
      }),
    ).toBe(1);
    expect(
      await prisma.auditLog.count({
        where: { entityId: rows[0].id, companyId: fixture.companyA.id },
      }),
    ).toBe(1);

    // --- bundle ------------------------------------------------------------
    const bundle = await bundleOf(order.id, token);
    expect(bundle.equipments).toHaveLength(1);
    expect(bundle.equipments[0].id).toBe(rows[0].id);
    expect(bundle.equipments[0].serial).toBe("FICTSERIAL001");
  });

  it("sem série e sem MAC o servidor RECUSA — e não cria nada", async () => {
    const { order, token } = await cenario();

    /*
      Este é o 400 do smoke test.

      O formulário não exigia identificador antes de enviar, então bastava o
      técnico tocar REGISTRAR com os campos de série e MAC vazios. O comando
      sai, o servidor recusa — e o aplicativo já tinha fechado a folha.
    */
    const response = await post(
      order.id,
      token,
      {
        expectedVersion: await versionOf(order.id),
        equipmentType: "ONU",
        manufacturer: "Fabricante Ficticio",
        model: "MODELO-X",
      },
      key("sem-id"),
    );

    expect(response.status).toBe(400);
    const payload = await body(response);
    expect(payload.ok).toBe(false);
    expect(payload.error?.code).toBe("VALIDATION_ERROR");
    expect(payload.error?.message).toContain("número de série");
    // Recusa não é sucesso adiado: o Flutter não pode tentar de novo sozinho.
    expect(payload.error?.retryable).toBe(false);
    expect(payload.error?.conflict).toBe(false);

    expect(
      await prisma.serviceOrderEquipment.count({
        where: { serviceOrderId: order.id },
      }),
    ).toBe(0);
    expect(
      await prisma.serviceOrderEvent.count({
        where: { serviceOrderId: order.id, event: "EQUIPMENT_INSTALLED" },
      }),
    ).toBe(0);
    expect((await bundleOf(order.id, token)).equipments).toHaveLength(0);
  });

  it("400 e depois 200 — exatamente a sequência do smoke test — deixa UM só", async () => {
    const { order, token } = await cenario();

    const recusado = await post(
      order.id,
      token,
      {
        expectedVersion: await versionOf(order.id),
        equipmentType: "ONU",
        manufacturer: "tolink",
      },
      key("primeira"),
    );
    expect(recusado.status).toBe(400);

    // A recusa não pode ter mexido na versão da OS: se tivesse, a segunda
    // tentativa levaria um `expectedVersion` velho e cairia em 409.
    const aceito = await post(
      order.id,
      token,
      {
        expectedVersion: await versionOf(order.id),
        equipmentType: "ONU",
        manufacturer: "tolink",
        serial: "FICTSERIAL002",
      },
      key("segunda"),
    );
    expect(aceito.status).toBe(201);

    const bundle = await bundleOf(order.id, token);
    expect(bundle.equipments).toHaveLength(1);
    expect(bundle.equipments[0].serial).toBe("FICTSERIAL002");
  });

  it("a recusa NÃO consome a versão da OS", async () => {
    const { order, token } = await cenario();
    const antes = await versionOf(order.id);

    await post(
      order.id,
      token,
      { expectedVersion: antes, equipmentType: "ONU" },
      key("versao"),
    );

    /*
      Provar isto separadamente importa.

      Se uma validação recusada ainda incrementasse a versão, o formulário do
      técnico ficaria com um `expectedVersion` velho na mão e a SEGUNDA
      tentativa — a correta — voltaria 409. O sintoma no aparelho seria
      indistinguível de "não salva nunca".
    */
    expect(await versionOf(order.id)).toBe(antes);
  });

  it("retry com a MESMA chave de idempotência não duplica", async () => {
    const { order, token } = await cenario();
    const chave = key("idem");
    const payload = {
      expectedVersion: await versionOf(order.id),
      equipmentType: "ONU",
      serial: "FICTSERIAL003",
    };

    const primeira = await post(order.id, token, payload, chave);
    expect(primeira.status).toBe(201);
    const segunda = await post(order.id, token, payload, chave);
    expect(segunda.status).toBe(201);

    expect(
      await prisma.serviceOrderEquipment.count({
        where: { serviceOrderId: order.id },
      }),
    ).toBe(1);
    expect(
      await prisma.serviceOrderEvent.count({
        where: { serviceOrderId: order.id, event: "EQUIPMENT_INSTALLED" },
      }),
    ).toBe(1);
    expect((await bundleOf(order.id, token)).equipments).toHaveLength(1);
  });

  it("mesma chave com payload diferente é conflito de idempotência", async () => {
    const { order, token } = await cenario();
    const chave = key("idem-conflito");
    const versao = await versionOf(order.id);

    expect(
      (
        await post(
          order.id,
          token,
          { expectedVersion: versao, equipmentType: "ONU", serial: "FICTA" },
          chave,
        )
      ).status,
    ).toBe(201);

    const divergente = await post(
      order.id,
      token,
      { expectedVersion: versao, equipmentType: "ONU", serial: "FICTB" },
      chave,
    );
    expect(divergente.status).toBe(409);
    expect((await body(divergente)).error?.code).toBe("IDEMPOTENCY_CONFLICT");
    expect((await bundleOf(order.id, token)).equipments).toHaveLength(1);
  });

  it("expectedVersion velho é 409, e nada é criado", async () => {
    const { order, token } = await cenario();
    const versao = await versionOf(order.id);

    expect(
      (
        await post(
          order.id,
          token,
          { expectedVersion: versao, equipmentType: "ONU", serial: "FICTC1" },
          key("cas-1"),
        )
      ).status,
    ).toBe(201);

    // Segunda com a versão que o técnico tinha ANTES da primeira gravação.
    const stale = await post(
      order.id,
      token,
      { expectedVersion: versao, equipmentType: "ONU", serial: "FICTC2" },
      key("cas-2"),
    );
    expect(stale.status).toBe(409);
    expect((await bundleOf(order.id, token)).equipments).toHaveLength(1);
  });

  it("técnico de OUTRA EMPRESA não registra equipamento na OS alheia", async () => {
    const { order } = await cenario();

    /*
      Um técnico de verdade da empresa B — com `User` E `Technician`.

      O atalho de reaproveitar `fixture.techB` seria falso: ele é da empresa A
      e não tem registro `Technician`, então o token dele é recusado ainda na
      porta com 401. O teste passaria sem nunca ter chegado ao isolamento de
      tenant, que é a coisa que ele afirma provar.
    */
    const invasor = await prisma.user.create({
      data: {
        companyId: fixture.companyB.id,
        name: "Tecnico Ficticio da Empresa B",
        email: `tec-b-${Date.now()}@exemplo.invalido`,
        passwordHash: "nao-usado",
        profile: "TECHNICIAN",
        active: true,
      },
    });
    await prisma.technician.create({
      data: { companyId: fixture.companyB.id, userId: invasor.id },
    });
    const { token } = await registerTestDevice(invasor.id);

    const response = await post(
      order.id,
      token,
      {
        expectedVersion: await versionOf(order.id),
        equipmentType: "ONU",
        serial: "FICTINVASOR",
      },
      key("cross-tenant"),
    );

    // 404 e não 403: confirmar existência já seria vazamento.
    expect(response.status).toBe(404);
    expect(
      await prisma.serviceOrderEquipment.count({
        where: { serviceOrderId: order.id },
      }),
    ).toBe(0);
  });

  it("técnico da mesma empresa que não é o dono da OS é recusado", async () => {
    const { order } = await cenario();

    const outroUser = await prisma.user.create({
      data: {
        companyId: fixture.companyA.id,
        name: "Tecnico Ficticio Dois",
        email: `tec2-${Date.now()}@exemplo.invalido`,
        passwordHash: "nao-usado",
        profile: "TECHNICIAN",
        active: true,
      },
    });
    await prisma.technician.create({
      data: { companyId: fixture.companyA.id, userId: outroUser.id },
    });
    const { token } = await registerTestDevice(outroUser.id);

    const response = await post(
      order.id,
      token,
      {
        expectedVersion: await versionOf(order.id),
        equipmentType: "ONU",
        serial: "FICTOUTRO",
      },
      key("nao-dono"),
    );

    expect(response.status).toBe(404);
    expect(
      await prisma.serviceOrderEquipment.count({
        where: { serviceOrderId: order.id },
      }),
    ).toBe(0);
  });

  it("MAC inválido é recusado antes de qualquer escrita", async () => {
    const { order, token } = await cenario();

    const response = await post(
      order.id,
      token,
      {
        expectedVersion: await versionOf(order.id),
        equipmentType: "ONU",
        macAddress: "isto-nao-e-um-mac",
      },
      key("mac"),
    );

    expect(response.status).toBe(400);
    expect((await body(response)).error?.message).toContain("MAC");
    expect(
      await prisma.serviceOrderEquipment.count({
        where: { serviceOrderId: order.id },
      }),
    ).toBe(0);
  });
});
