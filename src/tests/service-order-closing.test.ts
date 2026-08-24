import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { POST as completeRoute } from "@/app/api/service-orders/[id]/complete/route";
import { POST as addEvidenceRoute } from "@/app/api/service-orders/[id]/evidence/route";
import { DELETE as removeEvidenceRoute } from "@/app/api/service-orders/[id]/evidence/[evidenceId]/route";
import { GET as evidenceContentRoute } from "@/app/api/service-orders/[id]/evidence/[evidenceId]/content/route";
import { POST as addMaterialRoute } from "@/app/api/service-orders/[id]/materials/route";
import {
  PATCH as patchMaterialRoute,
  DELETE as deleteMaterialRoute,
} from "@/app/api/service-orders/[id]/materials/[materialId]/route";
import { PUT as putSignatureRoute } from "@/app/api/service-orders/[id]/signature/route";
import { prisma } from "@/lib/prisma";
import { DomainError } from "@/lib/errors";
import { LocalFileStorageAdapter, setFileStorage } from "@/lib/storage";
import {
  addEvidence,
  addMaterial,
  completeServiceOrder,
  EVIDENCE_MAX_PER_ORDER,
  getServiceOrderClosingBundle,
  putSignature,
  sniffImageMime,
} from "@/lib/service-order-closing";
import { startServiceOrder, updateServiceOrderExecution } from "@/lib/service-orders";
import { getDashboardStats } from "@/lib/dashboard";
import {
  allocateTestServiceOrderNumber,
  apiRequest,
  createTokenFor,
  seedTestData,
  type TestFixture,
} from "./helpers";

let fixture: TestFixture;
let storageRoot: string;

// Storage is redirected to a throwaway directory for the whole file and wiped
// afterwards, so a test run never writes into the app's real storage root and
// never leaves artefacts behind.
beforeAll(async () => {
  storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "alfaos-storage-test-"));
  setFileStorage(new LocalFileStorageAdapter(storageRoot));
});

afterAll(async () => {
  setFileStorage(null);
  await fs.rm(storageRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  fixture = await seedTestData();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Smallest byte sequences that pass magic-number sniffing. */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 1),
]);
const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff]),
  Buffer.alloc(64, 2),
]);
const WEBP = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.alloc(4, 0),
  Buffer.from("WEBP"),
  Buffer.alloc(64, 3),
]);

function filePart(data: Buffer, name: string, type: string): File {
  return new File([new Uint8Array(data)], name, { type });
}

function formRequest(url: string, form: FormData, token?: string): Request {
  const headers: Record<string, string> = {};
  if (token) headers["Cookie"] = `alfaos_session=${encodeURIComponent(token)}`;
  return new Request(`http://localhost${url}`, {
    method: "POST",
    headers,
    body: form,
  });
}

async function scenario(options: { withExecutionText?: boolean } = {}) {
  const customer = await prisma.customer.create({
    data: { companyId: fixture.companyA.id, name: "Cliente Fechamento" },
  });
  // Upsert, not create: a test may build more than one order in the same
  // fixture, and `Technician.userId` is unique.
  const techA = await prisma.technician.upsert({
    where: { userId: fixture.techA.id },
    update: {},
    create: { companyId: fixture.companyA.id, userId: fixture.techA.id },
  });
  const order = await prisma.serviceOrder.create({
    data: {
      companyId: fixture.companyA.id,
      number: await allocateTestServiceOrderNumber(fixture.companyA.id),
      customerId: customer.id,
      technicianId: techA.id,
      type: "Instalação",
      description: "Instalação de fibra.",
      status: "ASSIGNED",
      assignedAt: new Date(),
    },
  });
  const started = await startServiceOrder(
    fixture.companyA.id,
    fixture.techA.id,
    order.id,
    order.version,
  );

  let executionVersion = started.execution.version;
  if (options.withExecutionText !== false) {
    const saved = await updateServiceOrderExecution(
      fixture.companyA.id,
      fixture.techA.id,
      order.id,
      executionVersion,
      { diagnosis: "Conector com alta atenuação.", workPerformed: "Fusão refeita." },
    );
    executionVersion = saved.version;
  }

  const fresh = await prisma.serviceOrder.findUniqueOrThrow({
    where: { id: order.id },
  });
  const token = await createTokenFor(fixture.techA.id);
  return {
    order: fresh,
    techA,
    token,
    orderVersion: fresh.version,
    executionVersion,
  };
}

async function currentOrderVersion(orderId: string) {
  const o = await prisma.serviceOrder.findUniqueOrThrow({ where: { id: orderId } });
  return o.version;
}

async function expectDomainError(fn: () => Promise<unknown>, status: number) {
  await expect(fn()).rejects.toBeInstanceOf(DomainError);
  await fn().catch((e) => expect((e as DomainError).status).toBe(status));
}

// ---------------------------------------------------------------------------
// Sniffing
// ---------------------------------------------------------------------------

describe("Detecção de tipo de imagem", () => {
  it("reconhece JPEG, PNG e WebP pelos bytes", () => {
    expect(sniffImageMime(JPEG)).toBe("image/jpeg");
    expect(sniffImageMime(PNG)).toBe("image/png");
    expect(sniffImageMime(WEBP)).toBe("image/webp");
  });

  it("rejeita conteúdo que não é imagem, mesmo com extensão de imagem", () => {
    expect(sniffImageMime(Buffer.from("<svg onload=alert(1)></svg>"))).toBeNull();
    expect(sniffImageMime(Buffer.from("<!DOCTYPE html><script>x</script>"))).toBeNull();
    expect(sniffImageMime(Buffer.from("MZ\x90\x00executable"))).toBeNull();
    expect(sniffImageMime(Buffer.alloc(0))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Completion — happy path and required fields
// ---------------------------------------------------------------------------

describe("Conclusão da OS", () => {
  it("técnico dono conclui: status, completedAt, OS_COMPLETED e auditoria", async () => {
    const s = await scenario();

    await completeServiceOrder(fixture.companyA.id, fixture.techA.id, s.order.id, {
      expectedOrderVersion: s.orderVersion,
      expectedExecutionVersion: s.executionVersion,
    });

    const after = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: s.order.id },
    });
    expect(after.status).toBe("COMPLETED");
    expect(after.completedAt).not.toBeNull();
    expect(after.version).toBe(s.orderVersion + 1);

    const events = await prisma.serviceOrderEvent.findMany({
      where: { serviceOrderId: s.order.id, event: "OS_COMPLETED" },
    });
    expect(events).toHaveLength(1);
    expect(events[0].userId).toBe(fixture.techA.id);
    expect(events[0].companyId).toBe(fixture.companyA.id);

    const audit = await prisma.auditLog.findFirst({
      where: { action: "SERVICE_ORDER.COMPLETED", entityId: s.order.id },
    });
    expect(audit).not.toBeNull();
    expect(audit?.userId).toBe(fixture.techA.id);
  });

  it("exige diagnóstico preenchido", async () => {
    const s = await scenario({ withExecutionText: false });
    await updateServiceOrderExecution(
      fixture.companyA.id,
      fixture.techA.id,
      s.order.id,
      s.executionVersion,
      { workPerformed: "Fez algo", diagnosis: "   " },
    );
    const ex = await prisma.serviceOrderExecution.findUniqueOrThrow({
      where: { serviceOrderId: s.order.id },
    });
    const v = await currentOrderVersion(s.order.id);
    await expectDomainError(
      () =>
        completeServiceOrder(fixture.companyA.id, fixture.techA.id, s.order.id, {
          expectedOrderVersion: v,
          expectedExecutionVersion: ex.version,
        }),
      400,
    );
    const after = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: s.order.id },
    });
    expect(after.status).toBe("IN_PROGRESS");
    expect(after.completedAt).toBeNull();
  });

  it("exige serviço realizado preenchido", async () => {
    const s = await scenario({ withExecutionText: false });
    await updateServiceOrderExecution(
      fixture.companyA.id,
      fixture.techA.id,
      s.order.id,
      s.executionVersion,
      { diagnosis: "Causa encontrada" },
    );
    const ex = await prisma.serviceOrderExecution.findUniqueOrThrow({
      where: { serviceOrderId: s.order.id },
    });
    const v = await currentOrderVersion(s.order.id);
    await expectDomainError(
      () =>
        completeServiceOrder(fixture.companyA.id, fixture.techA.id, s.order.id, {
          expectedOrderVersion: v,
          expectedExecutionVersion: ex.version,
        }),
      400,
    );
  });

  it("conclui sem foto, material ou assinatura (não são obrigatórios nesta versão)", async () => {
    const s = await scenario();
    await completeServiceOrder(fixture.companyA.id, fixture.techA.id, s.order.id, {
      expectedOrderVersion: s.orderVersion,
      expectedExecutionVersion: s.executionVersion,
    });
    const after = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: s.order.id },
    });
    expect(after.status).toBe("COMPLETED");
  });

  it("versão da OS obsoleta => 409, sem concluir", async () => {
    const s = await scenario();
    await expectDomainError(
      () =>
        completeServiceOrder(fixture.companyA.id, fixture.techA.id, s.order.id, {
          expectedOrderVersion: s.orderVersion + 5,
          expectedExecutionVersion: s.executionVersion,
        }),
      409,
    );
    const after = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: s.order.id },
    });
    expect(after.status).toBe("IN_PROGRESS");
    expect(after.completedAt).toBeNull();
  });

  it("versão da EXECUÇÃO obsoleta => 409, sem concluir e sem bump da OS", async () => {
    const s = await scenario();
    await expectDomainError(
      () =>
        completeServiceOrder(fixture.companyA.id, fixture.techA.id, s.order.id, {
          expectedOrderVersion: s.orderVersion,
          expectedExecutionVersion: s.executionVersion + 7,
        }),
      409,
    );
    const after = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: s.order.id },
    });
    expect(after.status).toBe("IN_PROGRESS");
    // Rollback: the execution CAS ran before the order CAS, so a failure must
    // leave BOTH untouched.
    expect(after.version).toBe(s.orderVersion);
    const ex = await prisma.serviceOrderExecution.findUniqueOrThrow({
      where: { serviceOrderId: s.order.id },
    });
    expect(ex.version).toBe(s.executionVersion);
  });

  it("estados PENDING / ASSIGNED / CANCELLED / COMPLETED não concluem", async () => {
    for (const status of ["PENDING", "ASSIGNED", "CANCELLED", "COMPLETED"] as const) {
      const s = await scenario();
      await prisma.serviceOrder.update({
        where: { id: s.order.id },
        data: { status },
      });
      const v = await currentOrderVersion(s.order.id);
      await expectDomainError(
        () =>
          completeServiceOrder(fixture.companyA.id, fixture.techA.id, s.order.id, {
            expectedOrderVersion: v,
            expectedExecutionVersion: s.executionVersion,
          }),
        409,
      );
    }
  });

  it("segundo complete sequencial => 409, sem duplicar efeito", async () => {
    const s = await scenario();
    await completeServiceOrder(fixture.companyA.id, fixture.techA.id, s.order.id, {
      expectedOrderVersion: s.orderVersion,
      expectedExecutionVersion: s.executionVersion,
    });
    await expectDomainError(
      () =>
        completeServiceOrder(fixture.companyA.id, fixture.techA.id, s.order.id, {
          expectedOrderVersion: s.orderVersion + 1,
          expectedExecutionVersion: s.executionVersion + 1,
        }),
      409,
    );
    const events = await prisma.serviceOrderEvent.count({
      where: { serviceOrderId: s.order.id, event: "OS_COMPLETED" },
    });
    expect(events).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

describe("Concorrência do fechamento", () => {
  it("complete × complete: exatamente um vence", async () => {
    const s = await scenario();
    const results = await Promise.allSettled([
      completeServiceOrder(fixture.companyA.id, fixture.techA.id, s.order.id, {
        expectedOrderVersion: s.orderVersion,
        expectedExecutionVersion: s.executionVersion,
      }),
      completeServiceOrder(fixture.companyA.id, fixture.techA.id, s.order.id, {
        expectedOrderVersion: s.orderVersion,
        expectedExecutionVersion: s.executionVersion,
      }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);

    const after = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: s.order.id },
    });
    expect(after.status).toBe("COMPLETED");
    expect(after.version).toBe(s.orderVersion + 1);
    expect(
      await prisma.serviceOrderEvent.count({
        where: { serviceOrderId: s.order.id, event: "OS_COMPLETED" },
      }),
    ).toBe(1);
  });

  it("complete × save execution: exatamente um vence", async () => {
    const s = await scenario();
    const results = await Promise.allSettled([
      completeServiceOrder(fixture.companyA.id, fixture.techA.id, s.order.id, {
        expectedOrderVersion: s.orderVersion,
        expectedExecutionVersion: s.executionVersion,
      }),
      updateServiceOrderExecution(
        fixture.companyA.id,
        fixture.techA.id,
        s.order.id,
        s.executionVersion,
        { notes: "escrito em paralelo" },
      ),
    ]);
    const won = results.filter((r) => r.status === "fulfilled");
    expect(won).toHaveLength(1);

    const after = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: s.order.id },
    });
    const ex = await prisma.serviceOrderExecution.findUniqueOrThrow({
      where: { serviceOrderId: s.order.id },
    });
    // Either the close won (order COMPLETED, notes untouched) or the save won
    // (order still IN_PROGRESS, notes written) — never a hybrid.
    const closeWon = after.status === "COMPLETED" && ex.notes === null;
    const saveWon =
      after.status === "IN_PROGRESS" && ex.notes === "escrito em paralelo";
    expect(closeWon || saveWon).toBe(true);
  });

  it("save posterior a um complete vencedor é rejeitado", async () => {
    const s = await scenario();
    await completeServiceOrder(fixture.companyA.id, fixture.techA.id, s.order.id, {
      expectedOrderVersion: s.orderVersion,
      expectedExecutionVersion: s.executionVersion,
    });
    const ex = await prisma.serviceOrderExecution.findUniqueOrThrow({
      where: { serviceOrderId: s.order.id },
    });
    await expectDomainError(
      () =>
        updateServiceOrderExecution(
          fixture.companyA.id,
          fixture.techA.id,
          s.order.id,
          ex.version,
          { notes: "tarde demais" },
        ),
      409,
    );
  });

  it("complete × add evidence: exatamente um vence", async () => {
    const s = await scenario();
    const results = await Promise.allSettled([
      completeServiceOrder(fixture.companyA.id, fixture.techA.id, s.order.id, {
        expectedOrderVersion: s.orderVersion,
        expectedExecutionVersion: s.executionVersion,
      }),
      addEvidence(fixture.companyA.id, fixture.techA.id, s.order.id, {
        data: PNG,
        declaredMimeType: "image/png",
        originalName: "foto.png",
        expectedOrderVersion: s.orderVersion,
      }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);

    const after = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: s.order.id },
    });
    const count = await prisma.serviceOrderEvidence.count({
      where: { serviceOrderId: s.order.id },
    });
    // No evidence may exist on a closed order that closed without it.
    const coherent =
      (after.status === "COMPLETED" && count === 0) ||
      (after.status === "IN_PROGRESS" && count === 1);
    expect(coherent).toBe(true);
  });

  it("complete × add material: exatamente um vence", async () => {
    const s = await scenario();
    const results = await Promise.allSettled([
      completeServiceOrder(fixture.companyA.id, fixture.techA.id, s.order.id, {
        expectedOrderVersion: s.orderVersion,
        expectedExecutionVersion: s.executionVersion,
      }),
      addMaterial(
        fixture.companyA.id,
        fixture.techA.id,
        s.order.id,
        { description: "Conector SC/APC", quantity: 2, unit: "UNIT" },
        s.orderVersion,
      ),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const after = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: s.order.id },
    });
    const count = await prisma.serviceOrderMaterialUsage.count({
      where: { serviceOrderId: s.order.id },
    });
    expect(
      (after.status === "COMPLETED" && count === 0) ||
        (after.status === "IN_PROGRESS" && count === 1),
    ).toBe(true);
  });

  it("complete × signature: exatamente um vence", async () => {
    const s = await scenario();
    const results = await Promise.allSettled([
      completeServiceOrder(fixture.companyA.id, fixture.techA.id, s.order.id, {
        expectedOrderVersion: s.orderVersion,
        expectedExecutionVersion: s.executionVersion,
      }),
      putSignature(fixture.companyA.id, fixture.techA.id, s.order.id, {
        signerName: "Cliente",
        data: PNG,
        declaredMimeType: "image/png",
        expectedOrderVersion: s.orderVersion,
      }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const after = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: s.order.id },
    });
    const sig = await prisma.serviceOrderSignature.count({
      where: { serviceOrderId: s.order.id },
    });
    expect(
      (after.status === "COMPLETED" && sig === 0) ||
        (after.status === "IN_PROGRESS" && sig === 1),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

describe("Evidências", () => {
  it("adiciona foto e incrementa a versão da OS", async () => {
    const s = await scenario();
    const ev = await addEvidence(fixture.companyA.id, fixture.techA.id, s.order.id, {
      data: JPEG,
      declaredMimeType: "image/jpeg",
      originalName: "antes.jpg",
      expectedOrderVersion: s.orderVersion,
    });
    expect(ev.mimeType).toBe("image/jpeg");
    expect(ev.sizeBytes).toBe(JPEG.byteLength);
    expect(await currentOrderVersion(s.order.id)).toBe(s.orderVersion + 1);
  });

  it("rejeita tipo declarado não suportado", async () => {
    const s = await scenario();
    await expectDomainError(
      () =>
        addEvidence(fixture.companyA.id, fixture.techA.id, s.order.id, {
          data: PNG,
          declaredMimeType: "image/svg+xml",
          originalName: "x.svg",
          expectedOrderVersion: s.orderVersion,
        }),
      400,
    );
  });

  it("rejeita conteúdo que não é imagem mesmo declarando image/png", async () => {
    const s = await scenario();
    await expectDomainError(
      () =>
        addEvidence(fixture.companyA.id, fixture.techA.id, s.order.id, {
          data: Buffer.from("<script>alert(1)</script>"),
          declaredMimeType: "image/png",
          originalName: "payload.png",
          expectedOrderVersion: s.orderVersion,
        }),
      400,
    );
  });

  it("rejeita divergência entre bytes e tipo declarado", async () => {
    const s = await scenario();
    await expectDomainError(
      () =>
        addEvidence(fixture.companyA.id, fixture.techA.id, s.order.id, {
          data: JPEG,
          declaredMimeType: "image/png",
          originalName: "confuso.png",
          expectedOrderVersion: s.orderVersion,
        }),
      400,
    );
  });

  it("nome com path traversal não influencia a storage key", async () => {
    const s = await scenario();
    const ev = await addEvidence(fixture.companyA.id, fixture.techA.id, s.order.id, {
      data: PNG,
      declaredMimeType: "image/png",
      originalName: "../../../etc/passwd.png",
      expectedOrderVersion: s.orderVersion,
    });
    const row = await prisma.serviceOrderEvidence.findUniqueOrThrow({
      where: { id: ev.id },
    });
    expect(row.storageKey).not.toContain("..");
    expect(row.storageKey.startsWith(`${fixture.companyA.id}/${s.order.id}/`)).toBe(
      true,
    );
    // The file really is inside the scratch root, not somewhere up the tree.
    const abs = path.resolve(storageRoot, row.storageKey);
    expect(abs.startsWith(path.resolve(storageRoot))).toBe(true);
    await expect(fs.access(abs)).resolves.toBeUndefined();
  });

  it("respeita o limite de imagens por OS", async () => {
    const s = await scenario();
    let v = s.orderVersion;
    for (let i = 0; i < EVIDENCE_MAX_PER_ORDER; i++) {
      await addEvidence(fixture.companyA.id, fixture.techA.id, s.order.id, {
        data: PNG,
        declaredMimeType: "image/png",
        originalName: `f${i}.png`,
        expectedOrderVersion: v,
      });
      v += 1;
    }
    await expectDomainError(
      () =>
        addEvidence(fixture.companyA.id, fixture.techA.id, s.order.id, {
          data: PNG,
          declaredMimeType: "image/png",
          originalName: "extra.png",
          expectedOrderVersion: v,
        }),
      400,
    );
  });

  /**
   * Regression for L-1: the count check used to run before the claim, so its
   * correctness depended on every evidence-creating path routing through the
   * same claim — true today, but not provable at the check's own call site.
   * This fires several concurrent uploads at the exact boundary (one slot
   * left) across multiple rounds and requires the invariant to hold every
   * time: never more rows than the cap, and never a file on disk without a
   * committed row (or a row without its file).
   */
  it("concorrência não fura o teto de evidências (múltiplas rodadas)", async () => {
    const CONCURRENT_ATTEMPTS = 5;
    const ROUNDS = 3;

    for (let round = 0; round < ROUNDS; round++) {
      const s = await scenario();
      let v = s.orderVersion;
      // Fill to one below the cap sequentially — setup, not the race itself.
      for (let i = 0; i < EVIDENCE_MAX_PER_ORDER - 1; i++) {
        await addEvidence(fixture.companyA.id, fixture.techA.id, s.order.id, {
          data: PNG,
          declaredMimeType: "image/png",
          originalName: `pre${round}-${i}.png`,
          expectedOrderVersion: v,
        });
        v += 1;
      }

      const filesBefore = await countFiles(storageRoot);

      // The race: several concurrent uploads all contending for the one
      // remaining slot, all reading the same version — the "duas operações
      // encadeadas" scenario from the audit, stressed with more than two.
      const results = await Promise.allSettled(
        Array.from({ length: CONCURRENT_ATTEMPTS }, (_, i) =>
          addEvidence(fixture.companyA.id, fixture.techA.id, s.order.id, {
            data: PNG,
            declaredMimeType: "image/png",
            originalName: `race${round}-${i}.png`,
            expectedOrderVersion: v,
          }),
        ),
      );

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rowCount = await prisma.serviceOrderEvidence.count({
        where: { serviceOrderId: s.order.id },
      });
      const filesAfter = await countFiles(storageRoot);

      expect(rowCount, `round ${round}: excedeu o teto`).toBeLessThanOrEqual(
        EVIDENCE_MAX_PER_ORDER,
      );
      // Exactly one slot was open, so exactly one of the N contenders may win
      // the compare-and-set — this is the CAS proving itself, not a new claim.
      expect(fulfilled.length, `round ${round}: vencedores simultâneos`).toBe(1);
      expect(rowCount, `round ${round}: teto não preenchido`).toBe(
        EVIDENCE_MAX_PER_ORDER,
      );
      // No orphan file from a loser, no missing file for the winner.
      expect(
        filesAfter - filesBefore,
        `round ${round}: arquivos ≠ linhas`,
      ).toBe(fulfilled.length);
    }
  });

  it("concorrência com o teto já atingido: todas rejeitadas, nenhum arquivo escrito", async () => {
    const s = await scenario();
    let v = s.orderVersion;
    for (let i = 0; i < EVIDENCE_MAX_PER_ORDER; i++) {
      await addEvidence(fixture.companyA.id, fixture.techA.id, s.order.id, {
        data: PNG,
        declaredMimeType: "image/png",
        originalName: `full${i}.png`,
        expectedOrderVersion: v,
      });
      v += 1;
    }

    const filesBefore = await countFiles(storageRoot);
    // Every one of these will win the CAS in turn (the winner's own rejection
    // rolls its claim back, so `v` stays valid for the next contender) and then
    // be rejected by the cap check itself — proving the cap check, not the
    // version check, is what stops them here.
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) =>
        addEvidence(fixture.companyA.id, fixture.techA.id, s.order.id, {
          data: PNG,
          declaredMimeType: "image/png",
          originalName: `overflow${i}.png`,
          expectedOrderVersion: v,
        }),
      ),
    );

    expect(results.every((r) => r.status === "rejected")).toBe(true);
    const rowCount = await prisma.serviceOrderEvidence.count({
      where: { serviceOrderId: s.order.id },
    });
    expect(rowCount).toBe(EVIDENCE_MAX_PER_ORDER);
    expect(await countFiles(storageRoot)).toBe(filesBefore);
  });

  it("remove evidência e apaga o arquivo", async () => {
    const s = await scenario();
    const ev = await addEvidence(fixture.companyA.id, fixture.techA.id, s.order.id, {
      data: PNG,
      declaredMimeType: "image/png",
      originalName: "a.png",
      expectedOrderVersion: s.orderVersion,
    });
    const row = await prisma.serviceOrderEvidence.findUniqueOrThrow({
      where: { id: ev.id },
    });
    const abs = path.resolve(storageRoot, row.storageKey);

    const token = await createTokenFor(fixture.techA.id);
    const res = await removeEvidenceRoute(
      apiRequest(
        `/api/service-orders/${s.order.id}/evidence/${ev.id}`,
        {
          method: "DELETE",
          body: { expectedOrderVersion: await currentOrderVersion(s.order.id) },
        },
        token,
      ),
      { params: { id: s.order.id, evidenceId: ev.id } },
    );
    expect(res.status).toBe(200);
    expect(
      await prisma.serviceOrderEvidence.count({ where: { id: ev.id } }),
    ).toBe(0);
    await expect(fs.access(abs)).rejects.toBeTruthy();
  });

  it("rollback de transação não deixa arquivo órfão", async () => {
    const s = await scenario();
    const before = await countFiles(storageRoot);
    // Stale version: the claim fails, so the transaction rolls back after the
    // file was written — the compensating delete must remove it.
    await expectDomainError(
      () =>
        addEvidence(fixture.companyA.id, fixture.techA.id, s.order.id, {
          data: PNG,
          declaredMimeType: "image/png",
          originalName: "orfa.png",
          expectedOrderVersion: s.orderVersion + 99,
        }),
      409,
    );
    expect(await countFiles(storageRoot)).toBe(before);
  });
});

async function countFiles(dir: string): Promise<number> {
  const entries = await fs.readdir(dir, { withFileTypes: true, recursive: true });
  return entries.filter((e) => e.isFile()).length;
}

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

describe("Materiais", () => {
  it("registra material com quantidade decimal", async () => {
    const s = await scenario();
    const m = await addMaterial(
      fixture.companyA.id,
      fixture.techA.id,
      s.order.id,
      { description: "Cabo drop", quantity: 15.5, unit: "METER" },
      s.orderVersion,
    );
    expect(m.description).toBe("Cabo drop");
    expect(Number(m.quantity)).toBeCloseTo(15.5);
    expect(m.unit).toBe("METER");
  });

  it("rejeita quantidade zero ou negativa na rota", async () => {
    const s = await scenario();
    const token = await createTokenFor(fixture.techA.id);
    for (const quantity of [0, -1]) {
      const res = await addMaterialRoute(
        apiRequest(
          `/api/service-orders/${s.order.id}/materials`,
          {
            method: "POST",
            body: {
              description: "X",
              quantity,
              unit: "UNIT",
              expectedOrderVersion: s.orderVersion,
            },
          },
          token,
        ),
        { params: { id: s.order.id } },
      );
      expect(res.status).toBe(400);
    }
  });

  it("atualiza e remove material", async () => {
    const s = await scenario();
    const token = await createTokenFor(fixture.techA.id);
    const m = await addMaterial(
      fixture.companyA.id,
      fixture.techA.id,
      s.order.id,
      { description: "Conector", quantity: 2, unit: "UNIT" },
      s.orderVersion,
    );

    const patched = await patchMaterialRoute(
      apiRequest(
        `/api/service-orders/${s.order.id}/materials/${m.id}`,
        {
          method: "PATCH",
          body: {
            description: "Conector SC/APC",
            quantity: 3,
            unit: "UNIT",
            expectedOrderVersion: await currentOrderVersion(s.order.id),
          },
        },
        token,
      ),
      { params: { id: s.order.id, materialId: m.id } },
    );
    expect(patched.status).toBe(200);

    const deleted = await deleteMaterialRoute(
      apiRequest(
        `/api/service-orders/${s.order.id}/materials/${m.id}`,
        {
          method: "DELETE",
          body: { expectedOrderVersion: await currentOrderVersion(s.order.id) },
        },
        token,
      ),
      { params: { id: s.order.id, materialId: m.id } },
    );
    expect(deleted.status).toBe(200);
    expect(
      await prisma.serviceOrderMaterialUsage.count({ where: { id: m.id } }),
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Signature
// ---------------------------------------------------------------------------

describe("Assinatura", () => {
  it("captura assinatura", async () => {
    const s = await scenario();
    const sig = await putSignature(
      fixture.companyA.id,
      fixture.techA.id,
      s.order.id,
      {
        signerName: "Maria Cliente",
        data: PNG,
        declaredMimeType: "image/png",
        expectedOrderVersion: s.orderVersion,
      },
    );
    expect(sig.signerName).toBe("Maria Cliente");
  });

  it("segunda captura substitui, mantendo uma única linha e apagando o arquivo antigo", async () => {
    const s = await scenario();
    const first = await putSignature(
      fixture.companyA.id,
      fixture.techA.id,
      s.order.id,
      {
        signerName: "Primeiro",
        data: PNG,
        declaredMimeType: "image/png",
        expectedOrderVersion: s.orderVersion,
      },
    );
    const firstRow = await prisma.serviceOrderSignature.findUniqueOrThrow({
      where: { serviceOrderId: s.order.id },
    });
    const firstAbs = path.resolve(storageRoot, firstRow.storageKey);

    const second = await putSignature(
      fixture.companyA.id,
      fixture.techA.id,
      s.order.id,
      {
        signerName: "Segundo",
        data: JPEG,
        declaredMimeType: "image/jpeg",
        expectedOrderVersion: await currentOrderVersion(s.order.id),
      },
    );
    expect(second.id).toBe(first.id);
    expect(second.signerName).toBe("Segundo");
    expect(
      await prisma.serviceOrderSignature.count({
        where: { serviceOrderId: s.order.id },
      }),
    ).toBe(1);
    await expect(fs.access(firstAbs)).rejects.toBeTruthy();
  });

  it("uma OS não pode ter duas assinaturas (constraint do banco)", async () => {
    const s = await scenario();
    await putSignature(fixture.companyA.id, fixture.techA.id, s.order.id, {
      signerName: "A",
      data: PNG,
      declaredMimeType: "image/png",
      expectedOrderVersion: s.orderVersion,
    });
    await expect(
      prisma.serviceOrderSignature.create({
        data: {
          companyId: fixture.companyA.id,
          serviceOrderId: s.order.id,
          signerName: "B",
          storageKey: "x/y/z.png",
          mimeType: "image/png",
          sizeBytes: 1,
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });
});

// ---------------------------------------------------------------------------
// Immutability after COMPLETED
// ---------------------------------------------------------------------------

describe("Imutabilidade após conclusão", () => {
  it("nenhuma mutação do técnico é aceita depois de COMPLETED", async () => {
    const s = await scenario();
    const ev = await addEvidence(fixture.companyA.id, fixture.techA.id, s.order.id, {
      data: PNG,
      declaredMimeType: "image/png",
      originalName: "a.png",
      expectedOrderVersion: s.orderVersion,
    });
    const mat = await addMaterial(
      fixture.companyA.id,
      fixture.techA.id,
      s.order.id,
      { description: "Cabo", quantity: 1, unit: "METER" },
      await currentOrderVersion(s.order.id),
    );
    const ex = await prisma.serviceOrderExecution.findUniqueOrThrow({
      where: { serviceOrderId: s.order.id },
    });
    await completeServiceOrder(fixture.companyA.id, fixture.techA.id, s.order.id, {
      expectedOrderVersion: await currentOrderVersion(s.order.id),
      expectedExecutionVersion: ex.version,
    });

    const v = await currentOrderVersion(s.order.id);
    const exAfter = await prisma.serviceOrderExecution.findUniqueOrThrow({
      where: { serviceOrderId: s.order.id },
    });

    await expectDomainError(
      () =>
        updateServiceOrderExecution(
          fixture.companyA.id,
          fixture.techA.id,
          s.order.id,
          exAfter.version,
          { notes: "editando depois" },
        ),
      409,
    );
    await expectDomainError(
      () =>
        addEvidence(fixture.companyA.id, fixture.techA.id, s.order.id, {
          data: PNG,
          declaredMimeType: "image/png",
          originalName: "depois.png",
          expectedOrderVersion: v,
        }),
      409,
    );
    await expectDomainError(
      () =>
        addMaterial(
          fixture.companyA.id,
          fixture.techA.id,
          s.order.id,
          { description: "Depois", quantity: 1, unit: "UNIT" },
          v,
        ),
      409,
    );
    await expectDomainError(
      () =>
        putSignature(fixture.companyA.id, fixture.techA.id, s.order.id, {
          signerName: "Depois",
          data: PNG,
          declaredMimeType: "image/png",
          expectedOrderVersion: v,
        }),
      409,
    );
    await expectDomainError(
      () =>
        startServiceOrder(fixture.companyA.id, fixture.techA.id, s.order.id, v),
      409,
    );

    // Everything recorded before the close is still readable and unchanged.
    const bundle = await getServiceOrderClosingBundle(
      fixture.companyA.id,
      s.order.id,
    );
    expect(bundle.evidences.map((e) => e.id)).toContain(ev.id);
    expect(bundle.materials.map((m) => m.id)).toContain(mat.id);
  });
});

// ---------------------------------------------------------------------------
// Ownership and tenancy
// ---------------------------------------------------------------------------

describe("Ownership e multi-tenancy", () => {
  async function otherTechnician() {
    return prisma.technician.create({
      data: { companyId: fixture.companyA.id, userId: fixture.techB.id },
    });
  }

  it("técnico B não conclui, anexa, adiciona material nem assina a OS de A", async () => {
    const s = await scenario();
    await otherTechnician();

    await expectDomainError(
      () =>
        completeServiceOrder(fixture.companyA.id, fixture.techB.id, s.order.id, {
          expectedOrderVersion: s.orderVersion,
          expectedExecutionVersion: s.executionVersion,
        }),
      404,
    );
    await expectDomainError(
      () =>
        addEvidence(fixture.companyA.id, fixture.techB.id, s.order.id, {
          data: PNG,
          declaredMimeType: "image/png",
          originalName: "b.png",
          expectedOrderVersion: s.orderVersion,
        }),
      404,
    );
    await expectDomainError(
      () =>
        addMaterial(
          fixture.companyA.id,
          fixture.techB.id,
          s.order.id,
          { description: "X", quantity: 1, unit: "UNIT" },
          s.orderVersion,
        ),
      404,
    );
    await expectDomainError(
      () =>
        putSignature(fixture.companyA.id, fixture.techB.id, s.order.id, {
          signerName: "B",
          data: PNG,
          declaredMimeType: "image/png",
          expectedOrderVersion: s.orderVersion,
        }),
      404,
    );
  });

  it("técnico B não baixa a evidência da OS de A", async () => {
    const s = await scenario();
    await otherTechnician();
    const ev = await addEvidence(fixture.companyA.id, fixture.techA.id, s.order.id, {
      data: PNG,
      declaredMimeType: "image/png",
      originalName: "secreta.png",
      expectedOrderVersion: s.orderVersion,
    });

    const tokenB = await createTokenFor(fixture.techB.id);
    const res = await evidenceContentRoute(
      apiRequest(
        `/api/service-orders/${s.order.id}/evidence/${ev.id}/content`,
        {},
        tokenB,
      ),
      { params: { id: s.order.id, evidenceId: ev.id } },
    );
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("storageKey");
  });

  it("empresa B não alcança nada da OS da empresa A", async () => {
    const s = await scenario();
    const userB = await prisma.user.create({
      data: {
        companyId: fixture.companyB.id,
        name: "Tec B",
        email: "tecb.closing@b.local",
        profile: "TECHNICIAN",
        passwordHash: "x",
      },
    });
    await prisma.technician.create({
      data: { companyId: fixture.companyB.id, userId: userB.id },
    });
    const ev = await addEvidence(fixture.companyA.id, fixture.techA.id, s.order.id, {
      data: PNG,
      declaredMimeType: "image/png",
      originalName: "a.png",
      expectedOrderVersion: s.orderVersion,
    });

    const vNow = await currentOrderVersion(s.order.id);
    await expectDomainError(
      () =>
        completeServiceOrder(fixture.companyB.id, userB.id, s.order.id, {
          expectedOrderVersion: vNow,
          expectedExecutionVersion: s.executionVersion,
        }),
      404,
    );

    const tokenB = await createTokenFor(userB.id);
    const res = await evidenceContentRoute(
      apiRequest(
        `/api/service-orders/${s.order.id}/evidence/${ev.id}/content`,
        {},
        tokenB,
      ),
      { params: { id: s.order.id, evidenceId: ev.id } },
    );
    expect(res.status).toBe(404);

    // And the read helper returns nothing for the wrong tenant.
    const bundle = await getServiceOrderClosingBundle(
      fixture.companyB.id,
      s.order.id,
    );
    expect(bundle.evidences).toHaveLength(0);
    expect(bundle.signature).toBeNull();
  });

  it("dono baixa a própria evidência (controle positivo)", async () => {
    const s = await scenario();
    const ev = await addEvidence(fixture.companyA.id, fixture.techA.id, s.order.id, {
      data: JPEG,
      declaredMimeType: "image/jpeg",
      originalName: "minha.jpg",
      expectedOrderVersion: s.orderVersion,
    });
    const res = await evidenceContentRoute(
      apiRequest(
        `/api/service-orders/${s.order.id}/evidence/${ev.id}/content`,
        {},
        s.token,
      ),
      { params: { id: s.order.id, evidenceId: ev.id } },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Disposition")).toBe("attachment");
  });

  it("ADMIN da mesma empresa lê a evidência; ADMIN não escreve", async () => {
    const s = await scenario();
    const ev = await addEvidence(fixture.companyA.id, fixture.techA.id, s.order.id, {
      data: PNG,
      declaredMimeType: "image/png",
      originalName: "a.png",
      expectedOrderVersion: s.orderVersion,
    });
    const admin = await createTokenFor(fixture.adminA.id);

    const read = await evidenceContentRoute(
      apiRequest(
        `/api/service-orders/${s.order.id}/evidence/${ev.id}/content`,
        {},
        admin,
      ),
      { params: { id: s.order.id, evidenceId: ev.id } },
    );
    expect(read.status).toBe(200);

    const write = await addMaterialRoute(
      apiRequest(
        `/api/service-orders/${s.order.id}/materials`,
        {
          method: "POST",
          body: {
            description: "X",
            quantity: 1,
            unit: "UNIT",
            expectedOrderVersion: await currentOrderVersion(s.order.id),
          },
        },
        admin,
      ),
      { params: { id: s.order.id } },
    );
    expect(write.status).toBe(403);

    const close = await completeRoute(
      apiRequest(
        `/api/service-orders/${s.order.id}/complete`,
        {
          method: "POST",
          body: { expectedOrderVersion: 0, expectedExecutionVersion: 0 },
        },
        admin,
      ),
      { params: { id: s.order.id } },
    );
    expect(close.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

describe("Elegibilidade do técnico no fechamento", () => {
  it("technician inativo, user inativo e perfil trocado não concluem", async () => {
    const s = await scenario();

    await prisma.technician.update({
      where: { id: s.techA.id },
      data: { active: false },
    });
    await expectDomainError(
      () =>
        completeServiceOrder(fixture.companyA.id, fixture.techA.id, s.order.id, {
          expectedOrderVersion: s.orderVersion,
          expectedExecutionVersion: s.executionVersion,
        }),
      403,
    );
    await prisma.technician.update({
      where: { id: s.techA.id },
      data: { active: true },
    });

    await prisma.user.update({
      where: { id: fixture.techA.id },
      data: { active: false },
    });
    await expectDomainError(
      () =>
        completeServiceOrder(fixture.companyA.id, fixture.techA.id, s.order.id, {
          expectedOrderVersion: s.orderVersion,
          expectedExecutionVersion: s.executionVersion,
        }),
      403,
    );
    await prisma.user.update({
      where: { id: fixture.techA.id },
      data: { active: true, profile: "DISPATCHER" },
    });
    await expectDomainError(
      () =>
        completeServiceOrder(fixture.companyA.id, fixture.techA.id, s.order.id, {
          expectedOrderVersion: s.orderVersion,
          expectedExecutionVersion: s.executionVersion,
        }),
      403,
    );
  });
});

// ---------------------------------------------------------------------------
// Contract hardening
// ---------------------------------------------------------------------------

describe("Contratos das rotas", () => {
  it("mass assignment é rejeitado em todas as rotas JSON novas", async () => {
    const s = await scenario();
    const token = await createTokenFor(fixture.techA.id);
    const banned = [
      "companyId",
      "serviceOrderId",
      "technicianId",
      "createdByUserId",
      "uploadedByUserId",
      "status",
      "version",
      "completedAt",
      "signedAt",
      "storageKey",
      "id",
    ];

    for (const field of banned) {
      const close = await completeRoute(
        apiRequest(
          `/api/service-orders/${s.order.id}/complete`,
          {
            method: "POST",
            body: {
              expectedOrderVersion: s.orderVersion,
              expectedExecutionVersion: s.executionVersion,
              [field]: "evil",
            },
          },
          token,
        ),
        { params: { id: s.order.id } },
      );
      expect(close.status).toBe(400);

      const mat = await addMaterialRoute(
        apiRequest(
          `/api/service-orders/${s.order.id}/materials`,
          {
            method: "POST",
            body: {
              description: "X",
              quantity: 1,
              unit: "UNIT",
              expectedOrderVersion: s.orderVersion,
              [field]: "evil",
            },
          },
          token,
        ),
        { params: { id: s.order.id } },
      );
      expect(mat.status).toBe(400);
    }

    const after = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: s.order.id },
    });
    expect(after.status).toBe("IN_PROGRESS");
    expect(after.companyId).toBe(fixture.companyA.id);
  });

  it("expectedVersion acima do INT32 retorna 400, não 500", async () => {
    const s = await scenario();
    const token = await createTokenFor(fixture.techA.id);
    const tooBig = 2_147_483_648;

    const close = await completeRoute(
      apiRequest(
        `/api/service-orders/${s.order.id}/complete`,
        {
          method: "POST",
          body: {
            expectedOrderVersion: tooBig,
            expectedExecutionVersion: s.executionVersion,
          },
        },
        token,
      ),
      { params: { id: s.order.id } },
    );
    expect(close.status).toBe(400);

    const closeExec = await completeRoute(
      apiRequest(
        `/api/service-orders/${s.order.id}/complete`,
        {
          method: "POST",
          body: {
            expectedOrderVersion: s.orderVersion,
            expectedExecutionVersion: tooBig,
          },
        },
        token,
      ),
      { params: { id: s.order.id } },
    );
    expect(closeExec.status).toBe(400);

    const mat = await addMaterialRoute(
      apiRequest(
        `/api/service-orders/${s.order.id}/materials`,
        {
          method: "POST",
          body: {
            description: "X",
            quantity: 1,
            unit: "UNIT",
            expectedOrderVersion: tooBig,
          },
        },
        token,
      ),
      { params: { id: s.order.id } },
    );
    expect(mat.status).toBe(400);
  });

  it("rotas novas exigem sessão e Same-Origin", async () => {
    const s = await scenario();
    const token = await createTokenFor(fixture.techA.id);

    const noSession = await completeRoute(
      apiRequest(`/api/service-orders/${s.order.id}/complete`, {
        method: "POST",
        body: { expectedOrderVersion: 0, expectedExecutionVersion: 0 },
      }),
      { params: { id: s.order.id } },
    );
    expect(noSession.status).toBe(401);

    const crossOrigin = await completeRoute(
      apiRequest(
        `/api/service-orders/${s.order.id}/complete`,
        {
          method: "POST",
          body: {
            expectedOrderVersion: s.orderVersion,
            expectedExecutionVersion: s.executionVersion,
          },
          headers: { Origin: "https://evil.test" },
        },
        token,
      ),
      { params: { id: s.order.id } },
    );
    expect(crossOrigin.status).toBe(403);

    const evidenceNoSession = await addEvidenceRoute(
      formRequest(`/api/service-orders/${s.order.id}/evidence`, new FormData()),
      { params: { id: s.order.id } },
    );
    expect(evidenceNoSession.status).toBe(401);
  });

  it("upload multipart funciona e ignora partes extras", async () => {
    const s = await scenario();
    const token = await createTokenFor(fixture.techA.id);
    const form = new FormData();
    form.set("file", filePart(PNG, "foto.png", "image/png"));
    form.set("expectedOrderVersion", String(s.orderVersion));
    // Extra parts must not reach persistence.
    form.set("companyId", fixture.companyB.id);
    form.set("storageKey", "../../evil.png");

    const res = await addEvidenceRoute(
      formRequest(`/api/service-orders/${s.order.id}/evidence`, form, token),
      { params: { id: s.order.id } },
    );
    expect(res.status).toBe(201);

    const row = await prisma.serviceOrderEvidence.findFirstOrThrow({
      where: { serviceOrderId: s.order.id },
    });
    expect(row.companyId).toBe(fixture.companyA.id);
    expect(row.storageKey).not.toContain("..");
  });

  it("assinatura via multipart exige nome do assinante", async () => {
    const s = await scenario();
    const token = await createTokenFor(fixture.techA.id);
    const form = new FormData();
    form.set("file", filePart(PNG, "sig.png", "image/png"));
    form.set("expectedOrderVersion", String(s.orderVersion));

    const req = new Request(
      `http://localhost/api/service-orders/${s.order.id}/signature`,
      {
        method: "PUT",
        headers: { Cookie: `alfaos_session=${encodeURIComponent(token)}` },
        body: form,
      },
    );
    const res = await putSignatureRoute(req, { params: { id: s.order.id } });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

describe("Dashboard", () => {
  it("conta concluídas por empresa", async () => {
    const s = await scenario();
    await completeServiceOrder(fixture.companyA.id, fixture.techA.id, s.order.id, {
      expectedOrderVersion: s.orderVersion,
      expectedExecutionVersion: s.executionVersion,
    });
    const statsA = await getDashboardStats(fixture.companyA.id);
    const statsB = await getDashboardStats(fixture.companyB.id);
    expect(statsA.osConcluidasHoje).toBe(1);
    expect(statsA.osEmAtendimento).toBe(0);
    expect(statsB.osConcluidasHoje).toBe(0);
  });
});
