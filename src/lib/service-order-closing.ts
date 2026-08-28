import { createHash } from "node:crypto";
import type { EvidenceCategory, EvidenceKind, MaterialUnit, Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { logAudit } from "./audit";
import { badRequest, conflict, notFound } from "./errors";
import {
  buildCompletionSnapshot,
  closingContentHash,
  CompletionBlockedError,
  validateServiceOrderCompletion,
} from "./service-order-completion";
import {
  loadOwnedServiceOrder,
  resolveActingTechnician,
} from "./service-orders";
import {
  claimOrderForChildMutation,
  loadInProgressOwnedOrder,
} from "./service-order-child-mutation";
import {
  buildStorageKey,
  getFileStorage,
  MIME_EXTENSIONS,
} from "./storage";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * 8 MB per image. A modern phone photo lands well under this after the browser
 * re-encodes it, while the cap still bounds a single request and the disk cost
 * of one order. Paired with the count cap below, worst case per order is 80 MB.
 */
export const EVIDENCE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * 10 photos per order. Enough for the documented field protocol (ONU, router,
 * CTO, power reading, problem, result) with room to spare; low enough that a
 * runaway client cannot fill the disk through one order.
 */
export const EVIDENCE_MAX_PER_ORDER = 10;

/** Signatures are small line drawings; 2 MB is generous for a PNG canvas. */
export const SIGNATURE_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Only raster formats with a checkable magic number.
 *
 * SVG and HTML are excluded on purpose: both can carry script and would run in
 * the browser's origin when rendered. There is no safe way to serve untrusted
 * SVG from the same origin as the app, so it is not accepted at all.
 */
export const ACCEPTED_IMAGE_MIME = Object.keys(MIME_EXTENSIONS);

export const MATERIAL_DESCRIPTION_MAX = 200;
export const SIGNER_NAME_MAX = 120;
/** Decimal(10,3) — quantity must stay inside what the column can hold. */
export const MATERIAL_QUANTITY_MAX = 9_999_999;

// ---------------------------------------------------------------------------
// Content sniffing
// ---------------------------------------------------------------------------

/**
 * Decides the real type from the bytes, never from the declared mime or the
 * filename extension.
 *
 * A client can claim `image/png` for a PHP script or name an executable
 * `photo.jpg`. The magic number is the only part of an upload the client
 * cannot lie about without actually producing a valid image.
 */
export function sniffImageMime(data: Buffer): string | null {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    data.length >= 8 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47 &&
    data[4] === 0x0d &&
    data[5] === 0x0a &&
    data[6] === 0x1a &&
    data[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    data.length >= 12 &&
    data.toString("ascii", 0, 4) === "RIFF" &&
    data.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export interface PublicEvidence {
  id: string;
  kind: EvidenceKind;
  category: EvidenceCategory;
  caption: string | null;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: Date;
}

export interface PublicMaterial {
  id: string;
  description: string;
  quantity: string;
  unit: MaterialUnit;
  createdAt: Date;
}

export interface PublicSignature {
  id: string;
  signerName: string;
  mimeType: string;
  sizeBytes: number;
  signedAt: Date;
}

export interface ServiceOrderClosingBundle {
  evidences: PublicEvidence[];
  materials: PublicMaterial[];
  signature: PublicSignature | null;
}


// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

export interface AddEvidenceInput {
  data: Buffer;
  declaredMimeType: string;
  originalName: string;
  expectedOrderVersion: number;
  /**
   * O que a foto prova. `OTHER` quando o chamador não classifica — é o caso da
   * web, que anexa sem categoria desde a v0.4.
   */
  category?: EvidenceCategory;
  caption?: string | null;
  /** Carimbo do APARELHO. Informativo; a integridade vem de `createdAt`. */
  capturedAt?: Date | null;
}

export const EVIDENCE_CAPTION_MAX = 300;

/**
 * Attaches a photo to an in-progress order.
 *
 * `storage.put` runs INSIDE the transaction, after the claim has already
 * secured the row lock — it is not hoisted out. If the transaction fails
 * after the write (the cap check below, a later DB error, the commit itself),
 * the `catch` block deletes the orphaned file; the row is the source of
 * truth, and nothing references a file without a committed row pointing at
 * it. An orphaned file from a mid-write crash costs disk, never correctness.
 *
 * This does mean the row lock on the order is held across a local filesystem
 * write, which is fine for `LocalFileStorageAdapter` (fast, no network) but
 * is a real cost to reconsider if `FileStorageContract` ever grows a
 * network-backed adapter (S3/R2/MinIO): holding a Postgres row lock across a
 * network round trip would widen the window every other child mutation of
 * this order has to wait through. Not a problem today — flagged for whoever
 * adds that adapter, not fixed here.
 */
export async function addEvidence(
  companyId: string,
  actorUserId: string,
  orderId: string,
  input: AddEvidenceInput,
): Promise<PublicEvidence> {
  if (input.data.byteLength === 0) {
    throw badRequest("Arquivo vazio.");
  }
  if (input.data.byteLength > EVIDENCE_MAX_BYTES) {
    throw badRequest(
      `Imagem muito grande (máximo ${Math.floor(EVIDENCE_MAX_BYTES / 1024 / 1024)} MB).`,
    );
  }

  // The declared type must be acceptable AND the bytes must agree with it.
  // Either alone is bypassable: the header is client-controlled, and sniffing
  // alone would happily accept a JPEG uploaded as `application/x-msdownload`.
  const sniffed = sniffImageMime(input.data);
  if (!sniffed) {
    throw badRequest("Arquivo não é uma imagem JPEG, PNG ou WebP válida.");
  }
  if (!ACCEPTED_IMAGE_MIME.includes(input.declaredMimeType)) {
    throw badRequest("Tipo de imagem não suportado. Use JPEG, PNG ou WebP.");
  }
  if (sniffed !== input.declaredMimeType) {
    throw badRequest("O conteúdo do arquivo não corresponde ao tipo informado.");
  }

  const storage = getFileStorage();
  const storageKey = buildStorageKey(companyId, orderId, sniffed);
  let wrote = false;

  /*
    Impressão digital dos BYTES — metadado, não regra de escrita.

    Serve para conferir integridade depois e para uma futura ferramenta de
    limpeza. **Não deduplica.** A retentativa do Field é resolvida pela
    `Idempotency-Key`, e transformar este hash numa unique criaria um caminho
    de sucesso-sem-escrita que enfraqueceria a garantia de corrida do teto
    logo abaixo — ver o comentário do campo em `schema.prisma`.
  */
  const contentHash = createHash("sha256").update(input.data).digest("hex");

  try {
    const created = await prisma.$transaction(async (tx) => {
      await loadInProgressOwnedOrder(tx, companyId, actorUserId, orderId);

      // Claim FIRST, count SECOND. `claimOrderForChildMutation`'s `UPDATE`
      // holds a row-exclusive Postgres lock on this order until the
      // transaction ends, so once it succeeds we are — provably, not just by
      // convention — the only writer touching this order's children until we
      // commit or roll back. A count taken before the claim only reflects
      // "committed as of a moment that has already passed by the time we act
      // on it"; a concurrent claimant on the same version can't create a
      // second row (the CAS lets only one of them through), but the ordering
      // still meant the cap's correctness depended on every future
      // evidence-creating code path remembering to route through this same
      // claim — a non-local invariant that is easy to violate by accident
      // later (a bulk-import script, an admin tool) without ever tripping a
      // version conflict. Counting only after the claim makes the check
      // locally sound: nothing else can be racing us here, so what we see IS
      // current, not "current as of when we looked".
      await claimOrderForChildMutation(
        tx,
        companyId,
        orderId,
        input.expectedOrderVersion,
      );

      const existing = await tx.serviceOrderEvidence.count({
        where: { serviceOrderId: orderId, companyId },
      });
      if (existing >= EVIDENCE_MAX_PER_ORDER) {
        // Thrown after the claim already ran: Prisma aborts the interactive
        // transaction on a thrown error, and Postgres rolls back everything
        // in it — including the version bump the claim just made. The order
        // is left exactly as it was; hitting the cap costs nothing.
        throw badRequest(
          `Limite de ${EVIDENCE_MAX_PER_ORDER} imagens por OS atingido.`,
        );
      }

      await storage.put(storageKey, input.data, sniffed);
      wrote = true;

      return tx.serviceOrderEvidence.create({
        data: {
          companyId,
          serviceOrderId: orderId,
          uploadedByUserId: actorUserId,
          kind: "PHOTO",
          category: input.category ?? "OTHER",
          caption: input.caption?.trim().slice(0, EVIDENCE_CAPTION_MAX) || null,
          capturedAt: input.capturedAt ?? null,
          contentHash,
          storageKey,
          // Stored for display only; truncated so a pathological name cannot
          // bloat the row. It never touches the filesystem path.
          originalName: input.originalName.slice(0, 255),
          mimeType: sniffed,
          sizeBytes: input.data.byteLength,
        },
      });
    });

    await logAudit({
      companyId,
      userId: actorUserId,
      action: "SERVICE_ORDER.EVIDENCE_ADDED",
      entity: "ServiceOrderEvidence",
      entityId: created.id,
      details: `Evidência ${created.category} anexada à OS (${created.mimeType}, ${created.sizeBytes} bytes)`,
    });

    return toPublicEvidence(created);
  } catch (error) {
    if (wrote) {
      await storage.delete(storageKey).catch(() => undefined);
    }
    throw error;
  }
}

export async function removeEvidence(
  companyId: string,
  actorUserId: string,
  orderId: string,
  evidenceId: string,
  expectedOrderVersion: number,
): Promise<void> {
  const removed = await prisma.$transaction(async (tx) => {
    await loadInProgressOwnedOrder(tx, companyId, actorUserId, orderId);

    const evidence = await tx.serviceOrderEvidence.findFirst({
      where: { id: evidenceId, serviceOrderId: orderId, companyId },
    });
    if (!evidence) {
      throw notFound("Evidência não encontrada.");
    }

    await claimOrderForChildMutation(
      tx,
      companyId,
      orderId,
      expectedOrderVersion,
    );

    /*
      Uma etiqueta em uso não pode ser apagada.

      A FK é `Restrict`, então o banco já recusaria — mas com um erro cru de
      constraint, que viraria 500. A conferência explícita existe para o
      técnico receber a frase que diz o que fazer.

      A ordem importa: remover a foto deixaria para trás um equipamento sem
      série, sem MAC e sem etiqueta — um registro que não responde mais a
      pergunta que ele existe para responder.
    */
    const identifica = await tx.serviceOrderEquipment.count({
      where: { labelEvidenceId: evidence.id, companyId },
    });
    if (identifica > 0) {
      throw conflict(
        "Esta foto identifica um equipamento registrado. " +
          "Remova o equipamento antes de apagar a etiqueta.",
      );
    }

    await tx.serviceOrderEvidence.delete({ where: { id: evidence.id } });
    return evidence;
  });

  // Deleted after the transaction commits: if the delete failed mid-transaction
  // we would have destroyed a file the surviving row still points at.
  await getFileStorage().delete(removed.storageKey).catch(() => undefined);

  await logAudit({
    companyId,
    userId: actorUserId,
    action: "SERVICE_ORDER.EVIDENCE_REMOVED",
    entity: "ServiceOrderEvidence",
    entityId: removed.id,
    details: "Evidência removida da OS",
  });
}

/**
 * Resolves an evidence for download, enforcing tenant and — for technicians —
 * ownership. Staff of the same company may read; a technician may read only
 * their own order's evidence. Anything else is 404, never 403, so an id probe
 * learns nothing.
 */
export async function loadEvidenceForDownload(
  companyId: string,
  orderId: string,
  evidenceId: string,
  requester: { isStaff: boolean; technicianId: string | null },
): Promise<{ data: Buffer; mimeType: string; originalName: string }> {
  const evidence = await prisma.serviceOrderEvidence.findFirst({
    where: { id: evidenceId, serviceOrderId: orderId, companyId },
    include: { serviceOrder: { select: { technicianId: true } } },
  });
  if (!evidence) {
    throw notFound("Evidência não encontrada.");
  }
  if (!requester.isStaff) {
    if (
      !requester.technicianId ||
      evidence.serviceOrder.technicianId !== requester.technicianId
    ) {
      throw notFound("Evidência não encontrada.");
    }
  }
  const data = await getFileStorage()
    .get(evidence.storageKey)
    .catch(() => {
      throw notFound("Arquivo não encontrado.");
    });
  return {
    data,
    mimeType: evidence.mimeType,
    originalName: evidence.originalName,
  };
}

function toPublicEvidence(e: {
  id: string;
  kind: EvidenceKind;
  category: EvidenceCategory;
  caption: string | null;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: Date;
}): PublicEvidence {
  return {
    id: e.id,
    kind: e.kind,
    category: e.category,
    caption: e.caption,
    originalName: e.originalName,
    mimeType: e.mimeType,
    sizeBytes: e.sizeBytes,
    createdAt: e.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

export interface MaterialInput {
  description: string;
  quantity: number;
  unit: MaterialUnit;
}

export async function addMaterial(
  companyId: string,
  actorUserId: string,
  orderId: string,
  input: MaterialInput,
  expectedOrderVersion: number,
): Promise<PublicMaterial> {
  const description = input.description.trim();
  if (!description) {
    throw badRequest("Descrição do material é obrigatória.");
  }

  const created = await prisma.$transaction(async (tx) => {
    await loadInProgressOwnedOrder(tx, companyId, actorUserId, orderId);
    await claimOrderForChildMutation(
      tx,
      companyId,
      orderId,
      expectedOrderVersion,
    );
    return tx.serviceOrderMaterialUsage.create({
      data: {
        companyId,
        serviceOrderId: orderId,
        createdByUserId: actorUserId,
        description: description.slice(0, MATERIAL_DESCRIPTION_MAX),
        quantity: input.quantity,
        unit: input.unit,
      },
    });
  });

  await logAudit({
    companyId,
    userId: actorUserId,
    action: "SERVICE_ORDER.MATERIAL_ADDED",
    entity: "ServiceOrderMaterialUsage",
    entityId: created.id,
    details: `Material registrado na OS (${created.quantity} ${created.unit})`,
  });

  return toPublicMaterial(created);
}

export async function updateMaterial(
  companyId: string,
  actorUserId: string,
  orderId: string,
  materialId: string,
  input: MaterialInput,
  expectedOrderVersion: number,
): Promise<PublicMaterial> {
  const description = input.description.trim();
  if (!description) {
    throw badRequest("Descrição do material é obrigatória.");
  }

  const updated = await prisma.$transaction(async (tx) => {
    await loadInProgressOwnedOrder(tx, companyId, actorUserId, orderId);

    const material = await tx.serviceOrderMaterialUsage.findFirst({
      where: { id: materialId, serviceOrderId: orderId, companyId },
    });
    if (!material) {
      throw notFound("Material não encontrado.");
    }

    await claimOrderForChildMutation(
      tx,
      companyId,
      orderId,
      expectedOrderVersion,
    );

    return tx.serviceOrderMaterialUsage.update({
      where: { id: material.id },
      data: {
        description: description.slice(0, MATERIAL_DESCRIPTION_MAX),
        quantity: input.quantity,
        unit: input.unit,
      },
    });
  });

  await logAudit({
    companyId,
    userId: actorUserId,
    action: "SERVICE_ORDER.MATERIAL_UPDATED",
    entity: "ServiceOrderMaterialUsage",
    entityId: updated.id,
    details: "Material da OS atualizado",
  });

  return toPublicMaterial(updated);
}

export async function removeMaterial(
  companyId: string,
  actorUserId: string,
  orderId: string,
  materialId: string,
  expectedOrderVersion: number,
): Promise<void> {
  const removed = await prisma.$transaction(async (tx) => {
    await loadInProgressOwnedOrder(tx, companyId, actorUserId, orderId);

    const material = await tx.serviceOrderMaterialUsage.findFirst({
      where: { id: materialId, serviceOrderId: orderId, companyId },
    });
    if (!material) {
      throw notFound("Material não encontrado.");
    }

    await claimOrderForChildMutation(
      tx,
      companyId,
      orderId,
      expectedOrderVersion,
    );

    await tx.serviceOrderMaterialUsage.delete({ where: { id: material.id } });
    return material;
  });

  await logAudit({
    companyId,
    userId: actorUserId,
    action: "SERVICE_ORDER.MATERIAL_REMOVED",
    entity: "ServiceOrderMaterialUsage",
    entityId: removed.id,
    details: "Material removido da OS",
  });
}

function toPublicMaterial(m: {
  id: string;
  description: string;
  quantity: unknown;
  unit: MaterialUnit;
  createdAt: Date;
}): PublicMaterial {
  return {
    id: m.id,
    description: m.description,
    // Prisma Decimal is not JSON-serializable in a Server Component payload,
    // so it crosses the boundary as a string and is formatted by the UI.
    quantity: String(m.quantity),
    unit: m.unit,
    createdAt: m.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Signature
// ---------------------------------------------------------------------------

export interface SignatureInput {
  signerName: string;
  data: Buffer;
  declaredMimeType: string;
  expectedOrderVersion: number;
}

/**
 * Captures (or replaces) the customer's signature.
 *
 * Replace, not append: the schema allows one signature per order, so a redraw
 * while IN_PROGRESS overwrites the row and deletes the previous file. That
 * keeps "the signature" unambiguous when the order closes.
 */
export async function putSignature(
  companyId: string,
  actorUserId: string,
  orderId: string,
  input: SignatureInput,
): Promise<PublicSignature> {
  const signerName = input.signerName.trim();
  if (!signerName) {
    throw badRequest("Nome de quem assina é obrigatório.");
  }
  if (input.data.byteLength === 0) {
    throw badRequest("Assinatura vazia.");
  }
  if (input.data.byteLength > SIGNATURE_MAX_BYTES) {
    throw badRequest("Imagem de assinatura muito grande.");
  }

  const sniffed = sniffImageMime(input.data);
  if (!sniffed) {
    throw badRequest("Assinatura deve ser uma imagem PNG válida.");
  }
  if (!ACCEPTED_IMAGE_MIME.includes(input.declaredMimeType)) {
    throw badRequest("Tipo de imagem não suportado.");
  }
  if (sniffed !== input.declaredMimeType) {
    throw badRequest("O conteúdo do arquivo não corresponde ao tipo informado.");
  }

  const storage = getFileStorage();
  const storageKey = buildStorageKey(companyId, orderId, sniffed);
  let wrote = false;
  let previousKey: string | null = null;

  try {
    const saved = await prisma.$transaction(async (tx) => {
      const { order } = await loadInProgressOwnedOrder(
        tx,
        companyId,
        actorUserId,
        orderId,
      );

      const existing = await tx.serviceOrderSignature.findFirst({
        where: { serviceOrderId: orderId, companyId },
      });
      previousKey = existing?.storageKey ?? null;

      await claimOrderForChildMutation(
        tx,
        companyId,
        orderId,
        input.expectedOrderVersion,
      );

      /*
        O QUE está sendo assinado, capturado no mesmo instante da assinatura.

        Sem este vínculo a assinatura prova apenas que alguém desenhou num
        vidro — não o que a pessoa estava aceitando. Com ele, qualquer mudança
        posterior no atendimento torna a assinatura OBSOLETA, e a conclusão
        recusa até ela ser recolhida de novo (§37).

        Calculado DEPOIS do claim: o claim não altera conteúdo nenhum, e ficar
        depois dele garante que ninguém escreveu um filho entre o hash e a
        gravação — o lock de linha da OS já é nosso.
      */
      const signedContentHash = await closingContentHash(tx, companyId, orderId);
      const signedOrderVersion = order.version + 1;

      await storage.put(storageKey, input.data, sniffed);
      wrote = true;

      if (existing) {
        return tx.serviceOrderSignature.update({
          where: { id: existing.id },
          data: {
            signerName: signerName.slice(0, SIGNER_NAME_MAX),
            storageKey,
            mimeType: sniffed,
            sizeBytes: input.data.byteLength,
            signedAt: new Date(),
            capturedByUserId: actorUserId,
            signedContentHash,
            signedOrderVersion,
          },
        });
      }
      const created = await tx.serviceOrderSignature.create({
        data: {
          companyId,
          serviceOrderId: orderId,
          signerName: signerName.slice(0, SIGNER_NAME_MAX),
          storageKey,
          mimeType: sniffed,
          sizeBytes: input.data.byteLength,
          capturedByUserId: actorUserId,
          signedContentHash,
          signedOrderVersion,
        },
      });

      /*
        Marco da timeline, e só na PRIMEIRA coleta.

        "O cliente assinou" é o fato operacional; redesenhar por causa de um
        traço torto não é, e um evento por redesenho encheria a linha do tempo
        de ruído. A substituição continua auditada no `AuditLog`.
      */
      await tx.serviceOrderEvent.create({
        data: {
          companyId,
          serviceOrderId: orderId,
          userId: actorUserId,
          event: "SIGNATURE_CAPTURED",
          // Nome de quem assinou, nunca a imagem nem o hash do conteúdo.
          metadata: { signerName: created.signerName },
        },
      });

      return created;
    });

    if (previousKey && previousKey !== storageKey) {
      await storage.delete(previousKey).catch(() => undefined);
    }

    await logAudit({
      companyId,
      userId: actorUserId,
      action: "SERVICE_ORDER.SIGNATURE_CAPTURED",
      entity: "ServiceOrderSignature",
      entityId: saved.id,
      // Name only — never the image bytes.
      details: `Assinatura capturada (${saved.signerName})`,
    });

    return toPublicSignature(saved);
  } catch (error) {
    if (wrote) {
      await storage.delete(storageKey).catch(() => undefined);
    }
    throw error;
  }
}

export async function loadSignatureForDownload(
  companyId: string,
  orderId: string,
  requester: { isStaff: boolean; technicianId: string | null },
): Promise<{ data: Buffer; mimeType: string }> {
  const signature = await prisma.serviceOrderSignature.findFirst({
    where: { serviceOrderId: orderId, companyId },
    include: { serviceOrder: { select: { technicianId: true } } },
  });
  if (!signature) {
    throw notFound("Assinatura não encontrada.");
  }
  if (!requester.isStaff) {
    if (
      !requester.technicianId ||
      signature.serviceOrder.technicianId !== requester.technicianId
    ) {
      throw notFound("Assinatura não encontrada.");
    }
  }
  const data = await getFileStorage()
    .get(signature.storageKey)
    .catch(() => {
      throw notFound("Arquivo não encontrado.");
    });
  return { data, mimeType: signature.mimeType };
}

function toPublicSignature(s: {
  id: string;
  signerName: string;
  mimeType: string;
  sizeBytes: number;
  signedAt: Date;
}): PublicSignature {
  return {
    id: s.id,
    signerName: s.signerName,
    mimeType: s.mimeType,
    sizeBytes: s.sizeBytes,
    signedAt: s.signedAt,
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Everything the closing UI needs, in one tenant-scoped round of queries.
 *
 * Each query filters by `companyId` in SQL rather than reaching the children
 * through the order relation, so a mismatched tenant returns nothing instead
 * of relying on FK navigation being correct.
 */
export async function getServiceOrderClosingBundle(
  companyId: string,
  orderId: string,
): Promise<ServiceOrderClosingBundle> {
  const [evidences, materials, signature] = await Promise.all([
    prisma.serviceOrderEvidence.findMany({
      where: { serviceOrderId: orderId, companyId },
      orderBy: { createdAt: "asc" },
    }),
    prisma.serviceOrderMaterialUsage.findMany({
      where: { serviceOrderId: orderId, companyId },
      orderBy: { createdAt: "asc" },
    }),
    prisma.serviceOrderSignature.findFirst({
      where: { serviceOrderId: orderId, companyId },
    }),
  ]);

  return {
    evidences: evidences.map(toPublicEvidence),
    materials: materials.map(toPublicMaterial),
    signature: signature ? toPublicSignature(signature) : null,
  };
}

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

export interface CompleteServiceOrderInput {
  expectedOrderVersion: number;
  expectedExecutionVersion: number;
}

/**
 * IN_PROGRESS -> COMPLETED, performed by the owning technician.
 *
 * TWO compare-and-sets, in this order, inside one transaction:
 *
 *  1. the EXECUTION on `expectedExecutionVersion` — this is what makes
 *     `complete × save execution` deterministic. Without it, a technician on a
 *     second tab could save new text a millisecond before the close and the
 *     order would be sealed around content the closer never reviewed.
 *  2. the ORDER on `expectedOrderVersion` AND `status = IN_PROGRESS` — this
 *     arbitrates `complete × complete` and `complete × child mutation`, since
 *     every child write bumps the same version through
 *     `claimOrderForChildMutation`.
 *
 * Either predicate matching zero rows aborts the whole transaction with 409,
 * so a stale closer never seals a stale order.
 *
 * `diagnosis` and `workPerformed` are required here and only here: they are
 * the report. Photos, materials and signature are deliberately NOT required —
 * which evidence a given order needs is a per-type checklist policy that does
 * not exist yet, and hard-coding "always required" now would block legitimate
 * closings.
 */
export async function completeServiceOrder(
  companyId: string,
  actorUserId: string,
  orderId: string,
  input: CompleteServiceOrderInput,
): Promise<void> {
  const completed = await prisma.$transaction(async (tx) => {
    const technician = await resolveActingTechnician(
      tx,
      companyId,
      actorUserId,
    );
    const order = await loadOwnedServiceOrder(
      tx,
      companyId,
      technician.id,
      orderId,
    );

    if (order.status !== "IN_PROGRESS") {
      throw conflict(
        order.status === "COMPLETED"
          ? "Esta OS já foi concluída."
          : `Não é possível concluir uma OS no estado ${order.status}.`,
      );
    }

    const execution = await tx.serviceOrderExecution.findFirst({
      where: { serviceOrderId: order.id, companyId },
    });
    if (!execution) {
      throw conflict("Execução não encontrada para esta OS.");
    }

    /*
      A validação roda DENTRO da transação, sobre os mesmos dados que serão
      selados. Fora dela existiria uma janela entre "está tudo certo" e
      "fechou", e é justamente nessa janela que uma mutação-filha concorrente
      acontece.

      Devolve a lista COMPLETA de pendências, não a primeira: um técnico que
      descobre o que falta uma por uma faz uma ida ao servidor por item, e em
      rede de borda desiste no meio (PRD §166).
    */
    const pendencies = await validateServiceOrderCompletion(tx, {
      companyId,
      orderId: order.id,
      serviceOrderTypeId: order.typeId,
    });
    if (pendencies.length > 0) {
      throw new CompletionBlockedError(pendencies);
    }

    const executionClaim = await tx.serviceOrderExecution.updateMany({
      where: { id: execution.id, version: input.expectedExecutionVersion },
      data: { version: { increment: 1 } },
    });
    if (executionClaim.count !== 1) {
      throw conflict(
        "A execução foi modificada por outra requisição. Recarregue e tente novamente.",
      );
    }

    const completedAt = new Date();
    const orderClaim = await tx.serviceOrder.updateMany({
      where: {
        id: order.id,
        companyId,
        status: "IN_PROGRESS",
        version: input.expectedOrderVersion,
      },
      data: {
        status: "COMPLETED",
        completedAt,
        version: { increment: 1 },
      },
    });
    if (orderClaim.count !== 1) {
      throw conflict(
        "A OS foi modificada por outra requisição. Recarregue e tente novamente.",
      );
    }

    const [evidenceCount, materialCount, signature] = await Promise.all([
      tx.serviceOrderEvidence.count({
        where: { serviceOrderId: order.id, companyId },
      }),
      tx.serviceOrderMaterialUsage.count({
        where: { serviceOrderId: order.id, companyId },
      }),
      tx.serviceOrderSignature.findFirst({
        where: { serviceOrderId: order.id, companyId },
        select: { id: true },
      }),
    ]);

    /*
      O fechamento congelado, na MESMA transação que leva a OS a COMPLETED.

      É o que permite responder "o que foi fechado" sem reconstituir o passado
      a partir das tabelas vivas — cuja resposta mudaria a cada correção
      posterior autorizada. `contentHash` é o mesmo algoritmo que a assinatura
      usa, e é a comparação entre os dois que prova que o cliente assinou ISTO.

      Não é o PDF: o PDF, quando existir, é uma renderização disto. A conclusão
      nunca fica bloqueada esperando pipeline de documento.
    */
    await tx.serviceOrderCompletion.create({
      data: {
        companyId,
        serviceOrderId: order.id,
        technicianId: technician.id,
        completedAt,
        orderVersionAtCompletion: order.version + 1,
        contentHash: await closingContentHash(tx, companyId, order.id),
        snapshot: (await buildCompletionSnapshot(
          tx,
          companyId,
          order.id,
        )) as unknown as Prisma.InputJsonValue,
      },
    });

    await tx.serviceOrderEvent.create({
      data: {
        companyId,
        serviceOrderId: order.id,
        userId: actorUserId,
        event: "OS_COMPLETED",
        // Counts and flags, never content: the timeline says what was closed,
        // the records themselves say what is in it.
        metadata: {
          technicianId: technician.id,
          technicianName: technician.user.name,
          completedAt: completedAt.toISOString(),
          startedAt: order.startedAt?.toISOString() ?? null,
          evidenceCount,
          materialCount,
          hasSignature: signature !== null,
        },
      },
    });

    return { technicianName: technician.user.name };
  });

  await logAudit({
    companyId,
    userId: actorUserId,
    action: "SERVICE_ORDER.COMPLETED",
    entity: "ServiceOrder",
    entityId: orderId,
    details: `Atendimento concluído pelo técnico ${completed.technicianName}`,
  });
}
