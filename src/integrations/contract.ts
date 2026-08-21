/**
 * ERPIntegrationContract
 *
 * Contract that decouples AlfaOS from any specific ERP system.
 *
 * All ERP adapters (MockERPAdapter, ReceitanetAdapter, and any future one)
 * must implement this interface. Business code depends only on this contract,
 * never on a concrete adapter.
 *
 * The real ReceitaNet integration will be implemented in a later version,
 * after the official API documentation is provided. Until then, only the
 * MockERPAdapter is fully functional.
 */

export interface ERPConnectionResult {
  ok: boolean;
  provider: string;
  latencyMs: number;
  message: string;
}

export interface ERPClientPayload {
  externalId?: string;
  name: string;
  document?: string;
  email?: string;
  phone?: string;
}

export interface ERPIntegrationContract {
  readonly provider: string;

  /**
   * Verifies connectivity and credentials with the ERP system.
   * Must never throw; connection failures must be returned as `ok: false`.
   */
  testConnection(): Promise<ERPConnectionResult>;

  // ------------------------------------------------------------------
  // Methods below are placeholders for the future integration surface.
  // They will be implemented as the official documentation becomes
  // available. Default implementations return "not implemented" errors
  // so that the contract can evolve without breaking existing adapters.
  // ------------------------------------------------------------------

  fetchClients?(params?: Record<string, unknown>): Promise<unknown>;
  fetchServiceOrders?(params?: Record<string, unknown>): Promise<unknown>;
  pushServiceOrder?(payload: Record<string, unknown>): Promise<unknown>;
}

export function notImplemented(provider: string, method: string): never {
  throw new Error(
    `${provider} adapter: method "${method}" not implemented. ` +
      "It will be implemented once the official ERP API documentation is available.",
  );
}
