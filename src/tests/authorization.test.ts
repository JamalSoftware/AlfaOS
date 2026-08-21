import { describe, it, expect, beforeEach } from "vitest";
import { GET as listUsers, POST as createUser } from "@/app/api/users/route";
import { PATCH as updateUser } from "@/app/api/users/[id]/route";
import { POST as testConnection } from "@/app/api/integrations/test-connection/route";
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

describe("Autorização por perfil de acesso", () => {
  it("7. ADMIN consegue gerenciar usuários", async () => {
    const token = await createTokenFor(fixture.adminA.id);

    const createdRes = await createUser(
      apiRequest(
        "/api/users",
        {
          method: "POST",
          body: {
            name: "Novo Tecnico",
            email: "novo.tec@alfa.test",
            password: TEST_PASSWORD,
            profile: "TECHNICIAN",
          },
        },
        token,
      ),
    );
    expect(createdRes.status).toBe(201);
    const created = (await createdRes.json()).data.user;
    expect(created.companyId).toBe(fixture.companyA.id);
    expect(created.profile).toBe("TECHNICIAN");

    const listRes = await listUsers(apiRequest("/api/users", {}, token));
    const users = (await listRes.json()).data.users;
    expect(users.some((u: { id: string }) => u.id === created.id)).toBe(true);

    const updatedRes = await updateUser(
      apiRequest(
        `/api/users/${created.id}`,
        { method: "PATCH", body: { active: false, name: "Novo Tecnico Inativo" } },
        token,
      ),
      { params: { id: created.id } },
    );
    expect(updatedRes.status).toBe(200);
    const updated = (await updatedRes.json()).data.user;
    expect(updated.active).toBe(false);
  });

  it("8. DISPATCHER não acessa configurações críticas", async () => {
    const token = await createTokenFor(fixture.dispatcherA.id);

    const listRes = await listUsers(apiRequest("/api/users", {}, token));
    expect(listRes.status).toBe(403);

    const updateRes = await updateUser(
      apiRequest(
        `/api/users/${fixture.adminA.id}`,
        { method: "PATCH", body: { active: false } },
        token,
      ),
      { params: { id: fixture.adminA.id } },
    );
    expect(updateRes.status).toBe(403);

    const integrationRes = await testConnection(
      apiRequest(
        "/api/integrations/test-connection",
        { method: "POST", body: { provider: "MOCK" } },
        token,
      ),
    );
    expect(integrationRes.status).toBe(403);
  });

  it("9. TECHNICIAN não acessa administração", async () => {
    const token = await createTokenFor(fixture.techA.id);

    const listRes = await listUsers(apiRequest("/api/users", {}, token));
    expect(listRes.status).toBe(403);

    const createRes = await createUser(
      apiRequest(
        "/api/users",
        {
          method: "POST",
          body: {
            name: "Invasor",
            email: "invasor@alfa.test",
            password: TEST_PASSWORD,
            profile: "ADMIN",
          },
        },
        token,
      ),
    );
    expect(createRes.status).toBe(403);
  });

  it("9b. usuário não autenticado não acessa", async () => {
    const res = await listUsers(apiRequest("/api/users"));
    expect(res.status).toBe(401);
  });
});
