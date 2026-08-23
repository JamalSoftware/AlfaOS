import { describe, it, expect } from "vitest";
import { MockERPAdapter } from "@/integrations/MockERPAdapter";
import { ReceitanetAdapter } from "@/integrations/ReceitanetAdapter";
import { getERPAdapter } from "@/integrations";
import { isIntegrationError } from "@/integrations/errors";

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

  it("getERPAdapter recusa construir ReceitaNet sem credencial", () => {
    // Falha na construção, e não na primeira chamada: um adapter ReceitaNet
    // sem token não tem uso válido.
    expect(() => getERPAdapter("RECEITANET")).toThrow();
    try {
      getERPAdapter("RECEITANET");
    } catch (error) {
      expect(isIntegrationError(error)).toBe(true);
      expect((error as { code: string }).code).toBe("AUTHENTICATION_FAILED");
    }
  });

  it("ReceitaNet distingue API alcançável de credencial validada", async () => {
    // `/ping` responde, mas a chamada autenticada é recusada.
    const adapter = new ReceitanetAdapter({
      token: "token-de-teste",
      fetchImpl: async (url) =>
        url.endsWith("/ping")
          ? { ok: true, status: 200, text: async () => "" }
          : {
              ok: false,
              status: 401,
              text: async () => '{"success":false}',
            },
    });

    const result = await adapter.testConnection();

    expect(result.ok).toBe(false);
    expect(result.provider).toBe("RECEITANET");
    // A distinção é o ponto: alcançável, mas credencial NÃO validada.
    expect(result.reachable).toBe(true);
    expect(result.credentialValidated).toBe(false);
  });
});
