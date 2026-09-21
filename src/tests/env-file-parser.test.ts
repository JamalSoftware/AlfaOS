import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * # `SEC-006` — o ambiente de produção é LIDO, não EXECUTADO
 *
 * ## O achado
 *
 * `/etc/alfaos/alfaos.env` é consumido por dois mundos com gramáticas
 * diferentes:
 *
 * | quem | como | efeito |
 * |---|---|---|
 * | systemd | `EnvironmentFile=` | lê o arquivo LITERALMENTE |
 * | scripts | `. "$ENV_FILE"` | EXECUTA o arquivo como código de shell |
 *
 * E o caminho que executava roda como **root** (`alfaos-backup.service`). Um
 * valor como `DB_PASSWORD=sen$(id)ha` é senha para um lado e comando para o
 * outro. Nem é preciso um atacante: uma senha com `$`, backtick, `\` ou aspas
 * era silenciosamente reescrita por um lado e não pelo outro, e a divergência
 * aparecia como "o web conecta e o worker não".
 *
 * ## O que estes testes provam
 *
 * O parser é EXECUTADO de verdade, contra arquivos com os caracteres hostis, e
 * o valor resolvido é comparado com o literal. Nenhuma substituição de comando
 * roda — e a prova disso é um sentinela: o valor mandaria criar um arquivo, e o
 * arquivo não existe depois.
 *
 * ## Limite declarado
 *
 * Isto não executa o systemd — ele não está disponível aqui. A equivalência é
 * garantida pela outra ponta: onde a gramática do systemd faria algo que este
 * parser não faz (escape de `\` entre aspas duplas, continuação de linha), o
 * parser **recusa o arquivo** em vez de adivinhar. Duas fontes divergindo em
 * silêncio é o defeito; falhar alto mantém as duas honestas.
 */

const LIB = path.join(process.cwd(), "deploy", "bin", "alfaos-env.sh").replace(/\\/g, "/");

let raiz = "";

beforeEach(() => {
  raiz = mkdtempSync(path.join(os.tmpdir(), "alfaos-env-"));
});

afterEach(() => {
  rmSync(raiz, { recursive: true, force: true });
});

interface Resultado {
  status: number | null;
  stderr: string;
  /** O valor que o parser resolveu, byte a byte. */
  valor: string;
}

/**
 * Escreve o arquivo, carrega-o pelo parser e devolve o valor de `chave`.
 *
 * O valor sai por arquivo, e não por `echo`, para que nem o teste reintroduza
 * uma passagem por analisador de shell.
 */
function carregar(conteudo: string, chave = "SEGREDO"): Resultado {
  const envFile = path.join(raiz, "alfaos.env").replace(/\\/g, "/");
  const saida = path.join(raiz, "valor.txt").replace(/\\/g, "/");
  writeFileSync(envFile, conteudo);

  const script = `
set -uo pipefail
. "${LIB}"
alfaos_carregar_ambiente "${envFile}" || exit $?
printf '%s' "\${${chave}:-}" > "${saida}"
`;
  const r = spawnSync("bash", ["-c", script], { encoding: "utf8", timeout: 60_000 });
  let valor = "";
  try {
    valor = readFileSync(saida, "utf8");
  } catch {
    valor = "";
  }
  return { status: r.status, stderr: r.stderr ?? "", valor };
}

describe("SEC-006 · o valor chega literal", () => {
  const literais: [string, string, string][] = [
    ["cifrão", "SEGREDO=abc$HOME def", "abc$HOME def"],
    ["substituição de comando", "SEGREDO=abc$(id)def", "abc$(id)def"],
    ["backtick", "SEGREDO=abc`id`def", "abc`id`def"],
    ["barra invertida", "SEGREDO=abc\\ndef", "abc\\ndef"],
    ["espaços no meio", "SEGREDO=uma frase com espacos", "uma frase com espacos"],
    ["iguais no valor", "SEGREDO=a=b=c", "a=b=c"],
    ["aspas simples no meio", "SEGREDO=abc'def", "abc'def"],
    ["aspas duplas no meio", 'SEGREDO=abc"def', 'abc"def'],
    ["ponto e vírgula", "SEGREDO=abc;id;def", "abc;id;def"],
    ["pipe e redirecionamento", "SEGREDO=a|b>c", "a|b>c"],
    ["chave de cifra base64", "SEGREDO=ZTJlLW9ubHktYWVzMjU2==", "ZTJlLW9ubHktYWVzMjU2=="],
    ["aspas duplas envolvendo tudo", 'SEGREDO="com espaco e $HOME"', "com espaco e $HOME"],
    ["aspas simples envolvendo tudo", "SEGREDO='com espaco e $HOME'", "com espaco e $HOME"],
    ["espaço à direita sai", "SEGREDO=valor   ", "valor"],
    ["espaço à direita fica entre aspas", 'SEGREDO="valor   "', "valor   "],
    ["valor vazio", "SEGREDO=", ""],
    ["cerquilha no meio não é comentário", "SEGREDO=a#b", "a#b"],
  ];

  for (const [rotulo, linha, esperado] of literais) {
    it(`SEC-006-01 · ${rotulo}`, () => {
      const r = carregar(`${linha}\n`);
      expect(r.status, r.stderr).toBe(0);
      expect(r.valor).toBe(esperado);
    });
  }

  it("SEC-006-02 · comentário, linha vazia e `export` não confundem", () => {
    const r = carregar(
      ["# comentario", "; outro comentario", "", "export SEGREDO=valor", ""].join("\n"),
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.valor).toBe("valor");
  });

  it("SEC-006-03 · CRLF não deixa CR no fim do valor", () => {
    const r = carregar("SEGREDO=valor\r\nOUTRA=x\r\n");
    expect(r.status, r.stderr).toBe(0);
    expect(r.valor).toBe("valor");
  });

  it("SEC-006-04 · a última linha sem newline é lida", () => {
    const r = carregar("SEGREDO=sem-newline-no-fim");
    expect(r.status, r.stderr).toBe(0);
    expect(r.valor).toBe("sem-newline-no-fim");
  });
});

/**
 * # `SEC-006` · §26 — nada executa, e o sentinela prova
 *
 * As asserções de igualdade acima provam que o valor não foi REESCRITO. Esta
 * prova é outra: que nenhum comando RODOU. O valor manda criar um arquivo; se
 * o parser avaliasse o conteúdo, o arquivo existiria.
 *
 * Sentinela inofensivo de propósito — `touch` num diretório temporário. Nunca
 * se roda conteúdo de atacante no host para "ver o que acontece".
 */
describe("SEC-006 · nenhum comando é executado", () => {
  const vetores: [string, (alvo: string) => string][] = [
    ["substituição $()", (alvo) => `x$(touch ${alvo})x`],
    ["backtick", (alvo) => `x\`touch ${alvo}\`x`],
    ["aritmética $(())", (alvo) => `x$(($(touch ${alvo})+1))x`],
    ["ponto e vírgula", (alvo) => `x; touch ${alvo}`],
    ["and lógico", (alvo) => `x && touch ${alvo}`],
    ["redirecionamento de entrada", (alvo) => `x$(<${alvo})`],
    ["eval aninhado", (alvo) => `x$(eval touch ${alvo})x`],
  ];

  for (const [rotulo, montar] of vetores) {
    it(`SEC-006-05 · ${rotulo} não roda`, () => {
      const sentinela = path.join(raiz, "EXECUTOU").replace(/\\/g, "/");
      const valorLiteral = montar(sentinela);
      const r = carregar(`SEGREDO=${valorLiteral}\n`);

      let executou = true;
      try {
        readFileSync(sentinela);
      } catch {
        executou = false;
      }
      expect(executou, `${rotulo}: o parser EXECUTOU o valor`).toBe(false);

      // E o valor chegou inteiro: nem executado, nem reescrito.
      expect(r.status, r.stderr).toBe(0);
      expect(r.valor).toBe(valorLiteral);
    });
  }
});

describe("SEC-006 · o que não cabe na gramática é RECUSADO, não adivinhado", () => {
  it("SEC-006-06 · `\\` entre aspas duplas recusa o arquivo", () => {
    // O systemd processaria o escape; este parser não. Ler diferente em
    // silêncio é o defeito, então a resposta é erro.
    const r = carregar('SEGREDO="valor\\ncom escape"\n');
    expect(r.status).toBe(78);
    expect(r.stderr).toMatch(/nao e suportado/);
  });

  it("SEC-006-07 · continuação de linha recusa o arquivo", () => {
    const r = carregar("SEGREDO=comeca\\\nCONTINUA=aqui\n");
    expect(r.status).toBe(78);
    expect(r.stderr).toMatch(/continuacao de linha/);
  });

  it("SEC-006-08 · linha sem `=` recusa o arquivo", () => {
    const r = carregar("SEGREDO=ok\nisto nao e atribuicao\n");
    expect(r.status).toBe(78);
    expect(r.stderr).toMatch(/sem '='/);
  });

  it("SEC-006-09 · nome de variável inválido recusa o arquivo", () => {
    for (const linha of ["2COISA=x", "COM-TRACO=x", "COM ESPACO=x", "=x"]) {
      const r = carregar(`${linha}\n`);
      expect(r.status, `${linha} foi aceito`).toBe(78);
      expect(r.stderr).toMatch(/nome de variavel invalido|sem '='/);
    }
  });

  it("SEC-006-10 · arquivo ilegível recusa com EX_CONFIG", () => {
    const r = spawnSync(
      "bash",
      ["-c", `. "${LIB}"; alfaos_carregar_ambiente "${raiz}/nao-existe.env"`],
      { encoding: "utf8" },
    );
    expect(r.status).toBe(78);
    expect(r.stderr).toMatch(/ambiente ilegivel/);
  });
});

/**
 * # `SEC-001` · a tradução de DATABASE_URL para o vocabulário do libpq
 *
 * O `pg_dump` do backup ia SEM alvo de banco. O alvo agora vem da fonte
 * autoritativa, e a tradução precisa acertar percent-encoding, IPv6 e a query
 * do Prisma — errar aqui manda o dump para o lugar errado.
 */
describe("SEC-001 · alvo do libpq derivado da DATABASE_URL", () => {
  interface AlvoPg {
    status: number | null;
    DB?: string;
    HOST?: string;
    PORT?: string;
    USER?: string;
    PASS?: string;
  }

  function derivar(url: string): AlvoPg {
    const saida = path.join(raiz, "pg.txt").replace(/\\/g, "/");
    const script = `
set -uo pipefail
. "${LIB}"
export DATABASE_URL='${url.replace(/'/g, "'\\''")}'
alfaos_exportar_alvo_pg || exit $?
{
  printf 'DB=%s\\n' "\${ALFAOS_PG_DATABASE:-}"
  printf 'HOST=%s\\n' "\${PGHOST:-}"
  printf 'PORT=%s\\n' "\${PGPORT:-}"
  printf 'USER=%s\\n' "\${PGUSER:-}"
  printf 'PASS=%s\\n' "\${PGPASSWORD:-}"
} > "${saida}"
`;
    const r = spawnSync("bash", ["-c", script], { encoding: "utf8", timeout: 60_000 });
    let campos: Record<string, string> = {};
    try {
      campos = Object.fromEntries(
        readFileSync(saida, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
      );
    } catch {
      campos = {};
    }
    return { ...campos, status: r.status };
  }

  it("SEC-001-06 · a URL de produção documentada", () => {
    const r = derivar("postgresql://alfaos:senha@localhost:5432/alfaos?schema=public");
    expect(r.status).toBe(0);
    expect(r.DB).toBe("alfaos");
    expect(r.HOST).toBe("localhost");
    expect(r.PORT).toBe("5432");
    expect(r.USER).toBe("alfaos");
    expect(r.PASS).toBe("senha");
  });

  it("SEC-001-07 · senha percent-encoded é decodificada", () => {
    // `%40` = @, `%24` = $, `%3A` = :, `%2F` = /
    const r = derivar("postgresql://u:p%40ss%24w%3Ard%2F@h:5432/db");
    expect(r.status).toBe(0);
    // O `$` decodificado chega LITERAL: se algo o expandisse, viria vazio.
    expect(r.PASS).toBe("p@ss$w:rd/");
  });

  it("SEC-001-08 · IPv6 entre colchetes não confunde host com porta", () => {
    const r = derivar("postgresql://u:p@[::1]:5433/db");
    expect(r.status).toBe(0);
    expect(r.HOST).toBe("::1");
    expect(r.PORT).toBe("5433");
  });

  it("SEC-001-09 · sem porta e sem senha, só o que existe é exportado", () => {
    const r = derivar("postgresql://u@host/db");
    expect(r.status).toBe(0);
    expect(r.DB).toBe("db");
    expect(r.HOST).toBe("host");
    expect(r.PORT).toBe("");
    expect(r.PASS).toBe("");
  });

  it("SEC-001-10 · URL sem banco é RECUSADA: o alvo seria adivinhado", () => {
    for (const url of ["postgresql://u:p@host:5432", "postgresql://u:p@host:5432/"]) {
      expect(derivar(url).status, url).toBe(78);
    }
  });

  it("SEC-001-11 · nome de banco que pareça string de conexão é recusado", () => {
    // O libpq expande `dbname` quando ele tem `=` ou parece URI: um nome assim
    // mandaria o dump para outro servidor.
    expect(derivar("postgresql://u:p@host:5432/db%3Dx%20host%3Devil").status).toBe(78);
  });

  it("SEC-001-12 · esquema que não é postgres é recusado", () => {
    expect(derivar("mysql://u:p@host:3306/db").status).toBe(78);
  });
});
