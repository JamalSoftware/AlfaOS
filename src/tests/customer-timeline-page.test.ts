import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { prisma } from "@/lib/prisma";
import { createCto } from "@/lib/cto";
import { connectCustomerToPort } from "@/lib/cto-connections";
import { CustomerTimelineSection } from "@/components/CustomerTimelineSection";
import type { CustomerTimelineSection as TimelineSection } from "@/lib/customer-timeline";
import { createTokenFor, seedTestData, type TestFixture } from "./helpers";
import { NOT_FOUND_DIGEST } from "./support/next-not-found";

/**
 * # TL-1 — a seção dentro da tela do cliente
 *
 * A timeline não tem rota própria: ela é lida pela página `/clientes/[id]/editar`,
 * que já é o portão (ADMIN e DISPATCHER, cliente resolvido sob a empresa da
 * sessão). Aqui se prova que a página passa o perfil da SESSÃO — é ele que
 * decide se CTO e porta entram — e que "Ver eventos anteriores" leva adiante
 * só a origem que a allowlist aceitou.
 */

const session = vi.hoisted(() => ({ token: null as string | null }));

vi.mock("next/headers", () => ({
  cookies: () => ({
    get: (name: string) => (session.token ? { name, value: session.token } : undefined),
  }),
}));

let fixture: TestFixture;
let cliente: { id: string };

beforeEach(async () => {
  fixture = await seedTestData();
  session.token = null;
  await prisma.company.update({
    where: { id: fixture.companyA.id },
    data: { ctoNetworkEnabled: true, timezone: "America/Manaus" },
  });
  cliente = await prisma.customer.create({
    data: { companyId: fixture.companyA.id, name: "QA TL Página" },
  });
});

async function pagina(searchParams: Record<string, string | string[] | undefined> = {}) {
  const { default: EditCustomerPage } = await import("@/app/(app)/clientes/[id]/editar/page");
  return EditCustomerPage({ params: Promise.resolve({ id: cliente.id }), searchParams: Promise.resolve(searchParams) });
}

/** A seção de histórico dentro da árvore que a página devolveu. */
function secao(no: ReactNode): { section: TimelineSection; loadMoreHref: string | null } {
  const achar = (n: ReactNode): ReactElement | null => {
    if (!n || typeof n !== "object") return null;
    if (Array.isArray(n)) {
      for (const filho of n) {
        const r = achar(filho);
        if (r) return r;
      }
      return null;
    }
    const el = n as ReactElement<{ children?: ReactNode }>;
    if (el.type === CustomerTimelineSection) return el;
    return achar(el.props?.children);
  };
  const el = achar(no);
  if (!el) throw new Error("A página não renderizou a seção de histórico.");
  return el.props as { section: TimelineSection; loadMoreHref: string | null };
}

/** `redirect()` e `notFound()` sinalizam controle de fluxo lançando um erro marcado. */
async function digestDe(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    const digest = (error as { digest?: unknown }).digest;
    if (typeof digest === "string") return digest;
    throw error;
  }
  throw new Error("Esperava redirect ou notFound, mas a página renderizou.");
}

async function eventos(quantos: number) {
  const ordem = await prisma.serviceOrder.create({
    data: {
      companyId: fixture.companyA.id,
      number: 9901,
      customerId: cliente.id,
      type: "Instalação",
      description: "QA TL",
      status: "PENDING",
    },
  });
  await prisma.serviceOrderEvent.createMany({
    data: Array.from({ length: quantos }, (_, i) => ({
      companyId: fixture.companyA.id,
      serviceOrderId: ordem.id,
      userId: fixture.adminA.id,
      event: "SERVICE_ORDER_CREATED",
      createdAt: new Date(Date.UTC(2026, 8, 1, 12, i)),
    })),
  });
  return ordem;
}

describe("TL-PAGE-UI — a seção na tela do cliente", () => {
  it("TL-AUTH-01 — TECHNICIAN não abre a tela do cliente, e com ela a timeline", async () => {
    session.token = await createTokenFor(fixture.techA.id);
    expect(await digestDe(() => pagina())).toMatch(/^NEXT_REDIRECT;[^;]*;\/minhas-os;/);
  });

  it("TL-AUTH-02 — ADMIN de outra empresa recebe 404 para o cliente de A", async () => {
    session.token = await createTokenFor(fixture.adminB.id);
    expect(await digestDe(() => pagina())).toBe(NOT_FOUND_DIGEST);
  });

  it("TL-AUTH-03 — a página passa o perfil da SESSÃO: CTO e porta só para o ADMIN", async () => {
    await eventos(1);
    const cto = await createCto(fixture.companyA.id, fixture.adminA.id, {
      name: "QA TL Página",
      capacity: 8,
    });
    const porta = await prisma.cTOPort.findFirstOrThrow({ where: { ctoId: cto.id, number: 1 } });
    await connectCustomerToPort(
      {
        companyId: fixture.companyA.id,
        provenance: { source: "WEB", actorUserId: fixture.adminA.id },
      },
      { customerId: cliente.id, ctoPortId: porta.id },
    );

    session.token = await createTokenFor(fixture.adminA.id);
    const admin = secao(await pagina()).section;
    expect(admin.state === "ok" && admin.data.items.map((i) => i.kind)).toEqual([
      "NETWORK_CONNECTED",
      "OS_CREATED",
    ]);

    session.token = await createTokenFor(fixture.dispatcherA.id);
    const despacho = secao(await pagina()).section;
    expect(despacho.state === "ok" && despacho.data.items.map((i) => i.kind)).toEqual([
      "OS_CREATED",
    ]);
  });

  it("TL-MORE-01 — 'Ver eventos anteriores' aumenta o limite e mantém a origem VALIDADA", async () => {
    const ordem = await eventos(60);
    session.token = await createTokenFor(fixture.adminA.id);

    const primeira = secao(await pagina({ returnTo: `/ordens/${ordem.id}` }));
    expect(primeira.section.state === "ok" && primeira.section.data.items).toHaveLength(50);
    expect(primeira.loadMoreHref).toBe(
      `/clientes/${cliente.id}/editar?returnTo=%2Fordens%2F${ordem.id}&historico=100#historico`,
    );

    const segunda = secao(await pagina({ returnTo: `/ordens/${ordem.id}`, historico: "100" }));
    expect(segunda.section.state === "ok" && segunda.section.data.items).toHaveLength(60);
    expect(segunda.section.state === "ok" && segunda.section.data.hasMore).toBe(false);
  });

  it("TL-MORE-02 — origem forjada não é ecoada; a vista do mapa é remontada dos valores conferidos", async () => {
    await eventos(1);
    session.token = await createTokenFor(fixture.adminA.id);

    const forjada = secao(
      await pagina({ returnTo: "https://evil.example/ordens", historico: "50" }),
    ).loadMoreHref;
    expect(forjada).toBe(`/clientes/${cliente.id}/editar?historico=100#historico`);

    const doMapa = secao(
      await pagina({
        returnTo: "/mapa",
        lat: "-3.1",
        lng: "-60.02",
        z: "16",
        q: "QA TL",
        extra: "<script>",
      }),
    ).loadMoreHref;
    expect(doMapa).toBe(
      `/clientes/${cliente.id}/editar?returnTo=%2Fmapa&lat=-3.100000&lng=-60.020000&z=16&q=QA+TL&historico=100#historico`,
    );
  });

  it("TL-MORE-03 — no teto de 500 não há próximo passo; parâmetro repetido vale pelo primeiro, como o returnTo", async () => {
    await eventos(1);
    session.token = await createTokenFor(fixture.adminA.id);
    expect(secao(await pagina({ historico: "500" })).loadMoreHref).toBeNull();
    const repetido = secao(await pagina({ historico: ["450", "500"] }));
    expect(repetido.section.state === "ok" && repetido.section.data.limit).toBe(450);
  });
});
