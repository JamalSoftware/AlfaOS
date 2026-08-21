import { describe, it, expect, beforeEach } from "vitest";
import { POST as login } from "@/app/api/auth/login/route";
import { PATCH as patchUser } from "@/app/api/users/[id]/route";
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

describe("Edição de usuário", () => {
  it("admin edita nome, e-mail, perfil e status do usuário", async () => {
    const token = await createTokenFor(fixture.adminA.id);

    const res = await patchUser(
      apiRequest(
        `/api/users/${fixture.techA.id}`,
        {
          method: "PATCH",
          body: {
            name: "Tecnico Renomeado",
            email: "tecnico2@alfa.test",
            profile: "DISPATCHER",
            active: true,
          },
          headers: { Origin: "http://localhost" },
        },
        token,
      ),
      { params: { id: fixture.techA.id } },
    );

    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.data.user.name).toBe("Tecnico Renomeado");
    expect(payload.data.user.email).toBe("tecnico2@alfa.test");
    expect(payload.data.user.profile).toBe("DISPATCHER");
    expect(payload.data.user.active).toBe(true);
  });

  it("admin altera senha do usuário (nova senha passa a funcionar)", async () => {
    const token = await createTokenFor(fixture.adminA.id);

    const res = await patchUser(
      apiRequest(
        `/api/users/${fixture.techA.id}`,
        {
          method: "PATCH",
          body: { password: "NovaSenha@123" },
          headers: { Origin: "http://localhost" },
        },
        token,
      ),
      { params: { id: fixture.techA.id } },
    );
    expect(res.status).toBe(200);

    const loginRes = await login(
      apiRequest("/api/auth/login", {
        method: "POST",
        body: { email: "tech@alfa.test", password: "NovaSenha@123" },
      }),
    );
    expect(loginRes.status).toBe(200);

    const oldPass = await login(
      apiRequest("/api/auth/login", {
        method: "POST",
        body: { email: "tech@alfa.test", password: TEST_PASSWORD },
      }),
    );
    expect(oldPass.status).toBe(401);
  });

  it("admin não consegue editar usuário de outra empresa (404)", async () => {
    const token = await createTokenFor(fixture.adminA.id);

    const res = await patchUser(
      apiRequest(
        `/api/users/${fixture.adminB.id}`,
        {
          method: "PATCH",
          body: { name: "Hack" },
          headers: { Origin: "http://localhost" },
        },
        token,
      ),
      { params: { id: fixture.adminB.id } },
    );

    expect(res.status).toBe(404);
  });

  it("não permite duplicar e-mail dentro da empresa (409)", async () => {
    const token = await createTokenFor(fixture.adminA.id);

    const res = await patchUser(
      apiRequest(
        `/api/users/${fixture.techA.id}`,
        {
          method: "PATCH",
          body: { email: "admin@alfa.test" },
          headers: { Origin: "http://localhost" },
        },
        token,
      ),
      { params: { id: fixture.techA.id } },
    );

    expect(res.status).toBe(409);
  });

  it("não-admin não edita usuários (403)", async () => {
    const token = await createTokenFor(fixture.techA.id);

    const res = await patchUser(
      apiRequest(
        `/api/users/${fixture.adminA.id}`,
        {
          method: "PATCH",
          body: { profile: "ADMIN" },
          headers: { Origin: "http://localhost" },
        },
        token,
      ),
      { params: { id: fixture.adminA.id } },
    );

    expect(res.status).toBe(403);
  });
});
