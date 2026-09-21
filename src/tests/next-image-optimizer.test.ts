import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config.mjs";

/**
 * # `SEC-003` — o otimizador de imagem do Next fica desligado
 *
 * ## Por quê
 *
 * `next@14.2.35` carrega um aviso **crítico** de RCE não autenticado na API de
 * otimização de imagem com arquivos AVIF (`GHSA-2xp9-vwfh-vxw4`), mais três
 * avisos de negação de serviço no mesmo caminho. O AlfaOS não usa `next/image`
 * — o otimizador estava ligado por ser o padrão, não por ser necessário.
 *
 * ## O que estes testes guardam
 *
 * Três coisas, e a terceira é a que raramente se pensa:
 *
 * 1. a configuração continua desligando o otimizador;
 * 2. continua não havendo consumidor de `next/image` — é o que torna o
 *    desligamento gratuito, e alguém pode acrescentar um sem saber disso;
 * 3. a versão instalada do Next continua **404 antes de processar** quando
 *    `unoptimized` está ligado. Este último é deliberadamente acoplado ao
 *    código de `node_modules`, porque é dele que a mitigação depende: um
 *    upgrade que mova esse portão precisa reabrir a análise, não passar calado.
 */

const RAIZ = process.cwd();

describe("SEC-003 · otimizador de imagem", () => {
  it("SEC-003-01 · a configuração desliga o otimizador", () => {
    expect(nextConfig.images?.unoptimized).toBe(true);
  });

  it("SEC-003-02 · não existe consumidor de next/image", () => {
    /*
      A razão de o desligamento ser gratuito. Quem acrescentar um `<Image>` vai
      ver a foto sem otimização — e vai cair aqui antes, para decidir com a
      informação na mão em vez de reativar o otimizador por reflexo.
    */
    const alvos = ["src", "e2e"];
    const encontrados: string[] = [];
    const varrer = (dir: string): void => {
      for (const entrada of readdirRecursivo(dir)) {
        if (!/\.(ts|tsx|js|jsx|mjs)$/.test(entrada)) continue;
        const conteudo = readFileSync(entrada, "utf8");
        if (/from ["']next\/image["']|require\(["']next\/image["']\)/.test(conteudo)) {
          encontrados.push(path.relative(RAIZ, entrada));
        }
      }
    };
    for (const alvo of alvos) varrer(path.join(RAIZ, alvo));
    expect(encontrados).toEqual([]);
  });

  it("SEC-003-03 · o Next instalado responde 404 ANTES de processar a requisição", () => {
    /*
      A mitigação só vale se o portão vier antes do trabalho. Verificado no
      código instalado: `if (imagesConfig.loader !== "default" ||
      imagesConfig.unoptimized) { await this.render404(...); return true; }`,
      e isso acontece ANTES de `validateParams` — antes de buscar, decodificar
      ou olhar o formato.

      Se este teste falhar depois de um upgrade do Next, a conclusão NÃO é
      "ajuste o teste": é que o alcance do `GHSA-2xp9-vwfh-vxw4` mudou e a
      análise de `docs/SECURITY.md` §8.27 precisa ser refeita.
    */
    const servidor = readFileSync(
      path.join(RAIZ, "node_modules", "next", "dist", "server", "next-server.js"),
      "utf8",
    );

    const portao = servidor.indexOf("imagesConfig.unoptimized");
    expect(portao, "o portão de `unoptimized` desapareceu do Next instalado").toBeGreaterThan(
      -1,
    );

    // O 404 vem junto do portão, e o processamento vem DEPOIS dele.
    const trechoDoPortao = servidor.slice(portao, portao + 200);
    expect(trechoDoPortao).toContain("render404");

    const validacao = servidor.indexOf("ImageOptimizerCache.validateParams");
    expect(validacao, "validateParams desapareceu: o fluxo mudou").toBeGreaterThan(-1);
    expect(
      portao,
      "o portão de `unoptimized` deixou de vir antes do processamento",
    ).toBeLessThan(validacao);
  });
});

/** Lista arquivos recursivamente, sem dependência nova. */
function readdirRecursivo(dir: string): string[] {
  const fs = require("node:fs") as typeof import("node:fs");
  const saida: string[] = [];
  const pilha = [dir];
  while (pilha.length) {
    const atual = pilha.pop()!;
    let entradas: import("node:fs").Dirent[];
    try {
      entradas = fs.readdirSync(atual, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entrada of entradas) {
      const completo = path.join(atual, entrada.name);
      if (entrada.isDirectory()) pilha.push(completo);
      else saida.push(completo);
    }
  }
  return saida;
}
