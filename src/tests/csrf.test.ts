import { describe, it, expect, beforeEach } from "vitest";
import { POST as createUser } from "@/app/api/users/route";
import { POST as login } from "@/app/api/auth/login/route";
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

function createUserBody() {
  return {
    name: "Novo Usuário",
    email: "novo@alfa.test",
    password: TEST_PASSWORD,
    profile: "TECHNICIAN",
  };
}

describe("Proteção CSRF (same-origin)", () => {
  it("rejeita POST com Origin de terceiros (403)", async () => {
    const token = await createTokenFor(fixture.adminA.id);
    const res = await createUser(
      apiRequest(
        "/api/users",
        {
          method: "POST",
          body: createUserBody(),
          headers: { Origin: "https://evil.example.com" },
        },
        token,
      ),
    );

    expect(res.status).toBe(403);
    const payload = await res.json();
    expect(payload.error).toContain("Origem");
  });

  it("rejeita PATCH com Origin de terceiros (403)", async () => {
    const token = await createTokenFor(fixture.adminA.id);
    const { PATCH } = await import("@/app/api/users/[id]/route");
    const res = await PATCH(
      apiRequest(
        `/api/users/${fixture.techA.id}`,
        {
          method: "PATCH",
          body: { name: "Nome Alterado" },
          headers: { Origin: "https://evil.example.com" },
        },
        token,
      ),
      { params: { id: fixture.techA.id } },
    );

    expect(res.status).toBe(403);
  });

  it("rejeita POST de login com Origin de terceiros (403)", async () => {
    const res = await login(
      apiRequest("/api/auth/login", {
        method: "POST",
        body: { email: "admin@alfa.test", password: TEST_PASSWORD },
        headers: { Origin: "https://evil.example.com" },
      }),
    );

    expect(res.status).toBe(403);
  });

  it("aceita POST com Origin de mesmo host", async () => {
    const token = await createTokenFor(fixture.adminA.id);
    const res = await createUser(
      apiRequest(
        "/api/users",
        {
          method: "POST",
          body: createUserBody(),
          headers: { Origin: "http://localhost" },
        },
        token,
      ),
    );

    expect(res.status).toBe(201);
  });

  it("aceita POST sem header Origin (navegação/curl)", async () => {
    const token = await createTokenFor(fixture.adminA.id);
    const res = await createUser(
      apiRequest(
        "/api/users",
        { method: "POST", body: createUserBody() },
        token,
      ),
    );

    expect(res.status).toBe(201);
  });
});
