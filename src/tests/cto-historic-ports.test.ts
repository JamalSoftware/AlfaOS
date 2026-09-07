import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { POST as portStateRoute } from "@/app/api/ctos/[id]/ports/[portId]/state/route";
import {
  changeCtoCapacity,
  createCto,
  isPortOfferable,
  isPortWithinCapacity,
  setPortAdministrativeState,
} from "@/lib/cto";
import {
  apiRequest,
  createTokenFor,
  seedTestData,
  type TestFixture,
} from "./helpers";

/**
 * # `CTO-1.9` — porta fora da capacidade é histórica e READ-ONLY
 *
 * ## O que motivou a regra
 *
 * O checkpoint final da `CTO-1` reproduziu o estado que ninguém tinha decidido
 * permitir: uma porta acima da capacidade — exibida na tela com o selo "Fora da
 * capacidade" — aceitava `RESERVED`, e essa reserva passava a **bloquear a
 * redução seguinte**. Uma posição que a empresa declarou não oferecer mais
 * decidindo se a capacidade pode mudar.
 *
 * A decisão do dono fechou a pergunta: enquanto estiver fora da capacidade, a
 * porta não aceita mutação administrativa nenhuma. Nem reservar, nem danificar,
 * **nem liberar** — histórico é registro do que houve, e registro não se edita.
 *
 * ## A distinção que estes testes protegem
 *
 * A condição é de FAIXA (`isPortWithinCapacity`), não de ofertabilidade. Uma
 * porta `RESERVED` dentro da capacidade também não é ofertável, e precisa
 * continuar aceitando "Liberar": trocar um predicado pelo outro trancaria toda
 * reserva no lugar, e a tela deixaria de poder desfazer o que ela mesma fez.
 * `CTO1-HIST-06/07/08` existem exatamente para derrubar essa troca.
 */

let fixture: TestFixture;
let adminToken: string;
let adminBToken: string;

beforeEach(async () => {
  fixture = await seedTestData();
  adminToken = await createTokenFor(fixture.adminA.id);
  adminBToken = await createTokenFor(fixture.adminB.id);
  await prisma.company.updateMany({
    where: { id: { in: [fixture.companyA.id, fixture.companyB.id] } },
    data: { ctoNetworkEnabled: true },
  });
});

const ORIGIN = { Origin: "http://localhost" };

/** Uma CTO de 16 portas reduzida a 8: as posições 9..16 viram histórico. */
async function ctoComHistorico(nome = "A16") {
  const cto = await createCto(fixture.companyA.id, fixture.adminA.id, {
    name: nome,
    capacity: 16,
  });
  await changeCtoCapacity(fixture.companyA.id, fixture.adminA.id, cto.id, 8);
  return cto;
}

async function porta(ctoId: string, numero: number) {
  return prisma.cTOPort.findFirstOrThrow({ where: { ctoId, number: numero } });
}

async function mudar(
  ctoId: string,
  portId: string,
  state: "AVAILABLE" | "RESERVED" | "DAMAGED",
) {
  return setPortAdministrativeState(
    fixture.companyA.id,
    fixture.adminA.id,
    ctoId,
    portId,
    state,
  );
}

async function auditoriaDePorta(portId: string) {
  return prisma.auditLog.count({
    where: { entity: "CTOPort", entityId: portId, action: "CTO.PORT_STATE_CHANGED" },
  });
}

// ---------------------------------------------------------------------------

describe("CTO1-HIST · a faixa é um predicado só", () => {
  it("`isPortWithinCapacity` responde SÓ pela posição", () => {
    expect(isPortWithinCapacity({ number: 8 }, 8)).toBe(true);
    expect(isPortWithinCapacity({ number: 9 }, 8)).toBe(false);
    expect(isPortWithinCapacity({ number: 1 }, 8)).toBe(true);
  });

  it("uma porta RESERVED dentro da capacidade está NA faixa e não é ofertável", () => {
    const p = { number: 3, administrativeState: "RESERVED" as const };
    /*
      As duas respostas são diferentes de propósito, e é essa diferença que
      autoriza "Liberar" numa porta reservada. Um predicado só não conseguiria
      dizer as duas coisas.
    */
    expect(isPortWithinCapacity(p, 8)).toBe(true);
    expect(isPortOfferable(p, 8)).toBe(false);
  });

  it("fora da capacidade nunca é ofertável, qualquer que seja o estado", () => {
    for (const estado of ["AVAILABLE", "RESERVED", "DAMAGED"] as const) {
      expect(
        isPortOfferable({ number: 12, administrativeState: estado }, 8),
      ).toBe(false);
    }
  });
});

describe("CTO1-HIST · porta histórica não aceita mutação", () => {
  it("CTO1-HIST-01 — fora da capacidade não vira RESERVED", async () => {
    const cto = await ctoComHistorico();
    const historica = await porta(cto.id, 12);

    await expect(mudar(cto.id, historica.id, "RESERVED")).rejects.toMatchObject(
      { status: 409 },
    );
    expect(
      (await prisma.cTOPort.findUniqueOrThrow({ where: { id: historica.id } }))
        .administrativeState,
    ).toBe("AVAILABLE");
  });

  it("CTO1-HIST-02 — fora da capacidade não vira DAMAGED", async () => {
    const cto = await ctoComHistorico();
    const historica = await porta(cto.id, 16);

    await expect(mudar(cto.id, historica.id, "DAMAGED")).rejects.toMatchObject({
      status: 409,
    });
    expect(
      (await prisma.cTOPort.findUniqueOrThrow({ where: { id: historica.id } }))
        .administrativeState,
    ).toBe("AVAILABLE");
  });

  it("CTO1-HIST-02b — nem 'Liberar', nem o estado que ela já tem", async () => {
    const cto = await ctoComHistorico();
    const historica = await porta(cto.id, 10);

    /*
      `AVAILABLE` sobre uma porta que já está `AVAILABLE` seria um no-op — e um
      no-op que responde 200 faria a tela concluir que a ação existe. A recusa
      não depende do estado guardado: read-only é read-only.
    */
    await expect(mudar(cto.id, historica.id, "AVAILABLE")).rejects.toMatchObject(
      { status: 409 },
    );
  });

  it("CTO1-HIST-03 — a API direta também recusa, com 409 e sem vazar nada", async () => {
    const cto = await ctoComHistorico();
    const historica = await porta(cto.id, 11);

    const res = await portStateRoute(
      apiRequest(
        `/api/ctos/${cto.id}/ports/${historica.id}/state`,
        {
          method: "POST",
          headers: { ...ORIGIN },
          body: { administrativeState: "RESERVED" },
        },
        adminToken,
      ),
      { params: { id: cto.id, portId: historica.id } },
    );

    expect(res.status).toBe(409);
    const corpo = await res.text();
    expect(corpo).toContain("fora da capacidade atual");
    // A mensagem nomeia a POSIÇÃO, que é o que resolve o problema, e nada mais.
    expect(corpo).toContain("11");
    expect(corpo).not.toContain(fixture.companyA.id);
    expect(corpo).not.toContain(cto.id);
    expect(corpo).not.toContain(historica.id);
    expect(corpo.toLowerCase()).not.toContain("select");
    expect(corpo.toLowerCase()).not.toContain("prisma");
  });

  it("CTO1-HIST-04 — a recusa não escreve NADA na linha", async () => {
    const cto = await ctoComHistorico();
    const historica = await porta(cto.id, 13);
    const antes = await prisma.cTOPort.findUniqueOrThrow({
      where: { id: historica.id },
    });

    await expect(mudar(cto.id, historica.id, "DAMAGED")).rejects.toThrow();

    const depois = await prisma.cTOPort.findUniqueOrThrow({
      where: { id: historica.id },
    });
    expect(depois.administrativeState).toBe(antes.administrativeState);
    expect(depois.updatedAt.getTime()).toBe(antes.updatedAt.getTime());
    // E a CTO também não se mexeu: a transação inteira voltou.
    const caixa = await prisma.cTO.findUniqueOrThrow({ where: { id: cto.id } });
    expect(caixa.capacity).toBe(8);
  });

  it("CTO1-HIST-05 — a recusa não deixa AuditLog de sucesso", async () => {
    const cto = await ctoComHistorico();
    const historica = await porta(cto.id, 14);
    const antes = await auditoriaDePorta(historica.id);

    await expect(mudar(cto.id, historica.id, "RESERVED")).rejects.toThrow();

    expect(await auditoriaDePorta(historica.id)).toBe(antes);
    // Controle POSITIVO: a mesma chamada numa porta dentro da capacidade
    // registra — sem ele, o zero acima poderia ser auditoria que não funciona.
    const operavel = await porta(cto.id, 2);
    await mudar(cto.id, operavel.id, "RESERVED");
    expect(await auditoriaDePorta(operavel.id)).toBe(1);
  });
});

describe("CTO1-HIST · a porta operável continua operável", () => {
  it("CTO1-HIST-06 — AVAILABLE dentro da capacidade vira RESERVED", async () => {
    const cto = await ctoComHistorico();
    const p = await porta(cto.id, 5);
    await mudar(cto.id, p.id, "RESERVED");
    expect(
      (await prisma.cTOPort.findUniqueOrThrow({ where: { id: p.id } }))
        .administrativeState,
    ).toBe("RESERVED");
  });

  it("CTO1-HIST-07 — RESERVED dentro da capacidade pode ser liberada", async () => {
    const cto = await ctoComHistorico();
    const p = await porta(cto.id, 4);
    await mudar(cto.id, p.id, "RESERVED");
    await mudar(cto.id, p.id, "AVAILABLE");
    expect(
      (await prisma.cTOPort.findUniqueOrThrow({ where: { id: p.id } }))
        .administrativeState,
    ).toBe("AVAILABLE");
  });

  it("CTO1-HIST-08 — DAMAGED dentro da capacidade pode ser liberada", async () => {
    const cto = await ctoComHistorico();
    const p = await porta(cto.id, 6);
    await mudar(cto.id, p.id, "DAMAGED");
    await mudar(cto.id, p.id, "AVAILABLE");
    expect(
      (await prisma.cTOPort.findUniqueOrThrow({ where: { id: p.id } }))
        .administrativeState,
    ).toBe("AVAILABLE");
  });
});

describe("CTO1-HIST · redução, reexpansão e volta da operação", () => {
  it("CTO1-HIST-09 — a redução preserva as linhas históricas", async () => {
    const cto = await ctoComHistorico();
    const portas = await prisma.cTOPort.findMany({
      where: { ctoId: cto.id },
      orderBy: { number: "asc" },
    });
    expect(portas.map((p) => p.number)).toEqual(
      Array.from({ length: 16 }, (_, i) => i + 1),
    );
    // A redução válida exige que as de cima estejam AVAILABLE, então é assim
    // que elas ficam congeladas — e é esse o estado que a regra preserva.
    expect(
      portas.filter((p) => p.number > 8).every((p) => p.administrativeState === "AVAILABLE"),
    ).toBe(true);
  });

  it("CTO1-HIST-10 — a reexpansão reutiliza as MESMAS linhas", async () => {
    const cto = await ctoComHistorico();
    const antes = await prisma.cTOPort.findMany({
      where: { ctoId: cto.id },
      select: { id: true, number: true, createdAt: true },
      orderBy: { number: "asc" },
    });

    await changeCtoCapacity(fixture.companyA.id, fixture.adminA.id, cto.id, 16);

    const depois = await prisma.cTOPort.findMany({
      where: { ctoId: cto.id },
      select: { id: true, number: true, createdAt: true },
      orderBy: { number: "asc" },
    });
    expect(depois.length).toBe(16);
    // Identidade de LINHA, não só contagem: ids e `createdAt` iguais provam
    // reutilização; recriação daria ids novos com a mesma contagem.
    expect(depois.map((p) => p.id)).toEqual(antes.map((p) => p.id));
    expect(depois.map((p) => p.createdAt.getTime())).toEqual(
      antes.map((p) => p.createdAt.getTime()),
    );
  });

  it("CTO1-HIST-11 — depois da reexpansão a mutação volta a funcionar", async () => {
    const cto = await ctoComHistorico();
    const p14 = await porta(cto.id, 14);

    await expect(mudar(cto.id, p14.id, "RESERVED")).rejects.toMatchObject({
      status: 409,
    });

    await changeCtoCapacity(fixture.companyA.id, fixture.adminA.id, cto.id, 16);

    await mudar(cto.id, p14.id, "RESERVED");
    const depois = await prisma.cTOPort.findUniqueOrThrow({
      where: { id: p14.id },
    });
    expect(depois.administrativeState).toBe("RESERVED");
    // É a MESMA linha, não uma recriada com o mesmo número.
    expect(depois.id).toBe(p14.id);
  });
});

describe("CTO1-HIST-12 · concorrência entre capacidade e estado", () => {
  it("reduzir e reservar ao mesmo tempo nunca deixa porta histórica mutada", async () => {
    /*
      A janela real: as duas operações leem a capacidade 16, as duas concluem
      que a porta 12 está dentro, e o resultado seria uma porta histórica
      reservada — o estado que esta regra existe para não produzir.

      `lockCto` serializa as duas por caixa, e a comparação usa a capacidade que
      veio do próprio lock. Qualquer ordem de chegada é aceitável; o que NÃO
      pode existir é o desfecho híbrido.
    */
    for (let rodada = 0; rodada < 6; rodada += 1) {
      const cto = await createCto(fixture.companyA.id, fixture.adminA.id, {
        name: `CORRIDA-${rodada}`,
        capacity: 16,
      });
      const p12 = await porta(cto.id, 12);

      await Promise.allSettled([
        changeCtoCapacity(fixture.companyA.id, fixture.adminA.id, cto.id, 8),
        mudar(cto.id, p12.id, "RESERVED"),
      ]);

      const caixa = await prisma.cTO.findUniqueOrThrow({ where: { id: cto.id } });
      const porta12 = await prisma.cTOPort.findUniqueOrThrow({
        where: { id: p12.id },
      });

      // A asserção PROÍBE o desfecho ruim, em vez de tolerá-lo: fora da
      // capacidade e reservada não podem coexistir em nenhuma ordem.
      const historicaEMutada =
        porta12.number > caixa.capacity &&
        porta12.administrativeState !== "AVAILABLE";
      expect(historicaEMutada).toBe(false);

      // E o par continua coerente: ou a redução venceu (8, AVAILABLE), ou a
      // reserva venceu e a redução foi recusada (16, RESERVED).
      expect([8, 16]).toContain(caixa.capacity);
      if (caixa.capacity === 16) {
        expect(porta12.administrativeState).toBe("RESERVED");
      }
    }
  });

  it("a porta histórica de OUTRO tenant continua respondendo 404, não 409", async () => {
    /*
      A ordem das verificações importa: tenant primeiro. Um 409 aqui confirmaria
      que a CTO e a porta existem — a mensagem de faixa é mais informativa que o
      "não encontrada", e por isso ela não pode chegar antes do isolamento.
    */
    const cto = await ctoComHistorico();
    const historica = await porta(cto.id, 12);

    const res = await portStateRoute(
      apiRequest(
        `/api/ctos/${cto.id}/ports/${historica.id}/state`,
        {
          method: "POST",
          headers: { ...ORIGIN },
          body: { administrativeState: "RESERVED" },
        },
        adminBToken,
      ),
      { params: { id: cto.id, portId: historica.id } },
    );
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("capacidade");
  });
});
