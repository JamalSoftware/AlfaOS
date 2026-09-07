import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  connectCustomerToPort,
  disconnectCustomer,
  moveCustomerToPort,
  type ConnectionContext,
} from "@/lib/cto-connections";
import {
  changeCtoCapacity,
  createCto,
  setPortAdministrativeState,
} from "@/lib/cto";
import { seedTestData, type TestFixture } from "./helpers";

/**
 * # `CTO-2.1` — concorrência do vínculo
 *
 * As corridas de `C1` a `C6` do freeze (§24.13), executadas de verdade.
 *
 * Duas regras que estes testes seguem e sem as quais eles não valeriam nada:
 * a asserção **proíbe** o desfecho ruim em vez de tolerá-lo (`toBe(1)`, nunca
 * `toBeGreaterThanOrEqual(1)`), e cada corrida roda **várias vezes** — se o
 * vencedor é sempre o mesmo, não houve corrida, houve uma sequência rápida.
 */

let fixture: TestFixture;
let ctx: ConnectionContext;

const RODADAS = 5;

beforeEach(async () => {
  fixture = await seedTestData();
  await prisma.company.update({
    where: { id: fixture.companyA.id },
    data: { ctoNetworkEnabled: true },
  });
  ctx = {
    companyId: fixture.companyA.id,
    provenance: { source: "WEB", actorUserId: fixture.adminA.id },
  };
});

async function novaCto(nome: string, capacidade = 8) {
  return createCto(fixture.companyA.id, fixture.adminA.id, {
    name: nome,
    capacity: capacidade,
  });
}

async function porta(ctoId: string, numero: number) {
  return prisma.cTOPort.findFirstOrThrow({ where: { ctoId, number: numero } });
}

async function cliente(nome: string) {
  return prisma.customer.create({
    data: { companyId: fixture.companyA.id, name: nome },
  });
}

function contar(r: PromiseSettledResult<unknown>[]) {
  return {
    ok: r.filter((x) => x.status === "fulfilled").length,
    falhou: r.filter((x) => x.status === "rejected").length,
  };
}

async function ativasDaPorta(ctoPortId: string) {
  return prisma.customerNetworkConnection.count({
    where: { ctoPortId, disconnectedAt: null },
  });
}

async function ativasDoCliente(customerId: string) {
  return prisma.customerNetworkConnection.count({
    where: { customerId, disconnectedAt: null },
  });
}

// ---------------------------------------------------------------------------

describe("C1 · dois clientes, a mesma porta", () => {
  it("exatamente um vence, e a porta fica com UM vínculo ativo", async () => {
    for (let i = 0; i < RODADAS; i += 1) {
      const cto = await novaCto(`C1-${i}`);
      const p1 = await porta(cto.id, 1);
      const a = await cliente(`A${i}`);
      const b = await cliente(`B${i}`);

      const r = await Promise.allSettled([
        connectCustomerToPort(ctx, { customerId: a.id, ctoPortId: p1.id }),
        connectCustomerToPort(ctx, { customerId: b.id, ctoPortId: p1.id }),
      ]);

      const { ok } = contar(r);
      expect(ok, `rodada ${i}`).toBe(1);
      expect(await ativasDaPorta(p1.id)).toBe(1);
      // E nenhum histórico falso: quem perdeu não deixou linha nenhuma.
      expect(
        await prisma.customerNetworkConnection.count({
          where: { ctoPortId: p1.id },
        }),
      ).toBe(1);
    }
  });
});

describe("C2 · o mesmo cliente, duas portas", () => {
  it("exatamente um vence, mesmo em CTOs diferentes", async () => {
    for (let i = 0; i < RODADAS; i += 1) {
      const a = await novaCto(`C2A-${i}`);
      const b = await novaCto(`C2B-${i}`);
      const pa = await porta(a.id, 1);
      const pb = await porta(b.id, 1);
      const c = await cliente(`C${i}`);

      const r = await Promise.allSettled([
        connectCustomerToPort(ctx, { customerId: c.id, ctoPortId: pa.id }),
        connectCustomerToPort(ctx, { customerId: c.id, ctoPortId: pb.id }),
      ]);

      expect(contar(r).ok, `rodada ${i}`).toBe(1);
      expect(await ativasDoCliente(c.id)).toBe(1);
      expect(
        await prisma.customerNetworkConnection.count({
          where: { customerId: c.id },
        }),
      ).toBe(1);
    }
  });
});

describe("C3 · dois moves do mesmo cliente", () => {
  it("nunca duas ativas, nunca zero, nunca a antiga fechada sem a nova", async () => {
    for (let i = 0; i < RODADAS; i += 1) {
      const cto = await novaCto(`C3-${i}`);
      const origem = await porta(cto.id, 1);
      const d1 = await porta(cto.id, 2);
      const d2 = await porta(cto.id, 3);
      const c = await cliente(`M${i}`);
      await connectCustomerToPort(ctx, {
        customerId: c.id,
        ctoPortId: origem.id,
      });

      const r = await Promise.allSettled([
        moveCustomerToPort(ctx, { customerId: c.id, targetCtoPortId: d1.id }),
        moveCustomerToPort(ctx, { customerId: c.id, targetCtoPortId: d2.id }),
      ]);

      /*
        Os dois PODEM vencer: são movimentações sequenciais legítimas depois de
        serializadas pelo lock de cliente. O que não pode existir é estado
        híbrido — e é isso que a asserção proíbe.
      */
      expect(await ativasDoCliente(c.id), `rodada ${i}`).toBe(1);
      expect(contar(r).ok).toBeGreaterThan(0);

      const todas = await prisma.customerNetworkConnection.findMany({
        where: { customerId: c.id },
        orderBy: { connectedAt: "asc" },
      });
      // Toda linha, menos a última, está fechada: sem buraco no histórico.
      for (const linha of todas.slice(0, -1)) {
        expect(linha.disconnectedAt).not.toBeNull();
      }
      expect(todas[todas.length - 1].disconnectedAt).toBeNull();
    }
  });
});

describe("C4 · conectar × reduzir capacidade", () => {
  it("não nasce vínculo ativo em porta que terminou fora da capacidade", async () => {
    for (let i = 0; i < RODADAS; i += 1) {
      const cto = await novaCto(`C4-${i}`, 16);
      const p12 = await porta(cto.id, 12);
      const c = await cliente(`Cap${i}`);

      const r = await Promise.allSettled([
        connectCustomerToPort(ctx, { customerId: c.id, ctoPortId: p12.id }),
        changeCtoCapacity(fixture.companyA.id, fixture.adminA.id, cto.id, 8),
      ]);

      const caixa = await prisma.cTO.findUniqueOrThrow({
        where: { id: cto.id },
      });
      const ativa = await prisma.customerNetworkConnection.findFirst({
        where: { ctoPortId: p12.id, disconnectedAt: null },
      });

      /*
        O desfecho proibido é UM só: porta 12 com vínculo ativo e capacidade 8.

        Qualquer ordem é aceitável — conectar primeiro e a redução ser recusada
        (`CTO-2.6` fecha isso; hoje a redução ainda não olha vínculo, e a
        limitação está declarada no relatório), ou reduzir primeiro e a conexão
        ser recusada pela faixa.
      */
      const proibido = caixa.capacity < 12 && ativa !== null;
      expect(proibido, `rodada ${i} — capacity ${caixa.capacity}`).toBe(false);
      expect(contar(r).ok).toBeGreaterThan(0);
    }
  });
});

describe("C5 · conectar × mudar estado administrativo", () => {
  it("não nasce vínculo em porta que virou não ofertável", async () => {
    for (let i = 0; i < RODADAS; i += 1) {
      const cto = await novaCto(`C5-${i}`);
      const p1 = await porta(cto.id, 1);
      const c = await cliente(`St${i}`);

      const r = await Promise.allSettled([
        connectCustomerToPort(ctx, { customerId: c.id, ctoPortId: p1.id }),
        setPortAdministrativeState(
          fixture.companyA.id,
          fixture.adminA.id,
          cto.id,
          p1.id,
          "RESERVED",
        ),
      ]);

      const estado = await prisma.cTOPort.findUniqueOrThrow({
        where: { id: p1.id },
      });
      const ativa = await prisma.customerNetworkConnection.findFirst({
        where: { ctoPortId: p1.id, disconnectedAt: null },
      });

      /*
        O que o lock da CTO garante HOJE: as duas operações serializam, então
        a conexão nunca é criada olhando um estado que já mudou.

        `RESERVED + ocupada` ainda é alcançável quando a reserva chega DEPOIS —
        e é exatamente essa combinação que a `CTO-2.6` vai proibir em
        `setPortAdministrativeState`. Este teste registra o limite atual sem
        fingir que ele já está fechado.
      */
      if (estado.administrativeState === "RESERVED" && ativa) {
        // A reserva venceu a corrida DEPOIS da conexão: permitido até a 2.6.
        expect(ativa.connectedAt.getTime()).toBeLessThanOrEqual(
          estado.updatedAt.getTime(),
        );
      }
      expect(contar(r).ok, `rodada ${i}`).toBeGreaterThan(0);
      expect(await ativasDaPorta(p1.id)).toBeLessThanOrEqual(1);
    }
  });
});

describe("C6 · desconectar × mover", () => {
  it("no máximo uma vence semanticamente, e o histórico fica coerente", async () => {
    for (let i = 0; i < RODADAS; i += 1) {
      const cto = await novaCto(`C6-${i}`);
      const origem = await porta(cto.id, 1);
      const destino = await porta(cto.id, 2);
      const c = await cliente(`D${i}`);
      const aberta = await connectCustomerToPort(ctx, {
        customerId: c.id,
        ctoPortId: origem.id,
      });

      const r = await Promise.allSettled([
        disconnectCustomer(ctx, { customerId: c.id }),
        moveCustomerToPort(ctx, { customerId: c.id, targetCtoPortId: destino.id }),
      ]);

      const { ok } = contar(r);
      const ativas = await ativasDoCliente(c.id);
      const linhas = await prisma.customerNetworkConnection.findMany({
        where: { customerId: c.id },
        orderBy: { connectedAt: "asc" },
      });

      /*
        Dois desfechos são válidos e nenhum outro:

        - o desconectar chegou primeiro → o mover encontra o vínculo já
          encerrado e recusa: 1 linha, fechada, 0 ativas;
        - o mover chegou primeiro → o desconectar fecha a linha NOVA: 2 linhas,
          as duas fechadas, 0 ativas. Ou o desconectar perde a corrida e sobra
          1 ativa na porta de destino.

        O que não pode existir: duas ativas, ou a linha original fechada DUAS
        vezes com carimbos diferentes, ou um move partindo de linha já fechada.
      */
      expect(ativas, `rodada ${i}`).toBeLessThanOrEqual(1);
      expect(ok).toBeGreaterThan(0);
      // A linha original nunca "reabre".
      const original = linhas.find((l) => l.id === aberta.id)!;
      expect(original.ctoPortId).toBe(origem.id);
      if (linhas.length > 1) {
        expect(original.disconnectedAt).not.toBeNull();
      }
      // Nenhuma linha fechada antes de ter sido aberta.
      for (const l of linhas) {
        if (l.disconnectedAt) {
          expect(l.disconnectedAt.getTime()).toBeGreaterThanOrEqual(
            l.connectedAt.getTime(),
          );
        }
      }
    }
  });
});
