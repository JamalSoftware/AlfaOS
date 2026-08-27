import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";

/**
 * # Notificação
 *
 * **A central é o registro; o push é apenas o aviso** (PRD §154).
 *
 * A linha é gravada mesmo quando o push externo falha. Push depende de token
 * válido, aparelho ligado, rede e um terceiro que pode descartar a mensagem
 * sem avisar — um sistema que trate a entrega como o fato perde a atribuição
 * inteira quando o Google decide que aquele token expirou.
 *
 * ## O texto cabe na tela bloqueada
 *
 * A prévia do push é a superfície menos controlada do produto: aparece sobre a
 * tela bloqueada, não passa por autenticação, não expira e pode ficar dias na
 * central do sistema operacional — num aparelho apoiado no painel do carro.
 *
 * **Nunca em notificação:** CPF, senha PPPoE, endereço completo, telefone,
 * diagnóstico detalhado (`docs/SECURITY.md` §8.9).
 *
 * O número operacional da OS identifica sem revelar. O detalhe fica atrás do
 * toque, e a autorização é verificada **na abertura** — `resourceId` é um
 * ponteiro, não uma permissão.
 */

export const NOTIFICATION_TYPES = {
  SERVICE_ORDER_ASSIGNED: "SERVICE_ORDER_ASSIGNED",
} as const;

export type NotificationType =
  (typeof NOTIFICATION_TYPES)[keyof typeof NOTIFICATION_TYPES];

export interface CreateNotificationInput {
  companyId: string;
  userId: string;
  technicianId?: string | null;
  type: NotificationType;
  title: string;
  body: string;
  resourceType?: string | null;
  resourceId?: string | null;
}

/**
 * Cria a notificação DENTRO da transação de quem chama.
 *
 * Mesmo motivo do outbox: se a mudança de domínio sofrer rollback, o aviso não
 * pode sobreviver a ela. Um técnico avisado de uma atribuição que não aconteceu
 * vai até o endereço.
 */
export async function createNotification(
  tx: Prisma.TransactionClient,
  input: CreateNotificationInput,
): Promise<void> {
  await tx.notification.create({
    data: {
      companyId: input.companyId,
      userId: input.userId,
      technicianId: input.technicianId ?? null,
      type: input.type,
      title: input.title,
      body: input.body,
      resourceType: input.resourceType ?? null,
      resourceId: input.resourceId ?? null,
    },
  });
}

export interface PublicNotification {
  id: string;
  type: string;
  title: string;
  body: string;
  resourceType: string | null;
  resourceId: string | null;
  readAt: Date | null;
  createdAt: Date;
}

export interface NotificationPage {
  items: PublicNotification[];
  /** `id` do último item; devolver como `cursor` traz a próxima página. */
  nextCursor: string | null;
  unreadCount: number;
}

export const NOTIFICATION_PAGE_SIZE = 30;
export const NOTIFICATION_MAX_PAGE_SIZE = 100;

/**
 * Página de notificações de UMA pessoa.
 *
 * `companyId` e `userId` vêm da sessão de quem chama e entram no `where` em
 * SQL — não há parâmetro que permita pedir a caixa de outro técnico. Paginação
 * por cursor em vez de `skip/take` porque a lista cresce por cima: com offset,
 * uma notificação nova entre duas páginas empurra um item para trás e o leitor
 * o vê duas vezes.
 */
export async function listNotifications(
  companyId: string,
  userId: string,
  options: { cursor?: string | null; limit?: number } = {},
): Promise<NotificationPage> {
  const take = Math.min(
    Math.max(1, options.limit ?? NOTIFICATION_PAGE_SIZE),
    NOTIFICATION_MAX_PAGE_SIZE,
  );

  const rows = await prisma.notification.findMany({
    where: { companyId, userId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: take + 1,
    ...(options.cursor
      ? { cursor: { id: options.cursor }, skip: 1 }
      : {}),
    select: {
      id: true,
      type: true,
      title: true,
      body: true,
      resourceType: true,
      resourceId: true,
      readAt: true,
      createdAt: true,
    },
  });

  const hasMore = rows.length > take;
  const items = hasMore ? rows.slice(0, take) : rows;

  const unreadCount = await prisma.notification.count({
    where: { companyId, userId, readAt: null },
  });

  return {
    items,
    nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
    unreadCount,
  };
}

/**
 * Marca como lidas. Sem `ids`, marca todas as não lidas da pessoa.
 *
 * `updateMany` com `companyId + userId` no predicado: um id de outra pessoa
 * simplesmente não casa nenhuma linha. Nunca lê antes para conferir dono — a
 * leitura prévia seria uma sonda de existência, e o filtro em SQL já é a
 * garantia.
 *
 * `readAt: null` no predicado torna a operação idempotente sem esforço: marcar
 * de novo o que já está lido não mexe no timestamp original.
 */
export async function markNotificationsRead(
  companyId: string,
  userId: string,
  ids?: string[],
): Promise<number> {
  const result = await prisma.notification.updateMany({
    where: {
      companyId,
      userId,
      readAt: null,
      ...(ids && ids.length > 0 ? { id: { in: ids } } : {}),
    },
    data: { readAt: new Date() },
  });
  return result.count;
}
