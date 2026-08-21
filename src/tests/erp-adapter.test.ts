import { describe, it, expect } from "vitest";
import { MockERPAdapter } from "@/integrations/MockERPAdapter";
import { ReceitanetAdapter } from "@/integrations/ReceitanetAdapter";
import { getERPAdapter } from "@/integrations";

describe("Arquitetura de integração ERP", () => {
  it("10. MockERPAdapter consegue executar testConnection()", async () => {
    const adapter = new MockERPAdapter();

    const result = await adapter.testConnection();

    expect(result.ok).toBe(true);
    expect(result.provider).toBe("MOCK");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.message.length).toBeGreaterThan(0);
  });

  it("getERPAdapter retorna MockERPAdapter para provider MOCK", () => {
    const adapter = getERPAdapter("MOCK");
    expect(adapter.provider).toBe("MOCK");
  });

  it("ReceitanetAdapter (placeholder) falha de forma controlada em testConnection()", async () => {
    const adapter = new ReceitanetAdapter();

    const result = await adapter.testConnection();

    expect(result.ok).toBe(false);
    expect(result.provider).toBe("RECEITANET");
  });
});
