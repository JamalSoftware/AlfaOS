import type { ServiceOrderStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCustomerDiagnostic } from "@/lib/customer-diagnostics";
import { TECHNICIAN_COMPLETED_WINDOW_DAYS } from "@/lib/service-orders";
import { FieldError } from "./errors";
import {
  toFieldDetail,
  toFieldListItem,
  toFieldQueueItem,
  type FieldDispatchQueueDto,
  type FieldServiceOrderDetail,
  type FieldServiceOrderListItem,
} from "./dto";

/**
 * Consultas do Field.
 *
 * A autorização é a MESMA da web e mora no `where` em SQL: `companyId` e
 * `technicianId` vêm do principal resolvido pelo token, nunca da requisição.
 * Não existe parâmetro capaz de trocar o dono — mandar `technicianId=<outro>`
 * simplesmente não é lido.
 *
 * O que muda em relação à web é só a PROJEÇÃO: menos campos (`dto.ts`) e
 * paginação por cursor, porque a lista vai para uma tela pequena com rede ruim.
 */

export const FIELD_PAGE_SIZE = 25;
export const FIELD_MAX_PAGE_SIZE = 100;

const ACTIVE_STATUSES: ServiceOrderStatus[] = ["ASSIGNED", "IN_PROGRESS"];

/** Só o que a projeção de lista consome. Nada de `document`. */
const LIST_SELECT = {
  id: true,
  number: true,
  status: true,
  priority: true,
  type: true,
  subtype: true,
  scheduledAt: true,
  updatedAt: true,
  version: true,
  customer: {
    select: {
      name: true,
      district: true,
      city: true,
      latitude: true,
      longitude: true,
    },
  },
} as const;

export type FieldOrderScope = "active" | "completed";

export interface FieldOrderPage {
  items: FieldServiceOrderListItem[];
  nextCursor: string | null;
}

/**
 * As OS do técnico que está chamando.
 *
 * `active` traz a fila de trabalho (ASSIGNED + IN_PROGRESS), ordenada por
 * prioridade e agenda — a mesma ordenação da web, para que as duas telas não
 * discordem sobre o que vem primeiro.
 *
 * `completed` traz o histórico recente, com a MESMA janela de 30 dias que a web
 * usa. A constante é importada, não copiada: duas janelas que hoje coincidem
 * por acaso divergiriam na primeira vez que alguém ajustasse uma delas.
 */
export async function listFieldServiceOrders(
  companyId: string,
  technicianId: string,
  options: {
    scope?: FieldOrderScope;
    cursor?: string | null;
    limit?: number;
  } = {},
): Promise<FieldOrderPage> {
  const scope = options.scope ?? "active";
  const take = Math.min(
    Math.max(1, options.limit ?? FIELD_PAGE_SIZE),
    FIELD_MAX_PAGE_SIZE,
  );

  const since = new Date();
  since.setDate(since.getDate() - TECHNICIAN_COMPLETED_WINDOW_DAYS);

  const where =
    scope === "completed"
      ? {
          companyId,
          technicianId,
          status: "COMPLETED" as ServiceOrderStatus,
          completedAt: { gte: since },
        }
      : {
          companyId,
          technicianId,
          status: { in: ACTIVE_STATUSES },
        };

  const rows = await prisma.serviceOrder.findMany({
    where,
    select: LIST_SELECT,
    orderBy:
      scope === "completed"
        ? [{ completedAt: "desc" }, { id: "desc" }]
        : [{ priority: "desc" }, { scheduledAt: "asc" }, { id: "asc" }],
    take: take + 1,
    ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > take;
  const page = hasMore ? rows.slice(0, take) : rows;

  return {
    items: page.map(toFieldListItem),
    nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
  };
}

/**
 * Detalhe da OS, provando posse na mesma consulta.
 *
 * `technicianId` entra no `where`, então uma OS de colega devolve **404**, não
 * 403 — 403 confirmaria que o id existe, que é exatamente o fato que um técnico
 * sondando ids não pode aprender. Mesma escolha já feita por
 * `loadOwnedServiceOrder` e por `GET /api/service-orders/[id]`.
 */
export async function getFieldServiceOrder(
  companyId: string,
  technicianId: string,
  orderId: string,
): Promise<FieldServiceOrderDetail> {
  const order = await prisma.serviceOrder.findFirst({
    where: { id: orderId, companyId, technicianId },
    select: {
      ...LIST_SELECT,
      description: true,
      assignedAt: true,
      startedAt: true,
      customerId: true,
      customer: {
        select: {
          name: true,
          district: true,
          city: true,
          latitude: true,
          longitude: true,
          phone: true,
          secondaryPhone: true,
          address: true,
          number: true,
          complement: true,
          state: true,
          zipCode: true,
        },
      },
      execution: {
        select: {
          id: true,
          diagnosis: true,
          workPerformed: true,
          notes: true,
          version: true,
        },
      },
    },
  });

  if (!order) {
    throw new FieldError("NOT_FOUND", "Ordem de serviço não encontrada.");
  }

  /*
    Conexão do cliente: metadado, nunca segredo.

    `username` e "tem senha" bastam para a tela. O texto claro sai só pela
    revelação explícita, auditada e `no-store` — e não é guardado no aparelho.
  */
  const connection = await prisma.customerConnection.findFirst({
    where: { companyId, customerId: order.customerId, active: true },
    select: {
      id: true,
      type: true,
      username: true,
      credentialCiphertext: true,
    },
    orderBy: { createdAt: "asc" },
  });

  const diagnostic = await getCustomerDiagnostic(companyId, order.customerId);

  return toFieldDetail(order, {
    connection: connection
      ? {
          id: connection.id,
          type: connection.type,
          username: connection.username,
          passwordConfigured: connection.credentialCiphertext !== null,
        }
      : null,
    execution: order.execution
      ? {
          id: order.execution.id,
          diagnosis: order.execution.diagnosis,
          workPerformed: order.execution.workPerformed,
          notes: order.execution.notes,
          version: order.execution.version,
        }
      : null,
    diagnostic: diagnostic
      ? {
          connectivityStatus: diagnostic.connectivityStatus,
          observedAt: diagnostic.observedAt?.toISOString() ?? null,
        }
      : null,
  });
}

/**
 * Resolve o `customerId` de uma OS do técnico, provando posse.
 *
 * Existe para os comandos que precisam do cliente (diagnóstico) sem carregar o
 * detalhe inteiro. Devolve 404 pelo mesmo motivo de sempre.
 */
export async function resolveOwnedOrderCustomer(
  companyId: string,
  technicianId: string,
  orderId: string,
): Promise<{ orderId: string; customerId: string }> {
  const order = await prisma.serviceOrder.findFirst({
    where: { id: orderId, companyId, technicianId },
    select: { id: true, customerId: true },
  });
  if (!order) {
    throw new FieldError("NOT_FOUND", "Ordem de serviço não encontrada.");
  }
  return { orderId: order.id, customerId: order.customerId };
}

// ---------------------------------------------------------------------------
// Fila operacional — leitura autoritativa (DQ-5)
// ---------------------------------------------------------------------------

/**
 * A fila operacional do técnico, na ordem que o despacho definiu.
 *
 * ## Somente leitura, e sem segunda autoridade
 *
 * O técnico **recebe** a ordem; ele não a negocia. Não existe rota de
 * reordenação nem de prioridade no Field, e esta função não calcula ordem
 * nenhuma: ela lê `position` da fila persistida, que já nasceu com a
 * precedência aplicada (`DISPATCH_BAND`, DQ-1). Reordenar aqui criaria uma
 * segunda autoridade, e duas autoridades divergem no primeiro dia.
 *
 * ## Sem fallback
 *
 * Técnico sem fila devolve fila **vazia**, e não o ranking local calculado no
 * servidor. O fallback é decisão do CLIENTE em DQ-6 — por presença do campo
 * `position` —, e escondê-lo aqui dentro faria o aplicativo achar que está
 * obedecendo ao despacho quando não está.
 *
 * ## `inProgress` não vem da fila
 *
 * Vem de `ServiceOrder.status`, que continua sendo a fonte de verdade do que
 * está em atendimento (PRD §321). É coleção: mais de uma é permitido.
 */
export async function getFieldDispatchQueue(
  companyId: string,
  technicianId: string,
): Promise<FieldDispatchQueueDto> {
  const queue = await prisma.technicianDispatchQueue.findFirst({
    where: { companyId, technicianId },
    select: { id: true, version: true },
  });

  const [entries, inProgress] = await Promise.all([
    queue
      ? prisma.technicianDispatchQueueEntry.findMany({
          // `companyId` no predicado, e não navegando a FK até a fila.
          where: { queueId: queue.id, companyId },
          select: { position: true, serviceOrder: { select: LIST_SELECT } },
          orderBy: { position: "asc" },
        })
      : Promise.resolve([]),
    prisma.serviceOrder.findMany({
      where: { companyId, technicianId, status: "IN_PROGRESS" },
      select: LIST_SELECT,
      // Desempate estável: duas leituras pintam a mesma tela.
      orderBy: [{ startedAt: "asc" }, { id: "asc" }],
    }),
  ]);

  return {
    queueVersion: queue?.version ?? 0,
    inProgress: inProgress.map((row) => toFieldQueueItem(row, null)),
    queued: entries.map((e) => toFieldQueueItem(e.serviceOrder, e.position)),
  };
}
