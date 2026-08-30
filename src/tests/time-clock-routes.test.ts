import { describe, it, expect, beforeEach } from "vitest";
import { GET as todayRoute } from "@/app/api/field/v1/time-clock/today/route";
import { POST as punchRoute } from "@/app/api/field/v1/time-clock/entries/route";
import { GET as historyRoute } from "@/app/api/field/v1/time-clock/history/route";
import {
  GET as ownAdjustmentsRoute,
  POST as requestAdjustmentRoute,
} from "@/app/api/field/v1/time-clock/adjustments/route";
import { POST as decisionRoute } from "@/app/api/time-clock/adjustments/[id]/decision/route";
import { GET as adminQueueRoute } from "@/app/api/time-clock/adjustments/route";
import { prisma } from "@/lib/prisma";
import {
  apiRequest,
  createTokenFor,
  fieldRequest,
  registerTestDevice,
  seedTestData,
  type TestFixture,
} from "./helpers";

/**
 * # Jornada pelas ROTAS reais do Field
 *
 * O que só existe na camada HTTP e por isso não cabe em `time-clock.test.ts`:
 * autenticação por token de aparelho, idempotência, aparelho revogado e a
 * recusa de campos que o corpo não pode trazer.
 *
 * Nada de dado real.
 */

let fixture: TestFixture;

beforeEach(async () => {
  fixture = await seedTestData();
});

let keySeed = 0;
const key = (step: string) => `ponto-${step}-${(keySeed += 1)}-${Date.now()}`;

async function body(response: Response) {
  return (await response.json()) as {
    ok: boolean;
    data?: Record<string, unknown>;
    error?: { code: string; message: string; retryable?: boolean };
  };
}

async function cenario() {
  const technician = await prisma.technician.upsert({
    where: { userId: fixture.techA.id },
    update: {},
    create: { companyId: fixture.companyA.id, userId: fixture.techA.id },
  });
  const { token, deviceId } = await registerTestDevice(fixture.techA.id, {
    installationId: key("inst"),
  });
  return { technician, token, deviceId };
}

function punch(
  token: string,
  payload: Record<string, unknown>,
  idempotencyKey: string,
) {
  return punchRoute(
    fieldRequest("/api/field/v1/time-clock/entries", {
      method: "POST",
      token,
      idempotencyKey,
      body: payload,
    }),
  );
}

describe("Field — batida de ponto", () => {
  it("registra e devolve estado e ações permitidas pelo SERVIDOR", async () => {
    const { token, technician, deviceId } = await cenario();

    const response = await punch(token, { type: "CLOCK_IN" }, key("in"));
    expect(response.status).toBe(201);

    const payload = await body(response);
    const workday = payload.data?.workday as {
      state: string;
      allowedActions: string[];
    };
    expect(workday.state).toBe("WORKING");
    // O app desenha o botão a partir DESTA lista.
    expect(workday.allowedActions).toEqual(["BREAK_START", "CLOCK_OUT"]);

    /*
      Aparelho e técnico vêm do TOKEN, não do corpo.

      O corpo enviado não tinha nenhum dos dois, e mesmo assim a linha os traz —
      é o que garante que ninguém bate ponto por outra pessoa nem forja de que
      aparelho a batida veio.
    */
    const linha = await prisma.timeEntry.findFirstOrThrow({
      where: { userId: fixture.techA.id },
    });
    expect(linha.technicianId).toBe(technician.id);
    expect(linha.mobileDeviceId).toBe(deviceId);
    expect(linha.source).toBe("FIELD_APP");
  });

  it("o corpo NÃO pode trazer identidade nem horário oficial", async () => {
    const { token } = await cenario();

    for (const proibido of [
      { type: "CLOCK_IN", userId: fixture.techB.id },
      { type: "CLOCK_IN", companyId: fixture.companyB.id },
      { type: "CLOCK_IN", technicianId: "forjado" },
      { type: "CLOCK_IN", occurredAt: "2020-01-01T00:00:00.000Z" },
    ]) {
      const response = await punch(token, proibido, key("proibido"));
      // `.strict()`: campo desconhecido é RECUSADO, não descartado em silêncio.
      // Um app que tenta decidir identidade pelo corpo precisa ouvir um "não".
      expect(response.status).toBe(400);
    }

    expect(
      await prisma.timeEntry.count({ where: { companyId: fixture.companyA.id } }),
    ).toBe(0);
  });

  it("DUPLO TOQUE com a mesma chave produz UMA marcação", async () => {
    const { token } = await cenario();
    const chave = key("duplo");

    const primeira = await punch(token, { type: "CLOCK_IN" }, chave);
    const segunda = await punch(token, { type: "CLOCK_IN" }, chave);

    expect(primeira.status).toBe(201);
    // A retentativa recebe a resposta MEMORIZADA, não um erro de transição.
    expect(segunda.status).toBe(201);

    expect(
      await prisma.timeEntry.count({ where: { userId: fixture.techA.id } }),
    ).toBe(1);
  });

  it("mesma chave com corpo diferente é IDEMPOTENCY_CONFLICT", async () => {
    const { token } = await cenario();
    const chave = key("conflito");

    expect((await punch(token, { type: "CLOCK_IN" }, chave)).status).toBe(201);

    const divergente = await punch(token, { type: "CLOCK_OUT" }, chave);
    expect(divergente.status).toBe(409);
    expect((await body(divergente)).error?.code).toBe("IDEMPOTENCY_CONFLICT");

    expect(
      await prisma.timeEntry.count({ where: { userId: fixture.techA.id } }),
    ).toBe(1);
  });

  it("chaves DIFERENTES para a mesma transição inválida ainda são recusadas", async () => {
    const { token } = await cenario();
    await punch(token, { type: "CLOCK_IN" }, key("a"));

    /*
      A idempotência não substitui a máquina de estados.

      Chave nova é um comando novo, e o domínio o recusa por sequência — não por
      duplicidade. Confundir os dois faria o segundo toque "funcionar" só por
      trocar de chave.
    */
    const segunda = await punch(token, { type: "CLOCK_IN" }, key("b"));
    expect(segunda.status).toBe(400);
    expect(
      await prisma.timeEntry.count({ where: { userId: fixture.techA.id } }),
    ).toBe(1);
  });

  it("sem Idempotency-Key a batida é recusada", async () => {
    const { token } = await cenario();
    const response = await punchRoute(
      fieldRequest("/api/field/v1/time-clock/entries", {
        method: "POST",
        token,
        body: { type: "CLOCK_IN" },
      }),
    );
    expect(response.status).toBe(400);
    expect(
      await prisma.timeEntry.count({ where: { userId: fixture.techA.id } }),
    ).toBe(0);
  });

  it("aparelho REVOGADO não bate ponto", async () => {
    const { token, deviceId } = await cenario();
    await prisma.mobileDevice.update({
      where: { id: deviceId },
      data: { status: "REVOKED", revokedAt: new Date() },
    });

    const response = await punch(token, { type: "CLOCK_IN" }, key("revogado"));

    /*
      401, e não 403 — o comportamento da v0.9, não uma exceção da jornada.

      Revogado o aparelho, o token deixa de valer: a recusa é a mesma de um
      token inventado, e uniforme de propósito. `DEVICE_REVOKED` (403) existe no
      LOGIN, onde a pessoa já provou a credencial e precisa saber que insistir
      não adianta — em vez de ficar redigitando a senha.
    */
    expect(response.status).toBe(401);
    expect((await body(response)).error?.code).toBe("UNAUTHENTICATED");

    // O que importa: aparelho revogado NÃO registra jornada.
    expect(
      await prisma.timeEntry.count({ where: { userId: fixture.techA.id } }),
    ).toBe(0);
  });

  it("sem token não há jornada", async () => {
    const response = await todayRoute(
      fieldRequest("/api/field/v1/time-clock/today"),
    );
    expect(response.status).toBe(401);
  });
});

describe("Field — leitura da jornada", () => {
  it("hoje devolve a própria jornada, e só a própria", async () => {
    const { token } = await cenario();
    await punch(token, { type: "CLOCK_IN" }, key("in"));

    // Jornada do colega, na mesma empresa — não pode aparecer.
    await prisma.technician.upsert({
      where: { userId: fixture.techB.id },
      update: {},
      create: { companyId: fixture.companyA.id, userId: fixture.techB.id },
    });
    const colega = await registerTestDevice(fixture.techB.id, {
      installationId: key("inst-b"),
    });
    await punch(colega.token, { type: "CLOCK_IN" }, key("in-b"));

    const payload = await body(
      await todayRoute(fieldRequest("/api/field/v1/time-clock/today", { token })),
    );
    const workday = payload.data?.workday as {
      entries: { id: string }[];
    };
    expect(workday.entries).toHaveLength(1);
  });

  it("período longo demais no histórico é recusado", async () => {
    const { token } = await cenario();
    const response = await historyRoute(
      fieldRequest(
        "/api/field/v1/time-clock/history?from=2020-01-01&to=2026-01-01",
        { token },
      ),
    );
    expect(response.status).toBe(400);
  });
});

describe("Field — pedido de correção", () => {
  it("abre o pedido e ele aparece na lista do próprio funcionário", async () => {
    const { token } = await cenario();
    await punch(token, { type: "CLOCK_IN" }, key("in"));

    const response = await requestAdjustmentRoute(
      fieldRequest("/api/field/v1/time-clock/adjustments", {
        method: "POST",
        token,
        idempotencyKey: key("ajuste"),
        body: {
          requestedType: "MISSING_ENTRY",
          requestedEntryType: "CLOCK_OUT",
          requestedOccurredAt: new Date(Date.now() - 60_000).toISOString(),
          reason: "Esqueci de bater a saída.",
        },
      }),
    );
    expect(response.status).toBe(201);

    const lista = await body(
      await ownAdjustmentsRoute(
        fieldRequest("/api/field/v1/time-clock/adjustments", { token }),
      ),
    );
    expect((lista.data?.adjustments as unknown[]).length).toBe(1);
  });

  it("o pedido NÃO cria marcação por si — ele espera decisão", async () => {
    const { token } = await cenario();
    await punch(token, { type: "CLOCK_IN" }, key("in"));

    await requestAdjustmentRoute(
      fieldRequest("/api/field/v1/time-clock/adjustments", {
        method: "POST",
        token,
        idempotencyKey: key("ajuste"),
        body: {
          requestedType: "MISSING_ENTRY",
          requestedEntryType: "CLOCK_OUT",
          requestedOccurredAt: new Date(Date.now() - 60_000).toISOString(),
          reason: "Esqueci.",
        },
      }),
    );

    // Uma marcação só: a do CLOCK_IN. O pedido é intenção, não fato.
    expect(
      await prisma.timeEntry.count({ where: { userId: fixture.techA.id } }),
    ).toBe(1);
    expect(
      await prisma.timeAdjustmentRequest.count({
        where: { userId: fixture.techA.id, status: "PENDING" },
      }),
    ).toBe(1);
  });
});

describe("Field + painel — o ataque completo, pelas rotas", () => {
  it("o servidor mostra a jornada encerrada e RECUSA a batida", async () => {
    /*
      O caminho inteiro, sem atalho pelo domínio: o técnico bate pelo Field, o
      técnico pede a correção pelo Field, o ADMIN decide pelo painel, e o
      técnico tenta bater de novo pelo Field.

      Era aqui que espelho e escrita discordavam: `/today` respondia jornada
      encerrada, sem nenhuma ação permitida, e `POST /entries` aceitava um
      retorno de intervalo — porque a última linha por horário era um início de
      intervalo já superado pela correção.
    */
    const { token } = await cenario();

    await punch(token, { type: "CLOCK_IN" }, key("in"));
    /*
      A pausa separa os dois carimbos do servidor.

      Sem ela as duas batidas caem a milissegundos uma da outra e não sobra
      instante ENTRE elas para a correção pedir — e o ataque depende exatamente
      disso: a marcação superada precisa ficar depois da saída corrigida.
    */
    await new Promise((resolve) => setTimeout(resolve, 25));
    await punch(token, { type: "BREAK_START" }, key("break"));

    const [entrada, intervalo] = await prisma.timeEntry.findMany({
      where: { userId: fixture.techA.id },
      orderBy: { occurredAt: "asc" },
    });
    expect(intervalo.occurredAt.getTime() - entrada.occurredAt.getTime()).
      toBeGreaterThan(10);

    // "Aquilo não era intervalo, era a minha saída — e foi antes."
    const pedido = await requestAdjustmentRoute(
      fieldRequest("/api/field/v1/time-clock/adjustments", {
        method: "POST",
        token,
        idempotencyKey: key("ajuste"),
        body: {
          requestedType: "WRONG_TIME",
          requestedEntryType: "CLOCK_OUT",
          requestedOccurredAt: new Date(
            entrada.occurredAt.getTime() + 10,
          ).toISOString(),
          reason: "Bati intervalo quando já estava saindo.",
          targetEntryId: intervalo.id,
        },
      }),
    );
    expect(pedido.status).toBe(201);
    const pedidoId = (
      (await body(pedido)).data?.adjustment as { id: string }
    ).id;

    const decisao = await decisionRoute(
      apiRequest(
        `/api/time-clock/adjustments/${pedidoId}/decision`,
        {
          method: "POST",
          body: { decision: "APPROVED" },
          headers: { Origin: "http://localhost", Host: "localhost" },
        },
        await createTokenFor(fixture.adminA.id),
      ),
      { params: { id: pedidoId } },
    );
    expect(decisao.status).toBe(200);

    // O servidor DIZ que acabou.
    const hoje = await todayRoute(
      fieldRequest("/api/field/v1/time-clock/today", { token }),
    );
    const workday = (await body(hoje)).data?.workday as {
      state: string;
      allowedActions: string[];
    };
    expect(workday.state).toBe("FINISHED");
    expect(workday.allowedActions).toEqual([]);

    // E RECUSA de acordo. Sem isto, a jornada encerrada continuava recebendo
    // marcação pelo aplicativo.
    const tentativa = await punch(token, { type: "BREAK_END" }, key("volta"));
    expect(tentativa.status).toBe(400);

    const erro = (await body(tentativa)).error;
    // Código estável do catálogo — o app nunca interpreta mensagem humana.
    expect(erro?.code).toBe("VALIDATION_ERROR");
    expect(erro?.retryable).toBe(false);

    // Três linhas: entrada, intervalo superado e a saída derivada. Nada a mais.
    expect(
      await prisma.timeEntry.count({ where: { userId: fixture.techA.id } }),
    ).toBe(3);
  });

  it("pedir correção sobre marcação JÁ corrigida volta CONFLICT, não erro de servidor", async () => {
    /*
      A recusa nova precisa chegar ao aplicativo como código ESTÁVEL.

      Um 409 que virasse 500 diria ao Flutter "tente de novo" — e a retentativa
      nunca funcionaria, porque o pedido está errado, não a rede.
    */
    const { token } = await cenario();
    await punch(token, { type: "CLOCK_IN" }, key("in"));

    const entrada = await prisma.timeEntry.findFirstOrThrow({
      where: { userId: fixture.techA.id },
    });
    // 1ms antes: mesmo dia civil em qualquer hora em que a suíte rode.
    const antes = new Date(entrada.occurredAt.getTime() - 1).toISOString();

    const primeiro = await requestAdjustmentRoute(
      fieldRequest("/api/field/v1/time-clock/adjustments", {
        method: "POST",
        token,
        idempotencyKey: key("ajuste1"),
        body: {
          requestedType: "WRONG_TIME",
          requestedEntryType: "CLOCK_IN",
          requestedOccurredAt: antes,
          reason: "Cheguei um pouco antes.",
          targetEntryId: entrada.id,
        },
      }),
    );
    const primeiroId = (
      (await body(primeiro)).data?.adjustment as { id: string }
    ).id;

    await decisionRoute(
      apiRequest(
        `/api/time-clock/adjustments/${primeiroId}/decision`,
        {
          method: "POST",
          body: { decision: "APPROVED" },
          headers: { Origin: "http://localhost", Host: "localhost" },
        },
        await createTokenFor(fixture.adminA.id),
      ),
      { params: { id: primeiroId } },
    );

    // Segundo pedido apontando para a marcação que já foi superada.
    const segundo = await requestAdjustmentRoute(
      fieldRequest("/api/field/v1/time-clock/adjustments", {
        method: "POST",
        token,
        idempotencyKey: key("ajuste2"),
        body: {
          requestedType: "WRONG_TIME",
          requestedEntryType: "CLOCK_IN",
          requestedOccurredAt: antes,
          reason: "De novo na versão antiga.",
          targetEntryId: entrada.id,
        },
      }),
    );

    expect(segundo.status).toBe(409);
    const erro = (await body(segundo)).error;
    expect(erro?.code).toBe("CONFLICT");
    expect(erro?.retryable).toBe(false);

    // Um pedido aprovado, e nada pendente sobrando.
    expect(
      await prisma.timeAdjustmentRequest.count({
        where: { userId: fixture.techA.id },
      }),
    ).toBe(1);
  });
});

/*
  E2E PERMANENTE DA JORNADA (§253, fechamento da Fase 1).

  O dia inteiro pelas rotas reais — as quatro transições, e depois a correção
  ponta a ponta: o Field pede, o painel vê, OUTRO administrador decide, o Field
  relê e encontra a versão corrigida valendo, com a original preservada.

  Existe como teste permanente, e não como roteiro de piloto, porque foi o
  piloto físico que encontrou os três defeitos que esta rodada fecha. O que só
  se verifica à mão volta a quebrar quando ninguém estiver olhando.
*/
describe("E2E — o dia inteiro e a correção, pelas rotas", () => {
  const estadoDe = async (response: Response) => {
    const payload = await body(response);
    return payload.data?.workday as {
      state: string;
      allowedActions: string[];
      utcOffset: string;
      entries: { id: string; type: string; fromAdjustment: boolean }[];
    };
  };

  it("CLOCK_IN → BREAK_START → BREAK_END → CLOCK_OUT, e o servidor manda o estado", async () => {
    const { token } = await cenario();

    /*
      O estado NUNCA é derivado no cliente.

      Cada batida devolve o estado novo e a lista de ações permitidas, e é
      dessa lista que o aplicativo desenha o botão. Um APK que decidisse
      sozinho continuaria oferecendo uma transição que o servidor já recusa.
    */
    const passos = [
      { type: "CLOCK_IN", estado: "WORKING", segue: ["BREAK_START", "CLOCK_OUT"] },
      { type: "BREAK_START", estado: "ON_BREAK", segue: ["BREAK_END"] },
      { type: "BREAK_END", estado: "WORKING", segue: ["BREAK_START", "CLOCK_OUT"] },
      { type: "CLOCK_OUT", estado: "FINISHED", segue: [] },
    ] as const;

    for (const passo of passos) {
      const r = await punch(token, { type: passo.type }, key(passo.type));
      expect(r.status).toBe(201);

      const workday = await estadoDe(r);
      expect(workday.state).toBe(passo.estado);
      expect(workday.allowedActions).toEqual([...passo.segue]);
    }

    /*
      Encerrada, a jornada não reabre por batida: reabrir é correção (§229).

      400, e não 409: nada mudou debaixo do aparelho para o app recarregar e
      resolver. A transição pedida é inválida naquele estado, e a saída é o
      pedido de correção — que é o que a mensagem manda fazer.
    */
    const depois = await punch(token, { type: "CLOCK_IN" }, key("reabrir"));
    expect(depois.status).toBe(400);
    expect((await body(depois)).error?.message).toContain("solicite um ajuste");

    // Quatro marcações, nenhuma delas derivada de correção.
    const linhas = await prisma.timeEntry.findMany({
      where: { userId: fixture.techA.id },
      orderBy: { occurredAt: "asc" },
      select: { type: true, source: true },
    });
    expect(linhas.map((l) => l.type)).toEqual([
      "CLOCK_IN",
      "BREAK_START",
      "BREAK_END",
      "CLOCK_OUT",
    ]);
    expect(linhas.every((l) => l.source === "FIELD_APP")).toBe(true);
  });

  it("Field pede, painel vê, OUTRO admin aprova, Field relê a versão corrigida", async () => {
    const { token } = await cenario();

    // 1. O dia acontece.
    await punch(token, { type: "CLOCK_IN" }, key("in"));
    const hoje = await estadoDe(
      await todayRoute(
        fieldRequest("/api/field/v1/time-clock/today", { token }),
      ),
    );
    const entradaOriginal = hoje.entries[0];
    expect(entradaOriginal.fromAdjustment).toBe(false);

    // O DTO carrega o fuso da empresa: é com ele que o aplicativo monta o
    // horário pedido, e não com o relógio do aparelho (§253, LOW-3).
    expect(hoje.utcOffset).toMatch(/^[+-]\d{2}:\d{2}$/);

    // 2. O técnico pede a correção pelo Field.
    const corrigidoPara = new Date(Date.now() - 30 * 60_000);
    const pedido = await requestAdjustmentRoute(
      fieldRequest("/api/field/v1/time-clock/adjustments", {
        method: "POST",
        token,
        idempotencyKey: key("pedido"),
        body: {
          requestedType: "WRONG_TIME",
          requestedEntryType: "CLOCK_IN",
          requestedOccurredAt: corrigidoPara.toISOString(),
          reason: "bati depois de já ter começado",
          targetEntryId: entradaOriginal.id,
        },
      }),
    );
    expect(pedido.status).toBe(201);
    const pedidoId = (
      (await body(pedido)).data as { adjustment: { id: string } }
    ).adjustment.id;

    // 3. O painel VÊ o pedido na fila — mesma fila, sem segundo caminho.
    const fila = await adminQueueRoute(
      apiRequest(
        "/api/time-clock/adjustments",
        {},
        await createTokenFor(fixture.adminA.id),
      ),
    );
    const naFila = (
      (await fila.json()) as { data: { adjustments: { id: string }[] } }
    ).data.adjustments;
    expect(naFila.map((a) => a.id)).toContain(pedidoId);

    // 4. OUTRO administrador decide. Quem pediu foi o técnico, então qualquer
    //    ADMIN serve — o que a regra proíbe é decidir o que se pediu para si.
    const segundoAdmin = await prisma.user.create({
      data: {
        companyId: fixture.companyA.id,
        name: "Administradora do Turno",
        email: "turno@alfa.test",
        profile: "ADMIN",
        active: true,
        passwordHash: "x",
      },
      select: { id: true },
    });
    const decisao = await decisionRoute(
      apiRequest(
        `/api/time-clock/adjustments/${pedidoId}/decision`,
        {
          method: "POST",
          body: { decision: "APPROVED" },
          headers: { Origin: "http://localhost", Host: "localhost" },
        },
        await createTokenFor(segundoAdmin.id),
      ),
      { params: { id: pedidoId } },
    );
    expect(decisao.status).toBe(200);

    // 5. O Field RELÊ e encontra a versão corrigida valendo.
    const depois = await estadoDe(
      await todayRoute(
        fieldRequest("/api/field/v1/time-clock/today", { token }),
      ),
    );
    expect(depois.entries).toHaveLength(1);
    expect(depois.entries[0].fromAdjustment).toBe(true);
    expect(depois.entries[0].id).not.toBe(entradaOriginal.id);
    expect(depois.state).toBe("WORKING");

    /*
      6. E a ORIGINAL continua no banco.

      O espelho mostra UMA entrada — a que vale. A tabela guarda DUAS: a batida
      original e a correção que a superou. Apagar ou editar a primeira
      destruiria justamente o que o registro existe para preservar (§229).
    */
    const brutas = await prisma.timeEntry.findMany({
      where: { userId: fixture.techA.id, type: "CLOCK_IN" },
      orderBy: { createdAt: "asc" },
      select: { id: true, source: true, adjustmentRequestId: true },
    });
    expect(brutas).toHaveLength(2);
    expect(brutas[0].id).toBe(entradaOriginal.id);
    expect(brutas[0].source).toBe("FIELD_APP");
    expect(brutas[0].adjustmentRequestId).toBeNull();
    expect(brutas[1].source).toBe("ADJUSTMENT");
    expect(brutas[1].adjustmentRequestId).toBe(pedidoId);
  });
});
