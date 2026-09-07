import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { DomainError } from "@/lib/errors";
import {
  changeCtoCapacity,
  createCto,
  effectivePortState,
  getCto,
  isPortOfferable,
  listCompanyCtos,
  setCtoActive,
  setCtoPhoto,
  setPortAdministrativeState,
  updateCto,
} from "@/lib/cto";
import { setFileStorage, getFileStorage } from "@/lib/storage";
import { seedTestData, type TestFixture } from "./helpers";
import { montarJpeg, lerExif, GPS_TAGS } from "./support/jpeg-exif";

/**
 * # CTO-1 — domínio
 *
 * Contra Postgres real. O alvo é o que a fase decidiu e não pode regredir:
 * portas nascem com a caixa, capacidade preserva histórico, ocupação não é
 * gravável, e o código é imutável.
 *
 * Autorização de rota fica em `cto-routes.test.ts`.
 */

let fixture: TestFixture;

/** Armazenamento em memória: o teste não escreve no disco do desenvolvedor. */
const arquivos = new Map<string, { data: Buffer; mimeType: string }>();

beforeEach(async () => {
  fixture = await seedTestData();
  arquivos.clear();
  /*
    O fake implementa o contrato INTEIRO, inclusive o retorno de `put` e o
    `exists` que este teste não exercita. Um fake com forma própria compilaria
    hoje e deixaria de representar o contrato assim que a produção passasse a
    usar o retorno — que é como um teste começa a provar outra coisa.
  */
  setFileStorage({
    async put(storageKey, data, mimeType) {
      arquivos.set(storageKey, { data, mimeType });
      return { storageKey, sizeBytes: data.byteLength, mimeType };
    },
    async get(storageKey) {
      const f = arquivos.get(storageKey);
      if (!f) throw new Error("não encontrado");
      return f.data;
    },
    async delete(storageKey) {
      arquivos.delete(storageKey);
    },
    async exists(storageKey) {
      return arquivos.has(storageKey);
    },
  });
});

async function novaCto(
  companyId = fixture.companyA.id,
  actor = fixture.adminA.id,
  overrides: Partial<Parameters<typeof createCto>[2]> = {},
) {
  return createCto(companyId, actor, {
    name: "A16",
    capacity: 8,
    ...overrides,
  });
}

async function portasDe(ctoId: string) {
  return prisma.cTOPort.findMany({
    where: { ctoId },
    orderBy: { number: "asc" },
  });
}

// ---------------------------------------------------------------------------

describe("CTO1-03 · criação cria as portas", () => {
  it("capacity=8 cria exatamente as portas 1..8", async () => {
    const cto = await novaCto();
    const portas = await portasDe(cto.id);

    expect(portas).toHaveLength(8);
    expect(portas.map((p) => p.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // Todas nascem disponíveis, e nenhuma nasce ocupada — não há como.
    expect(portas.every((p) => p.administrativeState === "AVAILABLE")).toBe(true);
    expect(portas.every((p) => p.companyId === fixture.companyA.id)).toBe(true);
  });

  it("CTO1-04 · falha DEPOIS das portas não deixa CTO nem portas", async () => {
    /*
      Achado da auditoria independente sobre a primeira versão deste teste.

      Ele usava conflito de nome e o comentário afirmava que "a CTO é criada, as
      portas são criadas, e a unique estoura no commit". Não é o que acontece: o
      índice único não é DEFERRABLE, então a violação dispara no próprio INSERT
      da CTO e `createMany` nunca roda. O teste documentava como provado um
      rollback de inserção única, e uma regressão que quebrasse a transação
      ENTRE a CTO e as portas passaria por ele.

      O vetor correto falha depois do `createMany`: um ator inexistente derruba
      a escrita do `AuditLog`, que é a última operação da transação. Se as
      portas fossem criadas fora dela, sobreviveriam a este rollback.
    */
    const atorInexistente = "usuario-que-nao-existe";

    await expect(
      createCto(fixture.companyA.id, atorInexistente, {
        name: "ATOMICA",
        capacity: 8,
      }),
    ).rejects.toThrow();

    expect(await prisma.cTO.count({ where: { name: "ATOMICA" } })).toBe(0);
    expect(await prisma.cTOPort.count()).toBe(0);
    expect(
      await prisma.auditLog.count({ where: { action: "CTO.CREATED" } }),
    ).toBe(0);
  });

  it("nome repetido na mesma empresa não deixa resíduo", async () => {
    // O caminho do conflito de nome continua coberto — só deixou de ser
    // apresentado como prova de atomicidade.
    await novaCto();
    const antesCtos = await prisma.cTO.count();
    const antesPortas = await prisma.cTOPort.count();

    await expect(novaCto(fixture.companyA.id, fixture.adminA.id)).rejects.toThrow(
      DomainError,
    );

    expect(await prisma.cTO.count()).toBe(antesCtos);
    expect(await prisma.cTOPort.count()).toBe(antesPortas);
  });

  it("capacidade fora da faixa é recusada", async () => {
    await expect(novaCto(undefined, undefined, { capacity: 0 })).rejects.toThrow(
      DomainError,
    );
    await expect(
      novaCto(undefined, undefined, { capacity: 1000 }),
    ).rejects.toThrow(DomainError);
  });
});

describe("CTO1-05 / CTO1-06 · nome único por empresa", () => {
  it("mesmo nome na mesma empresa é conflito", async () => {
    await novaCto();
    await expect(novaCto()).rejects.toMatchObject({ status: 409 });
  });

  it("mesmo nome em empresa diferente é permitido", async () => {
    await novaCto();
    const outra = await novaCto(fixture.companyB.id, fixture.adminB.id);
    expect(outra.name).toBe("A16");

    // Controle positivo: as duas existem, cada uma na sua empresa.
    const daA = await listCompanyCtos(fixture.companyA.id);
    const daB = await listCompanyCtos(fixture.companyB.id);
    expect(daA).toHaveLength(1);
    expect(daB).toHaveLength(1);
    expect(daA[0].id).not.toBe(daB[0].id);
  });

  it("renomear não cria CTO nova nem altera o id", async () => {
    const cto = await novaCto();
    const renomeada = await updateCto(
      fixture.companyA.id,
      fixture.adminA.id,
      cto.id,
      { name: "A17" },
    );
    expect(renomeada.id).toBe(cto.id);
    expect(renomeada.name).toBe("A17");
    expect(await prisma.cTO.count()).toBe(1);
    // As portas continuam sendo as mesmas linhas.
    expect(await prisma.cTOPort.count({ where: { ctoId: cto.id } })).toBe(8);
  });
});

describe("CTO1-07 · UNIQUE(ctoId, number) é do banco", () => {
  it("o banco impede duas portas com o mesmo número na mesma CTO", async () => {
    const cto = await novaCto();
    // Direto no Prisma, sem passar pelo serviço: é a constraint que está sendo
    // testada, não a validação de aplicação.
    await expect(
      prisma.cTOPort.create({
        data: { ctoId: cto.id, companyId: fixture.companyA.id, number: 3 },
      }),
    ).rejects.toThrow();
  });

  it("o mesmo número em CTOs diferentes é permitido", async () => {
    const a = await novaCto();
    const b = await novaCto(undefined, undefined, { name: "A17" });
    const p1 = await prisma.cTOPort.findFirst({
      where: { ctoId: a.id, number: 3 },
    });
    const p2 = await prisma.cTOPort.findFirst({
      where: { ctoId: b.id, number: 3 },
    });
    expect(p1).not.toBeNull();
    expect(p2).not.toBeNull();
    expect(p1!.id).not.toBe(p2!.id);
  });
});

describe("CTO1-08 / CTO1-09 / CTO1-12 · capacidade", () => {
  it("aumento 8 → 16 cria 9..16 e preserva 1..8", async () => {
    const cto = await novaCto();
    const idsAntes = (await portasDe(cto.id)).map((p) => p.id);

    const depois = await changeCtoCapacity(
      fixture.companyA.id,
      fixture.adminA.id,
      cto.id,
      16,
    );

    expect(depois.capacity).toBe(16);
    const portas = await portasDe(cto.id);
    expect(portas.map((p) => p.number)).toEqual(
      Array.from({ length: 16 }, (_, i) => i + 1),
    );
    // As oito originais são as MESMAS linhas, não recriadas.
    expect(portas.slice(0, 8).map((p) => p.id)).toEqual(idsAntes);
  });

  it("redução 16 → 8 NÃO apaga as portas 9..16", async () => {
    const cto = await novaCto(undefined, undefined, { capacity: 16 });
    const idsAcima = (await portasDe(cto.id))
      .filter((p) => p.number > 8)
      .map((p) => p.id);

    const depois = await changeCtoCapacity(
      fixture.companyA.id,
      fixture.adminA.id,
      cto.id,
      8,
    );

    expect(depois.capacity).toBe(8);
    // 16 linhas continuam existindo: capacity != contagem de linhas.
    expect(await prisma.cTOPort.count({ where: { ctoId: cto.id } })).toBe(16);
    const sobreviventes = await prisma.cTOPort.findMany({
      where: { id: { in: idsAcima } },
    });
    expect(sobreviventes).toHaveLength(8);

    // E elas deixam de ser ofertáveis, que é a única coisa que muda para elas.
    expect(depois.summary.historical).toBe(8);
    for (const porta of depois.ports.filter((p) => p.number > 8)) {
      expect(porta.offerable).toBe(false);
    }
  });

  it("reaumento reutiliza as linhas históricas, sem duplicar", async () => {
    const cto = await novaCto(undefined, undefined, { capacity: 16 });
    const idPorta12 = (await portasDe(cto.id)).find((p) => p.number === 12)!.id;

    await changeCtoCapacity(fixture.companyA.id, fixture.adminA.id, cto.id, 8);
    await changeCtoCapacity(fixture.companyA.id, fixture.adminA.id, cto.id, 16);

    const portas = await portasDe(cto.id);
    expect(portas).toHaveLength(16);
    // Mesmíssima linha: o histórico da porta 12 sobreviveu ao ciclo inteiro.
    expect(portas.find((p) => p.number === 12)!.id).toBe(idPorta12);
  });

  it("o estado administrativo de uma linha reutilizada NÃO é resetado", async () => {
    /*
      ## O preparo mudou; a afirmação não

      A versão anterior marcava a porta 12 como danificada ENQUANTO ela estava
      fora da capacidade, apoiada numa frase que eu havia escrito no domínio:
      "marcar histórico como danificado é legítimo". A `CTO-1.9` fechou essa
      pergunta na direção oposta, por decisão de produto — porta fora da
      capacidade é histórica e **read-only** —, e o caminho que este teste usava
      deixou de existir.

      Sob a regra nova, uma linha histórica é sempre `AVAILABLE`: a redução só
      é aceita quando as posições acima do novo limite estão liberadas, e depois
      disso nada mais as toca. O risco que este teste sempre guardou continua de
      pé e é outro — o passo que CRIA as posições faltantes no reaumento não
      pode reescrever as linhas que já existem.
    */
    const cto = await novaCto(undefined, undefined, { capacity: 16 });
    const antes = await portasDe(cto.id);
    const porta5 = antes.find((p) => p.number === 5)!;
    const porta12 = antes.find((p) => p.number === 12)!;

    // Dentro da capacidade que SOBREVIVE à redução: por estar abaixo de 8, ela
    // não bloqueia nada e atravessa o ciclo inteiro marcada.
    await setPortAdministrativeState(
      fixture.companyA.id,
      fixture.adminA.id,
      cto.id,
      porta5.id,
      "DAMAGED",
    );

    await changeCtoCapacity(fixture.companyA.id, fixture.adminA.id, cto.id, 8);

    // A histórica atravessa a redução exatamente como estava: liberada.
    expect(
      (await prisma.cTOPort.findUniqueOrThrow({ where: { id: porta12.id } }))
        .administrativeState,
    ).toBe("AVAILABLE");

    await changeCtoCapacity(fixture.companyA.id, fixture.adminA.id, cto.id, 16);

    const depois = await portasDe(cto.id);
    expect(depois).toHaveLength(16);

    // O que o reaumento NÃO pode fazer: resetar quem já estava lá.
    expect(depois.find((p) => p.number === 5)!.administrativeState).toBe(
      "DAMAGED",
    );

    // E a linha histórica é a MESMA, não uma recriada com o mesmo número.
    const doze = depois.find((p) => p.number === 12)!;
    expect(doze.id).toBe(porta12.id);
    expect(doze.createdAt.getTime()).toBe(porta12.createdAt.getTime());
    expect(doze.administrativeState).toBe("AVAILABLE");
  });
});

describe("CTO1-10 / CTO1-11 · redução recusada", () => {
  async function ctoComPortaEm(state: "RESERVED" | "DAMAGED") {
    const cto = await novaCto(undefined, undefined, { capacity: 16 });
    const porta = (await portasDe(cto.id)).find((p) => p.number === 12)!;
    await setPortAdministrativeState(
      fixture.companyA.id,
      fixture.adminA.id,
      cto.id,
      porta.id,
      state,
    );
    return cto;
  }

  it("porta RESERVED acima do novo limite recusa a redução", async () => {
    const cto = await ctoComPortaEm("RESERVED");
    await expect(
      changeCtoCapacity(fixture.companyA.id, fixture.adminA.id, cto.id, 8),
    ).rejects.toMatchObject({ status: 409 });

    // E a capacidade não mudou: a recusa é total, não parcial.
    const atual = await prisma.cTO.findUniqueOrThrow({ where: { id: cto.id } });
    expect(atual.capacity).toBe(16);
  });

  it("porta DAMAGED acima do novo limite recusa a redução", async () => {
    const cto = await ctoComPortaEm("DAMAGED");
    await expect(
      changeCtoCapacity(fixture.companyA.id, fixture.adminA.id, cto.id, 8),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("liberar a porta destrava a redução — controle positivo", async () => {
    const cto = await ctoComPortaEm("RESERVED");
    const porta = (await portasDe(cto.id)).find((p) => p.number === 12)!;
    await setPortAdministrativeState(
      fixture.companyA.id,
      fixture.adminA.id,
      cto.id,
      porta.id,
      "AVAILABLE",
    );

    const depois = await changeCtoCapacity(
      fixture.companyA.id,
      fixture.adminA.id,
      cto.id,
      8,
    );
    expect(depois.capacity).toBe(8);
  });

  it("porta reservada ABAIXO do novo limite não atrapalha", async () => {
    const cto = await novaCto(undefined, undefined, { capacity: 16 });
    const porta3 = (await portasDe(cto.id)).find((p) => p.number === 3)!;
    await setPortAdministrativeState(
      fixture.companyA.id,
      fixture.adminA.id,
      cto.id,
      porta3.id,
      "RESERVED",
    );

    const depois = await changeCtoCapacity(
      fixture.companyA.id,
      fixture.adminA.id,
      cto.id,
      8,
    );
    expect(depois.capacity).toBe(8);
  });
});

describe("CTO1-13 · code é imutável", () => {
  it("alterar o código é recusado explicitamente, não ignorado", async () => {
    const cto = await novaCto(undefined, undefined, { code: "CX-45" });

    await expect(
      updateCto(fixture.companyA.id, fixture.adminA.id, cto.id, {
        code: "CX-99",
      }),
    ).rejects.toMatchObject({ status: 400 });

    const atual = await prisma.cTO.findUniqueOrThrow({ where: { id: cto.id } });
    expect(atual.code).toBe("CX-45");
  });

  it("reenviar o MESMO código é aceito", async () => {
    // O formulário manda o objeto inteiro. Recusar o valor igual transformaria
    // "salvar sem mexer no código" num erro.
    const cto = await novaCto(undefined, undefined, { code: "CX-45" });
    const depois = await updateCto(
      fixture.companyA.id,
      fixture.adminA.id,
      cto.id,
      { code: "CX-45", notes: "poste novo" },
    );
    expect(depois.code).toBe("CX-45");
    expect(depois.notes).toBe("poste novo");
  });

  it("preencher um código que era nulo também é recusado", async () => {
    const cto = await novaCto();
    expect(cto.code).toBeNull();
    await expect(
      updateCto(fixture.companyA.id, fixture.adminA.id, cto.id, {
        code: "NOVO",
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("CTO1-16 · isolamento entre empresas (R-02)", () => {
  it("a empresa B não lê a CTO da empresa A", async () => {
    const cto = await novaCto();

    // Controle positivo primeiro: pelo caminho certo, o dado VEM.
    expect(await getCto(fixture.companyA.id, cto.id)).not.toBeNull();

    expect(await getCto(fixture.companyB.id, cto.id)).toBeNull();
  });

  it("a empresa B não altera, não muda capacidade e não inativa a CTO de A", async () => {
    const cto = await novaCto();

    await expect(
      updateCto(fixture.companyB.id, fixture.adminB.id, cto.id, {
        name: "invadida",
      }),
    ).rejects.toMatchObject({ status: 404 });

    await expect(
      changeCtoCapacity(fixture.companyB.id, fixture.adminB.id, cto.id, 32),
    ).rejects.toMatchObject({ status: 404 });

    await expect(
      setCtoActive(fixture.companyB.id, fixture.adminB.id, cto.id, false),
    ).rejects.toMatchObject({ status: 404 });

    const atual = await prisma.cTO.findUniqueOrThrow({ where: { id: cto.id } });
    expect(atual.name).toBe("A16");
    expect(atual.capacity).toBe(8);
    expect(atual.active).toBe(true);
  });

  it("a empresa B não altera o estado de uma porta de A", async () => {
    const cto = await novaCto();
    const porta = (await portasDe(cto.id))[0];

    await expect(
      setPortAdministrativeState(
        fixture.companyB.id,
        fixture.adminB.id,
        cto.id,
        porta.id,
        "DAMAGED",
      ),
    ).rejects.toMatchObject({ status: 404 });

    const atual = await prisma.cTOPort.findUniqueOrThrow({
      where: { id: porta.id },
    });
    expect(atual.administrativeState).toBe("AVAILABLE");
  });

  it("a porta de OUTRA CTO da mesma empresa também é recusada", async () => {
    /*
      Não é cross-tenant, e é um defeito do mesmo tipo: o `ctoId` da URL diz um
      recurso e o `portId` do caminho diz outro. Sem o `ctoId` no predicado, a
      escrita aconteceria numa caixa que a requisição não nomeou.
    */
    const a = await novaCto();
    const b = await novaCto(undefined, undefined, { name: "A17" });
    const portaDeB = (await portasDe(b.id))[0];

    await expect(
      setPortAdministrativeState(
        fixture.companyA.id,
        fixture.adminA.id,
        a.id,
        portaDeB.id,
        "DAMAGED",
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("a listagem de A nunca traz CTO de B", async () => {
    await novaCto();
    await novaCto(fixture.companyB.id, fixture.adminB.id, { name: "B-01" });

    const daA = await listCompanyCtos(fixture.companyA.id);
    expect(daA.map((c) => c.name)).toEqual(["A16"]);
  });
});

describe("CTO1-23 / CTO1-24 · ofertabilidade (R-13)", () => {
  /*
    A regra é testada DIRETAMENTE, e não pela listagem que a tela consome.

    É esse o ponto do R-13: a lista não pode ser a única proteção, porque a
    CTO-2 vai receber um `ctoPortId` num payload e precisa decidir sozinha se
    aquela posição ainda é oferecida.
  */
  it("número acima da capacidade não é ofertável", () => {
    expect(
      isPortOfferable({ number: 12, administrativeState: "AVAILABLE" }, 8),
    ).toBe(false);
  });

  it("número dentro da capacidade e disponível é ofertável", () => {
    expect(
      isPortOfferable({ number: 8, administrativeState: "AVAILABLE" }, 8),
    ).toBe(true);
  });

  it("RESERVED e DAMAGED não são ofertáveis mesmo dentro da capacidade", () => {
    expect(
      isPortOfferable({ number: 3, administrativeState: "RESERVED" }, 8),
    ).toBe(false);
    expect(
      isPortOfferable({ number: 3, administrativeState: "DAMAGED" }, 8),
    ).toBe(false);
  });

  it("a projeção marca como não ofertável a porta acima da capacidade", async () => {
    const cto = await novaCto(undefined, undefined, { capacity: 16 });
    await changeCtoCapacity(fixture.companyA.id, fixture.adminA.id, cto.id, 8);
    const detalhe = await getCto(fixture.companyA.id, cto.id);
    const p12 = detalhe!.ports.find((p) => p.number === 12)!;
    expect(p12.offerable).toBe(false);
  });
});

describe("CTO1-25 · OCUPADA não é um estado gravável", () => {
  it("o enum do banco não aceita OCCUPIED", async () => {
    const cto = await novaCto();
    const porta = (await portasDe(cto.id))[0];
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "cto_ports" SET "administrativeState" = 'OCCUPIED' WHERE "id" = $1`,
        porta.id,
      ),
    ).rejects.toThrow();
  });

  it("o estado efetivo é DERIVADO, e ocupação vence o administrativo", () => {
    // Na CTO-1 nada produz `true` aqui; o parâmetro existe para a CTO-2.
    expect(effectivePortState("AVAILABLE")).toBe("FREE");
    expect(effectivePortState("RESERVED")).toBe("RESERVED");
    expect(effectivePortState("DAMAGED")).toBe("DAMAGED");
    expect(effectivePortState("AVAILABLE", true)).toBe("OCCUPIED");
    expect(effectivePortState("DAMAGED", true)).toBe("OCCUPIED");
  });

  it("nenhuma porta aparece ocupada na CTO-1", async () => {
    const cto = await novaCto();
    const detalhe = await getCto(fixture.companyA.id, cto.id);
    expect(detalhe!.summary.occupied).toBe(0);
    expect(detalhe!.ports.every((p) => p.effectiveState !== "OCCUPIED")).toBe(
      true,
    );
  });
});

describe("CTO1-21 · auditoria", () => {
  async function acoes(companyId: string) {
    const logs = await prisma.auditLog.findMany({
      where: { companyId, action: { startsWith: "CTO." } },
      orderBy: { createdAt: "asc" },
    });
    return logs;
  }

  it("criar, editar, mudar capacidade, mudar porta e inativar são auditados", async () => {
    const cto = await novaCto();
    await updateCto(fixture.companyA.id, fixture.adminA.id, cto.id, {
      notes: "poste da esquina",
    });
    await changeCtoCapacity(fixture.companyA.id, fixture.adminA.id, cto.id, 16);
    const porta = (await portasDe(cto.id))[0];
    await setPortAdministrativeState(
      fixture.companyA.id,
      fixture.adminA.id,
      cto.id,
      porta.id,
      "RESERVED",
    );
    await setCtoActive(fixture.companyA.id, fixture.adminA.id, cto.id, false);

    const logs = await acoes(fixture.companyA.id);
    expect(logs.map((l) => l.action)).toEqual([
      "CTO.CREATED",
      "CTO.UPDATED",
      "CTO.CAPACITY_CHANGED",
      "CTO.PORT_STATE_CHANGED",
      "CTO.INACTIVATED",
    ]);
    // Ator e empresa em todas.
    expect(logs.every((l) => l.userId === fixture.adminA.id)).toBe(true);
    expect(logs.every((l) => l.companyId === fixture.companyA.id)).toBe(true);
  });

  it("a auditoria de edição registra os CAMPOS, não o conteúdo", async () => {
    const cto = await novaCto();
    const segredo = "anotação interna que não deve ser copiada para a auditoria";
    await updateCto(fixture.companyA.id, fixture.adminA.id, cto.id, {
      notes: segredo,
    });
    const log = (await acoes(fixture.companyA.id)).find(
      (l) => l.action === "CTO.UPDATED",
    )!;
    expect(log.details).toContain("observações");
    expect(log.details).not.toContain(segredo);
  });

  it("edição sem mudança real não gera auditoria, em NENHUM campo", async () => {
    /*
      A tela manda o formulário inteiro a cada "Salvar". Se só `name` comparasse
      com o gravado, toda gravação registraria uma alteração de coordenadas que
      ninguém fez — e a auditoria vira ruído que esconde a mudança real.
    */
    const cto = await novaCto(undefined, undefined, {
      latitude: -23.5505199,
      longitude: -46.6333094,
      addressReference: "Poste em frente ao nº 340",
      notes: "caixa alta",
    });

    await updateCto(fixture.companyA.id, fixture.adminA.id, cto.id, {
      name: "A16",
      latitude: -23.5505199,
      longitude: -46.6333094,
      addressReference: "Poste em frente ao nº 340",
      notes: "caixa alta",
    });

    const logs = await acoes(fixture.companyA.id);
    expect(logs.map((l) => l.action)).toEqual(["CTO.CREATED"]);
  });

  it("mudança real de coordenada é auditada", async () => {
    // O par do teste acima: prova que o silêncio veio da igualdade, e não de a
    // comparação recusar tudo.
    const cto = await novaCto(undefined, undefined, {
      latitude: -23.5505199,
      longitude: -46.6333094,
    });
    await updateCto(fixture.companyA.id, fixture.adminA.id, cto.id, {
      latitude: -23.55,
      longitude: -46.63,
    });
    const logs = await acoes(fixture.companyA.id);
    expect(logs.map((l) => l.action)).toEqual(["CTO.CREATED", "CTO.UPDATED"]);
    expect(logs[1].details).toContain("coordenadas");
  });
});

describe("CTO1-22 · concorrência na capacidade", () => {
  it("duas expansões simultâneas não duplicam porta", async () => {
    const cto = await novaCto();

    // Corrida REAL: as duas partem do mesmo estado lido.
    const resultados = await Promise.allSettled([
      changeCtoCapacity(fixture.companyA.id, fixture.adminA.id, cto.id, 16),
      changeCtoCapacity(fixture.companyA.id, fixture.adminA.id, cto.id, 16),
    ]);

    // Nenhuma das duas pode falhar por violação de unique: o lock serializa, e
    // a segunda enxerga o trabalho da primeira.
    expect(resultados.every((r) => r.status === "fulfilled")).toBe(true);

    const portas = await portasDe(cto.id);
    // Exatamente 16 — não "pelo menos 16".
    expect(portas).toHaveLength(16);
    expect(new Set(portas.map((p) => p.number)).size).toBe(16);

    const atual = await prisma.cTO.findUniqueOrThrow({ where: { id: cto.id } });
    expect(atual.capacity).toBe(16);
  });

  it("duas mudanças simultâneas na mesma porta deixam trilha ENCADEÁVEL", async () => {
    /*
      Este teste substitui um anterior que eu escrevi errado, e o registro vale
      mais que o teste.

      A primeira versão afirmava que reduzir capacidade e reservar uma porta ao
      mesmo tempo nunca poderia deixar uma porta reservada acima da capacidade.
      Ela falhou — e falhou porque a afirmação estava errada: esse estado é
      alcançável de forma legítima, bastando a redução acontecer primeiro e a
      reserva depois, que é permitido por decisão da própria fase. Serializar as
      duas operações não remove nenhum estado final do conjunto, então não havia
      desfecho ruim a proibir.

      O que a serialização realmente garante é a AUDITORIA. Com o estado lido
      fora da transação, duas mudanças simultâneas na mesma porta produzem dois
      registros partindo do mesmo ponto — ambos "AVAILABLE → X" —, e a trilha
      deixa de ser encadeável: ninguém consegue reconstruir por qual sequência a
      porta passou.
    */
    const cto = await novaCto();
    const porta = (await portasDe(cto.id))[0];

    await Promise.allSettled([
      setPortAdministrativeState(
        fixture.companyA.id,
        fixture.adminA.id,
        cto.id,
        porta.id,
        "RESERVED",
      ),
      setPortAdministrativeState(
        fixture.companyA.id,
        fixture.adminA.id,
        cto.id,
        porta.id,
        "DAMAGED",
      ),
    ]);

    const logs = await prisma.auditLog.findMany({
      where: { companyId: fixture.companyA.id, action: "CTO.PORT_STATE_CHANGED" },
      orderBy: { createdAt: "asc" },
    });
    expect(logs).toHaveLength(2);

    // A trilha encadeia: o destino de um registro é a origem do seguinte.
    const transicoes = logs.map((l) => {
      const m = /: (\w+) → (\w+)$/.exec(l.details ?? "");
      return { de: m?.[1], para: m?.[2] };
    });
    expect(transicoes[0].de).toBe("AVAILABLE");
    expect(transicoes[1].de).toBe(transicoes[0].para);

    // E o estado final é o destino do último registro, não um terceiro valor.
    const final = await prisma.cTOPort.findUniqueOrThrow({
      where: { id: porta.id },
    });
    expect(final.administrativeState).toBe(transicoes[1].para);
  });

  it("expansões para alvos diferentes deixam estado coerente", async () => {
    const cto = await novaCto();

    await Promise.allSettled([
      changeCtoCapacity(fixture.companyA.id, fixture.adminA.id, cto.id, 16),
      changeCtoCapacity(fixture.companyA.id, fixture.adminA.id, cto.id, 32),
    ]);

    const atual = await prisma.cTO.findUniqueOrThrow({ where: { id: cto.id } });
    const portas = await portasDe(cto.id);

    // O vencedor pode ser qualquer um dos dois; o que não pode é o estado
    // híbrido — capacidade de um e portas de outro.
    expect([16, 32]).toContain(atual.capacity);
    expect(portas.length).toBeGreaterThanOrEqual(atual.capacity);
    expect(new Set(portas.map((p) => p.number)).size).toBe(portas.length);
    // Toda posição de 1 até a capacidade existe.
    for (let n = 1; n <= atual.capacity; n += 1) {
      expect(portas.some((p) => p.number === n)).toBe(true);
    }
  });
});

describe("CTO1-19 / CTO1-20 · foto da caixa", () => {
  it("o GPS do EXIF não sobrevive à persistência", async () => {
    const cto = await novaCto();
    const original = montarJpeg({ comGps: true, orientacao: 6 });

    // Controle positivo: o fixture REALMENTE tem coordenada.
    const antes = lerExif(original);
    expect(antes.tagsGps).toContain(GPS_TAGS.latitude);
    expect(antes.tagsGps).toContain(GPS_TAGS.longitude);

    const publico = await setCtoPhoto(
      fixture.companyA.id,
      fixture.adminA.id,
      cto.id,
      { data: original, declaredMimeType: "image/jpeg" },
    );
    expect(publico.hasPhoto).toBe(true);

    const linha = await prisma.cTO.findUniqueOrThrow({ where: { id: cto.id } });
    const gravado = await getFileStorage().get(linha.photoStorageKey!);
    const depois = lerExif(gravado);

    expect(depois.tagsGps).toEqual([]);
    // A orientação sobrevive: sem ela a foto é exibida deitada.
    expect(depois.orientacao).toBe(6);
  });

  it("arquivo que não é imagem é recusado", async () => {
    const cto = await novaCto();
    await expect(
      setCtoPhoto(fixture.companyA.id, fixture.adminA.id, cto.id, {
        data: Buffer.from("<svg onload=alert(1)></svg>"),
        declaredMimeType: "image/png",
      }),
    ).rejects.toMatchObject({ status: 400 });

    const linha = await prisma.cTO.findUniqueOrThrow({ where: { id: cto.id } });
    expect(linha.photoStorageKey).toBeNull();
  });

  it("tipo declarado que não bate com os bytes é recusado", async () => {
    const cto = await novaCto();
    await expect(
      setCtoPhoto(fixture.companyA.id, fixture.adminA.id, cto.id, {
        data: montarJpeg({ comGps: false }),
        declaredMimeType: "image/png",
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("a chave é construída pelo servidor e começa pelo tenant", async () => {
    const cto = await novaCto();
    await setCtoPhoto(fixture.companyA.id, fixture.adminA.id, cto.id, {
      data: montarJpeg({ comGps: false }),
      declaredMimeType: "image/jpeg",
    });
    const linha = await prisma.cTO.findUniqueOrThrow({ where: { id: cto.id } });
    expect(linha.photoStorageKey).toMatch(
      new RegExp(`^${fixture.companyA.id}/${cto.id}/[a-z0-9]+\\.jpg$`),
    );
  });

  it("CTO1PV-PHOTO-02/03/04 · a segunda foto substitui a primeira", async () => {
    /*
      A substituição já funcionava quando o achado da validação humana chegou —
      o que faltava era a tela dizer isso. Estes testes fixam o comportamento do
      servidor para que ele continue verdadeiro enquanto a UX evolui.
    */
    const cto = await novaCto();
    const primeira = montarJpeg({ comGps: true, orientacao: 1 });
    await setCtoPhoto(fixture.companyA.id, fixture.adminA.id, cto.id, {
      data: primeira,
      declaredMimeType: "image/jpeg",
    });
    const chaveA = (
      await prisma.cTO.findUniqueOrThrow({ where: { id: cto.id } })
    ).photoStorageKey!;
    const bytesA = await getFileStorage().get(chaveA);

    const segunda = montarJpeg({ comGps: true, orientacao: 6 });
    await setCtoPhoto(fixture.companyA.id, fixture.adminA.id, cto.id, {
      data: segunda,
      declaredMimeType: "image/jpeg",
    });
    const chaveB = (
      await prisma.cTO.findUniqueOrThrow({ where: { id: cto.id } })
    ).photoStorageKey!;

    // A referência mudou, e o conteúdo servido mudou junto.
    expect(chaveB).not.toBe(chaveA);
    const bytesB = await getFileStorage().get(chaveB);
    expect(bytesB.equals(bytesA)).toBe(false);

    // UMA referência ativa: a coluna guarda uma chave, não uma lista.
    expect(typeof chaveB).toBe("string");

    // E o GPS continua saindo das duas — a substituição não é atalho para
    // pular a limpeza.
    expect(lerExif(bytesB).tagsGps).toEqual([]);
  });

  it("CTO1PV-PHOTO-06 · falha no envio preserva a foto anterior", async () => {
    const cto = await novaCto();
    await setCtoPhoto(fixture.companyA.id, fixture.adminA.id, cto.id, {
      data: montarJpeg({ comGps: false }),
      declaredMimeType: "image/jpeg",
    });
    const antes = (await prisma.cTO.findUniqueOrThrow({ where: { id: cto.id } }))
      .photoStorageKey;

    await expect(
      setCtoPhoto(fixture.companyA.id, fixture.adminA.id, cto.id, {
        data: Buffer.from("isto não é uma imagem"),
        declaredMimeType: "image/jpeg",
      }),
    ).rejects.toMatchObject({ status: 400 });

    // A CTO nunca fica sem foto por causa de uma substituição que falhou.
    const depois = (
      await prisma.cTO.findUniqueOrThrow({ where: { id: cto.id } })
    ).photoStorageKey;
    expect(depois).toBe(antes);
    expect(await getFileStorage().get(depois!)).toBeInstanceOf(Buffer);
  });

  it("a empresa B não envia foto para a CTO de A", async () => {
    const cto = await novaCto();
    await expect(
      setCtoPhoto(fixture.companyB.id, fixture.adminB.id, cto.id, {
        data: montarJpeg({ comGps: false }),
        declaredMimeType: "image/jpeg",
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("inativação preserva tudo", () => {
  it("inativar mantém a CTO e as portas", async () => {
    const cto = await novaCto();
    await setCtoActive(fixture.companyA.id, fixture.adminA.id, cto.id, false);

    const linha = await prisma.cTO.findUniqueOrThrow({ where: { id: cto.id } });
    expect(linha.active).toBe(false);
    expect(await prisma.cTOPort.count({ where: { ctoId: cto.id } })).toBe(8);
  });

  it("a listagem padrão esconde inativa; includeInactive a traz de volta", async () => {
    const cto = await novaCto();
    await setCtoActive(fixture.companyA.id, fixture.adminA.id, cto.id, false);

    expect(await listCompanyCtos(fixture.companyA.id)).toHaveLength(0);
    expect(
      await listCompanyCtos(fixture.companyA.id, { includeInactive: true }),
    ).toHaveLength(1);
  });

  it("o banco recusa apagar CTO que tem portas", async () => {
    // `Restrict` no schema: mesmo um delete escrito por engano esbarra aqui.
    const cto = await novaCto();
    await expect(
      prisma.cTO.delete({ where: { id: cto.id } }),
    ).rejects.toThrow();
  });
});

describe("coordenadas", () => {
  it("as duas juntas, ou nenhuma", async () => {
    await expect(
      novaCto(undefined, undefined, { latitude: -23.5 }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      novaCto(undefined, undefined, { longitude: -46.6 }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("fora da faixa geográfica é recusado", async () => {
    await expect(
      novaCto(undefined, undefined, { latitude: 91, longitude: 0 }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      novaCto(undefined, undefined, { latitude: 0, longitude: 181 }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("CTO sem coordenada é válida", async () => {
    const cto = await novaCto();
    expect(cto.latitude).toBeNull();
    expect(cto.longitude).toBeNull();
  });
});
