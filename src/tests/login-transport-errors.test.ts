import { Prisma } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as login } from "@/app/api/auth/login/route";
import { prisma } from "@/lib/prisma";
import { apiRequest, seedTestData, TEST_PASSWORD } from "./helpers";

/**
 * # `RC-1` — erro de INFRAESTRUTURA no login continua 500 (débito §12)
 *
 * O débito "login-flood sensível a carga" é uma requisição de flood que volta
 * 500 em vez de 401, uma vez a cada quatro rodadas da suíte inteira. A
 * investigação mostrou que a única classe de exceção capaz de produzir isso
 * naquele caminho é erro de TRANSPORTE do Prisma: as demais ou são
 * `DomainError` (401/429/503), ou são engolidas (`logAudit`), ou são
 * estruturalmente impossíveis (não existe unique em `LoginAttempt`, e o
 * `deleteMany` da poda casa zero linhas num banco recém-limpo).
 *
 * Medido, com controle: uma rajada de 13 consultas concorrentes com o pool
 * FRIO produz `P1001` a cada ~750 consultas neste ambiente; a mesma contagem
 * feita em sequência, nenhuma. O pool do Prisma nasce com uma conexão, e o
 * ambiente de desenvolvimento fala com o Postgres pelo port proxy do Docker
 * Desktop. Por isso o teste de flood aquece o pool antes da rajada.
 *
 * Este arquivo fixa a outra metade, e é a que importa para o produto: quando o
 * erro de transporte ACONTECE, a resposta tem de continuar sendo 500. Nunca
 * 401 — dizer "credencial inválida" para um banco fora do ar manda a pessoa
 * trocar a senha por causa de um problema que não é dela —, e nunca 429.
 *
 * É também a prova de reversão do aquecimento: se alguém "resolver" o
 * intermitente convertendo erro de infraestrutura em 401, estes casos caem.
 */

const EMAIL = "admin@alfa.test";

function pedido(email = EMAIL, senha = TEST_PASSWORD): Request {
  return apiRequest("/api/auth/login", {
    method: "POST",
    body: { email, password: senha },
  });
}

/** O erro que o Prisma levanta quando não alcança o banco. */
function erroDeTransporte(code: string) {
  return new Prisma.PrismaClientKnownRequestError("Can't reach database server", {
    code,
    clientVersion: Prisma.prismaVersion.client,
  });
}

beforeEach(async () => {
  delete process.env.TRUSTED_PROXY_HOPS;
  await seedTestData();
  await prisma.loginAttempt.deleteMany();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await prisma.loginAttempt.deleteMany();
});

describe("LOGIN-TRANSPORT — banco inalcançável não vira resposta de autenticação", () => {
  it.each([
    ["P1001", "servidor de banco inalcançável"],
    ["P1017", "conexão fechada pelo servidor"],
    ["P2024", "pool esgotado"],
  ])("LOGIN-TRANSPORT-01 · %s na contagem de tentativas devolve 500", async (code) => {
    const espiao = vi
      .spyOn(prisma.loginAttempt, "count")
      .mockRejectedValueOnce(erroDeTransporte(code));

    const res = await login(pedido());

    expect(res.status).toBe(500);
    expect(espiao).toHaveBeenCalled();
    const corpo = await res.json();
    // A mensagem é genérica: nada de código do Prisma nem de conexão na resposta.
    expect(JSON.stringify(corpo)).not.toMatch(/P10|P20|prisma|postgres/i);
  });

  it("LOGIN-TRANSPORT-02 · falha ao LER o usuário devolve 500, e não 401", async () => {
    /*
      Este é o caso perigoso: `findUnique` falhando devolve o mesmo "usuário não
      encontrado" que uma credencial errada produziria, se alguém tratasse a
      exceção como ausência. A resposta tem de ser 500.
    */
    vi.spyOn(prisma.user, "findUnique").mockRejectedValueOnce(erroDeTransporte("P1001"));

    const res = await login(pedido());
    expect(res.status).toBe(500);
  });

  it("LOGIN-TRANSPORT-03 · falha ao REGISTRAR a tentativa devolve 500, e não 401", async () => {
    vi.spyOn(prisma.loginAttempt, "create").mockRejectedValueOnce(erroDeTransporte("P1001"));

    // Credencial errada: o caminho chega ao registro da tentativa.
    const res = await login(pedido(EMAIL, "SenhaErrada@123"));
    expect(res.status).toBe(500);
  });

  it("LOGIN-TRANSPORT-04 · com o banco respondendo, a mesma credencial errada é 401", async () => {
    /*
      Controle positivo. Sem ele, os casos acima passariam num login que
      devolvesse 500 para tudo — inclusive para credencial inválida.
    */
    expect((await login(pedido(EMAIL, "SenhaErrada@123"))).status).toBe(401);
    expect((await login(pedido())).status).toBe(200);
  });

  it("LOGIN-TRANSPORT-05 · um 500 no meio de um lote concorrente não contamina os outros", async () => {
    /*
      A forma exata do intermitente: uma requisição falha no transporte, as
      outras seguem. O lote não pode virar 500 inteiro nem 401 inteiro.
    */
    let chamadas = 0;
    const real = prisma.loginAttempt.count.bind(prisma.loginAttempt);
    vi.spyOn(prisma.loginAttempt, "count").mockImplementation(((args: never) => {
      chamadas += 1;
      return chamadas === 3
        ? Promise.reject(erroDeTransporte("P1001"))
        : real(args);
    }) as typeof prisma.loginAttempt.count);

    const respostas = await Promise.all(
      Array.from({ length: 6 }, () => login(pedido(EMAIL, "SenhaErrada@123"))),
    );
    const status = respostas.map((r) => r.status).sort();

    expect(status.filter((s) => s === 500)).toHaveLength(1);
    expect(status.filter((s) => s === 401)).toHaveLength(5);
  });
});
