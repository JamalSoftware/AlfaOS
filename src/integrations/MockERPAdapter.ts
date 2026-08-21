import type { ERPConnectionResult, ERPIntegrationContract } from "./contract";

/**
 * MockERPAdapter
 *
 * Simulates an ERP connection for development and tests.
 * Useful for exercising the integration layer (e.g. the "test connection"
 * feature on the Integrations page) without an external ERP system.
 */
export class MockERPAdapter implements ERPIntegrationContract {
  readonly provider = "MOCK";

  async testConnection(): Promise<ERPConnectionResult> {
    const startedAt = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 25));
    return {
      ok: true,
      provider: this.provider,
      latencyMs: Date.now() - startedAt,
      message: "Conexão com o Mock ERP estabelecida com sucesso.",
    };
  }
}
