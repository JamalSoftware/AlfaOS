import type { ERPProvider } from "@prisma/client";
import type { ERPIntegrationContract } from "./contract";
import { MockERPAdapter } from "./MockERPAdapter";
import { ReceitanetAdapter } from "./ReceitanetAdapter";

/**
 * Factory that returns the adapter for a given ERP provider.
 * AlfaOS business code should always go through this factory so it never
 * depends on a concrete adapter implementation.
 */
export function getERPAdapter(provider: ERPProvider): ERPIntegrationContract {
  switch (provider) {
    case "RECEITANET":
      return new ReceitanetAdapter();
    case "MOCK":
    default:
      return new MockERPAdapter();
  }
}
