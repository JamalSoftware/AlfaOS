import { prisma } from "./prisma";

export interface AuditLogData {
  companyId: string;
  userId?: string | null;
  action: string;
  entity?: string | null;
  entityId?: string | null;
  details?: string | null;
}

export async function logAudit(data: AuditLogData): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        companyId: data.companyId,
        userId: data.userId ?? null,
        action: data.action,
        entity: data.entity ?? null,
        entityId: data.entityId ?? null,
        details: data.details ?? null,
      },
    });
  } catch (error) {
    console.error("Failed to write audit log:", error);
  }
}
