import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type { ServiceOrderStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ServiceOrderEvidencePackageView } from "@/components/ServiceOrderEvidencePackageView";
import type { EvidencePackageSection } from "@/lib/service-order-evidence-package";
import {
  allocateTestServiceOrderNumber,
  createTokenFor,
  seedTestData,
  type TestFixture,
} from "./helpers";

/**
 * # EV-1 — a página `/ordens/[id]/pacote` e o botão na OS
 *
 * A página usa o mesmo portão da tela da OS: sessão, empresa, e o técnico só a
 * própria OS. Aqui se prova pela página — o que o servidor renderiza —, e que o
 * botão "Ver pacote técnico" só aparece na OS concluída.
 */

const session = vi.hoisted(() => ({ token: null as string | null }));

vi.mock("next/headers", () => ({
  cookies: () => ({
    get: (name: string) => (session.token ? { name, value: session.token } : undefined),
  }),
}));

let fixture: TestFixture;
let tecnicoA: { id: string };

beforeEach(async () => {
  fixture = await seedTestData();
  session.token = null;
  tecnicoA = await prisma.technician.create({
    data: { companyId: fixture.companyA.id, userId: fixture.techA.id },
  });
});

async function ordem(status: ServiceOrderStatus) {
  const cliente = await prisma.customer.create({
    data: { companyId: fixture.companyA.id, name: "QA EV Página" },
  });
  return prisma.serviceOrder.create({
    data: {
      companyId: fixture.companyA.id,
      number: await allocateTestServiceOrderNumber(fixture.companyA.id),
      customerId: cliente.id,
      technicianId: tecnicoA.id,
      type: "Instalação",
      description: "QA EV",
      status,
      assignedAt: new Date(),
      ...(status === "IN_PROGRESS" || status === "COMPLETED" ? { startedAt: new Date() } : {}),
      ...(status === "COMPLETED" ? { completedAt: new Date() } : {}),
    },
  });
}

async function paginaPacote(id: string) {
  const { default: Page } = await import("@/app/(app)/ordens/[id]/pacote/page");
  return Page({ params: { id } });
}

async function paginaOs(id: string) {
  const { default: Page } = await import("@/app/(app)/ordens/[id]/page");
  return Page({ params: { id }, searchParams: {} });
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

function secaoDe(no: ReactNode): EvidencePackageSection {
  const el = achar(no, (e) => e.type === ServiceOrderEvidencePackageView);
  if (!el) throw new Error("a página não renderizou o pacote");
  return (el.props as { section: EvidencePackageSection }).section;
}

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

describe("EV-PAGE — quem abre o pacote", () => {
  it("EV-PAGE-01 — técnico dono abre; outro técnico recebe 404", async () => {
    const os = await ordem("COMPLETED");
    session.token = await createTokenFor(fixture.techA.id);
    expect(secaoDe(await paginaPacote(os.id)).state).toBe("ok");

    await prisma.technician.create({ data: { companyId: fixture.companyA.id, userId: fixture.techB.id } });
    session.token = await createTokenFor(fixture.techB.id);
    expect(await digestDe(() => paginaPacote(os.id))).toBe("NEXT_NOT_FOUND");
  });

  it("EV-PAGE-02 — ADMIN de outra empresa recebe 404; ADMIN e DISPATCHER da empresa abrem", async () => {
    const os = await ordem("COMPLETED");
    session.token = await createTokenFor(fixture.adminB.id);
    expect(await digestDe(() => paginaPacote(os.id))).toBe("NEXT_NOT_FOUND");

    session.token = await createTokenFor(fixture.adminA.id);
    expect(secaoDe(await paginaPacote(os.id)).state).toBe("ok");
    session.token = await createTokenFor(fixture.dispatcherA.id);
    expect(secaoDe(await paginaPacote(os.id)).state).toBe("ok");
  });

  it("EV-PAGE-03 — OS em atendimento abre a página dizendo que o pacote ainda não existe", async () => {
    const os = await ordem("IN_PROGRESS");
    session.token = await createTokenFor(fixture.adminA.id);
    expect(secaoDe(await paginaPacote(os.id)).state).toBe("not-completed");
  });

  it("EV-PAGE-04 — sem sessão, a página manda para o login", async () => {
    const os = await ordem("COMPLETED");
    expect(await digestDe(() => paginaPacote(os.id))).toMatch(/^NEXT_REDIRECT;[^;]*;\/login/);
  });

  it("EV-PAGE-05 — o botão 'Ver pacote técnico' só existe na OS concluída", async () => {
    session.token = await createTokenFor(fixture.adminA.id);
    const concluida = await ordem("COMPLETED");
    const emAtendimento = await ordem("IN_PROGRESS");
    const link = (no: ReactNode, id: string) =>
      achar(no, (e) => (e.props as { href?: string } | undefined)?.href === `/ordens/${id}/pacote`);

    expect(link(await paginaOs(concluida.id), concluida.id)).not.toBeNull();
    expect(link(await paginaOs(emAtendimento.id), emAtendimento.id)).toBeNull();
  });
});
