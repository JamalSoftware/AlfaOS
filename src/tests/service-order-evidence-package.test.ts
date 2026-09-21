import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AccessProfile, type EvidenceCategory } from "@prisma/client";
import { POST as startOrder } from "@/app/api/field/v1/service-orders/[id]/start/route";
import {
  GET as executionBundle,
  POST as saveReport,
} from "@/app/api/field/v1/service-orders/[id]/execution/route";
import { POST as correctLocation } from "@/app/api/field/v1/service-orders/[id]/location/correct/route";
import { POST as checkIn } from "@/app/api/field/v1/service-orders/[id]/check-in/route";
import { POST as answerChecklist } from "@/app/api/field/v1/service-orders/[id]/checklist/[itemId]/route";
import { POST as addEvidence } from "@/app/api/field/v1/service-orders/[id]/evidence/route";
import { POST as registerMaterial } from "@/app/api/field/v1/service-orders/[id]/materials/route";
import { POST as addEquipment } from "@/app/api/field/v1/service-orders/[id]/equipment/route";
import { POST as removeEquipment } from "@/app/api/field/v1/service-orders/[id]/equipment/[equipmentId]/route";
import { PUT as putSignature } from "@/app/api/field/v1/service-orders/[id]/signature/route";
import { POST as completeOrder } from "@/app/api/field/v1/service-orders/[id]/complete/route";
import { GET as evidenceContent } from "@/app/api/service-orders/[id]/evidence/[evidenceId]/content/route";
import { GET as signatureContent } from "@/app/api/service-orders/[id]/signature/route";
import { prisma } from "@/lib/prisma";
import { LocalFileStorageAdapter, setFileStorage } from "@/lib/storage";
import { putChecklistTemplate } from "@/lib/checklists";
import { createInventoryItem, receiveStock } from "@/lib/inventory";
import {
  getServiceOrderEvidencePackage,
  loadServiceOrderEvidencePackage,
  type EvidencePackageViewer,
  type ServiceOrderEvidencePackage,
} from "@/lib/service-order-evidence-package";
import {
  allocateTestServiceOrderNumber,
  apiRequest,
  createTokenFor,
  fieldRequest,
  registerTestDevice,
  seedTestData,
  type TestFixture,
} from "./helpers";
import { lerExif, montarJpeg, montarPng } from "./support/jpeg-exif";

/**
 * # EV-1 — o pacote técnico de evidências
 *
 * As OS são atendidas pelas ROTAS REAIS do Field — iniciar, corrigir o ponto,
 * check-in, checklist, fotos, material, equipamento com etiqueta, relatório,
 * assinatura e conclusão. Assim o hash do fechamento, a assinatura vinculada, a
 * limpeza de EXIF e os arquivos gravados são os de produção, e o pacote é
 * conferido contra fatos que ele não fabricou.
 */

let fixture: TestFixture;
let storageRoot: string;
let keySeed = 0;
const PNG = montarPng();

beforeAll(async () => {
  storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "alfaos-ev1-"));
  setFileStorage(new LocalFileStorageAdapter(storageRoot));
});

afterAll(async () => {
  setFileStorage(null);
  await fs.rm(storageRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  fixture = await seedTestData();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function key(step: string) {
  keySeed += 1;
  return `ev1-${step}-${keySeed}-${Date.now()}`;
}

async function ok(response: Response, step: string) {
  const body = (await response.json()) as {
    data?: Record<string, unknown>;
    error?: { code: string; message: string; pendencies?: { code: string }[] };
  };
  if (response.status >= 400) {
    throw new Error(
      `${step} falhou com ${response.status}: ${body.error?.code} — ${body.error?.message}` +
        (body.error?.pendencies ? ` [${body.error.pendencies.map((p) => p.code).join(", ")}]` : ""),
    );
  }
  return body;
}

interface OpcoesJornada {
  techUserId?: string;
  nomeCliente?: string;
  /** Atende um cliente que já existe — para duas OS do MESMO cliente. */
  clienteId?: string;
  checklist?: boolean;
  corrigirPonto?: boolean;
  /** O ponto gravado pela correção em campo. */
  ponto?: { latitude: number; longitude: number };
  fotos?: { category: EvidenceCategory; arquivo?: Buffer; mime?: string; legenda?: string }[];
  equipamento?: boolean;
  equipamentoRemovido?: boolean;
  etiquetaSolta?: boolean;
  material?: boolean;
  concluir?: boolean;
}

interface Jornada {
  orderId: string;
  customerId: string;
  technicianId: string;
  fotos: { id: string; category: EvidenceCategory }[];
  etiquetaId: string | null;
  equipamentoId: string | null;
  removido: { equipamentoId: string; etiquetaId: string } | null;
  etiquetaSoltaId: string | null;
}

async function tecnicoDe(userId: string): Promise<string> {
  const existente = await prisma.technician.findFirst({ where: { userId } });
  if (existente) return existente.id;
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  return (await prisma.technician.create({ data: { companyId: user.companyId, userId } })).id;
}

async function enviarFoto(
  orderId: string,
  token: string,
  versao: number,
  category: EvidenceCategory,
  arquivo: Buffer = PNG,
  mime = "image/png",
  legenda?: string,
) {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(arquivo)], mime === "image/png" ? "f.png" : "f.jpg", { type: mime }));
  form.set("expectedOrderVersion", String(versao));
  form.set("category", category);
  if (legenda) form.set("caption", legenda);
  const res = await ok(
    await addEvidence(
      new Request(`http://localhost/api/field/v1/service-orders/${orderId}/evidence`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Idempotency-Key": key("foto") },
        body: form,
      }),
      { params: Promise.resolve({ id: orderId }) },
    ),
    `foto ${category}`,
  );
  return (res.data?.evidence as { id: string }).id;
}

/** Um atendimento inteiro pelas rotas do Field, com o que o teste pedir. */
async function jornada(opcoes: OpcoesJornada = {}): Promise<Jornada> {
  const companyId = fixture.companyA.id;
  const techUserId = opcoes.techUserId ?? fixture.techA.id;
  const technicianId = await tecnicoDe(techUserId);

  if (opcoes.checklist) {
    await putChecklistTemplate(companyId, fixture.adminA.id, {
      serviceOrderTypeId: fixture.typeA.id,
      name: "Checklist EV-1",
      items: [
        { label: "Cabo testado?", type: "BOOLEAN", required: true },
        { label: "Potência óptica (dBm)", type: "NUMBER", required: false },
        { label: "Observação do rack", type: "TEXT", required: false },
        { label: "Foto da ONU", type: "PHOTO", required: true, evidenceCategory: "ONU_ONT" },
        { label: "Foto do roteador", type: "PHOTO", required: false, evidenceCategory: "ROUTER" },
      ],
    });
  }

  const customer = opcoes.clienteId
    ? await prisma.customer.findUniqueOrThrow({ where: { id: opcoes.clienteId } })
    : await prisma.customer.create({
        data: {
          companyId,
          name: opcoes.nomeCliente ?? "QA EV Cliente",
          document: "123.456.789-09",
          address: "Rua das Fibras",
          number: "100",
          city: "Manaus",
          state: "AM",
        },
      });
  const order = await prisma.serviceOrder.create({
    data: {
      companyId,
      number: await allocateTestServiceOrderNumber(companyId),
      customerId: customer.id,
      technicianId,
      type: "Instalação",
      subtype: "Fibra",
      typeId: fixture.typeA.id,
      description: "Instalação EV-1",
      status: "ASSIGNED",
      assignedAt: new Date(),
    },
  });
  const { token } = await registerTestDevice(techUserId, { installationId: `ev1-${order.id.slice(-10)}` });

  const started = await ok(
    await startOrder(
      fieldRequest(`/api/field/v1/service-orders/${order.id}/start`, {
        method: "POST",
        token,
        idempotencyKey: key("start"),
        body: { expectedVersion: order.version },
      }),
      { params: Promise.resolve({ id: order.id }) },
    ),
    "iniciar",
  );
  const executionVersion = (started.data?.execution as { version: number }).version;

  let bundle: Record<string, unknown> = {};
  const reler = async () => {
    const res = await ok(
      await executionBundle(fieldRequest(`/api/field/v1/service-orders/${order.id}/execution`, { token }), {
        params: Promise.resolve({ id: order.id }),
      }),
      "ler execução",
    );
    bundle = res.data as Record<string, unknown>;
  };
  const versao = () => bundle.version as number;
  await reler();

  if (opcoes.corrigirPonto !== false) {
    // O CAS da localização: `null` só vale para cliente ainda sem ponto.
    const atual = await prisma.customerLocation.findUnique({
      where: { customerId: customer.id },
      select: { version: true },
    });
    await ok(
      await correctLocation(
        fieldRequest(`/api/field/v1/service-orders/${order.id}/location/correct`, {
          method: "POST",
          token,
          idempotencyKey: key("ponto"),
          body: {
            expectedVersion: atual?.version ?? null,
            reason: "INCOMPLETE_REGISTRATION",
            latitude: opcoes.ponto?.latitude ?? -3.119,
            longitude: opcoes.ponto?.longitude ?? -60.0217,
            accuracyMeters: 8,
            source: "TECHNICIAN_GPS",
          },
        }),
        { params: Promise.resolve({ id: order.id }) },
      ),
      "corrigir ponto",
    );
    await reler();
  }

  await ok(
    await checkIn(
      fieldRequest(`/api/field/v1/service-orders/${order.id}/check-in`, {
        method: "POST",
        token,
        idempotencyKey: key("checkin"),
        body: { expectedVersion: versao(), latitude: -3.1191, longitude: -60.0218, accuracyMeters: 12 },
      }),
      { params: Promise.resolve({ id: order.id }) },
    ),
    "check-in",
  );
  await reler();

  if (opcoes.checklist) {
    const itens = bundle.checklist as { id: string; type: string; label: string }[];
    const responder = async (label: string, body: Record<string, unknown>) => {
      const item = itens.find((i) => i.label === label)!;
      await ok(
        await answerChecklist(
          fieldRequest(`/api/field/v1/service-orders/${order.id}/checklist/${item.id}`, {
            method: "POST",
            token,
            idempotencyKey: key("checklist"),
            body: { expectedVersion: versao(), ...body },
          }),
          { params: Promise.resolve({ id: order.id, itemId: item.id }) },
        ),
        `checklist ${label}`,
      );
      await reler();
    };
    await responder("Cabo testado?", { valueBoolean: true });
    await responder("Potência óptica (dBm)", { valueNumber: -18.5 });
    // "Observação do rack" fica sem resposta de propósito.
  }

  const fotos: Jornada["fotos"] = [];
  for (const f of opcoes.fotos ?? []) {
    const id = await enviarFoto(order.id, token, versao(), f.category, f.arquivo, f.mime, f.legenda);
    fotos.push({ id, category: f.category });
    await reler();
  }

  let etiquetaId: string | null = null;
  let equipamentoId: string | null = null;
  const registrar = async (serial: string, mac: string) => {
    const etiqueta = await enviarFoto(order.id, token, versao(), "EQUIPMENT_LABEL");
    await reler();
    const res = await ok(
      await addEquipment(
        fieldRequest(`/api/field/v1/service-orders/${order.id}/equipment`, {
          method: "POST",
          token,
          idempotencyKey: key("equip"),
          body: {
            expectedVersion: versao(),
            equipmentType: "ONU",
            manufacturer: "Fabricante QA",
            model: "MODELO-EV",
            serial,
            macAddress: mac,
            labelEvidenceId: etiqueta,
          },
        }),
        { params: Promise.resolve({ id: order.id }) },
      ),
      "equipamento",
    );
    await reler();
    return { etiqueta, equipamento: (res.data?.equipment as { id: string }).id };
  };

  let removido: Jornada["removido"] = null;
  if (opcoes.equipamentoRemovido) {
    const errado = await registrar(`ERRADO${keySeed}`, `aa:bb:cc:00:00:${String(keySeed % 90 + 10)}`);
    await ok(
      await removeEquipment(
        fieldRequest(`/api/field/v1/service-orders/${order.id}/equipment/${errado.equipamento}`, {
          method: "POST",
          token,
          idempotencyKey: key("remover"),
          body: { expectedVersion: versao() },
        }),
        { params: Promise.resolve({ id: order.id, equipmentId: errado.equipamento }) },
      ),
      "remover equipamento",
    );
    await reler();
    removido = { equipamentoId: errado.equipamento, etiquetaId: errado.etiqueta };
  }

  if (opcoes.equipamento !== false) {
    const certo = await registrar(`SERIE${keySeed}${Date.now() % 100000}`, `aa:bb:cc:dd:ee:${String(keySeed % 90 + 10)}`);
    etiquetaId = certo.etiqueta;
    equipamentoId = certo.equipamento;
  }

  let etiquetaSoltaId: string | null = null;
  if (opcoes.etiquetaSolta) {
    etiquetaSoltaId = await enviarFoto(order.id, token, versao(), "EQUIPMENT_LABEL");
    await reler();
  }

  if (opcoes.material) {
    const item = await createInventoryItem(companyId, fixture.adminA.id, {
      code: `CABO-${keySeed}`,
      name: "Cabo drop óptico",
      unit: "METER",
    });
    await receiveStock(companyId, fixture.adminA.id, { itemId: item.id, technicianId, quantity: 100 });
    await ok(
      await registerMaterial(
        fieldRequest(`/api/field/v1/service-orders/${order.id}/materials`, {
          method: "POST",
          token,
          idempotencyKey: key("material"),
          body: { expectedVersion: versao(), itemId: item.id, quantity: 35.5 },
        }),
        { params: Promise.resolve({ id: order.id }) },
      ),
      "material",
    );
    await reler();
  }

  await ok(
    await saveReport(
      fieldRequest(`/api/field/v1/service-orders/${order.id}/execution`, {
        method: "POST",
        token,
        idempotencyKey: key("relatorio"),
        body: {
          expectedVersion: executionVersion,
          diagnosis: "Sinal ausente por conector mal polido na CTO.",
          workPerformed: "Conector refeito, ONU ativada e velocidade aferida.",
          notes: "Cliente orientado sobre o roteador.\nSegunda linha.",
        },
      }),
      { params: Promise.resolve({ id: order.id }) },
    ),
    "relatório",
  );
  await reler();

  const assinatura = new FormData();
  assinatura.set("file", new File([new Uint8Array(PNG)], "assinatura.png", { type: "image/png" }));
  assinatura.set("expectedOrderVersion", String(versao()));
  assinatura.set("signerName", "Maria QA EV");
  await ok(
    await putSignature(
      new Request(`http://localhost/api/field/v1/service-orders/${order.id}/signature`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Idempotency-Key": key("assinatura") },
        body: assinatura,
      }),
      { params: Promise.resolve({ id: order.id }) },
    ),
    "assinatura",
  );
  await reler();

  if (opcoes.concluir !== false) {
    await ok(
      await completeOrder(
        fieldRequest(`/api/field/v1/service-orders/${order.id}/complete`, {
          method: "POST",
          token,
          idempotencyKey: key("concluir"),
          body: { expectedVersion: versao(), expectedExecutionVersion: bundle.executionVersion as number },
        }),
        { params: Promise.resolve({ id: order.id }) },
      ),
      "concluir",
    );
  }

  return {
    orderId: order.id,
    customerId: customer.id,
    technicianId,
    fotos,
    etiquetaId,
    equipamentoId,
    removido,
    etiquetaSoltaId,
  };
}

const comoAdmin = (): EvidencePackageViewer => ({
  companyId: fixture.companyA.id,
  userId: fixture.adminA.id,
  profile: AccessProfile.ADMIN,
});
const comoDespacho = (): EvidencePackageViewer => ({
  companyId: fixture.companyA.id,
  userId: fixture.dispatcherA.id,
  profile: AccessProfile.DISPATCHER,
});
const comoTecnico = (userId: string): EvidencePackageViewer => ({
  companyId: fixture.companyA.id,
  userId,
  profile: AccessProfile.TECHNICIAN,
});

async function pacote(orderId: string, viewer = comoAdmin()): Promise<ServiceOrderEvidencePackage> {
  const r = await getServiceOrderEvidencePackage(viewer, orderId);
  if (r.state !== "ok") throw new Error(`esperava pacote, veio ${r.state}`);
  return r.data;
}

/** Todo id de foto que o pacote mostra, em qualquer seção. */
function idsDeFoto(p: ServiceOrderEvidencePackage): string[] {
  return [
    ...p.photos.map((f) => f.id),
    ...p.measurements.speedTests.map((f) => f.id),
    ...p.measurements.opticalReadings.map((f) => f.id),
    ...p.equipments.flatMap((q) => (q.label ? [q.label.id] : [])),
  ];
}

const FOTOS_PADRAO: OpcoesJornada["fotos"] = [
  { category: "ONU_ONT", legenda: "ONU no rack" },
  { category: "CTO" },
  { category: "SPEED_TEST" },
  { category: "OPTICAL_READING" },
  { category: "CTO" },
];

// ---------------------------------------------------------------------------

describe("EV-DOM — o que entra, o que não entra", () => {
  it("EV-DOM-01 — toda evidência confirmada aparece, e nenhuma categoria presente é omitida", async () => {
    const j = await jornada({ fotos: FOTOS_PADRAO });
    const p = await pacote(j.orderId);

    const confirmadas = await prisma.serviceOrderEvidence.findMany({
      where: { serviceOrderId: j.orderId, status: "COMMITTED" },
      select: { id: true, category: true },
    });
    expect(idsDeFoto(p).sort()).toEqual(confirmadas.map((e) => e.id).sort());
    const categoriasNoPacote = new Set([
      ...p.photos.map((f) => f.category),
      ...p.measurements.speedTests.map((f) => f.category),
      ...p.measurements.opticalReadings.map((f) => f.category),
      ...p.equipments.flatMap((q) => (q.label ? [q.label.category] : [])),
    ]);
    expect(Array.from(categoriasNoPacote).sort()).toEqual(
      Array.from(new Set(confirmadas.map((e) => e.category))).sort(),
    );
  });

  it("EV-DOM-02 — foto temporária não entra: nem a etiqueta solta, nem a do equipamento removido", async () => {
    const j = await jornada({ fotos: [{ category: "CTO" }], etiquetaSolta: true, equipamentoRemovido: true });
    const temporarias = await prisma.serviceOrderEvidence.findMany({
      where: { serviceOrderId: j.orderId, status: "TEMPORARY" },
      select: { id: true },
    });
    // Controle: as duas existem, e são temporárias.
    expect(temporarias.map((t) => t.id).sort()).toEqual([j.etiquetaSoltaId!, j.removido!.etiquetaId].sort());

    const p = await pacote(j.orderId);
    const texto = JSON.stringify(p);
    for (const t of temporarias) expect(texto).not.toContain(t.id);
  });

  it("EV-DOM-03 — tenant: a empresa B não lê o pacote da OS de A, nem com o id certo", async () => {
    const j = await jornada({ fotos: [{ category: "CTO" }] });
    // Controle positivo.
    expect((await getServiceOrderEvidencePackage(comoAdmin(), j.orderId)).state).toBe("ok");

    const deB = await getServiceOrderEvidencePackage(
      { companyId: fixture.companyB.id, userId: fixture.adminB.id, profile: AccessProfile.ADMIN },
      j.orderId,
    );
    expect(deB).toEqual({ state: "not-found" });
  });

  it("EV-DOM-03b — linha filha com a empresa errada não entra, mesmo apontando para a OS certa", async () => {
    const j = await jornada({ fotos: [{ category: "CTO" }] });
    // O banco aceita: `serviceOrderId` é FK simples, sem `(companyId, serviceOrderId)` —
    // o mesmo vetor da DQ-7.1. Nenhum escritor grava isso; o filtro de empresa é o
    // que impede uma linha corrompida de virar evidência de outro tenant.
    const intrusa = await prisma.serviceOrderEvidence.create({
      data: {
        companyId: fixture.companyB.id,
        serviceOrderId: j.orderId,
        category: "ROUTER",
        status: "COMMITTED",
        storageKey: `qa-ev1/${fixture.companyB.id}/${j.orderId}/intrusa.png`,
        originalName: "intrusa.png",
        mimeType: "image/png",
        sizeBytes: 10,
      },
    });

    const p = await pacote(j.orderId);
    expect(JSON.stringify(p)).not.toContain(intrusa.id);
    expect(p.photos.map((f) => f.category)).toEqual(["CTO"]);
    // O hash do fechamento também filtra a empresa: a linha não o altera.
    expect(p.integrity).toBe("VERIFIED");
  });

  it("EV-DOM-04 — outra OS e outro cliente não vazam para o pacote", async () => {
    const um = await jornada({ fotos: [{ category: "CTO" }], nomeCliente: "QA EV Um" });
    const dois = await jornada({ fotos: [{ category: "ROUTER" }], nomeCliente: "QA EV Dois" });

    const p = await pacote(um.orderId);
    const texto = JSON.stringify(p);
    for (const f of dois.fotos) expect(texto).not.toContain(f.id);
    expect(texto).not.toContain(dois.equipamentoId!);
    expect(texto).not.toContain("QA EV Dois");
    expect(p.customer.name).toBe("QA EV Um");
    // A mudança de ponto listada é a desta OS: uma, a do cliente dela.
    expect(p.locationChanges).toHaveLength(1);
  });

  it("EV-DOM-05 — equipamento removido no atendimento não aparece; o registrado, sim", async () => {
    const j = await jornada({ equipamentoRemovido: true });
    const p = await pacote(j.orderId);
    expect(p.equipments.map((q) => q.id)).toEqual([j.equipamentoId]);
    expect(JSON.stringify(p)).not.toContain(j.removido!.equipamentoId);
    expect(p.equipments[0]).toMatchObject({
      equipmentType: "ONU",
      manufacturer: "Fabricante QA",
      model: "MODELO-EV",
      installedByName: "Tecnico Alfa",
      label: { id: j.etiquetaId, category: "EQUIPMENT_LABEL" },
    });
  });

  it("EV-DOM-06 — os instantes são os do servidor, cada um da sua fonte", async () => {
    const j = await jornada({ fotos: [{ category: "CTO" }, { category: "SPEED_TEST" }] });
    const p = await pacote(j.orderId);

    const evidencias = await prisma.serviceOrderEvidence.findMany({ where: { serviceOrderId: j.orderId } });
    for (const foto of [...p.photos, ...p.measurements.speedTests]) {
      const linha = evidencias.find((e) => e.id === foto.id)!;
      expect(foto.recordedAt.getTime()).toBe(linha.createdAt.getTime());
    }
    const ordem = await prisma.serviceOrder.findUniqueOrThrow({ where: { id: j.orderId } });
    const chk = await prisma.serviceOrderCheckIn.findUniqueOrThrow({ where: { serviceOrderId: j.orderId } });
    const ass = await prisma.serviceOrderSignature.findUniqueOrThrow({ where: { serviceOrderId: j.orderId } });
    const eq = await prisma.serviceOrderEquipment.findUniqueOrThrow({ where: { id: j.equipamentoId! } });
    expect(p.order.completedAt?.getTime()).toBe(ordem.completedAt!.getTime());
    expect(p.order.startedAt?.getTime()).toBe(ordem.startedAt!.getTime());
    expect(p.checkIn?.checkedInAt.getTime()).toBe(chk.checkedInAt.getTime());
    expect(p.signature?.signedAt.getTime()).toBe(ass.signedAt.getTime());
    expect(p.equipments[0].installedAt.getTime()).toBe(eq.createdAt.getTime());
  });

  it("EV-DOM-07 — perfis: ADMIN, DISPATCHER e o técnico dono leem; outro técnico não", async () => {
    const j = await jornada({ fotos: [{ category: "CTO" }] });
    expect((await getServiceOrderEvidencePackage(comoAdmin(), j.orderId)).state).toBe("ok");
    expect((await getServiceOrderEvidencePackage(comoDespacho(), j.orderId)).state).toBe("ok");
    expect((await getServiceOrderEvidencePackage(comoTecnico(fixture.techA.id), j.orderId)).state).toBe("ok");

    await tecnicoDe(fixture.techB.id);
    expect(await getServiceOrderEvidencePackage(comoTecnico(fixture.techB.id), j.orderId)).toEqual({
      state: "not-found",
    });
    // Usuário técnico sem registro de técnico também não.
    const semRegistro = await prisma.user.create({
      data: {
        companyId: fixture.companyA.id,
        name: "Sem registro",
        email: `sem.registro.${Date.now()}@sintetico.local`,
        profile: "TECHNICIAN",
        passwordHash: "x",
      },
    });
    expect(await getServiceOrderEvidencePackage(comoTecnico(semRegistro.id), j.orderId)).toEqual({
      state: "not-found",
    });
  });

  it("EV-DOM-08 — nada duplica: etiqueta só no equipamento, medição só em Medições", async () => {
    const j = await jornada({ fotos: FOTOS_PADRAO });
    const p = await pacote(j.orderId);
    const ids = idsDeFoto(p);
    expect(new Set(ids).size).toBe(ids.length);
    expect(p.photos.map((f) => f.category)).not.toContain("EQUIPMENT_LABEL");
    expect(p.photos.map((f) => f.category)).not.toContain("SPEED_TEST");
    expect(p.photos.map((f) => f.category)).not.toContain("OPTICAL_READING");
    expect(p.measurements.speedTests).toHaveLength(1);
    expect(p.measurements.opticalReadings).toHaveLength(1);
  });
});

describe("EV-INT — conferência contra o fechamento", () => {
  it("EV-INT-01 — OS fechada pelo fluxo real: conteúdo conferido e assinatura vinculada", async () => {
    const j = await jornada({ fotos: [{ category: "CTO" }], material: true, checklist: true });
    const p = await pacote(j.orderId);
    expect(p.integrity).toBe("VERIFIED");
    expect(p.signatureBinding).toBe("BOUND");
  });

  it("EV-INT-02 — conteúdo alterado depois do fechamento é DIVERGENT; a assinatura continua presa ao fechado", async () => {
    const j = await jornada({ fotos: [{ category: "CTO" }] });
    await prisma.serviceOrderExecution.updateMany({
      where: { serviceOrderId: j.orderId },
      data: { notes: "texto trocado depois do fechamento" },
    });
    const p = await pacote(j.orderId);
    expect(p.integrity).toBe("DIVERGENT");
    expect(p.signatureBinding).toBe("BOUND");
  });

  it("EV-INT-03 — sem registro de fechamento (anterior à v0.10) é NO_RECORD, e a assinatura legada é LEGACY", async () => {
    const j = await jornada({ fotos: [{ category: "CTO" }] });
    await prisma.serviceOrderCompletion.deleteMany({ where: { serviceOrderId: j.orderId } });
    await prisma.serviceOrderSignature.updateMany({
      where: { serviceOrderId: j.orderId },
      data: { signedContentHash: null },
    });
    const p = await pacote(j.orderId);
    expect(p.integrity).toBe("NO_RECORD");
    expect(p.signatureBinding).toBe("LEGACY");
  });

  it("EV-INT-04 — assinatura presa a outro conteúdo é DIVERGENT", async () => {
    const j = await jornada({ fotos: [{ category: "CTO" }] });
    await prisma.serviceOrderSignature.updateMany({
      where: { serviceOrderId: j.orderId },
      data: { signedContentHash: "0".repeat(64) },
    });
    const p = await pacote(j.orderId);
    expect(p.integrity).toBe("VERIFIED");
    expect(p.signatureBinding).toBe("DIVERGENT");
  });

  it("EV-INT-05 — OS em atendimento não tem pacote: nada parcial é devolvido", async () => {
    const j = await jornada({ fotos: [{ category: "CTO" }], concluir: false });
    const r = await getServiceOrderEvidencePackage(comoAdmin(), j.orderId);
    expect(r.state).toBe("not-completed");
    expect(JSON.stringify(r)).not.toContain(j.fotos[0].id);
  });
});

describe("EV-CONT — conteúdo de cada seção", () => {
  it("EV-CONT-01 — checklist: sim/não, número, sem resposta e foto pela categoria confirmada", async () => {
    const j = await jornada({ checklist: true, fotos: [{ category: "ONU_ONT" }] });
    const p = await pacote(j.orderId);
    const por = (label: string) => p.checklist.find((i) => i.label === label)!;
    expect(por("Cabo testado?")).toMatchObject({ required: true, answer: { kind: "boolean", value: true } });
    expect(por("Potência óptica (dBm)").answer).toEqual({ kind: "number", value: "-18.5" });
    expect(por("Observação do rack").answer).toEqual({ kind: "unanswered" });
    expect(por("Foto da ONU").answer).toEqual({ kind: "photo", category: "ONU_ONT", attached: true });
    expect(por("Foto do roteador").answer).toEqual({ kind: "photo", category: "ROUTER", attached: false });
    expect(p.checklist.map((i) => i.label)).toEqual([
      "Cabo testado?",
      "Potência óptica (dBm)",
      "Observação do rack",
      "Foto da ONU",
      "Foto do roteador",
    ]);
  });

  it("EV-CONT-02 — localização: check-in com GPS e distância, e a correção feita nesta OS", async () => {
    const j = await jornada({});
    const p = await pacote(j.orderId);
    expect(p.checkIn).toMatchObject({ withDeviceLocation: true, accuracyMeters: 12, technicianName: "Tecnico Alfa" });
    expect(p.checkIn?.distanceMeters).toEqual(expect.any(Number));
    expect(p.locationChanges).toEqual([
      expect.objectContaining({ kind: "LOCATION_CORRECTED", reason: "INCOMPLETE_REGISTRATION", actorName: "Tecnico Alfa" }),
    ]);
  });

  it("EV-CONT-02b — a mudança de ponto de OUTRA OS do mesmo cliente não entra", async () => {
    const um = await jornada({});
    const dois = await jornada({ clienteId: um.customerId, ponto: { latitude: -3.1201, longitude: -60.0229 } });
    // Controle: o cliente tem as duas mudanças, uma por OS, pelo escritor real.
    const linhas = await prisma.customerLocationHistory.findMany({
      where: { customerId: um.customerId },
      select: { id: true, serviceOrderId: true },
    });
    expect(linhas.map((l) => l.serviceOrderId).sort()).toEqual([um.orderId, dois.orderId].sort());
    const daOs = (orderId: string) => linhas.filter((l) => l.serviceOrderId === orderId).map((l) => l.id);

    expect((await pacote(um.orderId)).locationChanges.map((c) => c.id)).toEqual(daOs(um.orderId));
    expect((await pacote(dois.orderId)).locationChanges.map((c) => c.id)).toEqual(daOs(dois.orderId));
  });

  it("EV-CONT-03 — relatório, materiais, assinatura e cabeçalho vêm das fontes", async () => {
    const j = await jornada({ material: true });
    const p = await pacote(j.orderId);
    expect(p.execution).toEqual({
      diagnosis: "Sinal ausente por conector mal polido na CTO.",
      workPerformed: "Conector refeito, ONU ativada e velocidade aferida.",
      notes: "Cliente orientado sobre o roteador.\nSegunda linha.",
    });
    const material = await prisma.serviceOrderMaterialUsage.findFirstOrThrow({ where: { serviceOrderId: j.orderId } });
    expect(p.materials).toEqual([
      { id: material.id, description: material.description, quantity: "35.5", unit: "METER" },
    ]);
    expect(material.description).toContain("Cabo drop óptico");
    expect(p.signature).toMatchObject({ signerName: "Maria QA EV", capturedByName: "Tecnico Alfa" });
    expect(p.customer).toEqual({ name: "QA EV Cliente", address: "Rua das Fibras, 100 · Manaus/AM" });
    expect(p.technicianName).toBe("Tecnico Alfa");
    expect(p.order).toMatchObject({ type: "Instalação", subtype: "Fibra", status: "COMPLETED" });
  });

  it("EV-CONT-04 — privacidade: nenhuma chave de arquivo, hash, coordenada ou documento sai no DTO", async () => {
    const j = await jornada({ fotos: FOTOS_PADRAO, material: true });
    const p = await pacote(j.orderId);
    const texto = JSON.stringify(p);

    const chaves = [
      ...(await prisma.serviceOrderEvidence.findMany({ where: { serviceOrderId: j.orderId } })).map((e) => e.storageKey),
      (await prisma.serviceOrderSignature.findUniqueOrThrow({ where: { serviceOrderId: j.orderId } })).storageKey,
    ];
    for (const k of chaves) expect(texto).not.toContain(k);
    const fechamento = await prisma.serviceOrderCompletion.findUniqueOrThrow({ where: { serviceOrderId: j.orderId } });
    expect(texto).not.toContain(fechamento.contentHash);
    expect(texto).not.toMatch(/-3\.11|-60\.02|latitude|longitude/);
    expect(texto).not.toContain("123.456.789-09");
    expect(texto).not.toMatch(/storageKey|contentHash|signedContentHash/);
  });

  it("EV-CONT-05 — o fuso do pacote é o da EMPRESA, não o padrão", async () => {
    // A fixture nasce no fuso padrão; com ele, "fuso da empresa" e "fuso padrão"
    // dariam o mesmo texto e nada se provaria.
    await prisma.company.update({ where: { id: fixture.companyA.id }, data: { timezone: "Asia/Tokyo" } });
    const j = await jornada({});
    expect((await pacote(j.orderId)).timezone).toBe("Asia/Tokyo");
  });
});

describe("EV-FILE — as imagens do pacote pelas rotas autorizadas", () => {
  async function get(url: string, token?: string) {
    const m = /\/api\/service-orders\/([^/]+)\/(?:evidence\/([^/]+)\/content|signature)$/.exec(url)!;
    const [, orderId, evidenceId] = m;
    return evidenceId
      ? evidenceContent(apiRequest(url, {}, token), { params: Promise.resolve({ id: orderId, evidenceId }) })
      : signatureContent(apiRequest(url, {}, token), { params: Promise.resolve({ id: orderId }) });
  }

  it("EV-FILE-01 — empresa certa lê; outra empresa e outro técnico recebem 404; sem sessão, 401", async () => {
    const j = await jornada({ fotos: [{ category: "CTO" }] });
    const p = await pacote(j.orderId);
    const urls = [p.photos[0].url, p.equipments[0].label!.url, p.signature!.url];

    const admin = await createTokenFor(fixture.adminA.id);
    const dono = await createTokenFor(fixture.techA.id);
    await tecnicoDe(fixture.techB.id);
    const outroTecnico = await createTokenFor(fixture.techB.id);
    const adminB = await createTokenFor(fixture.adminB.id);

    for (const url of urls) {
      expect((await get(url, admin)).status, url).toBe(200);
      expect((await get(url, dono)).status, url).toBe(200);
      expect((await get(url, outroTecnico)).status, url).toBe(404);
      expect((await get(url, adminB)).status, url).toBe(404);
      expect((await get(url)).status, url).toBe(401);
    }
  });

  it("EV-FILE-02 — a foto servida pelo pacote continua sem EXIF de GPS (PC-1)", async () => {
    const comGps = montarJpeg();
    expect(lerExif(comGps).tagsGps.length).toBeGreaterThan(0); // pré-condição
    const j = await jornada({ fotos: [{ category: "SPEED_TEST", arquivo: comGps, mime: "image/jpeg" }] });
    const p = await pacote(j.orderId);
    const res = await get(p.measurements.speedTests[0].url, await createTokenFor(fixture.adminA.id));
    expect(res.status).toBe(200);
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(lerExif(bytes).tagsGps).toEqual([]);
  });
});

describe("EV-ERR / EV-PERF", () => {
  it("EV-ERR-01 — uma leitura que falha vira `error`, nunca pacote vazio, e o log não leva a mensagem", async () => {
    const j = await jornada({ fotos: [{ category: "CTO" }] });
    vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(new Error("relation secreta_ev1 does not exist"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await loadServiceOrderEvidencePackage(comoAdmin(), j.orderId);
    expect(r).toEqual({ state: "error" });
    const nossos = log.mock.calls.filter((c) => String(c[0]).startsWith("[evidence-package]"));
    expect(nossos).toHaveLength(1);
    expect(JSON.stringify(nossos)).not.toContain("secreta_ev1");
  });

  it("EV-PERF-01 — uma transação, e o mesmo número de consultas para 2 fotos e para 8", async () => {
    const contar = () => {
      let n = 0;
      const original = prisma.$transaction.bind(prisma) as (...args: unknown[]) => Promise<unknown>;
      const espiao = vi.spyOn(prisma, "$transaction").mockImplementation(((arg: unknown, opts: unknown) => {
        if (typeof arg !== "function") return original(arg, opts);
        return original(
          (tx: Record<string, unknown>) =>
            (arg as (t: unknown) => unknown)(
              new Proxy(tx, {
                get(alvo, prop) {
                  const delegado = alvo[prop as string];
                  if (!delegado || typeof delegado !== "object") return delegado;
                  return new Proxy(delegado as Record<string, unknown>, {
                    get(d, metodo) {
                      const f = d[metodo as string];
                      if (typeof f !== "function") return f;
                      return (...a: unknown[]) => {
                        n += 1;
                        return (f as (...x: unknown[]) => unknown).apply(d, a);
                      };
                    },
                  });
                },
              }),
            ),
          opts,
        );
      }) as never);
      return { total: () => n, transacoes: () => espiao.mock.calls.length };
    };

    const pequeno = await jornada({ fotos: [{ category: "CTO" }] });
    let medida = contar();
    await pacote(pequeno.orderId);
    const comUma = { consultas: medida.total(), transacoes: medida.transacoes() };
    vi.restoreAllMocks();

    const grande = await jornada({
      fotos: [
        { category: "CTO" },
        { category: "CTO" },
        { category: "ROUTER" },
        { category: "ONU_ONT" },
        { category: "SPEED_TEST" },
        { category: "OPTICAL_READING" },
        { category: "CABLE_ROUTE" },
      ],
      material: true,
      checklist: true,
    });
    medida = contar();
    const p = await pacote(grande.orderId);
    const comNove = { consultas: medida.total(), transacoes: medida.transacoes() };

    expect(idsDeFoto(p)).toHaveLength(8); // 7 fotos + etiqueta (o pequeno: 1 + etiqueta)
    expect(comNove).toEqual(comUma);
    expect(comUma.transacoes).toBe(1);
    expect(comUma.consultas).toBeLessThanOrEqual(16);
  });

  it("EV-PERF-02 — toda lista que o pacote lê tem teto, e a leitura é um instante só", async () => {
    // O teto de fotos (100) fica acima do limite de 10 imagens por OS do fechamento:
    // nenhum escritor real o alcança, então nenhum teste de RESULTADO o veria cair.
    // A afirmação é sobre os argumentos da consulta, como na TL-1.
    const j = await jornada({ fotos: [{ category: "CTO" }], material: true, checklist: true });
    const listas: { fonte: string; take: unknown }[] = [];
    const original = prisma.$transaction.bind(prisma) as (...args: unknown[]) => Promise<unknown>;
    const espiao = vi.spyOn(prisma, "$transaction").mockImplementation(((arg: unknown, opts: unknown) => {
      if (typeof arg !== "function") return original(arg, opts);
      return original(
        (tx: Record<string, unknown>) =>
          (arg as (t: unknown) => unknown)(
            new Proxy(tx, {
              get(alvo, fonte) {
                const delegado = alvo[fonte as string];
                if (!delegado || typeof delegado !== "object") return delegado;
                return new Proxy(delegado as Record<string, unknown>, {
                  get(d, metodo) {
                    const f = d[metodo as string];
                    if (typeof f !== "function" || metodo !== "findMany") return f;
                    return (...a: unknown[]) => {
                      // O hash do fechamento lê TUDO de propósito — teto ali mudaria o
                      // hash. O teto é do que o PACOTE lista: conta só quando ele chama.
                      const chamador =
                        (new Error().stack ?? "").split("\n").find((l) => /src[\\/]lib[\\/]/.test(l)) ?? "";
                      if (chamador.includes("service-order-evidence-package")) {
                        listas.push({ fonte: String(fonte), take: (a[0] as { take?: unknown } | undefined)?.take });
                      }
                      return (f as (...x: unknown[]) => unknown).apply(d, a);
                    };
                  },
                });
              },
            }),
          ),
        opts,
      );
    }) as never);

    await pacote(j.orderId);
    // Controle positivo: as cinco listas do pacote foram vistas.
    expect(listas.map((l) => l.fonte).sort()).toEqual([
      "customerLocationHistory",
      "serviceOrderChecklistItem",
      "serviceOrderEquipment",
      "serviceOrderEvidence",
      "serviceOrderMaterialUsage",
    ]);
    for (const l of listas) expect(l.take, l.fonte).toEqual(expect.any(Number));
    expect(espiao).toHaveBeenCalledTimes(1);
    expect((espiao.mock.calls[0][1] as { isolationLevel?: string } | undefined)?.isolationLevel).toBe(
      "RepeatableRead",
    );
  });
});
