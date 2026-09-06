import { describe, it, expect, beforeEach } from "vitest";
import { ERPCredentialKind, ERPProvider } from "@prisma/client";
import { POST as candidateRoute } from "@/app/api/integrations/candidate/route";
import { POST as switchRoute } from "@/app/api/integrations/active-provider/route";
import { getERPAdapter } from "@/integrations";
import { supportsCustomerLookup } from "@/integrations/customer-lookup";
import { supportsDiagnostics } from "@/integrations/diagnostics";
import { supportsServiceTickets } from "@/integrations/service-tickets";
import { SgpAdapter } from "@/integrations/SgpAdapter";
import type { FetchLike } from "@/integrations/sgp/SgpClient";
import { resolveCompanyAdapter, readConfiguredApp } from "@/lib/erp-adapter";
import { getCredentialFor, saveCredentialFor } from "@/lib/erp-credential-store";
import { getActiveIntegration } from "@/lib/erp-integration";
import {
  activateErpProviderWithConfiguration,
  testCandidateConnection,
} from "@/lib/erp-provisioning";
import { DomainError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import {
  apiRequest,
  createTokenFor,
  seedTestData,
  type TestFixture,
} from "./helpers";

/**
 * # `SGP-1` — autenticação, sonda e ativação explícita
 *
 * Cobre `SGP1-01`…`SGP1-27`. **Nenhum teste toca a API real do SGP:** o
 * transporte é injetado, e o resolvedor de DNS também — então SSRF, timeout,
 * 401 e JSON inválido são exercitados de forma determinística e a suíte nunca
 * depende de rede.
 */

let fixture: TestFixture;
beforeEach(async () => {
  fixture = await seedTestData();
});

const BASE_URL = "https://sgp.exemplo.net.br";
const APP = "alfaos";
const TOKEN = "token-do-sgp-abcdef123456";
const PLANO_CONTAS = JSON.stringify([
  { id: 1, codigo: "01", descricao: "RECEITA" },
]);

/** Transporte falso que grava o que foi enviado. */
function recorder(
  respond: (url: string) => { status: number; body: string } | Promise<never>,
) {
  const calls: { url: string; method: string; headers: Record<string, string>; body: string }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    const r = await respond(url);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => r.body };
  };
  return { calls, fetchImpl };
}

async function withReceitanetActive(companyId: string, adminId: string) {
  await prisma.eRPIntegration.create({
    data: { companyId, provider: "RECEITANET", name: "ReceitaNet", enabled: true },
  });
  await saveCredentialFor(companyId, adminId, "RECEITANET", "CALLCENTER", "token-do-receitanet-9999");
}

async function integrationRow(companyId: string) {
  return prisma.eRPIntegration.findUniqueOrThrow({ where: { companyId } });
}

/** Resolvedor de DNS falso: nada aqui consulta a rede. */
const publicDns = async () => [{ address: "203.0.113.10" }];

// ---------------------------------------------------------------------------
// SGP1-01 · SGP1-02 · SGP1-03 — domínio
// ---------------------------------------------------------------------------

describe("Domínio do provider", () => {
  it("SGP1-01: ERPProvider tem SGP", () => {
    expect(ERPProvider.SGP).toBe("SGP");
  });

  it("SGP1-02: ERPCredentialKind tem PUBLIC_API", () => {
    expect(ERPCredentialKind.PUBLIC_API).toBe("PUBLIC_API");
  });

  it("SGP1-03: os valores antigos continuam existindo e utilizáveis", async () => {
    // Existência no enum gerado.
    expect(ERPProvider.MOCK).toBe("MOCK");
    expect(ERPProvider.RECEITANET).toBe("RECEITANET");
    expect(ERPCredentialKind.CALLCENTER).toBe("CALLCENTER");
    expect(ERPCredentialKind.CHATBOT).toBe("CHATBOT");

    /**
     * E utilizáveis de verdade: uma credencial gravada sob os valores antigos
     * decripta. Se a migration tivesse recriado o tipo sem preservar rótulo, o
     * AAD `v2` — que inclui o `kind` — deixaria de conferir.
     */
    await withReceitanetActive(fixture.companyA.id, fixture.adminA.id);
    await saveCredentialFor(
      fixture.companyA.id,
      fixture.adminA.id,
      "RECEITANET",
      "CHATBOT",
      "token-do-chatbot-8888",
    );
    expect(
      await getCredentialFor(fixture.companyA.id, "RECEITANET", "CALLCENTER"),
    ).toBe("token-do-receitanet-9999");
    expect(
      await getCredentialFor(fixture.companyA.id, "RECEITANET", "CHATBOT"),
    ).toBe("token-do-chatbot-8888");
  });
});

// ---------------------------------------------------------------------------
// Transporte
// ---------------------------------------------------------------------------

describe("Transporte do SGP", () => {
  it("envia POST urlencoded com token e app no CORPO, nada na URL", async () => {
    const rec = recorder(() => ({ status: 200, body: PLANO_CONTAS }));
    const adapter = new SgpAdapter({
      baseUrl: BASE_URL,
      app: APP,
      token: TOKEN,
      fetchImpl: rec.fetchImpl,
    });

    const result = await adapter.testConnection();
    expect(result.ok).toBe(true);

    const call = rec.calls[0];
    expect(call.method).toBe("POST");
    expect(call.url).toBe(`${BASE_URL}/api/ura/planoscontas/`);
    expect(call.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(call.body).toContain(`app=${APP}`);
    expect(call.body).toContain(`token=${TOKEN}`);

    // O token NÃO pode estar na URL — ela entra em log, proxy e `Referer`.
    expect(call.url).not.toContain(TOKEN);
    expect(call.url).not.toContain("token");
  });

  it("SGP1-04: sonda bem-sucedida marca alcançável E credencial validada", async () => {
    const rec = recorder(() => ({ status: 200, body: PLANO_CONTAS }));
    const r = await new SgpAdapter({
      baseUrl: BASE_URL, app: APP, token: TOKEN, fetchImpl: rec.fetchImpl,
    }).testConnection();
    expect(r.ok).toBe(true);
    expect(r.reachable).toBe(true);
    expect(r.credentialValidated).toBe(true);
  });

  it("SGP1-05: 401 é alcançável com credencial recusada; timeout não é alcançável", async () => {
    const negado = recorder(() => ({ status: 401, body: "{}" }));
    const r1 = await new SgpAdapter({
      baseUrl: BASE_URL, app: APP, token: TOKEN, fetchImpl: negado.fetchImpl,
    }).testConnection();
    expect(r1.ok).toBe(false);
    /**
     * Um 401 prova que o serviço RESPONDEU. Colapsar isso em "não alcançável"
     * faria o operador procurar problema de rede quando o token é que está
     * errado.
     */
    expect(r1.reachable).toBe(true);
    expect(r1.credentialValidated).toBe(false);

    const travado = recorder(() => {
      const e = new Error("aborted");
      e.name = "AbortError";
      return Promise.reject(e);
    });
    const r2 = await new SgpAdapter({
      baseUrl: BASE_URL, app: APP, token: TOKEN, fetchImpl: travado.fetchImpl,
    }).testConnection();
    expect(r2.ok).toBe(false);
    expect(r2.reachable).toBe(false);
    expect(r2.credentialValidated).toBe(false);
  });

  it("resposta que não é lista vira INVALID_RESPONSE, não sonda aprovada", async () => {
    const rec = recorder(() => ({ status: 200, body: '{"erro":"nao autorizado"}' }));
    const r = await new SgpAdapter({
      baseUrl: BASE_URL, app: APP, token: TOKEN, fetchImpl: rec.fetchImpl,
    }).testConnection();
    // 200 com corpo inesperado NÃO é conexão boa.
    expect(r.ok).toBe(false);
  });

  it("SGP1-10: nenhuma mensagem renderizável carrega token, app ou URL", async () => {
    for (const status of [401, 404, 500, 418]) {
      const rec = recorder(() => ({ status, body: `<html>${TOKEN}</html>` }));
      const r = await new SgpAdapter({
        baseUrl: BASE_URL, app: APP, token: TOKEN, fetchImpl: rec.fetchImpl,
      }).testConnection();
      expect(r.message).not.toContain(TOKEN);
      expect(r.message).not.toContain(APP);
      expect(r.message).not.toContain("sgp.exemplo.net.br");
      // E o corpo do provider também não atravessa.
      expect(r.message).not.toContain("<html>");
    }
  });

  it("adapter sem baseUrl, app ou token não é construído", () => {
    expect(() => new SgpAdapter({ baseUrl: "", app: APP, token: TOKEN })).toThrow();
    expect(() => new SgpAdapter({ baseUrl: BASE_URL, app: "", token: TOKEN })).toThrow();
    expect(() => new SgpAdapter({ baseUrl: BASE_URL, app: APP, token: "" })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// SGP1-06 … SGP1-09 — candidato não persiste
// ---------------------------------------------------------------------------

describe("Configuração candidata", () => {
  /**
   * Testado no SERVIÇO, não pela rota, e de propósito.
   *
   * A afirmação forte é sobre um teste que **passa** e ainda assim não grava
   * nada. Isso exige transporte, e a rota — corretamente — não aceita costura
   * de transporte: um `fetchImpl` vindo do corpo da requisição seria uma
   * superfície de saída controlada por quem chama.
   *
   * A rota é coberta logo abaixo pelo que ela de fato governa: autorização,
   * `.strict()` e o contrato da resposta.
   */
  function testarCandidato(
    responder: (url: string) => { status: number; body: string } | Promise<never>,
  ) {
    const rec = recorder(responder);
    return testCandidateConnection({
      provider: "SGP",
      candidate: { baseUrl: BASE_URL, app: APP, token: TOKEN },
      fetchImpl: rec.fetchImpl,
      dnsResolver: publicDns,
    });
  }

  it("SGP1-06 e SGP1-07: um teste BEM-SUCEDIDO não muda provider nem baseUrl", async () => {
    await withReceitanetActive(fixture.companyA.id, fixture.adminA.id);
    const antes = await integrationRow(fixture.companyA.id);

    const result = await testarCandidato(() => ({ status: 200, body: PLANO_CONTAS }));
    // O teste passou — e é justamente por isso que a asserção vale.
    expect(result.ok).toBe(true);

    const depois = await integrationRow(fixture.companyA.id);
    expect(depois.provider).toBe("RECEITANET");
    expect(depois.baseUrl).toBe(antes.baseUrl);
    expect(depois.baseUrl).toBeNull();
  });

  it("SGP1-08: um teste bem-sucedido não muda config nem a saúde do ERP ativo", async () => {
    await withReceitanetActive(fixture.companyA.id, fixture.adminA.id);
    const antes = await integrationRow(fixture.companyA.id);

    expect((await testarCandidato(() => ({ status: 200, body: PLANO_CONTAS }))).ok).toBe(
      true,
    );

    const depois = await integrationRow(fixture.companyA.id);
    /**
     * Gravar o `app` do SGP em `config` só para testar corromperia a
     * configuração do ERP que está atendendo — é o vetor que o plano proíbe
     * nominalmente.
     */
    expect(depois.config).toEqual(antes.config);
    expect(depois.lastTestedAt?.getTime()).toBe(antes.lastTestedAt?.getTime());
    expect(depois.lastTestStatus).toBe(antes.lastTestStatus);
  });

  it("SGP1-09: o token candidato não é persistido em lugar nenhum", async () => {
    await withReceitanetActive(fixture.companyA.id, fixture.adminA.id);

    expect((await testarCandidato(() => ({ status: 200, body: PLANO_CONTAS }))).ok).toBe(
      true,
    );

    // Nenhuma credencial de SGP foi criada.
    expect(
      await prisma.eRPCredential.count({
        where: { companyId: fixture.companyA.id, provider: "SGP" },
      }),
    ).toBe(0);

    // E o token não aparece em nenhuma linha que a empresa possua.
    const dump = JSON.stringify([
      await prisma.eRPCredential.findMany({ where: { companyId: fixture.companyA.id } }),
      await prisma.eRPIntegration.findMany({ where: { companyId: fixture.companyA.id } }),
      await prisma.auditLog.findMany({ where: { companyId: fixture.companyA.id } }),
    ]);
    expect(dump).not.toContain(TOKEN);
  });

  it("testar não cria integração para empresa sem ERP", async () => {
    expect((await testarCandidato(() => ({ status: 200, body: PLANO_CONTAS }))).ok).toBe(
      true,
    );
    expect(
      await prisma.eRPIntegration.count({ where: { companyId: fixture.companyA.id } }),
    ).toBe(0);
  });

  it("a rota devolve o resultado dizendo que NADA foi ativado", async () => {
    await withReceitanetActive(fixture.companyA.id, fixture.adminA.id);
    const token = await createTokenFor(fixture.adminA.id);

    /**
     * IP literal privado: a validação de SSRF recusa antes de qualquer DNS e
     * antes de qualquer rede, então a rota é exercitada de forma determinística
     * e sem depender de internet.
     */
    const res = await candidateRoute(
      apiRequest(
        "/api/integrations/candidate",
        {
          method: "POST",
          body: {
            action: "test",
            provider: "SGP",
            baseUrl: "https://10.0.0.5",
            app: APP,
            token: TOKEN,
          },
        },
        token,
      ),
    );

    expect(res.status).toBe(400);
    const payload = await res.json();
    // Erro do catálogo: nunca revela IP resolvido nem topologia.
    expect(JSON.stringify(payload)).not.toContain(TOKEN);
    // E nada mudou.
    expect((await integrationRow(fixture.companyA.id)).provider).toBe("RECEITANET");
  });
});

// ---------------------------------------------------------------------------
// SGP1-11 … SGP1-13 — SSRF
// ---------------------------------------------------------------------------

describe("SSRF", () => {
  it("SGP1-11: localhost e loopback são recusados", async () => {
    for (const url of [
      "https://localhost/api",
      "http://127.0.0.1:5432",
      "https://127.1.2.3",
      "https://[::1]/api",
      "https://algo.localhost",
    ]) {
      await expect(
        testCandidateConnection({
          provider: "SGP",
          candidate: { baseUrl: url, app: APP, token: TOKEN },
        }),
      ).rejects.toBeInstanceOf(DomainError);
    }
  });

  it("SGP1-11b: IPv4 embutido em literal IPv6 não escapa do filtro", async () => {
    /*
      Achado da auditoria de release (`SSRF-01`), com exploração demonstrada.

      O guarda tinha a ramificação certa e ela nunca disparava: o parser WHATWG
      de `URL` normaliza `[::ffff:127.0.0.1]` para o hostname `[::ffff:7f00:1]`
      — hexadecimal, sem ponto —, e a verificação só reconhecia a forma
      pontuada. Loopback, metadados de nuvem, RFC1918 e NAT64 atravessavam,
      enquanto `127.0.0.1` e `[::1]` eram corretamente recusados.

      **A asserção vive AQUI, no nível do guarda, e não em `isPrivateAddress`.**
      Essa é a lição do achado: a suíte antiga testava a função auxiliar, onde a
      normalização da URL ainda não aconteceu — e por isso o defeito não
      conseguia aparecer. Testar a unidade não é testar o controle.
    */
    for (const url of [
      "https://[::ffff:127.0.0.1]",
      "https://[::ffff:169.254.169.254]",
      "https://[::ffff:10.0.0.5]",
      "https://[::ffff:192.168.1.1]:8443",
      "https://[::ffff:172.16.0.1]",
      "https://[::127.0.0.1]",
      "https://[64:ff9b::127.0.0.1]",
    ]) {
      await expect(
        testCandidateConnection({
          provider: "SGP",
          candidate: { baseUrl: url, app: APP, token: TOKEN },
        }),
        `deveria recusar ${url}`,
      ).rejects.toBeInstanceOf(DomainError);
    }
  });

  it("SGP1-11c: endereço público em literal IPv6 continua aceito", async () => {
    /*
      Controle positivo. Sem ele, a correção acima passaria mesmo se alguém
      recusasse TODO literal IPv6 — o teste ficaria verde e um SGP hospedado em
      IPv6 pararia de funcionar sem ninguém entender por quê.

      Não há rede aqui: o que se afirma é que o GUARDA deixa passar. A chamada
      falha depois, no transporte, e é isso que o `catch` distingue.
    */
    for (const url of [
      "https://[::ffff:8.8.8.8]",
      "https://[2001:4860:4860::8888]",
    ]) {
      let recusadoPeloGuarda = false;
      try {
        await testCandidateConnection({
          provider: "SGP",
          candidate: { baseUrl: url, app: APP, token: TOKEN },
        });
      } catch (erro) {
        recusadoPeloGuarda = erro instanceof DomainError;
      }
      expect(recusadoPeloGuarda, `${url} não deveria ser barrado`).toBe(false);
    }
  });

  it("SGP1-12: link-local e o endereço de metadados são recusados", async () => {
    for (const url of [
      "https://169.254.169.254/latest/meta-data/",
      "https://169.254.0.1",
      "https://[fe80::1]",
    ]) {
      await expect(
        testCandidateConnection({
          provider: "SGP",
          candidate: { baseUrl: url, app: APP, token: TOKEN },
        }),
      ).rejects.toBeInstanceOf(DomainError);
    }
  });

  it("SGP1-13: RFC1918, CGNAT e nomes internos são recusados", async () => {
    for (const url of [
      "https://10.0.0.5",
      "https://172.16.0.5",
      "https://192.168.1.10",
      "https://100.64.0.1",
      "https://db.internal/api",
      "https://sgp.local",
      "https://metadata/api",
    ]) {
      await expect(
        testCandidateConnection({
          provider: "SGP",
          candidate: { baseUrl: url, app: APP, token: TOKEN },
        }),
      ).rejects.toBeInstanceOf(DomainError);
    }
  });

  it("um NOME que resolve para endereço interno é recusado — regex não bastaria", async () => {
    const { assertSafeOutboundUrl } = await import("@/lib/safe-outbound-url");
    /**
     * `sgp.exemplo.net.br` não tem nada de suspeito no texto. Só a resolução
     * revela que ele aponta para dentro — e é por isso que a validação não
     * pode ser apenas textual.
     */
    await expect(
      assertSafeOutboundUrl(BASE_URL, async () => [{ address: "10.1.2.3" }]),
    ).rejects.toThrow();

    // E quando UM dos endereços é interno, o nome inteiro é recusado.
    await expect(
      assertSafeOutboundUrl(BASE_URL, async () => [
        { address: "203.0.113.10" },
        { address: "127.0.0.1" },
      ]),
    ).rejects.toThrow();

    // Controle positivo: só endereços públicos passam.
    await expect(assertSafeOutboundUrl(BASE_URL, publicDns)).resolves.toMatchObject({
      origin: BASE_URL,
    });
  });

  it("URL com credencial embutida ou fragmento é recusada", async () => {
    const { assertSafeOutboundUrl } = await import("@/lib/safe-outbound-url");
    await expect(
      assertSafeOutboundUrl("https://u:p@sgp.exemplo.net.br", publicDns),
    ).rejects.toThrow();
    await expect(
      assertSafeOutboundUrl("https://sgp.exemplo.net.br/#x", publicDns),
    ).rejects.toThrow();
    await expect(assertSafeOutboundUrl("sgp.exemplo.net.br", publicDns)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// SGP1-14 … SGP1-17 — autorização e tenancy
// ---------------------------------------------------------------------------

describe("Autorização e isolamento", () => {
  async function chamar(userId: string, body: Record<string, unknown>) {
    const token = await createTokenFor(userId);
    return candidateRoute(
      apiRequest("/api/integrations/candidate", { method: "POST", body }, token),
    );
  }

  const corpo = { action: "test", provider: "SGP", baseUrl: BASE_URL, app: APP, token: TOKEN };

  it("SGP1-14: ADMIN passa pela autorização", async () => {
    const res = await chamar(fixture.adminA.id, corpo);
    /**
     * O assunto aqui é AUTORIZAÇÃO, e a asserção é sobre ela: o ADMIN não é
     * barrado. O corpo usa um host de exemplo, que não resolve — então a rota
     * responde 400 pela validação de saída, e é isso que prova que o pedido
     * chegou até a validação em vez de morrer em 403.
     *
     * O caminho de sucesso é coberto no nível do serviço, com transporte e DNS
     * injetados; forçá-lo aqui exigiria a rota aceitar costura de transporte,
     * que é justamente o que ela não deve aceitar.
     */
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(400);
  });

  it("SGP1-15: DISPATCHER recebe 403", async () => {
    expect((await chamar(fixture.dispatcherA.id, corpo)).status).toBe(403);
  });

  it("SGP1-16: TECHNICIAN recebe 403", async () => {
    expect((await chamar(fixture.techA.id, corpo)).status).toBe(403);
  });

  it("SGP1-17: companyId no corpo é RECUSADO, não ignorado", async () => {
    await withReceitanetActive(fixture.companyA.id, fixture.adminA.id);
    await withReceitanetActive(fixture.companyB.id, fixture.adminB.id);

    const res = await chamar(fixture.adminA.id, {
      action: "activate",
      provider: "SGP",
      baseUrl: BASE_URL,
      app: APP,
      token: TOKEN,
      companyId: fixture.companyB.id,
    });

    // `.strict()`: campo desconhecido derruba o parse.
    expect(res.status).toBe(400);
    expect((await integrationRow(fixture.companyA.id)).provider).toBe("RECEITANET");
    expect((await integrationRow(fixture.companyB.id)).provider).toBe("RECEITANET");
  });
});

// ---------------------------------------------------------------------------
// SGP1-18 … SGP1-25 — ativação
// ---------------------------------------------------------------------------

describe("Ativação explícita", () => {
  /**
   * Ativação com transporte e DNS injetados.
   *
   * Usa as costuras que o serviço publica (`fetchImpl`, `dnsResolver`) em vez
   * de espionar o módulo: o ponto de injeção já existe para isso, e mexer no
   * binding do ESM testaria o mock, não o serviço.
   */
  function ativar(
    responder: (url: string) => { status: number; body: string } | Promise<never>,
  ) {
    const rec = recorder(responder);
    return {
      rec,
      run: () =>
        activateErpProviderWithConfiguration({
          companyId: fixture.companyA.id,
          actorUserId: fixture.adminA.id,
          provider: "SGP",
          candidate: { baseUrl: BASE_URL, app: APP, token: TOKEN },
          fetchImpl: rec.fetchImpl,
          dnsResolver: publicDns,
        }),
    };
  }

  it("SGP1-18 e SGP1-20: a ativação retesta no servidor e grava atomicamente", async () => {
    await withReceitanetActive(fixture.companyA.id, fixture.adminA.id);
    const { rec, run } = ativar(() => ({ status: 200, body: PLANO_CONTAS }));

    const change = await run();
    expect(change.fromProvider).toBe("RECEITANET");
    expect(change.toProvider).toBe("SGP");

    /**
     * O reteste ACONTECEU no servidor. Sem esta asserção, uma ativação que
     * confiasse no resultado do browser passaria — e um POST forjado ativaria o
     * SGP com credencial que nunca funcionou.
     */
    expect(rec.calls.length).toBeGreaterThanOrEqual(1);
    expect(rec.calls[0].url).toBe(`${BASE_URL}/api/ura/planoscontas/`);

    // SGP1-20 e SGP1-22: provider, baseUrl, config e credencial, juntos.
    const row = await integrationRow(fixture.companyA.id);
    expect(row.provider).toBe("SGP");
    expect(row.baseUrl).toBe(BASE_URL);
    expect(readConfiguredApp(row.config)).toBe(APP);
    expect(row.lastTestStatus).toBe("OK");

    // SGP1-21: o token vive cifrado, e decripta.
    const cred = await prisma.eRPCredential.findUniqueOrThrow({
      where: {
        companyId_provider_kind: {
          companyId: fixture.companyA.id,
          provider: "SGP",
          kind: "PUBLIC_API",
        },
      },
    });
    expect(cred.credentialCiphertext).not.toBeNull();
    expect(JSON.stringify(cred)).not.toContain(TOKEN);
    expect(cred.aadVersion).toBe("v2");
    expect(await getCredentialFor(fixture.companyA.id, "SGP", "PUBLIC_API")).toBe(
      TOKEN,
    );
  });

  it("SGP1-19 e SGP1-22: reteste falhado não troca o ERP e não grava nada", async () => {
    await withReceitanetActive(fixture.companyA.id, fixture.adminA.id);
    const { run } = ativar(() => ({ status: 401, body: "{}" }));

    await expect(run()).rejects.toBeInstanceOf(DomainError);

    const row = await integrationRow(fixture.companyA.id);
    expect(row.provider).toBe("RECEITANET");
    expect(row.baseUrl).toBeNull();
    expect(readConfiguredApp(row.config)).toBeNull();
    expect(
      await prisma.eRPCredential.count({
        where: { companyId: fixture.companyA.id, provider: "SGP" },
      }),
    ).toBe(0);
    expect(
      await prisma.auditLog.count({
        where: {
          companyId: fixture.companyA.id,
          action: "ERP.ACTIVE_PROVIDER_CHANGED",
        },
      }),
    ).toBe(0);
  });

  it("SGP1-23 e SGP1-24: a credencial do ReceitaNet sobrevive, e não há fallback", async () => {
    await withReceitanetActive(fixture.companyA.id, fixture.adminA.id);
    await ativar(() => ({ status: 200, body: PLANO_CONTAS })).run();

    // SGP1-23: preservada, cifrada e ociosa.
    expect(
      await getCredentialFor(fixture.companyA.id, "RECEITANET", "CALLCENTER"),
    ).toBe("token-do-receitanet-9999");

    /**
     * SGP1-24: e ela NÃO cria um provider secundário. O ERP ativo é o SGP, e o
     * adapter resolvido é o dele — mesmo o ReceitaNet tendo credencial e
     * sabendo buscar cliente.
     */
    const active = await getActiveIntegration(fixture.companyA.id);
    expect(active?.provider).toBe("SGP");
    const adapter = await resolveCompanyAdapter(
      fixture.companyA.id,
      active!.provider,
    );
    expect(adapter.provider).toBe("SGP");
    expect(supportsCustomerLookup(adapter)).toBe(false);
  });

  it("SGP1-25: a auditoria registra origem e destino, sem segredo", async () => {
    await withReceitanetActive(fixture.companyA.id, fixture.adminA.id);
    await ativar(() => ({ status: 200, body: PLANO_CONTAS })).run();

    const logs = await prisma.auditLog.findMany({
      where: { companyId: fixture.companyA.id },
    });
    const change = logs.find((l) => l.action === "ERP.ACTIVE_PROVIDER_CHANGED");
    expect(change).toBeDefined();
    expect(change?.details).toContain("RECEITANET");
    expect(change?.details).toContain("SGP");

    const dump = JSON.stringify(logs);
    expect(dump).not.toContain(TOKEN);
    expect(dump).not.toContain("token-do-receitanet-9999");
    // Nem o `app`, que não é segredo mas também não precisa estar ali.
    expect(change?.details).not.toContain(APP);
  });

  it("duas ativações simultâneas: uma vence, um único evento", async () => {
    await withReceitanetActive(fixture.companyA.id, fixture.adminA.id);
    const a = ativar(() => ({ status: 200, body: PLANO_CONTAS }));
    const b = ativar(() => ({ status: 200, body: PLANO_CONTAS }));

    const results = await Promise.allSettled([a.run(), b.run()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);

    expect((await integrationRow(fixture.companyA.id)).provider).toBe("SGP");
    expect(
      await prisma.auditLog.count({
        where: {
          companyId: fixture.companyA.id,
          action: "ERP.ACTIVE_PROVIDER_CHANGED",
        },
      }),
    ).toBe(1);
  });

  it("ativar o SGP pela rota genérica de troca é recusado", async () => {
    await withReceitanetActive(fixture.companyA.id, fixture.adminA.id);
    const token = await createTokenFor(fixture.adminA.id);

    const res = await switchRoute(
      apiRequest(
        "/api/integrations/active-provider",
        { method: "POST", body: { provider: "SGP" } },
        token,
      ),
    );
    /**
     * O SGP precisa de Base URL, App e Token. A rota genérica só troca entre
     * providers cuja credencial já está gravada — deixá-la tentar acabaria
     * ativando o SGP com a `baseUrl` de outro provider.
     */
    expect(res.status).toBe(400);
    expect((await integrationRow(fixture.companyA.id)).provider).toBe(
      "RECEITANET",
    );
  });

  it("sair do SGP limpa baseUrl e config, para o ReceitaNet não herdar o host", async () => {
    await withReceitanetActive(fixture.companyA.id, fixture.adminA.id);
    await ativar(() => ({ status: 200, body: PLANO_CONTAS })).run();
    expect((await integrationRow(fixture.companyA.id)).baseUrl).toBe(BASE_URL);

    const { switchActiveErpProvider } = await import("@/lib/erp-integration");
    await switchActiveErpProvider({
      companyId: fixture.companyA.id,
      actorUserId: fixture.adminA.id,
      provider: "RECEITANET",
    });

    /**
     * A limpeza é o que torna o ROLLBACK possível.
     *
     * O token não vazaria sem ela — o `ReceitanetCallCenterClient` tem
     * allowlist exata de host e recusa qualquer outro. O efeito real era pior
     * de diagnosticar: a volta para o ReceitaNet **falhava** com "não foi
     * possível autenticar", mandando o operador trocar um token que estava
     * perfeito. Este teste falha se a limpeza sair — e ele falha na própria
     * chamada acima, não numa asserção.
     */
    const row = await integrationRow(fixture.companyA.id);
    expect(row.provider).toBe("RECEITANET");
    expect(row.baseUrl).toBeNull();
    expect(readConfiguredApp(row.config)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SGP1-26 · SGP1-27
// ---------------------------------------------------------------------------

describe("Escopo e histórico", () => {
  it("SGP1-26: o SGP ainda não tem capability de negócio", () => {
    const adapter = getERPAdapter("SGP", {
      baseUrl: BASE_URL,
      app: APP,
      token: TOKEN,
    });

    /**
     * A existência do endpoint na API do SGP não é a capability. Os type guards
     * são estruturais: enquanto o adapter não tiver os métodos, todos respondem
     * `false` sem que ninguém mantenha uma lista.
     */
    expect(supportsCustomerLookup(adapter)).toBe(false);
    expect(supportsDiagnostics(adapter)).toBe(false);
    expect(supportsServiceTickets(adapter)).toBe(false);
    expect(adapter.listServiceOrders).toBeUndefined();
    // E o que ele TEM é o teste de conexão.
    expect(typeof adapter.testConnection).toBe("function");
  });

  it("SGP1-27: ativar o SGP não reescreve identidade externa histórica", async () => {
    await withReceitanetActive(fixture.companyA.id, fixture.adminA.id);
    const customer = await prisma.customer.create({
      data: {
        companyId: fixture.companyA.id,
        name: "Cliente importado do ReceitaNet",
        externalProvider: "RECEITANET",
        externalId: "RN-777",
      },
    });

    const rec = recorder(() => ({ status: 200, body: PLANO_CONTAS }));
    await activateErpProviderWithConfiguration({
      companyId: fixture.companyA.id,
      actorUserId: fixture.adminA.id,
      provider: "SGP",
      candidate: { baseUrl: BASE_URL, app: APP, token: TOKEN },
      fetchImpl: rec.fetchImpl,
      dnsResolver: publicDns,
    });

    const depois = await prisma.customer.findUniqueOrThrow({
      where: { id: customer.id },
    });
    expect(depois.externalProvider).toBe("RECEITANET");
    expect(depois.externalId).toBe("RN-777");
  });
});
