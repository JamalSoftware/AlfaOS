import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONNECTIVITY_PRESENTATION,
  connectivityPresentation,
} from "@/lib/connectivity-presentation";

/*
  "Sem leitura" é só o texto — decisão do dono na validação da CTO (RC-1D).

  O "?" que vinha na frente do rótulo repetia a dúvida que o texto já diz.
  A regra mora na TABELA ÚNICA (`glyph: null` para UNKNOWN), e por isso vale
  em todo selo que lê dela: detalhe da CTO, popups do Mapa Operacional e o
  "Ver clientes" da caixa.

  São três provas, e cada uma pega um defeito que as outras não pegam:
  - DADO: a tabela não tem "?" em lugar nenhum do estado UNKNOWN;
  - ESTRUTURA: todo ponto que desenha o glifo o GUARDA — senão o caractere
    some e o `<span>` vazio fica, e o `gap` do `inline-flex` empurra o texto;
  - NAVEGADOR: `e2e/cto-client-connectivity.spec.ts` (UX-09) e
    `e2e/operational-map.spec.ts` (NOGLYPH-01).
*/

describe("RC-1D · 'Sem leitura' sem glifo — o dado", () => {
  it("NOGLYPH-DATA-01 · UNKNOWN → 'Sem leitura', e nenhum campo contém '?'", () => {
    const p = connectivityPresentation("UNKNOWN");

    expect(p.mapLabel).toBe("Sem leitura");
    expect(p.customerLabel).toBe("Sem leitura");
    expect(p.glyph).toBeNull();

    for (const [campo, valor] of Object.entries(p)) {
      if (typeof valor === "string") {
        expect(valor, `o campo '${campo}' ainda tem '?'`).not.toContain("?");
      }
    }
  });

  it("NOGLYPH-DATA-02 · o resto do UNKNOWN não mudou: tom neutro, rótulo da OS, nunca OFFLINE", () => {
    const p = CONNECTIVITY_PRESENTATION.UNKNOWN;
    expect(p.status).toBe("UNKNOWN");
    expect(p.tone).toBe("neutral");
    expect(p.label).toBe("Desconhecido");
    expect(p.mapLabel).not.toBe(CONNECTIVITY_PRESENTATION.OFFLINE.mapLabel);
  });

  it("NOGLYPH-DATA-03 · online e offline MANTÊM o glifo — a regra é do UNKNOWN, não uma remoção geral", () => {
    // Controle: se alguém zerar todos os glifos, o estado passa a viajar só
    // como cor, e é isso que a tabela existe para impedir.
    expect(CONNECTIVITY_PRESENTATION.ONLINE.glyph).toBe("●");
    expect(CONNECTIVITY_PRESENTATION.OFFLINE.glyph).toBe("×");
    expect(CONNECTIVITY_PRESENTATION.ONLINE.tone).toBe("success");
    expect(CONNECTIVITY_PRESENTATION.OFFLINE.tone).toBe("danger");
  });
});

describe("RC-1D · 'Sem leitura' sem glifo — a estrutura", () => {
  const raiz = path.join(process.cwd(), "src");

  function arquivosTsx(dir: string): string[] {
    const saida: string[] = [];
    for (const nome of readdirSync(dir)) {
      const cheio = path.join(dir, nome);
      if (statSync(cheio).isDirectory()) {
        if (nome === "tests" || nome === "node_modules") continue;
        saida.push(...arquivosTsx(cheio));
      } else if (nome.endsWith(".tsx")) {
        saida.push(cheio);
      }
    }
    return saida;
  }

  /*
    Todo `<span aria-hidden="true">{X.glyph}</span>` num arquivo que importa a
    tabela de conectividade. É o formato dos cinco selos; o glifo da LEGENDA de
    caixas (`CTO_MAP_LEGEND`) é outro módulo e não tem `aria-hidden`, então não
    entra — e não deve entrar, porque a caixa não perdeu glifo nenhum.
  */
  const SPAN_DE_GLIFO =
    /<span\b[^>]*aria-hidden="true"[^>]*>\s*\{(\w+)\.glyph\}\s*<\/span>/g;

  const pontos = arquivosTsx(raiz)
    .map((arquivo) => ({ arquivo, fonte: readFileSync(arquivo, "utf8") }))
    .filter(({ fonte }) => fonte.includes("@/lib/connectivity-presentation"))
    .flatMap(({ arquivo, fonte }) =>
      Array.from(fonte.matchAll(SPAN_DE_GLIFO)).map((m) => ({
        arquivo: path.relative(raiz, arquivo).replaceAll("\\", "/"),
        ident: m[1],
        antes: fonte.slice(0, m.index).trimEnd(),
      })),
    );

  it("NOGLYPH-STRUCT-01 · a varredura enxerga os selos (não passa por não achar nada)", () => {
    const arquivos = new Set(pontos.map((p) => p.arquivo));
    for (const esperado of [
      "app/(app)/ctos/[id]/CtoDetailManager.tsx",
      "components/map/OperationalMarkers.tsx",
      "components/map/CtoMapLayer.tsx",
      "app/(app)/clientes/page.tsx",
    ]) {
      expect(arquivos, `a varredura não achou o selo de ${esperado}`).toContain(esperado);
    }
    expect(pontos.length).toBeGreaterThanOrEqual(5);
  });

  it("NOGLYPH-STRUCT-02 · todo selo GUARDA o glifo — sem span vazio empurrando o texto", () => {
    const soltos = pontos.filter(
      (p) => !p.antes.endsWith(`{${p.ident}.glyph && (`),
    );
    expect(
      soltos.map((p) => `${p.arquivo} (${p.ident}.glyph)`),
      "glifo desenhado sem guarda: com glyph null sobra um <span> vazio",
    ).toEqual([]);
  });
});
