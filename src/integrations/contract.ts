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

export type ERPServiceOrderPriority = "LOW" | "NORMAL" | "HIGH" | "URGENT";

export interface ERPServiceOrderCustomer {
  externalId: string;
  name: string;
  document?: string;
  phone?: string;
  email?: string;
  address?: string;
  number?: string;
  complement?: string;
  district?: string;
  city?: string;
  state?: string;
  zipCode?: string;
}

export interface ERPServiceOrderPayload {
  externalId: string;
  externalNumber?: string;
  type: string;
  subtype?: string;
  description: string;
  priority?: ERPServiceOrderPriority;
  scheduledAt?: string;
  customer: ERPServiceOrderCustomer;
}

export interface ERPListServiceOrdersResult {
  orders: ERPServiceOrderPayload[];
}

export interface ERPIntegrationContract {
  readonly provider: string;

  /**
   * Verifies connectivity and credentials with the ERP system.
   * Must never throw; connection failures must be returned as `ok: false`.
   */
  testConnection(): Promise<ERPConnectionResult>;

  /**
   * Lists open service orders available for import.
   * Returns a normalized, provider-agnostic payload.
   */
  listServiceOrders?(
    params?: Record<string, unknown>,
  ): Promise<ERPListServiceOrdersResult>;
}
