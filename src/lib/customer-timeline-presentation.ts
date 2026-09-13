import type {
  ContactAttemptChannel,
  ContactAttemptResult,
  EvidenceCategory,
  ImpedimentReason,
  LocationChangeReason,
} from "@prisma/client";
import type {
  CustomerTimelineItem,
  CustomerTimelineKind,
} from "./customer-timeline";

/**
 * # Como a timeline do cliente fala com o operador — TL-1
 *
 * Função pura: de um item estruturado para categoria, título e descrição em
 * português. Nenhum código cru (`OS_COMPLETED`, `PHONE_CALL`) chega à tela, e
 * nenhum texto é inventado — tudo sai de um campo do item.
 *
 * Os rótulos de categoria de foto, canal, resultado e motivo são os MESMOS do
 * aplicativo do técnico (`apps/field/lib/features/execution/domain/execution.dart`
 * e `.../ui/execution_forms.dart`): a mesma coisa não pode ter um nome no campo
 * e outro no escritório. Um teste lê os dois arquivos e cobra a igualdade.
 *
 * Os mapas são `Record<Enum, string>`: um valor novo no enum do Prisma sem
 * rótulo aqui não compila.
 */

export const EVIDENCE_CATEGORY_LABELS: Record<EvidenceCategory, string> = {
  BEFORE_SERVICE: "Antes do serviço",
  INSTALLATION_LOCATION: "Local da instalação",
  CABLE_ROUTE: "Passagem de cabo",
  CTO: "CTO",
  ONU_ONT: "ONU / ONT",
  ROUTER: "Roteador",
  EQUIPMENT: "Equipamento",
  EQUIPMENT_LABEL: "Etiqueta do equipamento",
  OPTICAL_READING: "Leitura óptica",
  WIFI_TEST: "Teste de Wi-Fi",
  SPEED_TEST: "Teste de velocidade",
  AFTER_SERVICE: "Depois do serviço",
  OTHER: "Outra",
};

export const CONTACT_CHANNEL_LABELS: Record<ContactAttemptChannel, string> = {
  PHONE_CALL: "Ligação",
  WHATSAPP: "WhatsApp",
  SMS: "SMS",
  OTHER: "Outro",
};

export const CONTACT_RESULT_LABELS: Record<ContactAttemptResult, string> = {
  ANSWERED: "Atendeu",
  NO_ANSWER: "Não atendeu",
  BUSY: "Ocupado",
  INVALID_NUMBER: "Número inválido",
  CUSTOMER_REQUESTED_LATER: "Pediu para remarcar",
};

export const IMPEDIMENT_REASON_LABELS: Record<ImpedimentReason, string> = {
  CUSTOMER_ABSENT: "Cliente ausente",
  CUSTOMER_NOT_ANSWERING: "Cliente não atende",
  NO_ACCESS: "Sem acesso ao local",
  MISSING_MATERIAL: "Falta material",
  EXTERNAL_NETWORK_ISSUE: "Problema na rede externa",
  WEATHER: "Condição climática",
  NEED_SECOND_TECHNICIAN: "Precisa de segundo técnico",
  NEED_SPECIAL_EQUIPMENT: "Precisa de equipamento especial",
  SAFETY_RISK: "Risco de segurança",
  OTHER: "Outro",
};

export const LOCATION_REASON_LABELS: Record<LocationChangeReason, string> = {
  INCORRECT_ADDRESS: "Endereço incorreto",
  INCORRECT_LOCATION: "Localização incorreta",
  CUSTOMER_MOVED: "Cliente mudou de endereço",
  INCOMPLETE_REGISTRATION: "Cadastro incompleto",
  OTHER: "Outro motivo",
};

/**
 * Categoria em TEXTO: é ela que diz de que tipo é o item, e não uma cor por
 * tipo. A cor fica reservada ao que é estado — impedimento é o único aviso.
 */
export type TimelineCategory =
  | "OS"
  | "Visita"
  | "Contato"
  | "Impedimento"
  | "Fotos"
  | "Medição"
  | "Assinatura"
  | "Equipamento"
  | "Rede"
  | "Localização";

export const TIMELINE_KIND_CATEGORY: Record<CustomerTimelineKind, TimelineCategory> = {
  OS_CREATED: "OS",
  OS_IMPORTED: "OS",
  OS_ASSIGNED: "OS",
  OS_REASSIGNED: "OS",
  OS_STARTED: "OS",
  OS_COMPLETED: "OS",
  VISIT: "Visita",
  CONTACT_ATTEMPT: "Contato",
  IMPEDIMENT: "Impedimento",
  PHOTOS: "Fotos",
  SPEED_TEST: "Medição",
  OPTICAL_READING: "Medição",
  SIGNATURE: "Assinatura",
  EQUIPMENT_INSTALLED: "Equipamento",
  NETWORK_CONNECTED: "Rede",
  NETWORK_DISCONNECTED: "Rede",
  LOCATION_CONFIRMED: "Localização",
  LOCATION_CORRECTED: "Localização",
  ADDRESS_CORRECTED: "Localização",
  LOCATION_AND_ADDRESS_CORRECTED: "Localização",
  LOCATION_FROM_INTEGRATION: "Localização",
  LOCATION_DIVERGENCE_FROM_INTEGRATION: "Localização",
};

export interface TimelineItemPresentation {
  category: TimelineCategory;
  title: string;
  description: string | null;
  /** Quem fez — ou a origem, quando não foi uma pessoa. */
  actorLabel: string | null;
}

/** "OS Nº 11 · Instalação · Instalação nova" — o tipo como foi gravado. */
export function timelineOrderLabel(order: {
  number: number;
  type: string;
  subtype: string | null;
}): string {
  return [`OS Nº ${order.number}`, order.type, order.subtype].filter(Boolean).join(" · ");
}

/**
 * "CTO Centro 01" — e "CTO QA FIELD 01" quando o nome já começa pela palavra.
 * Caixas costumam ser batizadas "CTO …"; prefixar sempre escreveria "CTO CTO".
 */
export function timelineCtoLabel(nome: string): string {
  return /^cto\b/i.test(nome.trim()) ? nome : `CTO ${nome}`;
}

function juntar(...partes: (string | null | undefined)[]): string | null {
  const texto = partes.filter((p): p is string => Boolean(p && p.trim())).join(" · ");
  return texto || null;
}

export function presentTimelineItem(item: CustomerTimelineItem): TimelineItemPresentation {
  const category = TIMELINE_KIND_CATEGORY[item.kind];
  const actorLabel = item.actorName;
  switch (item.kind) {
    case "OS_CREATED":
      return { category, title: "OS criada", description: null, actorLabel };
    case "OS_IMPORTED":
      return {
        category,
        title: "OS importada do ERP",
        description: null,
        actorLabel: actorLabel ?? "Integração (ERP)",
      };
    case "OS_ASSIGNED":
      return {
        category,
        title: "Técnico atribuído",
        description: item.technicianName,
        actorLabel,
      };
    case "OS_REASSIGNED":
      return {
        category,
        title: "Técnico alterado",
        description:
          item.previousTechnicianName && item.technicianName
            ? `${item.previousTechnicianName} → ${item.technicianName}`
            : item.technicianName,
        actorLabel,
      };
    case "OS_STARTED":
      return { category, title: "Atendimento iniciado", description: null, actorLabel };
    case "OS_COMPLETED":
      return {
        category,
        title: "Atendimento concluído",
        description: item.observations ? `Observações: ${item.observations}` : null,
        actorLabel,
      };
    case "VISIT":
      return {
        category,
        title: "Técnico no local (check-in)",
        description: item.withDeviceLocation
          ? "Com a localização do aparelho"
          : "Sem a localização do aparelho",
        actorLabel,
      };
    case "CONTACT_ATTEMPT":
      return {
        category,
        title: "Tentativa de contato",
        description: juntar(
          CONTACT_CHANNEL_LABELS[item.channel],
          CONTACT_RESULT_LABELS[item.result],
        ),
        actorLabel,
      };
    case "IMPEDIMENT":
      return {
        category,
        title: "Impedimento registrado",
        description: IMPEDIMENT_REASON_LABELS[item.reason],
        actorLabel,
      };
    case "PHOTOS":
      return {
        category,
        title: `${item.total} ${item.total === 1 ? "foto do atendimento" : "fotos do atendimento"}`,
        description: juntar(
          ...item.categories.map(
            (c) => `${EVIDENCE_CATEGORY_LABELS[c.category]} (${c.count})`,
          ),
        ),
        actorLabel: null,
      };
    case "SPEED_TEST":
      return {
        category,
        title: "Teste de velocidade registrado",
        description: "Foto do resultado",
        actorLabel,
      };
    case "OPTICAL_READING":
      return {
        category,
        title: "Leitura óptica registrada",
        description: "Foto da leitura",
        actorLabel,
      };
    case "SIGNATURE":
      return {
        category,
        title: "Assinatura coletada",
        description: `Assinado por ${item.signerName}`,
        actorLabel,
      };
    case "EQUIPMENT_INSTALLED":
      return {
        category,
        title: "Equipamento instalado",
        description: juntar(
          item.equipmentType,
          [item.manufacturer, item.model].filter(Boolean).join(" "),
          item.serial ? `série ${item.serial}` : null,
        ),
        actorLabel,
      };
    case "NETWORK_CONNECTED":
      return {
        category,
        title: `Conectado à ${timelineCtoLabel(item.cto.name)} · porta ${item.portNumber}`,
        description: item.source === "FIELD" ? "Em campo" : "Pelo painel",
        actorLabel,
      };
    case "NETWORK_DISCONNECTED":
      return {
        category,
        title: `Desconectado da ${timelineCtoLabel(item.cto.name)} · porta ${item.portNumber}`,
        description: juntar(
          item.source === "FIELD" ? "Em campo" : "Pelo painel",
          item.reason ? `Motivo: ${item.reason}` : null,
        ),
        actorLabel,
      };
    case "LOCATION_CONFIRMED":
      return { category, title: "Localização confirmada em campo", description: null, actorLabel };
    case "LOCATION_CORRECTED":
      return {
        category,
        title: "Localização corrigida",
        description: LOCATION_REASON_LABELS[item.reason],
        actorLabel,
      };
    case "ADDRESS_CORRECTED":
      return {
        category,
        title: "Endereço corrigido",
        description: LOCATION_REASON_LABELS[item.reason],
        actorLabel,
      };
    case "LOCATION_AND_ADDRESS_CORRECTED":
      return {
        category,
        title: "Endereço e localização corrigidos",
        description: LOCATION_REASON_LABELS[item.reason],
        actorLabel,
      };
    case "LOCATION_FROM_INTEGRATION":
      return {
        category,
        title: "Localização atualizada pela integração",
        description: null,
        actorLabel: "Integração (ERP)",
      };
    case "LOCATION_DIVERGENCE_FROM_INTEGRATION":
      return {
        category,
        title: "Divergência de localização informada pela integração",
        description: "O ponto cadastrado foi mantido.",
        actorLabel: "Integração (ERP)",
      };
  }
}
