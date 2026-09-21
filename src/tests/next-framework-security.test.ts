import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * # `SEC-003` — o framework instalado não pode voltar a uma versão afetada
 *
 * ## O que o upgrade fechou
 *
 * `next@14.2.35` carregava dois avisos CRÍTICOS de RCE não autenticado
 * (`GHSA-p293-qw3h-jr36`, servidor em Windows; `GHSA-2xp9-vwfh-vxw4`,
 * otimizador de imagem com AVIF) e uma série de avisos `high` de negação de
 * serviço e de cache de RSC — e **`14.2.35` era a última da linha 14.x**.
 * Todo aviso que afetava a versão antiga tinha limite superior na família
 * `<15.5.x`, o maior deles `<15.5.24`. A base de avisos do registro npm não
 * lista nenhum aviso para `15.5.24` nem para `15.5.25`.
 *
 * ## Por que este arquivo existe
 *
 * Um downgrade não precisa ser intencional: um `npm install` com o lockfile
 * errado, um merge que reverte `package-lock.json`, uma cópia de
 * `node_modules` de outra máquina. Nenhum deles quebra build ou teste de
 * produto — o AlfaOS roda igual na 14. A única coisa que muda é voltar a ter
 * RCE crítico conhecido. Por isso a versão é afirmada nas TRÊS fontes que
 * podem divergir: o que o `package.json` declara, o que o lockfile resolve e o
 * que está de fato instalado.
 *
 * ## Mudar de MAJOR reabre a análise
 *
 * A linha 16 tem avisos próprios em versões anteriores a `16.3.x`. Um piso
 * simples ("≥ 15.5.24") deixaria passar um `16.0.0` vulnerável. Então a regra é
 * explícita: a major aprovada é a 15, com piso `15.5.24`. Ir para a 16 é
 * decisão legítima — e ela passa por refazer a consulta de avisos e atualizar
 * este teste de propósito, não por acidente.
 */

const RAIZ = process.cwd();

/** A versão mínima que fecha TODOS os avisos que afetavam a 14.2.35. */
const PISO_SEGURO = "15.5.24";
/** A major aprovada pelo dono para o `SEC-003`. */
const MAJOR_APROVADA = 15;

function partes(versao: string): [number, number, number] {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(versao.trim());
  if (!m) throw new Error(`versão não é semver exata: ${JSON.stringify(versao)}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function comparar(a: string, b: string): number {
  const [x, y] = [partes(a), partes(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

function lerJson<T>(relativo: string): T {
  return JSON.parse(readFileSync(path.join(RAIZ, relativo), "utf8")) as T;
}

/** Falha dizendo POR QUE a versão não serve, e o que fazer. */
function assertVersaoSegura(fonte: string, versao: string): void {
  const [major] = partes(versao);
  expect(
    major,
    `${fonte}: next@${versao} — a major aprovada para o SEC-003 é a ${MAJOR_APROVADA}. ` +
      "Mudar de major exige refazer a consulta de avisos (docs/SECURITY.md §8.27.7) " +
      "e atualizar este teste de propósito.",
  ).toBe(MAJOR_APROVADA);
  expect(
    comparar(versao, PISO_SEGURO),
    `${fonte}: next@${versao} está ABAIXO de ${PISO_SEGURO} — faixa com RCE crítico conhecido.`,
  ).toBeGreaterThanOrEqual(0);
}

describe("SEC-003 · versão do framework", () => {
  it("SEC-003-04 · o package.json declara uma versão EXATA e segura", () => {
    const pkg = lerJson<{ dependencies: Record<string, string> }>("package.json");
    const declarada = pkg.dependencies.next;
    // Exata, sem `^`/`~`: um intervalo deixaria o lockfile escolher.
    expect(declarada, "next deve ser fixado em versão exata").toMatch(/^\d+\.\d+\.\d+$/);
    assertVersaoSegura("package.json", declarada);
  });

  it("SEC-003-05 · o lockfile resolve a MESMA versão segura", () => {
    const lock = lerJson<{ packages: Record<string, { version?: string }> }>(
      "package-lock.json",
    );
    const resolvida = lock.packages["node_modules/next"]?.version;
    expect(resolvida, "next ausente do package-lock.json").toBeDefined();
    assertVersaoSegura("package-lock.json", resolvida!);

    const pkg = lerJson<{ dependencies: Record<string, string> }>("package.json");
    expect(resolvida, "lockfile e package.json divergem").toBe(pkg.dependencies.next);
  });

  it("SEC-003-06 · o que está INSTALADO é a versão segura", () => {
    const instalada = lerJson<{ version: string }>("node_modules/next/package.json").version;
    assertVersaoSegura("node_modules/next", instalada);
  });

  it("SEC-003-07 · eslint-config-next acompanha a versão do framework", () => {
    // As regras do lint são da mesma linha do framework; versões cruzadas
    // produzem regras que não correspondem ao que o build faz.
    const pkg = lerJson<{ dependencies: Record<string, string>; devDependencies: Record<string, string> }>(
      "package.json",
    );
    expect(pkg.devDependencies["eslint-config-next"]).toBe(pkg.dependencies.next);
  });

  it("SEC-003-08 · a comparação de versão recusa o que deveria recusar", () => {
    /*
      Controle da própria régua. Sem ele, um `comparar` quebrado que devolvesse
      sempre 0 deixaria os três testes acima verdes com qualquer versão.
    */
    expect(comparar("14.2.35", PISO_SEGURO)).toBeLessThan(0);
    expect(comparar("15.5.23", PISO_SEGURO)).toBeLessThan(0);
    expect(comparar("15.5.24", PISO_SEGURO)).toBe(0);
    expect(comparar("15.5.25", PISO_SEGURO)).toBeGreaterThan(0);
    expect(() => assertVersaoSegura("controle", "14.2.35")).toThrow();
    expect(() => assertVersaoSegura("controle", "15.5.23")).toThrow();
    expect(() => assertVersaoSegura("controle", "16.0.0")).toThrow();
    expect(() => assertVersaoSegura("controle", "15.5.24")).not.toThrow();
  });
});

/**
 * # `SEC-003` · a biblioteca do mapa suporta o React que o App Router RODA
 *
 * O upgrade expôs uma armadilha que o `peerDependencies` esconde: o App Router
 * **não usa o React instalado** — usa um React vendorizado dentro do Next. No
 * 14 era 18.3-canary; no 15 é **19.2-canary**. Com o pacote `react` ainda em 18,
 * tudo instalava sem aviso, os tipos passavam, a suíte Vitest passava, e o
 * Mapa Operacional caía no navegador: `Error: Map container is already
 * initialized.`, lançado de `react-leaflet/lib/MapContainer.js` via
 * `commitAttachRef`. O `react-leaflet@4` cria o mapa num callback de ref
 * memorizado com `[]`, e o StrictMode do React 19 reanexa refs na montagem —
 * a segunda anexação vê o `context` antigo e cria o mapa de novo no mesmo nó.
 *
 * Quem pegou foi o E2E. Este teste pega antes, sem navegador: a biblioteca do
 * mapa precisa declarar suporte à MAJOR do React vendorizado, e o React
 * instalado — que é o que a suíte Vitest usa — precisa ser a mesma major, para
 * que os testes rodem no React que a produção roda.
 */
describe("SEC-003 · React do runtime × bibliotecas", () => {
  function majorVendorizada(): number {
    const fonte = readFileSync(
      path.join(RAIZ, "node_modules/next/dist/compiled/react/cjs/react.production.js"),
      "utf8",
    );
    const m = /exports\.version\s*=\s*"(\d+)\./.exec(fonte);
    if (!m) throw new Error("não achei a versão do React vendorizado pelo Next");
    return Number(m[1]);
  }

  /** Maiores aceitas por uma faixa simples de peer (`^19.0.0 || ^18.2.0`). */
  function majoresAceitas(faixa: string): number[] {
    return Array.from(faixa.matchAll(/\^(\d+)\./g), (m) => Number(m[1]));
  }

  it("SEC-003-12 · react-leaflet declara suporte à major do React do App Router", () => {
    const vendorizada = majorVendorizada();
    const peers = lerJson<{ peerDependencies: Record<string, string> }>(
      "node_modules/react-leaflet/package.json",
    ).peerDependencies;
    expect(
      majoresAceitas(peers.react),
      `react-leaflet aceita react "${peers.react}", mas o App Router roda React ${vendorizada}. ` +
        "Com o react-leaflet@4 sob React 19 o mapa quebra no navegador.",
    ).toContain(vendorizada);
  });

  it("SEC-003-13 · o React instalado é a MESMA major do React do App Router", () => {
    const instalada = partes(lerJson<{ version: string }>("node_modules/react/package.json").version)[0];
    expect(instalada, "a suíte Vitest usaria outro React que a produção").toBe(majorVendorizada());
  });
});

/**
 * # `SEC-003` · o corpo da requisição continua chegando EM FLUXO
 *
 * O teto de upload (`RC-STO-01`, e o limite declarado do `SEC-009`) só é real
 * porque o Next entrega o corpo ao route handler **sem bufferizar**: é o
 * handler que lê, conta e CANCELA o fluxo ao passar do teto. Reverificado no
 * código do `next@15.5.25` instalado: `getCloneableBody` só pendura ouvintes
 * passivos (`end`/`error`), que não põem o fluxo para correr; quem bufferiza é
 * `cloneBodyStream()`, e ele só é chamado no caminho de MIDDLEWARE
 * (`next-server.js`, depois de `if (!middleware) return`).
 *
 * O Next 15 acrescentou justamente um caminho novo de middleware no runtime
 * Node, que clona o corpo até `middlewareClientMaxBodySize` (10 MB por
 * padrão). Então a garantia agora depende de uma AUSÊNCIA — e ausência que
 * ninguém afirma é ausência que alguém desfaz sem saber o preço. Criar um
 * `middleware.ts` (ou o `proxy.ts` do Next 16) faria o servidor bufferizar o
 * corpo inteiro antes de o teto do handler rodar.
 */
describe("SEC-003 · corpo em fluxo até o handler", () => {
  it("SEC-003-11 · não existe middleware nem proxy no projeto", () => {
    const candidatos = ["", "src/"].flatMap((dir) =>
      ["middleware", "proxy"].flatMap((nome) =>
        [".ts", ".js", ".mjs", ".tsx"].map((ext) => `${dir}${nome}${ext}`),
      ),
    );
    const existentes = candidatos.filter((relativo) => {
      try {
        readFileSync(path.join(RAIZ, relativo));
        return true;
      } catch {
        return false;
      }
    });
    expect(
      existentes,
      "um middleware faz o Next bufferizar o corpo ANTES do handler — o teto de " +
        "upload deixa de proteger a memória. Reavalie `readMultipartWithinLimit` " +
        "e docs/SECURITY.md §8.27 antes de acrescentar um.",
    ).toEqual([]);
  });
});

/**
 * # `SEC-003` · a validação de ambiente continua na SUBIDA
 *
 * Um upgrade de framework é o momento em que costuma aparecer a tentação de
 * mover inicialização para outro lugar — um `instrumentation.ts`, um hook do
 * framework novo. Se a validação saísse do caminho de carga dos módulos, a
 * aplicação subiria em produção sem `APP_ORIGINS`, com `STORAGE_ROOT`
 * relativo ou com `AUTH_SECRET` padrão, e nenhum teste de rota perceberia,
 * porque os testes definem o ambiente antes.
 *
 * O teste importa o módulo que TODA rota com banco ou sessão importa e exige
 * que ele recuse o ambiente de produção incompleto.
 */
describe("SEC-003 · validação de ambiente na subida", () => {
  const env = process.env as Record<string, string | undefined>;
  const salvo = { ...env };

  afterEach(() => {
    for (const k of Object.keys(env)) if (!(k in salvo)) delete env[k];
    Object.assign(env, salvo);
    vi.resetModules();
  });

  it("SEC-003-09 · carregar o cliente do banco em produção incompleta FALHA", async () => {
    env.NODE_ENV = "production";
    env.DATABASE_URL = "postgresql://user:pass@localhost:5432/db";
    env.AUTH_SECRET = "a-production-secret-that-is-long-enough-123";
    env.STORAGE_ROOT = path.resolve("/srv/alfaos-storage-fixture");
    delete env.APP_ORIGINS;
    delete env.NEXT_PHASE;

    vi.resetModules();
    await expect(import("@/lib/prisma")).rejects.toThrow(/APP_ORIGINS/);
  });

  it("SEC-003-10 · CONTROLE: com o ambiente completo, o mesmo módulo carrega", async () => {
    // Sem este controle, o teste acima passaria com um `prisma.ts` quebrado
    // por qualquer outro motivo.
    env.NODE_ENV = "production";
    env.DATABASE_URL = "postgresql://user:pass@localhost:5432/db";
    env.AUTH_SECRET = "a-production-secret-that-is-long-enough-123";
    env.STORAGE_ROOT = path.resolve("/srv/alfaos-storage-fixture");
    env.APP_ORIGINS = "https://app.exemplo.com.br";
    delete env.NEXT_PHASE;

    vi.resetModules();
    await expect(import("@/lib/prisma")).resolves.toBeDefined();
  });
});
