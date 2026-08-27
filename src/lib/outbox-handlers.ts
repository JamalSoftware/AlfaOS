import { prisma } from "./prisma";
import { OUTBOX_EVENTS, type OutboxHandlerContext } from "./outbox";
import { getPushProvider } from "./push/provider";

/**
 * O que o worker faz com cada evento do outbox.
 *
 * Vive separado de `outbox.ts` de propósito: aquele arquivo é o mecanismo
 * (reivindicar, contar tentativa, adiar, esgotar) e não deve saber o que é uma
 * ordem de serviço. Este sabe do domínio e nada do mecanismo.
 *
 * **O worker relê.** O evento carrega só identificadores; o conteúdo vem do
 * banco na hora de processar. Isso não é só higiene de segurança — é o que faz
 * o push refletir o estado atual e não uma fotografia de horas atrás.
 */

function payloadString(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== "object") return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * OS atribuída → avisar o técnico no aparelho.
 *
 * A `Notification` já existe (foi gravada na mesma transação da atribuição), e
 * é dela que saem título e corpo: eles já foram redigidos para caber na tela
 * bloqueada, então reaproveitá-los evita que uma segunda redação, aqui, deixe
 * escapar o que a primeira teve o cuidado de omitir.
 */
async function handleServiceOrderAssigned(
  ctx: OutboxHandlerContext,
): Promise<void> {
  const notificationId = payloadString(ctx.payload, "notificationId");
  if (!notificationId) {
    // Evento antigo ou malformado. Não é retentável — insistir não faz
    // aparecer um identificador que nunca esteve lá.
    console.warn("[outbox] evento de atribuição sem notificationId");
    return;
  }

  const notification = await prisma.notification.findFirst({
    // `companyId` do evento entra no filtro para que o worker respeite o
    // isolamento de tenant sem depender de reconsultar o agregado.
    where: { id: notificationId, companyId: ctx.companyId },
    select: {
      id: true,
      userId: true,
      title: true,
      body: true,
      resourceType: true,
      resourceId: true,
    },
  });
  if (!notification) {
    // A notificação sumiu (empresa removida, por exemplo). Nada a entregar.
    return;
  }

  const devices = await prisma.mobileDevice.findMany({
    where: {
      companyId: ctx.companyId,
      userId: notification.userId,
      status: "ACTIVE",
      revokedAt: null,
      pushToken: { not: null },
    },
    select: { id: true, pushToken: true },
  });

  const tokens = devices
    .map((device) => device.pushToken)
    .filter((token): token is string => Boolean(token));

  if (tokens.length === 0) {
    // Técnico sem aparelho registrado, ou sem permissão de notificação
    // concedida. A Notification interna continua lá — ele vê ao abrir o app.
    return;
  }

  const result = await getPushProvider().send({
    tokens,
    title: notification.title,
    body: notification.body,
    data: {
      type: OUTBOX_EVENTS.SERVICE_ORDER_ASSIGNED,
      ...(notification.resourceType
        ? { resourceType: notification.resourceType }
        : {}),
      ...(notification.resourceId
        ? { resourceId: notification.resourceId }
        : {}),
    },
  });

  /*
    Token recusado em definitivo sai do aparelho.

    Sem isso o worker tentaria para sempre um aplicativo desinstalado, gastando
    tentativa e mascarando falhas reais no meio do ruído. Limpar só o
    `pushToken` — e não revogar o aparelho — porque token morto é um fato sobre
    a permissão de notificação, não sobre o direito de acesso: quem reabrir o
    app registra um token novo e continua com a mesma sessão.
  */
  if (result.invalidTokens.length > 0) {
    const invalid = new Set(result.invalidTokens);
    const stale = devices
      .filter((device) => device.pushToken && invalid.has(device.pushToken))
      .map((device) => device.id);
    if (stale.length > 0) {
      await prisma.mobileDevice.updateMany({
        where: { id: { in: stale }, companyId: ctx.companyId },
        data: { pushToken: null },
      });
    }
  }
}

const HANDLERS: Record<string, (ctx: OutboxHandlerContext) => Promise<void>> = {
  [OUTBOX_EVENTS.SERVICE_ORDER_ASSIGNED]: handleServiceOrderAssigned,
};

/**
 * Despacha pelo tipo. Tipo desconhecido não derruba o worker.
 *
 * Um evento gravado por uma versão mais nova do código, lido por um processo
 * mais antigo, seria retentado até esgotar e apareceria como falha — quando o
 * problema real é só ordem de implantação. Registrar e seguir mantém a fila
 * andando.
 */
export async function handleOutboxEvent(
  ctx: OutboxHandlerContext,
): Promise<void> {
  const handler = HANDLERS[ctx.eventType];
  if (!handler) {
    console.warn(`[outbox] tipo de evento sem handler: ${ctx.eventType}`);
    return;
  }
  await handler(ctx);
}
