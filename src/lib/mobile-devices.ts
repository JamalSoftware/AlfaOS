import { prisma } from "./prisma";

/**
 * Superfície administrativa dos aparelhos do Field.
 *
 * `revokeDevice` existia desde a v0.9 e **nenhuma rota a chamava** — na
 * prática, o ADMIN de uma empresa cujo técnico perdeu o celular não tinha como
 * cortar o acesso pela aplicação. Uma capacidade de segurança que só existe em
 * função exportada é uma capacidade que a operação não tem.
 *
 * Esta camada é deliberadamente pequena: listar e revogar. Sessões por
 * aparelho, versão mínima do app e bloqueio de versão insegura continuam
 * DIFERENCIAL (`docs/SECURITY.md` §8.9), e não entram aqui só porque a tela
 * existe.
 */

export interface AdminMobileDevice {
  id: string;
  /** Quem usa o aparelho. Nome do usuário, não identificador técnico. */
  userName: string;
  userEmail: string;
  platform: string;
  deviceName: string | null;
  appVersion: string | null;
  status: string;
  lastSeenAt: Date | null;
  registeredAt: Date;
  revokedAt: Date | null;
  /**
   * O aparelho tem sessão viva agora?
   *
   * Derivado, não exposto como token: a tela precisa distinguir "revogado" de
   * "só não entrou desde ontem", e nenhuma das duas respostas exige mostrar o
   * hash nem o prazo exato.
   */
  hasActiveSession: boolean;
  /** Está registrado para receber push? Booleano — nunca o token. */
  pushEnabled: boolean;
}

/**
 * Aparelhos da empresa da sessão.
 *
 * `companyId` entra no `where` em SQL e vem sempre da sessão. Não existe
 * parâmetro que alcance outra empresa.
 *
 * O `select` é explícito e **omite `tokenHash`, `pushToken` e
 * `installationId`**: nenhum deles ajuda um administrador a decidir se revoga
 * um aparelho, e os três são exatamente o que não deve estar num payload que
 * passa por navegador, log de proxy e captura de tela de suporte.
 */
export async function listCompanyMobileDevices(
  companyId: string,
  now: Date = new Date(),
): Promise<AdminMobileDevice[]> {
  const devices = await prisma.mobileDevice.findMany({
    where: { companyId },
    select: {
      id: true,
      platform: true,
      deviceName: true,
      appVersion: true,
      status: true,
      lastSeenAt: true,
      registeredAt: true,
      revokedAt: true,
      tokenExpiresAt: true,
      pushToken: true,
      user: { select: { name: true, email: true } },
    },
    orderBy: [{ status: "asc" }, { lastSeenAt: "desc" }, { registeredAt: "desc" }],
  });

  return devices.map((device) => ({
    id: device.id,
    userName: device.user.name,
    userEmail: device.user.email,
    platform: device.platform,
    deviceName: device.deviceName,
    appVersion: device.appVersion,
    status: device.status,
    lastSeenAt: device.lastSeenAt,
    registeredAt: device.registeredAt,
    revokedAt: device.revokedAt,
    hasActiveSession:
      device.status === "ACTIVE" &&
      device.revokedAt === null &&
      device.tokenExpiresAt !== null &&
      device.tokenExpiresAt > now,
    pushEnabled: device.pushToken !== null,
  }));
}

export interface AdminOutboxEvent {
  id: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  status: string;
  attempts: number;
  availableAt: Date;
  processedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
}

/**
 * Eventos do outbox que precisam de atenção humana.
 *
 * Só `FAILED` por padrão: é o único estado que não anda sozinho. `PENDING` e
 * `PROCESSING` se resolvem no próximo ciclo do worker, e listá-los convidaria
 * alguém a "consertar" uma fila que está funcionando.
 *
 * O `payload` **não** entra na projeção. Ele carrega só identificadores, mas a
 * regra vale por construção e não por inspeção: o dia em que alguém acrescentar
 * um campo ao payload, esta tela não passa a exibi-lo.
 */
export async function listCompanyFailedOutboxEvents(
  companyId: string,
  limit = 50,
): Promise<AdminOutboxEvent[]> {
  return prisma.outboxEvent.findMany({
    where: { companyId, status: "FAILED" },
    select: {
      id: true,
      eventType: true,
      aggregateType: true,
      aggregateId: true,
      status: true,
      attempts: true,
      availableAt: true,
      processedAt: true,
      lastError: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(1, limit), 200),
  });
}
