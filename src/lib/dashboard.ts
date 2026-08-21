import { AccessProfile } from "@prisma/client";
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

/**
 * The OS counters are zero because the Service Order module is not
 * implemented yet (no OS table exists). No fake data is used.
 */
export async function getDashboardStats(companyId: string): Promise<DashboardStats> {
  const [tecnicosAtivos, recentLogs] = await Promise.all([
    prisma.user.count({
      where: { companyId, profile: AccessProfile.TECHNICIAN, active: true },
    }),
    prisma.auditLog.findMany({
      where: { companyId },
      orderBy: { createdAt: "desc" },
      take: 10,
      include: { user: { select: { name: true } } },
    }),
  ]);

  return {
    osPendentes: 0,
    osEmAtendimento: 0,
    osConcluidasHoje: 0,
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
