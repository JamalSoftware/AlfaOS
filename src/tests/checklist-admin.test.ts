import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  listCompanyChecklistTemplates,
  putChecklistTemplate,
  resolveApplicableTemplate,
  setChecklistTemplateActive,
} from "@/lib/checklists";
import {
  listCompanyCompletionPolicies,
  putCompletionPolicy,
} from "@/lib/service-order-completion";
import { seedTestData, type TestFixture } from "./helpers";

/**
 * # PRD §382 — a CONFIGURAÇÃO da cobertura
 *
 * `checklist-coverage.test.ts` fixa a regra que decide o que cobre o quê. Este
 * arquivo fixa o outro lado, que a V1 passou a exigir: configurar essa
 * cobertura pelo produto, e não por escrita direta no banco.
 *
 * Aqui não se afirma NADA sobre o conteúdo de nenhuma empresa real — nomes de
 * item são dado do provedor. O que se afirma é o mecanismo: quem lê, quem
 * escreve, o que é idempotente e o que nunca atravessa o tenant.
 */

let fixture: TestFixture;

beforeEach(async () => {
  fixture = await seedTestData();
});

const itens = (quantos: number, prefixo = "Item") =>
  Array.from({ length: quantos }, (_, i) => ({
    label: `${prefixo} ${i + 1}`,
    description: null,
    type: "BOOLEAN" as const,
    required: true,
    options: null,
    evidenceCategory: null,
  }));

describe("CHK-ADM — configuração do checklist", () => {
  it("CHK-ADM-01 · a leitura da empresa nunca traz template de outra", async () => {
    await putChecklistTemplate(fixture.companyA.id, fixture.adminA.id, {
      serviceOrderTypeId: null,
      name: "Padrão de A",
      items: itens(2),
    });
    await putChecklistTemplate(fixture.companyB.id, fixture.adminB.id, {
      serviceOrderTypeId: null,
      name: "Padrão de B",
      items: itens(3),
    });

    const deA = await listCompanyChecklistTemplates(fixture.companyA.id);
    expect(deA).toHaveLength(1);
    expect(deA[0].name).toBe("Padrão de A");
    expect(deA.some((t) => t.name === "Padrão de B")).toBe(false);
  });

  it("CHK-ADM-02 · salvar duas vezes não duplica: substitui os itens e anda a versão", async () => {
    /*
      Idempotência é da unique `(companyId, serviceOrderTypeId)`, não de uma
      conferência: salvar de novo alcança a MESMA linha. Sem isso, cada visita
      do operador à tela deixaria um template a mais e a precedência passaria a
      depender de qual o banco devolvesse primeiro.
    */
    const primeiro = await putChecklistTemplate(
      fixture.companyA.id,
      fixture.adminA.id,
      { serviceOrderTypeId: fixture.typeA.id, name: "Do tipo", items: itens(2) },
    );
    const segundo = await putChecklistTemplate(
      fixture.companyA.id,
      fixture.adminA.id,
      { serviceOrderTypeId: fixture.typeA.id, name: "Do tipo", items: itens(3) },
    );

    expect(segundo.templateId).toBe(primeiro.templateId);
    expect(segundo.version).toBe(primeiro.version + 1);

    const templates = await listCompanyChecklistTemplates(fixture.companyA.id);
    expect(templates).toHaveLength(1);
    expect(templates[0].items).toHaveLength(3);

    const linhas = await prisma.checklistTemplate.count({
      where: { companyId: fixture.companyA.id },
    });
    expect(linhas, "salvar de novo criou um segundo template").toBe(1);
  });

  it("CHK-ADM-03 · desativar tira o template da resolução sem apagar os itens", async () => {
    const salvo = await putChecklistTemplate(
      fixture.companyA.id,
      fixture.adminA.id,
      { serviceOrderTypeId: fixture.typeA.id, name: "Do tipo", items: itens(2) },
    );

    await setChecklistTemplateActive(
      fixture.companyA.id,
      fixture.adminA.id,
      salvo.templateId,
      false,
    );

    // Some da execução…
    expect(
      await resolveApplicableTemplate(prisma, fixture.companyA.id, fixture.typeA.id),
    ).toBeNull();

    // …e continua na configuração, com os itens intactos, para poder voltar.
    const templates = await listCompanyChecklistTemplates(fixture.companyA.id);
    expect(templates[0].active).toBe(false);
    expect(templates[0].items).toHaveLength(2);

    await setChecklistTemplateActive(
      fixture.companyA.id,
      fixture.adminA.id,
      salvo.templateId,
      true,
    );
    expect(
      (await resolveApplicableTemplate(prisma, fixture.companyA.id, fixture.typeA.id))
        ?.id,
    ).toBe(salvo.templateId);
  });

  it("CHK-ADM-04 · o template de OUTRA empresa não é desativável nem por id conhecido", async () => {
    const deB = await putChecklistTemplate(
      fixture.companyB.id,
      fixture.adminB.id,
      { serviceOrderTypeId: null, name: "Padrão de B", items: itens(2) },
    );

    await expect(
      setChecklistTemplateActive(
        fixture.companyA.id,
        fixture.adminA.id,
        deB.templateId,
        false,
      ),
    ).rejects.toThrow();

    const intacto = await prisma.checklistTemplate.findUniqueOrThrow({
      where: { id: deB.templateId },
    });
    expect(intacto.active, "a empresa A desativou o checklist da B").toBe(true);
  });

  it("CHK-ADM-05 · as políticas lidas são só as da empresa, e tipo sem política não vira linha", async () => {
    await putCompletionPolicy(
      fixture.companyA.id,
      fixture.adminA.id,
      fixture.typeA.id,
      {
        requireChecklist: true,
        requireSignature: false,
        requireMaterials: false,
        requireEquipment: false,
        requireCheckIn: false,
        minEvidenceCount: 0,
        requiredEvidenceCategories: [],
      },
    );
    await putCompletionPolicy(
      fixture.companyB.id,
      fixture.adminB.id,
      fixture.typeB.id,
      {
        requireChecklist: true,
        requireSignature: false,
        requireMaterials: false,
        requireEquipment: false,
        requireCheckIn: false,
        minEvidenceCount: 0,
        requiredEvidenceCategories: [],
      },
    );

    const deA = await listCompanyCompletionPolicies(fixture.companyA.id);
    expect(deA).toHaveLength(1);
    expect(deA[0].serviceOrderTypeId).toBe(fixture.typeA.id);
    expect(deA[0].requireChecklist).toBe(true);
  });

  it("CHK-ADM-06 · cobertura de um catálogo inteiro: template ativo E exigência configurada", async () => {
    /*
      A matriz que a §382 pede, com fixture e não com o catálogo de nenhum
      provedor: para cada tipo, existe checklist aplicável e a conclusão o
      exige. Ter checklist e exigir checklist são coisas diferentes — a
      primeira faz o técnico VER, a segunda faz o fechamento PARAR.
    */
    const nomes = ["Instalação", "Reparo", "Retirada", "Troca"];
    const tipos = [];
    for (const [indice, name] of nomes.entries()) {
      tipos.push(
        await prisma.serviceOrderType.create({
          data: {
            companyId: fixture.companyA.id,
            name: `${name} (matriz)`,
            sortOrder: indice + 30,
          },
        }),
      );
    }

    // Um padrão só cobre o catálogo inteiro; a exigência continua por tipo.
    await putChecklistTemplate(fixture.companyA.id, fixture.adminA.id, {
      serviceOrderTypeId: null,
      name: "Padrão da empresa",
      items: itens(4),
    });
    for (const tipo of tipos) {
      await putCompletionPolicy(fixture.companyA.id, fixture.adminA.id, tipo.id, {
        requireChecklist: true,
        requireSignature: false,
        requireMaterials: false,
        requireEquipment: false,
        requireCheckIn: false,
        minEvidenceCount: 0,
        requiredEvidenceCategories: [],
      });
    }

    const politicas = new Map(
      (await listCompanyCompletionPolicies(fixture.companyA.id)).map((p) => [
        p.serviceOrderTypeId,
        p,
      ]),
    );
    const descobertos: string[] = [];
    for (const tipo of tipos) {
      const template = await resolveApplicableTemplate(
        prisma,
        fixture.companyA.id,
        tipo.id,
      );
      const exige = politicas.get(tipo.id)?.requireChecklist ?? false;
      if (!template || template.items.length === 0 || !exige) {
        descobertos.push(tipo.name);
      }
    }
    expect(descobertos).toEqual([]);

    // E a OS sem tipo recebe o mesmo padrão — como orientação (CHK-NULL-01).
    const semTipo = await resolveApplicableTemplate(
      prisma,
      fixture.companyA.id,
      null,
    );
    expect(semTipo?.items).toHaveLength(4);
  });
});
