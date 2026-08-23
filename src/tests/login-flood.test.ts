import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { POST as login } from "@/app/api/auth/login/route";
import {
  LOGIN_MAX_FAILED_ATTEMPTS,
  LOGIN_WINDOW_SECONDS,
} from "@/lib/constants";
import {
  passwordGateStats,
  resetPasswordGateStats,
} from "@/lib/password";
import { prisma } from "@/lib/prisma";
import { apiRequest, seedTestData, TEST_PASSWORD } from "./helpers";

/**
 * Flood de login anônimo — docs/SECURITY.md §2.2.
 *
 * O login roda `verifyPassword` incondicionalmente (nivelamento de timing
 * anti-enumeração), então toda tentativa custa CPU de bcrypt. A defesa anterior
 * era um teto de falhas do DEPLOY INTEIRO: ao estourar, TODO mundo tomava 429.
 * Como e-mails aleatórios não precisam existir e a requisição bloqueada nem
 * chegava a registrar tentativa, o atacante segurava o bloqueio de graça — um
 * interruptor de autenticação, não um rate limit. O teto foi REMOVIDO.
 *
 * No lugar dele: `src/lib/password.ts` limita o bcrypt concorrente e aplica
 * contrapressão limitada (fila FIFO + 503 quando cheia). Estes testes fixam as
 * duas metades: o interruptor global não pode voltar, e a contrapressão precisa
 * ser instantânea e reversível.
 */

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

function legitRequest(email = "admin@alfa.test"): Request {
  return apiRequest("/api/auth/login", {
    method: "POST",
    body: { email, password: TEST_PASSWORD },
  });
}

/**
 * Histórico de falhas já registrado, sem pagar bcrypt real. Cada linha tem um
 * e-mail distinto, exatamente como o flood produz.
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
  delete process.env.BCRYPT_MAX_CONCURRENCY;
  delete process.env.BCRYPT_MAX_QUEUE;
  await seedTestData();
  resetPasswordGateStats();
});

afterEach(async () => {
  delete process.env.BCRYPT_MAX_CONCURRENCY;
  delete process.env.BCRYPT_MAX_QUEUE;
  await prisma.loginAttempt.deleteMany();
});

describe("(a) Flood anônimo não derruba o login de terceiros", () => {
  it("400 falhas de e-mails aleatórios não impedem o login legítimo", async () => {
    // Duas vezes o antigo teto global (200). Sob o código anterior isto era
    // suficiente para devolver 429 a TODA a base; agora é ruído irrelevante,
    // porque nenhuma dessas falhas é atribuível a este e-mail nem a este IP.
    await seedFailures(400);

    const res = await login(legitRequest());

    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.data.user.email).toBe("admin@alfa.test");
  });

  it("nenhum volume de falhas de e-mails inexistentes gera bloqueio global", async () => {
    // Mesmo com o flood MUITO acima de qualquer teto plausível, um e-mail que
    // nunca falhou continua com contador zerado.
    await seedFailures(2_000);

    const res = await login(legitRequest());
    expect(res.status).toBe(200);
  });

  it("flood em voo não impede o login legítimo disparado junto", async () => {
    // Agora com requisições REAIS concorrentes (cada uma paga bcrypt de fato),
    // não apenas linhas pré-inseridas.
    const flood = Array.from({ length: 12 }, () => login(floodRequest()));
    const legit = login(legitRequest());

    const [legitRes, ...floodRes] = await Promise.all([legit, ...flood]);

    // O usuário legítimo é atendido — pode ter esperado na fila, mas não foi
    // negado. Esse é exatamente o desfecho que o teto global impedia.
    expect(legitRes.status).toBe(200);
    // E o flood não conseguiu nada além de 401 genérico.
    expect(floodRes.map((r) => r.status)).toEqual(Array(12).fill(401));
  });

  it("falhas fora da janela não contam (bloqueio nunca é permanente)", async () => {
    const expired = new Date(Date.now() - (LOGIN_WINDOW_SECONDS + 60) * 1000);
    await seedFailures(500, expired);

    const res = await login(legitRequest());
    expect(res.status).toBe(200);
  });
});

describe("(b) Event loop não é exaurido pelo flood", () => {
  it("a concorrência de bcrypt nunca passa do teto configurado", async () => {
    // Asserção determinística: não mede tempo, mede o high-water mark real do
    // semáforo.
    //
    // Medido neste mesmo cenário: com o portão em 2, `peakActive` fecha em 2;
    // com o portão aberto (limite 999), fecha em 20 — ou seja, as 20
    // comparações ficavam TODAS em voo ao mesmo tempo, dividindo a CPU e
    // multiplicando por 20 a latência de qualquer login honesto no meio. Por
    // isso a igualdade estrita: o teto tem de ser atingido (senão o teste não
    // provaria nada) e não pode ser ultrapassado.
    process.env.BCRYPT_MAX_CONCURRENCY = "2";
    process.env.BCRYPT_MAX_QUEUE = "100";
    resetPasswordGateStats();

    await Promise.all(Array.from({ length: 20 }, () => login(floodRequest())));

    const stats = passwordGateStats();
    expect(stats.peakActive).toBe(2);
    // Nada vaza: todo slot tomado foi devolvido.
    expect(stats.active).toBe(0);
    expect(stats.queued).toBe(0);
  });

  it("o event loop continua girando enquanto o flood é processado", async () => {
    process.env.BCRYPT_MAX_CONCURRENCY = "2";
    process.env.BCRYPT_MAX_QUEUE = "100";

    // Batimento em `setImmediate`: conta quantas vezes o loop completou uma
    // volta durante o flood. Se o hashing tomasse o loop de ponta a ponta, este
    // contador ficaria em 0. Não é medida de tempo de parede — é contagem de
    // iterações, e o limiar (10) tem ordens de grandeza de folga: o bcryptjs
    // assíncrono cede o controle a cada 100ms, então 12 hashes de ~350ms
    // produzem dezenas de voltas.
    let ticks = 0;
    let beating = true;
    const beat = () => {
      if (!beating) return;
      ticks += 1;
      setImmediate(beat);
    };
    setImmediate(beat);

    try {
      await Promise.all(Array.from({ length: 12 }, () => login(floodRequest())));
    } finally {
      beating = false;
    }

    expect(ticks).toBeGreaterThan(10);
  });

  it("fila cheia devolve 503 sem gastar CPU e o serviço se recupera na hora", async () => {
    // Portão minúsculo de propósito: 1 executando + 2 na fila.
    process.env.BCRYPT_MAX_CONCURRENCY = "1";
    process.env.BCRYPT_MAX_QUEUE = "2";
    resetPasswordGateStats();

    const responses = await Promise.all(
      Array.from({ length: 20 }, () => login(floodRequest())),
    );
    const statuses = responses.map((r) => r.status);

    // Excedente é recusado imediatamente, sem pagar bcrypt.
    expect(statuses.filter((s) => s === 503).length).toBeGreaterThan(0);
    // E nada além de "credencial inválida" ou "sobrecarregado" sai daqui.
    expect(statuses.every((s) => s === 401 || s === 503)).toBe(true);
    expect(passwordGateStats().rejected).toBeGreaterThan(0);

    // A diferença essencial para o teto global: a contrapressão é instantânea,
    // não uma janela. Assim que o flood para, o portão está vazio...
    expect(passwordGateStats().active).toBe(0);
    expect(passwordGateStats().queued).toBe(0);

    // ...e o próximo login legítimo passa na mesma hora, sem esperar janela
    // nenhuma. Sob o teto global, este login tomaria 429 por 15 minutos.
    const res = await login(legitRequest());
    expect(res.status).toBe(200);
  });
});

describe("(c) Limites atribuíveis (por e-mail / por IP) seguem valendo", () => {
  it("o limite por e-mail continua bloqueando o e-mail que falhou", async () => {
    await prisma.loginAttempt.createMany({
      data: Array.from({ length: LOGIN_MAX_FAILED_ATTEMPTS }, () => ({
        email: "admin@alfa.test",
        ip: null,
        success: false,
      })),
    });

    const res = await login(legitRequest());
    expect(res.status).toBe(429);
  });

  it("o bloqueio de um e-mail não respinga em outro (sem contador global)", async () => {
    await prisma.loginAttempt.createMany({
      data: Array.from({ length: LOGIN_MAX_FAILED_ATTEMPTS * 10 }, () => ({
        email: "dispatcher@alfa.test",
        ip: null,
        success: false,
      })),
    });

    // O e-mail que apanhou está bloqueado...
    const blocked = await login(
      apiRequest("/api/auth/login", {
        method: "POST",
        body: { email: "dispatcher@alfa.test", password: TEST_PASSWORD },
      }),
    );
    expect(blocked.status).toBe(429);

    // ...e o vizinho segue intacto.
    const other = await login(legitRequest());
    expect(other.status).toBe(200);
  });

  it("o limite por IP continua valendo quando há proxy confiável", async () => {
    process.env.TRUSTED_PROXY_HOPS = "1";
    const ip = "203.0.113.77";

    await prisma.loginAttempt.createMany({
      data: Array.from({ length: 20 }, () => ({
        email: freshEmail(),
        ip,
        success: false,
      })),
    });

    const res = await login(
      apiRequest("/api/auth/login", {
        method: "POST",
        body: { email: "admin@alfa.test", password: TEST_PASSWORD },
        headers: { "x-forwarded-for": ip },
      }),
    );
    expect(res.status).toBe(429);

    // Outro IP não é afetado.
    const clean = await login(
      apiRequest("/api/auth/login", {
        method: "POST",
        body: { email: "admin@alfa.test", password: TEST_PASSWORD },
        headers: { "x-forwarded-for": "198.51.100.4" },
      }),
    );
    expect(clean.status).toBe(200);
  });
});
