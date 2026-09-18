import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { resolveApplicableTemplate } from "@/lib/checklists";
import { seedTestData, type TestFixture } from "./helpers";

/**
 * # PRD §382 — cobertura de checklist por tipo de OS (`RC-1`)
 *
 * O mecanismo existe desde a v0.10 e a §382 é explícita: *"o que a V1 deve
 * fazer é **verificar cobertura** dos tipos que o provedor usa de fato, não
 * reimplementar o mecanismo"*. Verificar cobertura exige saber o que
 * "coberto" significa, e isso é uma REGRA — a precedência `template do tipo →
 * template padrão da empresa` —, não uma lista de nomes.
 *
 * Por isso este arquivo não afirma nada sobre "Instalação" ou "Reparo": nomes
 * de tipo são dado da empresa, digitados no catálogo dela, e um teste que os
 * fixasse quebraria no primeiro provedor que escrevesse "Instalacao" sem
 * cedilha — sem defeito nenhum no produto.
 *
 * O que se afirma é o que decide a cobertura de QUALQUER catálogo:
 *
 * ```text
 * tipo com template próprio   → o próprio
 * tipo sem template próprio   → o PADRÃO da empresa, se existir
 * empresa sem padrão          → sem checklist (e a conclusão segue a política)
 * template inativo            → não cobre
 * template de outra empresa   → nunca cobre
 * ```
 *
 * **O padrão é o que torna a cobertura total barata:** uma empresa cobre o
 * catálogo inteiro com um template só, e é ele que cobre também a OS importada
 * do ERP, que não tem `typeId` porque o provedor não conhece o catálogo.
 */

let fixture: TestFixture;

beforeEach(async () => {
  fixture = await seedTestData();
});

async function template(
  companyId: string,
  serviceOrderTypeId: string | null,
  opcoes: { ativo?: boolean; itens?: number; nome?: string } = {},
) {
  const { ativo = true, itens = 2, nome = "Template" } = opcoes;
  return prisma.checklistTemplate.create({
    data: {
      companyId,
      serviceOrderTypeId,
      name: nome,
      active: ativo,
      items: {
        create: Array.from({ length: itens }, (_, i) => ({
          // O item carrega o próprio `companyId`: o tenant é filtrado em SQL,
          // não por navegação de FK — a mesma regra do resto do schema.
          companyId,
          label: `Item ${i + 1}`,
          type: "BOOLEAN" as const,
          required: i === 0,
          sortOrder: i,
        })),
      },
    },
  });
}

const resolver = (companyId: string, typeId: string | null) =>
  resolveApplicableTemplate(prisma, companyId, typeId);

describe("CHK-COV — a regra que decide a cobertura", () => {
  it("CHK-COV-01 · tipo com template próprio usa o próprio, e não o padrão", async () => {
    const padrao = await template(fixture.companyA.id, null, { nome: "Padrão" });
    const proprio = await template(fixture.companyA.id, fixture.typeA.id, { nome: "Do tipo", itens: 3 });

    const aplicavel = await resolver(fixture.companyA.id, fixture.typeA.id);
    expect(aplicavel?.id).toBe(proprio.id);
    expect(aplicavel?.id).not.toBe(padrao.id);
    expect(aplicavel?.items).toHaveLength(3);
  });

  it("CHK-COV-02 · tipo SEM template próprio é coberto pelo padrão da empresa", async () => {
    const padrao = await template(fixture.companyA.id, null, { nome: "Padrão" });

    const aplicavel = await resolver(fixture.companyA.id, fixture.typeA.id);
    expect(aplicavel?.id).toBe(padrao.id);
  });

  it("CHK-COV-03 · OS sem tipo (importada do ERP) também é coberta pelo padrão", async () => {
    /*
      A OS que veio do provedor não tem `typeId` — o ERP não conhece o catálogo
      da empresa. Sem o padrão, ela ficaria permanentemente sem checklist.
    */
    const padrao = await template(fixture.companyA.id, null);
    expect((await resolver(fixture.companyA.id, null))?.id).toBe(padrao.id);
  });

  it("CHK-COV-04 · sem nenhum template, não há checklist — e isso é um estado válido", async () => {
    expect(await resolver(fixture.companyA.id, fixture.typeA.id)).toBeNull();
    expect(await resolver(fixture.companyA.id, null)).toBeNull();
  });

  it("CHK-COV-05 · template inativo não cobre, nem o do tipo nem o padrão", async () => {
    await template(fixture.companyA.id, fixture.typeA.id, { ativo: false, nome: "Desligado" });
    expect(await resolver(fixture.companyA.id, fixture.typeA.id)).toBeNull();

    const padrao = await template(fixture.companyA.id, null, { nome: "Padrão" });
    // Com o próprio inativo, cai no padrão — não fica sem checklist.
    expect((await resolver(fixture.companyA.id, fixture.typeA.id))?.id).toBe(padrao.id);
  });

  it("CHK-COV-06 · template de OUTRA empresa nunca cobre", async () => {
    await template(fixture.companyB.id, null, { nome: "Padrão de B" });
    await template(fixture.companyB.id, fixture.typeB.id, { nome: "Tipo de B" });

    expect(await resolver(fixture.companyA.id, fixture.typeA.id)).toBeNull();
    // E o tipo de B, pedido pela empresa A, também não alcança o template de B.
    expect(await resolver(fixture.companyA.id, fixture.typeB.id)).toBeNull();
  });

  it("CHK-COV-07 · um padrão cobre o CATÁLOGO INTEIRO — a varredura que a §382 pede", async () => {
    /*
      A pergunta da §382 é operacional: "todo tipo que o provedor usa tem
      checklist?". A resposta é uma varredura sobre o catálogo REAL da empresa,
      e é isto que este caso demonstra — com um catálogo de quatro tipos com a
      forma dos que um provedor usa (instalação, reparo, retirada, troca).
    */
    // O sufixo evita colidir com o catálogo que a fixture já criou — a unique é
    // `(companyId, name)`, e o que este caso mede é a cobertura, não o nome.
    const nomes = [
      "Instalação (cobertura)",
      "Reparo (cobertura)",
      "Retirada (cobertura)",
      "Troca de equipamento (cobertura)",
    ];
    const tipos = [];
    for (const [indice, name] of Array.from(nomes.entries())) {
      tipos.push(
        await prisma.serviceOrderType.create({
          data: { companyId: fixture.companyA.id, name, sortOrder: indice + 10 },
        }),
      );
    }

    // Antes de configurar: nenhum tipo coberto.
    for (const tipo of tipos) {
      expect(await resolver(fixture.companyA.id, tipo.id), tipo.name).toBeNull();
    }

    await template(fixture.companyA.id, null, { nome: "Padrão da empresa" });

    // Depois do padrão: todos cobertos, sem um template por tipo.
    const cobertura = await Promise.all(
      tipos.map(async (tipo) => ({
        tipo: tipo.name,
        coberto: (await resolver(fixture.companyA.id, tipo.id)) !== null,
      })),
    );
    expect(cobertura.filter((c) => !c.coberto)).toEqual([]);
  });
});
