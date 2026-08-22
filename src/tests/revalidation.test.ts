import bcrypt from "bcryptjs";
import { describe, it, expect, beforeEach } from "vitest";
import { GET as listUsers } from "@/app/api/users/route";
import { PATCH as patchUser } from "@/app/api/users/[id]/route";
import { prisma } from "@/lib/prisma";
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

describe("Revalidação imediata de sessão", () => {
  it("token de usuário promovido a ADMIN passa a acessar rota de admin", async () => {
    const oldToken = await createTokenFor(fixture.techA.id);

    const denied = await listUsers(apiRequest("/api/users", {}, oldToken));
    expect(denied.status).toBe(403);

    const adminToken = await createTokenFor(fixture.adminA.id);
    const res = await patchUser(
      apiRequest(
        `/api/users/${fixture.techA.id}`,
        {
          method: "PATCH",
          body: { profile: "ADMIN" },
          headers: { Origin: "http://localhost" },
        },
        adminToken,
      ),
      { params: { id: fixture.techA.id } },
    );
    expect(res.status).toBe(200);

    const nowAllowed = await listUsers(apiRequest("/api/users", {}, oldToken));
    expect(nowAllowed.status).toBe(200);
  });

  it("token de usuário desativado é invalidado imediatamente", async () => {
    const oldToken = await createTokenFor(fixture.dispatcherA.id);

    const adminToken = await createTokenFor(fixture.adminA.id);
    const res = await patchUser(
      apiRequest(
        `/api/users/${fixture.dispatcherA.id}`,
        {
          method: "PATCH",
          body: { active: false },
          headers: { Origin: "http://localhost" },
        },
        adminToken,
      ),
      { params: { id: fixture.dispatcherA.id } },
    );
    expect(res.status).toBe(200);

    const denied = await listUsers(apiRequest("/api/users", {}, oldToken));
    expect(denied.status).toBe(401);
  });

  it("token de admin rebaixado deixa de acessar rota de admin", async () => {
    // O rebaixamento tem que partir de OUTRO admin: auto-rebaixar-se é
    // recusado (403) desde a proteção contra auto-travamento — ver
    // docs/SECURITY.md §12 e user-edit.test.ts.
    const other = await prisma.user.create({
      data: {
        companyId: fixture.companyA.id,
        name: "Administrador Dois",
        email: "admin2@alfa.test",
        profile: "ADMIN",
        active: true,
        passwordHash: bcrypt.hashSync(TEST_PASSWORD, 10),
      },
      select: { id: true },
    });

    const demotedToken = await createTokenFor(other.id);
    const allowed = await listUsers(apiRequest("/api/users", {}, demotedToken));
    expect(allowed.status).toBe(200);

    const adminToken = await createTokenFor(fixture.adminA.id);
    const demote = await patchUser(
      apiRequest(
        `/api/users/${other.id}`,
        {
          method: "PATCH",
          body: { profile: "TECHNICIAN" },
          headers: { Origin: "http://localhost" },
        },
        adminToken,
      ),
      { params: { id: other.id } },
    );
    expect(demote.status).toBe(200);

    const denied = await listUsers(apiRequest("/api/users", {}, demotedToken));
    expect(denied.status).toBe(403);
  });
});
