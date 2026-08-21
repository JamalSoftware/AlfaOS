import { describe, it, expect, beforeEach } from "vitest";
import { POST as testConnection } from "@/app/api/integrations/test-connection/route";
import { PATCH as toggleIntegration } from "@/app/api/integrations/route";
import { prisma } from "@/lib/prisma";
import {
  apiRequest,
  createTokenFor,
  seedTestData,
  type TestFixture,
} from "./helpers";

let fixture: TestFixture;

beforeEach(async () => {
  fixture = await seedTestData();
});

describe("Integração ERP", () => {
  it("testar conexão não ativa a integração automaticamente", async () => {
    const token = await createTokenFor(fixture.adminA.id);

    const res = await testConnection(
      apiRequest(
        "/api/integrations/test-connection",
        {
          method: "POST",
          body: { provider: "MOCK" },
          headers: { Origin: "http://localhost" },
        },
        token,
      ),
    );

    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.data.integration.enabled).toBe(false);
    expect(payload.data.integration.lastTestStatus).toBe("OK");
    expect(payload.data.result.ok).toBe(true);

    const saved = await prisma.eRPIntegration.findUnique({
      where: { companyId: fixture.companyA.id },
    });
    expect(saved?.enabled).toBe(false);
  });

  it("admin habilita e desabilita a integração explicitamente", async () => {
    const token = await createTokenFor(fixture.adminA.id);

    const enable = await toggleIntegration(
      apiRequest(
        "/api/integrations",
        {
          method: "PATCH",
          body: { enabled: true },
          headers: { Origin: "http://localhost" },
        },
        token,
      ),
    );
    expect(enable.status).toBe(200);
    const enabledPayload = await enable.json();
    expect(enabledPayload.data.integration.enabled).toBe(true);

    const disable = await toggleIntegration(
      apiRequest(
        "/api/integrations",
        {
          method: "PATCH",
          body: { enabled: false },
          headers: { Origin: "http://localhost" },
        },
        token,
      ),
    );
    expect(disable.status).toBe(200);
    const disabledPayload = await disable.json();
    expect(disabledPayload.data.integration.enabled).toBe(false);
  });

  it("apenas admin altera integração (403 para técnico)", async () => {
    const token = await createTokenFor(fixture.techA.id);

    const res = await toggleIntegration(
      apiRequest(
        "/api/integrations",
        {
          method: "PATCH",
          body: { enabled: true },
          headers: { Origin: "http://localhost" },
        },
        token,
      ),
    );

    expect(res.status).toBe(403);
  });
});
