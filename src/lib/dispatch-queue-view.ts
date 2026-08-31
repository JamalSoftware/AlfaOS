import type { ServiceOrderPriority, ServiceOrderStatus } from "@prisma/client";
import { prisma } from "./prisma";
import { notFound } from "./errors";

/**
 * # Fila operacional — projeção de leitura (DQ-3)
 *
 * A forma que o despacho Web consome. Separada do serviço porque projeção e
 * mutação mudam por motivos diferentes: acrescentar um campo à tela não deveria
 * abrir o arquivo que decide lock e CAS.
 *
 * ## O menor conjunto suficiente
 *
 * O que está aqui é o que o despachante precisa para decidir a ordem: número,
 * prioridade, posição, tipo, cliente e bairro. **Não** entram CPF, telefone,
 * endereço completo, credencial PPPoE nem payload de provider — vale a §203 do
 * PRD ("dado que não ajuda a decidir não precisa estar na tela") e a
 * `SECURITY.md`.
 *
 * `externalNumber` também fica de fora, embora o shape administrativo da OS já
 * o exponha: a fila responde "em que ordem", e o número no ERP não participa
 * dessa decisão.
 */

export interface DispatchQueueItemView {
  serviceOrderId: string;
  /** Identidade operacional humana. É o que o despachante fala ao telefone. */
  number: number;
  status: ServiceOrderStatus;
  priority: ServiceOrderPriority;
  /** `null` em `inProgress`: OS em atendimento não ocupa posição (PRD §321). */
  position: number | null;
  type: string;
  customerName: string;
  district: string | null;
  city: string | null;
  /**
   * Agendamento real, e nunca derivado da posição (PRD §324).
   *
   * Viaja junto para a tela poder mostrar as duas coisas — mas "1ª da fila" e
   * "próxima agendada" continuam sendo frases diferentes, e a UI as rotula
   * separadamente.
   */
  scheduledAt: string | null;
  /** CAS da OS. Volta como `expectedVersion` numa mutação da própria OS. */
  version: number;
}

export interface DispatchQueueView {
  technician: { id: string; name: string; active: boolean };
  /**
   * CAS da FILA. Volta como `expectedQueueVersion` numa reordenação.
   *
   * Vale `0` quando o técnico ainda não tem fila — que é o mesmo valor com que
   * ela nasce, então a primeira mutação sobre uma fila vazia não é recusada.
   */
  queueVersion: number;
  /**
   * COLEÇÃO, e não um item. O AlfaOS permite mais de uma OS `IN_PROGRESS` por
   * técnico (PRD §321, `D-08`), e escolher uma como "a verdadeira" esconderia
   * trabalho real. Vem de `ServiceOrder.status`, nunca da fila.
   */
  inProgress: DispatchQueueItemView[];
  /** A fila autoritativa, já ordenada por `position` crescente, 1..N. */
  queued: DispatchQueueItemView[];
}

const ITEM_SELECT = {
  id: true,
  number: true,
  status: true,
  priority: true,
  type: true,
  scheduledAt: true,
  version: true,
  customer: { select: { name: true, district: true, city: true } },
} as const;

type ItemRow = {
  id: string;
  number: number;
  status: ServiceOrderStatus;
  priority: ServiceOrderPriority;
  type: string;
  scheduledAt: Date | null;
  version: number;
  customer: { name: string; district: string | null; city: string | null };
};

function toItem(row: ItemRow, position: number | null): DispatchQueueItemView {
  return {
    serviceOrderId: row.id,
    number: row.number,
    status: row.status,
    priority: row.priority,
    position,
    type: row.type,
    customerName: row.customer.name,
    district: row.customer.district,
    city: row.customer.city,
    scheduledAt: row.scheduledAt?.toISOString() ?? null,
    version: row.version,
  };
}

/**
 * A fila de um técnico, escopada por tenant.
 *
 * **Leitura pura: não cria fila.** Um `GET` que criasse a linha faria a simples
 * abertura de uma tela escrever no banco, e um técnico só olhado passaria a ter
 * fila. Sem fila ainda, a resposta é uma fila vazia com `queueVersion: 0` — o
 * mesmo valor com que ela nasceria, então a primeira reordenação não é recusada
 * por CAS.
 *
 * `technicianId` vem da rota e é conferido contra a empresa da SESSÃO. De outra
 * empresa devolve **404**, nunca 403: confirmar que o técnico existe noutro
 * tenant já é enumeração.
 */
export async function getDispatchQueueView(
  companyId: string,
  technicianId: string,
): Promise<DispatchQueueView> {
  const technician = await prisma.technician.findFirst({
    where: { id: technicianId, companyId },
    select: { id: true, active: true, user: { select: { name: true } } },
  });
  if (!technician) {
    throw notFound("Técnico não encontrado nesta empresa.");
  }

  const queue = await prisma.technicianDispatchQueue.findFirst({
    where: { companyId, technicianId },
    select: { id: true, version: true },
  });

  const [entries, inProgress] = await Promise.all([
    queue
      ? prisma.technicianDispatchQueueEntry.findMany({
          where: { queueId: queue.id, companyId },
          select: { position: true, serviceOrder: { select: ITEM_SELECT } },
          // Já ordenada aqui: a tela nunca deveria precisar reordenar nada.
          orderBy: { position: "asc" },
        })
      : Promise.resolve([]),
    prisma.serviceOrder.findMany({
      where: { companyId, technicianId, status: "IN_PROGRESS" },
      select: ITEM_SELECT,
      // Desempate estável para que duas leituras pintem a mesma tela.
      orderBy: [{ startedAt: "asc" }, { id: "asc" }],
    }),
  ]);

  return {
    technician: {
      id: technician.id,
      name: technician.user.name,
      active: technician.active,
    },
    queueVersion: queue?.version ?? 0,
    inProgress: inProgress.map((row) => toItem(row, null)),
    queued: entries.map((e) => toItem(e.serviceOrder, e.position)),
  };
}
