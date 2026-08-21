import { describe, it, expect, beforeEach } from "vitest";
import { GET as listUsers } from "@/app/api/users/route";
import {
  GET as getUser,
  PATCH as updateUser,
} from "@/app/api/users/[id]/route";
import {
  apiRequest,
  createTokenFor,
  seedTestData,
  type TestFixture,
} from "./helpers";

let fixture: TestFixture;

beforeEach(async () => {
  fixture = await seedTestData();
});

describe("Isolamento multi-empresa", () => {
  it("4. Empresa A não consegue listar usuários da Empresa B", async () => {
    const token = await createTokenFor(fixture.adminA.id);

    const res = await listUsers(apiRequest("/api/users", {}, token));
    expect(res.status).toBe(200);

    const payload = await res.json();
    const users = payload.data.users;

    expect(users.length).toBeGreaterThan(0);
    for (const user of users) {
      expect(user.companyId).toBe(fixture.companyA.id);
    }

    const companyBEmails = users.filter(
      (u: { email: string }) => u.email === "admin@companyb.test",
    );
    expect(companyBEmails).toHaveLength(0);
  });

  it("5. Empresa A não consegue buscar usuário da Empresa B por ID", async () => {
    const token = await createTokenFor(fixture.adminA.id);

    const res = await getUser(apiRequest(`/api/users/${fixture.adminB.id}`, {}, token), {
      params: { id: fixture.adminB.id },
    });

    expect(res.status).toBe(404);
  });

  it("6. Empresa A não consegue editar usuário da Empresa B", async () => {
    const token = await createTokenFor(fixture.adminA.id);

    const res = await updateUser(
      apiRequest(
        `/api/users/${fixture.adminB.id}`,
        { method: "PATCH", body: { active: false, name: "Hacked" } },
        token,
      ),
      { params: { id: fixture.adminB.id } },
    );

    expect(res.status).toBe(404);

    const { getCompanyUser } = await import("@/lib/users");
    const untouched = await getCompanyUser(
      fixture.companyB.id,
      fixture.adminB.id,
    );
    expect(untouched?.name).toBe("Administrador Empresa B");
    expect(untouched?.active).toBe(true);
  });
});
