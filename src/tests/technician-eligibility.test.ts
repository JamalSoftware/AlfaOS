import { describe, it, expect, beforeEach } from "vitest";
import { AccessProfile } from "@prisma/client";
import { POST as assignOrder } from "@/app/api/service-orders/[id]/assign/route";
import { DomainError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import {
  assignTechnician,
  getCompanyServiceOrder,
} from "@/lib/service-orders";
import { listActiveTechnicianOptions } from "@/lib/technicians";
import { updateCompanyUser } from "@/lib/users";
import {
  apiRequest,
  createTokenFor,
  seedTestData,
  type TestFixture,
} from "./helpers";

/**
 * Elegibilidade de técnico para NOVA atribuição — docs/SERVICE-ORDERS.md §3.
 *
 * `Technician.active` sozinho não descreve a pessoa: o `User` vinculado pode
 * ser desativado ou trocar de perfil sem que a linha do técnico mude. Antes,
 * `assignTechnician` só olhava `Technician.active` e o dropdown
 * (`listActiveTechnicianOptions`) fazia o mesmo — ou seja, uma conta revogada
 * continuava recebendo trabalho.
 *
 * A regra vale para as DUAS pontas e é derivada na leitura, nunca sincronizada
 * de forma destrutiva: desativar um usuário não reescreve o técnico nem toca em
 * OS já atribuídas.
 */

let fixture: TestFixture;

beforeEach(async () => {
  fixture = await seedTestData();
});

async function createOrder(): Promise<string> {
  const customer = await prisma.customer.create({
    data: { companyId: fixture.companyA.id, name: "Cliente A" },
  });
  const order = await prisma.serviceOrder.create({
    data: {
      companyId: fixture.companyA.id,
      customerId: customer.id,
      type: "Instalação",
      description: "Instalação de fibra óptica.",
      priority: "NORMAL",
      status: "PENDING",
      origin: "INTERNAL",
    },
  });
  return order.id;
}

function createTech(userId: string, active = true) {
  return prisma.technician.create({
    data: { companyId: fixture.companyA.id, userId, active },
  });
}

/** Executa a atribuição e devolve o DomainError, se houver. */
async function assignExpectingError(
  orderId: string,
  technicianId: string,
): Promise<DomainError> {
  try {
    await assignTechnician(
      fixture.companyA.id,
      fixture.adminA.id,
      orderId,
      technicianId,
    );
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    return error as DomainError;
  }
  throw new Error("A atribuição deveria ter sido rejeitada, mas passou.");
}

describe("Elegibilidade do técnico para nova atribuição", () => {
  it("(1) Technician ativo + User ativo → atribuível", async () => {
    const orderId = await createOrder();
    const tech = await createTech(fixture.techA.id);

    const order = await assignTechnician(
      fixture.companyA.id,
      fixture.adminA.id,
      orderId,
      tech.id,
    );

    expect(order.status).toBe("ASSIGNED");
    expect(order.technician?.id).toBe(tech.id);
    expect(order.technician?.name).toBe("Tecnico Alfa");
  });

  it("(2) Technician ativo + User inativo → rejeitado com mensagem clara", async () => {
    const orderId = await createOrder();
    const tech = await createTech(fixture.techA.id);
    await prisma.user.update({
      where: { id: fixture.techA.id },
      data: { active: false },
    });

    const error = await assignExpectingError(orderId, tech.id);
    expect(error.status).toBe(400);
    expect(error.message).toContain("inativo");

    // A OS não foi tocada.
    const os = await prisma.serviceOrder.findUnique({ where: { id: orderId } });
    expect(os?.status).toBe("PENDING");
    expect(os?.technicianId).toBeNull();
  });

  it("(3) Technician inativo + User ativo → rejeitado", async () => {
    const orderId = await createOrder();
    const tech = await createTech(fixture.techA.id, false);

    const error = await assignExpectingError(orderId, tech.id);
    expect(error.status).toBe(400);
    expect(error.message).toContain("ativos");
  });

  it("(4) User deixa de ser TECHNICIAN → não recebe nova atribuição", async () => {
    const orderId = await createOrder();
    const tech = await createTech(fixture.techA.id);

    // Caminho real de produção: edição de usuário pelo ADMIN.
    await updateCompanyUser(
      fixture.companyA.id,
      fixture.techA.id,
      { profile: AccessProfile.DISPATCHER },
      fixture.adminA.id,
    );

    const error = await assignExpectingError(orderId, tech.id);
    expect(error.status).toBe(400);
    expect(error.message).toContain("perfil Técnico");
  });

  it("A rota /assign devolve 400 para técnico inelegível", async () => {
    const orderId = await createOrder();
    const tech = await createTech(fixture.techA.id);
    await updateCompanyUser(
      fixture.companyA.id,
      fixture.techA.id,
      { active: false },
      fixture.adminA.id,
    );

    const token = await createTokenFor(fixture.adminA.id);
    const res = await assignOrder(
      apiRequest(
        `/api/service-orders/${orderId}/assign`,
        { method: "POST", body: { technicianId: tech.id } },
        token,
      ),
      { params: { id: orderId } },
    );

    expect(res.status).toBe(400);
    const payload = await res.json();
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain("inativo");
  });

  it("Técnico de outra empresa continua 404 (não vira 400)", async () => {
    const orderId = await createOrder();
    const techB = await prisma.technician.create({
      data: { companyId: fixture.companyB.id, userId: fixture.adminB.id },
    });

    const error = await assignExpectingError(orderId, techB.id);
    expect(error.status).toBe(404);
  });
});

describe("Dropdown de técnicos usa a mesma regra da atribuição", () => {
  it("lista apenas técnicos elegíveis", async () => {
    const eligible = await createTech(fixture.techA.id);
    const inactiveTech = await createTech(fixture.techB.id, false);

    let options = await listActiveTechnicianOptions(fixture.companyA.id);
    expect(options.map((o) => o.id)).toEqual([eligible.id]);
    expect(options.map((o) => o.id)).not.toContain(inactiveTech.id);

    // Usuário desativado some da lista sem que o Technician mude.
    await prisma.user.update({
      where: { id: fixture.techA.id },
      data: { active: false },
    });
    options = await listActiveTechnicianOptions(fixture.companyA.id);
    expect(options).toEqual([]);

    // E o registro do técnico continua ativo: nada foi apagado nem reescrito.
    const stillThere = await prisma.technician.findUnique({
      where: { id: eligible.id },
    });
    expect(stillThere?.active).toBe(true);
  });

  it("técnico com perfil trocado some do dropdown", async () => {
    const tech = await createTech(fixture.techA.id);
    expect(await listActiveTechnicianOptions(fixture.companyA.id)).toHaveLength(
      1,
    );

    await updateCompanyUser(
      fixture.companyA.id,
      fixture.techA.id,
      { profile: AccessProfile.ADMIN },
      fixture.adminA.id,
    );

    expect(await listActiveTechnicianOptions(fixture.companyA.id)).toEqual([]);
    const stillThere = await prisma.technician.findUnique({
      where: { id: tech.id },
    });
    expect(stillThere?.active).toBe(true);
  });
});

describe("(5) Histórico é preservado quando o técnico é desativado depois", () => {
  it("OS já atribuída mantém técnico e timeline intactos", async () => {
    const orderId = await createOrder();
    const tech = await createTech(fixture.techA.id);
    await assignTechnician(
      fixture.companyA.id,
      fixture.adminA.id,
      orderId,
      tech.id,
    );

    // Desativa o usuário DEPOIS da atribuição.
    await updateCompanyUser(
      fixture.companyA.id,
      fixture.techA.id,
      { active: false },
      fixture.adminA.id,
    );

    const detail = await getCompanyServiceOrder(fixture.companyA.id, orderId);
    expect(detail).not.toBeNull();
    expect(detail?.status).toBe("ASSIGNED");
    // O técnico continua visível na OS antiga.
    expect(detail?.technician?.id).toBe(tech.id);
    expect(detail?.technician?.name).toBe("Tecnico Alfa");
    // A timeline não perdeu nada.
    expect(detail?.events.map((e) => e.event)).toEqual([
      "TECHNICIAN_ASSIGNED",
    ]);

    // Mas ele não recebe NOVAS atribuições.
    const otherOrder = await createOrder();
    const error = await assignExpectingError(otherOrder, tech.id);
    expect(error.status).toBe(400);
  });
});
