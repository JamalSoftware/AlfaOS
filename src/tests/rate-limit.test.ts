import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { POST as login } from "@/app/api/auth/login/route";
import { prisma } from "@/lib/prisma";
import { getClientIp } from "@/lib/rate-limit";
import {
  apiRequest,
  seedTestData,
  TEST_PASSWORD,
  type TestFixture,
} from "./helpers";

let fixture: TestFixture;

const IP = "200.100.10.5";

function loginWithHeaders(
  email: string,
  password: string,
  headers: Record<string, string>,
) {
  return apiRequest("/api/auth/login", {
    method: "POST",
    body: { email, password },
    headers,
  });
}

function loginReq(email: string, password: string) {
  return loginWithHeaders(email, password, { "x-forwarded-for": IP });
}

function setHops(hops: number | null): void {
  if (hops === null) {
    delete process.env.TRUSTED_PROXY_HOPS;
  } else {
    process.env.TRUSTED_PROXY_HOPS = String(hops);
  }
}

function ipHeaders(value: string) {
  return { "x-forwarded-for": value };
}

function randomIp(): string {
  const octet = () => Math.floor(Math.random() * 254) + 1;
  return `${octet()}.${octet()}.${octet()}.${octet()}`;
}

afterEach(() => {
  setHops(null);
});

describe("Resolução do IP do cliente (trusted proxy)", () => {
  it("sem proxy confiável (padrão) ignora X-Forwarded-For e X-Real-IP", () => {
    setHops(null);
    const resolved = getClientIp(
      apiRequest("/api/auth/login", {
        method: "POST",
        headers: { "x-forwarded-for": "1.2.3.4", "x-real-ip": "5.6.7.8" },
      }),
    );
    expect(resolved.trusted).toBe(false);
    expect(resolved.value).toBe("unknown");
  });

  it("com 1 hop confiável usa o endereço escrito pelo proxy (último da lista)", () => {
    setHops(1);
    expect(
      getClientIp(
        apiRequest("/api/auth/login", { headers: ipHeaders("203.0.113.7") }),
      ),
    ).toEqual({ value: "203.0.113.7", trusted: true });

    // "9.9.9.9" veio do cliente; "203.0.113.7" foi acrescentado pelo proxy.
    expect(
      getClientIp(
        apiRequest("/api/auth/login", {
          headers: ipHeaders("9.9.9.9, 203.0.113.7"),
        }),
      ),
    ).toEqual({ value: "203.0.113.7", trusted: true });
  });

  it("com 2 hops confiáveis pula o proxy interno e ignora o que veio do cliente", () => {
    setHops(2);
    expect(
      getClientIp(
        apiRequest("/api/auth/login", {
          headers: ipHeaders("9.9.9.9, 203.0.113.7, 10.0.0.1"),
        }),
      ),
    ).toEqual({ value: "203.0.113.7", trusted: true });
  });

  it("cadeia mais curta que os hops configurados não vira IP do cliente", () => {
    setHops(3);
    const resolved = getClientIp(
      apiRequest("/api/auth/login", {
        headers: ipHeaders("9.9.9.9, 203.0.113.7"),
      }),
    );
    expect(resolved.trusted).toBe(false);
    expect(resolved.value).toBe("unknown");
  });

  it("valor que não é IP cai no fallback não diferenciado", () => {
    setHops(1);
    for (const value of ["not-an-ip", "999.1.1.1", "  ", "<script>"]) {
      expect(
        getClientIp(
          apiRequest("/api/auth/login", { headers: ipHeaders(value) }),
        ).trusted,
      ).toBe(false);
    }
  });

  it("aceita IPv6 e formas com porta", () => {
    setHops(1);
    expect(
      getClientIp(
        apiRequest("/api/auth/login", {
          headers: ipHeaders("[2001:db8::1]:443"),
        }),
      ),
    ).toEqual({ value: "2001:db8::1", trusted: true });
    expect(
      getClientIp(
        apiRequest("/api/auth/login", { headers: ipHeaders("198.51.100.4:52") }),
      ),
    ).toEqual({ value: "198.51.100.4", trusted: true });
  });
});

describe("Rate limit de login", () => {
  beforeEach(async () => {
    // Os cenários abaixo simulam um único proxy reverso confiável.
    setHops(1);
    fixture = await seedTestData();
  });

  it("bloqueia (429) após 5 falhas por e-mail e libera outro e-mail", async () => {
    for (let i = 0; i < 5; i += 1) {
      const res = await login(loginReq("admin@alfa.test", "SenhaErrada@999"));
      expect(res.status).toBe(401);
    }

    const blocked = await login(
      loginReq("admin@alfa.test", TEST_PASSWORD),
    );
    expect(blocked.status).toBe(429);

    const payload = await blocked.json();
    expect(payload.error).toContain("Tente novamente");
  });

  it("não bloqueia e-mails diferentes no mesmo IP antes do limite de IP", async () => {
    for (let i = 0; i < 5; i += 1) {
      const res = await login(
        loginReq("dispatcher@alfa.test", "SenhaErrada@999"),
      );
      expect(res.status).toBe(401);
    }

    const res = await login(
      loginReq("tech@alfa.test", TEST_PASSWORD),
    );
    expect(res.status).toBe(200);
  });

  it("bloqueia por IP após 20 falhas em e-mails diferentes", async () => {
    const emails = [
      "admin@alfa.test",
      "dispatcher@alfa.test",
      "tech@alfa.test",
      "inactive@alfa.test",
    ];
    for (let i = 0; i < 20; i += 1) {
      const email = emails[i % emails.length];
      const res = await login(loginReq(email, "SenhaErrada@999"));
      expect(res.status).toBe(401);
    }

    const blocked = await login(
      loginReq("admin@alfa.test", TEST_PASSWORD),
    );
    expect(blocked.status).toBe(429);
  });

  it("aplica o limite por IP de forma independente (outro IP continua livre)", async () => {
    const extra = await prisma.user.createMany({
      data: [
        { companyId: fixture.companyA.id, name: "Extra 1", email: "extra1@alfa.test", profile: "TECHNICIAN", active: true, passwordHash: "$2a$10$abcdefghijklmnopqrstuv" },
        { companyId: fixture.companyA.id, name: "Extra 2", email: "extra2@alfa.test", profile: "TECHNICIAN", active: true, passwordHash: "$2a$10$abcdefghijklmnopqrstuv" },
      ],
    });
    void extra;

    const emails = [
      "admin@alfa.test",
      "dispatcher@alfa.test",
      "tech@alfa.test",
      "inactive@alfa.test",
      "extra1@alfa.test",
      "extra2@alfa.test",
    ];
    for (let i = 0; i < 20; i += 1) {
      const email = emails[i % emails.length];
      const res = await login(loginReq(email, "SenhaErrada@999"));
      expect(res.status).toBe(401);
    }

    const res = await login(
      apiRequest("/api/auth/login", {
        method: "POST",
        body: { email: "admin@alfa.test", password: TEST_PASSWORD },
        headers: { "x-forwarded-for": "203.0.113.9" },
      }),
    );
    expect(res.status).toBe(200);
  });
});

describe("Rate limit de login — sem proxy confiável (configuração padrão)", () => {
  beforeEach(async () => {
    // Sem TRUSTED_PROXY_HOPS: é assim que roda um `next start` self-hosted.
    setHops(null);
    fixture = await seedTestData();
  });

  it("o limite por IP é inerte: 20+ falhas de e-mails distintos não bloqueiam um e-mail novo", async () => {
    // Mesmo cenário que, com proxy confiável, dispara o limite por IP (20).
    const emails = [
      "dispatcher@alfa.test",
      "tech@alfa.test",
      "tech2@alfa.test",
      "inactive@alfa.test",
    ];
    for (let i = 0; i < 20; i += 1) {
      const res = await login(
        loginReq(emails[i % emails.length], "SenhaErrada@999"),
      );
      expect(res.status).toBe(401);
    }

    // Nenhum IP foi estabelecido, então nada foi contabilizado por IP...
    const attempts = await prisma.loginAttempt.findMany({ select: { ip: true } });
    expect(attempts.every((attempt) => attempt.ip === null)).toBe(true);

    // ...e um e-mail ainda não usado passa direto (chegando ao bcrypt).
    // Nesta configuração quem protege esse caminho é só o limite por e-mail
    // e o teto global (docs/SECURITY.md §2.2) — ver login-flood.test.ts.
    const fresh = await login(loginReq("admin@alfa.test", TEST_PASSWORD));
    expect(fresh.status).toBe(200);
  });

  it("o limite por e-mail continua valendo sem proxy confiável", async () => {
    for (let i = 0; i < 5; i += 1) {
      const res = await login(loginReq("dispatcher@alfa.test", "SenhaErrada@999"));
      expect(res.status).toBe(401);
    }

    const blocked = await login(
      loginReq("dispatcher@alfa.test", TEST_PASSWORD),
    );
    expect(blocked.status).toBe(429);
  });
});

describe("Auditoria de bloqueio (AUTH.RATE_LIMITED)", () => {
  beforeEach(async () => {
    setHops(1);
    fixture = await seedTestData();
  });

  it("registra só na transição para bloqueado, não a cada requisição", async () => {
    for (let i = 0; i < 5; i += 1) {
      const res = await login(loginReq("admin@alfa.test", "SenhaErrada@999"));
      expect(res.status).toBe(401);
    }

    for (let i = 0; i < 6; i += 1) {
      const blocked = await login(loginReq("admin@alfa.test", TEST_PASSWORD));
      expect(blocked.status).toBe(429);
    }

    // Sem o throttle seriam 6 linhas (uma por request bloqueado), suficientes
    // para varrer o painel "Atividade recente" (take: 10) do dashboard.
    const rateLimited = await prisma.auditLog.count({
      where: { userId: fixture.adminA.id, action: "AUTH.RATE_LIMITED" },
    });
    expect(rateLimited).toBe(1);
  });
});

describe("Rate limit de login — X-Forwarded-For forjado", () => {
  beforeEach(async () => {
    fixture = await seedTestData();
  });

  it("(a) sem proxy confiável, não dá para bloquear o IP de um terceiro", async () => {
    setHops(null);
    const victimIp = "198.51.100.42";

    // 20 falhas alegando ser o IP da vítima (4 e-mails × 5 falhas).
    const emails = [
      "dispatcher@alfa.test",
      "tech2@alfa.test",
      "inactive@alfa.test",
      "admin@companyb.test",
    ];
    for (let i = 0; i < 20; i += 1) {
      const res = await login(
        loginWithHeaders(
          emails[i % emails.length],
          "SenhaErrada@999",
          ipHeaders(victimIp),
        ),
      );
      expect(res.status).toBe(401);
    }

    // A vítima (outro e-mail, mesmo IP alegado) continua conseguindo entrar.
    const victim = await login(
      loginWithHeaders("admin@alfa.test", TEST_PASSWORD, ipHeaders(victimIp)),
    );
    expect(victim.status).toBe(200);

    // O header nunca chegou a ser persistido como identidade de IP.
    const attempts = await prisma.loginAttempt.findMany({ select: { ip: true } });
    expect(attempts.length).toBeGreaterThan(0);
    expect(attempts.every((attempt) => attempt.ip === null)).toBe(true);
  });

  it("(b) randomizar X-Forwarded-For não escapa do limite por e-mail", async () => {
    setHops(null);
    for (let i = 0; i < 5; i += 1) {
      const res = await login(
        loginWithHeaders(
          "admin@alfa.test",
          "SenhaErrada@999",
          ipHeaders(randomIp()),
        ),
      );
      expect(res.status).toBe(401);
    }

    const blocked = await login(
      loginWithHeaders("admin@alfa.test", TEST_PASSWORD, ipHeaders(randomIp())),
    );
    expect(blocked.status).toBe(429);
  });

  it("(b2) com proxy confiável, randomizar o prefixo do header não escapa do limite por IP", async () => {
    setHops(1);
    const attackerIp = "203.0.113.77";
    const emails = [
      "dispatcher@alfa.test",
      "tech@alfa.test",
      "tech2@alfa.test",
      "inactive@alfa.test",
    ];

    for (let i = 0; i < 20; i += 1) {
      const res = await login(
        loginWithHeaders(
          emails[i % emails.length],
          "SenhaErrada@999",
          // O prefixo é forjado pelo atacante; o proxy confiável acrescenta o
          // endereço real no fim da lista.
          ipHeaders(`${randomIp()}, ${attackerIp}`),
        ),
      );
      expect(res.status).toBe(401);
    }

    const blocked = await login(
      loginWithHeaders(
        "admin@alfa.test",
        TEST_PASSWORD,
        ipHeaders(`${randomIp()}, ${attackerIp}`),
      ),
    );
    expect(blocked.status).toBe(429);
  });

  it("(c) com proxy confiável, o XFF forjado além do hop não determina o IP", async () => {
    setHops(1);
    const victimIp = "198.51.100.42";
    const attackerIp = "203.0.113.77";
    const emails = [
      "dispatcher@alfa.test",
      "tech@alfa.test",
      "tech2@alfa.test",
      "inactive@alfa.test",
    ];

    // O atacante forja o IP da vítima à esquerda; o proxy acrescenta o dele.
    for (let i = 0; i < 20; i += 1) {
      const res = await login(
        loginWithHeaders(
          emails[i % emails.length],
          "SenhaErrada@999",
          ipHeaders(`${victimIp}, ${attackerIp}`),
        ),
      );
      expect(res.status).toBe(401);
    }

    // Todas as falhas foram contabilizadas no IP do atacante...
    const attempts = await prisma.loginAttempt.findMany({ select: { ip: true } });
    expect(attempts.every((attempt) => attempt.ip === attackerIp)).toBe(true);

    // ...então a vítima (requisição legítima pelo mesmo proxy) segue livre...
    const victim = await login(
      loginWithHeaders("admin@alfa.test", TEST_PASSWORD, ipHeaders(victimIp)),
    );
    expect(victim.status).toBe(200);

    // ...e o atacante é quem fica bloqueado.
    const attacker = await login(
      loginWithHeaders(
        "admin@companyb.test",
        TEST_PASSWORD,
        ipHeaders(`${victimIp}, ${attackerIp}`),
      ),
    );
    expect(attacker.status).toBe(429);
  });
});
