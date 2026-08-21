import {
  notImplemented,
  type ERPConnectionResult,
  type ERPIntegrationContract,
} from "./contract";

/**
 * ReceitanetAdapter (PLACEHOLDER)
 *
 * This is only a structural placeholder. The real ReceitaNet integration
 * will be implemented in a future version, after the official API
 * documentation is provided.
 *
 * No ReceitaNet endpoints are invented here on purpose.
 */
export class ReceitanetAdapter implements ERPIntegrationContract {
  readonly provider = "RECEITANET";

  async testConnection(): Promise<ERPConnectionResult> {
    return {
      ok: false,
      provider: this.provider,
      latencyMs: 0,
      message:
        "Integração com o ReceitaNet ainda não implementada. " +
        "Aguardando documentação oficial da API.",
    };
  }

  fetchClients(): Promise<unknown> {
    return notImplemented(this.provider, "fetchClients");
  }

  fetchServiceOrders(): Promise<unknown> {
    return notImplemented(this.provider, "fetchServiceOrders");
  }

  pushServiceOrder(): Promise<unknown> {
    return notImplemented(this.provider, "pushServiceOrder");
  }
}
