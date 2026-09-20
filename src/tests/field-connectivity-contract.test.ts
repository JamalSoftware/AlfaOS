import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { getFieldServiceOrder } from "@/lib/field/service-orders";
import { CONNECTIVITY_POLICY_DEFAULTS } from "@/lib/connectivity-policy";
import { seedTestData, type TestFixture } from "./helpers";

/**
 * # O contrato de conectividade que o Field recebe
 *
 * O dono viu, em aparelho real, *"Online há 25 d"* numa OS. A frase afirma há
 * quanto tempo o cliente está no ar, e o número saía de `observedAt` — que é
 * quando o provedor CONFERIU pela última vez. Os dois fatos são
 * independentes: com o ciclo reconferindo de 5 em 5 minutos, "online há 25
 * dias" e "verificado há 3 minutos" são verdadeiros ao mesmo tempo.
 *
 * O aplicativo não tinha como escrever a duração: `statusSince` **não era
 * enviado**. E não tinha como avisar que a leitura envelheceu: não havia
 * nenhum sinal de frescor no DTO.
 *
 * ## Quem decide o frescor é o SERVIDOR
 *
 * `connectivity-policy.ts` é dona do alvo e do limiar, e a web já segue essa
 * regra — o read model entrega `verificationIsStale` resolvido e a tela só
 * pinta. Um limiar compilado no APK discordaria de um ambiente que alongasse
 * o alvo por variável, e o aparelho em campo é exatamente o que não se
 * atualiza junto com a configuração.
 *
 * ## `stale` NÃO é um estado
 *
 * Os estados continuam `ONLINE`, `OFFLINE` e `UNKNOWN`. Um quarto valor faria
 * a tela escolher entre mostrar o estado e mostrar que a leitura é velha,
 * quando as duas coisas são verdade.
 */

let fixture: TestFixture;

const LIMIAR = CONNECTIVITY_POLICY_DEFAULTS.staleAfterMs;

async function montarOs(): Promise<{ orderId: string; customerId: string; technicianId: string }> {
  const customer = await prisma.customer.create({
    data: { companyId: fixture.companyA.id, name: "Cliente Contrato" },
  });
  const technician = await prisma.technician.create({
    data: { companyId: fixture.companyA.id, userId: fixture.techA.id },
  });
  const order = await prisma.serviceOrder.create({
    data: {
      companyId: fixture.companyA.id,
      customerId: customer.id,
      technicianId: technician.id,
      number: 9001,
      status: "ASSIGNED",
      // `type` é o rótulo livre exigido pelo schema; o `typeId` do catálogo é
      // outra coisa e não interessa a este contrato.
      type: "Manutenção",
      description: "OS do contrato de conectividade.",
      assignedAt: new Date(),
    },
  });
  return { orderId: order.id, customerId: customer.id, technicianId: technician.id };
}

async function gravarSnapshot(
  customerId: string,
  dados: { status: "ONLINE" | "OFFLINE" | "UNKNOWN"; observedAt: Date; statusSince: Date },
) {
  await prisma.customerDiagnosticSnapshot.create({
    data: {
      companyId: fixture.companyA.id,
      customerId,
      externalProvider: "MOCK",
      connectivityStatus: dados.status,
      observedAt: dados.observedAt,
      statusSince: dados.statusSince,
    },
  });
}

beforeEach(async () => {
  fixture = await seedTestData();
});

describe("FIELD-CONN — o DTO carrega as duas datas e o veredito de frescor", () => {
  it("FIELD-CONN-01 · statusSince e observedAt viajam SEPARADOS", async () => {
    const { orderId, customerId, technicianId } = await montarOs();
    const agora = Date.now();
    await gravarSnapshot(customerId, {
      status: "ONLINE",
      // Estado antigo, confirmação recente: é o caso que produzia a frase errada.
      statusSince: new Date(agora - 25 * 24 * 60 * 60_000),
      observedAt: new Date(agora - 3 * 60_000),
    });

    const detalhe = await getFieldServiceOrder(
      fixture.companyA.id,
      technicianId,
      orderId,
    );

    expect(detalhe.diagnostic?.connectivityStatus).toBe("ONLINE");
    expect(detalhe.diagnostic?.statusSince).not.toBeNull();
    expect(detalhe.diagnostic?.observedAt).not.toBeNull();
    // As duas datas são DIFERENTES: se o DTO mandasse a mesma para as duas
    // frases, o aplicativo voltaria a escrever a duração com o relógio errado.
    expect(detalhe.diagnostic!.statusSince).not.toBe(detalhe.diagnostic!.observedAt);

    const desde = new Date(detalhe.diagnostic!.statusSince!).getTime();
    const visto = new Date(detalhe.diagnostic!.observedAt!).getTime();
    expect(agora - desde).toBeGreaterThan(24 * 24 * 60 * 60_000);
    expect(agora - visto).toBeLessThan(10 * 60_000);
  });

  it("FIELD-CONN-02 · confirmação recente NÃO é velha", async () => {
    const { orderId, customerId, technicianId } = await montarOs();
    await gravarSnapshot(customerId, {
      status: "ONLINE",
      statusSince: new Date(Date.now() - 60 * 60_000),
      observedAt: new Date(Date.now() - Math.floor(LIMIAR / 2)),
    });

    const detalhe = await getFieldServiceOrder(
      fixture.companyA.id,
      technicianId,
      orderId,
    );
    expect(detalhe.diagnostic?.verificationIsStale).toBe(false);
  });

  it("FIELD-CONN-03 · passado o limiar, o SERVIDOR marca a leitura como velha", async () => {
    const { orderId, customerId, technicianId } = await montarOs();
    await gravarSnapshot(customerId, {
      status: "ONLINE",
      statusSince: new Date(Date.now() - 25 * 24 * 60 * 60_000),
      observedAt: new Date(Date.now() - (LIMIAR + 60_000)),
    });

    const detalhe = await getFieldServiceOrder(
      fixture.companyA.id,
      technicianId,
      orderId,
    );

    expect(detalhe.diagnostic?.verificationIsStale).toBe(true);
    // E o ESTADO continua o que era: velho não é um estado.
    expect(detalhe.diagnostic?.connectivityStatus).toBe("ONLINE");
  });

  it("FIELD-CONN-04 · `stale` não vira um quarto estado de conectividade", async () => {
    const { orderId, customerId, technicianId } = await montarOs();
    await gravarSnapshot(customerId, {
      status: "OFFLINE",
      statusSince: new Date(Date.now() - 2 * 60 * 60_000),
      observedAt: new Date(Date.now() - (LIMIAR + 60_000)),
    });

    const detalhe = await getFieldServiceOrder(
      fixture.companyA.id,
      technicianId,
      orderId,
    );

    expect(["ONLINE", "OFFLINE", "UNKNOWN"]).toContain(
      detalhe.diagnostic!.connectivityStatus,
    );
    expect(detalhe.diagnostic!.connectivityStatus).toBe("OFFLINE");
    expect(detalhe.diagnostic!.verificationIsStale).toBe(true);
  });

  it("FIELD-CONN-05 · sem snapshot, o diagnóstico é nulo e nada é inventado", async () => {
    const { orderId, technicianId } = await montarOs();

    const detalhe = await getFieldServiceOrder(
      fixture.companyA.id,
      technicianId,
      orderId,
    );
    // Ausência de leitura não vira OFFLINE, nem `stale`, nem duração.
    expect(detalhe.diagnostic).toBeNull();
  });
});
