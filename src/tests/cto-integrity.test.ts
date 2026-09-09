import { beforeEach, describe, expect, it } from "vitest";
import { POST as capacityRoute } from "@/app/api/ctos/[id]/capacity/route";
import { POST as portStateRoute } from "@/app/api/ctos/[id]/ports/[portId]/state/route";
import {
  changeCtoCapacity,
  createCto,
  setPortAdministrativeState,
} from "@/lib/cto";
import {
  connectCustomerToPort,
  moveCustomerToPort,
  type ConnectionContext,
} from "@/lib/cto-connections";
import { getOperationalCtoDetail } from "@/lib/cto-read-model";
import { DomainError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import {
  apiRequest,
  createTokenFor,
  seedTestData,
  type TestFixture,
} from "./helpers";

/**
 * # `CTO-2.6` — integridade entre vínculo, estado da porta e capacidade
 *
 * Duas proteções que faltavam, e as duas são sobre o mesmo tipo de erro: uma
 * decisão administrativa passar por cima de um cliente que está conectado.
 *
 * A regra do estado é sobre o **ALVO**, nunca sobre o estado atual — e é isso
 * que impede o beco sem saída de uma linha legada `ativa + RESERVED`.
 *
 * As fixturas são fictícias.
 */

let fixture: TestFixture;
let ctx: ConnectionContext;

beforeEach(async () => {
  fixture = await seedTestData();
  await prisma.company.updateMany({
    where: { id: { in: [fixture.companyA.id, fixture.companyB.id] } },
    data: { ctoNetworkEnabled: true },
  });
  ctx = {
    companyId: fixture.companyA.id,
    provenance: { source: "WEB", actorUserId: fixture.adminA.id },
  };
});

// --- ajudantes --------------------------------------------------------------

const novaCto = (nome: string, capacidade = 8) =>
  createCto(fixture.companyA.id, fixture.adminA.id, {
    name: nome,
    capacity: capacidade,
  });

const porta = (ctoId: string, numero: number) =>
  prisma.cTOPort.findFirstOrThrow({ where: { ctoId, number: numero } });

const novoCliente = (nome: string) =>
  prisma.customer.create({
    data: { companyId: fixture.companyA.id, name: nome },
  });

const estado = (ctoId: string, numero: number) =>
  porta(ctoId, numero).then((p) => p.administrativeState);

const capacidade = (ctoId: string) =>
  prisma.cTO
    .findUniqueOrThrow({ where: { id: ctoId }, select: { capacity: true } })
    .then((c) => c.capacity);

const ativosNaPorta = (ctoPortId: string) =>
  prisma.customerNetworkConnection.count({
    where: { ctoPortId, disconnectedAt: null },
  });

const mudarEstado = (
  ctoId: string,
  portId: string,
  alvo: "AVAILABLE" | "RESERVED" | "DAMAGED",
) =>
  setPortAdministrativeState(
    fixture.companyA.id,
    fixture.adminA.id,
    ctoId,
    portId,
    alvo,
  );

const reduzir = (ctoId: string, nova: number) =>
  changeCtoCapacity(fixture.companyA.id, fixture.adminA.id, ctoId, nova);

async function esperaConflito(run: () => Promise<unknown>, trecho?: string) {
  await expect(run()).rejects.toSatisfy((error) => {
    if (!(error instanceof DomainError)) return false;
    if (error.status !== 409) return false;
    return trecho === undefined || error.message.includes(trecho);
  });
}

/**
 * Cria o estado LEGADO `ativa + RESERVED` por escrita direta.
 *
 * Tem de ser direta: depois desta fase o serviço recusa produzi-lo, e é
 * exatamente por isso que a saída dele precisa ser testada — dados antigos
 * existem e não podem ficar presos.
 */
async function legadoReservadaOcupada(ctoId: string, numero: number) {
  const p = await porta(ctoId, numero);
  const cliente = await novoCliente(`Cliente legado ${numero}`);
  await connectCustomerToPort(ctx, {
    customerId: cliente.id,
    ctoPortId: p.id,
  });
  await prisma.cTOPort.update({
    where: { id: p.id },
    data: { administrativeState: "RESERVED" },
  });
  return { port: p, customerId: cliente.id };
}

// ---------------------------------------------------------------------------
// Estado administrativo × vínculo ativo
// ---------------------------------------------------------------------------

describe("CTO-2.6 · alvo RESERVED com vínculo ativo", () => {
  it("INT-01 AVAILABLE ocupada → RESERVED recusa com 409", async () => {
    const cto = await novaCto("CX-INT-01");
    const p = await porta(cto.id, 3);
    const cliente = await novoCliente("Cliente INT-01");
    await connectCustomerToPort(ctx, {
      customerId: cliente.id,
      ctoPortId: p.id,
    });

    await esperaConflito(
      () => mudarEstado(cto.id, p.id, "RESERVED"),
      "ocupada por um cliente",
    );

    expect(await estado(cto.id, 3)).toBe("AVAILABLE");
    expect(await ativosNaPorta(p.id)).toBe(1);
  });

  it("INT-02 DAMAGED ocupada → RESERVED recusa com 409", async () => {
    const cto = await novaCto("CX-INT-02");
    const p = await porta(cto.id, 3);
    const cliente = await novoCliente("Cliente INT-02");
    await connectCustomerToPort(ctx, {
      customerId: cliente.id,
      ctoPortId: p.id,
    });
    await mudarEstado(cto.id, p.id, "DAMAGED");

    await esperaConflito(() => mudarEstado(cto.id, p.id, "RESERVED"));

    expect(await estado(cto.id, 3)).toBe("DAMAGED");
    expect(await ativosNaPorta(p.id)).toBe(1);
  });

  it("INT-03 legado RESERVED ocupada → AVAILABLE é PERMITIDO", async () => {
    const cto = await novaCto("CX-INT-03");
    const { port } = await legadoReservadaOcupada(cto.id, 4);

    await mudarEstado(cto.id, port.id, "AVAILABLE");

    // Sem saída, a linha legada ficaria presa para sempre. A regra é sobre o
    // ALVO, e por isso ela tem porta de saída.
    expect(await estado(cto.id, 4)).toBe("AVAILABLE");
    expect(await ativosNaPorta(port.id)).toBe(1);
  });

  it("INT-04 legado RESERVED ocupada → DAMAGED é PERMITIDO", async () => {
    const cto = await novaCto("CX-INT-04");
    const { port } = await legadoReservadaOcupada(cto.id, 4);

    await mudarEstado(cto.id, port.id, "DAMAGED");

    expect(await estado(cto.id, 4)).toBe("DAMAGED");
    expect(await ativosNaPorta(port.id)).toBe(1);
  });

  it("INT-05 AVAILABLE ocupada → DAMAGED é PERMITIDO", async () => {
    const cto = await novaCto("CX-INT-05");
    const p = await porta(cto.id, 2);
    const cliente = await novoCliente("Cliente INT-05");
    await connectCustomerToPort(ctx, {
      customerId: cliente.id,
      ctoPortId: p.id,
    });

    await mudarEstado(cto.id, p.id, "DAMAGED");

    // O cabo quebra com o cliente ligado: é situação real de campo.
    expect(await estado(cto.id, 2)).toBe("DAMAGED");
    expect(await ativosNaPorta(p.id)).toBe(1);
  });

  it("INT-06 DAMAGED ocupada → AVAILABLE é PERMITIDO", async () => {
    const cto = await novaCto("CX-INT-06");
    const p = await porta(cto.id, 2);
    const cliente = await novoCliente("Cliente INT-06");
    await connectCustomerToPort(ctx, {
      customerId: cliente.id,
      ctoPortId: p.id,
    });
    await mudarEstado(cto.id, p.id, "DAMAGED");

    await mudarEstado(cto.id, p.id, "AVAILABLE");

    expect(await estado(cto.id, 2)).toBe("AVAILABLE");
  });

  it("INT-07 porta LIVRE continua podendo ser reservada", async () => {
    const cto = await novaCto("CX-INT-07");
    const p = await porta(cto.id, 5);

    // Controle positivo: sem a regra o teste inteiro poderia passar por vazio.
    await mudarEstado(cto.id, p.id, "RESERVED");
    expect(await estado(cto.id, 5)).toBe("RESERVED");
  });

  it("INT-08 vínculo ENCERRADO não bloqueia a reserva", async () => {
    const cto = await novaCto("CX-INT-08");
    const p = await porta(cto.id, 6);
    const cliente = await novoCliente("Cliente INT-08");
    const vinculo = await connectCustomerToPort(ctx, {
      customerId: cliente.id,
      ctoPortId: p.id,
    });
    const { disconnectCustomer } = await import("@/lib/cto-connections");
    await disconnectCustomer(ctx, {
      customerId: cliente.id,
      expectedConnectionId: vinculo.id,
    });

    await mudarEstado(cto.id, p.id, "RESERVED");

    // O histórico continua lá — é ocupação ATIVA que bloqueia, não passado.
    expect(await estado(cto.id, 6)).toBe("RESERVED");
    expect(
      await prisma.customerNetworkConnection.count({
        where: { ctoPortId: p.id },
      }),
    ).toBe(1);
  });

  it("INT-09 legado ocupado pedindo RESERVED de novo recebe 409, não 200 mudo", async () => {
    const cto = await novaCto("CX-INT-09");
    const { port } = await legadoReservadaOcupada(cto.id, 3);

    // Um `200` anunciaria que reservar está disponível, o que é falso.
    await esperaConflito(() => mudarEstado(cto.id, port.id, "RESERVED"));
    expect(await estado(cto.id, 3)).toBe("RESERVED");
  });

  it("INT-10 a recusa não vaza nada além do número da posição", async () => {
    const cto = await novaCto("CX-INT-10");
    const p = await porta(cto.id, 7);
    const cliente = await novoCliente("Fulano Que Nao Deve Aparecer");
    await connectCustomerToPort(ctx, {
      customerId: cliente.id,
      ctoPortId: p.id,
    });

    let mensagem = "";
    try {
      await mudarEstado(cto.id, p.id, "RESERVED");
    } catch (error) {
      mensagem = (error as Error).message;
    }

    expect(mensagem).toContain("porta 7");
    for (const proibido of [
      "Fulano Que Nao Deve Aparecer",
      cliente.id,
      p.id,
      cto.id,
      fixture.companyA.id,
    ]) {
      expect(mensagem).not.toContain(proibido);
    }
  });
});

// ---------------------------------------------------------------------------
// Capacidade × vínculo ativo
// ---------------------------------------------------------------------------

describe("CTO-2.6 · redução de capacidade com vínculo ativo", () => {
  it("CAP-01 reduzir sem vínculo acima do limite é PERMITIDO", async () => {
    const cto = await novaCto("CX-CAP-01", 8);
    const p = await porta(cto.id, 2);
    const cliente = await novoCliente("Cliente CAP-01");
    await connectCustomerToPort(ctx, {
      customerId: cliente.id,
      ctoPortId: p.id,
    });

    await reduzir(cto.id, 4);

    // O cliente está na 2, dentro do novo limite: nada a bloquear.
    expect(await capacidade(cto.id)).toBe(4);
    expect(await ativosNaPorta(p.id)).toBe(1);
  });

  it("CAP-02 reduzir com vínculo acima do limite recusa com 409", async () => {
    const cto = await novaCto("CX-CAP-02", 8);
    const p = await porta(cto.id, 8);
    const cliente = await novoCliente("Cliente CAP-02");
    const vinculo = await connectCustomerToPort(ctx, {
      customerId: cliente.id,
      ctoPortId: p.id,
    });

    await esperaConflito(() => reduzir(cto.id, 4), "cliente conectado");

    // CAP-03 e CAP-04, no mesmo cenário: nada parcial.
    expect(await capacidade(cto.id)).toBe(8);
    const linha = await prisma.customerNetworkConnection.findUniqueOrThrow({
      where: { id: vinculo.id },
    });
    expect(linha.disconnectedAt).toBeNull();
    expect(linha.ctoPortId).toBe(p.id);
    expect(await prisma.cTOPort.count({ where: { ctoId: cto.id } })).toBe(8);
  });

  it("CAP-05 a recusa nomeia TODAS as posições ocupadas, em ordem", async () => {
    const cto = await novaCto("CX-CAP-05", 8);
    for (const numero of [7, 5, 8]) {
      const p = await porta(cto.id, numero);
      const cliente = await novoCliente(`Cliente ${numero}`);
      await connectCustomerToPort(ctx, {
        customerId: cliente.id,
        ctoPortId: p.id,
      });
    }

    let mensagem = "";
    try {
      await reduzir(cto.id, 4);
    } catch (error) {
      mensagem = (error as Error).message;
    }

    expect(mensagem).toContain("as portas 5, 7, 8 estão com clientes conectados");
  });

  it("CAP-06 concordância no singular quando é uma só", async () => {
    const cto = await novaCto("CX-CAP-06", 8);
    const p = await porta(cto.id, 6);
    const cliente = await novoCliente("Cliente CAP-06");
    await connectCustomerToPort(ctx, {
      customerId: cliente.id,
      ctoPortId: p.id,
    });

    let mensagem = "";
    try {
      await reduzir(cto.id, 4);
    } catch (error) {
      mensagem = (error as Error).message;
    }
    expect(mensagem).toContain("a porta 6 está com um cliente conectado");
    expect(mensagem).not.toContain("as portas");
  });

  it("CAP-07 o cliente conectado é reportado ANTES do estado administrativo", async () => {
    const cto = await novaCto("CX-CAP-07", 8);
    const ocupada = await porta(cto.id, 8);
    const cliente = await novoCliente("Cliente CAP-07");
    await connectCustomerToPort(ctx, {
      customerId: cliente.id,
      ctoPortId: ocupada.id,
    });
    await mudarEstado(cto.id, (await porta(cto.id, 7)).id, "DAMAGED");

    let mensagem = "";
    try {
      await reduzir(cto.id, 4);
    } catch (error) {
      mensagem = (error as Error).message;
    }

    // Estado se resolve num clique; cliente conectado exige decisão de operação.
    expect(mensagem).toContain("cliente conectado");
    expect(mensagem).not.toContain("danificada");
  });

  it("CAP-08 vínculo ENCERRADO acima do limite não bloqueia", async () => {
    const cto = await novaCto("CX-CAP-08", 8);
    const p = await porta(cto.id, 8);
    const cliente = await novoCliente("Cliente CAP-08");
    const vinculo = await connectCustomerToPort(ctx, {
      customerId: cliente.id,
      ctoPortId: p.id,
    });
    const { disconnectCustomer } = await import("@/lib/cto-connections");
    await disconnectCustomer(ctx, {
      customerId: cliente.id,
      expectedConnectionId: vinculo.id,
    });

    await reduzir(cto.id, 4);

    expect(await capacidade(cto.id)).toBe(4);
    // A linha histórica sobrevive à redução: é a resposta para "quem já esteve
    // na porta 8?".
    expect(
      await prisma.customerNetworkConnection.count({
        where: { ctoPortId: p.id },
      }),
    ).toBe(1);
  });

  it("CAP-09 a regra da CTO-1 continua valendo sozinha", async () => {
    const cto = await novaCto("CX-CAP-09", 8);
    await mudarEstado(cto.id, (await porta(cto.id, 6)).id, "RESERVED");

    await esperaConflito(
      () => reduzir(cto.id, 4),
      "reservada ou danificada",
    );
    expect(await capacidade(cto.id)).toBe(8);
  });

  it("CAP-10 aumentar capacidade nunca é bloqueado por vínculo", async () => {
    const cto = await novaCto("CX-CAP-10", 4);
    const p = await porta(cto.id, 4);
    const cliente = await novoCliente("Cliente CAP-10");
    await connectCustomerToPort(ctx, {
      customerId: cliente.id,
      ctoPortId: p.id,
    });

    await reduzir(cto.id, 16);
    expect(await capacidade(cto.id)).toBe(16);
    expect(await ativosNaPorta(p.id)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Concorrência
// ---------------------------------------------------------------------------

describe("CTO-2.6 · concorrência", () => {
  /**
   * Toda corrida roda várias vezes, e nas DUAS ordens.
   *
   * A primeira versão deste bloco rodava só uma. Disparadas juntas, a operação
   * administrativa sempre vencia o lock, porque o `CONNECT` faz mais trabalho
   * antes dele — trava o cliente, resolve a porta, e só então trava a caixa. A
   * sabotagem que remove a regra do alvo `RESERVED` **passou** nessas corridas,
   * e a culpa era do teste: a ordem perigosa nunca acontecia.
   *
   * A ordem B dá ao vínculo uma dianteira curta, o bastante para ele estar com
   * o lock quando a administrativa chega. Ela então BLOQUEIA no `FOR UPDATE` e
   * só lê depois do commit — que é exatamente a janela que a regra existe para
   * fechar.
   *
   * Cada corrida conta quantas vezes o vínculo venceu e exige pelo menos uma:
   * sem isso, o teste voltaria a provar metade do que afirma.
   */
  const RODADAS = 4;
  const DIANTEIRA_MS = 25;

  const dianteira = () =>
    new Promise((resolve) => setTimeout(resolve, DIANTEIRA_MS));

  it("RACE-01 CONNECT na porta 8 × redução para 4, nas duas ordens", async () => {
    let vinculoVenceu = 0;

    for (let rodada = 0; rodada < RODADAS * 2; rodada += 1) {
      const vinculoPrimeiro = rodada % 2 === 1;
      const cto = await novaCto(`CX-RACE-01-${rodada}`, 8);
      const p = await porta(cto.id, 8);
      const cliente = await novoCliente(`Cliente RACE-01-${rodada}`);

      const conectando = connectCustomerToPort(ctx, {
        customerId: cliente.id,
        ctoPortId: p.id,
      });
      if (vinculoPrimeiro) await dianteira();
      const reduzindo = reduzir(cto.id, 4);
      const [c, r] = await Promise.allSettled([conectando, reduzindo]);

      const capFinal = await capacidade(cto.id);
      const ativos = await ativosNaPorta(p.id);

      // O desfecho PROIBIDO, e não um "pelo menos um deu certo".
      expect(capFinal >= 8 || ativos === 0).toBe(true);
      expect(c.status === "fulfilled" || r.status === "fulfilled").toBe(true);
      if (c.status === "fulfilled") vinculoVenceu += 1;
    }

    expect(vinculoVenceu).toBeGreaterThan(0);
  });

  it("RACE-02 CONNECT × marcar a mesma porta como RESERVED, nas duas ordens", async () => {
    let vinculoVenceu = 0;

    for (let rodada = 0; rodada < RODADAS * 2; rodada += 1) {
      const vinculoPrimeiro = rodada % 2 === 1;
      const cto = await novaCto(`CX-RACE-02-${rodada}`, 8);
      const p = await porta(cto.id, 3);
      const cliente = await novoCliente(`Cliente RACE-02-${rodada}`);

      const conectando = connectCustomerToPort(ctx, {
        customerId: cliente.id,
        ctoPortId: p.id,
      });
      if (vinculoPrimeiro) await dianteira();
      const reservando = mudarEstado(cto.id, p.id, "RESERVED");
      const [c] = await Promise.allSettled([conectando, reservando]);

      const estadoFinal = await estado(cto.id, 3);
      const ativos = await ativosNaPorta(p.id);
      // Nunca vínculo ativo numa porta reservada por corrida.
      expect(estadoFinal !== "RESERVED" || ativos === 0).toBe(true);
      if (c.status === "fulfilled") vinculoVenceu += 1;
    }

    expect(vinculoVenceu).toBeGreaterThan(0);
  });

  it("RACE-03 MOVE para a porta 8 × redução para 4, nas duas ordens", async () => {
    let vinculoVenceu = 0;

    for (let rodada = 0; rodada < RODADAS * 2; rodada += 1) {
      const vinculoPrimeiro = rodada % 2 === 1;
      const cto = await novaCto(`CX-RACE-03-${rodada}`, 8);
      const origem = await porta(cto.id, 1);
      const destino = await porta(cto.id, 8);
      const cliente = await novoCliente(`Cliente RACE-03-${rodada}`);
      const vinculo = await connectCustomerToPort(ctx, {
        customerId: cliente.id,
        ctoPortId: origem.id,
      });

      const movendo = moveCustomerToPort(ctx, {
        customerId: cliente.id,
        expectedConnectionId: vinculo.id,
        targetCtoPortId: destino.id,
      });
      if (vinculoPrimeiro) await dianteira();
      const reduzindo = reduzir(cto.id, 4);
      const [m] = await Promise.allSettled([movendo, reduzindo]);

      const capFinal = await capacidade(cto.id);
      const ativosNoDestino = await ativosNaPorta(destino.id);
      expect(capFinal >= 8 || ativosNoDestino === 0).toBe(true);
      // O cliente nunca some no meio: ele está em algum lugar.
      expect(
        await prisma.customerNetworkConnection.count({
          where: { customerId: cliente.id, disconnectedAt: null },
        }),
      ).toBe(1);
      if (m.status === "fulfilled") vinculoVenceu += 1;
    }

    expect(vinculoVenceu).toBeGreaterThan(0);
  });

  it("RACE-04 MOVE para a porta 8 × marcar a 8 como RESERVED, nas duas ordens", async () => {
    let vinculoVenceu = 0;

    for (let rodada = 0; rodada < RODADAS * 2; rodada += 1) {
      const vinculoPrimeiro = rodada % 2 === 1;
      const cto = await novaCto(`CX-RACE-04-${rodada}`, 8);
      const origem = await porta(cto.id, 1);
      const destino = await porta(cto.id, 8);
      const cliente = await novoCliente(`Cliente RACE-04-${rodada}`);
      const vinculo = await connectCustomerToPort(ctx, {
        customerId: cliente.id,
        ctoPortId: origem.id,
      });

      const movendo = moveCustomerToPort(ctx, {
        customerId: cliente.id,
        expectedConnectionId: vinculo.id,
        targetCtoPortId: destino.id,
      });
      if (vinculoPrimeiro) await dianteira();
      const reservando = mudarEstado(cto.id, destino.id, "RESERVED");
      const [m] = await Promise.allSettled([movendo, reservando]);

      const estadoFinal = await estado(cto.id, 8);
      const ativosNoDestino = await ativosNaPorta(destino.id);
      expect(estadoFinal !== "RESERVED" || ativosNoDestino === 0).toBe(true);
      expect(
        await prisma.customerNetworkConnection.count({
          where: { customerId: cliente.id, disconnectedAt: null },
        }),
      ).toBe(1);
      if (m.status === "fulfilled") vinculoVenceu += 1;
    }

    expect(vinculoVenceu).toBeGreaterThan(0);
  });

  it("RACE-05 duas reservas simultâneas em portas ocupadas diferentes", async () => {
    for (let rodada = 0; rodada < RODADAS; rodada += 1) {
      const cto = await novaCto(`CX-RACE-05-${rodada}`, 8);
      const a = await porta(cto.id, 2);
      const b = await porta(cto.id, 3);
      for (const p of [a, b]) {
        const cliente = await novoCliente(`Cliente ${p.id}`);
        await connectCustomerToPort(ctx, {
          customerId: cliente.id,
          ctoPortId: p.id,
        });
      }

      const resultados = await Promise.allSettled([
        mudarEstado(cto.id, a.id, "RESERVED"),
        mudarEstado(cto.id, b.id, "RESERVED"),
      ]);

      // Ocupadas: as duas são recusadas, e nenhuma escapa pela serialização.
      expect(resultados.every((r) => r.status === "rejected")).toBe(true);
      expect(await estado(cto.id, 2)).toBe("AVAILABLE");
      expect(await estado(cto.id, 3)).toBe("AVAILABLE");
    }
  });
});


// ---------------------------------------------------------------------------
// O que a tentativa bloqueada NÃO faz
// ---------------------------------------------------------------------------

describe("CTO-2.6 · a recusa não deixa rastro", () => {
  it("NEG-01 tentativa bloqueada não escreve auditoria", async () => {
    const cto = await novaCto("CX-NEG-01", 8);
    const p = await porta(cto.id, 8);
    const cliente = await novoCliente("Cliente NEG-01");
    await connectCustomerToPort(ctx, {
      customerId: cliente.id,
      ctoPortId: p.id,
    });

    const antes = await prisma.auditLog.count({
      where: { companyId: fixture.companyA.id },
    });

    await esperaConflito(() => mudarEstado(cto.id, p.id, "RESERVED"));
    await esperaConflito(() => reduzir(cto.id, 4));

    // A transação inteira volta: nada de auditoria de algo que não aconteceu.
    expect(
      await prisma.auditLog.count({ where: { companyId: fixture.companyA.id } }),
    ).toBe(antes);
  });

  it("NEG-02 depois da redução bloqueada, o banco está BYTE a byte igual", async () => {
    const cto = await novaCto("CX-NEG-02", 8);
    const p = await porta(cto.id, 8);
    const cliente = await novoCliente("Cliente NEG-02");
    const vinculo = await connectCustomerToPort(ctx, {
      customerId: cliente.id,
      ctoPortId: p.id,
    });

    const ctoAntes = await prisma.cTO.findUniqueOrThrow({
      where: { id: cto.id },
    });
    const portasAntes = await prisma.cTOPort.findMany({
      where: { ctoId: cto.id },
      orderBy: { number: "asc" },
    });
    const vinculoAntes =
      await prisma.customerNetworkConnection.findUniqueOrThrow({
        where: { id: vinculo.id },
      });

    await esperaConflito(() => reduzir(cto.id, 4));

    /*
      Igualdade profunda, e não uma amostra de campos.

      "Nenhuma alteração parcial" é a promessa da fase, e conferir só
      `capacity` deixaria de fora `updatedAt`, o estado das portas e o vínculo —
      exatamente onde um efeito colateral se esconderia.
    */
    expect(
      await prisma.cTO.findUniqueOrThrow({ where: { id: cto.id } }),
    ).toEqual(ctoAntes);
    expect(
      await prisma.cTOPort.findMany({
        where: { ctoId: cto.id },
        orderBy: { number: "asc" },
      }),
    ).toEqual(portasAntes);
    expect(
      await prisma.customerNetworkConnection.findUniqueOrThrow({
        where: { id: vinculo.id },
      }),
    ).toEqual(vinculoAntes);
  });

  it("NEG-03 o 409 das ROTAS não vaza stack, SQL nem nome de tabela", async () => {
    const cto = await novaCto("CX-NEG-03", 8);
    const p = await porta(cto.id, 8);
    const cliente = await novoCliente("Fulano Que Nao Deve Aparecer");
    await connectCustomerToPort(ctx, {
      customerId: cliente.id,
      ctoPortId: p.id,
    });
    const token = await createTokenFor(fixture.adminA.id);

    const respostas = [
      await portStateRoute(
        apiRequest(
          `/api/ctos/${cto.id}/ports/${p.id}/state`,
          { method: "POST", body: { administrativeState: "RESERVED" } },
          token,
        ),
        { params: { id: cto.id, portId: p.id } },
      ),
      await capacityRoute(
        apiRequest(
          `/api/ctos/${cto.id}/capacity`,
          { method: "POST", body: { capacity: 4 } },
          token,
        ),
        { params: { id: cto.id } },
      ),
    ];

    for (const res of respostas) {
      expect(res.status).toBe(409);
      const texto = await res.text();
      for (const proibido of [
        "at Object",
        "node_modules",
        "SELECT",
        "customer_network_connections",
        "cto_ports",
        "prisma",
        "Fulano Que Nao Deve Aparecer",
        cliente.id,
        p.id,
        fixture.companyA.id,
      ]) {
        expect(texto).not.toContain(proibido);
      }
    }
  });
});


describe("CTO-2.6 · o read model não mudou", () => {
  it("RM-01 DANIFICADA e OCUPADA conta nos DOIS agregados", async () => {
    const cto = await novaCto("CX-RM-01", 4);
    const p = await porta(cto.id, 2);
    const cliente = await novoCliente("Cliente RM-01");
    await connectCustomerToPort(ctx, {
      customerId: cliente.id,
      ctoPortId: p.id,
    });
    await mudarEstado(cto.id, p.id, "DAMAGED");

    const detalhe = await getOperationalCtoDetail(fixture.companyA.id, cto.id);
    expect(detalhe!.summary.damaged).toBe(1);
    expect(detalhe!.summary.occupied).toBe(1);
    // As categorias se sobrepõem, e a soma pode passar da capacidade.
    const soma =
      detalhe!.summary.free +
      detalhe!.summary.reserved +
      detalhe!.summary.damaged +
      detalhe!.summary.occupied;
    expect(soma).toBeGreaterThan(detalhe!.summary.capacity);

    const porta2 = detalhe!.ports.find((x) => x.number === 2)!;
    expect(porta2.administrativeState).toBe("DAMAGED");
    expect(porta2.occupied).toBe(true);
    expect(porta2.availableForConnection).toBe(false);
  });

  it("RM-02 OCCUPIED continua sem existir como estado gravável", async () => {
    const cto = await novaCto("CX-RM-02", 2);
    const p = await porta(cto.id, 1);
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "cto_ports" SET "administrativeState" = 'OCCUPIED' WHERE "id" = $1`,
        p.id,
      ),
    ).rejects.toThrow();
  });
});
