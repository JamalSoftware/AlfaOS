import { describe, it, expect, beforeEach } from "vitest";
import { POST as login } from "@/app/api/auth/login/route";
import { GET as listUsers } from "@/app/api/users/route";
import {
  apiRequest,
  createTokenFor,
  seedTestData,
  TEST_PASSWORD,
  type TestFixture,
} from "./helpers";

let fixture: TestFixture;

beforeEach(async () => {
  fixture = await seedTestData();
});

describe("Autenticação", () => {
  it("1. usuário válido consegue autenticar", async () => {
    const res = await login(
      apiRequest("/api/auth/login", {
        method: "POST",
        body: {
          email: "admin@alfa.test",
          password: TEST_PASSWORD,
        },
      }),
    );

    expect(res.status).toBe(200);

    const payload = await res.json();
    expect(payload.ok).toBe(true);
    expect(payload.data.user.email).toBe("admin@alfa.test");

    const cookies = res.headers.getSetCookie();
    expect(cookies.length).toBeGreaterThan(0);
    expect(cookies[0]).toContain("alfaos_session=");
    expect(cookies[0]).toContain("HttpOnly");
  });

  it("2. senha errada é rejeitada", async () => {
    const res = await login(
      apiRequest("/api/auth/login", {
        method: "POST",
        body: {
          email: "admin@alfa.test",
          password: "SenhaTotalmenteErrada@999",
        },
      }),
    );

    expect(res.status).toBe(401);
    const payload = await res.json();
    expect(payload.ok).toBe(false);

    const cookies = res.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith("alfaos_session="))).toBe(false);
  });

  it("3. usuário inativo não acessa", async () => {
    const res = await login(
      apiRequest("/api/auth/login", {
        method: "POST",
        body: {
          email: "inactive@alfa.test",
          password: TEST_PASSWORD,
        },
      }),
    );

    expect(res.status).toBe(401);
    const payload = await res.json();
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain("inativo");
  });

  it("3b. usuário inativo com token válido não acessa APIs protegidas", async () => {
    const token = await createTokenFor(fixture.inactiveA.id);

    const res = await listUsers(apiRequest("/api/users", {}, token));
    expect(res.status).toBe(401);
  });
});
