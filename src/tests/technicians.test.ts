import { describe, it, expect, beforeEach } from "vitest";
import {
  GET as listTechnicians,
  POST as createTechnician,
} from "@/app/api/technicians/route";
import { prisma } from "@/lib/prisma";
import { getDashboardStats } from "@/lib/dashboard";
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

describe("Técnicos", () => {
  it("ADMIN vincula usuário TECHNICIAN como técnico", async () => {
    const token = await createTokenFor(fixture.adminA.id);

    const res = await createTechnician(
      apiRequest(
        "/api/technicians",
        {
          method: "POST",
          body: { userId: fixture.techA.id },
        },
        token,
      ),
    );

    expect(res.status).toBe(201);
    const payload = await res.json();
    expect(payload.data.technician.userId).toBe(fixture.techA.id);
    expect(payload.data.technician.name).toBe("Tecnico Alfa");
  });

  it("Não vincula usuário de outra empresa (404)", async () => {
    const token = await createTokenFor(fixture.adminA.id);

    const res = await createTechnician(
      apiRequest(
        "/api/technicians",
        { method: "POST", body: { userId: fixture.adminB.id } },
        token,
      ),
    );

    expect(res.status).toBe(404);
  });

  it("Não vincula usuário ADMIN nem usuário inativo (400)", async () => {
    const token = await createTokenFor(fixture.adminA.id);

    const adminRes = await createTechnician(
      apiRequest(
        "/api/technicians",
        { method: "POST", body: { userId: fixture.adminA.id } },
        token,
      ),
    );
    expect(adminRes.status).toBe(400);

    const inactiveRes = await createTechnician(
      apiRequest(
        "/api/technicians",
        { method: "POST", body: { userId: fixture.inactiveA.id } },
        token,
      ),
    );
    expect(inactiveRes.status).toBe(400);
  });

  it("Não permite vínculo duplicado (409)", async () => {
    const token = await createTokenFor(fixture.adminA.id);

    await createTechnician(
      apiRequest(
        "/api/technicians",
        { method: "POST", body: { userId: fixture.techA.id } },
        token,
      ),
    );

    const duplicate = await createTechnician(
      apiRequest(
        "/api/technicians",
        { method: "POST", body: { userId: fixture.techA.id } },
        token,
      ),
    );
    expect(duplicate.status).toBe(409);
  });

  it("DISPATCHER não pode criar técnico (403)", async () => {
    const token = await createTokenFor(fixture.dispatcherA.id);

    const res = await createTechnician(
      apiRequest(
        "/api/technicians",
        { method: "POST", body: { userId: fixture.techA.id } },
        token,
      ),
    );
    expect(res.status).toBe(403);
  });

  it("KPI Técnicos Ativos conta technicians.active da empresa", async () => {
    const token = await createTokenFor(fixture.adminA.id);
    await createTechnician(
      apiRequest(
        "/api/technicians",
        { method: "POST", body: { userId: fixture.techA.id } },
        token,
      ),
    );

    const stats = await getDashboardStats(fixture.companyA.id);
    expect(stats.tecnicosAtivos).toBe(1);

    await prisma.technician.updateMany({
      where: { userId: fixture.techA.id },
      data: { active: false },
    });

    const statsAfter = await getDashboardStats(fixture.companyA.id);
    expect(statsAfter.tecnicosAtivos).toBe(0);
  });

  it("Listagem de técnicos é isolada por empresa", async () => {
    const token = await createTokenFor(fixture.adminA.id);
    await createTechnician(
      apiRequest(
        "/api/technicians",
        { method: "POST", body: { userId: fixture.techA.id } },
        token,
      ),
    );
    await prisma.technician.create({
      data: { companyId: fixture.companyB.id, userId: fixture.adminB.id },
    });

    const res = await listTechnicians(apiRequest("/api/technicians", {}, token));
    const payload = await res.json();
    expect(payload.data.total).toBe(1);
    expect(payload.data.technicians[0].email).toBe("tech@alfa.test");
  });
});
