import { beforeEach, describe, expect, it } from "vitest";
import { PUT as putPolicy } from "@/app/api/service-order-types/[id]/completion-policy/route";
import { prisma } from "@/lib/prisma";
import {
  MAX_REQUIRED_EVIDENCE,
  POLICY_EVIDENCE_CATEGORIES,
} from "@/lib/evidence-category-policy";
import { validateServiceOrderCompletion } from "@/lib/service-order-completion";
import { apiRequest, createTokenFor, seedTestData, type TestFixture } from "./helpers";

/**
 * # A superfície administrativa da política de conclusão (`APP-003`)
 *
 * O backend já decidia tudo isso; o que faltava era o ADMIN conseguir VER e
 * MUDAR sem script. Estes casos afirmam a superfície — e, no `POL-ADMIN-15`,
 * que mexer nela muda a decisão do MOTOR DE VERDADE.
 *
 * A autoridade continua sendo uma só: `validateServiceOrderCompletion`. A tela
 * é configuração. Um teste que só conferisse a coluna no banco provaria que o
 * `UPDATE` aconteceu, não que a conclusão passou a obedecê-lo — e é essa a
 * pergunta que interessa.
 */

let fixture: TestFixture;

beforeEach(async () => {
  fixture = await seedTestData();
});

/** O corpo completo, porque a API SUBSTITUI a política inteira. */
function corpo(mudanca: Partial<Record<string, unknown>> = {}) {
  return {
    requireChecklist: false,
    requireSignature: false,
    requireMaterials: false,
    requireEquipment: false,
    requireCheckIn: false,
    minEvidenceCount: 0,
    requiredEvidenceCategories: [] as string[],
    ...mudanca,
  };
}

async function salvarComo(
  userId: string,
  typeId: string,
  body: unknown,
): Promise<Response> {
  const token = await createTokenFor(userId);
  return putPolicy(
    apiRequest(
      `/api/service-order-types/${typeId}/completion-policy`,
      { method: "PUT", body },
      token,
    ),
    { params: Promise.resolve({ id: typeId }) },
  );
}

async function politicaGravada(typeId: string) {
  return prisma.serviceOrderCompletionPolicy.findUnique({
    where: { serviceOrderTypeId: typeId },
  });
}

describe("POL-ADMIN — o ADMIN configura o que a conclusão exige", () => {
  it("POL-ADMIN-03 · assinatura passa a ser exigida e fica gravada", async () => {
    const res = await salvarComo(
      fixture.adminA.id,
      fixture.typeA.id,
      corpo({ requireSignature: true }),
    );
    expect(res.status).toBe(200);
    expect((await politicaGravada(fixture.typeA.id))?.requireSignature).toBe(
      true,
    );
  });

  it("POL-ADMIN-04 · equipamento passa a ser exigido e fica gravado", async () => {
    const res = await salvarComo(
      fixture.adminA.id,
      fixture.typeA.id,
      corpo({ requireEquipment: true }),
    );
    expect(res.status).toBe(200);
    expect((await politicaGravada(fixture.typeA.id))?.requireEquipment).toBe(
      true,
    );
  });

  it("POL-ADMIN-05 · material passa a ser exigido e fica gravado", async () => {
    const res = await salvarComo(
      fixture.adminA.id,
      fixture.typeA.id,
      corpo({ requireMaterials: true }),
    );
    expect(res.status).toBe(200);
    expect((await politicaGravada(fixture.typeA.id))?.requireMaterials).toBe(
      true,
    );
  });

  it("POL-ADMIN-06 · check-in passa a ser exigido e fica gravado", async () => {
    const res = await salvarComo(
      fixture.adminA.id,
      fixture.typeA.id,
      corpo({ requireCheckIn: true }),
    );
    expect(res.status).toBe(200);
    expect((await politicaGravada(fixture.typeA.id))?.requireCheckIn).toBe(true);
  });

  it("POL-ADMIN-07 · a quantidade mínima de fotos fica gravada", async () => {
    const res = await salvarComo(
      fixture.adminA.id,
      fixture.typeA.id,
      corpo({ minEvidenceCount: 3 }),
    );
    expect(res.status).toBe(200);
    expect((await politicaGravada(fixture.typeA.id))?.minEvidenceCount).toBe(3);
  });

  it("POL-ADMIN-08 · as categorias obrigatórias ficam gravadas", async () => {
    const res = await salvarComo(
      fixture.adminA.id,
      fixture.typeA.id,
      corpo({ requiredEvidenceCategories: ["ONU_ONT", "OPTICAL_READING"] }),
    );
    expect(res.status).toBe(200);
    expect(
      (await politicaGravada(fixture.typeA.id))?.requiredEvidenceCategories,
    ).toEqual(["ONU_ONT", "OPTICAL_READING"]);
  });

  it("POL-ADMIN-08b · salvar um campo não apaga os outros", async () => {
    /*
      A armadilha da §382, agora com SETE campos em vez de um. A tela manda o
      corpo inteiro; se um dia ela mandar só o que mudou, este caso cai.
    */
    await salvarComo(
      fixture.adminA.id,
      fixture.typeA.id,
      corpo({
        requireChecklist: true,
        requireSignature: true,
        minEvidenceCount: 2,
        requiredEvidenceCategories: ["CTO"],
      }),
    );

    // Agora só o equipamento muda — reenviando o resto, como a tela faz.
    const atual = await politicaGravada(fixture.typeA.id);
    await salvarComo(
      fixture.adminA.id,
      fixture.typeA.id,
      corpo({
        requireChecklist: atual!.requireChecklist,
        requireSignature: atual!.requireSignature,
        requireMaterials: atual!.requireMaterials,
        requireCheckIn: atual!.requireCheckIn,
        minEvidenceCount: atual!.minEvidenceCount,
        requiredEvidenceCategories: atual!.requiredEvidenceCategories,
        requireEquipment: true,
      }),
    );

    const depois = await politicaGravada(fixture.typeA.id);
    expect(depois?.requireEquipment).toBe(true);
    expect(depois?.requireChecklist).toBe(true);
    expect(depois?.requireSignature).toBe(true);
    expect(depois?.minEvidenceCount).toBe(2);
    expect(depois?.requiredEvidenceCategories).toEqual(["CTO"]);
  });

  it("POL-ADMIN-10 · DISPATCHER e TECHNICIAN não configuram", async () => {
    for (const userId of [fixture.dispatcherA.id, fixture.techA.id]) {
      const res = await salvarComo(
        userId,
        fixture.typeA.id,
        corpo({ requireSignature: true }),
      );
      expect(res.status).toBe(403);
    }
    // Controle positivo: a mesma escrita, pelo ADMIN, passa.
    expect(
      (
        await salvarComo(
          fixture.adminA.id,
          fixture.typeA.id,
          corpo({ requireSignature: true }),
        )
      ).status,
    ).toBe(200);
    expect((await politicaGravada(fixture.typeA.id))?.requireSignature).toBe(
      true,
    );
  });

  it("POL-ADMIN-11 · o ADMIN não configura tipo de OUTRA empresa", async () => {
    const res = await salvarComo(
      fixture.adminA.id,
      fixture.typeB.id,
      corpo({ requireSignature: true }),
    );
    expect(res.status).toBe(404);
    // E nada foi gravado para o tipo da outra empresa.
    expect(await politicaGravada(fixture.typeB.id)).toBeNull();
  });

  it("POL-ADMIN-12 · quantidade de fotos inválida é recusada pelo SERVIDOR", async () => {
    // Uma política VÁLIDA primeiro: o risco real não é a recusa, é a recusa
    // corromper o que já estava configurado.
    await salvarComo(
      fixture.adminA.id,
      fixture.typeA.id,
      corpo({ minEvidenceCount: 4, requireSignature: true }),
    );

    for (const valor of [-1, 1.5, MAX_REQUIRED_EVIDENCE + 1]) {
      const res = await salvarComo(
        fixture.adminA.id,
        fixture.typeA.id,
        corpo({ minEvidenceCount: valor }),
      );
      expect(res.status, `minEvidenceCount=${valor}`).toBe(400);
    }

    const intacta = await politicaGravada(fixture.typeA.id);
    expect(intacta?.minEvidenceCount).toBe(4);
    expect(intacta?.requireSignature).toBe(true);
  });

  it("POL-ADMIN-13 · categoria inválida é recusada pelo SERVIDOR", async () => {
    await salvarComo(
      fixture.adminA.id,
      fixture.typeA.id,
      corpo({ requiredEvidenceCategories: ["CTO"] }),
    );

    /*
      `EQUIPMENT_LABEL` existe no enum do Prisma e é recusado aqui de
      propósito: ela não é foto que o técnico tira quando decide — nasce
      temporária e é promovida pelo registro do equipamento.
    */
    for (const categoria of ["NAO_EXISTE", "EQUIPMENT_LABEL"]) {
      const res = await salvarComo(
        fixture.adminA.id,
        fixture.typeA.id,
        corpo({ requiredEvidenceCategories: [categoria] }),
      );
      expect(res.status, categoria).toBe(400);
    }

    expect(
      (await politicaGravada(fixture.typeA.id))?.requiredEvidenceCategories,
    ).toEqual(["CTO"]);
  });

  it("POL-ADMIN-13b · a lista que a tela oferece é a que o servidor aceita", async () => {
    /*
      Anti-divergência: a lista morava COPIADA na rota, na rota do checklist e
      na tela. Este caso prova, valor por valor, que a constante compartilhada
      é aceita inteira — uma opção oferecida e recusada viraria um 400 que o
      operador lê como defeito.
    */
    const res = await salvarComo(
      fixture.adminA.id,
      fixture.typeA.id,
      corpo({ requiredEvidenceCategories: [...POLICY_EVIDENCE_CATEGORIES] }),
    );
    expect(res.status).toBe(200);
    expect(
      (await politicaGravada(fixture.typeA.id))?.requiredEvidenceCategories,
    ).toHaveLength(POLICY_EVIDENCE_CATEGORIES.length);
  });
});

describe("POL-ADMIN — o motor de conclusão obedece ao que foi configurado", () => {
  /** Uma OS com relatório pronto: só a política decide se ela fecha. */
  async function ordemPronta(typeId: string) {
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
        number: 9101,
        type: "Tipo de teste",
        description: "Atendimento fictício.",
        typeId,
        status: "IN_PROGRESS",
      },
      select: { id: true },
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

  const pendencias = (typeId: string, orderId: string) =>
    validateServiceOrderCompletion(prisma, {
      companyId: fixture.companyA.id,
      orderId,
      serviceOrderTypeId: typeId,
    });

  it("POL-ADMIN-15 · ligar a exigência pela API muda a decisão do motor REAL", async () => {
    const order = await ordemPronta(fixture.typeA.id);

    // 1. Sem exigência de assinatura, a OS fecha.
    await salvarComo(
      fixture.adminA.id,
      fixture.typeA.id,
      corpo({ requireSignature: false }),
    );
    const antes = await pendencias(fixture.typeA.id, order.id);
    expect(antes.map((p) => p.code)).not.toContain("SIGNATURE_REQUIRED");
    expect(antes).toHaveLength(0);

    // 2. O ADMIN liga a exigência pelo MESMO caminho que a tela usa.
    const res = await salvarComo(
      fixture.adminA.id,
      fixture.typeA.id,
      corpo({ requireSignature: true }),
    );
    expect(res.status).toBe(200);

    // 3. O motor de verdade passa a bloquear. Nada foi recarregado nem
    //    migrado: a política é resolvida por tipo a cada validação.
    const depois = await pendencias(fixture.typeA.id, order.id);
    expect(depois.map((p) => p.code)).toContain("SIGNATURE_REQUIRED");
  });

  it("POL-ADMIN-15b · a mesma prova para foto mínima e categoria", async () => {
    const order = await ordemPronta(fixture.typeA.id);

    await salvarComo(
      fixture.adminA.id,
      fixture.typeA.id,
      corpo({ minEvidenceCount: 2, requiredEvidenceCategories: ["ONU_ONT"] }),
    );

    const codigos = (await pendencias(fixture.typeA.id, order.id)).map(
      (p) => p.code,
    );
    expect(codigos).toContain("EVIDENCE_COUNT_BELOW_MINIMUM");
    expect(codigos).toContain("EVIDENCE_CATEGORY_MISSING");
  });

  it("POL-ADMIN-15c · a pendência de categoria fala português, não o enum", async () => {
    const order = await ordemPronta(fixture.typeA.id);
    await salvarComo(
      fixture.adminA.id,
      fixture.typeA.id,
      corpo({ requiredEvidenceCategories: ["ONU_ONT"] }),
    );

    const falta = (await pendencias(fixture.typeA.id, order.id)).find(
      (p) => p.code === "EVIDENCE_CATEGORY_MISSING",
    );
    // O `code` é o contrato e não muda; a MENSAGEM é para gente.
    expect(falta?.message).toContain("ONU / ONT");
    expect(falta?.message).not.toContain("ONU_ONT");
  });

  it("POL-ADMIN-09 · desligar tudo devolve a OS ao que o relatório basta", async () => {
    // A compatibilidade que o `CHK-NULL-01` protege continua valendo: política
    // sem exigência nenhuma não inventa bloqueio.
    const order = await ordemPronta(fixture.typeA.id);
    await salvarComo(fixture.adminA.id, fixture.typeA.id, corpo());
    expect(await pendencias(fixture.typeA.id, order.id)).toHaveLength(0);
  });

  it("POL-ADMIN-09b · OS sem tipo não é alcançada pela política de tipo nenhum", async () => {
    /*
      `CHK-NULL-01`, preservado: a política é chaveada por tipo, e OS importada
      sem tipo não recebe exigência. Ligar tudo num tipo não a bloqueia.
    */
    await salvarComo(
      fixture.adminA.id,
      fixture.typeA.id,
      corpo({
        requireSignature: true,
        requireEquipment: true,
        minEvidenceCount: 5,
      }),
    );

    const customer = await prisma.customer.create({
      data: {
        companyId: fixture.companyA.id,
        name: "Cliente Importado",
        document: "11111111111",
      },
      select: { id: true },
    });
    const semTipo = await prisma.serviceOrder.create({
      data: {
        companyId: fixture.companyA.id,
        customerId: customer.id,
        number: 9102,
        type: "Chamado importado",
        description: "Veio do ERP.",
        typeId: null,
        status: "IN_PROGRESS",
      },
      select: { id: true },
    });
    await prisma.serviceOrderExecution.create({
      data: {
        companyId: fixture.companyA.id,
        serviceOrderId: semTipo.id,
        diagnosis: "Diagnóstico.",
        workPerformed: "Serviço realizado.",
      },
    });

    const codigos = (
      await validateServiceOrderCompletion(prisma, {
        companyId: fixture.companyA.id,
        orderId: semTipo.id,
        serviceOrderTypeId: null,
      })
    ).map((p) => p.code);
    expect(codigos).toHaveLength(0);
  });
});
