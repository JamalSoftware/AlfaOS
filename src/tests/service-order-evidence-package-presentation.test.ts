import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ServiceOrderEvidencePackageView } from "@/components/ServiceOrderEvidencePackageView";
import type {
  EvidencePackagePhoto,
  EvidencePackageSection,
  PackageIntegrity,
  ServiceOrderEvidencePackage,
  SignatureBinding,
} from "@/lib/service-order-evidence-package";
import {
  checkInLocationText,
  checklistAnswerText,
  durationText,
  groupPhotosByCategory,
  integrityText,
  locationChangeText,
  signatureBindingText,
} from "@/lib/service-order-evidence-package-presentation";
import { presentTimelineItem } from "@/lib/customer-timeline-presentation";

/**
 * # EV-1 — como o pacote fala, e o HTML que o servidor entrega
 *
 * Frases sem código cru, as palavras do check-in iguais às do aplicativo do
 * técnico, as da localização iguais às da timeline do cliente — e os três
 * estados da tela, renderizados de verdade, no fuso da empresa.
 */

const T0 = new Date("2026-09-10T02:30:00.000Z"); // 11:30 em Tóquio; 23:30 de 09/09 em SP

function foto(id: string, category: EvidencePackagePhoto["category"], extra: Partial<EvidencePackagePhoto> = {}): EvidencePackagePhoto {
  return {
    id,
    category,
    caption: null,
    recordedAt: T0,
    uploadedByName: "Bruno",
    url: `/api/service-orders/os_1/evidence/${id}/content`,
    ...extra,
  };
}

function pacote(extra: Partial<ServiceOrderEvidencePackage> = {}): ServiceOrderEvidencePackage {
  return {
    order: {
      id: "os_1",
      number: 42,
      type: "Instalação",
      subtype: "Fibra",
      status: "COMPLETED",
      startedAt: new Date(T0.getTime() - 65 * 60_000),
      completedAt: T0,
    },
    customer: { name: "Dona Maria", address: "Rua das Fibras, 100 · Manaus/AM" },
    technicianName: "Bruno",
    timezone: "Asia/Tokyo",
    integrity: "VERIFIED",
    signatureBinding: "BOUND",
    checkIn: {
      checkedInAt: new Date(T0.getTime() - 60 * 60_000),
      withDeviceLocation: true,
      distanceMeters: 15,
      accuracyMeters: 12,
      technicianName: "Bruno",
    },
    locationChanges: [
      { id: "l1", kind: "LOCATION_CORRECTED", reason: "INCOMPLETE_REGISTRATION", occurredAt: T0, actorName: "Bruno" },
    ],
    execution: { diagnosis: "Conector sujo.", workPerformed: "Conector refeito.", notes: "Linha 1\nLinha 2" },
    checklist: [
      { id: "c1", label: "Cabo testado?", type: "BOOLEAN", required: true, answer: { kind: "boolean", value: true } },
      { id: "c2", label: "Potência (dBm)", type: "NUMBER", required: false, answer: { kind: "number", value: "-18.5" } },
      { id: "c3", label: "Foto da ONU", type: "PHOTO", required: true, answer: { kind: "photo", category: "ONU_ONT", attached: true } },
    ],
    photos: [foto("e1", "CTO", { caption: "Caixa aberta" }), foto("e2", "ONU_ONT"), foto("e3", "CTO")],
    measurements: { speedTests: [foto("e4", "SPEED_TEST")], opticalReadings: [] },
    equipments: [
      {
        id: "q1",
        equipmentType: "ONU",
        manufacturer: "Huawei",
        model: "HG8245",
        serial: "S123",
        macAddress: "aa:bb:cc:dd:ee:ff",
        installedAt: T0,
        installedByName: "Bruno",
        label: foto("e5", "EQUIPMENT_LABEL"),
      },
    ],
    materials: [{ id: "m1", description: "CABO-1 — Cabo drop", quantity: "35.5", unit: "METER" }],
    signature: { signerName: "Dona Maria", signedAt: T0, capturedByName: "Bruno", url: "/api/service-orders/os_1/signature" },
    ...extra,
  };
}

function render(section: Exclude<EvidencePackageSection, { state: "not-found" }>): string {
  return renderToStaticMarkup(createElement(ServiceOrderEvidencePackageView, { orderId: "os_1", section }));
}

const CODIGO_CRU = /\b[A-Z]{2,}(?:_[A-Z0-9]+)+\b/;

describe("EV-PRES — frases", () => {
  it("EV-PRES-01 — conferência e assinatura: todo estado tem título e tom; divergência é aviso", () => {
    for (const i of ["VERIFIED", "DIVERGENT", "NO_RECORD"] as PackageIntegrity[]) {
      const t = integrityText(i);
      expect(t.title.length, i).toBeGreaterThan(5);
      expect(t.title, i).not.toMatch(CODIGO_CRU);
    }
    for (const s of ["BOUND", "DIVERGENT", "LEGACY", "NONE"] as SignatureBinding[]) {
      expect(signatureBindingText(s).title, s).not.toMatch(CODIGO_CRU);
    }
    expect(integrityText("DIVERGENT").tone).toBe("warning");
    expect(signatureBindingText("DIVERGENT").tone).toBe("warning");
    expect(integrityText("VERIFIED").tone).toBe("ok");
  });

  it("EV-PRES-02 — o check-in usa as MESMAS frases do aplicativo do técnico", () => {
    const base = pacote().checkIn!;
    const frases = [
      checkInLocationText({ ...base, distanceMeters: 15 }),
      checkInLocationText({ ...base, distanceMeters: null, withDeviceLocation: true }),
      checkInLocationText({ ...base, distanceMeters: null, withDeviceLocation: false }),
    ];
    expect(frases).toEqual([
      "A 15 m do ponto cadastrado",
      "Sem localização cadastrada no momento do check-in",
      "Sem coordenada — registrado assim mesmo",
    ]);
    const dart = readFileSync(
      path.join(process.cwd(), "apps/field/lib/features/execution/ui/execution_screen.dart"),
      "utf8",
    );
    expect(dart).toContain("m do ponto cadastrado");
    expect(dart).toContain(frases[1]);
    expect(dart).toContain(frases[2]);
  });

  it("EV-PRES-03 — respostas do checklist como foram gravadas", () => {
    expect(checklistAnswerText({ kind: "boolean", value: true })).toBe("Sim");
    expect(checklistAnswerText({ kind: "boolean", value: false })).toBe("Não");
    expect(checklistAnswerText({ kind: "number", value: "-18.5" })).toBe("-18,5");
    expect(checklistAnswerText({ kind: "text", value: "ok" })).toBe("ok");
    expect(checklistAnswerText({ kind: "photo", category: "ONU_ONT", attached: true })).toBe("Foto anexada — ONU / ONT");
    expect(checklistAnswerText({ kind: "photo", category: "ROUTER", attached: false })).toBe("Foto não anexada — Roteador");
    expect(checklistAnswerText({ kind: "unanswered" })).toBe("Sem resposta");
  });

  it("EV-PRES-04 — duração e agrupamento de fotos por categoria, na ordem de chegada", () => {
    expect(durationText(new Date(0), new Date(35 * 60_000))).toBe("35 min");
    expect(durationText(new Date(0), new Date(65 * 60_000))).toBe("1h 05min");
    expect(durationText(null, new Date())).toBeNull();
    const grupos = groupPhotosByCategory([foto("a", "CTO"), foto("b", "ROUTER"), foto("c", "CTO")]);
    expect(grupos.map((g) => [g.label, g.photos.map((p) => p.id)])).toEqual([
      ["CTO", ["a", "c"]],
      ["Roteador", ["b"]],
    ]);
  });

  it("EV-PRES-05 — mudança de ponto com as MESMAS frases da timeline do cliente", () => {
    for (const kind of ["LOCATION_CONFIRMED", "LOCATION_CORRECTED", "ADDRESS_CORRECTED", "LOCATION_AND_ADDRESS_CORRECTED"] as const) {
      const nosso = locationChangeText({ kind, reason: "INCORRECT_LOCATION" });
      const timeline = presentTimelineItem({ id: "x", kind, occurredAt: T0, actorName: null, order: null, reason: "INCORRECT_LOCATION" });
      expect(nosso.title).toBe(timeline.title);
      expect(nosso.reason).toBe(timeline.description);
    }
  });
});

describe("EV-UI — a tela", () => {
  it("EV-UI-01 — erro é aviso, e nunca um pacote vazio", () => {
    const html = render({ state: "error" });
    expect(html).toContain('data-testid="evidence-package-error"');
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("package-photos");
    expect(html).not.toContain("Nenhuma foto");
  });

  it("EV-UI-02 — OS em atendimento: diz que o pacote ainda não existe, sem nenhum item", () => {
    const html = render({
      state: "not-completed",
      order: { id: "os_1", number: 42, type: "Instalação", subtype: null, status: "IN_PROGRESS", startedAt: T0, completedAt: null },
    });
    expect(html).toContain('data-testid="evidence-package-not-completed"');
    expect(html).toContain("ainda não foi concluído");
    expect(html).toContain("Voltar para OS Nº 42");
    expect(html).not.toContain("package-integrity");
  });

  it("EV-UI-03 — pacote completo: seções, fuso da empresa, alt nas imagens e nada cru", () => {
    const processo = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(T0);
    expect(processo).not.toBe("11:30"); // pré-condição: o fuso do processo é outro

    const html = render({ state: "ok", data: pacote() });
    for (const secao of [
      "package-summary",
      "package-integrity",
      "package-times",
      "package-location",
      "package-report",
      "package-checklist",
      "package-photos",
      "package-measurements",
      "package-equipments",
      "package-materials",
      "package-signature",
    ]) {
      expect(html, secao).toContain(`data-testid="${secao}"`);
    }
    expect(html).toContain("Conclusão");
    expect(html).toContain(">11:30<"); // conclusão no fuso de Tóquio
    expect(html).toContain("10/09/2026, 11:30");
    expect(html).toContain("Check-in realizado às 10:30");
    expect(html).toContain("A 15 m do ponto cadastrado");
    expect(html).toContain("Localização corrigida");
    expect(html).toContain("1h 05min");
    expect(html).toContain("Foto — CTO, registrada às 11:30");
    expect(html).toContain('alt="Assinatura de Dona Maria"');
    expect(html).toContain('alt="Etiqueta do equipamento ONU"');
    expect(html).toContain("CTO (2)");
    expect(html).toContain("-18,5");
    expect(html).toContain("35,5");
    const visivel = html.replace(/<[^>]+>/g, " ");
    expect(visivel).not.toMatch(CODIGO_CRU);
    expect(html).not.toMatch(/latitude|longitude|storageKey|contentHash/);
  });

  it("EV-UI-04 — status não depende só de cor: glifo e texto; divergência vira alerta", () => {
    const ok = render({ state: "ok", data: pacote() });
    expect(ok).toMatch(/data-tone="ok"[^>]*>[\s\S]*?✓[\s\S]*?Conteúdo conferido com o fechamento/);
    const divergente = render({ state: "ok", data: pacote({ integrity: "DIVERGENT", signatureBinding: "DIVERGENT" }) });
    expect(divergente.match(/role="alert"/g)).toHaveLength(2);
    expect(divergente).toContain("O conteúdo mudou depois do fechamento");
    expect(divergente).toContain("A assinatura não corresponde ao conteúdo fechado");
  });

  it("EV-UI-05 — seções sem dado dizem isso em português, sem esconder a seção", () => {
    const html = render({
      state: "ok",
      data: pacote({
        checkIn: null,
        locationChanges: [],
        checklist: [],
        photos: [],
        measurements: { speedTests: [], opticalReadings: [] },
        equipments: [],
        materials: [],
        signature: null,
        signatureBinding: "NONE",
        integrity: "NO_RECORD",
      }),
    });
    for (const frase of [
      "Sem check-in registrado.",
      "Esta OS não tinha checklist.",
      "Nenhuma foto além das medições e etiquetas.",
      "Nenhuma foto de teste de velocidade.",
      "Nenhuma foto de leitura óptica.",
      "Nenhum equipamento registrado.",
      "Nenhum material registrado.",
      "Assinatura não coletada.",
      "Sem registro de fechamento",
    ]) {
      expect(html, frase).toContain(frase);
    }
  });
});
