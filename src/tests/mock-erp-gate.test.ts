import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { getERPAdapter } from "@/integrations";
import { IntegrationError } from "@/integrations/errors";
import { MockERPAdapter } from "@/integrations/MockERPAdapter";
import { isMockErpEnabled } from "@/integrations/mock-availability";
import { assertProviderUsableAfterSwitch } from "@/lib/erp-adapter";
import { syncServiceOrdersFromERP } from "@/lib/erp-sync";
import { prisma } from "@/lib/prisma";
import { SyncERPButton } from "@/components/SyncERPButton";
import { POST as syncRoute } from "@/app/api/integrations/sync/route";
import { POST as testConnectionRoute } from "@/app/api/integrations/test-connection/route";
import { resetCapabilityLimits } from "@/lib/capability-rate-limit";
import { apiRequest, createTokenFor, seedTestData, type TestFixture } from "./helpers";

/**
 * RC-OPS-03 — o Mock ERP não existe em produção.
 *
 * Ele gera clientes e OS de mentira. Em produção, "Sincronizar Mock ERP"
 * importava dado falso para uma empresa real — sem caminho de apagar, e
 * queimando números de OS para sempre.
 *
 * O gate fica em DOIS lugares, e é de propósito: na fábrica do adapter (nenhum
 * dado de mock sai em produção, por caminho nenhum — sincronização, busca de
 * cliente, diagnóstico, teste de conexão, troca de ERP ativo) e na tela (o
 * botão e a opção somem). A linha `ERPIntegration` com `provider = MOCK`
 * continua existindo como "nenhum ERP escolhido ainda": é o único caminho pelo
 * qual uma empresa nova chega a configurar o ERP de verdade, e trocar isso
 * seria fluxo novo, fora do RC.
 */

const session = vi.hoisted(() => ({ token: null as string | null }));

vi.mock("next/headers", () => ({
  cookies: () => ({
    get: (name: string) => (session.token ? { name, value: session.token } : undefined),
  }),
}));

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  usePathname: () => "/ordens",
}));

let fixture: TestFixture;

beforeEach(async () => {
  fixture = await seedTestData();
  session.token = null;
  resetCapabilityLimits();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function emProducao() {
  vi.stubEnv("NODE_ENV", "production");
}

async function integracaoMock(companyId: string) {
  await prisma.eRPIntegration.upsert({
    where: { companyId },
    update: { provider: "MOCK", enabled: true },
    create: { companyId, provider: "MOCK", name: "Mock ERP", enabled: true },
  });
}

function achar(no: ReactNode, pred: (el: ReactElement) => boolean): ReactElement | null {
  if (!no || typeof no !== "object") return null;
  if (Array.isArray(no)) {
    for (const filho of no) {
      const r = achar(filho, pred);
      if (r) return r;
    }
    return null;
  }
  const el = no as ReactElement<{ children?: ReactNode }>;
  if (pred(el)) return el;
  return achar(el.props?.children, pred);
}

function textoDe(no: ReactNode): string {
  if (no === null || no === undefined || typeof no === "boolean") return "";
  if (typeof no === "string" || typeof no === "number") return String(no);
  if (Array.isArray(no)) return no.map(textoDe).join(" ");
  const el = no as ReactElement<{ children?: ReactNode }>;
  return textoDe(el.props?.children);
}

describe("isMockErpEnabled", () => {
  it("fora de produção, sim; em produção, nunca", () => {
    expect(isMockErpEnabled("development")).toBe(true);
    expect(isMockErpEnabled("test")).toBe(true);
    expect(isMockErpEnabled(undefined)).toBe(true);
    expect(isMockErpEnabled("production")).toBe(false);
  });
});

describe("a fábrica do adapter", () => {
  it("em teste, MOCK continua sendo o MockERPAdapter (os testes que dependem dele seguem)", () => {
    expect(getERPAdapter("MOCK")).toBeInstanceOf(MockERPAdapter);
  });

  it("em produção, MOCK não produz adapter — NOT_SUPPORTED", () => {
    emProducao();
    let erro: unknown;
    try {
      getERPAdapter("MOCK");
    } catch (e) {
      erro = e;
    }
    expect(erro).toBeInstanceOf(IntegrationError);
    expect((erro as IntegrationError).code).toBe("NOT_SUPPORTED");
  });

  it("em produção, trocar o ERP ativo PARA o MOCK é recusado", async () => {
    emProducao();
    await expect(assertProviderUsableAfterSwitch(fixture.companyA.id, "MOCK")).rejects.toBeInstanceOf(
      IntegrationError,
    );
  });
});

describe("sincronização", () => {
  it("em teste, sincronizar o Mock importa OS (controle positivo)", async () => {
    await integracaoMock(fixture.companyA.id);
    const r = await syncServiceOrdersFromERP(fixture.companyA.id, fixture.adminA.id);
    expect(r.created).toBeGreaterThan(0);
  });

  it("em produção, o domínio recusa — e nenhuma OS nasce", async () => {
    await integracaoMock(fixture.companyA.id);
    emProducao();
    await expect(
      syncServiceOrdersFromERP(fixture.companyA.id, fixture.adminA.id),
    ).rejects.toMatchObject({ status: 400 });
    expect(await prisma.serviceOrder.count({ where: { companyId: fixture.companyA.id } })).toBe(0);
  });

  it("em produção, a rota também recusa (400), sem importar nada", async () => {
    await integracaoMock(fixture.companyA.id);
    const token = await createTokenFor(fixture.adminA.id);
    emProducao();
    const res = await syncRoute(apiRequest("/api/integrations/sync", { method: "POST" }, token));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Mock ERP/);
    expect(await prisma.serviceOrder.count({ where: { companyId: fixture.companyA.id } })).toBe(0);
  });
});

describe("teste de conexão", () => {
  it("em produção, testar o MOCK não devolve sucesso de mentira", async () => {
    await integracaoMock(fixture.companyA.id);
    const token = await createTokenFor(fixture.adminA.id);
    emProducao();
    const res = await testConnectionRoute(
      apiRequest("/api/integrations/test-connection", { method: "POST", body: { provider: "MOCK" } }, token),
    );
    const body = await res.json();
    expect(body.data?.result?.ok).not.toBe(true);
  });
});

describe("a tela", () => {
  async function paginaDeOrdens() {
    const { default: Page } = await import("@/app/(app)/ordens/page");
    return Page({ searchParams: Promise.resolve({}) });
  }

  it("fora de produção, o ADMIN vê o botão (controle positivo)", async () => {
    session.token = await createTokenFor(fixture.adminA.id);
    const arvore = await paginaDeOrdens();
    expect(achar(arvore, (e) => e.type === SyncERPButton)).not.toBeNull();
  });

  it("em produção, o botão não é renderizado — nem a instrução de sincronizar o Mock", async () => {
    session.token = await createTokenFor(fixture.adminA.id);
    emProducao();
    const arvore = await paginaDeOrdens();
    expect(achar(arvore, (e) => e.type === SyncERPButton)).toBeNull();
    expect(textoDe(arvore)).not.toMatch(/Mock ERP/);
  });

  it("em produção, /integracoes não oferece o Mock nem o anuncia como ERP ativo", async () => {
    await integracaoMock(fixture.companyA.id);
    session.token = await createTokenFor(fixture.adminA.id);
    emProducao();
    const { default: Page } = await import("@/app/(app)/integracoes/page");
    const arvore = await Page();

    const opcoesDoTeste = achar(arvore, (e) => (e.props as { providers?: unknown })?.providers !== undefined);
    expect(opcoesDoTeste).not.toBeNull();
    const provedoresDoTeste = (opcoesDoTeste!.props as { providers: { value: string }[] }).providers;
    expect(provedoresDoTeste.map((p) => p.value)).not.toContain("MOCK");

    const troca = achar(arvore, (e) => (e.props as { options?: unknown })?.options !== undefined);
    const opcoesDaTroca = (troca!.props as { options: { value: string }[] }).options;
    expect(opcoesDaTroca.map((o) => o.value)).not.toContain("MOCK");

    expect(textoDe(arvore)).not.toMatch(/Mock ERP/);
    expect(textoDe(arvore)).toMatch(/Nenhum ERP configurado/);
  });
});
