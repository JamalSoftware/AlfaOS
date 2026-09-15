import type { LatLngTuple } from "leaflet";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { stablePosition } from "@/components/map/stable-position";

/**
 * # RC-1D — a posição do marcador é estável por referência
 *
 * O react-leaflet reposiciona um marcador quando a prop `position` muda de
 * REFERÊNCIA. Com um array novo a cada render, uma releitura do recorte que
 * chegasse durante o arrasto devolvia a caixa ao ponto gravado — o MAPEDIT
 * intermitente, reproduzido de forma determinística em
 * `e2e/operational-map.spec.ts` (`MAPEDIT-15`).
 */
describe("stablePosition", () => {
  it("o mesmo par devolve o MESMO array — nada chega ao Leaflet", () => {
    const cache = new Map<string, LatLngTuple>();
    const primeira = stablePosition(cache, "cto-a", -20.31, -40.31);
    const segunda = stablePosition(cache, "cto-a", -20.31, -40.31);
    expect(segunda).toBe(primeira);
  });

  it("um par diferente é um array novo — a mudança real chega", () => {
    const cache = new Map<string, LatLngTuple>();
    const antes = stablePosition(cache, "cto-a", -20.31, -40.31);
    const depois = stablePosition(cache, "cto-a", -20.3101, -40.31);
    expect(depois).not.toBe(antes);
    expect(depois).toEqual([-20.3101, -40.31]);
    // E o novo passa a ser o estável.
    expect(stablePosition(cache, "cto-a", -20.3101, -40.31)).toBe(depois);
  });

  it("cada marcador tem o seu: o mesmo par em caixas diferentes não se confunde", () => {
    const cache = new Map<string, LatLngTuple>();
    const a = stablePosition(cache, "cto-a", -20.31, -40.31);
    const b = stablePosition(cache, "cto-b", -20.31, -40.31);
    expect(b).not.toBe(a);
    expect(stablePosition(cache, "cto-a", -20.31, -40.31)).toBe(a);
  });

  it("a camada de CTO passa TODA posição de marcador por ele", () => {
    // Sem isto, um array literal no JSX voltaria a ser novo a cada render.
    const fonte = readFileSync(
      path.join(process.cwd(), "src/components/map/CtoMarkers.tsx"),
      "utf8",
    ).replace(/\{\/\*[\s\S]*?\*\/\}|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    const inicio = fonte.indexOf("position={");
    expect(inicio).toBeGreaterThan(-1);
    const trecho = fonte.slice(inicio, fonte.indexOf("draggable=", inicio));
    expect(trecho).not.toMatch(/\[\s*(draftPosition|marker)\.latitude/);
    expect(trecho.match(/stablePosition\(/g)).toHaveLength(2);
  });
});
