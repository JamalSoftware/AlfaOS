import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { assignTechnician, startServiceOrder } from "@/lib/service-orders";
import { confirmCustomerLocation, correctCustomerLocation } from "@/lib/customer-locations";
import { DomainError } from "@/lib/errors";
import { allocateTestServiceOrderNumber, seedTestData, type TestFixture } from "./helpers";

/**
 * RC-LOC-06 — confirmar/corrigir localização × concluir a OS, na mesma hora.
 *
 * Os comandos de localização conferiam `status === IN_PROGRESS` com uma
 * leitura SIMPLES da OS — sem trava. Entre essa leitura e o commit, a OS podia
 * ser concluída por outra transação, e o comando gravava mesmo assim: ponto
 * atualizado, linha de histórico e evento amarrados a uma OS que já estava
 * `COMPLETED` quando a escrita chegou.
 *
 * ## Como a corrida fica determinística
 *
 * Nada de `sleep`. Uma transação à parte trava a linha de `customer_locations`
 * com `FOR UPDATE`; o comando de localização passa pela conferência de status
 * e PARA na escrita do ponto. Enquanto ele está parado — provado por
 * `pg_stat_activity`, não por relógio —, a "conclusão" roda. A conclusão é um
 * `UPDATE` direto do status: o que importa para a corrida é a trava de linha
 * que ele disputa, e é a mesma que `completeServiceOrder` toma no seu
 * compare-and-set. Montar uma OS concluível de verdade (assinatura, checklist,
 * política) só acrescentaria pré-requisito sem mudar a disputa.
 *
 * ## A invariante
 *
 * Se o comando de localização GRAVOU, então no instante do commit dele a OS
 * ainda estava em atendimento — a conclusão não pode ter commitado antes.
 */

let fixture: TestFixture;

beforeEach(async () => {
  fixture = await seedTestData();
});

async function versaoDaOs(id: string) {
  return (await prisma.serviceOrder.findUniqueOrThrow({ where: { id } })).version;
}

async function atendimento() {
  const dono = await prisma.technician.upsert({
    where: { userId: fixture.techA.id },
    update: {},
    create: { companyId: fixture.companyA.id, userId: fixture.techA.id },
  });
  const customer = await prisma.customer.create({
    data: { companyId: fixture.companyA.id, name: "Cliente Corrida" },
  });
  const location = await prisma.customerLocation.create({
    data: {
      companyId: fixture.companyA.id,
      customerId: customer.id,
      latitude: -20.3,
      longitude: -40.3,
      source: "IMPORTED",
      verified: false,
    },
  });
  const order = await prisma.serviceOrder.create({
    data: {
      companyId: fixture.companyA.id,
      number: await allocateTestServiceOrderNumber(fixture.companyA.id),
      customerId: customer.id,
      type: "Reparo",
      description: "Corrida.",
      status: "PENDING",
    },
  });
  await assignTechnician(fixture.companyA.id, fixture.adminA.id, order.id, dono.id, await versaoDaOs(order.id));
  await startServiceOrder(fixture.companyA.id, fixture.techA.id, order.id, await versaoDaOs(order.id));
  return { order, location };
}

/** Quantas sessões estão esperando trava numa consulta que menciona `tabela`. */
async function esperandoTrava(tabela: string): Promise<number> {
  const linhas = await prisma.$queryRawUnsafe<{ n: number }[]>(
    `SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE $1`,
    `%${tabela}%`,
  );
  return linhas[0]?.n ?? 0;
}

async function ate(condicao: () => Promise<boolean>, limiteMs = 5_000): Promise<boolean> {
  const inicio = Date.now();
  while (Date.now() - inicio < limiteMs) {
    if (await condicao()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

/**
 * Segura a linha do ponto até `soltar()` — em conexão própria, numa
 * transação interativa que só termina quando o teste manda.
 */
function segurarPonto(locationId: string) {
  let soltar!: () => void;
  const liberado = new Promise<void>((r) => (soltar = r));
  let pronto!: () => void;
  const segurando = new Promise<void>((r) => (pronto = r));
  const fim = prisma.$transaction(
    async (tx) => {
      await tx.$queryRawUnsafe(`SELECT id FROM customer_locations WHERE id = $1 FOR UPDATE`, locationId);
      pronto();
      await liberado;
    },
    { timeout: 30_000, maxWait: 10_000 },
  );
  return { segurando, soltar, fim };
}

function concluirPorFora(orderId: string) {
  return prisma.$executeRawUnsafe(
    `UPDATE service_orders SET status = 'COMPLETED', "completedAt" = now(), version = version + 1 WHERE id = $1`,
    orderId,
  );
}

type Comando = (orderId: string, locationVersion: number) => Promise<unknown>;

const COMANDOS: Array<[string, Comando]> = [
  [
    "confirmar",
    // Com o GPS do aparelho no ponto (RC-1C). Sem ele o comando é recusado
    // ANTES de chegar à escrita do ponto, e a corrida nunca aconteceria.
    (orderId, v) =>
      confirmCustomerLocation(fixture.companyA.id, fixture.techA.id, orderId, {
        expectedVersion: v,
        observedLatitude: -20.3,
        observedLongitude: -40.3,
      }),
  ],
  [
    "corrigir",
    (orderId, v) =>
      correctCustomerLocation(fixture.companyA.id, fixture.techA.id, orderId, {
        expectedVersion: v,
        reason: "INCORRECT_LOCATION",
        latitude: -20.31,
        longitude: -40.31,
        source: "TECHNICIAN_GPS",
      }),
  ],
];

describe("RC-LOC-06 — localização × conclusão", () => {
  it.each(COMANDOS)(
    "%s: se a escrita commitou, a conclusão NÃO tinha commitado antes dela",
    async (_nome, comando) => {
      const { order, location } = await atendimento();
      const trava = segurarPonto(location.id);
      await trava.segurando;

      // O comando passa pela conferência de status e para na escrita do ponto.
      const escrita = comando(order.id, location.version).then(
        () => "gravou" as const,
        (e: unknown) => e,
      );
      expect(await ate(async () => (await esperandoTrava("customer_locations")) > 0)).toBe(true);

      // Agora a conclusão. Ela termina sozinha (defeito) ou fica esperando a
      // trava que o comando de localização tem sobre a OS (correção).
      let conclusaoTerminou = false;
      const conclusao = concluirPorFora(order.id).then(() => {
        conclusaoTerminou = true;
      });
      await ate(async () => conclusaoTerminou || (await esperandoTrava("service_orders")) > 0);
      const concluiuAntesDaEscrita = conclusaoTerminou;

      trava.soltar();
      await trava.fim;
      const desfecho = await escrita;
      await conclusao;

      if (desfecho === "gravou") {
        expect(
          concluiuAntesDaEscrita,
          "o ponto foi gravado a partir de uma OS que já estava concluída",
        ).toBe(false);
      } else {
        // Recusar também cumpre a invariante — mas só com um 409 limpo.
        expect(desfecho).toBeInstanceOf(DomainError);
        expect((desfecho as DomainError).status).toBe(409);
      }

      // Nada pela metade: o histórico acompanha o ponto, linha a linha.
      const ponto = await prisma.customerLocation.findUniqueOrThrow({ where: { id: location.id } });
      const historico = await prisma.customerLocationHistory.count({ where: { customerId: ponto.customerId } });
      expect(historico).toBe(desfecho === "gravou" ? 1 : 0);
      expect(ponto.version).toBe(desfecho === "gravou" ? location.version + 1 : location.version);
      // E a OS terminou concluída — a conclusão não se perde.
      expect((await prisma.serviceOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(
        "COMPLETED",
      );
    },
  );

  it("conclusão commitada ANTES: o comando espera, relê e recusa com 409 — sem ponto nem histórico", async () => {
    const { order, location } = await atendimento();

    let soltar!: () => void;
    const liberado = new Promise<void>((r) => (soltar = r));
    let pronto!: () => void;
    const concluindo = new Promise<void>((r) => (pronto = r));
    // A conclusão toma a linha da OS e segura, sem commitar.
    const conclusao = prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(
          `UPDATE service_orders SET status = 'COMPLETED', "completedAt" = now(), version = version + 1 WHERE id = $1`,
          order.id,
        );
        pronto();
        await liberado;
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
    await concluindo;

    // Com GPS válido no ponto: a recusa esperada é a do ESTADO da OS, e não a
    // da falta de posição (RC-1C).
    const escrita = confirmCustomerLocation(fixture.companyA.id, fixture.techA.id, order.id, {
      expectedVersion: location.version,
      observedLatitude: -20.3,
      observedLongitude: -40.3,
    }).then(
      () => "gravou" as const,
      (e: unknown) => e,
    );
    // O comando precisa ESPERAR a OS — é a trava que faltava.
    expect(await ate(async () => (await esperandoTrava("service_orders")) > 0)).toBe(true);

    soltar();
    await conclusao;
    const desfecho = await escrita;

    expect(desfecho).toBeInstanceOf(DomainError);
    expect((desfecho as DomainError).status).toBe(409);
    const ponto = await prisma.customerLocation.findUniqueOrThrow({ where: { id: location.id } });
    expect(ponto.verified).toBe(false);
    expect(ponto.version).toBe(location.version);
    expect(await prisma.customerLocationHistory.count()).toBe(0);
  });
});
