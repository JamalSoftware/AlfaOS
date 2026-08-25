import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { saveCredentialFor } from "@/lib/erp-credential-store";
import {
  apiRequest,
  createTokenFor,
  seedTestData,
  type TestFixture,
} from "./helpers";

/**
 * Teste de conexão POR credencial.
 *
 * O que estes testes protegem: cada botão da tela tem de exercitar a SUA API
 * com a SUA credencial. Um teste que passasse usando o token do bloco vizinho
 * diria ao operador que está tudo bem com uma credencial que ele nem
 * configurou.
 *
 * Nenhum token real — strings inventadas.
 */

const TOKEN_CC = "token-callcenter-ficticio-AAAA";
const TOKEN_CB = "token-chatbot-ficticio-BBBB";

let fixture: TestFixture;
beforeEach(async () => {
  fixture = await seedTestData();
  vi.resetModules();
});

async function integration(companyId: string) {
  await prisma.eRPIntegration.create({
    data: { companyId, provider: "RECEITANET", name: "ReceitaNet", enabled: true },
  });
}

/**
 * Roda a rota com transporte falso, registrando as URLs efetivamente chamadas.
 *
 * O adapter e o cliente nascem DENTRO do grafo recriado por `resetModules`,
 * senão `instanceof IntegrationError` cruza registries e todo erro vira
 * desconhecido — escondendo exatamente o que se mede aqui.
 */
async function callRoute(
  userId: string,
  body: Record<string, unknown>,
  respond: (url: string) => { status: number; payload: string },
) {
  const calls: string[] = [];

  const makeFetch = async (url: string) => {
    calls.push(url);
    const r = respond(url);
    return {
      ok: r.status < 300,
      status: r.status,
      text: async () => r.payload,
      contentType: "application/json",
    };
  };

  vi.doMock("@/lib/erp-adapter", async () => {
    const actual =
      await vi.importActual<typeof import("@/lib/erp-adapter")>("@/lib/erp-adapter");
    const { ReceitanetAdapter } = await import("@/integrations/ReceitanetAdapter");
    const { ReceitanetChatbotClient } = await import(
      "@/integrations/receitanet/ChatbotClient"
    );
    const { getCredentialFor } = await import("@/lib/erp-credential-store");

    return {
      ...actual,
      /** Mantém a resolução REAL da credencial, trocando só o transporte. */
      resolveCompanyAdapter: async (companyId: string) => {
        const token = await getCredentialFor(companyId, "RECEITANET", "CALLCENTER");
        if (!token) throw new Error("sem credencial CALLCENTER");
        return new ReceitanetAdapter({ token, fetchImpl: makeFetch });
      },
      resolveChatbotClient: async (companyId: string) => {
        const token = await getCredentialFor(companyId, "RECEITANET", "CHATBOT");
        if (!token) return null;
        return new ReceitanetChatbotClient({ token, fetchImpl: makeFetch });
      },
    };
  });

  const { POST } = await import("@/app/api/integrations/test-connection/route");
  const token = await createTokenFor(userId);
  const res = await POST(
    apiRequest("/api/integrations/test-connection", { method: "POST", body }, token),
  );
  return { res, calls };
}

const OK_JSON = JSON.stringify({ success: true });

// ---------------------------------------------------------------------------
// Cada botão usa a sua API
// ---------------------------------------------------------------------------

describe("O teste endereça a API pedida", () => {
  beforeEach(async () => {
    await integration(fixture.companyA.id);
    await saveCredentialFor(
      fixture.companyA.id,
      fixture.adminA.id,
      "RECEITANET",
      "CALLCENTER",
      TOKEN_CC,
    );
    await saveCredentialFor(
      fixture.companyA.id,
      fixture.adminA.id,
      "RECEITANET",
      "CHATBOT",
      TOKEN_CB,
    );
  });

  it("CONTROLE POSITIVO: kind=CHATBOT chama /chatbot, nunca /callcenter", async () => {
    const { res, calls } = await callRoute(
      fixture.adminA.id,
      { provider: "RECEITANET", kind: "CHATBOT" },
      () => ({ status: 200, payload: OK_JSON }),
    );

    expect(res.status).toBe(200);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((u) => u.includes("/chatbot/"))).toBe(true);
    expect(calls.some((u) => u.includes("/callcenter/"))).toBe(false);
  });

  it("CONTROLE POSITIVO: kind=CALLCENTER chama /callcenter, nunca /chatbot", async () => {
    const { res, calls } = await callRoute(
      fixture.adminA.id,
      { provider: "RECEITANET", kind: "CALLCENTER" },
      () => ({ status: 200, payload: "[]" }),
    );

    expect(res.status).toBe(200);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((u) => u.includes("/callcenter/"))).toBe(true);
    expect(calls.some((u) => u.includes("/chatbot/"))).toBe(false);
  });

  /**
   * A regressão que importa: cada URL carrega o token da SUA API. Um vazamento
   * cruzado aqui significaria que o botão de uma testou a credencial da outra.
   */
  it("REGRESSÃO: o token do CallCenter nunca aparece numa chamada do Chatbot", async () => {
    const { calls } = await callRoute(
      fixture.adminA.id,
      { provider: "RECEITANET", kind: "CHATBOT" },
      () => ({ status: 200, payload: OK_JSON }),
    );

    expect(calls.join(" ")).toContain(TOKEN_CB);
    expect(calls.join(" ")).not.toContain(TOKEN_CC);
  });
});

// ---------------------------------------------------------------------------
// Isolamento de resultado
// ---------------------------------------------------------------------------

describe("O resultado de uma API não contamina a outra", () => {
  beforeEach(async () => {
    await integration(fixture.companyA.id);
  });

  it("Chatbot não configurado responde NOT_CONFIGURED, sem cair no CallCenter", async () => {
    await saveCredentialFor(
      fixture.companyA.id,
      fixture.adminA.id,
      "RECEITANET",
      "CALLCENTER",
      TOKEN_CC,
    );

    const { res, calls } = await callRoute(
      fixture.adminA.id,
      { provider: "RECEITANET", kind: "CHATBOT" },
      () => ({ status: 200, payload: OK_JSON }),
    );

    const body = await res.json();
    expect(body.data.code).toBe("NOT_CONFIGURED");
    expect(body.data.result.ok).toBe(false);
    // E não tentou nada — muito menos com o token do CallCenter.
    expect(calls).toHaveLength(0);
  });

  /**
   * O teste do Chatbot NÃO pode escrever o `lastTestStatus` compartilhado da
   * integração: isso faria o CallCenter aparecer como testado quando não foi.
   */
  it("REGRESSÃO: testar o Chatbot não altera o último teste da integração", async () => {
    await saveCredentialFor(fixture.companyA.id, fixture.adminA.id, "RECEITANET", "CALLCENTER", TOKEN_CC);
    await saveCredentialFor(fixture.companyA.id, fixture.adminA.id, "RECEITANET", "CHATBOT", TOKEN_CB);

    const antes = await prisma.eRPIntegration.findUniqueOrThrow({
      where: { companyId: fixture.companyA.id },
    });

    await callRoute(
      fixture.adminA.id,
      { provider: "RECEITANET", kind: "CHATBOT" },
      () => ({ status: 200, payload: OK_JSON }),
    );

    const depois = await prisma.eRPIntegration.findUniqueOrThrow({
      where: { companyId: fixture.companyA.id },
    });
    expect(depois.lastTestedAt?.getTime()).toBe(antes.lastTestedAt?.getTime());
    expect(depois.lastTestStatus).toBe(antes.lastTestStatus);
  });

  it("falha do Chatbot devolve o código, sem corpo do provider", async () => {
    await saveCredentialFor(fixture.companyA.id, fixture.adminA.id, "RECEITANET", "CHATBOT", TOKEN_CB);

    const segredo = "senha-do-cliente-que-nao-pode-vazar";
    const { res } = await callRoute(
      fixture.adminA.id,
      { provider: "RECEITANET", kind: "CHATBOT" },
      () => ({ status: 401, payload: JSON.stringify({ senha: segredo }) }),
    );

    const raw = await res.text();
    expect(raw).toContain("AUTHENTICATION_FAILED");
    // Nem o corpo, nem o token, nem a URL (que carrega o token).
    expect(raw).not.toContain(segredo);
    expect(raw).not.toContain(TOKEN_CB);
    expect(raw).not.toContain("api.receitanet.net");
  });

  it("REGRESSÃO: resposta pública do teste não carrega token algum", async () => {
    await saveCredentialFor(fixture.companyA.id, fixture.adminA.id, "RECEITANET", "CALLCENTER", TOKEN_CC);
    await saveCredentialFor(fixture.companyA.id, fixture.adminA.id, "RECEITANET", "CHATBOT", TOKEN_CB);

    for (const kind of ["CALLCENTER", "CHATBOT"] as const) {
      const { res } = await callRoute(
        fixture.adminA.id,
        { provider: "RECEITANET", kind },
        () => ({ status: 200, payload: kind === "CHATBOT" ? OK_JSON : "[]" }),
      );
      const raw = await res.text();
      expect(raw).not.toContain(TOKEN_CC);
      expect(raw).not.toContain(TOKEN_CB);
    }
  });
});

// ---------------------------------------------------------------------------
// Autorização
// ---------------------------------------------------------------------------

describe("Somente ADMIN testa conexão", () => {
  beforeEach(async () => {
    await integration(fixture.companyA.id);
    await saveCredentialFor(fixture.companyA.id, fixture.adminA.id, "RECEITANET", "CHATBOT", TOKEN_CB);
  });

  it.each([
    ["DISPATCHER", "dispatcherA"],
    ["TECHNICIAN", "techA"],
  ])("%s recebe 403", async (_l, key) => {
    const userId = (fixture as unknown as Record<string, { id: string }>)[key].id;
    const { res } = await callRoute(
      userId,
      { provider: "RECEITANET", kind: "CHATBOT" },
      () => ({ status: 200, payload: OK_JSON }),
    );
    expect(res.status).toBe(403);
  });
});
