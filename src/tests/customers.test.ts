import { describe, it, expect, beforeEach } from "vitest";
import {
  GET as listCustomers,
  POST as createCustomer,
} from "@/app/api/customers/route";
import {
  GET as getCustomer,
  PATCH as updateCustomer,
} from "@/app/api/customers/[id]/route";
import { prisma } from "@/lib/prisma";
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

describe("Clientes", () => {
  it("ADMIN cria cliente e campos externos/internos não são expostos", async () => {
    const token = await createTokenFor(fixture.adminA.id);

    const res = await createCustomer(
      apiRequest(
        "/api/customers",
        {
          method: "POST",
          body: { name: "Cliente Alfa", phone: "(11) 99999-1111" },
        },
        token,
      ),
    );

    expect(res.status).toBe(201);
    const payload = await res.json();
    expect(payload.data.customer.name).toBe("Cliente Alfa");
    expect(payload.data.customer.companyId).toBeUndefined();
    expect(payload.data.customer.externalProvider).toBeUndefined();
    expect(payload.data.customer.externalId).toBeUndefined();
  });

  it("Mass assignment é bloqueado: corpo com companyId é rejeitado", async () => {
    const token = await createTokenFor(fixture.adminA.id);

    const res = await createCustomer(
      apiRequest(
        "/api/customers",
        {
          method: "POST",
          body: {
            name: "Hacker",
            companyId: fixture.companyB.id,
            createdAt: "2020-01-01T00:00:00.000Z",
          },
        },
        token,
      ),
    );

    expect(res.status).toBe(400);
    const count = await prisma.customer.count();
    expect(count).toBe(0);
  });

  it("DISPATCHER pode criar cliente; TECHNICIAN é negado", async () => {
    const dispatcherToken = await createTokenFor(fixture.dispatcherA.id);
    const res = await createCustomer(
      apiRequest(
        "/api/customers",
        { method: "POST", body: { name: "Via Despachante" } },
        dispatcherToken,
      ),
    );
    expect(res.status).toBe(201);

    const techToken = await createTokenFor(fixture.techA.id);
    const denied = await createCustomer(
      apiRequest(
        "/api/customers",
        { method: "POST", body: { name: "Nao Permitido" } },
        techToken,
      ),
    );
    expect(denied.status).toBe(403);
  });

  it("Empresa A não acessa cliente da Empresa B (GET e PATCH)", async () => {
    const created = await prisma.customer.create({
      data: { companyId: fixture.companyB.id, name: "Cliente B" },
    });

    const tokenA = await createTokenFor(fixture.adminA.id);
    const getRes = await getCustomer(
      apiRequest(`/api/customers/${created.id}`, {}, tokenA),
      { params: { id: created.id } },
    );
    expect(getRes.status).toBe(404);

    const patchRes = await updateCustomer(
      apiRequest(
        `/api/customers/${created.id}`,
        { method: "PATCH", body: { name: "Hacked" } },
        tokenA,
      ),
      { params: { id: created.id } },
    );
    expect(patchRes.status).toBe(404);

    const untouched = await prisma.customer.findUnique({
      where: { id: created.id },
    });
    expect(untouched?.name).toBe("Cliente B");
  });

  it("Edita cliente e listagem é isolada por empresa", async () => {
    const tokenA = await createTokenFor(fixture.adminA.id);
    await createCustomer(
      apiRequest(
        "/api/customers",
        { method: "POST", body: { name: "Cliente A1", city: "São Paulo" } },
        tokenA,
      ),
    );

    await prisma.customer.create({
      data: { companyId: fixture.companyB.id, name: "Cliente B1" },
    });

    const listRes = await listCustomers(
      apiRequest("/api/customers", {}, tokenA),
    );
    const list = await listRes.json();
    expect(list.data.total).toBe(1);
    expect(list.data.customers[0].name).toBe("Cliente A1");

    const created = await prisma.customer.findFirst({
      where: { companyId: fixture.companyA.id },
    });
    const editRes = await updateCustomer(
      apiRequest(
        `/api/customers/${created!.id}`,
        { method: "PATCH", body: { active: false } },
        tokenA,
      ),
      { params: { id: created!.id } },
    );
    expect(editRes.status).toBe(200);
    const edited = await editRes.json();
    expect(edited.data.customer.active).toBe(false);
  });
});
