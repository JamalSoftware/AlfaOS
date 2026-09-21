import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, chmodSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * # `RC-1F-B` addendum — `OPS-BACKUP-CONSISTENCY`
 *
 * A versão anterior do backup copiava banco e storage com o web NO AR e dizia
 * que a ordem (banco primeiro) só podia produzir arquivo órfão. Estava errado:
 *
 *   T1  o dump grava a linha da evidência X, apontando para o arquivo X
 *   T2  o técnico apaga a evidência pela aplicação
 *   T3  a aplicação apaga o arquivo X (`removeEvidence`)
 *   T4  o tar roda — e X não existe mais
 *
 * Restaurar essa geração dá banco referenciando foto que o backup não tem.
 *
 * Estes testes EXECUTAM o script com `systemctl`, `pg_dump` e `tar` falsos e
 * afirmam sobre a ORDEM real dos passos e sobre o que sobra em disco. Ler o
 * texto do script provaria que ele menciona "parar"; só rodá-lo prova que ele
 * para ANTES do dump e sobe o serviço mesmo quando o dump falha.
 */

const SCRIPT = path.join(process.cwd(), "deploy", "bin", "alfaos-backup.sh").replace(/\\/g, "/");
const RUNBOOK = readFileSync(path.join(process.cwd(), "docs", "DEPLOYMENT.md"), "utf8");

const STUB_SYSTEMCTL = `#!/usr/bin/env bash
estado="$STUB_STATE/web"
case "$1" in
  stop)
    echo "stop" >> "$STUB_LOG"
    [ -n "\${STUB_STOP_FAIL:-}" ] && exit 1
    # "Parou" sem parar: o serviço responde 0 e continua ativo.
    [ -n "\${STUB_STOP_SILENT:-}" ] && exit 0
    echo inactive > "$estado"
    exit 0 ;;
  start)
    echo "start" >> "$STUB_LOG"
    [ -n "\${STUB_START_FAIL:-}" ] && exit 1
    echo active > "$estado"
    exit 0 ;;
  is-active)
    [ "$(cat "$estado")" = "active" ] ;;
  *) exit 0 ;;
esac
`;

/**
 * O falso `pg_dump` REGISTRA o que recebeu — `SEC-001`.
 *
 * A versão anterior aceitava qualquer argv e só ecoava "dump". Com isso, um
 * `pg_dump` invocado SEM alvo de banco nenhum passava por todos os testes: o
 * stub respondia 0, a geração saía `COMPLETE`, e no servidor de verdade o libpq
 * cairia no nome do usuário do sistema (`root`) e o backup nunca funcionaria.
 * Um stub que aceita qualquer coisa não testa o contrato, testa a si mesmo.
 *
 * Grava argv e as variáveis do libpq em arquivos separados para que o teste
 * afirme sobre cada um — inclusive que a senha NÃO está em argv.
 */
const STUB_PGDUMP = `#!/usr/bin/env bash
echo "dump" >> "$STUB_LOG"
printf '%s\\n' "$@" > "$STUB_STATE/pgdump.argv"
{
  echo "PGDATABASE=\${PGDATABASE:-}"
  echo "PGHOST=\${PGHOST:-}"
  echo "PGPORT=\${PGPORT:-}"
  echo "PGUSER=\${PGUSER:-}"
  echo "PGPASSWORD=\${PGPASSWORD:-}"
} > "$STUB_STATE/pgdump.env"
[ -n "\${STUB_DUMP_FAIL:-}" ] && exit 1
echo "-- fake sql de teste"
`;

const STUB_TAR = `#!/usr/bin/env bash
echo "tar" >> "$STUB_LOG"
[ -n "\${STUB_TAR_FAIL:-}" ] && exit 1
destino=""
anterior=""
for arg in "$@"; do
  [ "$anterior" = "--file" ] && destino="$arg"
  anterior="$arg"
done
echo "conteudo falso do storage" | gzip -9 > "$destino"
`;

const STUB_FLOCK = `#!/usr/bin/env bash
[ -n "\${STUB_FLOCK_FAIL:-}" ] && exit 1
exit 0
`;

/**
 * `date` controlável só onde o teste precisa decidir a FAIXA de retenção.
 *
 * A promoção para `weekly`/`monthly` depende do dia (`date -u +%u`, `+%d`), e um
 * teste que esperasse domingo não seria teste. Todo outro formato — inclusive o
 * do id da geração — vai para o `date` de verdade, por CAMINHO ABSOLUTO: o
 * `PATH` deste processo é o do Windows, e delegar por ele deixa o `exec` do
 * bash sem achar o binário.
 */
const STUB_DATE = `#!/usr/bin/env bash
if [ -n "\${STUB_FORCE_WEEKLY:-}" ] && [ "$*" = "-u +%u" ]; then echo 7; exit 0; fi
if [ -n "\${STUB_FORCE_MONTHLY:-}" ] && [ "$*" = "-u +%d" ]; then echo 01; exit 0; fi
exec "$STUB_REAL_DATE" "$@"
`;

/** `cp` que falha sob demanda: é o vetor do SEC-012. */
const STUB_CP = `#!/usr/bin/env bash
if [ -n "\${STUB_CP_FAIL:-}" ]; then
  echo "cp: falha simulada" >&2
  exit 1
fi
exec "$STUB_REAL_CP" "$@"
`;

/** Onde estão os binários reais, para os stubs delegarem sem depender do PATH. */
function resolverBinario(nome: string): string {
  const r = spawnSync("bash", ["-c", `command -v ${nome}`], { encoding: "utf8" });
  const caminho = (r.stdout ?? "").trim();
  if (!caminho) throw new Error(`binario ${nome} nao encontrado para os stubs`);
  return caminho;
}
const BIN_DATE = resolverBinario("date");
const BIN_CP = resolverBinario("cp");

interface Cenario {
  raiz: string;
  destino: string;
  log: () => string[];
  saida: { status: number | null; stdout: string; stderr: string };
}

let temporarios: string[] = [];

function montar(): { raiz: string; env: Record<string, string> } {
  const raiz = mkdtempSync(path.join(os.tmpdir(), "alfaos-backup-"));
  temporarios.push(raiz);
  const bin = path.join(raiz, "bin");
  const estado = path.join(raiz, "estado");
  const storage = path.join(raiz, "storage");
  const destino = path.join(raiz, "backups");
  for (const dir of [bin, estado, storage, destino]) mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(storage, "foto.jpg"), "bytes");
  writeFileSync(path.join(estado, "web"), "active");

  for (const [nome, corpo] of [
    ["systemctl", STUB_SYSTEMCTL],
    ["pg_dump", STUB_PGDUMP],
    ["tar", STUB_TAR],
    ["flock", STUB_FLOCK],
    ["date", STUB_DATE],
    ["cp", STUB_CP],
  ] as const) {
    const alvo = path.join(bin, nome);
    writeFileSync(alvo, corpo);
    chmodSync(alvo, 0o755);
  }

  const envFile = path.join(raiz, "alfaos.env");
  writeFileSync(
    envFile,
    [
      `STORAGE_ROOT=${storage.replace(/\\/g, "/")}`,
      // O alvo do dump vem DAQUI (`SEC-001`). Senha com `$` e com `%40`
      // codificado de propósito: é o valor que o `. arquivo` de antes
      // reescrevia em silêncio (`SEC-006`).
      `DATABASE_URL=postgresql://alfa_user:se%24nha%40forte@db.local:6543/alfaos_prod?schema=public`,
      "",
    ].join("\n"),
  );

  return {
    raiz,
    env: {
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      // Os stubs de `date` e `cp` delegam por caminho ABSOLUTO (ver STUB_DATE).
      STUB_REAL_DATE: BIN_DATE,
      STUB_REAL_CP: BIN_CP,
      ALFAOS_ENV_FILE: envFile.replace(/\\/g, "/"),
      ALFAOS_BACKUP_DIR: destino.replace(/\\/g, "/"),
      ALFAOS_BACKUP_LOCK: path.join(raiz, "backup.lock").replace(/\\/g, "/"),
      ALFAOS_WEB_UNIT: "alfaos-web",
      STUB_LOG: path.join(raiz, "ordem.log").replace(/\\/g, "/"),
      STUB_STATE: estado.replace(/\\/g, "/"),
    },
  };
}

function rodar(extra: Record<string, string> = {}): Cenario {
  const { raiz, env } = montar();
  const resultado = spawnSync("bash", [SCRIPT], {
    env: { ...process.env, ...env, ...extra },
    encoding: "utf8",
    timeout: 120_000,
  });
  const logPath = path.join(raiz, "ordem.log");
  return {
    raiz,
    destino: path.join(raiz, "backups"),
    log: () =>
      existsSync(logPath)
        ? readFileSync(logPath, "utf8").split("\n").map((l) => l.trim()).filter(Boolean)
        : [],
    saida: { status: resultado.status, stdout: resultado.stdout ?? "", stderr: resultado.stderr ?? "" },
  };
}

const diarios = (c: Cenario) => readdirSync(path.join(c.destino, "daily"));
const manifesto = (c: Cenario) => {
  const nome = diarios(c).find((f) => f.endsWith(".manifest"));
  if (!nome) return null;
  const texto = readFileSync(path.join(c.destino, "daily", nome), "utf8");
  return Object.fromEntries(
    texto.split("\n").filter(Boolean).map((linha) => linha.split("=") as [string, string]),
  ) as Record<string, string>;
};

beforeEach(() => {
  temporarios = [];
});

afterEach(() => {
  for (const dir of temporarios) rmSync(dir, { recursive: true, force: true });
});

describe("OPS-BACKUP-CONSISTENCY — a janela de manutenção", () => {
  it("OPS-BACKUP-CONSISTENCY-01 · o web PARA antes do dump do banco", () => {
    const c = rodar();
    expect(c.saida.status, c.saida.stderr).toBe(0);
    const ordem = c.log();
    expect(ordem.indexOf("stop")).toBeGreaterThanOrEqual(0);
    expect(ordem.indexOf("stop")).toBeLessThan(ordem.indexOf("dump"));
  });

  it("OPS-BACKUP-CONSISTENCY-02 · o storage é arquivado DEPOIS do dump e ANTES de o web voltar", () => {
    const ordem = rodar().log();
    expect(ordem.indexOf("dump")).toBeLessThan(ordem.indexOf("tar"));
    expect(ordem.indexOf("tar")).toBeLessThan(ordem.indexOf("start"));
    // Nenhum `start` entre o dump e o tar: a janela é uma só.
    expect(ordem.slice(ordem.indexOf("dump"), ordem.indexOf("tar"))).not.toContain("start");
  });

  it("OPS-BACKUP-CONSISTENCY-03 · a cópia externa só acontece com o web já no ar", () => {
    const c = rodar({ ALFAOS_OFFSITE_CMD: 'echo offsite >> "$STUB_LOG"' });
    expect(c.saida.status, c.saida.stderr).toBe(0);
    const ordem = c.log();
    expect(ordem).toContain("offsite");
    expect(ordem.indexOf("start")).toBeLessThan(ordem.indexOf("offsite"));
  });

  it("OPS-BACKUP-CONSISTENCY-04 · dump que falha ainda sobe o web, e a volta não é silenciosa", () => {
    const c = rodar({ STUB_DUMP_FAIL: "1" });
    expect(c.saida.status).not.toBe(0);
    const ordem = c.log();
    expect(ordem).toEqual(["stop", "dump", "start"]);
    expect(c.saida.stderr).toMatch(/pg_dump FALHOU/);
  });

  it("OPS-BACKUP-CONSISTENCY-05 · tar que falha ainda sobe o web", () => {
    const c = rodar({ STUB_TAR_FAIL: "1" });
    expect(c.saida.status).not.toBe(0);
    expect(c.log()).toEqual(["stop", "dump", "tar", "start"]);
    expect(c.saida.stderr).toMatch(/tar do storage FALHOU/);
  });

  it("OPS-BACKUP-CONSISTENCY-06 · sem PROVAR que o web parou, nada é copiado", () => {
    // (a) o comando de parada falha
    const falhou = rodar({ STUB_STOP_FAIL: "1" });
    expect(falhou.saida.status).not.toBe(0);
    expect(falhou.log()).toEqual(["stop"]);
    expect(falhou.saida.stderr).toMatch(/ABORTADO/);

    // (b) o comando responde 0 e o serviço CONTINUA ativo — o caso traiçoeiro
    const mentiu = rodar({ STUB_STOP_SILENT: "1" });
    expect(mentiu.saida.status).not.toBe(0);
    expect(mentiu.log()).toEqual(["stop"]);
    expect(mentiu.saida.stderr).toMatch(/continua ativo/);
    expect(diarios(mentiu)).toHaveLength(0);
  });

  it("OPS-BACKUP-CONSISTENCY-07 · geração que falhou não vira geração boa", () => {
    const c = rodar({ STUB_TAR_FAIL: "1" });
    expect(diarios(c)).toHaveLength(0);
    // E não sobra rastro parcial passando por backup.
    expect(existsSync(path.join(c.destino, ".parcial"))).toBe(false);
  });

  it("OPS-BACKUP-CONSISTENCY-08 · banco e storage da mesma geração, com checksum conferível", () => {
    const c = rodar();
    const arquivos = diarios(c);
    expect(arquivos).toHaveLength(3);

    const m = manifesto(c)!;
    expect(m.status).toBe("COMPLETE");
    expect(m.web_stopped_during_copy).toBe("yes");
    // O id da geração é o MESMO nos dois artefatos: restaurar banco de uma
    // geração com storage de outra é o defeito que isto impede.
    expect(m.database).toBe(`alfaos-${m.generation}-db.sql.gz`);
    expect(m.storage).toBe(`alfaos-${m.generation}-storage.tar.gz`);
    for (const nome of arquivos) expect(nome.startsWith(`alfaos-${m.generation}`)).toBe(true);

    const sha = (arquivo: string) =>
      createHash("sha256").update(readFileSync(path.join(c.destino, "daily", arquivo))).digest("hex");
    expect(m.database_sha256).toBe(sha(m.database));
    expect(m.storage_sha256).toBe(sha(m.storage));

    /*
      Os três nomes DERIVAM do mesmo `$GERACAO`, e isso precisa ser estrutural.
      Uma segunda leitura do relógio para o nome do storage produz o mesmo texto
      quase sempre — e diverge no segundo em que a execução atravessa a virada,
      que é justamente quando ninguém está olhando. Comparar só o resultado
      deixaria passar.
    */
    const script = readFileSync(SCRIPT, "utf8");
    expect(script).toMatch(/DB_TMP="\$TMP\/alfaos-\$GERACAO-db\.sql\.gz"/);
    expect(script).toMatch(/ST_TMP="\$TMP\/alfaos-\$GERACAO-storage\.tar\.gz"/);
    expect(script).toMatch(/MAN_TMP="\$TMP\/alfaos-\$GERACAO\.manifest"/);
  });

  it("OPS-BACKUP-CONSISTENCY-09 · a restauração exige UMA geração e a conferência de checksum", () => {
    const secao = /## 10\. Restauração[\s\S]*?\n## 11\./.exec(RUNBOOK)?.[0] ?? "";
    expect(secao).toMatch(/geração/i);
    expect(secao).toMatch(/sha256sum|checksum/i);
    expect(secao).toMatch(/manifest/i);
    // Misturar gerações é proibido em palavras, não só implícito.
    expect(secao).toMatch(/nunca misture|não misture|jamais misture/i);
  });

  it("OPS-BACKUP-CONSISTENCY-10 · web que não volta é falha crítica visível, não aviso", () => {
    const c = rodar({ STUB_START_FAIL: "1" });
    expect(c.saida.status).not.toBe(0);
    expect(c.saida.stderr).toMatch(/FALHA CRITICA/);
    expect(c.saida.stderr).toMatch(/systemctl start alfaos-web/);
    // Nenhum segredo no que o operador lê.
    expect(c.saida.stdout + c.saida.stderr).not.toMatch(/PGPASSWORD|ENCRYPTION_KEY|postgres:\/\//);
  });

  it("OPS-BACKUP-CONSISTENCY-11 · outra execução em andamento não abre janela nenhuma", () => {
    const c = rodar({ STUB_FLOCK_FAIL: "1" });
    expect(c.saida.status).not.toBe(0);
    expect(c.log()).toEqual([]); // nem parou o web, nem copiou nada
  });
});

/**
 * # `SEC-001` — o `pg_dump` tem alvo, e o alvo é o banco da aplicação
 *
 * A revisão independente encontrou `pg_dump` sem `--dbname` e sem `PGDATABASE`.
 * Sem alvo, o libpq usa o nome do usuário do sistema operacional — `root`, que
 * é quem roda o backup — e o dump diário do produto nunca teria funcionado.
 * Pior que falhar: com um `PGDATABASE` qualquer no ambiente, a geração sairia
 * rotulada `COMPLETE` com o banco ERRADO dentro.
 */
describe("SEC-001 — alvo do dump", () => {
  const argv = (c: Cenario): string[] => {
    const arquivo = path.join(c.raiz, "estado", "pgdump.argv");
    return existsSync(arquivo)
      ? readFileSync(arquivo, "utf8").split("\n").filter(Boolean)
      : [];
  };
  const libpq = (c: Cenario): Record<string, string> => {
    const arquivo = path.join(c.raiz, "estado", "pgdump.env");
    if (!existsSync(arquivo)) return {};
    return Object.fromEntries(
      readFileSync(arquivo, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    );
  };

  it("SEC-001-01 · o banco da aplicação é passado explicitamente ao pg_dump", () => {
    const c = rodar();
    expect(c.saida.status, c.saida.stderr).toBe(0);
    expect(argv(c)).toContain("--dbname=alfaos_prod");
  });

  it("SEC-001-02 · host, porta e usuário vêm da DATABASE_URL, não do host", () => {
    const vars = libpq(rodar());
    expect(vars.PGHOST).toBe("db.local");
    expect(vars.PGPORT).toBe("6543");
    expect(vars.PGUSER).toBe("alfa_user");
  });

  it("SEC-001-03 · a senha chega pelo AMBIENTE, percent-decodificada, nunca em argv", () => {
    const c = rodar();
    // `se%24nha%40forte` → `se$nha@forte`. O `$` prova que nada foi expandido.
    expect(libpq(c).PGPASSWORD).toBe("se$nha@forte");
    for (const arg of argv(c)) {
      expect(arg).not.toContain("se$nha@forte");
      expect(arg).not.toMatch(/postgres(ql)?:\/\//);
    }
    expect(argv(c).join(" ")).not.toMatch(/--password|-W\b/);
  });

  it("SEC-001-04 · sem DATABASE_URL o backup NÃO abre a janela de manutenção", () => {
    /*
      A recusa vem ANTES de parar o serviço: um erro de configuração não pode
      custar uma janela de manutenção, e muito menos deixar o web parado
      enquanto alguém descobre por quê.
    */
    const { raiz, env } = montar();
    writeFileSync(
      env.ALFAOS_ENV_FILE,
      `STORAGE_ROOT=${path.join(raiz, "storage").replace(/\\/g, "/")}\n`,
    );
    const r = spawnSync("bash", [SCRIPT], {
      env: { ...process.env, ...env },
      encoding: "utf8",
      timeout: 120_000,
    });
    expect(r.status).toBe(78);
    expect(r.stderr).toMatch(/DATABASE_URL ausente/);
    const logPath = path.join(raiz, "ordem.log");
    expect(existsSync(logPath) ? readFileSync(logPath, "utf8").trim() : "").toBe("");
  });

});

/**
 * # `SEC-012` — falha ao promover faixa não é sucesso
 *
 * `cp -p` para `weekly`/`monthly` tinha o resultado IGNORADO: disco cheio ou
 * permissão, e o script seguia para a poda e terminava com `exit=0`. O operador
 * lia um relatório verde enquanto a cópia semanal não existia — e a poda então
 * empurrava o último semanal BOM para fora da retenção.
 */
describe("SEC-012 — promoção de faixa de retenção", () => {
  /** Roda forçando o dia da semana/mês pela variável que o teste injeta. */
  const rodarComFaixa = (extra: Record<string, string> = {}) =>
    rodar({ ...extra, STUB_FORCE_WEEKLY: "1" });

  it("SEC-012-01 · num dia de faixa, a geração é copiada para weekly", () => {
    const c = rodarComFaixa();
    expect(c.saida.status, c.saida.stderr).toBe(0);
    expect(readdirSync(path.join(c.destino, "weekly"))).toHaveLength(3);
  });

  it("SEC-012-02 · cópia que falha NÃO termina com sucesso", () => {
    const c = rodarComFaixa({ STUB_CP_FAIL: "1" });
    expect(c.saida.status).not.toBe(0);
    expect(c.saida.stderr).toMatch(/copia para weekly FALHOU|copia para weekly incompleta/);
  });

  it("SEC-012-03 · cópia que falha NÃO poda a faixa: a última boa fica", () => {
    /*
      O ponto do achado. Com a retenção semanal cheia e a promoção falhando, a
      poda rodava de qualquer forma e jogava fora a geração mais antiga para
      abrir espaço a uma que nunca chegou.
    */
    const { raiz, env } = montar();
    const weekly = path.join(raiz, "backups", "weekly");
    mkdirSync(weekly, { recursive: true });
    const antigas: string[] = [];
    for (let k = 1; k <= 5; k++) {
      const id = `alfaos-2020010${k}T000000Z`;
      for (const sufixo of ["-db.sql.gz", "-storage.tar.gz", ".manifest"]) {
        writeFileSync(path.join(weekly, `${id}${sufixo}`), "geracao antiga boa");
      }
      antigas.push(`${id}.manifest`);
    }

    const r = spawnSync("bash", [SCRIPT], {
      env: { ...process.env, ...env, STUB_FORCE_WEEKLY: "1", STUB_CP_FAIL: "1" },
      encoding: "utf8",
      timeout: 120_000,
    });

    expect(r.status).not.toBe(0);
    const sobraram = readdirSync(weekly);
    for (const manifesto of antigas) {
      expect(sobraram, `${manifesto} foi podado apesar de a promoção falhar`).toContain(
        manifesto,
      );
    }
  });

  it("SEC-012-04 · a diária completa não é desfeita por causa da faixa", () => {
    // O dia não é perda total: a geração diária fica, e o código de saída diz
    // que a retenção não está em ordem.
    const c = rodarComFaixa({ STUB_CP_FAIL: "1" });
    expect(diarios(c)).toHaveLength(3);
    expect(c.saida.stderr).toMatch(/diaria COMPLETA, retencao de faixa INCOMPLETA/);
  });
});
