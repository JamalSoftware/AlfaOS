/**
 * Presentation helpers for material usage, shared by a Server Component and a
 * Client Component.
 *
 * Deliberately its own module with NO imports: putting these in
 * `service-order-closing.ts` would drag that module's server-only dependency
 * chain (Prisma, `node:crypto` via the storage adapter) into the client
 * bundle, and putting them in the `"use client"` panel would make them client
 * references that a Server Component cannot call.
 */
export const MATERIAL_UNIT_LABELS: Record<string, string> = {
  UNIT: "un",
  METER: "m",
  KILOGRAM: "kg",
  LITER: "L",
};

/** `15.500` out of Decimal(10,3) reads better as `15,5`. */
export function formatMaterialQuantity(quantity: string): string {
  const n = Number(quantity);
  if (!Number.isFinite(n)) return quantity;
  return n.toLocaleString("pt-BR", { maximumFractionDigits: 3 });
}
