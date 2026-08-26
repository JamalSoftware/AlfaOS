import type { ServiceOrderPriority, ServiceOrderStatus } from "@prisma/client";
import {
  SERVICE_ORDER_PRIORITY_LABELS,
  SERVICE_ORDER_STATUS_LABELS,
} from "@/lib/service-orders";
import { StatusPill, type StatusTone } from "./StatusPill";

/**
 * Status e prioridade sobre a mesma pílula do resto do sistema.
 *
 * O que muda por estado é só o TOM — um token semântico —, não uma classe de
 * cor. Foi assim que os badges passaram a acompanhar claro e escuro sem
 * nenhuma condicional de tema.
 */
const STATUS_TONES: Record<ServiceOrderStatus, StatusTone> = {
  PENDING: "warning",
  ASSIGNED: "info",
  IN_PROGRESS: "progress",
  COMPLETED: "success",
  CANCELLED: "neutral",
};

const PRIORITY_TONES: Record<ServiceOrderPriority, StatusTone> = {
  LOW: "neutral",
  NORMAL: "info",
  HIGH: "warning",
  URGENT: "danger",
};

export function StatusBadge({ status }: { status: ServiceOrderStatus }) {
  return (
    <StatusPill
      data-testid="status-badge"
      tone={STATUS_TONES[status]}
      label={SERVICE_ORDER_STATUS_LABELS[status]}
    />
  );
}

export function PriorityBadge({ priority }: { priority: ServiceOrderPriority }) {
  return (
    <StatusPill
      data-testid="priority-badge"
      tone={PRIORITY_TONES[priority]}
      label={SERVICE_ORDER_PRIORITY_LABELS[priority]}
    />
  );
}
