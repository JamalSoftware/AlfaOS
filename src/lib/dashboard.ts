import { prisma } from "./prisma";

export interface DashboardRecentActivity {
  id: string;
  action: string;
  entity: string | null;
  entityId: string | null;
  userName: string | null;
  createdAt: Date;
}

export interface DashboardStats {
  osPendentes: number;
  osEmAtendimento: number;
  osConcluidasHoje: number;
  tecnicosAtivos: number;
  recentActivity: DashboardRecentActivity[];
}

export async function getDashboardStats(
  companyId: string,
): Promise<DashboardStats> {
  const now = new Date();
  const startOfDay = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  );
  const endOfDay = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
  );

  const [
    osPendentes,
    osEmAtendimento,
    osConcluidasHoje,
    tecnicosAtivos,
    recentLogs,
  ] = await Promise.all([
    prisma.serviceOrder.count({
      where: { companyId, status: "PENDING" },
    }),
    prisma.serviceOrder.count({
      where: { companyId, status: { in: ["ASSIGNED", "IN_PROGRESS"] } },
    }),
    prisma.serviceOrder.count({
      where: {
        companyId,
        status: "COMPLETED",
        completedAt: { gte: startOfDay, lt: endOfDay },
      },
    }),
    prisma.technician.count({
      where: { companyId, active: true },
    }),
    prisma.auditLog.findMany({
      where: { companyId },
      orderBy: { createdAt: "desc" },
      take: 10,
      include: { user: { select: { name: true } } },
    }),
  ]);

  return {
    osPendentes,
    osEmAtendimento,
    osConcluidasHoje,
    tecnicosAtivos,
    recentActivity: recentLogs.map((log) => ({
      id: log.id,
      action: log.action,
      entity: log.entity,
      entityId: log.entityId,
      userName: log.user?.name ?? null,
      createdAt: log.createdAt,
    })),
  };
}
