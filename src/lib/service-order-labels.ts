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

/**
 * Os estados TERMINAIS da OS. Tudo o que não está aqui está em aberto.
 *
 * ## Por que a lista é a dos fechados, e não a dos abertos
 *
 * Escrita ao contrário — `["PENDING", "ASSIGNED", "IN_PROGRESS"]` — ela
 * envelheceria mal: um estado novo na taxonomia nasceria **fora** da lista e
 * seria tratado como fechado em silêncio, sumindo do mapa sem que nada
 * falhasse. Listando os terminais, um estado novo nasce **aberto**, que é a
 * direção segura: aparecer a mais é visível, sumir não é.
 *
 * ## Ela é a extração de um predicado que já existia espalhado
 *
 * `service-orders.ts` comparava `status === "COMPLETED" || status ===
 * "CANCELLED"` diretamente, e a `CTO-3.2.2` precisaria da mesma pergunta em mais
 * três lugares — mapa, resumo da CTO e busca. Quatro cópias da mesma regra é
 * como uma delas passa a discordar das outras.
 *
 * **A taxonomia não muda aqui.** `CANCELLED` continua declarado e inalcançável
 * em produção (PRD §385), e esta fase não o promove a nada.
 */
export const SERVICE_ORDER_TERMINAL_STATUSES = [
  "COMPLETED",
  "CANCELLED",
] as const satisfies readonly ServiceOrderStatus[];

/**
 * Os estados em ABERTO, derivados dos terminais — e nunca digitados à mão.
 *
 * Derivar é o que garante que as duas listas não possam divergir. Escrever as
 * duas separadamente seria manter duas verdades sobre a mesma taxonomia.
 */
export const OPEN_SERVICE_ORDER_STATUSES: ServiceOrderStatus[] = (
  ["PENDING", "ASSIGNED", "IN_PROGRESS", "COMPLETED", "CANCELLED"] as const
).filter(
  (status) =>
    !(SERVICE_ORDER_TERMINAL_STATUSES as readonly string[]).includes(status),
);

/** A OS está em aberto? Uma pergunta, uma resposta, um lugar. */
export function isOpenServiceOrder(status: ServiceOrderStatus): boolean {
  return !(SERVICE_ORDER_TERMINAL_STATUSES as readonly string[]).includes(
    status,
  );
}

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
