import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { DomainError } from "@/lib/errors";
import { LocalFileStorageAdapter, setFileStorage, getFileStorage } from "@/lib/storage";
import {
  addEvidence,
  completeServiceOrder,
  EQUIPMENT_LABEL_TTL_MS,
} from "@/lib/service-order-closing";
import { CompletionBlockedError, putCompletionPolicy } from "@/lib/service-order-completion";
import { addServiceOrderEquipment } from "@/lib/service-order-equipment";
import { purgeExpiredTemporaryEvidence } from "@/lib/field/evidence-cleanup";
import { getFieldExecutionBundle } from "@/lib/field/execution";
import { startServiceOrder, updateServiceOrderExecution } from "@/lib/service-orders";
import {
  allocateTestServiceOrderNumber,
  seedTestData,
  type TestFixture,
} from "./helpers";

/**
 * # Etiqueta do equipamento: estágio, promoção e expurgo
 *
 * A foto da etiqueta é enviada ANTES de o equipamento existir, porque o
 * registro precisa do id dela para apontar. Isso cria duas perguntas que o
 * commit anterior deixou em aberto:
 *
 * 1. a foto vira evidência definitiva da OS mesmo se o cadastro for recusado?
 * 2. a mesma foto pode identificar dois equipamentos?
 *
 * A resposta das duas era "sim". Estes testes prendem o "não".
 *
 * Nada de dado real: cliente, técnico e equipamento são fictícios.
 */

let fixture: TestFixture;
let storageRoot: string;

beforeAll(async () => {
  storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "alfaos-etiqueta-"));
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

async function cenario(options: { companyId?: string } = {}) {
  const companyId = options.companyId ?? fixture.companyA.id;

  /*
    Técnico PRÓPRIO quando a empresa não é a A.

    Reaproveitar `fixture.adminB` seria falso: ele é ADMIN, e o domínio recusa
    antes de chegar ao isolamento de tenant — o teste passaria sem nunca ter
    tocado a coisa que afirma provar.
  */
  const userId =
    companyId === fixture.companyA.id
      ? fixture.techA.id
      : (
          await prisma.user.create({
            data: {
              companyId,
              name: "Tecnico Ficticio da Empresa B",
              email: `tec-b-${Date.now()}-${Math.random()}@exemplo.invalido`,
              passwordHash: "nao-usado",
              profile: "TECHNICIAN",
              active: true,
            },
          })
        ).id;

  const customer = await prisma.customer.create({
    data: {
      companyId,
      name: "Cliente Ficticio da Etiqueta",
      city: "Cidade Teste",
      address: "Rua Ficticia",
    },
  });
  const technician = await prisma.technician.upsert({
    where: { userId },
    update: {},
    create: { companyId, userId },
  });
  const order = await prisma.serviceOrder.create({
    data: {
      companyId,
      number: await allocateTestServiceOrderNumber(companyId),
      customerId: customer.id,
      technicianId: technician.id,
      type: "Instalação",
      typeId: companyId === fixture.companyA.id ? fixture.typeA.id : fixture.typeB.id,
      description: "Instalação de fibra (etiqueta).",
      status: "ASSIGNED",
      assignedAt: new Date(),
    },
  });

  await startServiceOrder(companyId, userId, order.id, order.version);
  return { orderId: order.id, companyId, userId, technicianId: technician.id };
}

async function versionOf(orderId: string) {
  const row = await prisma.serviceOrder.findUniqueOrThrow({
    where: { id: orderId },
    select: { version: true },
  });
  return row.version;
}

/** Anexa uma foto e devolve o id. */
async function anexar(
  ctx: { orderId: string; companyId: string; userId: string },
  category: "EQUIPMENT_LABEL" | "ONU_ONT" | "SPEED_TEST" = "EQUIPMENT_LABEL",
) {
  const evidence = await addEvidence(ctx.companyId, ctx.userId, ctx.orderId, {
    data: PNG,
    declaredMimeType: "image/png",
    originalName: "foto.png",
    expectedOrderVersion: await versionOf(ctx.orderId),
    category,
  });
  return evidence.id;
}

/** Envelhece a etiqueta sem esperar um dia. */
async function vencer(evidenceId: string) {
  await prisma.serviceOrderEvidence.update({
    where: { id: evidenceId },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
}

async function expectDomainError(fn: () => Promise<unknown>, status: number) {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).status).toBe(status);
    return error as DomainError;
  }
  throw new Error(`esperava DomainError ${status}, mas nada foi lançado`);
}

describe("Etiqueta — nasce temporária", () => {
  it("EQUIPMENT_LABEL nasce TEMPORARY e com prazo; as outras não", async () => {
    const ctx = await cenario();
    const etiqueta = await anexar(ctx, "EQUIPMENT_LABEL");
    const comum = await anexar(ctx, "ONU_ONT");

    const linhaEtiqueta = await prisma.serviceOrderEvidence.findUniqueOrThrow({
      where: { id: etiqueta },
      select: { status: true, expiresAt: true },
    });
    expect(linhaEtiqueta.status).toBe("TEMPORARY");
    expect(linhaEtiqueta.expiresAt).not.toBeNull();

    /*
      O prazo é de 24 horas, conferido com folga.

      Uma asserção de igualdade exata competiria com o relógio entre a escrita
      e a leitura; o que importa é que ele seja da ordem de um dia, e não de
      minutos — um prazo curto transformaria uma correção comum em "fotografe
      de novo".
    */
    const restante = linhaEtiqueta.expiresAt!.getTime() - Date.now();
    expect(restante).toBeGreaterThan(EQUIPMENT_LABEL_TTL_MS - 60_000);
    expect(restante).toBeLessThanOrEqual(EQUIPMENT_LABEL_TTL_MS);

    const linhaComum = await prisma.serviceOrderEvidence.findUniqueOrThrow({
      where: { id: comum },
      select: { status: true, expiresAt: true },
    });
    expect(linhaComum.status).toBe("COMMITTED");
    expect(linhaComum.expiresAt).toBeNull();
  });

  it("temporária NÃO aparece no pacote da execução", async () => {
    const ctx = await cenario();
    await anexar(ctx, "EQUIPMENT_LABEL");
    const comum = await anexar(ctx, "ONU_ONT");

    const bundle = await getFieldExecutionBundle(
      ctx.companyId,
      ctx.technicianId,
      ctx.orderId,
    );
    expect(bundle.evidences.map((e) => e.id)).toEqual([comum]);
  });

  it("temporária NÃO satisfaz requisito de evidência da política", async () => {
    const ctx = await cenario();
    await putCompletionPolicy(
      ctx.companyId,
      fixture.adminA.id,
      fixture.typeA.id,
      {
        requireChecklist: false,
        requireSignature: false,
        requireMaterials: false,
        requireEquipment: false,
        requireCheckIn: false,
        minEvidenceCount: 1,
        requiredEvidenceCategories: ["EQUIPMENT_LABEL"],
      },
    );
    const execucao = await updateServiceOrderExecution(
      ctx.companyId,
      ctx.userId,
      ctx.orderId,
      0,
      { diagnosis: "Diagnóstico fictício.", workPerformed: "Serviço fictício." },
    );

    const etiqueta = await anexar(ctx, "EQUIPMENT_LABEL");

    /*
      A foto existe, é da categoria exigida, e ainda assim não conta.

      Sem o estágio, esta OS fecharia: bastaria fotografar uma etiqueta e
      abandonar o cadastro para satisfazer a política com a prova de um
      aparelho que ninguém registrou.
    */
    const versaoAntes = await versionOf(ctx.orderId);
    const erro = await expectDomainError(
      () =>
        completeServiceOrder(ctx.companyId, ctx.userId, ctx.orderId, {
          expectedOrderVersion: versaoAntes,
          expectedExecutionVersion: execucao.version,
        }),
      400,
    );
    expect(erro).toBeInstanceOf(CompletionBlockedError);
    expect(
      (erro as CompletionBlockedError).pendencies.map((p) => p.code),
    ).toContain("EVIDENCE_CATEGORY_MISSING");

    // Promovida pelo registro do equipamento, a MESMA foto passa a contar.
    await addServiceOrderEquipment(ctx.companyId, ctx.userId, ctx.orderId, {
      expectedOrderVersion: await versionOf(ctx.orderId),
      equipmentType: "ONU",
      labelEvidenceId: etiqueta,
    });
    await completeServiceOrder(ctx.companyId, ctx.userId, ctx.orderId, {
      expectedOrderVersion: await versionOf(ctx.orderId),
      expectedExecutionVersion: execucao.version,
    });
    expect(
      (
        await prisma.serviceOrder.findUniqueOrThrow({
          where: { id: ctx.orderId },
          select: { status: true },
        })
      ).status,
    ).toBe("COMPLETED");
  });
});

describe("Etiqueta — promoção", () => {
  it("registro válido promove a foto para definitiva", async () => {
    const ctx = await cenario();
    const etiqueta = await anexar(ctx);

    const equipamento = await addServiceOrderEquipment(
      ctx.companyId,
      ctx.userId,
      ctx.orderId,
      {
        expectedOrderVersion: await versionOf(ctx.orderId),
        equipmentType: "ONU",
        labelEvidenceId: etiqueta,
      },
    );

    const linha = await prisma.serviceOrderEvidence.findUniqueOrThrow({
      where: { id: etiqueta },
      select: { status: true, expiresAt: true },
    });
    expect(linha.status).toBe("COMMITTED");
    // Prazo zerado: promovida, ela não é mais alvo do expurgo.
    expect(linha.expiresAt).toBeNull();
    expect(equipamento.labelEvidenceId).toBe(etiqueta);

    // E agora aparece como evidência da OS.
    const bundle = await getFieldExecutionBundle(
      ctx.companyId,
      ctx.technicianId,
      ctx.orderId,
    );
    expect(bundle.evidences.map((e) => e.id)).toContain(etiqueta);
  });

  it("registro INVÁLIDO não promove, e a foto continua utilizável", async () => {
    const ctx = await cenario();
    const etiqueta = await anexar(ctx);
    const versaoAtual = await versionOf(ctx.orderId);

    // MAC malformado: o servidor recusa antes de qualquer escrita.
    await expectDomainError(
      () =>
        addServiceOrderEquipment(ctx.companyId, ctx.userId, ctx.orderId, {
          expectedOrderVersion: versaoAtual,
          equipmentType: "ONU",
          macAddress: "nao-e-um-mac",
          labelEvidenceId: etiqueta,
        }),
      400,
    );

    expect(
      (
        await prisma.serviceOrderEvidence.findUniqueOrThrow({
          where: { id: etiqueta },
          select: { status: true },
        })
      ).status,
    ).toBe("TEMPORARY");
    expect(
      await prisma.serviceOrderEquipment.count({
        where: { serviceOrderId: ctx.orderId },
      }),
    ).toBe(0);

    /*
      O RETRY reaproveita a MESMA foto.

      É o comportamento que se quer no aparelho: o técnico corrige o MAC e
      toca Registrar de novo, sem fotografar outra vez.
    */
    const equipamento = await addServiceOrderEquipment(
      ctx.companyId,
      ctx.userId,
      ctx.orderId,
      {
        expectedOrderVersion: await versionOf(ctx.orderId),
        equipmentType: "ONU",
        macAddress: "AA:BB:CC:DD:EE:01",
        labelEvidenceId: etiqueta,
      },
    );
    expect(equipamento.labelEvidenceId).toBe(etiqueta);
    expect(
      (
        await prisma.serviceOrderEvidence.findUniqueOrThrow({
          where: { id: etiqueta },
          select: { status: true },
        })
      ).status,
    ).toBe("COMMITTED");
  });

  it("etiqueta vencida não cria equipamento, e o código diz por quê", async () => {
    const ctx = await cenario();
    const etiqueta = await anexar(ctx);
    await vencer(etiqueta);
    const versaoAtual = await versionOf(ctx.orderId);

    const erro = await expectDomainError(
      () =>
        addServiceOrderEquipment(ctx.companyId, ctx.userId, ctx.orderId, {
          expectedOrderVersion: versaoAtual,
          equipmentType: "ONU",
          labelEvidenceId: etiqueta,
        }),
      400,
    );
    // Código PRÓPRIO: a saída não é "corrija o formulário", é "fotografe de
    // novo" — e o aplicativo precisa saber disso sem ler a mensagem.
    expect((erro as { code?: string }).code).toBe("LABEL_EXPIRED");

    expect(
      await prisma.serviceOrderEquipment.count({
        where: { serviceOrderId: ctx.orderId },
      }),
    ).toBe(0);
  });
});

describe("Etiqueta — uma foto, um equipamento", () => {
  it("a mesma foto não identifica dois equipamentos", async () => {
    const ctx = await cenario();
    const etiqueta = await anexar(ctx);

    await addServiceOrderEquipment(ctx.companyId, ctx.userId, ctx.orderId, {
      expectedOrderVersion: await versionOf(ctx.orderId),
      equipmentType: "ONU",
      serial: "FICTPRIMEIRO",
      labelEvidenceId: etiqueta,
    });

    const versaoDepois = await versionOf(ctx.orderId);
    await expectDomainError(
      () =>
        addServiceOrderEquipment(ctx.companyId, ctx.userId, ctx.orderId, {
          expectedOrderVersion: versaoDepois,
          equipmentType: "ROTEADOR",
          serial: "FICTSEGUNDO",
          labelEvidenceId: etiqueta,
        }),
      409,
    );

    expect(
      await prisma.serviceOrderEquipment.count({
        where: { serviceOrderId: ctx.orderId },
      }),
    ).toBe(1);
  });

  it("CORRIDA: duas criações simultâneas com a mesma foto deixam UMA", async () => {
    const ctx = await cenario();
    const etiqueta = await anexar(ctx);
    const versao = await versionOf(ctx.orderId);

    /*
      Corrida REAL, não sequência rápida.

      Quem separa as duas aqui é o compare-and-set da versão da OS, que já
      protege toda mutação-filha desde a v0.10 — medido na prova de reversão:
      sem a unique de etiqueta, a segunda ainda leva 409. Este teste afirma o
      DESFECHO ("uma só"), não qual camada o produziu; a contribuição própria
      da unique está isolada no teste seguinte.
    */
    const resultados = await Promise.allSettled([
      addServiceOrderEquipment(ctx.companyId, ctx.userId, ctx.orderId, {
        expectedOrderVersion: versao,
        equipmentType: "ONU",
        serial: "FICTCORRIDA1",
        labelEvidenceId: etiqueta,
      }),
      addServiceOrderEquipment(ctx.companyId, ctx.userId, ctx.orderId, {
        expectedOrderVersion: versao,
        equipmentType: "ONU",
        serial: "FICTCORRIDA2",
        labelEvidenceId: etiqueta,
      }),
    ]);

    const ok = resultados.filter((r) => r.status === "fulfilled");
    const falhas = resultados.filter((r) => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(falhas).toHaveLength(1);

    // Erro CONTROLADO, não 500 cru.
    const motivo = (falhas[0] as PromiseRejectedResult).reason;
    expect(motivo).toBeInstanceOf(DomainError);
    expect((motivo as DomainError).status).toBe(409);

    // E nada de equipamento parcial.
    expect(
      await prisma.serviceOrderEquipment.count({
        where: { serviceOrderId: ctx.orderId },
      }),
    ).toBe(1);
    expect(
      await prisma.serviceOrderEquipment.count({
        where: { labelEvidenceId: etiqueta },
      }),
    ).toBe(1);
  });

  it("o BANCO recusa o vínculo duplicado, mesmo por escrita direta", async () => {
    const ctx = await cenario();
    const etiqueta = await anexar(ctx);
    const customerId = (
      await prisma.serviceOrder.findUniqueOrThrow({
        where: { id: ctx.orderId },
        select: { customerId: true },
      })
    ).customerId;

    await addServiceOrderEquipment(ctx.companyId, ctx.userId, ctx.orderId, {
      expectedOrderVersion: await versionOf(ctx.orderId),
      equipmentType: "ONU",
      serial: "FICTDIRETO1",
      labelEvidenceId: etiqueta,
    });

    /*
      A camada que nenhum `if` alcança.

      Este `create` não passa pelo domínio, nem pelo compare-and-set da OS, nem
      pela conferência de estado — é a forma de uma ferramenta administrativa
      futura, de uma correção manual ou de um script de migração. Sem a unique
      no banco, ele duplica: verificado por reversão, o índice removido faz
      exatamente esta escrita ser aceita.
    */
    await expect(
      prisma.serviceOrderEquipment.create({
        data: {
          companyId: ctx.companyId,
          serviceOrderId: ctx.orderId,
          customerId,
          equipmentType: "ROTEADOR",
          serial: "FICTDIRETO2",
          labelEvidenceId: etiqueta,
        },
      }),
    ).rejects.toThrow();

    expect(
      await prisma.serviceOrderEquipment.count({
        where: { labelEvidenceId: etiqueta },
      }),
    ).toBe(1);
  });

  it("etiqueta de OUTRA EMPRESA não serve", async () => {
    const alheio = await cenario({ companyId: fixture.companyB.id });
    const etiquetaAlheia = await anexar(alheio);

    const ctx = await cenario();
    const versaoAtual = await versionOf(ctx.orderId);
    await expectDomainError(
      () =>
        addServiceOrderEquipment(ctx.companyId, ctx.userId, ctx.orderId, {
          expectedOrderVersion: versaoAtual,
          equipmentType: "ONU",
          labelEvidenceId: etiquetaAlheia,
        }),
      400,
    );
    expect(
      (
        await prisma.serviceOrderEvidence.findUniqueOrThrow({
          where: { id: etiquetaAlheia },
          select: { status: true },
        })
      ).status,
    ).toBe("TEMPORARY");
  });
});

describe("Etiqueta — expurgo", () => {
  it("remove a temporária vencida e o arquivo dela", async () => {
    const ctx = await cenario();
    const etiqueta = await anexar(ctx);
    const linha = await prisma.serviceOrderEvidence.findUniqueOrThrow({
      where: { id: etiqueta },
      select: { storageKey: true },
    });
    await vencer(etiqueta);

    const resultado = await purgeExpiredTemporaryEvidence();

    expect(resultado.deleted).toBe(1);
    expect(resultado.skipped).toBe(0);
    expect(
      await prisma.serviceOrderEvidence.count({ where: { id: etiqueta } }),
    ).toBe(0);
    // O arquivo saiu junto: expurgo que só apaga a linha deixa disco órfão e
    // invisível para qualquer varredura futura.
    expect(await getFileStorage().exists(linha.storageKey)).toBe(false);
  });

  it("NÃO remove etiqueta vinculada, nem evidência comum", async () => {
    const ctx = await cenario();
    const etiqueta = await anexar(ctx);
    const comum = await anexar(ctx, "ONU_ONT");

    await addServiceOrderEquipment(ctx.companyId, ctx.userId, ctx.orderId, {
      expectedOrderVersion: await versionOf(ctx.orderId),
      equipmentType: "ONU",
      labelEvidenceId: etiqueta,
    });

    /*
      Envelhecer à força uma linha JÁ promovida.

      É o ataque ao expurgo: se ele filtrasse só por `expiresAt`, apagaria a
      prova de identidade de um equipamento instalado. O predicado de status é
      o que impede — e a FK `Restrict` é a segunda tranca.
    */
    await prisma.serviceOrderEvidence.updateMany({
      where: { id: { in: [etiqueta, comum] } },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const resultado = await purgeExpiredTemporaryEvidence();

    expect(resultado.deleted).toBe(0);
    expect(
      await prisma.serviceOrderEvidence.count({
        where: { id: { in: [etiqueta, comum] } },
      }),
    ).toBe(2);
  });

  it("é idempotente: rodar duas vezes não erra nem conta duas vezes", async () => {
    const ctx = await cenario();
    await vencer(await anexar(ctx));

    const primeira = await purgeExpiredTemporaryEvidence();
    const segunda = await purgeExpiredTemporaryEvidence();

    expect(primeira.deleted).toBe(1);
    expect(segunda.found).toBe(0);
    expect(segunda.deleted).toBe(0);
  });

  it("não toca em temporária ainda dentro do prazo", async () => {
    const ctx = await cenario();
    const etiqueta = await anexar(ctx);

    const resultado = await purgeExpiredTemporaryEvidence();

    expect(resultado.found).toBe(0);
    expect(
      await prisma.serviceOrderEvidence.count({ where: { id: etiqueta } }),
    ).toBe(1);
  });
});

describe("Etiqueta — legado", () => {
  it("equipamento anterior à regra continua válido e visível", async () => {
    const ctx = await cenario();

    /*
      Linha escrita DIRETO, como as que existiam antes da v0.10.1.

      A obrigatoriedade vale para registros novos, pelo contrato atual; inventar
      uma foto para o passado afirmaria uma prova que ninguém produziu.
    */
    const legado = await prisma.serviceOrderEquipment.create({
      data: {
        companyId: ctx.companyId,
        serviceOrderId: ctx.orderId,
        customerId: (
          await prisma.serviceOrder.findUniqueOrThrow({
            where: { id: ctx.orderId },
            select: { customerId: true },
          })
        ).customerId,
        equipmentType: "ONU",
        serial: "FICTLEGADO001",
      },
    });

    expect(legado.labelEvidenceId).toBeNull();

    const bundle = await getFieldExecutionBundle(
      ctx.companyId,
      ctx.technicianId,
      ctx.orderId,
    );
    const visto = bundle.equipments.find((e) => e.id === legado.id);
    expect(visto).toBeDefined();
    expect(visto!.labelEvidenceId).toBeNull();

    /*
      E mais de um legado convive.

      A unique é sobre um VALOR repetido; no Postgres várias linhas com NULL
      convivem numa unique, e sem isso a migration teria quebrado toda OS com
      dois equipamentos antigos.
    */
    const outro = await prisma.serviceOrderEquipment.create({
      data: {
        companyId: legado.companyId,
        serviceOrderId: legado.serviceOrderId,
        customerId: legado.customerId,
        equipmentType: "ROTEADOR",
        serial: "FICTLEGADO002",
      },
    });
    expect(outro.labelEvidenceId).toBeNull();
  });
});
