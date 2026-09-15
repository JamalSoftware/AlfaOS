import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  SERVICE_ORDER_EVENT_LABELS,
  serviceOrderEventLabel,
} from "@/lib/service-order-event-labels";

/**
 * # RC-1D — a timeline da OS fala português
 *
 * O defeito: `EVENT_LABELS[code] ?? code`, com seis dos dezenove códigos
 * mapeados. O dono viu `PRIORITY_CHANGED` na tela.
 *
 * O que impede a volta disso é a varredura abaixo — a mesma ideia do teste de
 * rótulos de auditoria do painel: quem escreve um evento novo sem rótulo
 * descobre aqui, e não na tela de alguém.
 */

const RAIZ = process.cwd();

function semComentarios(fonte: string): string {
  return fonte.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
}

function arquivosDe(dir: string, extensoes = [".ts"]): string[] {
  return readdirSync(path.join(RAIZ, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? arquivosDe(path.join(dir, e.name), extensoes)
      : extensoes.some((ext) => e.name.endsWith(ext)) &&
          !e.name.endsWith(".test.ts")
        ? [path.join(dir, e.name)]
        : [],
  );
}

/** Todo código de evento que o código de produção grava ou consulta. */
function codigosGravados(): Set<string> {
  const codigos = new Set<string>();
  for (const arquivo of arquivosDe("src/lib")) {
    const fonte = semComentarios(readFileSync(path.join(RAIZ, arquivo), "utf8"));
    if (!fonte.includes("serviceOrderEvent")) continue;
    const expressoes = Array.from(fonte.matchAll(/event:\s*([^\n]+)/g))
      .concat(Array.from(fonte.matchAll(/const\s+eventos?\s*=\s*([^\n]+)/g)))
      .map((m) => m[1])
      // `kind === "ADDRESS"` é comparação, não código de evento.
      .map((e) => e.replace(/[!=]==?\s*"[^"]*"/g, ""));
    for (const expressao of expressoes) {
      for (const literal of Array.from(
        expressao.matchAll(/"([A-Z][A-Z0-9_]{3,})"/g),
      )) {
        codigos.add(literal[1]);
      }
    }
  }
  return codigos;
}

describe("RC-1D — rótulos dos eventos da OS", () => {
  it("todo código que o produto grava tem rótulo — nenhum chega cru à tela", () => {
    const codigos = Array.from(codigosGravados()).sort();
    // Sanidade do scanner: se ele parar de achar os eventos, o teste passa por
    // vazio e não prova nada.
    expect(codigos.length).toBeGreaterThan(14);
    expect(codigos).toContain("PRIORITY_CHANGED");
    expect(codigos).toContain("CTO_PORT_MOVED");

    const semRotulo = codigos.filter(
      (c) =>
        !Object.prototype.hasOwnProperty.call(SERVICE_ORDER_EVENT_LABELS, c),
    );
    expect(semRotulo).toEqual([]);
  });

  it("código desconhecido vira frase, nunca o código — e a tela não quebra", () => {
    expect(serviceOrderEventLabel("CODIGO_QUE_NINGUEM_MAPEOU")).toBe(
      "Evento registrado",
    );
    expect(serviceOrderEventLabel("")).toBe("Evento registrado");
    expect(serviceOrderEventLabel("PRIORITY_CHANGED")).toBe(
      "Prioridade alterada",
    );
  });

  it("nenhum rótulo é o próprio código, nem tem underscore de enum", () => {
    for (const [codigo, rotulo] of Object.entries(SERVICE_ORDER_EVENT_LABELS)) {
      expect(rotulo).not.toBe(codigo);
      expect(rotulo).not.toMatch(/_/);
      expect(rotulo[0]).toBe(rotulo[0].toUpperCase());
    }
  });

  it("a tela da OS usa a tabela central, e não tem mais o `?? código`", () => {
    const pagina = semComentarios(
      readFileSync(path.join(RAIZ, "src/app/(app)/ordens/[id]/page.tsx"), "utf8"),
    );
    expect(pagina).toContain("serviceOrderEventLabel(event.event)");
    expect(pagina).not.toMatch(/EVENT_LABELS\[/);
    expect(pagina).not.toMatch(/\?\?\s*event\.event/);
  });

  it("a copy antiga do fechamento saiu da tela da OS", () => {
    // O painel de fechamento existe desde a v0.10, e a tela dizia ao técnico,
    // logo abaixo dele, que o fechamento viria "na próxima versão".
    const pagina = readFileSync(
      path.join(RAIZ, "src/app/(app)/ordens/[id]/page.tsx"),
      "utf8",
    );
    expect(pagina).not.toMatch(/próxima versão do AlfaOS/i);
  });

  it("nenhuma tela promete funcionalidade para 'as próximas versões'", () => {
    // Sobre o TEXTO da tela: um comentário que cite a copy antiga é registro,
    // não promessa.
    const telas = arquivosDe("src/app", [".tsx"]).concat(
      arquivosDe("src/components", [".tsx"]),
    );
    expect(telas.length).toBeGreaterThan(20);
    const prometem = telas.filter((arquivo) =>
      /próximas versões|proximas versoes/i.test(
        semComentarios(readFileSync(path.join(RAIZ, arquivo), "utf8")),
      ),
    );
    expect(prometem).toEqual([]);
  });
});
