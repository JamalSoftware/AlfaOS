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
