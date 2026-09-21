import { describe, it, expect, beforeEach, vi } from "vitest";
import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AccessProfile } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { GlobalSearchView, globalSearchHint } from "@/components/GlobalSearchView";
import type { GlobalSearchSection } from "@/lib/global-search";
import { canUseGlobalSearch } from "@/lib/navigation";
import { createTokenFor, seedTestData, type TestFixture } from "./helpers";

/**
 * # GS-1 — a página `/busca`, a tela e o campo do menu
 */

const session = vi.hoisted(() => ({ token: null as string | null }));

vi.mock("next/headers", () => ({
  cookies: () => ({
    get: (name: string) => (session.token ? { name, value: session.token } : undefined),
  }),
}));

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  usePathname: () => "/dashboard",
}));

let fixture: TestFixture;

beforeEach(async () => {
  fixture = await seedTestData();
  session.token = null;
});

async function pagina(q?: string) {
  const { default: Page } = await import("@/app/(app)/busca/page");
  return Page({ searchParams: Promise.resolve(q === undefined ? {} : { q }) });
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

function propsDaTela(no: ReactNode) {
  const el = achar(no, (e) => e.type === GlobalSearchView);
  if (!el) throw new Error("a página não renderizou a busca");
  return el.props as { section: GlobalSearchSection; includesCtos: boolean };
}

async function digestDe(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    const digest = (error as { digest?: unknown }).digest;
    if (typeof digest === "string") return digest;
    throw error;
  }
  throw new Error("Esperava redirect, mas a página renderizou.");
}

const render = (section: GlobalSearchSection, includesCtos = false) =>
  renderToStaticMarkup(createElement(GlobalSearchView, { section, includesCtos }));

describe("GS-PAGE — quem abre /busca", () => {
  it("GS-PAGE-01 — ADMIN busca na própria empresa; a dica cita CTOs só com a rede ligada", async () => {
    const c = await prisma.customer.create({ data: { companyId: fixture.companyA.id, name: "QA GS Página" } });
    session.token = await createTokenFor(fixture.adminA.id);
    let props = propsDaTela(await pagina("QA GS Página"));
    expect(props.section.state).toBe("ok");
    expect(JSON.stringify(props.section)).toContain(c.id);
    expect(props.includesCtos).toBe(false);

    await prisma.company.update({ where: { id: fixture.companyA.id }, data: { ctoNetworkEnabled: true } });
    props = propsDaTela(await pagina("QA GS Página"));
    expect(props.includesCtos).toBe(true);
  });

  it("GS-PAGE-02 — DISPATCHER abre; a dica nunca cita CTOs", async () => {
    await prisma.company.update({ where: { id: fixture.companyA.id }, data: { ctoNetworkEnabled: true } });
    session.token = await createTokenFor(fixture.dispatcherA.id);
    const props = propsDaTela(await pagina());
    expect(props.section).toEqual({ state: "idle" });
    expect(props.includesCtos).toBe(false);
  });

  it("GS-PAGE-03 — TECHNICIAN é mandado para a tela dele; sem sessão, para o login", async () => {
    session.token = await createTokenFor(fixture.techA.id);
    expect(await digestDe(() => pagina("QA"))).toMatch(/^NEXT_REDIRECT;[^;]*;\/minhas-os/);
    session.token = null;
    expect(await digestDe(() => pagina("QA"))).toMatch(/^NEXT_REDIRECT;[^;]*;\/login/);
  });

  it("GS-PAGE-04 — ADMIN de outra empresa não acha o cliente de A (controle: o ADMIN de A acha)", async () => {
    await prisma.customer.create({ data: { companyId: fixture.companyA.id, name: "QA GS Só de A" } });
    session.token = await createTokenFor(fixture.adminB.id);
    const deB = propsDaTela(await pagina("QA GS Só de A")).section;
    expect(deB).toEqual({ state: "ok", term: "QA GS Só de A", groups: [] });
    session.token = await createTokenFor(fixture.adminA.id);
    const deA = propsDaTela(await pagina("QA GS Só de A")).section;
    expect(deA.state === "ok" && deA.groups.length).toBe(1);
  });
});

describe("GS-UI — a tela", () => {
  it("GS-UI-01 — erro é aviso, e nunca 'nenhum resultado'", () => {
    const html = render({ state: "error", term: "Maria" });
    expect(html).toContain('role="alert"');
    expect(html).toContain("Não foi possível buscar agora");
    expect(html).not.toContain("Nenhum resultado");
  });

  it("GS-UI-02 — vazio, curto e longo dizem cada um o que houve", () => {
    expect(render({ state: "ok", term: "Zé", groups: [] })).toContain("Nenhum resultado para “Zé”.");
    expect(render({ state: "too-short", term: "a" })).toContain("Digite pelo menos 2 letras ou números");
    expect(render({ state: "too-long", term: "x" })).toContain("no máximo 60 caracteres");
    const idle = render({ state: "idle" });
    expect(idle).not.toContain("Nenhum resultado");
    expect(idle).not.toContain('role="alert"');
  });

  it("GS-UI-03 — grupos com rótulo, link do próprio registro, inativo marcado e 'ver todos' da listagem", () => {
    const html = render({
      state: "ok",
      term: "Ana",
      groups: [
        {
          type: "CUSTOMER",
          hits: [
            { type: "CUSTOMER", id: "c1", title: "Ana <b>", subtitle: "Centro · Manaus/AM", inactive: true, href: "/clientes/c1/editar" },
          ],
          truncated: true,
          moreHref: "/clientes?search=Ana",
        },
        {
          type: "CTO",
          hits: [{ type: "CTO", id: "k1", title: "CTO Ana", subtitle: "Código A1", inactive: false, href: "/ctos/k1" }],
          truncated: true,
          moreHref: null,
        },
      ],
    });
    expect(html).toContain(">Clientes<");
    expect(html).toContain(">CTOs<");
    expect(html).toContain('href="/clientes/c1/editar"');
    expect(html).toContain('href="/ctos/k1"');
    expect(html).toContain("Ana &lt;b&gt;"); // texto do banco é texto, nunca HTML
    expect(html).toContain(">Inativo<");
    expect(html).toContain('href="/clientes?search=Ana"');
    expect(html).toContain("Ver todos em Clientes");
    expect(html).toContain("Refine o termo para encontrar as outras.");
  });

  it("GS-UI-04 — o formulário é um GET para /busca, com rótulo e o termo preenchido", () => {
    const html = render({ state: "ok", term: "Ana", groups: [] });
    // A ORDEM dos atributos é do renderizador: o React 19 emite `action` antes
    // de `method`, porque passou a tratar `action` de formulário de forma
    // especial. O que importa é a MESMA tag `<form>` ter os dois.
    const form = /<form\b[^>]*>/.exec(html)?.[0] ?? "";
    expect(form).toContain('method="get"');
    expect(form).toContain('action="/busca"');
    expect(html).toContain('<label for="global-search-page"');
    expect(html).toMatch(/<input[^>]*id="global-search-page"[^>]*name="q"[^>]*value="Ana"/);
  });

  it("GS-UI-05 — a dica só cita CTOs para quem pode achá-las", () => {
    expect(globalSearchHint(true)).toContain("CTOs");
    expect(globalSearchHint(false)).not.toContain("CTO");
  });
});

describe("GS-NAV — o campo do menu", () => {
  it("GS-NAV-01 — só ADMIN e DISPATCHER têm a busca", () => {
    expect(canUseGlobalSearch(AccessProfile.ADMIN)).toBe(true);
    expect(canUseGlobalSearch(AccessProfile.DISPATCHER)).toBe(true);
    expect(canUseGlobalSearch(AccessProfile.TECHNICIAN)).toBe(false);
  });

  it("GS-NAV-02 — o menu desenha o campo para ADMIN e DISPATCHER, e não para o TECHNICIAN", async () => {
    const { Sidebar } = await import("@/components/Sidebar");
    const { ThemeProvider } = await import("@/components/ThemeProvider");
    const desenhar = (profile: AccessProfile) =>
      renderToStaticMarkup(
        createElement(
          ThemeProvider,
          null,
          createElement(Sidebar, {
            profile,
            userName: "QA",
            companyName: "QA GS",
            features: { ctoNetworkEnabled: false },
          }),
        ),
      );
    for (const profile of [AccessProfile.ADMIN, AccessProfile.DISPATCHER]) {
      const html = desenhar(profile);
      expect(html, profile).toContain('data-testid="sidebar-search"');
      expect(html, profile).toMatch(/<form[^>]*action="\/busca"/);
    }
    expect(desenhar(AccessProfile.TECHNICIAN)).not.toContain('data-testid="sidebar-search"');
  });
});
