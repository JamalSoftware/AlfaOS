import { describe, it, expect, beforeEach } from "vitest";
import { POST as startOrder } from "@/app/api/field/v1/service-orders/[id]/start/route";
import { GET as executionBundle } from "@/app/api/field/v1/service-orders/[id]/execution/route";
import { POST as addEquipment } from "@/app/api/field/v1/service-orders/[id]/equipment/route";
import { POST as addEvidence } from "@/app/api/field/v1/service-orders/[id]/evidence/route";
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
  // `upsert`, não `create`: um teste que monta DUAS OS reutiliza o mesmo
  // técnico, e `Technician.userId` é único.
  const technician = await prisma.technician.upsert({
    where: { userId: fixture.techA.id },
    update: {},
    create: { companyId: fixture.companyA.id, userId: fixture.techA.id },
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
  // Instalação distinta por cenário, pelo mesmo motivo do `upsert` acima.
  const { token } = await registerTestDevice(fixture.techA.id, {
    installationId: key("inst"),
  });

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

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 7),
]);

/**
 * Anexa a foto da etiqueta pela rota real e devolve o id dela.
 *
 * Desde a v0.10.1 a identificação do equipamento é a FOTO: série e MAC viraram
 * opcionais, e o servidor exige uma evidência `EQUIPMENT_LABEL` da MESMA OS.
 */
async function etiqueta(orderId: string, token: string): Promise<string> {
  const form = new FormData();
  form.set(
    "file",
    new File([new Uint8Array(PNG)], "etiqueta.png", { type: "image/png" }),
  );
  form.set("expectedOrderVersion", String(await versionOf(orderId)));
  form.set("category", "EQUIPMENT_LABEL");

  const response = await addEvidence(
    new Request(
      `http://localhost/api/field/v1/service-orders/${orderId}/evidence`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Idempotency-Key": key("etiqueta"),
        },
        body: form,
      },
    ),
    { params: { id: orderId } },
  );
  expect(response.status).toBe(201);
  const payload = await body(response);
  return (payload.data?.evidence as { id: string }).id;
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
        labelEvidenceId: await etiqueta(order.id, token),
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

  it("sem série e sem MAC é ACEITO — a foto da etiqueta identifica", async () => {
    const { order, token } = await cenario();

    /*
      Onde era o 400 do smoke test, agora é o caminho normal (v0.10.1).

      A regra antiga mandava o técnico transcrever à mão, agachado dentro de um
      armário, o mesmo adesivo que a câmera lê sem errar. A foto passou a ser a
      identificação; a transcrição, quando alguém precisar dela, é feita no
      escritório com a imagem na tela.
    */
    const response = await post(
      order.id,
      token,
      {
        labelEvidenceId: await etiqueta(order.id, token),
        expectedVersion: await versionOf(order.id),
        equipmentType: "ONU",
        manufacturer: "Fabricante Ficticio",
        model: "MODELO-X",
      },
      key("so-foto"),
    );

    expect(response.status).toBe(201);
    const rows = await prisma.serviceOrderEquipment.findMany({
      where: { serviceOrderId: order.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].serial).toBeNull();
    expect(rows[0].macAddress).toBeNull();
    // O que identifica está preservado e conferível.
    expect(rows[0].labelEvidenceId).toBeTruthy();
    expect((await bundleOf(order.id, token)).equipments).toHaveLength(1);
  });

  it("SEM a foto da etiqueta o servidor recusa — e não cria nada", async () => {
    const { order, token } = await cenario();

    const response = await post(
      order.id,
      token,
      {
        expectedVersion: await versionOf(order.id),
        equipmentType: "ONU",
        serial: "FICTSEMFOTO01",
      },
      key("sem-foto"),
    );

    // Um APK anterior à v0.10.1 não manda o campo e cai aqui — que é o
    // desfecho certo: ele registraria equipamento sem identificação nenhuma,
    // já que série e MAC deixaram de ser exigidos na mesma mudança.
    expect(response.status).toBe(400);
    const payload = await body(response);
    expect(payload.ok).toBe(false);
    expect(payload.error?.code).toBe("VALIDATION_ERROR");
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

  it("uma etiqueta de OUTRA OS não identifica este equipamento", async () => {
    const alheia = await cenario();
    const etiquetaAlheia = await etiqueta(alheia.order.id, alheia.token);

    const { order, token } = await cenario();
    const response = await post(
      order.id,
      token,
      {
        labelEvidenceId: etiquetaAlheia,
        expectedVersion: await versionOf(order.id),
        equipmentType: "ONU",
      },
      key("etiqueta-alheia"),
    );

    // Sem amarrar a foto à OS, o campo viraria um ponteiro para qualquer linha
    // da tabela — e "identificado pela etiqueta" seria mentira.
    expect(response.status).toBe(400);
    expect(
      await prisma.serviceOrderEquipment.count({
        where: { serviceOrderId: order.id },
      }),
    ).toBe(0);
  });

  it("400 e depois 200 — exatamente a sequência do smoke test — deixa UM só", async () => {
    const { order, token } = await cenario();
    const label = await etiqueta(order.id, token);

    const recusado = await post(
      order.id,
      token,
      {
        labelEvidenceId: label,
        expectedVersion: await versionOf(order.id),
        equipmentType: "ONU",
        manufacturer: "tolink",
        macAddress: "isto-nao-e-um-mac",
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
        labelEvidenceId: label,
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
    const label = await etiqueta(order.id, token);
    const antes = await versionOf(order.id);

    await post(
      order.id,
      token,
      {
        labelEvidenceId: label,
        expectedVersion: antes,
        equipmentType: "ONU",
        macAddress: "isto-nao-e-um-mac",
      },
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
    const label = await etiqueta(order.id, token);
    const payload = {
      labelEvidenceId: label,
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
    const label = await etiqueta(order.id, token);
    const versao = await versionOf(order.id);

    expect(
      (
        await post(
          order.id,
          token,
          { labelEvidenceId: label, expectedVersion: versao, equipmentType: "ONU", serial: "FICTA" },
          chave,
        )
      ).status,
    ).toBe(201);

    const divergente = await post(
      order.id,
      token,
      { labelEvidenceId: label, expectedVersion: versao, equipmentType: "ONU", serial: "FICTB" },
      chave,
    );
    expect(divergente.status).toBe(409);
    expect((await body(divergente)).error?.code).toBe("IDEMPOTENCY_CONFLICT");
    expect((await bundleOf(order.id, token)).equipments).toHaveLength(1);
  });

  it("expectedVersion velho é 409, e nada é criado", async () => {
    const { order, token } = await cenario();
    const label = await etiqueta(order.id, token);
    const versao = await versionOf(order.id);

    expect(
      (
        await post(
          order.id,
          token,
          { labelEvidenceId: label, expectedVersion: versao, equipmentType: "ONU", serial: "FICTC1" },
          key("cas-1"),
        )
      ).status,
    ).toBe(201);

    // Segunda com a versão que o técnico tinha ANTES da primeira gravação.
    const stale = await post(
      order.id,
      token,
      { labelEvidenceId: label, expectedVersion: versao, equipmentType: "ONU", serial: "FICTC2" },
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
        // Id sintetico: a OS nem e dele, entao a recusa tem de vir da
        // tenancy — e nao de um campo faltando no schema.
        labelEvidenceId: "etiqueta-inexistente",
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
        labelEvidenceId: "etiqueta-inexistente",
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

  it("MAC inválido é recusado — mas MAC VAZIO é válido", async () => {
    const { order, token } = await cenario();
    const label = await etiqueta(order.id, token);

    const response = await post(
      order.id,
      token,
      {
        labelEvidenceId: label,
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
