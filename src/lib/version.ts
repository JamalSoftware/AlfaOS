import { z } from "zod";

/**
 * Upper bound of a Postgres `integer`, which is what Prisma maps `Int` to.
 *
 * Optimistic-lock columns (`ServiceOrder.version`, `ServiceOrderExecution
 * .version`) are `Int`. A payload above this range used to reach the driver
 * and surface as a 500 instead of a 400 — a LOW found while benchmarking the
 * security-review skill. Validating at the boundary keeps out-of-range input
 * a client error, where it belongs.
 */
export const INT32_MAX = 2_147_483_647;

/**
 * The canonical schema for every `expectedVersion`-style field in the API.
 *
 * Centralized on purpose: each route that rolls its own `z.number().int()`
 * is one more place the INT32 ceiling can be forgotten.
 */
export const expectedVersionSchema = z
  .number()
  .int()
  .min(0)
  .max(INT32_MAX, "Versão fora da faixa suportada.");
