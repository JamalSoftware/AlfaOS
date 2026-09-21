import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { getFileStorage, LocalFileStorageAdapter, setFileStorage } from "@/lib/storage";
import { GET as baixarAssinatura } from "@/app/api/service-orders/[id]/signature/route";
import {
  allocateTestServiceOrderNumber,
  apiRequest,
  createTokenFor,
  seedTestData,
  type TestFixture,
} from "./helpers";

/**
 * RC-TEST-01 — download da assinatura atravessando empresa ou dono.
 *
 * A assinatura é imagem do cliente, e só o E2E cobria a negação dela
 * (`evidence-package.spec.ts`). Aqui a rota é atacada direto, com os bytes no
 * storage: ADMIN de outra empresa e técnico da mesma empresa que não é o dono
 * recebem 404 — e o corpo não carrega um byte da imagem —; quem tem direito
 * recebe exatamente os bytes gravados.
 */

let storageRoot: string;
let fixture: TestFixture;

const BYTES = Buffer.from("\x89PNG\r\n\x1a\nassinatura-do-cliente-de-teste");

beforeAll(async () => {
  storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "alfaos-signature-"));
  setFileStorage(new LocalFileStorageAdapter(storageRoot));
});

afterAll(async () => {
  setFileStorage(null);
  await fs.rm(storageRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  fixture = await seedTestData();
});

async function osComAssinatura() {
  const dono = await prisma.technician.upsert({
    where: { userId: fixture.techA.id },
    update: {},
    create: { companyId: fixture.companyA.id, userId: fixture.techA.id },
  });
  await prisma.technician.upsert({
    where: { userId: fixture.techB.id },
    update: {},
    create: { companyId: fixture.companyA.id, userId: fixture.techB.id },
  });
  const cliente = await prisma.customer.create({
    data: { companyId: fixture.companyA.id, name: "Cliente Assinatura" },
  });
  const ordem = await prisma.serviceOrder.create({
    data: {
      companyId: fixture.companyA.id,
      number: await allocateTestServiceOrderNumber(fixture.companyA.id),
      customerId: cliente.id,
      technicianId: dono.id,
      type: "Instalação",
      description: "Com assinatura.",
      status: "COMPLETED",
      completedAt: new Date(),
    },
  });
  const chave = `${fixture.companyA.id}/${ordem.id}/assinatura.png`;
  await getFileStorage().put(chave, BYTES, "image/png");
  await prisma.serviceOrderSignature.create({
    data: {
      companyId: fixture.companyA.id,
      serviceOrderId: ordem.id,
      signerName: "Cliente Assinatura",
      storageKey: chave,
      mimeType: "image/png",
      sizeBytes: BYTES.byteLength,
    },
  });
  return ordem;
}

async function baixar(orderId: string, userId: string) {
  const token = await createTokenFor(userId);
  return baixarAssinatura(apiRequest(`/api/service-orders/${orderId}/signature`, {}, token), {
    params: Promise.resolve({ id: orderId }),
  });
}

describe("download da assinatura", () => {
  it("ADMIN da empresa B com o id da OS da A: 404, sem um byte da imagem", async () => {
    const ordem = await osComAssinatura();
    const res = await baixar(ordem.id, fixture.adminB.id);
    expect(res.status).toBe(404);
    const corpo = Buffer.from(await res.arrayBuffer());
    expect(corpo.includes(Buffer.from("assinatura-do-cliente"))).toBe(false);
  });

  it("técnico da MESMA empresa que não é o dono: 404", async () => {
    const ordem = await osComAssinatura();
    const res = await baixar(ordem.id, fixture.techB.id);
    expect(res.status).toBe(404);
    const corpo = Buffer.from(await res.arrayBuffer());
    expect(corpo.includes(Buffer.from("assinatura-do-cliente"))).toBe(false);
  });

  it("controle positivo: o técnico dono e o despachante recebem os bytes exatos", async () => {
    const ordem = await osComAssinatura();
    for (const userId of [fixture.techA.id, fixture.dispatcherA.id]) {
      const res = await baixar(ordem.id, userId);
      expect(res.status).toBe(200);
      expect(Buffer.from(await res.arrayBuffer()).equals(BYTES)).toBe(true);
    }
  });
});
