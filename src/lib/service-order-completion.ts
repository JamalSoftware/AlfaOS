import { createHash } from "node:crypto";
import type { EvidenceCategory } from "@prisma/client";
import { logAudit } from "./audit";
import { DomainError, notFound } from "./errors";
import { prisma } from "./prisma";
import { pendingChecklistItems } from "./checklists";
import type { ExecutionTx } from "./service-orders";

/**
 * # Motor de validação da conclusão
 *
 * > O Flutter não decide sozinho se a OS pode ser concluída (PRD §166).
 *
 * A validação no cliente é conveniência — ela evita uma ida ao servidor para
 * dizer o óbvio. Ela não é controle: um app modificado, uma versão antiga em
 * campo ou uma requisição montada à mão passam por cima dela. Este arquivo é a
 * autoridade.
 *
 * ## A resposta é uma lista, não uma frase
 *
 * Uma lista de códigos estáveis permite que o app leve o técnico direto ao item
 * que falta. Uma mensagem de texto o obriga a procurar — e quebra assim que
 * alguém corrigir uma vírgula, num APK que já está em campo.
 *
 * ## O que a política ausente significa
 *
 * `ServiceOrderCompletionPolicy` é opcional, e a ausência dela quer dizer "sem
 * exigência extra". É essa propriedade que mantém a v0.10 retrocompatível: toda
 * OS e todo tipo anteriores a esta versão continuam concluindo exatamente como
 * antes, porque nenhum deles tem política.
 */

// ---------------------------------------------------------------------------
// Pendências
// ---------------------------------------------------------------------------

/**
 * Códigos ESTÁVEIS de pendência. Fechados, versionados junto do contrato.
 *
 * O aplicativo decide o que fazer com cada um: levar à seção da foto, abrir o
 * checklist, chamar a assinatura. Renomear um destes é mudança de contrato.
 */
export const COMPLETION_PENDENCY_CODES = [
  "EXECUTION_DIAGNOSIS_REQUIRED",
  "EXECUTION_WORK_REQUIRED",
  "CHECKLIST_ITEM_PENDING",
  "EVIDENCE_COUNT_BELOW_MINIMUM",
  "EVIDENCE_CATEGORY_MISSING",
  "SIGNATURE_REQUIRED",
  "SIGNATURE_STALE",
  "MATERIALS_REQUIRED",
  "EQUIPMENT_REQUIRED",
  "CHECK_IN_REQUIRED",
] as const;

export type CompletionPendencyCode = (typeof COMPLETION_PENDENCY_CODES)[number];

export interface CompletionPendency {
  code: CompletionPendencyCode;
  /** Frase para exibir. O app NUNCA decide nada a partir dela. */
  message: string;
  /** Item de checklist ou evidência a que a pendência se refere. */
  itemId?: string;
  category?: EvidenceCategory;
}

/**
 * A conclusão foi recusada por pendências.
 *
 * `DomainError` com 400, para que o `runApi` da web continue traduzindo sem
 * saber desta classe. O que ela acrescenta é a LISTA — que o Field devolve
 * estruturada e a web renderiza como texto.
 */
export class CompletionBlockedError extends DomainError {
  readonly pendencies: CompletionPendency[];

  constructor(pendencies: CompletionPendency[]) {
    super(
      400,
      // A primeira pendência vira a mensagem humana. A web mostra uma frase; o
      // Field lê `pendencies` e ignora isto.
      pendencies[0]?.message ?? "Não é possível concluir esta OS.",
    );
    this.name = "CompletionBlockedError";
    this.pendencies = pendencies;
  }
}

// ---------------------------------------------------------------------------
// Política por tipo de OS
// ---------------------------------------------------------------------------

export interface CompletionPolicyInput {
  requireChecklist: boolean;
  requireSignature: boolean;
  requireMaterials: boolean;
  requireEquipment: boolean;
  requireCheckIn: boolean;
  minEvidenceCount: number;
  requiredEvidenceCategories: EvidenceCategory[];
}

/** Teto do mínimo de evidências: o teto de fotos por OS é 10. */
export const MAX_REQUIRED_EVIDENCE = 10;

/**
 * Define o que um tipo de OS exige para concluir.
 *
 * Substitui a política inteira em vez de aplicar um patch: uma política parcial
 * obrigaria a decidir o que um campo ausente significa — "não mude" ou "não
 * exige" — e as duas leituras produzem resultados opostos para quem esquecer um
 * campo. Substituindo, o que está gravado é sempre exatamente o que alguém
 * enviou.
 *
 * A política é do TIPO, e o tipo é da empresa: `serviceOrderTypeId` é validado
 * contra `companyId` antes de qualquer escrita, senão um ADMIN poderia
 * configurar a exigência de conclusão de outra empresa.
 */
export async function putCompletionPolicy(
  companyId: string,
  actorUserId: string,
  serviceOrderTypeId: string,
  input: CompletionPolicyInput,
): Promise<{ serviceOrderTypeId: string }> {
  const minEvidenceCount = Math.max(
    0,
    Math.min(MAX_REQUIRED_EVIDENCE, Math.trunc(input.minEvidenceCount)),
  );
  // Categorias repetidas exigiriam a mesma foto duas vezes e produziriam duas
  // pendências idênticas na tela do técnico.
  const categories = Array.from(new Set(input.requiredEvidenceCategories));

  const saved = await prisma.$transaction(async (tx) => {
    const type = await tx.serviceOrderType.findFirst({
      where: { id: serviceOrderTypeId, companyId },
      select: { id: true, name: true },
    });
    if (!type) {
      throw notFound("Tipo de OS não encontrado.");
    }

    const data = {
      requireChecklist: input.requireChecklist,
      requireSignature: input.requireSignature,
      requireMaterials: input.requireMaterials,
      requireEquipment: input.requireEquipment,
      requireCheckIn: input.requireCheckIn,
      minEvidenceCount,
      requiredEvidenceCategories: categories,
    };

    await tx.serviceOrderCompletionPolicy.upsert({
      where: { serviceOrderTypeId },
      create: { companyId, serviceOrderTypeId, ...data },
      update: data,
    });

    return type;
  });

  await logAudit({
    companyId,
    userId: actorUserId,
    action: "SERVICE_ORDER_TYPE.COMPLETION_POLICY_SAVED",
    entity: "ServiceOrderCompletionPolicy",
    entityId: serviceOrderTypeId,
    details: `Requisitos de conclusão de "${saved.name}" atualizados`,
  });

  return { serviceOrderTypeId };
}

// ---------------------------------------------------------------------------
// Hash do conteúdo fechado
// ---------------------------------------------------------------------------

/**
 * Resumo determinístico do que está sendo fechado.
 *
 * É o que amarra a assinatura ao conteúdo (§37). Sem ele, um técnico poderia
 * colher a assinatura e só depois acrescentar materiais, trocar o serviço
 * realizado ou anexar outra foto — e o fechamento sairia com o cliente
 * aparentemente concordando com algo que nunca viu.
 *
 * ## O que entra
 *
 * Execução (os textos do relatório), respostas do checklist, evidências,
 * materiais e equipamentos. Ou seja: tudo que o cliente vê antes de assinar.
 *
 * ## O que NÃO entra
 *
 * - a própria assinatura — ela é o que está sendo comparado;
 * - `updatedAt` e qualquer carimbo de tempo — mudariam o hash sem o conteúdo
 *   mudar, e toda assinatura ficaria obsoleta sozinha;
 * - bytes de arquivo — o `id` da evidência basta para dizer "estas fotos", e
 *   ler o binário aqui colocaria megabytes numa transação.
 *
 * ## Determinismo
 *
 * Toda lista é ordenada por `id` antes de entrar. Sem isso, a mesma OS
 * produziria hashes diferentes conforme a ordem que o Postgres devolvesse, e a
 * assinatura ficaria obsoleta ao acaso.
 */
export async function closingContentHash(
  tx: ExecutionTx,
  companyId: string,
  orderId: string,
): Promise<string> {
  const [execution, checklist, evidences, materials, equipments] =
    await Promise.all([
      tx.serviceOrderExecution.findFirst({
        where: { serviceOrderId: orderId, companyId },
        select: { diagnosis: true, workPerformed: true, notes: true },
      }),
      tx.serviceOrderChecklistItem.findMany({
        where: { serviceOrderId: orderId, companyId },
        select: {
          id: true,
          valueBoolean: true,
          valueText: true,
          valueNumber: true,
        },
        orderBy: { id: "asc" },
      }),
      tx.serviceOrderEvidence.findMany({
        where: { serviceOrderId: orderId, companyId },
        select: { id: true, category: true },
        orderBy: { id: "asc" },
      }),
      tx.serviceOrderMaterialUsage.findMany({
        where: { serviceOrderId: orderId, companyId },
        select: { id: true, description: true, quantity: true, unit: true },
        orderBy: { id: "asc" },
      }),
      tx.serviceOrderEquipment.findMany({
        where: { serviceOrderId: orderId, companyId },
        select: { id: true, equipmentType: true, serial: true, macAddress: true },
        orderBy: { id: "asc" },
      }),
    ]);

  const canonical = {
    execution: {
      diagnosis: execution?.diagnosis ?? null,
      workPerformed: execution?.workPerformed ?? null,
      notes: execution?.notes ?? null,
    },
    checklist: checklist.map((item) => ({
      id: item.id,
      b: item.valueBoolean,
      t: item.valueText,
      n: item.valueNumber?.toString() ?? null,
    })),
    evidences: evidences.map((e) => ({ id: e.id, c: e.category })),
    materials: materials.map((m) => ({
      id: m.id,
      d: m.description,
      q: m.quantity.toString(),
      u: m.unit,
    })),
    equipments: equipments.map((e) => ({
      id: e.id,
      t: e.equipmentType,
      s: e.serial,
      m: e.macAddress,
    })),
  };

  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

// ---------------------------------------------------------------------------
// Validação
// ---------------------------------------------------------------------------

export interface CompletionContext {
  companyId: string;
  orderId: string;
  serviceOrderTypeId: string | null;
}

/**
 * Tudo que impede esta OS de fechar, de uma vez.
 *
 * Devolve a lista COMPLETA em vez de parar na primeira: um técnico que descobre
 * as pendências uma por uma faz uma viagem de ida e volta ao servidor por item,
 * e em rede de borda desiste no meio.
 *
 * Roda dentro da transação da conclusão, sobre os mesmos dados que serão
 * selados — validar fora dela deixaria uma janela entre "está tudo certo" e
 * "fechou".
 */
export async function validateServiceOrderCompletion(
  tx: ExecutionTx,
  context: CompletionContext,
): Promise<CompletionPendency[]> {
  const { companyId, orderId } = context;
  const pendencies: CompletionPendency[] = [];

  // --- o relatório, exigido desde a v0.4 e independente de política --------
  const execution = await tx.serviceOrderExecution.findFirst({
    where: { serviceOrderId: orderId, companyId },
    select: { diagnosis: true, workPerformed: true },
  });
  if (!execution?.diagnosis?.trim()) {
    pendencies.push({
      code: "EXECUTION_DIAGNOSIS_REQUIRED",
      message: "Preencha o diagnóstico antes de concluir o atendimento.",
    });
  }
  if (!execution?.workPerformed?.trim()) {
    pendencies.push({
      code: "EXECUTION_WORK_REQUIRED",
      message: "Preencha o serviço realizado antes de concluir o atendimento.",
    });
  }

  const policy = context.serviceOrderTypeId
    ? await tx.serviceOrderCompletionPolicy.findFirst({
        where: { serviceOrderTypeId: context.serviceOrderTypeId, companyId },
      })
    : null;

  // --- assinatura obsoleta: vale MESMO SEM política -----------------------
  //
  // Se existe assinatura, ela tem de corresponder ao que está sendo fechado.
  // Uma empresa que não exige assinatura mas cujo técnico colheu uma não pode
  // fechar com ela desatualizada: o cliente assinou outra coisa.
  const signature = await tx.serviceOrderSignature.findFirst({
    where: { serviceOrderId: orderId, companyId },
    select: { id: true, signedContentHash: true },
  });
  if (signature?.signedContentHash) {
    const current = await closingContentHash(tx, companyId, orderId);
    if (current !== signature.signedContentHash) {
      pendencies.push({
        code: "SIGNATURE_STALE",
        message:
          "O atendimento mudou depois da assinatura. Recolha a assinatura novamente.",
      });
    }
  }
  // Assinatura da v0.4 tem `signedContentHash` nulo — é anterior à regra e não
  // há conteúdo com que compará-la. Exigir recoleta retroativa impediria de
  // fechar OS legítimas por uma regra que não existia quando foram assinadas.

  if (!policy) return pendencies;

  if (policy.requireChecklist) {
    const pending = await pendingChecklistItems(tx, companyId, orderId);
    for (const item of pending) {
      pendencies.push({
        code: "CHECKLIST_ITEM_PENDING",
        message:
          item.type === "PHOTO"
            ? `Falta a foto: ${item.label}.`
            : `Responda o item: ${item.label}.`,
        itemId: item.itemId,
        ...(item.evidenceCategory ? { category: item.evidenceCategory } : {}),
      });
    }
  }

  if (policy.minEvidenceCount > 0 || policy.requiredEvidenceCategories.length > 0) {
    const evidences = await tx.serviceOrderEvidence.findMany({
      where: { serviceOrderId: orderId, companyId },
      select: { category: true },
    });
    if (evidences.length < policy.minEvidenceCount) {
      pendencies.push({
        code: "EVIDENCE_COUNT_BELOW_MINIMUM",
        message: `Anexe ao menos ${policy.minEvidenceCount} foto(s); há ${evidences.length}.`,
      });
    }
    const present = new Set(evidences.map((e) => e.category));
    for (const category of policy.requiredEvidenceCategories) {
      if (!present.has(category)) {
        pendencies.push({
          code: "EVIDENCE_CATEGORY_MISSING",
          message: `Falta a foto da categoria ${category}.`,
          category,
        });
      }
    }
  }

  if (policy.requireSignature && !signature) {
    pendencies.push({
      code: "SIGNATURE_REQUIRED",
      message: "A assinatura do cliente é obrigatória para concluir.",
    });
  }

  if (policy.requireMaterials) {
    const count = await tx.serviceOrderMaterialUsage.count({
      where: { serviceOrderId: orderId, companyId },
    });
    if (count === 0) {
      pendencies.push({
        code: "MATERIALS_REQUIRED",
        message: "Registre os materiais utilizados antes de concluir.",
      });
    }
  }

  if (policy.requireEquipment) {
    const count = await tx.serviceOrderEquipment.count({
      where: { serviceOrderId: orderId, companyId },
    });
    if (count === 0) {
      pendencies.push({
        code: "EQUIPMENT_REQUIRED",
        message: "Registre o equipamento instalado antes de concluir.",
      });
    }
  }

  if (policy.requireCheckIn) {
    const checkIn = await tx.serviceOrderCheckIn.findFirst({
      where: { serviceOrderId: orderId, companyId },
      select: { id: true },
    });
    if (!checkIn) {
      pendencies.push({
        code: "CHECK_IN_REQUIRED",
        message: "Faça o check-in de chegada antes de concluir.",
      });
    }
  }

  return pendencies;
}

// ---------------------------------------------------------------------------
// Snapshot do fechamento
// ---------------------------------------------------------------------------

export interface CompletionSnapshot {
  evidences: { id: string; category: EvidenceCategory }[];
  checklist: {
    id: string;
    label: string;
    type: string;
    value: string | null;
  }[];
  materials: {
    id: string;
    description: string;
    quantity: string;
    unit: string;
    inventoryItemId: string | null;
  }[];
  equipments: {
    id: string;
    equipmentType: string;
    serial: string | null;
    macAddress: string | null;
  }[];
  signature: { id: string; signerName: string; signedAt: string } | null;
  checkIn: { id: string; checkedInAt: string; distanceMeters: number | null } | null;
  impedimentCount: number;
  contactAttemptCount: number;
}

/**
 * Congela o que existia no instante do fechamento.
 *
 * Sem isto, "o que o cliente assinou" só poderia ser respondido relendo
 * evidências e materiais como estão HOJE — e a resposta mudaria a cada correção
 * posterior autorizada.
 *
 * Guarda identificadores, rótulos e contagens. **Nenhum binário e nenhum
 * segredo**: a linha sobrevive em backup e em dump, e uma foto embutida aqui
 * duplicaria o armazenamento sem acrescentar prova.
 */
export async function buildCompletionSnapshot(
  tx: ExecutionTx,
  companyId: string,
  orderId: string,
): Promise<CompletionSnapshot> {
  const [
    evidences,
    checklist,
    materials,
    equipments,
    signature,
    checkIn,
    impedimentCount,
    contactAttemptCount,
  ] = await Promise.all([
    tx.serviceOrderEvidence.findMany({
      where: { serviceOrderId: orderId, companyId },
      select: { id: true, category: true },
      orderBy: { id: "asc" },
    }),
    tx.serviceOrderChecklistItem.findMany({
      where: { serviceOrderId: orderId, companyId },
      orderBy: { sortOrder: "asc" },
    }),
    tx.serviceOrderMaterialUsage.findMany({
      where: { serviceOrderId: orderId, companyId },
      orderBy: { id: "asc" },
    }),
    tx.serviceOrderEquipment.findMany({
      where: { serviceOrderId: orderId, companyId },
      orderBy: { id: "asc" },
    }),
    tx.serviceOrderSignature.findFirst({
      where: { serviceOrderId: orderId, companyId },
      select: { id: true, signerName: true, signedAt: true },
    }),
    tx.serviceOrderCheckIn.findFirst({
      where: { serviceOrderId: orderId, companyId },
      select: { id: true, checkedInAt: true, distanceMeters: true },
    }),
    tx.serviceOrderImpediment.count({
      where: { serviceOrderId: orderId, companyId },
    }),
    tx.serviceOrderContactAttempt.count({
      where: { serviceOrderId: orderId, companyId },
    }),
  ]);

  return {
    evidences: evidences.map((e) => ({ id: e.id, category: e.category })),
    checklist: checklist.map((item) => ({
      id: item.id,
      label: item.label,
      type: item.type,
      value:
        item.valueText ??
        item.valueNumber?.toString() ??
        (item.valueBoolean === null ? null : item.valueBoolean ? "true" : "false"),
    })),
    materials: materials.map((m) => ({
      id: m.id,
      description: m.description,
      quantity: m.quantity.toString(),
      unit: m.unit,
      inventoryItemId: m.inventoryItemId,
    })),
    equipments: equipments.map((e) => ({
      id: e.id,
      equipmentType: e.equipmentType,
      serial: e.serial,
      macAddress: e.macAddress,
    })),
    signature: signature
      ? {
          id: signature.id,
          signerName: signature.signerName,
          signedAt: signature.signedAt.toISOString(),
        }
      : null,
    checkIn: checkIn
      ? {
          id: checkIn.id,
          checkedInAt: checkIn.checkedInAt.toISOString(),
          distanceMeters: checkIn.distanceMeters,
        }
      : null,
    impedimentCount,
    contactAttemptCount,
  };
}
