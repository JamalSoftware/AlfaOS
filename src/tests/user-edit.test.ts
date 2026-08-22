import bcrypt from "bcryptjs";
import { describe, it, expect, beforeEach } from "vitest";
import { POST as login } from "@/app/api/auth/login/route";
import { PATCH as patchUser } from "@/app/api/users/[id]/route";
import { prisma } from "@/lib/prisma";
import { updateCompanyUser } from "@/lib/users";
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

function patchRequest(targetId: string, body: unknown, token: string) {
  return patchUser(
    apiRequest(
      `/api/users/${targetId}`,
      { method: "PATCH", body, headers: { Origin: "http://localhost" } },
      token,
    ),
    { params: { id: targetId } },
  );
}

/** Segundo ADMIN ativo da empresa A, para os cenários de "não é o último". */
async function createSecondAdmin(): Promise<{ id: string }> {
  return prisma.user.create({
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
}

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

  it("rejeita campo desconhecido no corpo (.strict())", async () => {
    const token = await createTokenFor(fixture.adminA.id);

    const res = await patchRequest(
      fixture.techA.id,
      { name: "Tecnico", companyId: fixture.companyB.id },
      token,
    );

    expect(res.status).toBe(400);
    const stillMine = await prisma.user.findUnique({
      where: { id: fixture.techA.id },
      select: { companyId: true, name: true },
    });
    expect(stillMine?.companyId).toBe(fixture.companyA.id);
    expect(stillMine?.name).toBe("Tecnico Alfa");
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

/**
 * Travamento administrativo (docs/SECURITY.md §12). Um ADMIN que se desativa
 * ou se rebaixa perde a sessão na requisição seguinte; se era o único ADMIN
 * ativo, a empresa fica sem ninguém capaz de gerenciar usuários — e não há
 * caminho de recuperação no produto.
 */
describe("Camada 1 — auto-modificação de privilégio (rota)", () => {
  it("(a) ADMIN não desativa a própria conta", async () => {
    const token = await createTokenFor(fixture.adminA.id);

    const res = await patchRequest(
      fixture.adminA.id,
      { active: false },
      token,
    );

    expect(res.status).toBe(403);
    const payload = await res.json();
    expect(payload.error).toContain("não pode desativar");

    const self = await prisma.user.findUnique({
      where: { id: fixture.adminA.id },
      select: { active: true },
    });
    expect(self?.active).toBe(true);
  });

  it("(b) ADMIN não rebaixa o próprio perfil", async () => {
    const token = await createTokenFor(fixture.adminA.id);

    const res = await patchRequest(
      fixture.adminA.id,
      { profile: "TECHNICIAN" },
      token,
    );

    expect(res.status).toBe(403);
    const self = await prisma.user.findUnique({
      where: { id: fixture.adminA.id },
      select: { profile: true },
    });
    expect(self?.profile).toBe("ADMIN");
  });

  it("bloqueia mesmo quando a empresa tem outro ADMIN ativo", async () => {
    await createSecondAdmin();
    const token = await createTokenFor(fixture.adminA.id);

    const res = await patchRequest(
      fixture.adminA.id,
      { active: false },
      token,
    );

    expect(res.status).toBe(403);
  });

  it("edições inofensivas da própria conta continuam permitidas", async () => {
    const token = await createTokenFor(fixture.adminA.id);

    // O formulário de edição sempre reenvia profile/active; inalterados é no-op.
    const res = await patchRequest(
      fixture.adminA.id,
      {
        name: "Administrador Renomeado",
        profile: "ADMIN",
        active: true,
        password: "OutraSenha@123",
      },
      token,
    );

    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.data.user.name).toBe("Administrador Renomeado");

    const stillWorks = await login(
      apiRequest("/api/auth/login", {
        method: "POST",
        body: { email: "admin@alfa.test", password: "OutraSenha@123" },
      }),
    );
    expect(stillWorks.status).toBe(200);
  });
});

describe("Camada 2 — último ADMIN ativo da empresa", () => {
  it("(c) desativar o único ADMIN ativo é recusado (409) e faz rollback", async () => {
    // A empresa A tem exatamente um ADMIN ativo (o outro ADMIN está inativo).
    const activeAdmins = await prisma.user.count({
      where: { companyId: fixture.companyA.id, profile: "ADMIN", active: true },
    });
    expect(activeAdmins).toBe(1);

    await expect(
      updateCompanyUser(
        fixture.companyA.id,
        fixture.adminA.id,
        { active: false },
        fixture.adminA.id,
      ),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("último administrador"),
    });

    const self = await prisma.user.findUnique({
      where: { id: fixture.adminA.id },
      select: { active: true },
    });
    expect(self?.active).toBe(true);
  });

  it("(c2) rebaixar o único ADMIN ativo é recusado (409)", async () => {
    await expect(
      updateCompanyUser(
        fixture.companyA.id,
        fixture.adminA.id,
        { profile: "DISPATCHER" },
        fixture.adminA.id,
      ),
    ).rejects.toMatchObject({ status: 409 });

    const self = await prisma.user.findUnique({
      where: { id: fixture.adminA.id },
      select: { profile: true },
    });
    expect(self?.profile).toBe("ADMIN");
  });

  it("(d) com 2 ADMINs ativos, desativar um deles é permitido", async () => {
    const admin2 = await createSecondAdmin();
    const token = await createTokenFor(fixture.adminA.id);

    const res = await patchRequest(admin2.id, { active: false }, token);
    expect(res.status).toBe(200);

    const target = await prisma.user.findUnique({
      where: { id: admin2.id },
      select: { active: true },
    });
    expect(target?.active).toBe(false);

    // ...e agora o que sobrou é o último: desativá-lo é recusado.
    await expect(
      updateCompanyUser(
        fixture.companyA.id,
        fixture.adminA.id,
        { active: false },
        fixture.adminA.id,
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("(d2) com 2 ADMINs ativos, rebaixar o outro é permitido", async () => {
    const admin2 = await createSecondAdmin();
    const token = await createTokenFor(fixture.adminA.id);

    const res = await patchRequest(admin2.id, { profile: "DISPATCHER" }, token);
    expect(res.status).toBe(200);
  });

  it("não bloqueia edições que não removem um ADMIN ativo", async () => {
    const token = await createTokenFor(fixture.adminA.id);

    // Não-admin: desativar é normal, mesmo com um único ADMIN na empresa.
    const dispatcher = await patchRequest(
      fixture.dispatcherA.id,
      { active: false },
      token,
    );
    expect(dispatcher.status).toBe(200);

    // ADMIN já inativo sendo rebaixado: não remove nenhum ADMIN ativo.
    const inactive = await patchRequest(
      fixture.inactiveA.id,
      { profile: "TECHNICIAN" },
      token,
    );
    expect(inactive.status).toBe(200);
  });

  it("promover alguém a ADMIN nunca é bloqueado", async () => {
    const token = await createTokenFor(fixture.adminA.id);

    const res = await patchRequest(fixture.techA.id, { profile: "ADMIN" }, token);
    expect(res.status).toBe(200);
  });
});
