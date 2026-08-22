import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { POST as login } from "@/app/api/auth/login/route";
import {
  LOGIN_MAX_FAILED_ATTEMPTS_GLOBAL,
  LOGIN_WINDOW_SECONDS,
} from "@/lib/constants";
import { prisma } from "@/lib/prisma";
import { apiRequest, seedTestData, TEST_PASSWORD } from "./helpers";

/**
 * DoS não autenticado por bcrypt (docs/SECURITY.md §2.2).
 *
 * O login roda `verifyPassword` incondicionalmente (nivelamento de timing
 * anti-enumeração). `bcryptjs` é JS puro e bloqueia o event loop, então cada
 * requisição custa ~350ms de CPU síncrona. Um atacante anônimo com um e-mail
 * aleatório novo a cada tentativa mantém o contador por e-mail em 0 e, na
 * configuração padrão (sem `TRUSTED_PROXY_HOPS`), o contador por IP nunca é
 * aplicado. O teto global é o único freio que sobra — e ele precisa cortar
 * ANTES do bcrypt.
 */

// Conta quantas vezes o bcrypt foi realmente executado, mantendo a
// implementação real (a asserção é "não foi chamado", não "foi mockado").
const bcrypt = vi.hoisted(() => ({ calls: 0 }));

vi.mock("@/lib/password", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/password")>();
  return {
    ...actual,
    verifyPassword: (plain: string, hash: string) => {
      bcrypt.calls += 1;
      return actual.verifyPassword(plain, hash);
    },
  };
});

/** E-mail inédito a cada chamada — é isso que zera o limite por e-mail. */
function freshEmail(): string {
  return `flood-${Math.random().toString(36).slice(2)}-${Date.now()}@nao-existe.test`;
}

function randomIp(): string {
  const octet = () => Math.floor(Math.random() * 254) + 1;
  return `${octet()}.${octet()}.${octet()}.${octet()}`;
}

/** Uma requisição do flood: e-mail novo, IP forjado novo, senha qualquer. */
function floodRequest(email = freshEmail()): Request {
  return apiRequest("/api/auth/login", {
    method: "POST",
    body: { email, password: "SenhaQualquer@123" },
    headers: { "x-forwarded-for": randomIp() },
  });
}

/**
 * Histórico de falhas já registrado, para não pagar ~200 bcrypts reais no
 * teste. Cada linha tem um e-mail distinto, exatamente como o flood produz.
 */
async function seedFailures(count: number, createdAt?: Date): Promise<void> {
  await prisma.loginAttempt.createMany({
    data: Array.from({ length: count }, () => ({
      email: freshEmail(),
      ip: null,
      success: false,
      ...(createdAt ? { createdAt } : {}),
    })),
  });
}

beforeEach(async () => {
  // Configuração padrão / self-hosted: nenhum proxy reverso confiável.
  delete process.env.TRUSTED_PROXY_HOPS;
  await seedTestData();
  bcrypt.calls = 0;
});

afterEach(async () => {
  await prisma.loginAttempt.deleteMany();
});

describe("Teto global de falhas de login (flood anônimo)", () => {
  it("depois do teto responde 429 sem chegar a executar o bcrypt", async () => {
    // Três tentativas abaixo do teto.
    await seedFailures(LOGIN_MAX_FAILED_ATTEMPTS_GLOBAL - 3);

    // Ainda abaixo do teto: o flood passa e paga bcrypt (401 genérico).
    for (let i = 0; i < 3; i += 1) {
      const res = await login(floodRequest());
      expect(res.status).toBe(401);
    }
    expect(bcrypt.calls).toBe(3);

    // As três falhas foram registradas: o contador global fechou a janela.
    const failures = await prisma.loginAttempt.count({
      where: { success: false },
    });
    expect(failures).toBe(LOGIN_MAX_FAILED_ATTEMPTS_GLOBAL);

    const callsBeforeBlock = bcrypt.calls;

    for (let i = 0; i < 5; i += 1) {
      const blocked = await login(floodRequest());
      expect(blocked.status).toBe(429);
      const payload = await blocked.json();
      expect(payload.error).toContain("Tente novamente");
    }

    // O ponto da correção: nenhuma CPU de bcrypt gasta com o flood bloqueado.
    expect(bcrypt.calls).toBe(callsBeforeBlock);

    // E a requisição bloqueada não realimenta a tabela (a contagem não cresce
    // sozinha enquanto o bloqueio dura).
    expect(await prisma.loginAttempt.count({ where: { success: false } })).toBe(
      LOGIN_MAX_FAILED_ATTEMPTS_GLOBAL,
    );
  });

  it("nem um e-mail válido escapa do teto global (interruptor assumido)", async () => {
    await seedFailures(LOGIN_MAX_FAILED_ATTEMPTS_GLOBAL);

    const res = await login(
      apiRequest("/api/auth/login", {
        method: "POST",
        body: { email: "admin@alfa.test", password: TEST_PASSWORD },
      }),
    );

    expect(res.status).toBe(429);
    expect(bcrypt.calls).toBe(0);
  });

  it("falhas fora da janela não contam (bloqueio não é permanente)", async () => {
    const expired = new Date(Date.now() - (LOGIN_WINDOW_SECONDS + 60) * 1000);
    await seedFailures(LOGIN_MAX_FAILED_ATTEMPTS_GLOBAL * 2, expired);

    const res = await login(
      apiRequest("/api/auth/login", {
        method: "POST",
        body: { email: "admin@alfa.test", password: TEST_PASSWORD },
      }),
    );

    expect(res.status).toBe(200);
    expect(bcrypt.calls).toBe(1);
  });

  it("abaixo do teto o login normal continua funcionando", async () => {
    await seedFailures(LOGIN_MAX_FAILED_ATTEMPTS_GLOBAL - 1);

    const res = await login(
      apiRequest("/api/auth/login", {
        method: "POST",
        body: { email: "admin@alfa.test", password: TEST_PASSWORD },
      }),
    );

    expect(res.status).toBe(200);
  });
});
