import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  putCompletionPolicy,
  validateServiceOrderCompletion,
} from "@/lib/service-order-completion";
import { seedTestData, type TestFixture } from "./helpers";

/**
 * # Exigir o equipamento instalado (decisão do dono, 20/09/2026)
 *
 * O dono fechou uma OS de Instalação em aparelho real e viu "Equipamentos
 * instalados / Nenhum equipamento registrado" sem nenhum aviso — e a OS
 * fechou. A investigação provou que **a tela estava certa**: a política do
 * tipo tinha `requireEquipment = false`, e o aplicativo não tinha o que
 * avisar. O que faltava era decisão de negócio, não código.
 *
 * A decisão: uma instalação não está operacionalmente concluída enquanto o
 * equipamento do cliente não estiver registrado.
 *
 * ## Por que estes casos NÃO olham para a Alfa Telecom
 *
 * O nome da empresa e o nome do tipo são dado digitado no catálogo dela. Um
 * teste que os afirmasse quebraria quando alguém renomeasse "Instalação" —
 * sem defeito nenhum no produto — e passaria a falar do banco de
 * desenvolvimento em vez de falar do produto.
 *
 * O que se afirma é a RECEITA, que é o que pode dar errado: a política é
 * SUBSTITUÍDA por inteiro (`putCompletionPolicy` não aplica patch), então
 * ligar um campo sem reenviar os outros os apaga em silêncio.
 */

let fixture: TestFixture;

beforeEach(async () => {
  fixture = await seedTestData();
});

/** A política que a §382 deixou: checklist exigido, e nada mais. */
async function politicaDaCobertura(typeId: string) {
  await putCompletionPolicy(fixture.companyA.id, fixture.adminA.id, typeId, {
    requireChecklist: true,
    requireSignature: false,
    requireMaterials: false,
    requireEquipment: false,
    requireCheckIn: false,
    minEvidenceCount: 0,
    requiredEvidenceCategories: [],
  });
}

/**
 * A receita da configuração, escrita uma vez.
 *
 * Lê o que está gravado, muda UM campo e reenvia o resto. É exatamente o que
 * a tela `/tipos-os` faz ao ligar um interruptor.
 */
async function exigirEquipamento(typeId: string) {
  const atual = await prisma.serviceOrderCompletionPolicy.findUnique({
    where: { serviceOrderTypeId: typeId },
  });
  await putCompletionPolicy(fixture.companyA.id, fixture.adminA.id, typeId, {
    requireEquipment: true,
    requireChecklist: atual?.requireChecklist ?? false,
    requireSignature: atual?.requireSignature ?? false,
    requireMaterials: atual?.requireMaterials ?? false,
    requireCheckIn: atual?.requireCheckIn ?? false,
    minEvidenceCount: atual?.minEvidenceCount ?? 0,
    requiredEvidenceCategories: atual?.requiredEvidenceCategories ?? [],
  });
}

describe("EQPOL — exigir equipamento sem apagar o resto da política", () => {
  it("EQPOL-01 · liga requireEquipment e PRESERVA todo o resto", async () => {
    // Uma política com TODOS os campos distintos do padrão: se a receita
    // esquecer algum, o campo esquecido volta a `false`/vazio e o caso cai
    // apontando qual.
    await putCompletionPolicy(
      fixture.companyA.id,
      fixture.adminA.id,
      fixture.typeA.id,
      {
        requireChecklist: true,
        requireSignature: true,
        requireMaterials: true,
        requireEquipment: false,
        requireCheckIn: true,
        minEvidenceCount: 2,
        requiredEvidenceCategories: ["ONU_ONT", "OPTICAL_READING"],
      },
    );

    await exigirEquipamento(fixture.typeA.id);

    const depois = await prisma.serviceOrderCompletionPolicy.findUnique({
      where: { serviceOrderTypeId: fixture.typeA.id },
    });
    expect(depois?.requireEquipment).toBe(true);
    expect(depois?.requireChecklist).toBe(true);
    expect(depois?.requireSignature).toBe(true);
    expect(depois?.requireMaterials).toBe(true);
    expect(depois?.requireCheckIn).toBe(true);
    expect(depois?.minEvidenceCount).toBe(2);
    expect(depois?.requiredEvidenceCategories).toEqual([
      "ONU_ONT",
      "OPTICAL_READING",
    ]);
  });

  it("EQPOL-02 · sobre a política da §382, o checklist continua exigido", async () => {
    // O estado REAL de onde a configuração parte: a §382 deixou os tipos com
    // `requireChecklist = true` e nada mais.
    await politicaDaCobertura(fixture.typeA.id);
    await exigirEquipamento(fixture.typeA.id);

    const depois = await prisma.serviceOrderCompletionPolicy.findUnique({
      where: { serviceOrderTypeId: fixture.typeA.id },
    });
    // As duas dimensões que o tipo passa a ter, juntas.
    expect(depois?.requireChecklist).toBe(true);
    expect(depois?.requireEquipment).toBe(true);
    // E nada mais foi ligado de carona.
    expect(depois?.requireSignature).toBe(false);
    expect(depois?.requireMaterials).toBe(false);
    expect(depois?.requireCheckIn).toBe(false);
    expect(depois?.minEvidenceCount).toBe(0);
  });

  it("EQPOL-03 · reaplicar não muda o que a política EXIGE", async () => {
    /*
      `putCompletionPolicy` faz `upsert` incondicional, então reaplicar
      reescreve a linha e `updatedAt` anda — e isso é o comportamento, não um
      defeito a esconder. O que precisa ser idempotente é a EXIGÊNCIA, que é o
      que decide se a OS fecha; um caso que comparasse a linha inteira falaria
      do carimbo de tempo e não da regra.
    */
    const exigencias = async () => {
      const p = await prisma.serviceOrderCompletionPolicy.findUnique({
        where: { serviceOrderTypeId: fixture.typeA.id },
        select: {
          requireChecklist: true,
          requireSignature: true,
          requireMaterials: true,
          requireEquipment: true,
          requireCheckIn: true,
          minEvidenceCount: true,
          requiredEvidenceCategories: true,
        },
      });
      return p;
    };

    await politicaDaCobertura(fixture.typeA.id);
    await exigirEquipamento(fixture.typeA.id);
    const primeira = await exigencias();

    await exigirEquipamento(fixture.typeA.id);
    expect(await exigencias()).toEqual(primeira);
  });

  it("EQPOL-04 · configurar um tipo não toca nos OUTROS tipos", async () => {
    const outro = await prisma.serviceOrderType.create({
      data: {
        companyId: fixture.companyA.id,
        name: "Outro tipo do catálogo",
        sortOrder: 2,
      },
    });
    await politicaDaCobertura(fixture.typeA.id);
    await politicaDaCobertura(outro.id);

    await exigirEquipamento(fixture.typeA.id);

    const vizinho = await prisma.serviceOrderCompletionPolicy.findUnique({
      where: { serviceOrderTypeId: outro.id },
    });
    expect(vizinho?.requireEquipment).toBe(false);
    expect(vizinho?.requireChecklist).toBe(true);
  });

  it("EQPOL-05 · tipo de OUTRA empresa é recusado", async () => {
    // `putCompletionPolicy` valida o tipo contra o `companyId` antes de
    // qualquer escrita. Sem isso, um ADMIN configuraria a exigência de
    // conclusão da concorrente.
    await expect(
      putCompletionPolicy(
        fixture.companyA.id,
        fixture.adminA.id,
        fixture.typeB.id,
        {
          requireChecklist: false,
          requireSignature: false,
          requireMaterials: false,
          requireEquipment: true,
          requireCheckIn: false,
          minEvidenceCount: 0,
          requiredEvidenceCategories: [],
        },
      ),
    ).rejects.toThrow(/não encontrado/i);

    const intacta = await prisma.serviceOrderCompletionPolicy.findUnique({
      where: { serviceOrderTypeId: fixture.typeB.id },
    });
    expect(intacta).toBeNull();
  });
});

describe("EQPOL — o efeito da configuração no fechamento", () => {
  /** Uma OS pronta para fechar, faltando só o que o caso quer provar. */
  async function ordemComRelatorio(typeId: string) {
    const customer = await prisma.customer.create({
      data: {
        companyId: fixture.companyA.id,
        name: "Cliente Fictício",
        document: "00000000000",
      },
      select: { id: true },
    });
    const order = await prisma.serviceOrder.create({
      data: {
        companyId: fixture.companyA.id,
        customerId: customer.id,
        number: 9001,
        type: "Instalação",
        description: "Atendimento fictício.",
        typeId,
        status: "IN_PROGRESS",
      },
      select: { id: true, customerId: true },
    });
    await prisma.serviceOrderExecution.create({
      data: {
        companyId: fixture.companyA.id,
        serviceOrderId: order.id,
        diagnosis: "Diagnóstico.",
        workPerformed: "Serviço realizado.",
      },
    });
    return order;
  }

  it("EQPOL-06 · exigido e sem equipamento → EQUIPMENT_REQUIRED", async () => {
    await politicaDaCobertura(fixture.typeA.id);
    await exigirEquipamento(fixture.typeA.id);
    const order = await ordemComRelatorio(fixture.typeA.id);

    const pendencias = await validateServiceOrderCompletion(prisma, {
      companyId: fixture.companyA.id,
      orderId: order.id,
      serviceOrderTypeId: fixture.typeA.id,
    });

    expect(pendencias.map((p) => p.code)).toContain("EQUIPMENT_REQUIRED");
  });

  it("EQPOL-07 · registrado o equipamento, a pendência some", async () => {
    await politicaDaCobertura(fixture.typeA.id);
    await exigirEquipamento(fixture.typeA.id);
    const order = await ordemComRelatorio(fixture.typeA.id);

    // Controle positivo: antes do registro a pendência existe.
    const antes = await validateServiceOrderCompletion(prisma, {
      companyId: fixture.companyA.id,
      orderId: order.id,
      serviceOrderTypeId: fixture.typeA.id,
    });
    expect(antes.map((p) => p.code)).toContain("EQUIPMENT_REQUIRED");

    await prisma.serviceOrderEquipment.create({
      data: {
        companyId: fixture.companyA.id,
        serviceOrderId: order.id,
        customerId: order.customerId,
        equipmentType: "ONU",
      },
    });

    const depois = await validateServiceOrderCompletion(prisma, {
      companyId: fixture.companyA.id,
      orderId: order.id,
      serviceOrderTypeId: fixture.typeA.id,
    });
    expect(depois.map((p) => p.code)).not.toContain("EQUIPMENT_REQUIRED");
  });

  it("EQPOL-08 · sem a exigência, a OS vazia fecha — o estado que o dono viu", async () => {
    // A reprodução do relato: Instalação, zero equipamento, e nenhuma
    // pendência de equipamento. A tela neutra estava CERTA; o que faltava era
    // a decisão de negócio.
    await politicaDaCobertura(fixture.typeA.id);
    const order = await ordemComRelatorio(fixture.typeA.id);

    const pendencias = await validateServiceOrderCompletion(prisma, {
      companyId: fixture.companyA.id,
      orderId: order.id,
      serviceOrderTypeId: fixture.typeA.id,
    });

    expect(pendencias.map((p) => p.code)).not.toContain("EQUIPMENT_REQUIRED");
  });
});
