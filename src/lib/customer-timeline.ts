import {
  AccessProfile,
  type ContactAttemptChannel,
  type ContactAttemptResult,
  type CustomerNetworkConnectionSource,
  type EvidenceCategory,
  type ImpedimentReason,
  type LocationChangeReason,
  type Prisma,
} from "@prisma/client";
import { prisma } from "./prisma";
import { resolveTimezone } from "./workday";

/**
 * # A timeline do cliente — TL-1 (PRD §381, MASTER-PLAN §5)
 *
 * **Visão DERIVADA dos registros reais.** Não existe tabela de timeline, e nada
 * aqui escreve: cada item é lido da tabela que JÁ é a autoridade daquele fato.
 * Duas fontes para o mesmo fato seriam duas verdades, e a timeline mostraria o
 * mesmo evento duas vezes — ou, pior, um que já foi corrigido.
 *
 * ## Uma fonte por fato
 *
 * ```text
 * ciclo da OS          ServiceOrderEvent (criada, importada, atribuída,
 *                      técnico alterado, iniciada, concluída)
 * observações          ServiceOrderExecution.notes — no item "concluída"
 * visita               ServiceOrderCheckIn            (checkedInAt)
 * contato              ServiceOrderContactAttempt     (attemptedAt)
 * impedimento          ServiceOrderImpediment         (reportedAt)
 * fotos                ServiceOrderEvidence, agrupadas por OS
 * teste de velocidade  ServiceOrderEvidence SPEED_TEST
 * leitura óptica       ServiceOrderEvidence OPTICAL_READING
 * assinatura           ServiceOrderSignature          (signedAt)
 * equipamento          ServiceOrderEquipment          (createdAt)
 * CTO e porta          CustomerNetworkConnection      (connectedAt / disconnectedAt)
 * localização          CustomerLocationHistory        (createdAt)
 * ```
 *
 * Os códigos de `ServiceOrderEvent` que repetem um fato de tabela própria
 * (`CHECKED_IN`, `EQUIPMENT_INSTALLED`, `SIGNATURE_CAPTURED`, `CTO_PORT_*`,
 * `LOCATION_*`…) ficam FORA de propósito. O `EQUIPMENT_INSTALLED` é o exemplo
 * que decide: remover um equipamento durante o atendimento é correção de
 * cadastro e apaga a linha, mas o evento continua lá — lido do evento, a
 * timeline mostraria um aparelho que nunca ficou no cliente. E o vínculo de
 * porta feito pelo painel (`WEB`) nem gera evento: só a linha o conta.
 *
 * `AuditLog` não é fonte. Ele é a trilha técnica (PRD §322); a timeline é a
 * história operacional do cliente.
 *
 * ## "Instalação" não é detectada
 *
 * O tipo da OS é um catálogo livre por empresa (PRD §124), não um enum. O item
 * da OS mostra o tipo gravado — "Instalação · Instalação nova" — e a timeline
 * não adivinha quais tipos "são" instalação.
 *
 * ## Limite e ordem
 *
 * Mais recente primeiro (decisão do dono). Cada fonte é lida com `limit + 1`,
 * as listas são unidas e cortadas em `limit`: o maior item de cada fonte que
 * cabe no topo global está sempre entre os `limit` primeiros dela, então o
 * corte é exato, e sobrar item em qualquer fonte diz que há mais. O desempate
 * é o `id` estável do item — nunca a ordem em que o banco devolveu.
 */

export const CUSTOMER_TIMELINE_PAGE_SIZE = 50;
export const CUSTOMER_TIMELINE_MAX = 500;

/** `?historico=` → 50..500, em passos de 50. Qualquer outra coisa vira 50. */
export function parseTimelineLimit(raw: unknown): number {
  const n = typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return CUSTOMER_TIMELINE_PAGE_SIZE;
  const passos = Math.ceil(n / CUSTOMER_TIMELINE_PAGE_SIZE);
  return Math.min(
    CUSTOMER_TIMELINE_MAX,
    Math.max(CUSTOMER_TIMELINE_PAGE_SIZE, passos * CUSTOMER_TIMELINE_PAGE_SIZE),
  );
}

/** A OS a que o item pertence — o bastante para o link e para o rótulo. */
export interface TimelineOrderRef {
  id: string;
  number: number;
  type: string;
  subtype: string | null;
}

interface ItemBase {
  /** `<fonte>:<id da linha>` — estável entre leituras, chave da lista. */
  id: string;
  occurredAt: Date;
  /** Quem fez, quando a linha diz. `null` nunca vira um nome inventado. */
  actorName: string | null;
}

export type CustomerTimelineItem =
  | (ItemBase & { kind: "OS_CREATED" | "OS_IMPORTED" | "OS_STARTED"; order: TimelineOrderRef })
  | (ItemBase & { kind: "OS_ASSIGNED"; order: TimelineOrderRef; technicianName: string | null })
  | (ItemBase & {
      kind: "OS_REASSIGNED";
      order: TimelineOrderRef;
      technicianName: string | null;
      previousTechnicianName: string | null;
    })
  | (ItemBase & { kind: "OS_COMPLETED"; order: TimelineOrderRef; observations: string | null })
  | (ItemBase & { kind: "VISIT"; order: TimelineOrderRef; withDeviceLocation: boolean })
  | (ItemBase & {
      kind: "CONTACT_ATTEMPT";
      order: TimelineOrderRef;
      channel: ContactAttemptChannel;
      result: ContactAttemptResult;
    })
  | (ItemBase & { kind: "IMPEDIMENT"; order: TimelineOrderRef; reason: ImpedimentReason })
  | (ItemBase & {
      kind: "PHOTOS";
      order: TimelineOrderRef;
      total: number;
      categories: { category: EvidenceCategory; count: number }[];
    })
  | (ItemBase & { kind: "SPEED_TEST" | "OPTICAL_READING"; order: TimelineOrderRef })
  | (ItemBase & { kind: "SIGNATURE"; order: TimelineOrderRef; signerName: string })
  | (ItemBase & {
      kind: "EQUIPMENT_INSTALLED";
      order: TimelineOrderRef;
      equipmentType: string;
      manufacturer: string | null;
      model: string | null;
      serial: string | null;
    })
  | (ItemBase & {
      kind: "NETWORK_CONNECTED" | "NETWORK_DISCONNECTED";
      order: TimelineOrderRef | null;
      cto: { id: string; name: string };
      portNumber: number;
      source: CustomerNetworkConnectionSource;
      reason: string | null;
    })
  | (ItemBase & {
      kind:
        | "LOCATION_CONFIRMED"
        | "LOCATION_CORRECTED"
        | "ADDRESS_CORRECTED"
        | "LOCATION_AND_ADDRESS_CORRECTED"
        | "LOCATION_FROM_INTEGRATION"
        | "LOCATION_DIVERGENCE_FROM_INTEGRATION";
      order: TimelineOrderRef | null;
      reason: LocationChangeReason;
    });

export type CustomerTimelineKind = CustomerTimelineItem["kind"];

export interface CustomerTimeline {
  items: CustomerTimelineItem[];
  /** Há itens mais antigos do que os `limit` devolvidos. */
  hasMore: boolean;
  limit: number;
  /** O fuso da empresa, para a tela formatar data e hora. */
  timezone: string;
}

export interface CustomerTimelineViewer {
  companyId: string;
  profile: AccessProfile;
}

/** Texto livre vai truncado: a íntegra continua na OS, a um clique. */
export const TIMELINE_OBSERVATIONS_MAX = 280;
export const TIMELINE_REASON_MAX = 140;

function truncar(texto: string | null | undefined, max: number): string | null {
  const limpo = texto?.replace(/\s+/g, " ").trim();
  if (!limpo) return null;
  return limpo.length <= max ? limpo : `${limpo.slice(0, max - 1).trimEnd()}…`;
}

/** Mais recente primeiro; empate no instante resolvido pelo `id`, sempre igual. */
export function sortTimelineItems<T extends { occurredAt: Date; id: string }>(
  items: readonly T[],
): T[] {
  return [...items].sort((a, b) => {
    const t = b.occurredAt.getTime() - a.occurredAt.getTime();
    if (t !== 0) return t;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
}

const ORDER_REF = {
  select: { id: true, number: true, type: true, subtype: true },
} as const;

const TIMELINE_OS_EVENTS = [
  "SERVICE_ORDER_CREATED",
  "SERVICE_ORDER_IMPORTED",
  "TECHNICIAN_ASSIGNED",
  "TECHNICIAN_CHANGED",
  "OS_STARTED",
  "OS_COMPLETED",
] as const;

/** Fotos que não são o teste de velocidade nem a leitura óptica. */
const MEASUREMENT_CATEGORIES: EvidenceCategory[] = ["SPEED_TEST", "OPTICAL_READING"];

function metadataText(metadata: Prisma.JsonValue | null, key: string): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function mesmoDecimal(
  a: Prisma.Decimal | null,
  b: Prisma.Decimal | null,
): boolean {
  if (a === null || b === null) return a === b;
  return a.equals(b);
}

/**
 * A timeline de UM cliente de UMA empresa.
 *
 * Toda consulta leva o `companyId` da sessão no predicado — da própria linha e,
 * onde a ligação é pela OS, também o da OS e o `customerId` dela. A empresa B
 * não aparece nem com uma OS que aponte para um cliente de A: `customerId` é FK
 * simples, sem `(companyId, customerId)`, o mesmo vetor da `DQ-7.1`.
 *
 * CTO e porta só para `ADMIN` com a capability de rede ligada — hoje o
 * histórico de vínculo (`GET /api/cto-connections`) é `ADMIN`, e a timeline
 * não pode ser o atalho que o estende ao `DISPATCHER`.
 */
export async function getCustomerTimeline(
  viewer: CustomerTimelineViewer,
  customerId: string,
  limit: number = CUSTOMER_TIMELINE_PAGE_SIZE,
): Promise<CustomerTimeline> {
  const { companyId } = viewer;
  const take = limit + 1;

  const [empresa, doTenant] = await Promise.all([
    prisma.company.findUnique({
      where: { id: companyId },
      select: { timezone: true, ctoNetworkEnabled: true },
    }),
    prisma.customer.findFirst({
      where: { id: customerId, companyId },
      select: { id: true },
    }),
  ]);
  const timezone = resolveTimezone(empresa?.timezone);
  // Cliente de outra empresa não tem história aqui — nem a das linhas desta
  // empresa que, por FK simples, apontem para ele. A tela já responde 404
  // antes de chegar aqui; esta é a segunda porta, para quem chamar direto.
  if (!doTenant) {
    return { items: [], hasMore: false, limit, timezone };
  }
  const verRede =
    viewer.profile === AccessProfile.ADMIN && empresa?.ctoNetworkEnabled === true;

  // O cliente pela OS: o tenant da linha E o da OS, e o cliente da OS.
  const daOs = { companyId, serviceOrder: { companyId, customerId } };

  const [
    eventos,
    visitas,
    contatos,
    impedimentos,
    gruposDeFotos,
    medicoes,
    assinaturas,
    equipamentos,
    conexoes,
    desconexoes,
    localizacoes,
  ] = await Promise.all([
    prisma.serviceOrderEvent.findMany({
      where: { ...daOs, event: { in: [...TIMELINE_OS_EVENTS] } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take,
      select: {
        id: true,
        event: true,
        createdAt: true,
        metadata: true,
        user: { select: { name: true } },
        serviceOrder: ORDER_REF,
      },
    }),
    prisma.serviceOrderCheckIn.findMany({
      where: daOs,
      orderBy: [{ checkedInAt: "desc" }, { id: "desc" }],
      take,
      select: {
        id: true,
        checkedInAt: true,
        source: true,
        technician: { select: { user: { select: { name: true } } } },
        serviceOrder: ORDER_REF,
      },
    }),
    prisma.serviceOrderContactAttempt.findMany({
      where: daOs,
      orderBy: [{ attemptedAt: "desc" }, { id: "desc" }],
      take,
      select: {
        id: true,
        attemptedAt: true,
        channel: true,
        result: true,
        technician: { select: { user: { select: { name: true } } } },
        serviceOrder: ORDER_REF,
      },
    }),
    prisma.serviceOrderImpediment.findMany({
      where: daOs,
      orderBy: [{ reportedAt: "desc" }, { id: "desc" }],
      take,
      select: {
        id: true,
        reportedAt: true,
        reason: true,
        technician: { select: { user: { select: { name: true } } } },
        serviceOrder: ORDER_REF,
      },
    }),
    // Fotos: UM item por OS. O agrupamento é do banco, então a contagem é a
    // de todas as fotos da OS — não só as que caberiam numa página de linhas.
    prisma.serviceOrderEvidence.groupBy({
      by: ["serviceOrderId"],
      where: {
        ...daOs,
        status: "COMMITTED",
        category: { notIn: MEASUREMENT_CATEGORIES },
      },
      _count: { _all: true },
      _max: { createdAt: true },
      orderBy: [{ _max: { createdAt: "desc" } }, { serviceOrderId: "desc" }],
      take,
    }),
    prisma.serviceOrderEvidence.findMany({
      where: { ...daOs, status: "COMMITTED", category: { in: MEASUREMENT_CATEGORIES } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take,
      select: {
        id: true,
        category: true,
        createdAt: true,
        uploadedBy: { select: { name: true } },
        serviceOrder: ORDER_REF,
      },
    }),
    prisma.serviceOrderSignature.findMany({
      where: daOs,
      orderBy: [{ signedAt: "desc" }, { id: "desc" }],
      take,
      select: {
        id: true,
        signedAt: true,
        signerName: true,
        capturedBy: { select: { name: true } },
        serviceOrder: ORDER_REF,
      },
    }),
    prisma.serviceOrderEquipment.findMany({
      where: { companyId, customerId, serviceOrder: { companyId, customerId } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take,
      select: {
        id: true,
        createdAt: true,
        equipmentType: true,
        manufacturer: true,
        model: true,
        serial: true,
        installedBy: { select: { name: true } },
        serviceOrder: ORDER_REF,
      },
    }),
    verRede
      ? prisma.customerNetworkConnection.findMany({
          where: { companyId, customerId },
          orderBy: [{ connectedAt: "desc" }, { id: "desc" }],
          take,
          select: CONNECTION_SELECT,
        })
      : Promise.resolve([]),
    verRede
      ? prisma.customerNetworkConnection.findMany({
          where: { companyId, customerId, disconnectedAt: { not: null } },
          orderBy: [{ disconnectedAt: "desc" }, { id: "desc" }],
          take,
          select: CONNECTION_SELECT,
        })
      : Promise.resolve([]),
    prisma.customerLocationHistory.findMany({
      where: { companyId, customerId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take,
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
        serviceOrder: { select: { ...ORDER_REF.select, companyId: true } },
      },
    }),
  ]);

  // Segunda leva, dependente da primeira e limitada por ela.
  const concluidas = eventos.filter((e) => e.event === "OS_COMPLETED").map((e) => e.serviceOrder.id);
  const osDasFotos = gruposDeFotos.map((g) => g.serviceOrderId);
  const [execucoes, categoriasDasFotos, osRefsDasFotos] = await Promise.all([
    concluidas.length > 0
      ? prisma.serviceOrderExecution.findMany({
          where: { companyId, serviceOrderId: { in: concluidas } },
          select: { serviceOrderId: true, notes: true },
        })
      : Promise.resolve([]),
    osDasFotos.length > 0
      ? prisma.serviceOrderEvidence.groupBy({
          by: ["serviceOrderId", "category"],
          where: {
            companyId,
            serviceOrderId: { in: osDasFotos },
            status: "COMMITTED",
            category: { notIn: MEASUREMENT_CATEGORIES },
          },
          _count: { _all: true },
        })
      : Promise.resolve([]),
    osDasFotos.length > 0
      ? prisma.serviceOrder.findMany({
          where: { companyId, customerId, id: { in: osDasFotos } },
          select: ORDER_REF.select,
        })
      : Promise.resolve([]),
  ]);

  const notasPorOs = new Map(execucoes.map((e) => [e.serviceOrderId, e.notes]));
  const osPorId = new Map(osRefsDasFotos.map((o) => [o.id, o]));
  const categoriasPorOs = new Map<string, { category: EvidenceCategory; count: number }[]>();
  for (const g of categoriasDasFotos) {
    const lista = categoriasPorOs.get(g.serviceOrderId) ?? [];
    lista.push({ category: g.category, count: g._count._all });
    categoriasPorOs.set(g.serviceOrderId, lista);
  }

  const items: CustomerTimelineItem[] = [];

  for (const e of eventos) {
    const base = {
      id: `os-event:${e.id}`,
      occurredAt: e.createdAt,
      actorName: e.user?.name ?? null,
      order: e.serviceOrder,
    };
    switch (e.event) {
      case "SERVICE_ORDER_CREATED":
        items.push({ ...base, kind: "OS_CREATED" });
        break;
      case "SERVICE_ORDER_IMPORTED":
        items.push({ ...base, kind: "OS_IMPORTED" });
        break;
      case "TECHNICIAN_ASSIGNED":
        items.push({ ...base, kind: "OS_ASSIGNED", technicianName: metadataText(e.metadata, "technicianName") });
        break;
      case "TECHNICIAN_CHANGED":
        items.push({
          ...base,
          kind: "OS_REASSIGNED",
          technicianName: metadataText(e.metadata, "technicianName"),
          previousTechnicianName: metadataText(e.metadata, "previousTechnicianName"),
        });
        break;
      case "OS_STARTED":
        items.push({ ...base, kind: "OS_STARTED" });
        break;
      case "OS_COMPLETED":
        items.push({
          ...base,
          kind: "OS_COMPLETED",
          observations: truncar(notasPorOs.get(e.serviceOrder.id), TIMELINE_OBSERVATIONS_MAX),
        });
        break;
    }
  }

  for (const v of visitas) {
    items.push({
      id: `visit:${v.id}`,
      kind: "VISIT",
      occurredAt: v.checkedInAt,
      actorName: v.technician.user.name,
      order: v.serviceOrder,
      withDeviceLocation: v.source === "DEVICE_GPS",
    });
  }

  for (const c of contatos) {
    items.push({
      id: `contact:${c.id}`,
      kind: "CONTACT_ATTEMPT",
      occurredAt: c.attemptedAt,
      actorName: c.technician.user.name,
      order: c.serviceOrder,
      channel: c.channel,
      result: c.result,
    });
  }

  for (const i of impedimentos) {
    items.push({
      id: `impediment:${i.id}`,
      kind: "IMPEDIMENT",
      occurredAt: i.reportedAt,
      actorName: i.technician.user.name,
      order: i.serviceOrder,
      reason: i.reason,
    });
  }

  for (const g of gruposDeFotos) {
    const order = osPorId.get(g.serviceOrderId);
    const ultima = g._max.createdAt;
    if (!order || !ultima) continue;
    items.push({
      id: `photos:${g.serviceOrderId}`,
      kind: "PHOTOS",
      occurredAt: ultima,
      actorName: null,
      order,
      total: g._count._all,
      categories: (categoriasPorOs.get(g.serviceOrderId) ?? []).sort(
        (a, b) => b.count - a.count || (a.category < b.category ? -1 : 1),
      ),
    });
  }

  for (const m of medicoes) {
    items.push({
      id: `evidence:${m.id}`,
      kind: m.category === "SPEED_TEST" ? "SPEED_TEST" : "OPTICAL_READING",
      occurredAt: m.createdAt,
      actorName: m.uploadedBy?.name ?? null,
      order: m.serviceOrder,
    });
  }

  for (const s of assinaturas) {
    items.push({
      id: `signature:${s.id}`,
      kind: "SIGNATURE",
      occurredAt: s.signedAt,
      actorName: s.capturedBy?.name ?? null,
      order: s.serviceOrder,
      signerName: s.signerName,
    });
  }

  for (const q of equipamentos) {
    items.push({
      id: `equipment:${q.id}`,
      kind: "EQUIPMENT_INSTALLED",
      occurredAt: q.createdAt,
      actorName: q.installedBy?.name ?? null,
      order: q.serviceOrder,
      equipmentType: q.equipmentType,
      manufacturer: q.manufacturer,
      model: q.model,
      serial: q.serial,
    });
  }

  /*
    Um vínculo são DOIS fatos: a entrada na porta e, quando houver, a saída.
    Mover é fechar e abrir, em linhas distintas — e sair e voltar à mesma porta
    também (CTO-2.7): cada linha conta a sua entrada e a sua saída, e nada é
    reconstruído a partir do estado atual.
  */
  const rede = (c: ConnectionRow, kind: "NETWORK_CONNECTED" | "NETWORK_DISCONNECTED", at: Date) => {
    // Defesa em profundidade: a porta e a caixa têm de ser da mesma empresa.
    if (c.ctoPort.companyId !== companyId || c.ctoPort.cto.companyId !== companyId) return;
    items.push({
      id: `network:${c.id}:${kind === "NETWORK_CONNECTED" ? "on" : "off"}`,
      kind,
      occurredAt: at,
      actorName: c.technician?.user.name ?? null,
      order: c.serviceOrder && c.serviceOrder.companyId === companyId ? orderRef(c.serviceOrder) : null,
      cto: { id: c.ctoPort.cto.id, name: c.ctoPort.cto.name },
      portNumber: c.ctoPort.number,
      source: c.source,
      reason: kind === "NETWORK_DISCONNECTED" ? truncar(c.reason, TIMELINE_REASON_MAX) : null,
    });
  };
  for (const c of conexoes) rede(c, "NETWORK_CONNECTED", c.connectedAt);
  for (const c of desconexoes) if (c.disconnectedAt) rede(c, "NETWORK_DISCONNECTED", c.disconnectedAt);

  for (const l of localizacoes) {
    const kind = classificarLocalizacao(l);
    items.push({
      id: `location:${l.id}`,
      kind,
      occurredAt: l.createdAt,
      actorName: l.changedBy?.name ?? l.technician?.user.name ?? null,
      order: l.serviceOrder && l.serviceOrder.companyId === companyId ? orderRef(l.serviceOrder) : null,
      reason: l.reason,
    });
  }

  const ordenados = sortTimelineItems(items);
  return {
    items: ordenados.slice(0, limit),
    hasMore: ordenados.length > limit,
    limit,
    timezone,
  };
}

const CONNECTION_SELECT = {
  id: true,
  connectedAt: true,
  disconnectedAt: true,
  source: true,
  reason: true,
  technician: { select: { user: { select: { name: true } } } },
  serviceOrder: { select: { ...ORDER_REF.select, companyId: true } },
  ctoPort: {
    select: {
      number: true,
      companyId: true,
      cto: { select: { id: true, name: true, companyId: true } },
    },
  },
} satisfies Prisma.CustomerNetworkConnectionSelect;

type ConnectionRow = Prisma.CustomerNetworkConnectionGetPayload<{
  select: typeof CONNECTION_SELECT;
}>;

function orderRef(o: TimelineOrderRef & { companyId?: string }): TimelineOrderRef {
  return { id: o.id, number: o.number, type: o.type, subtype: o.subtype };
}

/**
 * O que a linha do histórico de localização conta — lido dos DADOS dela, nunca
 * do texto da nota.
 *
 * Existem exatamente quatro escritores (`customer-locations.ts`), e a regra é a
 * assinatura de cada um:
 *
 * ```text
 * confirmação em campo   pessoa, COORDINATES, motivo OTHER, mesmo ponto e
 *                        mesma origem, de não verificado para verificado
 * correção em campo      pessoa; ADDRESS, BOTH ou COORDINATES com o motivo
 *                        que o técnico escolheu
 * importação que venceu  sem pessoa, motivo INCOMPLETE_REGISTRATION
 * divergência preservada sem pessoa, motivo OTHER — o `new*` é o ponto que o
 *                        PROVEDOR informou, e que NÃO foi aplicado
 * ```
 *
 * A divergência é a armadilha: ela grava o ponto do provedor como "novo", então
 * comparar coordenadas a confundiria com uma atualização. O que separa as duas
 * é o motivo que cada escritor grava — e os testes passam pelos escritores
 * reais, para que trocar esse motivo lá quebre aqui.
 *
 * Coordenada nenhuma sai daqui: a tela diz O QUE aconteceu, não ONDE.
 */
function classificarLocalizacao(l: {
  kind: "ADDRESS" | "COORDINATES" | "BOTH";
  reason: LocationChangeReason;
  previousLatitude: Prisma.Decimal | null;
  previousLongitude: Prisma.Decimal | null;
  previousSource: string | null;
  previousVerified: boolean | null;
  newLatitude: Prisma.Decimal | null;
  newLongitude: Prisma.Decimal | null;
  newSource: string | null;
  newVerified: boolean | null;
  changedBy: { name: string } | null;
  technician: { user: { name: string } } | null;
}):
  | "LOCATION_CONFIRMED"
  | "LOCATION_CORRECTED"
  | "ADDRESS_CORRECTED"
  | "LOCATION_AND_ADDRESS_CORRECTED"
  | "LOCATION_FROM_INTEGRATION"
  | "LOCATION_DIVERGENCE_FROM_INTEGRATION" {
  if (!l.changedBy && !l.technician) {
    return l.reason === "OTHER"
      ? "LOCATION_DIVERGENCE_FROM_INTEGRATION"
      : "LOCATION_FROM_INTEGRATION";
  }
  if (l.kind === "ADDRESS") return "ADDRESS_CORRECTED";
  if (l.kind === "BOTH") return "LOCATION_AND_ADDRESS_CORRECTED";
  const mesmoPonto =
    mesmoDecimal(l.previousLatitude, l.newLatitude) &&
    mesmoDecimal(l.previousLongitude, l.newLongitude);
  if (
    l.reason === "OTHER" &&
    mesmoPonto &&
    l.previousSource === l.newSource &&
    l.previousVerified === false &&
    l.newVerified === true
  ) {
    return "LOCATION_CONFIRMED";
  }
  return "LOCATION_CORRECTED";
}

export type CustomerTimelineSection =
  | { state: "ok"; data: CustomerTimeline }
  | { state: "error" };

/**
 * A timeline para a tela: falha vira `error`, NUNCA a lista vazia. "Nenhum
 * evento" dito porque uma consulta caiu seria o contrário da verdade, com a
 * cara de um cliente novo.
 */
export async function loadCustomerTimeline(
  viewer: CustomerTimelineViewer,
  customerId: string,
  limit: number,
): Promise<CustomerTimelineSection> {
  try {
    return { state: "ok", data: await getCustomerTimeline(viewer, customerId, limit) };
  } catch (error) {
    // Só o tipo do erro: mensagem de banco pode trazer fragmento de consulta.
    console.error("[customer-timeline] falhou", {
      companyId: viewer.companyId,
      erro: error instanceof Error ? error.name : "desconhecido",
    });
    return { state: "error" };
  }
}
