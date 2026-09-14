import type { EvidenceCategory } from "@prisma/client";
import type {
  ChecklistAnswerView,
  LocationChangeKind,
  PackageIntegrity,
  ServiceOrderEvidencePackage,
  SignatureBinding,
} from "./service-order-evidence-package";
import {
  EVIDENCE_CATEGORY_LABELS,
  presentTimelineItem,
} from "./customer-timeline-presentation";

/**
 * # Como o pacote técnico fala — EV-1
 *
 * Funções puras: do DTO para frases. Nenhum código cru na tela, nenhum valor
 * inventado. As palavras do check-in são as do aplicativo do técnico, e as da
 * localização são as da timeline do cliente — a mesma coisa não ganha um nome
 * novo por aparecer em outra tela.
 */

export type Tone = "ok" | "warning" | "neutral";

export interface StatusText {
  title: string;
  description: string;
  tone: Tone;
}

export function integrityText(integrity: PackageIntegrity): StatusText {
  switch (integrity) {
    case "VERIFIED":
      return {
        title: "Conteúdo conferido com o fechamento",
        description:
          "Relatório, checklist, fotos, materiais e equipamentos são os mesmos que foram fechados.",
        tone: "ok",
      };
    case "DIVERGENT":
      return {
        title: "O conteúdo mudou depois do fechamento",
        description:
          "O que aparece abaixo não é igual ao que foi fechado. Trate como inconsistência e verifique antes de usar como comprovação.",
        tone: "warning",
      };
    case "NO_RECORD":
      return {
        title: "Sem registro de fechamento",
        description:
          "Esta OS foi concluída antes do registro estruturado de fechamento; não há com o que conferir o conteúdo.",
        tone: "neutral",
      };
  }
}

export function signatureBindingText(binding: SignatureBinding): StatusText {
  switch (binding) {
    case "BOUND":
      return {
        title: "Assinatura vinculada ao conteúdo fechado",
        description: "O cliente assinou exatamente o que foi fechado.",
        tone: "ok",
      };
    case "DIVERGENT":
      return {
        title: "A assinatura não corresponde ao conteúdo fechado",
        description: "O que foi assinado é diferente do que foi fechado.",
        tone: "warning",
      };
    case "LEGACY":
      return {
        title: "Assinatura anterior à regra de vínculo",
        description: "Coletada antes de a assinatura ser amarrada ao conteúdo.",
        tone: "neutral",
      };
    case "NONE":
      return {
        title: "Assinatura não coletada",
        description: "Nenhuma assinatura foi registrada nesta OS.",
        tone: "neutral",
      };
  }
}

/** A linha de localização do check-in — as frases do aplicativo do técnico. */
export function checkInLocationText(
  checkIn: NonNullable<ServiceOrderEvidencePackage["checkIn"]>,
): string {
  if (checkIn.distanceMeters !== null) {
    return `A ${checkIn.distanceMeters} m do ponto cadastrado`;
  }
  return checkIn.withDeviceLocation
    ? "Sem localização cadastrada no momento do check-in"
    : "Sem coordenada — registrado assim mesmo";
}

export function checkInAccuracyText(
  checkIn: NonNullable<ServiceOrderEvidencePackage["checkIn"]>,
): string | null {
  if (!checkIn.withDeviceLocation || checkIn.accuracyMeters === null) return null;
  return `Precisão do GPS: ${checkIn.accuracyMeters} m`;
}

/**
 * A mudança de ponto feita nesta OS, com as MESMAS frases da timeline do
 * cliente: a apresentação de lá é chamada, não copiada.
 */
export function locationChangeText(change: {
  kind: LocationChangeKind;
  reason: ServiceOrderEvidencePackage["locationChanges"][number]["reason"];
}): { title: string; reason: string | null } {
  const p = presentTimelineItem({
    id: "location",
    kind: change.kind,
    occurredAt: new Date(0),
    actorName: null,
    order: null,
    reason: change.reason,
    // O pacote técnico (EV-1, congelado) não carrega a medida da confirmação:
    // a linha continua dizendo o que dizia antes da RC-1C.
    confirmation: null,
  });
  return { title: p.title, reason: p.description };
}

export function evidenceCategoryLabel(category: EvidenceCategory | null): string {
  return category ? EVIDENCE_CATEGORY_LABELS[category] : "Sem categoria";
}

const NUMBER_FORMAT = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 4 });

export function checklistAnswerText(answer: ChecklistAnswerView): string {
  switch (answer.kind) {
    case "boolean":
      return answer.value ? "Sim" : "Não";
    case "text":
      return answer.value;
    case "number": {
      const n = Number(answer.value);
      return Number.isFinite(n) ? NUMBER_FORMAT.format(n) : answer.value;
    }
    case "photo":
      return answer.attached
        ? `Foto anexada — ${evidenceCategoryLabel(answer.category)}`
        : `Foto não anexada — ${evidenceCategoryLabel(answer.category)}`;
    case "unanswered":
      return "Sem resposta";
  }
}

/** "1h 05min" ou "35 min" — a mesma forma da faixa verde da OS. */
export function durationText(start: Date | null, end: Date | null): string | null {
  if (!start || !end) return null;
  const ms = end.getTime() - start.getTime();
  if (ms < 0) return null;
  const totalMinutes = Math.round(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} min`;
  return `${hours}h ${String(minutes).padStart(2, "0")}min`;
}

/** Fotos agrupadas por categoria, na ordem em que a primeira de cada uma chegou. */
export function groupPhotosByCategory<T extends { category: EvidenceCategory }>(
  photos: readonly T[],
): { category: EvidenceCategory; label: string; photos: T[] }[] {
  const grupos = new Map<EvidenceCategory, T[]>();
  for (const photo of photos) {
    const lista = grupos.get(photo.category) ?? [];
    lista.push(photo);
    grupos.set(photo.category, lista);
  }
  return Array.from(grupos, ([category, lista]) => ({
    category,
    label: EVIDENCE_CATEGORY_LABELS[category],
    photos: lista,
  }));
}
