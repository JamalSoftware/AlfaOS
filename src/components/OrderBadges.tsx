import type { ServiceOrderPriority, ServiceOrderStatus } from "@prisma/client";
import {
  SERVICE_ORDER_PRIORITY_LABELS,
  SERVICE_ORDER_STATUS_LABELS,
} from "@/lib/service-orders";

const STATUS_STYLES: Record<ServiceOrderStatus, string> = {
  PENDING: "bg-amber-50 text-amber-700",
  ASSIGNED: "bg-blue-50 text-blue-700",
  IN_PROGRESS: "bg-violet-50 text-violet-700",
  COMPLETED: "bg-emerald-50 text-emerald-700",
  CANCELLED: "bg-slate-100 text-slate-600",
};

const PRIORITY_STYLES: Record<ServiceOrderPriority, string> = {
  LOW: "bg-slate-100 text-slate-600",
  NORMAL: "bg-blue-50 text-blue-700",
  HIGH: "bg-amber-50 text-amber-700",
  URGENT: "bg-red-50 text-red-700",
};

export function StatusBadge({ status }: { status: ServiceOrderStatus }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUS_STYLES[status]}`}
    >
      {SERVICE_ORDER_STATUS_LABELS[status]}
    </span>
  );
}

export function PriorityBadge({ priority }: { priority: ServiceOrderPriority }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${PRIORITY_STYLES[priority]}`}
    >
      {SERVICE_ORDER_PRIORITY_LABELS[priority]}
    </span>
  );
}
