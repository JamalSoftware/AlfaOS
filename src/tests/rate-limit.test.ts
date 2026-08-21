import { describe, it, expect, beforeEach } from "vitest";
import { POST as login } from "@/app/api/auth/login/route";
import { prisma } from "@/lib/prisma";
import {
  apiRequest,
  seedTestData,
  TEST_PASSWORD,
  type TestFixture,
} from "./helpers";

let fixture: TestFixture;

const IP = "200.100.10.5";

function loginReq(email: string, password: string) {
  return apiRequest(
    "/api/auth/login",
    {
      method: "POST",
      body: { email, password },
      headers: { "x-forwarded-for": IP },
    },
  );
}

beforeEach(async () => {
  fixture = await seedTestData();
});

describe("Rate limit de login", () => {
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
