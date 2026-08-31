import type {
  ServiceOrderOrigin,
  ServiceOrderPriority,
  ServiceOrderStatus,
} from "@prisma/client";

/**
 * # Rótulos da OS — apresentação, e nada além disso
 *
 * Vivem separados de `service-orders.ts` por uma razão de **bundle**, não de
 * estética: aquele módulo importa Prisma, `checklists` e `service-order-closing`,
 * que por sua vez importa `node:crypto`. Um componente `"use client"` que
 * quisesse só o rótulo de uma prioridade arrastava essa árvore inteira para o
 * navegador, e o webpack do dev server quebrava em `UnhandledSchemeError:
 * node:crypto`.
 *
 * O arquivo importa **só tipos** do Prisma — `import type` some na compilação —,
 * então é seguro dos dois lados.
 *
 * `service-orders.ts` reexporta tudo daqui, e por isso nenhum chamador
 * existente muda: o caminho antigo continua valendo.
 */

export const SERVICE_ORDER_STATUS_LABELS: Record<ServiceOrderStatus, string> = {
  PENDING: "Pendente",
  ASSIGNED: "Atribuída",
  IN_PROGRESS: "Em atendimento",
  COMPLETED: "Concluída",
  CANCELLED: "Cancelada",
};

export const SERVICE_ORDER_PRIORITY_LABELS: Record<
  ServiceOrderPriority,
  string
> = {
  LOW: "Baixa",
  NORMAL: "Normal",
  HIGH: "Alta",
  URGENT: "Urgente",
};

/**
 * Rótulos de ORIGEM — onde a OS nasceu (PRD §122).
 *
 * Não confundir com `externalProvider`: uma OS INTERNAL pode ganhar vínculo
 * externo depois e continua INTERNAL. A origem é gravada na criação e nunca
 * derivada dos campos externos.
 */
export const SERVICE_ORDER_ORIGIN_LABELS: Record<ServiceOrderOrigin, string> = {
  INTERNAL: "Interna (AlfaOS)",
  EXTERNAL: "Externa (ERP)",
};

/**
 * Rótulo operacional da OS — o único lugar que decide como o número é escrito.
 *
 * Centralizado para que administrativo, tela do técnico e listagem não possam
 * divergir: o operador precisa reconhecer "OS Nº 12" como a mesma coisa em
 * qualquer tela, no telefone e no papel.
 */
export function formatServiceOrderNumber(order: { number: number }): string {
  return `OS Nº ${order.number}`;
}
