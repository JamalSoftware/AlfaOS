import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTokenFor, seedTestData, type TestFixture } from "./helpers";

/**
 * Page guards run inside server components and read the session from
 * `next/headers`. The mock below feeds them a real session token so the guard
 * resolves an actual user from the test database.
 */
const session = vi.hoisted(() => ({ token: null as string | null }));

vi.mock("next/headers", () => ({
  cookies: () => ({
    get: (name: string) =>
      session.token ? { name, value: session.token } : undefined,
  }),
}));

let fixture: TestFixture;

beforeEach(async () => {
  fixture = await seedTestData();
  session.token = null;
});

/** `redirect()` signals control flow by throwing a tagged error. */
async function redirectTargetOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    const digest = (error as { digest?: unknown }).digest;
    if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT")) {
      return digest.split(";")[2] ?? "";
    }
    throw error;
  }
  throw new Error("Esperava um redirect, mas a página renderizou.");
}

describe("Guards de página — /tecnicos", () => {
  it("DISPATCHER não abre /tecnicos/novo (mesma matriz da API, ADMIN-only)", async () => {
    const { default: NewTechnicianPage } = await import(
      "@/app/(app)/tecnicos/novo/page"
    );

    session.token = await createTokenFor(fixture.dispatcherA.id);
    const target = await redirectTargetOf(() => NewTechnicianPage());
    expect(target).toBe("/dashboard");
  });

  it("TECHNICIAN também não abre /tecnicos/novo", async () => {
    const { default: NewTechnicianPage } = await import(
      "@/app/(app)/tecnicos/novo/page"
    );

    session.token = await createTokenFor(fixture.techA.id);
    const target = await redirectTargetOf(() => NewTechnicianPage());
    expect(target).toBe("/minhas-os");
  });

  it("ADMIN abre /tecnicos/novo normalmente", async () => {
    const { default: NewTechnicianPage } = await import(
      "@/app/(app)/tecnicos/novo/page"
    );

    session.token = await createTokenFor(fixture.adminA.id);
    await expect(NewTechnicianPage()).resolves.toBeTruthy();
  });

  it("a listagem de técnicos segue aberta a DISPATCHER", async () => {
    const { default: TechniciansPage } = await import(
      "@/app/(app)/tecnicos/page"
    );

    session.token = await createTokenFor(fixture.dispatcherA.id);
    await expect(TechniciansPage({ searchParams: {} })).resolves.toBeTruthy();
  });
});

/*
  RC-TEST-01 — o TECHNICIAN nunca entra numa página administrativa.

  A matriz de perfis é aplicada por `requirePageProfile` em cada página, e as
  rotas de API por trás delas já tinham teste de negação. As PÁGINAS não: um
  `requirePageProfile(["ADMIN", "TECHNICIAN"])` escrito por engano abriria a
  tela — e o que ela renderiza no servidor — sem nenhum teste acusar.
*/
describe("Guards de página — TECHNICIAN não entra em tela administrativa", () => {
  const PAGINAS: Array<[string, () => Promise<unknown>]> = [
    ["/ctos", async () => (await import("@/app/(app)/ctos/page")).default({ searchParams: {} })],
    [
      "/ctos/[id]",
      async () =>
        (await import("@/app/(app)/ctos/[id]/page")).default({
          params: { id: "qualquer" },
          searchParams: {},
        } as never),
    ],
    ["/configuracoes", async () => (await import("@/app/(app)/configuracoes/page")).default()],
    ["/integracoes", async () => (await import("@/app/(app)/integracoes/page")).default()],
    ["/dispositivos", async () => (await import("@/app/(app)/dispositivos/page")).default()],
    ["/dashboard", async () => (await import("@/app/(app)/dashboard/page")).default()],
    ["/usuarios", async () => (await import("@/app/(app)/usuarios/page")).default()],
    ["/despacho", async () => (await import("@/app/(app)/despacho/page")).default()],
    [
      "/clientes",
      async () => (await import("@/app/(app)/clientes/page")).default({ searchParams: {} }),
    ],
  ];

  it.each(PAGINAS)("%s manda o técnico para /minhas-os", async (_rota, abrir) => {
    session.token = await createTokenFor(fixture.techA.id);
    expect(await redirectTargetOf(abrir)).toBe("/minhas-os");
  });

  it("controle positivo: o ADMIN abre /configuracoes e /dispositivos", async () => {
    session.token = await createTokenFor(fixture.adminA.id);
    const { default: Configuracoes } = await import("@/app/(app)/configuracoes/page");
    const { default: Dispositivos } = await import("@/app/(app)/dispositivos/page");
    await expect(Configuracoes()).resolves.toBeTruthy();
    await expect(Dispositivos()).resolves.toBeTruthy();
  });
});
