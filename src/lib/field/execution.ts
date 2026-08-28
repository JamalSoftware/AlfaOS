import { prisma } from "@/lib/prisma";
import { getCustomerLocationView, type LocationStatus } from "@/lib/customer-locations";
import { getOrderChecklist, type PublicChecklistItem } from "@/lib/checklists";
import {
  validateServiceOrderCompletion,
  type CompletionPendency,
} from "@/lib/service-order-completion";
import { FieldError } from "./errors";

/**
 * # O pacote de execução
 *
 * Uma leitura só para a tela de EXECUÇÃO do aplicativo. Nove seções —
 * localização, check-in, checklist, fotos, materiais, equipamentos,
 * observações, assinatura e conclusão — pedidas em nove requisições seriam nove
 * oportunidades de falhar em rede de borda, e o técnico veria a tela montar aos
 * pedaços.
 *
 * ## O que NÃO entra
 *
 * As mesmas exclusões do resto do Field (`dto.ts`): sem CPF, sem senha, sem
 * `externalProvider`, sem interno de auditoria. A ausência do dado de provider
 * é o que impede um `if (RECEITANET)` no aplicativo — uma OS importada tem de
 * se comportar exatamente como uma interna depois de atribuída.
 *
 * ## As pendências vêm junto
 *
 * A tela precisa saber o que falta ANTES de o técnico apertar concluir, para
 * mostrar progresso e desabilitar o botão. Isso é conveniência: quem decide se
 * a OS fecha continua sendo `completeServiceOrder`, que revalida dentro da
 * própria transação. Uma lista lida aqui já pode estar velha quando o comando
 * chegar — e é exatamente por isso que a validação não pode morar só aqui.
 */

export interface FieldExecutionBundle {
  orderId: string;
  version: number;
  executionVersion: number | null;
  /**
   * O relatório do atendimento.
   *
   * Vem no pacote porque a tela precisa MOSTRAR o que já foi escrito antes de
   * deixar editar — sem isso o técnico reabriria a OS e veria os campos vazios,
   * e sobrescreveria o próprio texto achando que nunca salvou.
   *
   * `diagnosis` e `workPerformed` são os dois únicos requisitos de conclusão
   * que valem para toda OS, com ou sem política.
   */
  report: {
    diagnosis: string | null;
    workPerformed: string | null;
    notes: string | null;
  };
  location: {
    status: LocationStatus;
    latitude: number | null;
    longitude: number | null;
    accuracyMeters: number | null;
    source: string | null;
    verified: boolean;
    reference: string | null;
    /** Token do compare-and-set da LOCALIZAÇÃO. `null` quando não existe. */
    version: number | null;
  };
  checkIn: {
    id: string;
    checkedInAt: string;
    distanceMeters: number | null;
    hasCoordinate: boolean;
  } | null;
  checklist: PublicChecklistItem[];
  evidences: {
    id: string;
    category: string;
    caption: string | null;
    createdAt: string;
  }[];
  materials: {
    id: string;
    description: string;
    quantity: string;
    unit: string;
    fromInventory: boolean;
  }[];
  equipments: {
    id: string;
    equipmentType: string;
    manufacturer: string | null;
    model: string | null;
    serial: string | null;
    macAddress: string | null;
    /** Foto da etiqueta que identifica este equipamento (v0.10.1). */
    labelEvidenceId: string | null;
  }[];
  signature: {
    id: string;
    signerName: string;
    signedAt: string;
    /** A assinatura ainda corresponde ao que está na tela? */
    stale: boolean;
  } | null;
  contactAttempts: {
    id: string;
    channel: string;
    result: string;
    attemptedAt: string;
  }[];
  impediments: { id: string; reason: string; reportedAt: string }[];
  /** O que o tipo da OS exige. Ausência de política = nenhuma exigência extra. */
  requirements: {
    requireChecklist: boolean;
    requireSignature: boolean;
    requireMaterials: boolean;
    requireEquipment: boolean;
    requireCheckIn: boolean;
    minEvidenceCount: number;
    requiredEvidenceCategories: string[];
  };
  /** O que falta agora. Orientação para a tela; a autoridade é a conclusão. */
  pendencies: CompletionPendency[];
}

export async function getFieldExecutionBundle(
  companyId: string,
  technicianId: string,
  orderId: string,
): Promise<FieldExecutionBundle> {
  /*
    Posse provada na PRÓPRIA consulta: `technicianId` entra no `where`, então
    uma OS de colega devolve 404 e não 403 — 403 confirmaria que o id existe,
    que é o fato que um técnico sondando ids não pode aprender.
  */
  const order = await prisma.serviceOrder.findFirst({
    where: { id: orderId, companyId, technicianId },
    select: {
      id: true,
      version: true,
      customerId: true,
      typeId: true,
      execution: {
        select: {
          version: true,
          diagnosis: true,
          workPerformed: true,
          notes: true,
        },
      },
    },
  });
  if (!order) {
    throw new FieldError("NOT_FOUND", "Ordem de serviço não encontrada.");
  }

  const [
    locationView,
    checkIn,
    checklist,
    evidences,
    materials,
    equipments,
    signature,
    contactAttempts,
    impediments,
    policy,
  ] = await Promise.all([
    getCustomerLocationView(companyId, order.customerId),
    prisma.serviceOrderCheckIn.findFirst({
      where: { serviceOrderId: order.id, companyId },
    }),
    getOrderChecklist(companyId, order.id),
    prisma.serviceOrderEvidence.findMany({
      where: { serviceOrderId: order.id, companyId },
      select: { id: true, category: true, caption: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.serviceOrderMaterialUsage.findMany({
      where: { serviceOrderId: order.id, companyId },
      orderBy: { createdAt: "asc" },
    }),
    prisma.serviceOrderEquipment.findMany({
      where: { serviceOrderId: order.id, companyId },
      orderBy: { createdAt: "asc" },
    }),
    prisma.serviceOrderSignature.findFirst({
      where: { serviceOrderId: order.id, companyId },
    }),
    prisma.serviceOrderContactAttempt.findMany({
      where: { serviceOrderId: order.id, companyId },
      orderBy: { attemptedAt: "asc" },
    }),
    prisma.serviceOrderImpediment.findMany({
      where: { serviceOrderId: order.id, companyId },
      orderBy: { reportedAt: "asc" },
    }),
    order.typeId
      ? prisma.serviceOrderCompletionPolicy.findFirst({
          where: { serviceOrderTypeId: order.typeId, companyId },
        })
      : null,
  ]);

  const pendencies = await validateServiceOrderCompletion(prisma, {
    companyId,
    orderId: order.id,
    serviceOrderTypeId: order.typeId,
  });

  return {
    orderId: order.id,
    version: order.version,
    executionVersion: order.execution?.version ?? null,
    report: {
      diagnosis: order.execution?.diagnosis ?? null,
      workPerformed: order.execution?.workPerformed ?? null,
      notes: order.execution?.notes ?? null,
    },
    location: {
      status: locationView.status,
      latitude: locationView.location?.latitude ?? null,
      longitude: locationView.location?.longitude ?? null,
      accuracyMeters: locationView.location?.accuracyMeters ?? null,
      source: locationView.location?.source ?? null,
      verified: locationView.location?.verified ?? false,
      reference: locationView.location?.reference ?? null,
      version: locationView.location?.version ?? null,
    },
    checkIn: checkIn
      ? {
          id: checkIn.id,
          checkedInAt: checkIn.checkedInAt.toISOString(),
          distanceMeters: checkIn.distanceMeters,
          hasCoordinate: checkIn.source === "DEVICE_GPS",
        }
      : null,
    checklist,
    evidences: evidences.map((e) => ({
      id: e.id,
      category: e.category,
      caption: e.caption,
      createdAt: e.createdAt.toISOString(),
    })),
    materials: materials.map((m) => ({
      id: m.id,
      description: m.description,
      quantity: m.quantity.toString(),
      unit: m.unit,
      fromInventory: m.inventoryItemId !== null,
    })),
    equipments: equipments.map((e) => ({
      id: e.id,
      equipmentType: e.equipmentType,
      manufacturer: e.manufacturer,
      model: e.model,
      serial: e.serial,
      macAddress: e.macAddress,
      labelEvidenceId: e.labelEvidenceId,
    })),
    signature: signature
      ? {
          id: signature.id,
          signerName: signature.signerName,
          signedAt: signature.signedAt.toISOString(),
          // Derivado da MESMA validação que a conclusão usa, e não de uma
          // segunda comparação escrita aqui — duas leituras da mesma regra
          // divergiriam.
          stale: pendencies.some((p) => p.code === "SIGNATURE_STALE"),
        }
      : null,
    contactAttempts: contactAttempts.map((c) => ({
      id: c.id,
      channel: c.channel,
      result: c.result,
      attemptedAt: c.attemptedAt.toISOString(),
    })),
    impediments: impediments.map((i) => ({
      id: i.id,
      reason: i.reason,
      reportedAt: i.reportedAt.toISOString(),
    })),
    requirements: {
      requireChecklist: policy?.requireChecklist ?? false,
      requireSignature: policy?.requireSignature ?? false,
      requireMaterials: policy?.requireMaterials ?? false,
      requireEquipment: policy?.requireEquipment ?? false,
      requireCheckIn: policy?.requireCheckIn ?? false,
      minEvidenceCount: policy?.minEvidenceCount ?? 0,
      requiredEvidenceCategories: policy?.requiredEvidenceCategories ?? [],
    },
    pendencies,
  };
}
