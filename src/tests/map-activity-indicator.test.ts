import { describe, expect, it } from "vitest";
import {
  MAP_ACTIVITY_MIN_VISIBLE_MS,
  MAP_ACTIVITY_SHOW_DELAY_MS,
  nextMapActivityStep,
} from "@/lib/map-activity-indicator";

/**
 * A cadência do indicador, com relógio de mentira.
 *
 * O defeito que estes testes existem para não deixar voltar é o flash de
 * 50–150 ms que o dono viu: o aviso nascendo com a requisição e morrendo com
 * a resposta. Cada caso abaixo é uma linha do tempo, e a asserção é sobre
 * QUANDO, não sobre SE.
 */
describe("LOADFLICKER — a cadência do indicador de atividade", () => {
  it("LOADFLICKER-01 · uma leitura rápida nunca chega a mostrar o aviso", () => {
    // t=0: começou. A decisão é "mostrar daqui a 250".
    const passo = nextMapActivityStep(true, false, null, 0);
    expect(passo).toEqual({ action: "show", afterMs: MAP_ACTIVITY_SHOW_DELAY_MS });

    // t=80: terminou ANTES do atraso vencer, com o aviso ainda fora da tela.
    // A resposta é "nada" — e o componente cancela o `show` pendente.
    expect(nextMapActivityStep(false, false, null, 80)).toEqual({
      action: "none",
      afterMs: 0,
    });
  });

  it("LOADFLICKER-02 · uma leitura lenta mostra, e só depois do atraso", () => {
    const passo = nextMapActivityStep(true, false, null, 1000);
    expect(passo.action).toBe("show");
    /*
      MAIOR que zero, e não "qualquer atraso": o valor antigo era 160 ms e o
      dono ainda via o flash. O piso é o do enunciado.
    */
    expect(passo.afterMs).toBeGreaterThanOrEqual(250);
    expect(passo.afterMs).toBe(MAP_ACTIVITY_SHOW_DELAY_MS);
  });

  it("LOADFLICKER-05 · o aviso fica o tempo mínimo, mesmo que a resposta chegue logo depois", () => {
    // Apareceu em t=250; a resposta chegou em t=260 — 10 ms depois.
    const passo = nextMapActivityStep(false, true, 250, 260);
    expect(passo.action).toBe("hide");
    expect(passo.afterMs).toBe(MAP_ACTIVITY_MIN_VISIBLE_MS - 10);
    expect(passo.afterMs).toBeGreaterThanOrEqual(250);
  });

  it("LOADFLICKER-05b · passado o tempo mínimo, some na hora", () => {
    const passo = nextMapActivityStep(false, true, 250, 250 + MAP_ACTIVITY_MIN_VISIBLE_MS + 500);
    expect(passo).toEqual({ action: "hide", afterMs: 0 });
  });

  it("LOADFLICKER-06 · leitura emendada na anterior não apaga e reacende", () => {
    // Está na tela, e uma nova camada começou a carregar: nada muda.
    expect(nextMapActivityStep(true, true, 250, 400)).toEqual({
      action: "none",
      afterMs: 0,
    });
  });

  it("LOADFLICKER-07 · parado e fora da tela é o repouso", () => {
    expect(nextMapActivityStep(false, false, null, 5000)).toEqual({
      action: "none",
      afterMs: 0,
    });
  });

  it("LOADFLICKER-08 · `shownAt` nulo com aviso na tela erra para o lado de mostrar", () => {
    const passo = nextMapActivityStep(false, true, null, 9999);
    expect(passo).toEqual({ action: "hide", afterMs: MAP_ACTIVITY_MIN_VISIBLE_MS });
  });

  it("LOADFLICKER-09 · os dois tempos são os do enunciado", () => {
    // Atraso ≈250 ms; mínimo visível entre 250 e 350 ms.
    expect(MAP_ACTIVITY_SHOW_DELAY_MS).toBe(250);
    expect(MAP_ACTIVITY_MIN_VISIBLE_MS).toBeGreaterThanOrEqual(250);
    expect(MAP_ACTIVITY_MIN_VISIBLE_MS).toBeLessThanOrEqual(350);
  });
});
