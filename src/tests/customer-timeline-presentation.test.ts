import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CustomerTimelineSection } from "@/components/CustomerTimelineSection";
import type {
  CustomerTimelineItem,
  CustomerTimelineKind,
  CustomerTimelineSection as TimelineSection,
  TimelineOrderRef,
} from "@/lib/customer-timeline";
import {
  CONTACT_CHANNEL_LABELS,
  CONTACT_RESULT_LABELS,
  EVIDENCE_CATEGORY_LABELS,
  IMPEDIMENT_REASON_LABELS,
  LOCATION_REASON_LABELS,
  TIMELINE_KIND_CATEGORY,
  presentTimelineItem,
  timelineOrderLabel,
} from "@/lib/customer-timeline-presentation";

/**
 * # TL-1 — como a timeline fala com o operador
 *
 * Nenhum código cru na tela (`OS_COMPLETED`, `PHONE_CALL`), os mesmos nomes do
 * aplicativo do técnico, e os três estados da seção — erro, vazio e lista —
 * que não se confundem. A seção é renderizada de verdade: é o HTML que o
 * servidor entrega, e é nele que o fuso da empresa tem de aparecer.
 */

const ORDEM: TimelineOrderRef = { id: "os_1", number: 42, type: "Instalação", subtype: "Fibra" };
const INSTANTE = new Date("2026-09-10T02:30:00.000Z");

/** Um item de amostra por tipo — `Record` obriga a cobrir todos. */
const AMOSTRAS: Record<CustomerTimelineKind, CustomerTimelineItem> = {
  OS_CREATED: { id: "a", kind: "OS_CREATED", occurredAt: INSTANTE, actorName: "Ana", order: ORDEM },
  OS_IMPORTED: { id: "b", kind: "OS_IMPORTED", occurredAt: INSTANTE, actorName: null, order: ORDEM },
  OS_ASSIGNED: {
    id: "c",
    kind: "OS_ASSIGNED",
    occurredAt: INSTANTE,
    actorName: "Ana",
    order: ORDEM,
    technicianName: "Bruno",
  },
  OS_REASSIGNED: {
    id: "d",
    kind: "OS_REASSIGNED",
    occurredAt: INSTANTE,
    actorName: "Ana",
    order: ORDEM,
    technicianName: "Carla",
    previousTechnicianName: "Bruno",
  },
  OS_STARTED: { id: "e", kind: "OS_STARTED", occurredAt: INSTANTE, actorName: "Bruno", order: ORDEM },
  OS_COMPLETED: {
    id: "f",
    kind: "OS_COMPLETED",
    occurredAt: INSTANTE,
    actorName: "Bruno",
    order: ORDEM,
    observations: "Cliente pediu retorno.",
  },
  VISIT: {
    id: "g",
    kind: "VISIT",
    occurredAt: INSTANTE,
    actorName: "Bruno",
    order: ORDEM,
    withDeviceLocation: true,
  },
  CONTACT_ATTEMPT: {
    id: "h",
    kind: "CONTACT_ATTEMPT",
    occurredAt: INSTANTE,
    actorName: "Bruno",
    order: ORDEM,
    channel: "PHONE_CALL",
    result: "CUSTOMER_REQUESTED_LATER",
  },
  IMPEDIMENT: {
    id: "i",
    kind: "IMPEDIMENT",
    occurredAt: INSTANTE,
    actorName: "Bruno",
    order: ORDEM,
    reason: "EXTERNAL_NETWORK_ISSUE",
  },
  PHOTOS: {
    id: "j",
    kind: "PHOTOS",
    occurredAt: INSTANTE,
    actorName: null,
    order: ORDEM,
    total: 3,
    categories: [
      { category: "ONU_ONT", count: 2 },
      { category: "CABLE_ROUTE", count: 1 },
    ],
  },
  SPEED_TEST: { id: "k", kind: "SPEED_TEST", occurredAt: INSTANTE, actorName: "Bruno", order: ORDEM },
  OPTICAL_READING: {
    id: "l",
    kind: "OPTICAL_READING",
    occurredAt: INSTANTE,
    actorName: "Bruno",
    order: ORDEM,
  },
  SIGNATURE: {
    id: "m",
    kind: "SIGNATURE",
    occurredAt: INSTANTE,
    actorName: "Bruno",
    order: ORDEM,
    signerName: "Dona Maria",
  },
  EQUIPMENT_INSTALLED: {
    id: "n",
    kind: "EQUIPMENT_INSTALLED",
    occurredAt: INSTANTE,
    actorName: "Bruno",
    order: ORDEM,
    equipmentType: "ONU",
    manufacturer: "Huawei",
    model: "HG8245",
    serial: "S123",
  },
  NETWORK_CONNECTED: {
    id: "o",
    kind: "NETWORK_CONNECTED",
    occurredAt: INSTANTE,
    actorName: "Bruno",
    order: ORDEM,
    cto: { id: "cto_1", name: "CTO Centro 01" },
    portNumber: 4,
    source: "FIELD",
    reason: null,
  },
  NETWORK_DISCONNECTED: {
    id: "p",
    kind: "NETWORK_DISCONNECTED",
    occurredAt: INSTANTE,
    actorName: null,
    order: null,
    cto: { id: "cto_1", name: "CTO Centro 01" },
    portNumber: 4,
    source: "WEB",
    reason: "Cliente suspenso",
  },
  LOCATION_CONFIRMED: {
    id: "q",
    kind: "LOCATION_CONFIRMED",
    occurredAt: INSTANTE,
    actorName: "Bruno",
    order: ORDEM,
    reason: "OTHER",
  },
  LOCATION_CORRECTED: {
    id: "r",
    kind: "LOCATION_CORRECTED",
    occurredAt: INSTANTE,
    actorName: "Bruno",
    order: ORDEM,
    reason: "INCORRECT_LOCATION",
  },
  ADDRESS_CORRECTED: {
    id: "s",
    kind: "ADDRESS_CORRECTED",
    occurredAt: INSTANTE,
    actorName: "Bruno",
    order: ORDEM,
    reason: "INCORRECT_ADDRESS",
  },
  LOCATION_AND_ADDRESS_CORRECTED: {
    id: "t",
    kind: "LOCATION_AND_ADDRESS_CORRECTED",
    occurredAt: INSTANTE,
    actorName: "Bruno",
    order: ORDEM,
    reason: "CUSTOMER_MOVED",
  },
  LOCATION_FROM_INTEGRATION: {
    id: "u",
    kind: "LOCATION_FROM_INTEGRATION",
    occurredAt: INSTANTE,
    actorName: null,
    order: null,
    reason: "INCOMPLETE_REGISTRATION",
  },
  LOCATION_DIVERGENCE_FROM_INTEGRATION: {
    id: "v",
    kind: "LOCATION_DIVERGENCE_FROM_INTEGRATION",
    occurredAt: INSTANTE,
    actorName: null,
    order: null,
    reason: "OTHER",
  },
};

/** Código de sistema: duas ou mais palavras maiúsculas ligadas por `_`. */
const CODIGO_CRU = /\b[A-Z]{2,}(?:_[A-Z0-9]+)+\b/;

describe("TL-PRES — nenhum código cru, nada inventado", () => {
  it("TL-PRES-01 — todo tipo tem título humano, categoria e nenhum código cru", () => {
    for (const [kind, item] of Object.entries(AMOSTRAS)) {
      const p = presentTimelineItem(item);
      expect(p.category, kind).toBe(TIMELINE_KIND_CATEGORY[kind as CustomerTimelineKind]);
      expect(p.title.trim().length, kind).toBeGreaterThan(3);
      expect(p.title, kind).not.toMatch(CODIGO_CRU);
      expect(p.description ?? "", kind).not.toMatch(CODIGO_CRU);
      expect(p.actorLabel ?? "", kind).not.toMatch(CODIGO_CRU);
    }
  });

  it("TL-PRES-02 — os textos de cada tipo saem dos campos do item", () => {
    const p = (kind: CustomerTimelineKind) => presentTimelineItem(AMOSTRAS[kind]);

    expect(p("OS_IMPORTED")).toMatchObject({ title: "OS importada do ERP", actorLabel: "Integração (ERP)" });
    expect(p("OS_REASSIGNED").description).toBe("Bruno → Carla");
    expect(p("OS_COMPLETED").description).toBe("Observações: Cliente pediu retorno.");
    expect(p("CONTACT_ATTEMPT").description).toBe("Ligação · Pediu para remarcar");
    expect(p("IMPEDIMENT").description).toBe("Problema na rede externa");
    expect(p("PHOTOS")).toMatchObject({
      title: "3 fotos do atendimento",
      description: "ONU / ONT (2) · Passagem de cabo (1)",
    });
    expect(
      presentTimelineItem({ ...(AMOSTRAS.PHOTOS as Extract<CustomerTimelineItem, { kind: "PHOTOS" }>), total: 1 })
        .title,
    ).toBe("1 foto do atendimento");
    expect(p("SIGNATURE").description).toBe("Assinado por Dona Maria");
    expect(p("EQUIPMENT_INSTALLED").description).toBe("ONU · Huawei HG8245 · série S123");
    expect(p("NETWORK_CONNECTED")).toMatchObject({
      title: "Conectado à CTO CTO Centro 01 · porta 4",
      description: "Em campo",
    });
    expect(p("NETWORK_DISCONNECTED").description).toBe("Pelo painel · Motivo: Cliente suspenso");
    expect(p("LOCATION_CORRECTED").description).toBe("Localização incorreta");
    expect(p("LOCATION_DIVERGENCE_FROM_INTEGRATION")).toMatchObject({
      description: "O ponto cadastrado foi mantido.",
      actorLabel: "Integração (ERP)",
    });
    expect(timelineOrderLabel(ORDEM)).toBe("OS Nº 42 · Instalação · Fibra");
    expect(timelineOrderLabel({ ...ORDEM, subtype: null })).toBe("OS Nº 42 · Instalação");
  });

  it("TL-PRES-03 — os rótulos são os MESMOS do aplicativo do técnico", () => {
    const dart = (relativo: string) =>
      readFileSync(path.join(process.cwd(), "apps/field/lib/features/execution", relativo), "utf8");
    const mapa = (fonte: string, inicio: string): Record<string, string> => {
      const de = fonte.indexOf(inicio);
      expect(de, inicio).toBeGreaterThanOrEqual(0);
      const bloco = fonte.slice(de, fonte.indexOf("};", de));
      return Object.fromEntries(
        Array.from(bloco.matchAll(/'([A-Z_]+)':\s*'([^']*)'/g), (m) => [m[1], m[2]]),
      );
    };
    const dominio = dart("domain/execution.dart");
    const formularios = dart("ui/execution_forms.dart");

    expect(EVIDENCE_CATEGORY_LABELS).toEqual(mapa(dominio, "static const all = <String, String>{"));
    expect(CONTACT_CHANNEL_LABELS).toEqual(mapa(dominio, "static const channelLabels"));
    expect(CONTACT_RESULT_LABELS).toEqual(mapa(dominio, "static const resultLabels"));
    expect(IMPEDIMENT_REASON_LABELS).toEqual(mapa(dominio, "static const reasonLabels"));
    expect(LOCATION_REASON_LABELS).toEqual(mapa(formularios, "const _correctionReasons"));
  });
});

// ---------------------------------------------------------------------------
// a seção renderizada
// ---------------------------------------------------------------------------

function render(section: TimelineSection, loadMoreHref: string | null = null): string {
  return renderToStaticMarkup(createElement(CustomerTimelineSection, { section, loadMoreHref }));
}

function ok(items: CustomerTimelineItem[], extra: { hasMore?: boolean; timezone?: string } = {}) {
  return {
    state: "ok" as const,
    data: {
      items,
      hasMore: extra.hasMore ?? false,
      limit: 50,
      timezone: extra.timezone ?? "America/Manaus",
    },
  };
}

describe("TL-UI — os três estados e o fuso da empresa", () => {
  it("TL-UI-01 — erro é aviso, e nunca o estado vazio", () => {
    const html = render({ state: "error" });
    expect(html).toContain('data-testid="customer-timeline-error"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("Não foi possível carregar o histórico");
    expect(html).not.toContain("customer-timeline-empty");
    expect(html).not.toContain("Nenhum registro ainda");
  });

  it("TL-UI-02 — vazio é mensagem humana, e nunca o aviso de erro", () => {
    const html = render(ok([]));
    expect(html).toContain('data-testid="customer-timeline-empty"');
    expect(html).toContain("Nenhum registro ainda");
    expect(html).not.toContain('role="alert"');
  });

  it("TL-UI-03 — hora e dia no fuso da EMPRESA, não no do servidor", () => {
    // 02:30 UTC de 10/09 é 11:30 de 10/09 em Tóquio e 23:30 de 09/09 em São
    // Paulo: o dia civil muda com o fuso, e é isso que se prova.
    const processo = new Intl.DateTimeFormat("pt-BR", {
      hour: "2-digit",
      minute: "2-digit",
    }).format(INSTANTE);
    expect(processo).not.toBe("11:30"); // pré-condição

    const html = render(ok([AMOSTRAS.OS_CREATED], { timezone: "Asia/Tokyo" }));
    expect(html).toContain(">11:30</time>");
    expect(html).toContain("10 de setembro de 2026");

    const manaus = render(ok([AMOSTRAS.OS_CREATED], { timezone: "America/Manaus" }));
    expect(manaus).toContain(">22:30</time>");
    expect(manaus).toContain("9 de setembro de 2026");
  });

  it("TL-UI-04 — itens de dias diferentes ficam em grupos diferentes, na ordem recebida", () => {
    const ontem = { ...AMOSTRAS.OS_CREATED, id: "z1", occurredAt: new Date("2026-09-09T15:00:00.000Z") };
    const hoje = { ...AMOSTRAS.OS_STARTED, id: "z2", occurredAt: new Date("2026-09-10T15:00:00.000Z") };
    const html = render(ok([hoje, ontem]));
    const dias = Array.from(html.matchAll(/data-testid="timeline-day"[^>]*>([^<]+)</g), (m) => m[1]);
    expect(dias).toEqual(["10 de setembro de 2026", "9 de setembro de 2026"]);
  });

  it("TL-UI-05 — link para a OS pelo número, link para a CTO, e nenhum código cru na página", () => {
    const html = render(ok(Object.values(AMOSTRAS)));
    expect(html).toContain('href="/ordens/os_1"');
    expect(html).toContain("OS Nº 42 · Instalação · Fibra");
    expect(html).toContain('href="/ctos/cto_1"');
    // O texto visível — sem atributos — não carrega código de sistema.
    const visivel = html.replace(/<[^>]+>/g, " ");
    expect(visivel).not.toMatch(CODIGO_CRU);
    expect(Array.from(html.matchAll(/data-testid="timeline-item"/g))).toHaveLength(
      Object.keys(AMOSTRAS).length,
    );
  });

  it("TL-UI-06 — impedimento é o único aviso com cor; o resto é categoria neutra", () => {
    const html = render(ok([AMOSTRAS.IMPEDIMENT, AMOSTRAS.CONTACT_ATTEMPT]));
    const chips = Array.from(
      html.matchAll(/<span class="([^"]+)" data-testid="timeline-category">([^<]+)</g),
      (m) => ({ classes: m[1], texto: m[2] }),
    );
    expect(chips.map((c) => c.texto)).toEqual(["Impedimento", "Contato"]);
    expect(chips[0].classes).toContain("text-warning-fg");
    expect(chips[1].classes).not.toContain("warning");
  });

  it("TL-UI-07 — 'Ver eventos anteriores' só quando há mais E ainda cabe; no teto, o aviso", () => {
    const itens = [AMOSTRAS.OS_CREATED];
    expect(render(ok(itens, { hasMore: false }), "/x?historico=100#historico")).not.toContain(
      "customer-timeline-more",
    );

    const comMais = render(ok(itens, { hasMore: true }), "/clientes/c1/editar?historico=100#historico");
    expect(comMais).toContain('data-testid="customer-timeline-more"');
    expect(comMais).toContain('href="/clientes/c1/editar?historico=100#historico"');

    const noTeto = render(ok(itens, { hasMore: true }), null);
    expect(noTeto).not.toContain("customer-timeline-more");
    expect(noTeto).toContain('data-testid="customer-timeline-cap"');
    expect(noTeto).toContain("500 registros mais recentes");
  });
});
