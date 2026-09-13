import { describe, it, expect } from "vitest";
import type { OperationalDashboard } from "@/lib/dashboard";
import {
  DASHBOARD_ERROR_HINT,
  buildDashboardCards,
  dashboardCardNumberTone,
} from "@/lib/dashboard-cards";

/**
 * # Os cartões do painel — regras de apresentação (DASH-1)
 *
 * Sem banco e sem navegador: dada uma leitura, que cartões a tela mostra, com
 * que texto e para onde cada um leva. É aqui que "erro nunca vira zero" e
 * "sem leitura nunca vira 0 offline" são provados para a TELA — o arquivo
 * `dashboard.test.ts` prova o mesmo para a leitura.
 */

function painel(parcial: Partial<OperationalDashboard> = {}): OperationalDashboard {
  return {
    generatedAt: new Date("2026-09-12T15:00:00Z"),
    timezone: "America/Sao_Paulo",
    serviceOrders: { state: "ok", data: { abertas: 5, atrasadas: 2, hoje: 1, pendentes: 0 } },
    team: { state: "ok", data: { emAtendimento: 3 } },
    customers: { state: "ok", data: { offline: 4, comLeitura: 40, ativos: 50 } },
    ctos: { state: "ok", data: { comDefeito: 1, comOsAbertas: 0 } },
    recentActivity: { state: "ok", data: [] },
    ...parcial,
  };
}

const todos = (p: OperationalDashboard) => {
  const g = buildDashboardCards(p);
  return [...g.serviceOrders, ...g.teamAndNetwork];
};

describe("DASH-UI — cartões", () => {
  it("DASH-UI-01 · os cartões são EXATAMENTE os do contrato, cada um com o seu destino", () => {
    expect(Object.fromEntries(todos(painel()).map((c) => [c.key, c.href]))).toEqual({
      abertas: "/ordens?recorte=abertas",
      atrasadas: "/ordens?recorte=atrasadas",
      hoje: "/ordens?recorte=hoje",
      // DASH-1a: recorte próprio, para a listagem mostrar a faixa e a volta.
      pendentes: "/ordens?recorte=pendentes",
      "tecnicos-em-atendimento": "/tecnicos?emAtendimento=true",
      "clientes-offline": "/clientes?active=true&conectividade=OFFLINE",
      "ctos-com-defeito": "/ctos?situacao=defeito",
      "ctos-com-os-abertas": "/ctos?situacao=com-os-abertas",
    });
  });

  it("DASH-UI-02 · seção com ERRO vira '—' com o motivo — nunca 0", () => {
    const cartoes = todos(
      painel({ serviceOrders: { state: "error" }, customers: { state: "error" } }),
    );
    for (const key of ["abertas", "atrasadas", "hoje", "pendentes", "clientes-offline"]) {
      const c = cartoes.find((x) => x.key === key)!;
      expect(c.value, key).toBeNull();
      expect(c.placeholder, key).toBe("—");
      expect(c.hint, key).toBe(DASHBOARD_ERROR_HINT);
    }
    // A seção que não falhou continua com o número.
    expect(cartoes.find((c) => c.key === "tecnicos-em-atendimento")?.value).toBe(3);
  });

  it("DASH-UI-03 · nenhum cliente ativo com leitura: 'Sem leitura', não '0 offline'", () => {
    const c = todos(
      painel({ customers: { state: "ok", data: { offline: 0, comLeitura: 0, ativos: 7 } } }),
    ).find((x) => x.key === "clientes-offline")!;
    expect(c.value).toBeNull();
    expect(c.placeholder).toBe("Sem leitura");
  });

  it("DASH-UI-04 · zero COM leitura é zero de verdade", () => {
    const c = todos(
      painel({ customers: { state: "ok", data: { offline: 0, comLeitura: 12, ativos: 12 } } }),
    ).find((x) => x.key === "clientes-offline")!;
    expect(c.value).toBe(0);
    expect(c.placeholder).toBeUndefined();
    expect(c.hint).toBe("Entre 12 clientes com leitura disponível.");
  });

  it("DASH-UI-05 · seção oculta não gera cartão — nem zerado", () => {
    const chaves = todos(
      painel({ customers: { state: "hidden" }, ctos: { state: "hidden" } }),
    ).map((c) => c.key);
    expect(chaves).toEqual(["abertas", "atrasadas", "hoje", "pendentes", "tecnicos-em-atendimento"]);
  });

  it("DASH-UI-06 · cor só em sinal de atenção e só acima de zero", () => {
    const cartoes = todos(painel());
    const tom = (k: string) => dashboardCardNumberTone(cartoes.find((c) => c.key === k)!);
    expect(tom("abertas")).toBe("neutro");
    expect(tom("atrasadas")).toBe("alerta");
    expect(tom("pendentes")).toBe("neutro"); // 0 pendentes: sem cor
    expect(tom("clientes-offline")).toBe("alerta");
    expect(tom("ctos-com-defeito")).toBe("alerta");
    expect(tom("ctos-com-os-abertas")).toBe("neutro");
  });
});
