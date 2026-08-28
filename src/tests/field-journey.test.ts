import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { GET as listOrders } from "@/app/api/field/v1/service-orders/route";
import { POST as startOrder } from "@/app/api/field/v1/service-orders/[id]/start/route";
import {
  GET as executionBundle,
  POST as saveReport,
} from "@/app/api/field/v1/service-orders/[id]/execution/route";
import { POST as correctLocation } from "@/app/api/field/v1/service-orders/[id]/location/correct/route";
import { POST as checkIn } from "@/app/api/field/v1/service-orders/[id]/check-in/route";
import { POST as answerChecklist } from "@/app/api/field/v1/service-orders/[id]/checklist/[itemId]/route";
import { POST as addEvidence } from "@/app/api/field/v1/service-orders/[id]/evidence/route";
import { POST as useMaterial } from "@/app/api/field/v1/service-orders/[id]/materials/route";
import { POST as addEquipment } from "@/app/api/field/v1/service-orders/[id]/equipment/route";
import { PUT as putSignature } from "@/app/api/field/v1/service-orders/[id]/signature/route";
import { POST as completeOrder } from "@/app/api/field/v1/service-orders/[id]/complete/route";
import { prisma } from "@/lib/prisma";
import { LocalFileStorageAdapter, setFileStorage } from "@/lib/storage";
import { putChecklistTemplate } from "@/lib/checklists";
import { createInventoryItem, receiveStock } from "@/lib/inventory";
import { putCompletionPolicy } from "@/lib/service-order-completion";
import {
  allocateTestServiceOrderNumber,
  fieldRequest,
  registerTestDevice,
  seedTestData,
  type TestFixture,
} from "./helpers";

/**
 * # A jornada completa do técnico (§72)
 *
 * Um atendimento inteiro, pelas ROTAS reais do Field, do começo ao fim:
 *
 * ```text
 * lista → iniciar → corrigir localização → check-in → checklist
 *       → foto → material → equipamento → relatório → assinatura → concluir
 * ```
 *
 * Com a política do tipo exigindo TUDO — checklist, foto por categoria,
 * material, equipamento, check-in e assinatura. É o cenário mais estrito que a
 * v0.10 sabe montar.
 *
 * ## Por que este teste existe além dos outros
 *
 * Os testes de unidade e os ataques provam que cada peça funciona ou recusa
 * corretamente. Nenhum deles prova que as peças, juntas, deixam um técnico
 * FECHAR uma OS — e foi exatamente isso que faltou: ao montar a tela de
 * execução descobriu-se que não havia rota para gravar diagnóstico e serviço
 * realizado, que a conclusão exige desde a v0.4. O aplicativo teria anexado
 * foto, baixado material e colhido assinatura para receber
 * `EXECUTION_DIAGNOSIS_REQUIRED` para sempre.
 *
 * Uma suíte só de peças isoladas não pega isso. Esta jornada pega.
 *
 * Nada de ReceitaNet e nada de dado real: cliente, técnico e equipamento são
 * fictícios.
 */

let fixture: TestFixture;
let storageRoot: string;

beforeAll(async () => {
  storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "alfaos-journey-"));
  setFileStorage(new LocalFileStorageAdapter(storageRoot));
});

afterAll(async () => {
  setFileStorage(null);
  await fs.rm(storageRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  fixture = await seedTestData();
});

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 7),
]);

let keySeed = 0;
function key(step: string) {
  keySeed += 1;
  return `jornada-${step}-${keySeed}-${Date.now()}`;
}

async function payload(response: Response) {
  const body = (await response.json()) as {
    ok: boolean;
    data?: Record<string, unknown>;
    error?: { code: string; message: string; pendencies?: { code: string }[] };
  };
  return body;
}

/** Falha com a mensagem do servidor, em vez de um `expect` mudo. */
async function expectOk(response: Response, step: string) {
  if (response.status >= 400) {
    const body = await payload(response);
    throw new Error(
      `${step} falhou com ${response.status}: ${body.error?.code} — ${body.error?.message}` +
        (body.error?.pendencies
          ? ` [${body.error.pendencies.map((p) => p.code).join(", ")}]`
          : ""),
    );
  }
  return payload(response);
}

describe("Jornada completa do atendimento", () => {
  it("do primeiro toque à OS concluída, com a política exigindo tudo", async () => {
    // --- configuração da empresa -----------------------------------------
    await putChecklistTemplate(fixture.companyA.id, fixture.adminA.id, {
      serviceOrderTypeId: fixture.typeA.id,
      name: "Checklist de instalação",
      items: [
        { label: "Cabo testado?", type: "BOOLEAN", required: true },
        { label: "Potência óptica (dBm)", type: "NUMBER", required: false },
        {
          label: "Foto da ONU",
          type: "PHOTO",
          required: true,
          evidenceCategory: "ONU_ONT",
        },
      ],
    });

    await putCompletionPolicy(
      fixture.companyA.id,
      fixture.adminA.id,
      fixture.typeA.id,
      {
        requireChecklist: true,
        requireSignature: true,
        requireMaterials: true,
        requireEquipment: true,
        requireCheckIn: true,
        minEvidenceCount: 1,
        requiredEvidenceCategories: ["ONU_ONT"],
      },
    );

    const item = await createInventoryItem(
      fixture.companyA.id,
      fixture.adminA.id,
      { code: "CABO-DROP", name: "Cabo drop óptico", unit: "METER" },
    );

    // --- a OS na fila do técnico -----------------------------------------
    const customer = await prisma.customer.create({
      data: {
        companyId: fixture.companyA.id,
        name: "Cliente Ficticio da Jornada",
        city: "Cidade Teste",
        address: "Rua Ficticia",
      },
    });
    const technician = await prisma.technician.create({
      data: { companyId: fixture.companyA.id, userId: fixture.techA.id },
    });
    await receiveStock(fixture.companyA.id, fixture.adminA.id, {
      itemId: item.id,
      technicianId: technician.id,
      quantity: 100,
    });

    const order = await prisma.serviceOrder.create({
      data: {
        companyId: fixture.companyA.id,
        number: await allocateTestServiceOrderNumber(fixture.companyA.id),
        customerId: customer.id,
        technicianId: technician.id,
        type: "Instalação",
        typeId: fixture.typeA.id,
        description: "Instalação de fibra (jornada).",
        status: "ASSIGNED",
        assignedAt: new Date(),
      },
    });

    const { token } = await registerTestDevice(fixture.techA.id);

    // --- 1. a fila ---------------------------------------------------------
    const list = await expectOk(
      await listOrders(fieldRequest("/api/field/v1/service-orders", { token })),
      "listar OS",
    );
    expect((list.data?.items as unknown[]).length).toBe(1);

    // --- 2. iniciar --------------------------------------------------------
    const started = await expectOk(
      await startOrder(
        fieldRequest(`/api/field/v1/service-orders/${order.id}/start`, {
          method: "POST",
          token,
          idempotencyKey: key("start"),
          body: { expectedVersion: order.version },
        }),
        { params: { id: order.id } },
      ),
      "iniciar",
    );
    const executionVersion = (
      started.data?.execution as { version: number }
    ).version;

    const bundleOf = async () => {
      const res = await expectOk(
        await executionBundle(
          fieldRequest(
            `/api/field/v1/service-orders/${order.id}/execution`,
            { token },
          ),
          { params: { id: order.id } },
        ),
        "ler execução",
      );
      return res.data as Record<string, unknown>;
    };

    let bundle = await bundleOf();
    // Antes de qualquer coisa, o servidor já diz tudo o que falta.
    expect((bundle.pendencies as unknown[]).length).toBeGreaterThan(0);
    expect((bundle.checklist as unknown[]).length).toBe(3);
    expect((bundle.location as { status: string }).status).toBe("MISSING");

    const version = () => (bundle.version as number);

    // --- 3. corrigir a localização (o cliente não tinha ponto) -------------
    await expectOk(
      await correctLocation(
        fieldRequest(
          `/api/field/v1/service-orders/${order.id}/location/correct`,
          {
            method: "POST",
            token,
            idempotencyKey: key("loc"),
            body: {
              // `null` = "eu vi que não existe localização": o CAS da criação.
              expectedVersion: null,
              reason: "INCOMPLETE_REGISTRATION",
              latitude: -23.5505,
              longitude: -46.6333,
              accuracyMeters: 8,
              source: "TECHNICIAN_GPS",
            },
          },
        ),
        { params: { id: order.id } },
      ),
      "corrigir localização",
    );

    bundle = await bundleOf();
    expect((bundle.location as { status: string }).status).toBe("CONFIRMED");

    // --- 4. check-in -------------------------------------------------------
    await expectOk(
      await checkIn(
        fieldRequest(`/api/field/v1/service-orders/${order.id}/check-in`, {
          method: "POST",
          token,
          idempotencyKey: key("checkin"),
          body: {
            expectedVersion: version(),
            latitude: -23.5506,
            longitude: -46.6334,
            accuracyMeters: 12,
          },
        }),
        { params: { id: order.id } },
      ),
      "check-in",
    );

    bundle = await bundleOf();
    const checkInInfo = bundle.checkIn as { distanceMeters: number | null };
    expect(checkInInfo).not.toBeNull();
    // Distância calculada no servidor, não enviada pelo aparelho.
    expect(checkInInfo.distanceMeters).not.toBeNull();

    // --- 5. checklist ------------------------------------------------------
    const checklist = bundle.checklist as { id: string; type: string }[];
    const booleano = checklist.find((i) => i.type === "BOOLEAN")!;
    await expectOk(
      await answerChecklist(
        fieldRequest(
          `/api/field/v1/service-orders/${order.id}/checklist/${booleano.id}`,
          {
            method: "POST",
            token,
            idempotencyKey: key("checklist"),
            body: { expectedVersion: version(), valueBoolean: true },
          },
        ),
        { params: { id: order.id, itemId: booleano.id } },
      ),
      "responder checklist",
    );
    bundle = await bundleOf();

    // --- 6. foto na categoria exigida --------------------------------------
    const form = new FormData();
    form.set(
      "file",
      new File([new Uint8Array(PNG)], "onu.png", { type: "image/png" }),
    );
    form.set("expectedOrderVersion", String(version()));
    form.set("category", "ONU_ONT");
    form.set("caption", "ONU instalada no rack do cliente");

    await expectOk(
      await addEvidence(
        new Request(
          `http://localhost/api/field/v1/service-orders/${order.id}/evidence`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Idempotency-Key": key("foto"),
            },
            body: form,
          },
        ),
        { params: { id: order.id } },
      ),
      "anexar foto",
    );
    bundle = await bundleOf();
    expect((bundle.evidences as unknown[]).length).toBe(1);
    // (a etiqueta do equipamento entra logo abaixo e vira a segunda)

    // --- 7. material -------------------------------------------------------
    await expectOk(
      await useMaterial(
        fieldRequest(`/api/field/v1/service-orders/${order.id}/materials`, {
          method: "POST",
          token,
          idempotencyKey: key("material"),
          body: {
            expectedVersion: version(),
            itemId: item.id,
            quantity: 35.5,
          },
        }),
        { params: { id: order.id } },
      ),
      "baixar material",
    );
    bundle = await bundleOf();
    expect((bundle.materials as unknown[]).length).toBe(1);

    // --- 8. equipamento -----------------------------------------------------
    // A etiqueta identifica o aparelho desde a v0.10.1; serie e MAC viraram
    // opcionais e viajam junto so porque o tecnico digitou.
    const etiqueta = new FormData();
    etiqueta.set(
      "file",
      new File([new Uint8Array(PNG)], "etiqueta.png", { type: "image/png" }),
    );
    etiqueta.set("expectedOrderVersion", String(version()));
    etiqueta.set("category", "EQUIPMENT_LABEL");

    const etiquetaCriada = await expectOk(
      await addEvidence(
        new Request(
          `http://localhost/api/field/v1/service-orders/${order.id}/evidence`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Idempotency-Key": key("etiqueta"),
            },
            body: etiqueta,
          },
        ),
        { params: { id: order.id } },
      ),
      "anexar etiqueta",
    );
    bundle = await bundleOf();

    await expectOk(
      await addEquipment(
        fieldRequest(`/api/field/v1/service-orders/${order.id}/equipment`, {
          method: "POST",
          token,
          idempotencyKey: key("equip"),
          body: {
            expectedVersion: version(),
            equipmentType: "ONU",
            manufacturer: "Fabricante Ficticio",
            model: "MODELO-X",
            serial: "FICTSERIAL001",
            macAddress: "aa:bb:cc:dd:ee:01",
            labelEvidenceId: (etiquetaCriada.data?.evidence as { id: string }).id,
          },
        }),
        { params: { id: order.id } },
      ),
      "registrar equipamento",
    );
    bundle = await bundleOf();

    // --- 9. relatório ------------------------------------------------------
    //
    // A rota que faltava. Sem ela nada abaixo funciona.
    await expectOk(
      await saveReport(
        fieldRequest(`/api/field/v1/service-orders/${order.id}/execution`, {
          method: "POST",
          token,
          idempotencyKey: key("relatorio"),
          body: {
            expectedVersion: executionVersion,
            diagnosis: "Sinal ausente por conector mal polido na CTO.",
            workPerformed: "Conector refeito, ONU ativada e velocidade aferida.",
            notes: "Cliente orientado sobre o posicionamento do roteador.",
          },
        }),
        { params: { id: order.id } },
      ),
      "salvar relatório",
    );
    bundle = await bundleOf();
    const report = bundle.report as { diagnosis: string | null };
    expect(report.diagnosis).toContain("conector");

    // --- 10. assinatura POR ÚLTIMO -----------------------------------------
    //
    // De propósito: a assinatura sela o conteúdo. Colhê-la antes e mexer depois
    // a tornaria obsoleta, e a conclusão seria recusada — que é exatamente o
    // que a regressão de `SIGNATURE_STALE` prova.
    const signForm = new FormData();
    signForm.set(
      "file",
      new File([new Uint8Array(PNG)], "assinatura.png", { type: "image/png" }),
    );
    signForm.set("expectedOrderVersion", String(version()));
    signForm.set("signerName", "Cliente Ficticio da Jornada");

    await expectOk(
      await putSignature(
        new Request(
          `http://localhost/api/field/v1/service-orders/${order.id}/signature`,
          {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${token}`,
              "Idempotency-Key": key("assinatura"),
            },
            body: signForm,
          },
        ),
        { params: { id: order.id } },
      ),
      "assinar",
    );

    bundle = await bundleOf();
    const signature = bundle.signature as { stale: boolean };
    expect(signature.stale).toBe(false);
    // Tudo resolvido: o servidor não aponta mais nenhuma pendência.
    expect(bundle.pendencies as unknown[]).toEqual([]);

    // --- 11. concluir ------------------------------------------------------
    const executionVersionNow = bundle.executionVersion as number;
    await expectOk(
      await completeOrder(
        fieldRequest(`/api/field/v1/service-orders/${order.id}/complete`, {
          method: "POST",
          token,
          idempotencyKey: key("concluir"),
          body: {
            expectedVersion: version(),
            expectedExecutionVersion: executionVersionNow,
          },
        }),
        { params: { id: order.id } },
      ),
      "concluir",
    );

    // --- o que ficou gravado ----------------------------------------------
    const finalOrder = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(finalOrder.status).toBe("COMPLETED");
    expect(finalOrder.completedAt).not.toBeNull();

    const completion = await prisma.serviceOrderCompletion.findUniqueOrThrow({
      where: { serviceOrderId: order.id },
    });
    const snapshot = completion.snapshot as Record<string, unknown>;
    // Duas: a foto da ONU exigida pela política e a etiqueta que identifica o
    // equipamento (v0.10.1).
    expect((snapshot.evidences as unknown[]).length).toBe(2);
    expect((snapshot.materials as unknown[]).length).toBe(1);
    expect((snapshot.equipments as unknown[]).length).toBe(1);
    expect(snapshot.signature).not.toBeNull();
    expect(snapshot.checkIn).not.toBeNull();

    // O estoque do técnico foi debitado pelo ledger, não por um contador.
    const movements = await prisma.inventoryMovement.findMany({
      where: { serviceOrderId: order.id },
    });
    expect(movements).toHaveLength(1);
    expect(movements[0].type).toBe("TECHNICIAN_TO_CUSTOMER");
    expect(movements[0].quantity.toString()).toBe("35.5");

    // A timeline conta a história inteira, uma vez cada.
    const events = await prisma.serviceOrderEvent.findMany({
      where: { serviceOrderId: order.id },
      select: { event: true },
    });
    const names = events.map((e) => e.event);
    for (const expected of [
      "OS_STARTED",
      "LOCATION_CORRECTED",
      "CHECKED_IN",
      "MATERIAL_USED",
      "EQUIPMENT_INSTALLED",
      "SIGNATURE_CAPTURED",
      "OS_COMPLETED",
    ]) {
      expect(names, `faltou o evento ${expected}`).toContain(expected);
    }
    expect(names.filter((n) => n === "OS_COMPLETED")).toHaveLength(1);

    /*
      Foto NÃO gera evento de timeline, e isso é decisão, não esquecimento.

      São até dez por OS: dez entradas de "foto anexada" afogariam os fatos que
      o despachante procura. Elas ficam no `AuditLog`, e a contagem entra no
      evento de conclusão — a mesma escolha que a v0.4 fez.
    */
    expect(names).not.toContain("EVIDENCE_ADDED");
    const completedEvent = await prisma.serviceOrderEvent.findFirstOrThrow({
      where: { serviceOrderId: order.id, event: "OS_COMPLETED" },
    });
    expect(
      (completedEvent.metadata as Record<string, unknown>).evidenceCount,
    ).toBe(2);
  });

  it("sem o relatório, a conclusão é recusada com o código estável", async () => {
    /*
      O contra-teste da jornada: prova que os campos do relatório são de fato
      obrigatórios, e que a recusa é legível pelo aplicativo. Sem ele, a
      jornada poderia estar passando porque a validação não valida nada.
    */
    const customer = await prisma.customer.create({
      data: { companyId: fixture.companyA.id, name: "Cliente Sem Relatorio" },
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
        description: "Sem relatório.",
        status: "ASSIGNED",
        assignedAt: new Date(),
      },
    });
    const { token } = await registerTestDevice(fixture.techA.id);

    const started = await expectOk(
      await startOrder(
        fieldRequest(`/api/field/v1/service-orders/${order.id}/start`, {
          method: "POST",
          token,
          idempotencyKey: key("start2"),
          body: { expectedVersion: order.version },
        }),
        { params: { id: order.id } },
      ),
      "iniciar",
    );

    const current = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: order.id },
      select: { version: true },
    });

    const response = await completeOrder(
      fieldRequest(`/api/field/v1/service-orders/${order.id}/complete`, {
        method: "POST",
        token,
        idempotencyKey: key("concluir2"),
        body: {
          expectedVersion: current.version,
          expectedExecutionVersion: (
            started.data?.execution as { version: number }
          ).version,
        },
      }),
      { params: { id: order.id } },
    );

    expect(response.status).toBe(400);
    const body = await payload(response);
    const codes = (body.error?.pendencies ?? []).map((p) => p.code);
    expect(codes).toContain("EXECUTION_DIAGNOSIS_REQUIRED");
    expect(codes).toContain("EXECUTION_WORK_REQUIRED");

    const unchanged = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(unchanged.status).toBe("IN_PROGRESS");
  });
});
