import { describe, it, expect, beforeEach } from "vitest";
import { GET as todayRoute } from "@/app/api/field/v1/time-clock/today/route";
import { POST as punchRoute } from "@/app/api/field/v1/time-clock/entries/route";
import { GET as historyRoute } from "@/app/api/field/v1/time-clock/history/route";
import {
  GET as ownAdjustmentsRoute,
  POST as requestAdjustmentRoute,
} from "@/app/api/field/v1/time-clock/adjustments/route";
import { prisma } from "@/lib/prisma";
import {
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
