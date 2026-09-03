import { describe, it, expect, beforeEach } from "vitest";
import { POST as testConnection } from "@/app/api/integrations/test-connection/route";
import { POST as switchProvider } from "@/app/api/integrations/active-provider/route";
import { prisma } from "@/lib/prisma";
import { resolveCompanyAdapter } from "@/lib/erp-adapter";
import {
  getCredentialFor,
  saveCredentialFor,
} from "@/lib/erp-credential-store";
import {
  getActiveIntegration,
  switchActiveErpProvider,
} from "@/lib/erp-integration";
import { DomainError } from "@/lib/errors";
import {
  apiRequest,
  createTokenFor,
  seedTestData,
  type TestFixture,
} from "./helpers";

/**
 * # `ERP-1` — troca explícita do ERP ativo
 *
 * Cobre `ERP1-01`…`ERP1-18`. Dois defeitos são o assunto:
 *
 * 1. `testConnection` trocava o ERP ativo da empresa;
 * 2. a troca apagava as credenciais do provider anterior.
 *
 * Nada aqui toca a API de provider nenhum: o MockERP responde localmente e o
 * ReceitaNet falha na resolução da credencial, antes de qualquer HTTP.
 */

let fixture: TestFixture;
beforeEach(async () => {
  fixture = await seedTestData();
});

const TOKEN_RN = "token-do-receitanet-1111";
const TOKEN_RN2 = "token-do-receitanet-2222";

/** Empresa com MOCK ativo, que é o estado do seed de produção. */
async function withMockActive(companyId: string) {
  await prisma.eRPIntegration.create({
    data: { companyId, provider: "MOCK", name: "Mock ERP", enabled: true },
  });
}

/** Credencial do ReceitaNet gravada SEM ele ser o ERP ativo. */
async function stageReceitanet(companyId: string, adminId: string, token = TOKEN_RN) {
  await saveCredentialFor(companyId, adminId, "RECEITANET", "CALLCENTER", token);
}

async function activeProviderOf(companyId: string) {
  const row = await prisma.eRPIntegration.findUniqueOrThrow({
    where: { companyId },
    select: { provider: true },
  });
  return row.provider;
}

// ---------------------------------------------------------------------------
// ERP1-01 … ERP1-04 — testar é consultar
// ---------------------------------------------------------------------------

describe("Testar conexão não altera o ERP ativo", () => {
  it("ERP1-01: testar o MESMO provider não troca nada", async () => {
    await withMockActive(fixture.companyA.id);
    const token = await createTokenFor(fixture.adminA.id);

    const res = await testConnection(
      apiRequest(
        "/api/integrations/test-connection",
        { method: "POST", body: { provider: "MOCK" } },
        token,
      ),
    );
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.data.testedActiveProvider).toBe(true);
    expect(await activeProviderOf(fixture.companyA.id)).toBe("MOCK");
  });

  it("ERP1-02: testar um CANDIDATO não troca o ERP ativo", async () => {
    await withMockActive(fixture.companyA.id);
    await stageReceitanet(fixture.companyA.id, fixture.adminA.id);
    const token = await createTokenFor(fixture.adminA.id);

    const res = await testConnection(
      apiRequest(
        "/api/integrations/test-connection",
        { method: "POST", body: { provider: "RECEITANET" } },
        token,
      ),
    );
    expect(res.status).toBe(200);
    const payload = await res.json();

    expect(payload.data.testedActiveProvider).toBe(false);
    expect(payload.data.activeProvider).toBe("MOCK");
    /**
     * A asserção que define a fase. Antes da `ERP-1` esta linha devolvia
     * `RECEITANET`: um clique de diagnóstico redirecionava todo o atendimento
     * da empresa para outro sistema.
     */
    expect(await activeProviderOf(fixture.companyA.id)).toBe("MOCK");
  });

  it("ERP1-03: testar um candidato não apaga a credencial ATIVA", async () => {
    await withMockActive(fixture.companyA.id);
    await saveCredentialFor(
      fixture.companyA.id,
      fixture.adminA.id,
      "MOCK",
      "CALLCENTER",
      "token-do-mock-3333",
    );
    await stageReceitanet(fixture.companyA.id, fixture.adminA.id);
    const token = await createTokenFor(fixture.adminA.id);

    await testConnection(
      apiRequest(
        "/api/integrations/test-connection",
        { method: "POST", body: { provider: "RECEITANET" } },
        token,
      ),
    );

    expect(
      await getCredentialFor(fixture.companyA.id, "MOCK", "CALLCENTER"),
    ).toBe("token-do-mock-3333");
  });

  it("ERP1-04: testar um candidato não apaga a credencial DELE nem de terceiros", async () => {
    await withMockActive(fixture.companyA.id);
    await stageReceitanet(fixture.companyA.id, fixture.adminA.id);
    const token = await createTokenFor(fixture.adminA.id);

    await testConnection(
      apiRequest(
        "/api/integrations/test-connection",
        { method: "POST", body: { provider: "RECEITANET" } },
        token,
      ),
    );

    expect(
      await getCredentialFor(fixture.companyA.id, "RECEITANET", "CALLCENTER"),
    ).toBe(TOKEN_RN);
    expect(
      await prisma.eRPCredential.count({ where: { companyId: fixture.companyA.id } }),
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// ERP1-05 … ERP1-08 — a troca explícita
// ---------------------------------------------------------------------------

describe("Troca explícita do ERP ativo", () => {
  it("ERP1-05: a rota dedicada altera o provider", async () => {
    await withMockActive(fixture.companyA.id);
    await stageReceitanet(fixture.companyA.id, fixture.adminA.id);
    const token = await createTokenFor(fixture.adminA.id);

    const res = await switchProvider(
      apiRequest(
        "/api/integrations/active-provider",
        { method: "POST", body: { provider: "RECEITANET" } },
        token,
      ),
    );
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.data.fromProvider).toBe("MOCK");
    expect(payload.data.toProvider).toBe("RECEITANET");

    expect(await activeProviderOf(fixture.companyA.id)).toBe("RECEITANET");
  });

  it("ERP1-06: a troca PRESERVA a credencial do provider anterior", async () => {
    await withMockActive(fixture.companyA.id);
    await saveCredentialFor(
      fixture.companyA.id,
      fixture.adminA.id,
      "MOCK",
      "CALLCENTER",
      "token-do-mock-3333",
    );
    await stageReceitanet(fixture.companyA.id, fixture.adminA.id);

    await switchActiveErpProvider({
      companyId: fixture.companyA.id,
      actorUserId: fixture.adminA.id,
      provider: "RECEITANET",
    });

    /**
     * Credencial armazenada NÃO significa ERP ativo. As linhas do MOCK ficam
     * cifradas e ociosas, isoladas pelo AAD — e é isso que preserva o rollback:
     * voltar não exige recadastrar token sob pressão.
     */
    expect(
      await getCredentialFor(fixture.companyA.id, "MOCK", "CALLCENTER"),
    ).toBe("token-do-mock-3333");
  });

  it("ERP1-07: voltar reutiliza a credencial preservada, sem recadastro", async () => {
    await withMockActive(fixture.companyA.id);
    await saveCredentialFor(
      fixture.companyA.id,
      fixture.adminA.id,
      "MOCK",
      "CALLCENTER",
      "token-do-mock-3333",
    );
    await stageReceitanet(fixture.companyA.id, fixture.adminA.id);

    const args = { companyId: fixture.companyA.id, actorUserId: fixture.adminA.id };
    await switchActiveErpProvider({ ...args, provider: "RECEITANET" });
    await switchActiveErpProvider({ ...args, provider: "MOCK" });

    expect(await activeProviderOf(fixture.companyA.id)).toBe("MOCK");
    // Ida e volta sem tocar em credencial nenhuma: as duas continuam legíveis.
    expect(
      await getCredentialFor(fixture.companyA.id, "MOCK", "CALLCENTER"),
    ).toBe("token-do-mock-3333");
    expect(
      await getCredentialFor(fixture.companyA.id, "RECEITANET", "CALLCENTER"),
    ).toBe(TOKEN_RN);
  });

  it("ERP1-08: o adapter resolvido acompanha o provider novo", async () => {
    await withMockActive(fixture.companyA.id);
    await stageReceitanet(fixture.companyA.id, fixture.adminA.id);

    const antes = await getActiveIntegration(fixture.companyA.id);
    expect((await resolveCompanyAdapter(fixture.companyA.id, antes!.provider)).provider).toBe(
      "MOCK",
    );

    await switchActiveErpProvider({
      companyId: fixture.companyA.id,
      actorUserId: fixture.adminA.id,
      provider: "RECEITANET",
    });

    /**
     * Nenhum cache pode manter o adapter antigo: a resolução parte da leitura
     * da integração, e a integração já mudou.
     */
    const depois = await getActiveIntegration(fixture.companyA.id);
    expect(depois?.provider).toBe("RECEITANET");
    expect((await resolveCompanyAdapter(fixture.companyA.id, depois!.provider)).provider).toBe(
      "RECEITANET",
    );
  });
});

// ---------------------------------------------------------------------------
// ERP1-09 — sem fallback
// ---------------------------------------------------------------------------

describe("Sem fallback para provider inativo", () => {
  it("ERP1-09: credencial armazenada não cria provider secundário", async () => {
    await withMockActive(fixture.companyA.id);
    // O ReceitaNet tem credencial gravada, mas NÃO é o ERP ativo.
    await stageReceitanet(fixture.companyA.id, fixture.adminA.id);

    const active = await getActiveIntegration(fixture.companyA.id);
    expect(active?.provider).toBe("MOCK");

    const adapter = await resolveCompanyAdapter(
      fixture.companyA.id,
      active!.provider,
    );
    /**
     * O MockERP não implementa busca de cliente. A resposta é a ausência da
     * capability — e **não** "usar o ReceitaNet, que tem credencial e sabe
     * buscar". Credencial ociosa não é um segundo ERP.
     */
    const { supportsCustomerLookup } = await import(
      "@/integrations/customer-lookup"
    );
    expect(supportsCustomerLookup(adapter)).toBe(false);
    expect(adapter.provider).toBe("MOCK");
  });
});

// ---------------------------------------------------------------------------
// ERP1-10 … ERP1-14 — autorização e tenancy
// ---------------------------------------------------------------------------

describe("Autorização e isolamento", () => {
  it("ERP1-10: ADMIN pode trocar", async () => {
    await withMockActive(fixture.companyA.id);
    await stageReceitanet(fixture.companyA.id, fixture.adminA.id);
    const token = await createTokenFor(fixture.adminA.id);

    const res = await switchProvider(
      apiRequest(
        "/api/integrations/active-provider",
        { method: "POST", body: { provider: "RECEITANET" } },
        token,
      ),
    );
    expect(res.status).toBe(200);
  });

  it("ERP1-11: DISPATCHER recebe 403 e nada muda", async () => {
    await withMockActive(fixture.companyA.id);
    await stageReceitanet(fixture.companyA.id, fixture.adminA.id);
    const token = await createTokenFor(fixture.dispatcherA.id);

    const res = await switchProvider(
      apiRequest(
        "/api/integrations/active-provider",
        { method: "POST", body: { provider: "RECEITANET" } },
        token,
      ),
    );
    expect(res.status).toBe(403);
    expect(await activeProviderOf(fixture.companyA.id)).toBe("MOCK");
  });

  it("ERP1-12: TECHNICIAN recebe 403 e nada muda", async () => {
    await withMockActive(fixture.companyA.id);
    await stageReceitanet(fixture.companyA.id, fixture.adminA.id);
    const token = await createTokenFor(fixture.techA.id);

    const res = await switchProvider(
      apiRequest(
        "/api/integrations/active-provider",
        { method: "POST", body: { provider: "RECEITANET" } },
        token,
      ),
    );
    expect(res.status).toBe(403);
    expect(await activeProviderOf(fixture.companyA.id)).toBe("MOCK");
  });

  it("ERP1-13: companyId no corpo é RECUSADO, não ignorado", async () => {
    await withMockActive(fixture.companyA.id);
    await withMockActive(fixture.companyB.id);
    await stageReceitanet(fixture.companyA.id, fixture.adminA.id);
    /**
     * A empresa B fica **pronta para trocar**: integração e credencial de
     * destino no lugar.
     *
     * Sem isso o teste passaria pelo motivo errado. Uma B sem credencial de
     * ReceitaNet faz a troca falhar por precondição, e o 400 apareceria mesmo
     * que o `companyId` do corpo tivesse sido obedecido — o ataque ficaria
     * invisível. Com B pronta, obedecer ao corpo **funcionaria**, e é isso que
     * a asserção precisa proibir.
     */
    await stageReceitanet(fixture.companyB.id, fixture.adminB.id);
    const token = await createTokenFor(fixture.adminA.id);

    const res = await switchProvider(
      apiRequest(
        "/api/integrations/active-provider",
        {
          method: "POST",
          body: { provider: "RECEITANET", companyId: fixture.companyB.id },
        },
        token,
      ),
    );

    /**
     * O schema é `.strict()`: quem envia `companyId` está confuso ou sondando,
     * e um 200 que o ignorasse sugeriria que foi aceito.
     */
    expect(res.status).toBe(400);
    expect(await activeProviderOf(fixture.companyA.id)).toBe("MOCK");
    expect(await activeProviderOf(fixture.companyB.id)).toBe("MOCK");
  });

  it("ERP1-14: a troca alcança APENAS a empresa da sessão", async () => {
    await withMockActive(fixture.companyA.id);
    await withMockActive(fixture.companyB.id);
    await stageReceitanet(fixture.companyA.id, fixture.adminA.id);
    // B também pronta para trocar — ver a nota do `ERP1-13`.
    await stageReceitanet(fixture.companyB.id, fixture.adminB.id);
    const token = await createTokenFor(fixture.adminA.id);

    const res = await switchProvider(
      apiRequest(
        "/api/integrations/active-provider",
        { method: "POST", body: { provider: "RECEITANET" } },
        token,
      ),
    );
    expect(res.status).toBe(200);

    // Controle positivo e negativo no mesmo cenário.
    expect(await activeProviderOf(fixture.companyA.id)).toBe("RECEITANET");
    expect(await activeProviderOf(fixture.companyB.id)).toBe("MOCK");
  });
});

// ---------------------------------------------------------------------------
// ERP1-15 … ERP1-18 — auditoria, histórico, invariantes
// ---------------------------------------------------------------------------

describe("Auditoria, histórico e invariantes", () => {
  it("ERP1-15: a troca é auditada com origem e destino, sem segredo", async () => {
    await withMockActive(fixture.companyA.id);
    await saveCredentialFor(
      fixture.companyA.id,
      fixture.adminA.id,
      "MOCK",
      "CALLCENTER",
      "token-do-mock-3333",
    );
    await stageReceitanet(fixture.companyA.id, fixture.adminA.id);

    await switchActiveErpProvider({
      companyId: fixture.companyA.id,
      actorUserId: fixture.adminA.id,
      provider: "RECEITANET",
    });

    const logs = await prisma.auditLog.findMany({
      where: { companyId: fixture.companyA.id },
    });
    const change = logs.find((l) => l.action === "ERP.ACTIVE_PROVIDER_CHANGED");
    expect(change).toBeDefined();
    expect(change?.userId).toBe(fixture.adminA.id);
    expect(change?.details).toContain("MOCK");
    expect(change?.details).toContain("RECEITANET");

    const dump = JSON.stringify(logs);
    expect(dump).not.toContain("token-do-mock-3333");
    expect(dump).not.toContain(TOKEN_RN);
    expect(dump).not.toContain("3333");
    expect(dump).not.toContain("1111");
  });

  it("ERP1-16: a troca NÃO reescreve identidade externa histórica", async () => {
    await withMockActive(fixture.companyA.id);
    await stageReceitanet(fixture.companyA.id, fixture.adminA.id);

    const customer = await prisma.customer.create({
      data: {
        companyId: fixture.companyA.id,
        name: "Cliente importado do Mock",
        externalProvider: "MOCK",
        externalId: "MOCK-CUST-9",
      },
    });

    await switchActiveErpProvider({
      companyId: fixture.companyA.id,
      actorUserId: fixture.adminA.id,
      provider: "RECEITANET",
    });

    /**
     * `externalProvider` registra DE ONDE o dado veio, não qual ERP está ativo.
     * Converter apagaria a informação de qual sistema originou o cadastro — e é
     * ela que permite conferir um registro antigo com o provedor certo.
     */
    const depois = await prisma.customer.findUniqueOrThrow({
      where: { id: customer.id },
    });
    expect(depois.externalProvider).toBe("MOCK");
    expect(depois.externalId).toBe("MOCK-CUST-9");
  });

  it("ERP1-17: trocar para o provider JÁ ativo é recusado", async () => {
    await withMockActive(fixture.companyA.id);

    /**
     * Erro controlado, e não no-op silencioso: um 200 gravaria
     * `ERP.ACTIVE_PROVIDER_CHANGED` para uma troca que não aconteceu, e a
     * auditoria passaria a conter eventos que a operação nunca viveu.
     */
    await expect(
      switchActiveErpProvider({
        companyId: fixture.companyA.id,
        actorUserId: fixture.adminA.id,
        provider: "MOCK",
      }),
    ).rejects.toBeInstanceOf(DomainError);

    expect(
      await prisma.auditLog.count({
        where: {
          companyId: fixture.companyA.id,
          action: "ERP.ACTIVE_PROVIDER_CHANGED",
        },
      }),
    ).toBe(0);
  });

  it("ERP1-18: o ciphertext não muda após a troca", async () => {
    await withMockActive(fixture.companyA.id);
    await saveCredentialFor(
      fixture.companyA.id,
      fixture.adminA.id,
      "MOCK",
      "CALLCENTER",
      "token-do-mock-3333",
    );
    await stageReceitanet(fixture.companyA.id, fixture.adminA.id);

    const antes = await prisma.eRPCredential.findMany({
      where: { companyId: fixture.companyA.id },
      orderBy: { provider: "asc" },
      select: {
        provider: true,
        credentialCiphertext: true,
        credentialIv: true,
        credentialAuthTag: true,
        credentialLast4: true,
        aadVersion: true,
      },
    });

    await switchActiveErpProvider({
      companyId: fixture.companyA.id,
      actorUserId: fixture.adminA.id,
      provider: "RECEITANET",
    });

    const depois = await prisma.eRPCredential.findMany({
      where: { companyId: fixture.companyA.id },
      orderBy: { provider: "asc" },
      select: {
        provider: true,
        credentialCiphertext: true,
        credentialIv: true,
        credentialAuthTag: true,
        credentialLast4: true,
        aadVersion: true,
      },
    });

    // Nenhuma recifragem, nenhum nonce novo, nenhum last4 alterado.
    expect(depois).toEqual(antes);
  });
});

// ---------------------------------------------------------------------------
// Precondições e concorrência
// ---------------------------------------------------------------------------

describe("Precondições da troca", () => {
  it("recusa trocar para provider sem credencial utilizável", async () => {
    await withMockActive(fixture.companyA.id);
    // Nenhuma credencial de ReceitaNet foi gravada.

    await expect(
      switchActiveErpProvider({
        companyId: fixture.companyA.id,
        actorUserId: fixture.adminA.id,
        provider: "RECEITANET",
      }),
    ).rejects.toBeInstanceOf(DomainError);

    expect(await activeProviderOf(fixture.companyA.id)).toBe("MOCK");
  });

  it("recusa trocar quando a empresa não tem integração", async () => {
    await expect(
      switchActiveErpProvider({
        companyId: fixture.companyA.id,
        actorUserId: fixture.adminA.id,
        provider: "RECEITANET",
      }),
    ).rejects.toBeInstanceOf(DomainError);
  });

  it("duas trocas simultâneas: uma vence, a outra recebe conflito", async () => {
    await withMockActive(fixture.companyA.id);
    await stageReceitanet(fixture.companyA.id, fixture.adminA.id, TOKEN_RN2);

    const args = { companyId: fixture.companyA.id, actorUserId: fixture.adminA.id };
    const results = await Promise.allSettled([
      switchActiveErpProvider({ ...args, provider: "RECEITANET" }),
      switchActiveErpProvider({ ...args, provider: "RECEITANET" }),
    ]);

    /**
     * O `updateMany` é compare-and-set sobre o provider LIDO. Quem chega em
     * segundo encontra `count === 0` e falha — sem gravar auditoria de uma
     * troca que não fez.
     */
    const ok = results.filter((r) => r.status === "fulfilled");
    expect(ok).toHaveLength(1);
    expect(await activeProviderOf(fixture.companyA.id)).toBe("RECEITANET");

    // Exatamente UM evento de troca. Não dois.
    expect(
      await prisma.auditLog.count({
        where: {
          companyId: fixture.companyA.id,
          action: "ERP.ACTIVE_PROVIDER_CHANGED",
        },
      }),
    ).toBe(1);
  });
});
