import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { runConnectivityRefreshCycle } from "@/lib/connectivity-monitor";
import { createCto } from "@/lib/cto";
import { MockERPAdapter } from "@/integrations/MockERPAdapter";
import { ReceitanetAdapter } from "@/integrations/ReceitanetAdapter";
import { IntegrationError } from "@/integrations/errors";
import type {
  ERPConnectivityObservation,
  ERPCustomerRef,
  ERPDiagnosticsRequestContext,
} from "@/integrations/diagnostics";
import { seedTestData, type TestFixture } from "./helpers";

/**
 * # `RC-1F-A` — o prazo da verificação é CONTRATO do provider, não gentileza do ReceitaNet
 *
 * Decisão do dono (B): o cancelamento faz parte do contrato multi-provider. Toda
 * chamada de `fetchCustomerConnectivity` recebe um contexto com `AbortSignal`,
 * criado por quem cronometra a verificação; adapter que faz I/O o repassa à
 * operação externa. Um SGP futuro recebe o MESMO contexto.
 *
 * Os testes daqui não conhecem provider concreto: o provider é um falso que
 * obedece (ou não) ao sinal.
 */

let fixture: TestFixture;
const MIN = 60_000;

beforeEach(async () => {
  fixture = await seedTestData();
  await prisma.eRPIntegration.create({
    data: { companyId: fixture.companyA.id, provider: "MOCK", name: "Mock ERP", enabled: true },
  });
});

async function ligadosComLeituraVelha(quantos: number) {
  await prisma.company.update({ where: { id: fixture.companyA.id }, data: { ctoNetworkEnabled: true } });
  const cto = await createCto(fixture.companyA.id, fixture.adminA.id, { name: "CTO RC1FA CANCEL", capacity: 8 });
  const velha = new Date(Date.now() - 30 * MIN);
  const clientes = [];
  for (let porta = 1; porta <= quantos; porta += 1) {
    const c = await prisma.customer.create({
      data: {
        companyId: fixture.companyA.id,
        name: `CANCEL ${porta}`,
        active: true,
        externalProvider: "MOCK",
        externalId: `CANCEL-${porta}-ONLINE`,
      },
    });
    const p = await prisma.cTOPort.findFirstOrThrow({ where: { ctoId: cto.id, number: porta } });
    await prisma.customerNetworkConnection.create({
      data: { companyId: fixture.companyA.id, customerId: c.id, ctoPortId: p.id, source: "WEB", connectedAt: new Date() },
    });
    await prisma.customerDiagnosticSnapshot.create({
      data: {
        companyId: fixture.companyA.id,
        customerId: c.id,
        externalProvider: "MOCK",
        connectivityStatus: "ONLINE",
        observedAt: velha,
        statusSince: velha,
      },
    });
    clientes.push(c);
  }
  return { clientes, velha };
}

describe("DIAG-PROVIDER-CANCEL — o contexto de cancelamento é do contrato", () => {
  it("DIAG-PROVIDER-CANCEL-00 · todo adapter com diagnóstico declara o contexto na assinatura", () => {
    /*
      O TypeScript aceita implementação com MENOS parâmetros que a interface —
      um adapter poderia ignorar o contexto e compilar. A aridade não prova que
      o sinal é repassado (isso é o CANCEL-02 e os testes de rede do
      ReceitaNet), mas impede o esquecimento mais barato.
    */
    const receitanet = new ReceitanetAdapter({ token: "t", fetchImpl: async () => ({ ok: true, status: 200, text: async () => "{}" }) });
    expect(new MockERPAdapter().fetchCustomerConnectivity.length).toBe(2);
    expect(receitanet.fetchCustomerConnectivity.length).toBe(2);
  });

  it("DIAG-PROVIDER-CANCEL-01 · o ciclo entrega ao provider um contexto com AbortSignal vivo", async () => {
    await ligadosComLeituraVelha(2);
    const recebidos: Array<ERPDiagnosticsRequestContext | undefined> = [];
    const original = MockERPAdapter.prototype.fetchCustomerConnectivity;
    const espiao = vi
      .spyOn(MockERPAdapter.prototype, "fetchCustomerConnectivity")
      .mockImplementation(async function (this: MockERPAdapter, ref, context) {
        recebidos.push(context);
        // Vivo no momento da chamada: o prazo ainda não venceu.
        expect(context?.signal.aborted).toBe(false);
        return original.call(this, ref, context);
      });
    let r;
    try {
      r = await runConnectivityRefreshCycle({ concurrency: 1 });
    } finally {
      espiao.mockRestore();
    }
    expect(r.processed).toBe(2);
    expect(r.online).toBe(2);
    expect(recebidos).toHaveLength(2);
    for (const contexto of recebidos) {
      expect(contexto?.signal).toBeInstanceOf(AbortSignal);
    }
    // Um contexto por verificação: dois prazos independentes.
    expect(recebidos[0]?.signal).not.toBe(recebidos[1]?.signal);
  }, 30_000);

  it("DIAG-PROVIDER-CANCEL-02 · prazo vencido ABORTA o provider que honra o sinal; falha é TIMEOUT, nada é escrito", async () => {
    const { clientes, velha } = await ligadosComLeituraVelha(3);
    let abortados = 0;
    let emVoo = 0;
    const espiao = vi
      .spyOn(MockERPAdapter.prototype, "fetchCustomerConnectivity")
      .mockImplementation(
        (_ref: ERPCustomerRef, context: ERPDiagnosticsRequestContext) =>
          new Promise<ERPConnectivityObservation>((_, reject) => {
            // Provider bem-comportado que nunca responde: só o sinal o encerra.
            emVoo += 1;
            context.signal.addEventListener(
              "abort",
              () => {
                abortados += 1;
                emVoo -= 1;
                reject(new IntegrationError("TIMEOUT", "MOCK", "abortado pelo prazo"));
              },
              { once: true },
            );
          }),
      );
    let r;
    try {
      r = await runConnectivityRefreshCycle({ concurrency: 1, timeoutMs: 80 });
    } finally {
      espiao.mockRestore();
    }
    expect(abortados).toBe(3);
    expect(emVoo).toBe(0);
    expect(r.processed).toBe(3);
    expect(r.providerFailures).toBe(3);
    expect(r.offline).toBe(0);
    for (const c of clientes) {
      const s = await prisma.customerDiagnosticSnapshot.findFirstOrThrow({ where: { customerId: c.id } });
      expect(s.observedAt.getTime()).toBe(velha.getTime());
      expect(s.connectivityStatus).toBe("ONLINE");
    }
  }, 30_000);

  it("DIAG-PROVIDER-CANCEL-03 · provider que IGNORA o sinal não segura o ciclo: TIMEOUT logo depois do prazo", async () => {
    await ligadosComLeituraVelha(2);
    const espiao = vi
      .spyOn(MockERPAdapter.prototype, "fetchCustomerConnectivity")
      .mockImplementation(() => new Promise<ERPConnectivityObservation>(() => undefined));
    const inicio = Date.now();
    let r;
    try {
      r = await runConnectivityRefreshCycle({ concurrency: 1, timeoutMs: 80 });
    } finally {
      espiao.mockRestore();
    }
    const decorrido = Date.now() - inicio;
    expect(r.providerFailures).toBe(2);
    expect(r.offline).toBe(0);
    // Duas verificações de 80 ms em série, com folga de banco — nunca o prazo padrão de 8 s.
    expect(decorrido).toBeLessThan(4_000);
  }, 30_000);
});
