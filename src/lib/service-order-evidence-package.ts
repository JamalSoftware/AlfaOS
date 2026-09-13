import {
  AccessProfile,
  Prisma,
  type ChecklistItemType,
  type EvidenceCategory,
  type LocationChangeReason,
  type MaterialUnit,
} from "@prisma/client";
import { prisma } from "./prisma";
import { resolveTimezone } from "./workday";
import { formatarEndereco } from "./map-links";
import { COMMITTED_EVIDENCE } from "./service-order-closing";
import { closingContentHash } from "./service-order-completion";
import { getTechnicianByUserId } from "./service-orders";
import { classificarLocalizacao } from "./customer-timeline";

/**
 * # Pacote técnico de evidências — EV-1 (PRD §383, MASTER-PLAN §6)
 *
 * O que comprova tecnicamente o atendimento de UMA OS concluída, reunido num
 * lugar só. **Leitura derivada:** nenhuma tabela nova, nada escrito — cada item
 * vem da tabela que já é a autoridade dele, e só no estado que vale como prova.
 *
 * ```text
 * horário        ServiceOrder (início, conclusão) · ServiceOrderCheckIn
 * localização    ServiceOrderCheckIn (GPS sim/não, distância, precisão) e a
 *                confirmação/correção do ponto FEITA NESTA OS — sem coordenada
 * fotos          ServiceOrderEvidence COMMITTED — temporária não prova nada
 * medições       as mesmas evidências, SPEED_TEST e OPTICAL_READING: são FOTOS,
 *                e nenhum valor medido é inventado
 * equipamentos   ServiceOrderEquipment + a foto da etiqueta que o identifica
 * materiais      ServiceOrderMaterialUsage (decisão do dono: está no conteúdo
 *                que o cliente assinou)
 * observações    ServiceOrderExecution — diagnóstico, serviço, observações
 * checklist      o snapshot respondido na execução
 * assinatura     ServiceOrderSignature
 * ```
 *
 * ## Só a OS concluída
 *
 * "Ao concluir uma OS" (§383), "na OS concluída" (MASTER-PLAN §6). Antes disso
 * o conteúdo ainda muda, e chamá-lo de pacote seria afirmar uma prova que não
 * existe — quem pede recebe `not-completed`, sem nenhum item.
 *
 * ## Conferência, e não promessa
 *
 * O fechamento grava `ServiceOrderCompletion.contentHash` com o mesmo algoritmo
 * que amarra a assinatura (`closingContentHash`). O pacote RECALCULA o hash e
 * compara: é assim que ele afirma que representa o estado fechado, em vez de
 * prometer um instantâneo imutável que a arquitetura não guarda. A assinatura é
 * conferida contra o hash do fechamento pelo mesmo caminho.
 *
 * Não existe selo de "completo": a política do tipo de OS é editável e não é
 * guardada no fechamento, então reaplicá-la hoje a uma OS antiga responderia
 * a pergunta errada (e os alertas de inconsistência são §387, SHOULD HAVE).
 *
 * ## Uma conexão, um instante
 *
 * Tudo é lido numa transação interativa `RepeatableRead`: uma conexão só (a
 * lição da `TL-1`) e todas as fontes vistas no mesmo instante.
 */

export interface EvidencePackageViewer {
  companyId: string;
  userId: string;
  profile: AccessProfile;
}

/** A OS, o bastante para cabeçalho e navegação. */
export interface EvidencePackageOrder {
  id: string;
  number: number;
  type: string;
  subtype: string | null;
  status: string;
  startedAt: Date | null;
  completedAt: Date | null;
}

/** Uma foto: nunca a chave de armazenamento, só a rota autorizada. */
export interface EvidencePackagePhoto {
  id: string;
  category: EvidenceCategory;
  caption: string | null;
  /** Instante do SERVIDOR — é ele que vale para integridade (SECURITY §8.16). */
  recordedAt: Date;
  uploadedByName: string | null;
  url: string;
}

export type ChecklistAnswerView =
  | { kind: "boolean"; value: boolean }
  | { kind: "text"; value: string }
  | { kind: "number"; value: string }
  | { kind: "photo"; category: EvidenceCategory | null; attached: boolean }
  | { kind: "unanswered" };

export type LocationChangeKind = ReturnType<typeof classificarLocalizacao>;

export type PackageIntegrity = "VERIFIED" | "DIVERGENT" | "NO_RECORD";
export type SignatureBinding = "BOUND" | "DIVERGENT" | "LEGACY" | "NONE";

export interface ServiceOrderEvidencePackage {
  order: EvidencePackageOrder;
  customer: { name: string; address: string | null };
  technicianName: string | null;
  timezone: string;
  integrity: PackageIntegrity;
  signatureBinding: SignatureBinding;
  checkIn: {
    checkedInAt: Date;
    withDeviceLocation: boolean;
    distanceMeters: number | null;
    accuracyMeters: number | null;
    technicianName: string | null;
  } | null;
  locationChanges: {
    id: string;
    kind: LocationChangeKind;
    reason: LocationChangeReason;
    occurredAt: Date;
    actorName: string | null;
  }[];
  execution: {
    diagnosis: string | null;
    workPerformed: string | null;
    notes: string | null;
  } | null;
  checklist: {
    id: string;
    label: string;
    type: ChecklistItemType;
    required: boolean;
    answer: ChecklistAnswerView;
  }[];
  photos: EvidencePackagePhoto[];
  measurements: {
    speedTests: EvidencePackagePhoto[];
    opticalReadings: EvidencePackagePhoto[];
  };
  equipments: {
    id: string;
    equipmentType: string;
    manufacturer: string | null;
    model: string | null;
    serial: string | null;
    macAddress: string | null;
    installedAt: Date;
    installedByName: string | null;
    label: EvidencePackagePhoto | null;
  }[];
  materials: {
    id: string;
    description: string;
    quantity: string;
    unit: MaterialUnit;
  }[];
  signature: {
    signerName: string;
    signedAt: Date;
    capturedByName: string | null;
    url: string;
  } | null;
}

export type EvidencePackageRead =
  | { state: "ok"; data: ServiceOrderEvidencePackage }
  | { state: "not-completed"; order: EvidencePackageOrder }
  | { state: "not-found" };

export type EvidencePackageSection = EvidencePackageRead | { state: "error" };

/** Tetos defensivos: a escrita já limita (10 fotos por OS), a leitura não confia. */
const MAX_PHOTOS = 100;
const MAX_ROWS = 200;

const MEASUREMENTS = new Set<EvidenceCategory>(["SPEED_TEST", "OPTICAL_READING"]);

export function evidencePhotoUrl(orderId: string, evidenceId: string): string {
  return `/api/service-orders/${encodeURIComponent(orderId)}/evidence/${encodeURIComponent(evidenceId)}/content`;
}

export function signatureImageUrl(orderId: string): string {
  return `/api/service-orders/${encodeURIComponent(orderId)}/signature`;
}

/**
 * O pacote de UMA OS de UMA empresa, para quem já pode ver aquela OS.
 *
 * Mesmo portão da tela da OS: empresa da sessão no predicado, e o técnico só a
 * própria OS — outra devolve `not-found`, nunca "sem permissão", para que um id
 * sondado não confirme que a OS existe.
 */
export async function getServiceOrderEvidencePackage(
  viewer: EvidencePackageViewer,
  orderId: string,
): Promise<EvidencePackageRead> {
  const { companyId } = viewer;

  let technicianId: string | null = null;
  if (viewer.profile === AccessProfile.TECHNICIAN) {
    const technician = await getTechnicianByUserId(companyId, viewer.userId);
    if (!technician) return { state: "not-found" };
    technicianId = technician.id;
  } else if (
    viewer.profile !== AccessProfile.ADMIN &&
    viewer.profile !== AccessProfile.DISPATCHER
  ) {
    return { state: "not-found" };
  }

  return prisma.$transaction(
    async (tx) => {
      const order = await tx.serviceOrder.findFirst({
        where: { id: orderId, companyId },
        select: {
          id: true,
          number: true,
          type: true,
          subtype: true,
          status: true,
          startedAt: true,
          completedAt: true,
          technicianId: true,
          customerId: true,
          technician: { select: { user: { select: { name: true } } } },
          customer: {
            select: {
              name: true,
              address: true,
              number: true,
              complement: true,
              district: true,
              city: true,
              state: true,
              zipCode: true,
            },
          },
          company: { select: { timezone: true } },
        },
      });
      if (!order) return { state: "not-found" };
      if (technicianId !== null && order.technicianId !== technicianId) {
        return { state: "not-found" };
      }

      const ref: EvidencePackageOrder = {
        id: order.id,
        number: order.number,
        type: order.type,
        subtype: order.subtype,
        status: order.status,
        startedAt: order.startedAt,
        completedAt: order.completedAt,
      };
      if (order.status !== "COMPLETED") {
        return { state: "not-completed", order: ref };
      }

      const daOs = { companyId, serviceOrderId: order.id };

      const completion = await tx.serviceOrderCompletion.findFirst({
        where: daOs,
        select: {
          contentHash: true,
          technician: { select: { user: { select: { name: true } } } },
        },
      });
      const execution = await tx.serviceOrderExecution.findFirst({
        where: daOs,
        select: { diagnosis: true, workPerformed: true, notes: true },
      });
      const checkIn = await tx.serviceOrderCheckIn.findFirst({
        where: daOs,
        select: {
          checkedInAt: true,
          source: true,
          distanceMeters: true,
          accuracyMeters: true,
          technician: { select: { user: { select: { name: true } } } },
        },
      });
      const evidences = await tx.serviceOrderEvidence.findMany({
        where: { ...daOs, ...COMMITTED_EVIDENCE },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: MAX_PHOTOS,
        select: {
          id: true,
          category: true,
          caption: true,
          createdAt: true,
          uploadedBy: { select: { name: true } },
        },
      });
      const signature = await tx.serviceOrderSignature.findFirst({
        where: daOs,
        select: {
          signerName: true,
          signedAt: true,
          signedContentHash: true,
          capturedBy: { select: { name: true } },
        },
      });
      const equipments = await tx.serviceOrderEquipment.findMany({
        where: daOs,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: MAX_ROWS,
        select: {
          id: true,
          equipmentType: true,
          manufacturer: true,
          model: true,
          serial: true,
          macAddress: true,
          labelEvidenceId: true,
          createdAt: true,
          installedBy: { select: { name: true } },
        },
      });
      const materials = await tx.serviceOrderMaterialUsage.findMany({
        where: daOs,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: MAX_ROWS,
        select: { id: true, description: true, quantity: true, unit: true },
      });
      const checklist = await tx.serviceOrderChecklistItem.findMany({
        where: daOs,
        orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
        take: MAX_ROWS,
        select: {
          id: true,
          label: true,
          type: true,
          required: true,
          evidenceCategory: true,
          valueBoolean: true,
          valueText: true,
          valueNumber: true,
          answeredAt: true,
        },
      });
      // Só a mudança de ponto feita NESTA OS — e do cliente dela.
      const locationRows = await tx.customerLocationHistory.findMany({
        where: { ...daOs, customerId: order.customerId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: MAX_ROWS,
        select: {
          id: true,
          createdAt: true,
          kind: true,
          reason: true,
          previousLatitude: true,
          previousLongitude: true,
          previousSource: true,
          previousVerified: true,
          newLatitude: true,
          newLongitude: true,
          newSource: true,
          newVerified: true,
          changedBy: { select: { name: true } },
          technician: { select: { user: { select: { name: true } } } },
        },
      });

      const currentHash = await closingContentHash(tx, companyId, order.id);
      const integrity: PackageIntegrity = !completion
        ? "NO_RECORD"
        : completion.contentHash === currentHash
          ? "VERIFIED"
          : "DIVERGENT";
      const referenceHash = completion?.contentHash ?? currentHash;
      const signatureBinding: SignatureBinding = !signature
        ? "NONE"
        : !signature.signedContentHash
          ? "LEGACY"
          : signature.signedContentHash === referenceHash
            ? "BOUND"
            : "DIVERGENT";

      const photoOf = (e: (typeof evidences)[number]): EvidencePackagePhoto => ({
        id: e.id,
        category: e.category,
        caption: e.caption,
        recordedAt: e.createdAt,
        uploadedByName: e.uploadedBy?.name ?? null,
        url: evidencePhotoUrl(order.id, e.id),
      });
      const byId = new Map(evidences.map((e) => [e.id, e]));
      // A etiqueta aparece UMA vez, junto do equipamento que ela identifica.
      const labelIds = new Set(
        equipments.map((q) => q.labelEvidenceId).filter((id): id is string => Boolean(id)),
      );
      const presentCategories = new Set(evidences.map((e) => e.category));

      return {
        state: "ok",
        data: {
          order: ref,
          customer: {
            name: order.customer.name,
            address: formatarEndereco(order.customer),
          },
          technicianName:
            completion?.technician.user.name ?? order.technician?.user.name ?? null,
          timezone: resolveTimezone(order.company.timezone),
          integrity,
          signatureBinding,
          checkIn: checkIn
            ? {
                checkedInAt: checkIn.checkedInAt,
                withDeviceLocation: checkIn.source === "DEVICE_GPS",
                distanceMeters: checkIn.distanceMeters,
                accuracyMeters: checkIn.accuracyMeters,
                technicianName: checkIn.technician.user.name,
              }
            : null,
          locationChanges: locationRows.map((l) => ({
            id: l.id,
            kind: classificarLocalizacao(l),
            reason: l.reason,
            occurredAt: l.createdAt,
            actorName: l.changedBy?.name ?? l.technician?.user.name ?? null,
          })),
          execution: execution
            ? {
                diagnosis: execution.diagnosis,
                workPerformed: execution.workPerformed,
                notes: execution.notes,
              }
            : null,
          checklist: checklist.map((item) => ({
            id: item.id,
            label: item.label,
            type: item.type,
            required: item.required,
            answer: checklistAnswer(item, presentCategories),
          })),
          photos: evidences
            .filter((e) => !MEASUREMENTS.has(e.category) && !labelIds.has(e.id))
            .map(photoOf),
          measurements: {
            speedTests: evidences.filter((e) => e.category === "SPEED_TEST").map(photoOf),
            opticalReadings: evidences
              .filter((e) => e.category === "OPTICAL_READING")
              .map(photoOf),
          },
          equipments: equipments.map((q) => {
            const label = q.labelEvidenceId ? byId.get(q.labelEvidenceId) : undefined;
            return {
              id: q.id,
              equipmentType: q.equipmentType,
              manufacturer: q.manufacturer,
              model: q.model,
              serial: q.serial,
              macAddress: q.macAddress,
              installedAt: q.createdAt,
              installedByName: q.installedBy?.name ?? null,
              label: label ? photoOf(label) : null,
            };
          }),
          materials: materials.map((m) => ({
            id: m.id,
            description: m.description,
            quantity: m.quantity.toString(),
            unit: m.unit,
          })),
          signature: signature
            ? {
                signerName: signature.signerName,
                signedAt: signature.signedAt,
                capturedByName: signature.capturedBy?.name ?? null,
                url: signatureImageUrl(order.id),
              }
            : null,
        },
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

/**
 * A resposta do checklist como foi gravada. Item de foto é satisfeito por uma
 * evidência CONFIRMADA na categoria dele — a mesma regra de
 * `pendingChecklistItems`, que decidiu a conclusão.
 */
function checklistAnswer(
  item: {
    type: ChecklistItemType;
    evidenceCategory: EvidenceCategory | null;
    valueBoolean: boolean | null;
    valueText: string | null;
    valueNumber: Prisma.Decimal | null;
    answeredAt: Date | null;
  },
  presentCategories: Set<EvidenceCategory>,
): ChecklistAnswerView {
  if (item.type === "PHOTO") {
    return {
      kind: "photo",
      category: item.evidenceCategory,
      attached: item.evidenceCategory !== null && presentCategories.has(item.evidenceCategory),
    };
  }
  if (item.answeredAt === null) return { kind: "unanswered" };
  if (item.type === "BOOLEAN" && item.valueBoolean !== null) {
    return { kind: "boolean", value: item.valueBoolean };
  }
  if (item.type === "NUMBER" && item.valueNumber !== null) {
    return { kind: "number", value: item.valueNumber.toString() };
  }
  if ((item.type === "TEXT" || item.type === "SELECT") && item.valueText?.trim()) {
    return { kind: "text", value: item.valueText };
  }
  return { kind: "unanswered" };
}

/**
 * O pacote para a tela: falha vira `error`, NUNCA um pacote vazio — "sem
 * evidência" dito porque uma consulta caiu seria o contrário da verdade.
 */
export async function loadServiceOrderEvidencePackage(
  viewer: EvidencePackageViewer,
  orderId: string,
): Promise<EvidencePackageSection> {
  try {
    return await getServiceOrderEvidencePackage(viewer, orderId);
  } catch (error) {
    // Só o tipo do erro: mensagem de banco pode trazer fragmento de consulta.
    console.error("[evidence-package] falhou", {
      companyId: viewer.companyId,
      erro: error instanceof Error ? error.name : "desconhecido",
    });
    return { state: "error" };
  }
}
