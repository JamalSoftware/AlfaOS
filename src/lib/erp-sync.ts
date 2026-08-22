import { getERPAdapter } from "@/integrations";
import { logAudit } from "./audit";
import { badRequest, notFound } from "./errors";
import { prisma } from "./prisma";
import { importServiceOrder } from "./service-orders";

export interface SyncResult {
  provider: string;
  fetched: number;
  created: number;
  updated: number;
}

/**
 * Idempotent sync: repeated calls must not duplicate service orders.
 * The unique constraint (companyId + provider + externalId) guarantees that
 * the first sync creates the OS and later syncs only refresh external data.
 */
export async function syncServiceOrdersFromERP(
  companyId: string,
  actorId: string,
): Promise<SyncResult> {
  const integration = await prisma.eRPIntegration.findFirst({
    where: { companyId },
  });
  if (!integration) {
    throw notFound("Integração ERP não configurada para esta empresa.");
  }
  if (!integration.enabled) {
    throw badRequest("Integração ERP está desabilitada. Habilite antes de sincronizar.");
  }

  const adapter = getERPAdapter(integration.provider);
  if (!adapter.listServiceOrders) {
    throw badRequest(
      `O provider ${integration.provider} ainda não suporta sincronização de OS.`,
    );
  }

  const result = await adapter.listServiceOrders();

  let created = 0;
  let updated = 0;

  for (const order of result.orders) {
    const outcome = await importServiceOrder(companyId, actorId, {
      externalProvider: integration.provider,
      externalId: order.externalId,
      externalNumber: order.externalNumber,
      type: order.type,
      subtype: order.subtype,
      description: order.description,
      priority: order.priority ?? "NORMAL",
      scheduledAt: order.scheduledAt,
      customer: order.customer,
    });
    if (outcome.created) {
      created += 1;
    } else {
      updated += 1;
    }
  }

  await logAudit({
    companyId,
    userId: actorId,
    action: "ERP.SYNC_SERVICE_ORDERS",
    entity: "ERPIntegration",
    entityId: integration.id,
    details: `Sync ${integration.provider}: ${created} criadas, ${updated} atualizadas, ${result.orders.length} recebidas`,
  });

  return {
    provider: integration.provider,
    fetched: result.orders.length,
    created,
    updated,
  };
}
