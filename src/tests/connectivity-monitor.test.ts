import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  getConnectivityForCustomers,
  refreshCustomerDiagnostic,
  resolveStatusSince,
} from "@/lib/customer-diagnostics";
import {
  claimCustomerForCheck,
  findConnectionsDueForCheck,
  runConnectivityRefreshCycle,
} from "@/lib/connectivity-monitor";
import {
  connectivityAge,
  connectivityStatusDuration,
  isConnectivityCheckStale,
} from "@/lib/connectivity-presentation";
import { createCto } from "@/lib/cto";
import { seedTestData, type TestFixture } from "./helpers";

/**
 * # `DIAG-AUTO-1` — a conectividade se reconfere sozinha
 *
 * O defeito que esta fase existe para impedir é de SIGNIFICADO, não de
 * encanamento: com verificação automática de 5 em 5 minutos, derivar "há quanto
 * tempo está assim" de `observedAt` faria todo cliente parecer ter mudado de
 * estado agora há pouco. Um cliente offline há nove dias passaria a dizer
 * "offline há 5 minutos", e ninguém perceberia — a tela continuaria plausível.
 *
 * Por isso o teste central aqui não é de worker: é o de CONFUSÃO DO TÉCNICO
 * (`AUTO-CONFUSAO-01`), e ele falha se alguém voltar a derivar duração da
 * verificação.
 */

let fixture: TestFixture;
let contador = 0;

beforeEach(async () => {
  fixture = await seedTestData();
  contador = 0;
  await prisma.eRPIntegration.create({
    data: {
      companyId: fixture.companyA.id,
      provider: "MOCK",
      name: "Mock ERP",
      enabled: true,
    },
  });
});

const MIN = 60_000;
const DIA = 24 * 60 * MIN;

async function cliente(
  sufixo: string,
  opcoes: { companyId?: string; ativo?: boolean } = {},
) {
  contador += 1;
  const companyId = opcoes.companyId ?? fixture.companyA.id;
  return prisma.customer.create({
    data: {
      companyId,
      name: `DIAG ${contador}`,
      active: opcoes.ativo ?? true,
      externalProvider: "MOCK",
      externalId: `DIAG-${contador}${sufixo}`,
    },
  });
}

/** Grava a leitura como se ela tivesse acontecido no passado. */
async function leituraAntiga(
  customerId: string,
  status: "ONLINE" | "OFFLINE" | "UNKNOWN",
  observedAt: Date,
  statusSince: Date,
  companyId = fixture.companyA.id,
) {
  return prisma.customerDiagnosticSnapshot.create({
    data: {
      companyId,
      customerId,
      externalProvider: "MOCK",
      connectivityStatus: status,
      observedAt,
      statusSince,
    },
  });
}

async function ligarNaPorta(
  customerId: string,
  porta: number,
  companyId = fixture.companyA.id,
  ctoId?: string,
) {
  let id = ctoId;
  if (!id) {
    await prisma.company.update({
      where: { id: companyId },
      data: { ctoNetworkEnabled: true },
    });
    const autor =
      companyId === fixture.companyA.id ? fixture.adminA.id : fixture.adminB.id;
    contador += 1;
    const cto = await createCto(companyId, autor, {
      name: `CTO DIAG ${contador}`,
      capacity: 8,
    });
    id = cto.id;
  }
  const p = await prisma.cTOPort.findFirstOrThrow({
    where: { ctoId: id, number: porta },
  });
  await prisma.customerNetworkConnection.create({
    data: {
      companyId,
      customerId,
      ctoPortId: p.id,
      source: "WEB",
      connectedAt: new Date(),
    },
  });
  return id;
}

function snapshotDe(customerId: string) {
  return prisma.customerDiagnosticSnapshot.findFirstOrThrow({
    where: { customerId },
  });
}

// ---------------------------------------------------------------------------
// A regra pura: reconfirmar não reinicia a duração
// ---------------------------------------------------------------------------

describe("AUTO — a transição de estado", () => {
  const ontem = new Date("2026-09-14T08:00:00.000Z");
  const agora = new Date("2026-09-15T08:00:00.000Z");

  it("AUTO-01 · sem leitura anterior, o estado começa AGORA", () => {
    expect(resolveStatusSince(null, "ONLINE", agora)).toEqual(agora);
  });

  it("AUTO-02 · o MESMO estado preserva o começo — a duração não reinicia", () => {
    const anterior = { connectivityStatus: "ONLINE" as const, statusSince: ontem };
    expect(resolveStatusSince(anterior, "ONLINE", agora)).toEqual(ontem);
  });

  it("AUTO-03 · estado DIFERENTE data a transição no instante da observação", () => {
    const anterior = { connectivityStatus: "ONLINE" as const, statusSince: ontem };
    expect(resolveStatusSince(anterior, "OFFLINE", agora)).toEqual(agora);
  });

  it("AUTO-04 · reconfirmar o estado novo preserva a transição, não a repete", () => {
    const transicao = new Date("2026-09-15T07:00:00.000Z");
    const anterior = {
      connectivityStatus: "OFFLINE" as const,
      statusSince: transicao,
    };
    expect(resolveStatusSince(anterior, "OFFLINE", agora)).toEqual(transicao);
  });

  it("AUTO-07 · UNKNOWN observado é um estado como os outros, e data a transição", () => {
    const anterior = { connectivityStatus: "ONLINE" as const, statusSince: ontem };
    expect(resolveStatusSince(anterior, "UNKNOWN", agora)).toEqual(agora);
    const mesmo = { connectivityStatus: "UNKNOWN" as const, statusSince: ontem };
    expect(resolveStatusSince(mesmo, "UNKNOWN", agora)).toEqual(ontem);
  });
});

// ---------------------------------------------------------------------------
// A mesma regra, ponta a ponta, contra o banco e o provider
// ---------------------------------------------------------------------------

describe("AUTO — verificação real: o que é gravado", () => {
  it("AUTO-01b · primeira verificação: statusSince nasce igual a observedAt", async () => {
    const c = await cliente("-ONLINE");
    const r = await refreshCustomerDiagnostic(fixture.companyA.id, null, c.id, {
      audit: false,
    });

    expect(r.ok).toBe(true);
    expect(r.snapshot!.connectivityStatus).toBe("ONLINE");
    expect(r.snapshot!.statusSince).toEqual(r.snapshot!.observedAt);
  });

  it("AUTO-02b · reconfirmar ONLINE move só observedAt — statusSince fica onde estava", async () => {
    const c = await cliente("-ONLINE");
    const nove = new Date(Date.now() - 9 * DIA);
    await leituraAntiga(c.id, "ONLINE", nove, nove);

    await refreshCustomerDiagnostic(fixture.companyA.id, null, c.id, {
      audit: false,
    });

    const s = await snapshotDe(c.id);
    expect(s.connectivityStatus).toBe("ONLINE");
    // A prova: o começo continua a nove dias atrás.
    expect(s.statusSince.getTime()).toBe(nove.getTime());
    // E a conferência é de agora.
    expect(s.observedAt.getTime()).toBeGreaterThan(nove.getTime());
  });

  it("AUTO-03b · o estado MUDOU: statusSince passa a ser o instante da verificação", async () => {
    const c = await cliente("-ONLINE");
    const nove = new Date(Date.now() - 9 * DIA);
    await leituraAntiga(c.id, "ONLINE", nove, nove);

    // O provider passa a responder OFFLINE para este cliente.
    await prisma.customer.update({
      where: { id: c.id },
      data: { externalId: `${c.externalId!.replace("-ONLINE", "")}-OFFLINE` },
    });
    await refreshCustomerDiagnostic(fixture.companyA.id, null, c.id, {
      audit: false,
    });

    const s = await snapshotDe(c.id);
    expect(s.connectivityStatus).toBe("OFFLINE");
    expect(s.statusSince.getTime()).toBeGreaterThan(nove.getTime());
    expect(s.statusSince.getTime()).toBe(s.observedAt.getTime());
  });

  it("AUTO-04b · reconfirmar OFFLINE: a duração CRESCE, não reinicia", async () => {
    const c = await cliente("-OFFLINE");
    const transicao = new Date(Date.now() - 40 * MIN);
    await leituraAntiga(c.id, "OFFLINE", transicao, transicao);

    await refreshCustomerDiagnostic(fixture.companyA.id, null, c.id, {
      audit: false,
    });

    const s = await snapshotDe(c.id);
    expect(s.connectivityStatus).toBe("OFFLINE");
    expect(s.statusSince.getTime()).toBe(transicao.getTime());
    expect(s.observedAt.getTime()).toBeGreaterThan(transicao.getTime());
  });

  it("AUTO-05 · provider indisponível: estado, statusSince e observedAt INTACTOS", async () => {
    const c = await cliente("-FAIL");
    const cinco = new Date(Date.now() - 5 * DIA);
    const conferido = new Date(Date.now() - 4 * MIN);
    await leituraAntiga(c.id, "ONLINE", conferido, cinco);

    const r = await refreshCustomerDiagnostic(fixture.companyA.id, null, c.id, {
      audit: false,
    });

    expect(r.ok).toBe(false);
    const s = await snapshotDe(c.id);
    // Nada foi tocado. Em especial: NUNCA vira OFFLINE.
    expect(s.connectivityStatus).toBe("ONLINE");
    expect(s.statusSince.getTime()).toBe(cinco.getTime());
    expect(s.observedAt.getTime()).toBe(conferido.getTime());
  });

  it("AUTO-06 · timeout do provider: idem — a verificação apenas envelhece", async () => {
    const c = await cliente("-TIMEOUT");
    const conferido = new Date(Date.now() - 30 * MIN);
    await leituraAntiga(c.id, "OFFLINE", conferido, conferido);

    const r = await refreshCustomerDiagnostic(fixture.companyA.id, null, c.id, {
      audit: false,
    });

    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("TIMEOUT");
    const s = await snapshotDe(c.id);
    expect(s.connectivityStatus).toBe("OFFLINE");
    expect(s.observedAt.getTime()).toBe(conferido.getTime());
  }, 20_000);

  it("AUTO-08 · resultado ANTIGO que chega depois não sobrescreve o novo", async () => {
    const c = await cliente("-ONLINE");
    /*
      O cenário do enunciado: duas verificações em voo, e a que começou antes
      termina depois. Aqui a leitura "mais nova" já está gravada com um instante
      no futuro do relógio desta verificação, que é a única forma determinística
      de reproduzir a inversão sem cronometrar duas chamadas reais.
    */
    const futuro = new Date(Date.now() + 10 * MIN);
    await leituraAntiga(c.id, "OFFLINE", futuro, futuro);

    await refreshCustomerDiagnostic(fixture.companyA.id, null, c.id, {
      audit: false,
    });

    const s = await snapshotDe(c.id);
    // A observação mais nova permanece: a mais velha casou zero linhas.
    expect(s.connectivityStatus).toBe("OFFLINE");
    expect(s.observedAt.getTime()).toBe(futuro.getTime());
  });

  it("AUTO-09 · o ciclo automático NÃO enche a auditoria", async () => {
    const c = await cliente("-ONLINE");
    const antes = await prisma.auditLog.count({
      where: { companyId: fixture.companyA.id, action: "CUSTOMER_DIAGNOSTIC.REFRESHED" },
    });

    await refreshCustomerDiagnostic(fixture.companyA.id, null, c.id, {
      audit: false,
    });
    const semAudit = await prisma.auditLog.count({
      where: { companyId: fixture.companyA.id, action: "CUSTOMER_DIAGNOSTIC.REFRESHED" },
    });
    expect(semAudit).toBe(antes);

    // Mas a ação HUMANA continua auditada.
    await refreshCustomerDiagnostic(fixture.companyA.id, fixture.adminA.id, c.id);
    const comAudit = await prisma.auditLog.count({
      where: { companyId: fixture.companyA.id, action: "CUSTOMER_DIAGNOSTIC.REFRESHED" },
    });
    expect(comAudit).toBe(antes + 1);
  });
});

// ---------------------------------------------------------------------------
// Quem entra no ciclo
// ---------------------------------------------------------------------------

describe("SCHED — a elegibilidade", () => {
  it("SCHED-01 · verificado há mais que o alvo: elegível", async () => {
    const c = await cliente("-ONLINE");
    await ligarNaPorta(c.id, 1);
    await leituraAntiga(
      c.id,
      "ONLINE",
      new Date(Date.now() - 7 * MIN),
      new Date(Date.now() - 7 * MIN),
    );

    const { due } = await findConnectionsDueForCheck(new Date());
    expect(due.map((d) => d.customerId)).toContain(c.id);
  });

  it("SCHED-02 · verificado há 2 minutos: NÃO elegível", async () => {
    const c = await cliente("-ONLINE");
    await ligarNaPorta(c.id, 1);
    await leituraAntiga(
      c.id,
      "ONLINE",
      new Date(Date.now() - 2 * MIN),
      new Date(Date.now() - 2 * MIN),
    );

    const { due } = await findConnectionsDueForCheck(new Date());
    expect(due.map((d) => d.customerId)).not.toContain(c.id);
  });

  it("SCHED-02b · NUNCA verificado: elegível — é o caso mais urgente", async () => {
    const c = await cliente("-ONLINE");
    await ligarNaPorta(c.id, 1);

    const { due } = await findConnectionsDueForCheck(new Date());
    expect(due.map((d) => d.customerId)).toContain(c.id);
  });

  it("SCHED-03 · cliente SEM conexão não entra, por mais velha que seja a leitura", async () => {
    const c = await cliente("-ONLINE");
    await leituraAntiga(
      c.id,
      "ONLINE",
      new Date(Date.now() - 9 * DIA),
      new Date(Date.now() - 9 * DIA),
    );

    const { due } = await findConnectionsDueForCheck(new Date());
    expect(due.map((d) => d.customerId)).not.toContain(c.id);
  });

  it("SCHED-04 · conexão ENCERRADA não entra: história não se reconsulta", async () => {
    const c = await cliente("-ONLINE");
    await ligarNaPorta(c.id, 1);
    await prisma.customerNetworkConnection.updateMany({
      where: { customerId: c.id },
      data: { disconnectedAt: new Date() },
    });

    const { due } = await findConnectionsDueForCheck(new Date());
    expect(due.map((d) => d.customerId)).not.toContain(c.id);
  });

  it("SCHED-05 · cadastro INATIVO com conexão ativa É elegível", async () => {
    const c = await cliente("-ONLINE", { ativo: false });
    await ligarNaPorta(c.id, 1);

    const { due } = await findConnectionsDueForCheck(new Date());
    // O cabo continua no poste. Ignorá-lo esconderia equipamento em campo.
    expect(due.map((d) => d.customerId)).toContain(c.id);
  });

  it("SCHED-06 · cada conexão carrega o tenant dela", async () => {
    const a = await cliente("-ONLINE");
    await ligarNaPorta(a.id, 1);
    const b = await cliente("-ONLINE", { companyId: fixture.companyB.id });
    await ligarNaPorta(b.id, 1, fixture.companyB.id);

    const { due } = await findConnectionsDueForCheck(new Date());
    const porCliente = new Map(due.map((d) => [d.customerId, d.companyId]));
    expect(porCliente.get(a.id)).toBe(fixture.companyA.id);
    expect(porCliente.get(b.id)).toBe(fixture.companyB.id);
  });

  it("SCHED-09 · o teto corta o ciclo, e a lista continua na volta seguinte", async () => {
    const ctoId = await ligarNaPorta((await cliente("-ONLINE")).id, 1);
    for (let i = 2; i <= 4; i += 1) {
      const c = await cliente("-ONLINE");
      await ligarNaPorta(c.id, i, fixture.companyA.id, ctoId);
    }

    const { due } = await findConnectionsDueForCheck(new Date(), 5 * MIN, 2);
    expect(due).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// O ciclo inteiro
// ---------------------------------------------------------------------------

describe("SCHED — o ciclo", () => {
  it("SCHED-07 · empresa cujo ERP não faz diagnóstico é pulada UMA vez, não por cliente", async () => {
    /*
      A empresa B não tem integração nenhuma: `resolveProvider` devolve null e o
      domínio responde NOT_SUPPORTED. Três clientes ligados não podem virar três
      falhas de provider — isso encheria o log de uma falha que é de
      configuração, não de rede.
    */
    const ctoId = await ligarNaPorta(
      (await cliente("-ONLINE", { companyId: fixture.companyB.id })).id,
      1,
      fixture.companyB.id,
    );
    for (let i = 2; i <= 3; i += 1) {
      const c = await cliente("-ONLINE", { companyId: fixture.companyB.id });
      await ligarNaPorta(c.id, i, fixture.companyB.id, ctoId);
    }

    const r = await runConnectivityRefreshCycle();
    /*
      UMA empresa, não três tentativas. Com concorrência, a primeira onda bate
      na mesma empresa antes de qualquer resposta chegar — contar tentativas
      diria "tres empresas puladas" onde existe uma. E nada disso é falha de
      provider: ninguém foi chamado.
    */
    expect(r.skippedCompanies).toBe(1);
    expect(r.providerFailures).toBe(0);
  });

  it("SCHED-08 · dois ciclos ao mesmo tempo não refazem o mesmo trabalho", async () => {
    const velha = new Date(Date.now() - 30 * MIN);
    const ctoId = await ligarNaPorta((await cliente("-ONLINE")).id, 1);
    for (let i = 2; i <= 6; i += 1) {
      const c = await cliente("-ONLINE");
      await ligarNaPorta(c.id, i, fixture.companyA.id, ctoId);
    }
    /*
      O estado REAL de regime: todo cliente já foi verificado alguma vez, e a
      verificação venceu. É nele que a reserva vale — quem nunca foi verificado
      não tem linha onde ser reservado, e essa janela está declarada no módulo.
    */
    for (const v of await prisma.customerNetworkConnection.findMany({
      where: { companyId: fixture.companyA.id, disconnectedAt: null },
      select: { customerId: true },
    })) {
      await leituraAntiga(v.customerId, "ONLINE", velha, velha);
    }

    const [um, dois] = await Promise.all([
      runConnectivityRefreshCycle(),
      runConnectivityRefreshCycle(),
    ]);

    /*
      A asserção PROÍBE o desfecho ruim em vez de tolerá-lo: as seis conexões
      existem uma vez, e a soma do que os dois ciclos processaram não pode
      passar disso por muito — a janela residual é a lista lida no mesmo
      instante, fechada no banco pela escrita monotônica.

      O que não pode acontecer é cada ciclo processar as seis: isso seria o
      dobro das chamadas ao provider a cada volta.
    */
    const total = um.processed + dois.processed;
    // As seis foram verificadas...
    expect(total).toBe(6);
    // ...e o outro ciclo enxergou que eram de alguém, em vez de refazê-las.
    expect(um.claimedByOther + dois.claimedByOther).toBe(6);

    // E o banco fica coerente: uma linha por cliente, com estado observado.
    const linhas = await prisma.customerDiagnosticSnapshot.findMany({
      where: { companyId: fixture.companyA.id },
    });
    expect(linhas).toHaveLength(6);
    for (const l of linhas) expect(l.connectivityStatus).toBe("ONLINE");
  }, 30_000);

  /*
    O ciclo morre no meio, depois de reservar e antes de o provider responder.

    Sem prazo, aquele cliente ficaria reservado para sempre e nunca mais seria
    verificado — o worker teria criado, sozinho, um ponto cego permanente. É o
    mesmo motivo pelo qual a reivindicação do outbox tem lease de 5 minutos.
  */
  it("SCHED-12 · a reserva EXPIRA: um ciclo que morre não tranca o cliente", async () => {
    const c = await cliente("-ONLINE");
    await ligarNaPorta(c.id, 1);
    const velha = new Date(Date.now() - 30 * MIN);
    await leituraAntiga(c.id, "ONLINE", velha, velha);

    // O ciclo que "morreu": reservou e não escreveu nada.
    const reservado = await claimCustomerForCheck(
      fixture.companyA.id,
      c.id,
      new Date(),
    );
    expect(reservado).toBe(true);

    // Enquanto o prazo vale, ninguém mais pega — e nada é consultado.
    const durante = await runConnectivityRefreshCycle();
    expect(durante.processed).toBe(0);
    expect(durante.claimedByOther).toBe(1);
    // A leitura continua velha: o ciclo morto não conferiu nada.
    expect((await snapshotDe(c.id)).observedAt.getTime()).toBe(velha.getTime());

    // Vencido o prazo, o cliente volta à fila.
    await prisma.customerDiagnosticSnapshot.updateMany({
      where: { customerId: c.id },
      data: { refreshLeaseUntil: new Date(Date.now() - MIN) },
    });
    const depois = await runConnectivityRefreshCycle();
    expect(depois.processed).toBe(1);
    expect((await snapshotDe(c.id)).observedAt.getTime()).toBeGreaterThan(
      velha.getTime(),
    );
  });

  it("SCHED-13 · a reserva não é estado de conectividade", async () => {
    const c = await cliente("-ONLINE");
    await ligarNaPorta(c.id, 1);
    const velha = new Date(Date.now() - 30 * MIN);
    await leituraAntiga(c.id, "OFFLINE", velha, velha);

    await claimCustomerForCheck(fixture.companyA.id, c.id, new Date());

    /*
      Reservar NÃO muda o que o cliente é. Se algum dia a reserva vazar para a
      leitura, a tela passaria a depender de infraestrutura de worker para dizer
      se alguém está no ar.
    */
    const s = await snapshotDe(c.id);
    expect(s.connectivityStatus).toBe("OFFLINE");
    expect(s.statusSince.getTime()).toBe(velha.getTime());
    expect(s.observedAt.getTime()).toBe(velha.getTime());

    const vista = await getConnectivityForCustomers(fixture.companyA.id, [c.id]);
    expect(vista.get(c.id)!.connectivityStatus).toBe("OFFLINE");
    expect(Object.keys(vista.get(c.id)!)).not.toContain("refreshLeaseUntil");
  });

  it("SCHED-10 · o ciclo conta o que verificou, e não vaza dado pessoal", async () => {
    const online = await cliente("-ONLINE");
    const ctoId = await ligarNaPorta(online.id, 1);
    const offline = await cliente("-OFFLINE");
    await ligarNaPorta(offline.id, 2, fixture.companyA.id, ctoId);
    const falha = await cliente("-FAIL");
    await ligarNaPorta(falha.id, 3, fixture.companyA.id, ctoId);

    const r = await runConnectivityRefreshCycle();

    expect(r.eligible).toBe(3);
    expect(r.processed).toBe(3);
    expect(r.online).toBe(1);
    expect(r.offline).toBe(1);
    expect(r.providerFailures).toBe(1);
    // O resultado é só números — não há onde um nome de cliente caber.
    expect(Object.values(r).every((v) => typeof v === "number")).toBe(true);
  }, 20_000);

  it("SCHED-11 · nenhuma consulta por cliente: o ciclo lê a lista em LOTE", async () => {
    const ctoId = await ligarNaPorta((await cliente("-ONLINE")).id, 1);
    for (let i = 2; i <= 5; i += 1) {
      const c = await cliente("-ONLINE");
      await ligarNaPorta(c.id, i, fixture.companyA.id, ctoId);
    }

    const espiaoVinculo = vi.spyOn(prisma.customerNetworkConnection, "findMany");
    const espiaoSnapshot = vi.spyOn(prisma.customerDiagnosticSnapshot, "findMany");
    try {
      await findConnectionsDueForCheck(new Date());
      // Cinco conexões, duas consultas. Nunca uma por cliente.
      expect(espiaoVinculo).toHaveBeenCalledTimes(1);
      expect(espiaoSnapshot).toHaveBeenCalledTimes(1);
    } finally {
      espiaoVinculo.mockRestore();
      espiaoSnapshot.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// O que o técnico lê na tela
// ---------------------------------------------------------------------------

describe("AUTO-CONFUSAO — duração e frescor são coisas diferentes", () => {
  /*
    O teste que a fase existe para ter.

    Se alguém voltar a derivar "Online há X" de `observedAt`, este teste passa a
    dizer "há 3 min" onde deveria dizer "há 9 d", e cai.
  */
  it("AUTO-CONFUSAO-01 · Online há 9 dias, verificado há 3 min — nunca 'Online há 3 min'", () => {
    const agora = new Date("2026-09-15T12:00:00.000Z");
    const statusSince = new Date(agora.getTime() - 9 * DIA).toISOString();
    const observedAt = new Date(agora.getTime() - 3 * MIN).toISOString();

    expect(connectivityStatusDuration(statusSince, agora)).toBe("há 9 d");
    expect(connectivityAge(observedAt, agora)).toBe("há 3 min");
    // E o contrário nunca acontece por acaso:
    expect(connectivityStatusDuration(statusSince, agora)).not.toBe("há 3 min");
  });

  it("AUTO-STALE-01 · a verificação atrasa só depois do DOBRO do alvo", () => {
    const agora = new Date("2026-09-15T12:00:00.000Z");
    const recente = new Date(agora.getTime() - 4 * MIN).toISOString();
    const noLimite = new Date(agora.getTime() - 10 * MIN).toISOString();
    const atrasada = new Date(agora.getTime() - 37 * MIN).toISOString();

    expect(isConnectivityCheckStale(recente, agora)).toBe(false);
    expect(isConnectivityCheckStale(noLimite, agora)).toBe(false);
    expect(isConnectivityCheckStale(atrasada, agora)).toBe(true);
  });

  it("AUTO-STALE-02 · nunca verificado NÃO é 'atrasado' — é sem leitura", () => {
    expect(isConnectivityCheckStale(null)).toBe(false);
    expect(connectivityStatusDuration(null)).toBeNull();
  });
});
