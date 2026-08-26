import {
  formatMaterialQuantity,
  MATERIAL_UNIT_LABELS,
} from "@/lib/material-format";

/**
 * Read-only rendering of everything the closing produced: photos, materials
 * and signature.
 *
 * Used for staff at any status and for the technician once the order is
 * COMPLETED — after closing there is no editing path in the UI at all, which
 * mirrors the server refusing every mutation on a closed order.
 */
export function ServiceOrderClosingReadOnly({
  orderId,
  evidences,
  materials,
  signature,
}: {
  orderId: string;
  evidences: { id: string; originalName: string }[];
  materials: {
    id: string;
    description: string;
    quantity: string;
    unit: string;
  }[];
  signature: { id: string; signerName: string } | null;
}) {
  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-border bg-surface p-5 shadow-sm">
        <h2 className="mb-3 text-base font-semibold text-fg">
          Evidências
        </h2>
        {evidences.length > 0 ? (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {evidences.map((ev) => (
              <li
                key={ev.id}
                className="overflow-hidden rounded-xl border border-border"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/api/service-orders/${orderId}/evidence/${ev.id}/content`}
                  alt={ev.originalName}
                  className="h-24 w-full bg-surface-muted object-cover"
                />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-fg-muted">Nenhuma foto anexada.</p>
        )}
      </section>

      <section className="rounded-2xl border border-border bg-surface p-5 shadow-sm">
        <h2 className="mb-3 text-base font-semibold text-fg">
          Materiais utilizados
        </h2>
        {materials.length > 0 ? (
          <ul className="divide-y divide-border-subtle">
            {materials.map((m) => (
              <li key={m.id} className="flex justify-between gap-3 py-2">
                <span className="min-w-0 flex-1 break-words text-sm text-fg">
                  {m.description}
                </span>
                <span className="shrink-0 text-sm text-fg-secondary">
                  {formatMaterialQuantity(m.quantity)} {MATERIAL_UNIT_LABELS[m.unit] ?? m.unit}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-fg-muted">Nenhum material registrado.</p>
        )}
      </section>

      <section className="rounded-2xl border border-border bg-surface p-5 shadow-sm">
        <h2 className="mb-3 text-base font-semibold text-fg">
          Assinatura do cliente
        </h2>
        {signature ? (
          <div>
            <p className="mb-2 text-sm text-fg">{signature.signerName}</p>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/api/service-orders/${orderId}/signature`}
              alt={`Assinatura de ${signature.signerName}`}
              className="h-32 w-full rounded-xl border border-border bg-surface object-contain"
            />
          </div>
        ) : (
          <p className="text-sm text-fg-muted">Assinatura não coletada.</p>
        )}
      </section>
    </div>
  );
}
