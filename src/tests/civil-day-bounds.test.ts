import { describe, it, expect } from "vitest";
import { civilDateIn, civilDayBoundsIn } from "@/lib/workday";

/**
 * # `civilDayBoundsIn` — o "hoje" da EMPRESA (DASH-1)
 *
 * "OS de hoje" no painel é o dia civil no fuso da empresa. As afirmações daqui
 * são sobre as bordas, que é onde um cálculo ingênuo erra em silêncio: a
 * noite (que em UTC já é amanhã) e os dias de 23 e 25 horas.
 */

const h = (inicio: Date, fim: Date) => (fim.getTime() - inicio.getTime()) / 3_600_000;

describe("DAYBOUNDS — o dia civil no fuso dado", () => {
  it("DAYBOUNDS-01 · São Paulo, meio-dia: [03:00Z, 03:00Z do dia seguinte)", () => {
    const dia = civilDayBoundsIn(new Date("2026-09-12T15:00:00Z"), "America/Sao_Paulo");
    expect(dia.start.toISOString()).toBe("2026-09-12T03:00:00.000Z");
    expect(dia.end.toISOString()).toBe("2026-09-13T03:00:00.000Z");
  });

  it("DAYBOUNDS-02 · 22h30 em São Paulo ainda é HOJE, embora em UTC já seja amanhã", () => {
    const instante = new Date("2026-09-13T01:30:00Z");
    const dia = civilDayBoundsIn(instante, "America/Sao_Paulo");
    expect(civilDateIn(instante, "America/Sao_Paulo")).toBe("2026-09-12");
    expect(dia.start.toISOString()).toBe("2026-09-12T03:00:00.000Z");
    expect(instante.getTime()).toBeLessThan(dia.end.getTime());
  });

  it("DAYBOUNDS-03 · dia em que a meia-noite NÃO existiu (horário de verão às 0h, 2018): 23h", () => {
    const dia = civilDayBoundsIn(new Date("2018-11-04T12:00:00Z"), "America/Sao_Paulo");
    // O relógio pulou de 23h59 para 1h: o dia começou à 1h local (-02:00).
    expect(dia.start.toISOString()).toBe("2018-11-04T03:00:00.000Z");
    expect(civilDateIn(dia.start, "America/Sao_Paulo")).toBe("2018-11-04");
    expect(civilDateIn(new Date(dia.start.getTime() - 1), "America/Sao_Paulo")).toBe("2018-11-03");
    expect(h(dia.start, dia.end)).toBe(23);
  });

  it("DAYBOUNDS-04 · dia de fim do horário de verão (2019): 25h", () => {
    const dia = civilDayBoundsIn(new Date("2019-02-16T12:00:00Z"), "America/Sao_Paulo");
    expect(h(dia.start, dia.end)).toBe(25);
    expect(civilDateIn(dia.start, "America/Sao_Paulo")).toBe("2019-02-16");
    expect(civilDateIn(new Date(dia.end.getTime() - 1), "America/Sao_Paulo")).toBe("2019-02-16");
    expect(civilDateIn(dia.end, "America/Sao_Paulo")).toBe("2019-02-17");
  });

  it("DAYBOUNDS-05 · Nova York nas duas trocas: 23h e 25h", () => {
    const primavera = civilDayBoundsIn(new Date("2024-03-10T12:00:00Z"), "America/New_York");
    const outono = civilDayBoundsIn(new Date("2024-11-03T12:00:00Z"), "America/New_York");
    expect(h(primavera.start, primavera.end)).toBe(23);
    expect(h(outono.start, outono.end)).toBe(25);
    expect(primavera.start.toISOString()).toBe("2024-03-10T05:00:00.000Z");
  });

  it("DAYBOUNDS-06 · UTC é o caso trivial, e o fim é exclusivo", () => {
    const dia = civilDayBoundsIn(new Date("2026-09-12T23:59:59.999Z"), "UTC");
    expect(dia.start.toISOString()).toBe("2026-09-12T00:00:00.000Z");
    expect(dia.end.toISOString()).toBe("2026-09-13T00:00:00.000Z");
  });

  it("DAYBOUNDS-07 · o fuso MUDA a resposta — não é o fuso do processo", () => {
    const instante = new Date("2026-09-12T15:00:00Z");
    const sp = civilDayBoundsIn(instante, "America/Sao_Paulo");
    const toquio = civilDayBoundsIn(instante, "Asia/Tokyo");
    expect(civilDateIn(instante, "Asia/Tokyo")).toBe("2026-09-13");
    expect(toquio.start.toISOString()).toBe("2026-09-12T15:00:00.000Z");
    expect(toquio.start.getTime()).not.toBe(sp.start.getTime());
  });
});
