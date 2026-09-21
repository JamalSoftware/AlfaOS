import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CTO_PHOTO_MAX_BYTES } from "@/lib/cto";
import { EVIDENCE_MAX_BYTES, SIGNATURE_MAX_BYTES } from "@/lib/service-order-closing";
import { multipartBodyLimit } from "@/lib/multipart-limit";

/**
 * # `RC-1F-B` — os arquivos de implantação são contrato, não sugestão
 *
 * Eles não rodam na suíte: rodam num VPS que ninguém aqui vê. O que os prende à
 * aplicação é este arquivo — ele lê os modelos versionados e confere cada
 * afirmação contra o código real (scripts do `package.json`, tetos de upload,
 * semântica de proxy). Um teto de corpo menor que o da aplicação, um script que
 * não existe ou um `location` servindo o storage passam despercebidos numa
 * revisão de texto e derrubam produção.
 */

const RAIZ = process.cwd();
const ler = (relativo: string) => readFileSync(path.join(RAIZ, relativo), "utf8");
const semComentarios = (texto: string) =>
  texto
    .split("\n")
    .filter((linha) => !/^\s*#/.test(linha))
    .join("\n");
/** Comentário citando `storage.delete(...)` não é uma chamada. */
const semComentariosTs = (texto: string) =>
  texto.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

const UNIT = ler("deploy/systemd/alfaos-web.service");
const BACKUP_UNIT = ler("deploy/systemd/alfaos-backup.service");
const BACKUP_TIMER = ler("deploy/systemd/alfaos-backup.timer");
const NGINX = ler("deploy/nginx/alfaos.conf.template");
const CRONTAB = ler("deploy/cron/alfaos.crontab");
const WRAPPER = ler("deploy/bin/alfaos-job.sh");
const BACKUP = ler("deploy/bin/alfaos-backup.sh");
const RUNBOOK = ler("docs/DEPLOYMENT.md");
const PACKAGE = JSON.parse(ler("package.json")) as { scripts: Record<string, string> };

const APP_DIR = "/opt/alfaos/current";
const ENV_FILE = "/etc/alfaos/alfaos.env";
const STORAGE_DIR = "/srv/alfaos/storage";

function diretivas(unidade: string, chave: string): string[] {
  return semComentarios(unidade)
    .split("\n")
    .map((linha) => linha.trim())
    .filter((linha) => linha.startsWith(`${chave}=`))
    .map((linha) => linha.slice(chave.length + 1).trim());
}

// ---------------------------------------------------------------------------
// systemd
// ---------------------------------------------------------------------------

describe("OPS-SYSTEMD — o serviço web", () => {
  it("OPS-SYSTEMD-01 · roda como usuário dedicado, nunca root", () => {
    expect(diretivas(UNIT, "User")).toEqual(["alfaos"]);
    expect(diretivas(UNIT, "Group")).toEqual(["alfaos"]);
    expect(semComentarios(UNIT)).not.toMatch(/^\s*User\s*=\s*root/m);
    // Privilégio mínimo declarado, não subentendido.
    expect(diretivas(UNIT, "NoNewPrivileges")).toEqual(["true"]);
  });

  it("OPS-SYSTEMD-02 · tem EnvironmentFile, e é o MESMO que os comandos usam", () => {
    expect(diretivas(UNIT, "EnvironmentFile")).toEqual([ENV_FILE]);
    // Uma segunda fonte de ambiente é como web e worker passam a discordar de
    // DATABASE_URL, de STORAGE_ROOT ou das chaves de cifra.
    expect(WRAPPER).toContain(`ALFAOS_ENV_FILE:-${ENV_FILE}`);
    expect(BACKUP).toContain(`ALFAOS_ENV_FILE:-${ENV_FILE}`);
  });

  it("OPS-SYSTEMD-03 · WorkingDirectory é o diretório da aplicação, e o invólucro concorda", () => {
    expect(diretivas(UNIT, "WorkingDirectory")).toEqual([APP_DIR]);
    expect(WRAPPER).toContain(`ALFAOS_APP_DIR:-${APP_DIR}`);
  });

  it("OPS-SYSTEMD-04 · ExecStart chama um script que EXISTE no package.json", () => {
    const [execStart] = diretivas(UNIT, "ExecStart");
    const script = /npm run (\S+)/.exec(execStart)?.[1];
    expect(script).toBeDefined();
    expect(Object.keys(PACKAGE.scripts)).toContain(script);
    expect(PACKAGE.scripts[script!]).toBe("next start");
  });

  it("OPS-SYSTEMD-05 · reinício conservador: falha reinicia, erro de configuração para de vez", () => {
    expect(diretivas(UNIT, "Restart")).toEqual(["on-failure"]);
    expect(Number(diretivas(UNIT, "RestartSec")[0])).toBeGreaterThanOrEqual(3);
    expect(diretivas(UNIT, "StartLimitBurst").length).toBe(1);
    expect(diretivas(UNIT, "StartLimitIntervalSec").length).toBe(1);
  });

  it("OPS-SYSTEMD-06 · o storage é o único caminho gravável concedido", () => {
    expect(diretivas(UNIT, "ReadWritePaths")).toEqual([STORAGE_DIR]);
    expect(diretivas(UNIT, "ProtectSystem")[0]).toMatch(/full|strict/);
  });

  /**
   * `SEC-005` — o ouvinte do Next é de LOOPBACK, afirmado na DIRETIVA.
   *
   * O detector antigo olhava o `upstream` do Nginx e a palavra "loopback" no
   * runbook. Nenhum dos dois é o processo: `next start` sem `--hostname` escuta
   * em `0.0.0.0`, e quem chega direto na porta 3000 não passa pelo proxy. Caem
   * juntos o teto de corpo, o HTTPS e a aritmética do limitador —
   * `TRUSTED_PROXY_HOPS=1` supõe UM proxy que ACRESCENTA a `x-forwarded-for`,
   * então numa requisição direta o cliente escolhe o IP a ser contado.
   */
  it("SEC-005-01 · ExecStart prende o ouvinte ao loopback", () => {
    const [execStart] = diretivas(UNIT, "ExecStart");
    expect(execStart).toMatch(/--hostname[= ]127\.0\.0\.1(\s|$)/);
    expect(execStart).not.toMatch(/--hostname[= ]0\.0\.0\.0/);
  });

  it("SEC-005-02 · nenhuma diretiva reabre o ouvinte para todas as interfaces", () => {
    /*
      `next start` também aceita `HOSTNAME` pelo ambiente. Uma diretiva
      `Environment=HOSTNAME=0.0.0.0` desfaria o `--hostname` sem tocar o
      `ExecStart` — o lugar onde alguém olharia.
    */
    for (const ambiente of diretivas(UNIT, "Environment")) {
      expect(ambiente).not.toMatch(/^HOSTNAME=(?!127\.0\.0\.1)/);
    }
    expect(semComentarios(UNIT)).not.toMatch(/0\.0\.0\.0|::/);
  });

  it("SEC-005-03 · o alvo do proxy é o MESMO endereço que o serviço escuta", () => {
    // Duas afirmações que precisam concordar: o Nginx encaminha para
    // 127.0.0.1:<porta> e o serviço escuta nesse endereço. Divergir daria um
    // 502 no deploy, ou — pior — um ouvinte público que ninguém procurou.
    const [execStart] = diretivas(UNIT, "ExecStart");
    const host = /--hostname[= ](\S+)/.exec(execStart)?.[1];
    expect(NGINX).toContain(`server ${host}:3000;`);
  });
});

// ---------------------------------------------------------------------------
// Nginx
// ---------------------------------------------------------------------------

describe("OPS-NGINX — o proxy reverso", () => {
  it("OPS-NGINX-01 · encaminha para o Next.js em loopback, e a porta não é pública", () => {
    expect(NGINX).toMatch(/upstream alfaos_app \{[\s\S]*server 127\.0\.0\.1:3000;/);
    expect(NGINX).toMatch(/proxy_pass http:\/\/alfaos_app;/);
    expect(semComentarios(NGINX)).not.toMatch(/server 0\.0\.0\.0:|listen 3000/);
  });

  it("OPS-NGINX-02 · cabeçalhos encaminhados batem com o contrato do limitador", () => {
    /*
      O limitador lê `x-forwarded-for` na posição (total - TRUSTED_PROXY_HOPS).
      Com UM proxy que ACRESCENTA, isso é TRUSTED_PROXY_HOPS=1. Sobrescrever com
      `$remote_addr` faria a conta apontar para o próprio Nginx, e o limite por
      IP viraria um limite global.
    */
    expect(NGINX).toMatch(/proxy_set_header X-Forwarded-For\s+\$proxy_add_x_forwarded_for;/);
    expect(NGINX).not.toMatch(/proxy_set_header X-Forwarded-For\s+\$remote_addr;/);
    expect(NGINX).toMatch(/proxy_set_header X-Forwarded-Proto\s+\$scheme;/);
    expect(NGINX).toMatch(/proxy_set_header Host\s+\$host;/);
    expect(RUNBOOK).toMatch(/TRUSTED_PROXY_HOPS\s*=\s*"?1/);
  });

  it("OPS-NGINX-03 · o teto de corpo é explícito e MAIOR que o da aplicação", () => {
    const [, valor, unidade] = /client_max_body_size\s+(\d+)([kmKM]);/.exec(NGINX) ?? [];
    expect(valor, "client_max_body_size ausente").toBeDefined();
    const bytes = Number(valor) * (unidade.toLowerCase() === "m" ? 1024 * 1024 : 1024);
    const maiorCorpo = Math.max(
      multipartBodyLimit(EVIDENCE_MAX_BYTES),
      multipartBodyLimit(CTO_PHOTO_MAX_BYTES),
      multipartBodyLimit(SIGNATURE_MAX_BYTES),
    );
    // Menor que isso: o técnico recebe um 413 de HTML do Nginx em vez da recusa
    // tipada da aplicação, e o aplicativo não sabe o que fazer com ela.
    expect(bytes).toBeGreaterThanOrEqual(maiorCorpo);
  });

  it("OPS-NGINX-04 · o storage NUNCA é servido como estático", () => {
    const ativo = semComentarios(NGINX);
    expect(ativo).not.toContain(STORAGE_DIR);
    expect(ativo).not.toMatch(/\b(alias|root)\s+\/srv/);
    expect(ativo).not.toMatch(/location\s+[^{]*storage/i);
  });
});

// ---------------------------------------------------------------------------
// cron
// ---------------------------------------------------------------------------

interface EntradaCron {
  agenda: string;
  comando: string;
  ativa: boolean;
}

const ENTRADAS: EntradaCron[] = CRONTAB.split("\n")
  .map((linha) => linha.trim())
  .filter((linha) => /^#?(\*|\d)/.test(linha) && linha.includes("alfaos-"))
  .map((linha) => {
    const ativa = !linha.startsWith("#");
    const limpa = ativa ? linha : linha.replace(/^#\s*/, "");
    const campos = limpa.split(/\s+/);
    return {
      agenda: campos.slice(0, 5).join(" "),
      comando: campos.slice(5).join(" "),
      ativa,
    };
  });

const entrada = (alvo: string) =>
  ENTRADAS.find((e) => e.comando.includes(alvo));

describe("OPS-CRON — o agendamento", () => {
  it("OPS-CRON-01 · outbox a cada minuto, ativo — é a entrega de notificação ao técnico", () => {
    const e = entrada("outbox:work");
    expect(e?.agenda).toBe("* * * * *");
    expect(e?.ativa).toBe(true);
  });

  it("OPS-CRON-02 · diagnóstico a cada minuto, e COMENTADO até a ativação pelo dono", () => {
    const e = entrada("diagnostics:refresh");
    expect(e?.agenda).toBe("* * * * *");
    // A fase entrega CONFIGURADO, não ATIVO: a recorrência só entra depois de o
    // dono ver o dry-run no servidor (docs/DEPLOYMENT.md, fase F).
    expect(e?.ativa).toBe(false);
    expect(CRONTAB).toMatch(/diagnostics:dry-run/);
  });

  it("OPS-CRON-03 · expurgo de etiqueta é DIÁRIO, como a documentação canônica diz", () => {
    const e = entrada("evidence:cleanup");
    expect(e?.ativa).toBe(true);
    const [minuto, hora, ...resto] = e!.agenda.split(" ");
    expect(resto.join(" ")).toBe("* * *"); // todo dia
    expect(Number(minuto)).toBeGreaterThanOrEqual(0);
    expect(Number(hora)).toBeGreaterThanOrEqual(0);
    /*
      Longe da janela do backup: os dois mexem nos mesmos arquivos, e o backup
      PARA o web para copiar. Cruzá-los seria apagar arquivo durante a cópia —
      a trava compartilhada é a segunda linha de defesa, não a primeira.
    */
    const horaBackup = /OnCalendar=\*-\*-\* (\d{2}):/.exec(BACKUP_TIMER)?.[1];
    expect(horaBackup, "timer do backup sem OnCalendar").toBeDefined();
    expect(horaBackup).not.toBe(hora.padStart(2, "0"));
  });

  it("OPS-CRON-04 · toda entrada aponta para comando REAL, e o backup NÃO está no crontab", () => {
    expect(ENTRADAS.length).toBeGreaterThanOrEqual(3);
    for (const e of ENTRADAS) {
      const script = /alfaos-job\.sh (\S+)/.exec(e.comando)?.[1];
      expect(script, e.comando).toBeDefined();
      expect(Object.keys(PACKAGE.scripts), e.comando).toContain(script!);
    }
    /*
      O backup PARA e SOBE o serviço, o que exige root. Deixá-lo no crontab do
      usuário de serviço obrigaria a dar sudo à conta que atende a internet.
    */
    expect(CRONTAB).not.toMatch(/^[^#\n]*alfaos-backup\.sh/m);
    expect(CRONTAB).toMatch(/alfaos-backup\.timer/);
  });

  it("OPS-CRON-05 · ambiente autoritativo, e nenhum segredo em argumento", () => {
    // Nada de `VAR=valor` antes do comando, nada de senha, nada de URL de banco.
    expect(CRONTAB).not.toMatch(/DATABASE_URL|ENCRYPTION_KEY|AUTH_SECRET|password|postgres:\/\//i);
    for (const e of ENTRADAS) {
      expect(e.comando, e.comando).toMatch(/^\/opt\/alfaos\/bin\/alfaos-(job|backup)\.sh/);
    }
    /*
      O invólucro é quem carrega o arquivo de ambiente e entra no diretório.

      Esta asserção exigia `set -a; . "$ENV_FILE"; set +a` — ela pedia
      textualmente o defeito do `SEC-006`, porque `.` EXECUTA o arquivo como
      shell. Passou a exigir o parser literal compartilhado: a propriedade
      desejada sempre foi "o invólucro usa a MESMA fonte do serviço", nunca
      "por meio de `source`".
    */
    expect(WRAPPER).toMatch(/alfaos_carregar_ambiente "\$ENV_FILE"/);
    expect(WRAPPER).toMatch(/ENV_FILE="\$\{ALFAOS_ENV_FILE:-\/etc\/alfaos\/alfaos\.env\}"/);
    expect(WRAPPER).toMatch(/cd "\$APP_DIR"/);
    // PATH explícito: o cron não tem o do shell interativo.
    expect(CRONTAB).toMatch(/^PATH=\S+/m);
  });

  it("OPS-CRON-07 · nenhuma operação destrutiva é agendada", () => {
    /*
      Expurgo de etiqueta NÃO é expurgo de órfãos. O primeiro apaga linha vencida
      com prazo de 24 h e é rotina; o segundo apaga ARQUIVO do storage e exige
      escopo e decisão do dono (`docs/SECURITY.md` §8.25). Confundi-los num
      crontab é como um `--apply` vira rotina noturna sem ninguém decidir.
    */
    expect(CRONTAB).not.toMatch(/--purge-orphans|--resanitize-legacy|--apply/);
    expect(CRONTAB).not.toMatch(/storage:audit|dispatch:backfill|prisma/);
    // Sem a flag `s` (o alvo de TypeScript do projeto é anterior a ES2018).
    expect(RUNBOOK).toMatch(/expurgo de órfãos[\s\S]{0,160}manuais/i);
  });

  it("OPS-CRON-06 · exclusão do sistema operacional SÓ onde a aplicação não arbitra", () => {
    /*
      Outbox e diagnóstico se arbitram no banco (reserva com prazo, advisory
      lock na primeira verificação): um `flock` neles esconderia a arbitragem
      real. O expurgo de etiqueta durante o backup é o caso que a aplicação não
      tem como resolver — ela não sabe que existe um backup copiando arquivos.
    */
    expect(WRAPPER).toMatch(/if \[ "\$JOB" = "evidence:cleanup" \]/);
    expect(WRAPPER).toMatch(/flock -n 9/);
    expect(WRAPPER).not.toMatch(/outbox:work[\s\S]*flock/);
    expect(BACKUP).toMatch(/flock -w \d+ 9/);
  });
});

// ---------------------------------------------------------------------------
// Backup e restauração
// ---------------------------------------------------------------------------

describe("OPS-BIN — os invólucros chegam ao servidor utilizáveis", () => {
  it("OPS-BIN-01 · o runbook instala os dois scripts, executáveis, onde o cron os chama", () => {
    // A linha do runbook quebra com `\`, então o trecho atravessa a quebra.
    const instalacao = /install[\s\S]{0,240}?\/opt\/alfaos\/bin\//.exec(RUNBOOK)?.[0];
    expect(instalacao, "runbook não instala deploy/bin").toBeDefined();
    expect(instalacao).toMatch(/-m 0755/);
    for (const script of ["alfaos-job.sh", "alfaos-backup.sh"]) {
      expect(instalacao, script).toContain(script);
    }
    // Quem chama cada um: o cron chama o invólucro; o backup é unidade de root.
    expect(CRONTAB).toContain("/opt/alfaos/bin/alfaos-job.sh");
    expect(diretivas(BACKUP_UNIT, "ExecStart")[0]).toContain("/opt/alfaos/bin/alfaos-backup.sh");
  });
});

describe("OPS-BACKUP-PRIV — quem pode parar o serviço", () => {
  it("OPS-BACKUP-PRIV-01 · o backup é unidade de root com timer, e a conta da aplicação não ganha sudo", () => {
    expect(diretivas(BACKUP_UNIT, "User")).toEqual(["root"]);
    expect(diretivas(BACKUP_UNIT, "Type")).toEqual(["oneshot"]);
    expect(diretivas(BACKUP_UNIT, "EnvironmentFile")).toEqual([ENV_FILE]);
    expect(BACKUP_TIMER).toMatch(/OnCalendar=\*-\*-\* 02:00:00/);
    expect(BACKUP_TIMER).toMatch(/Unit=alfaos-backup\.service/);
    /*
      Parar e subir o serviço é de root. A alternativa seria dar sudo ao usuário
      que atende a internet — e aí a conta comprometida mexeria em unidades do
      sistema. Nenhum arquivo desta fase concede privilégio amplo.
    */
    for (const [nome, texto] of [
      ["runbook", RUNBOOK],
      ["crontab", CRONTAB],
      ["unidade", BACKUP_UNIT],
      ["script", BACKUP],
    ] as const) {
      expect(texto, nome).not.toMatch(/NOPASSWD|ALL=\(ALL\)/);
    }
    expect(RUNBOOK).toMatch(/sem sudo/i);
  });
});

/**
 * `OPS-BACKUP-MUTATORS` — mesma filosofia de `ORPHAN-REF-COLUMNS`.
 *
 * O contrato de backup depende de QUEM pode mexer no storage: o web para
 * durante a janela, `evidence:cleanup` é excluído pela trava, e os demais
 * workers não tocam arquivo. Uma superfície nova de mutação — um worker que
 * apague foto, por exemplo — tornaria esse contrato falso em silêncio. Esta
 * lista é a fronteira; ampliá-la obriga a revisar a janela e a documentá-la.
 */
const MUTADORES_CONHECIDOS = [
  "src/lib/cto.ts", // foto da CTO — WEB
  "src/lib/service-order-closing.ts", // evidência e assinatura — WEB
  "src/lib/field/evidence-cleanup.ts", // etiqueta vencida — WORKER diário
  "src/lib/storage/photo-audit.ts", // expurgo e re-sanitização — MANUAL
  "src/lib/storage/references.ts", // limpeza de blob sem linha — usado pelos acima
];

describe("OPS-BACKUP-MUTATORS — a fronteira de quem escreve no storage", () => {
  it("OPS-BACKUP-MUTATORS-01 · nenhuma superfície de mutação nova apareceu sem revisar o backup", () => {
    const arquivos: string[] = [];
    const varrer = (dir: string) => {
      for (const item of readdirSync(path.join(RAIZ, dir), { withFileTypes: true })) {
        const relativo = `${dir}/${item.name}`;
        if (item.isDirectory()) varrer(relativo);
        else if (item.name.endsWith(".ts")) arquivos.push(relativo);
      }
    };
    varrer("src/lib");
    varrer("src/app");

    /*
      Duas formas de apagar arquivo: a chamada direta no adapter e o auxiliar
      compartilhado. Sem a segunda, o `evidence:cleanup` — que é worker e apaga
      blob — ficaria de fora da lista, que é exatamente o caso que a janela de
      manutenção precisa conhecer.
    */
    const mutadores = arquivos.filter((relativo) => {
      const codigo = semComentariosTs(ler(relativo));
      return (
        /\b(storage|getFileStorage\(\))\s*\.\s*(put|delete)\s*\(/.test(codigo) ||
        /\bdiscardBlobIfUnreferenced\s*\(/.test(codigo)
      );
    });

    expect(mutadores.sort()).toEqual(MUTADORES_CONHECIDOS.sort());
  });
});

describe("OPS-NET — a superfície de rede documentada", () => {
  it("OPS-NET-01 · banco e porta da aplicação não são públicos", () => {
    // A tabela de portas do runbook é a fonte; o firewall abre só 22, 80 e 443.
    const regras = RUNBOOK.match(/ufw allow \S+/g) ?? [];
    expect(regras.length).toBeGreaterThan(0);
    for (const regra of regras) {
      expect(regra, regra).toMatch(/ufw allow (22|80|443)\/tcp/);
    }
    expect(RUNBOOK).not.toMatch(/ufw allow 5432|ufw allow 3000/);
    // E o texto diz, em palavras, que as duas ficam em loopback.
    expect(RUNBOOK).toMatch(/\|\s*3000\s*\|\s*\*\*loopback\*\*/);
    expect(RUNBOOK).toMatch(/\|\s*5432\s*\|\s*\*\*loopback\*\*/);
  });
});

describe("OPS-BACKUP — o que o backup precisa conter", () => {
  it("OPS-BACKUP-01 · inclui o banco, e a credencial não vai em argumento", () => {
    /*
      `SEC-001` mudou o mecanismo, então a asserção passou a ser sobre a
      PROPRIEDADE e não sobre o texto.
      Antes: "a string `PGPASSWORD=` não aparece no script". Isso confundia
      "senha em argumento de processo" — o risco real, porque `ps` é legível por
      qualquer usuário do host — com "senha numa variável de ambiente", que só
      o dono do processo lê em `/proc/<pid>/environ`. A regra literal barraria a
      correção e deixaria passar o que importa.
    */
    expect(BACKUP).toMatch(/pg_dump/);
    // O ALVO é explícito: era a ausência dele o achado.
    expect(BACKUP).toMatch(/pg_dump --dbname="\$ALFAOS_PG_DATABASE"/);

    // A senha nunca entra na linha de comando de nada.
    const linhasDeComando = semComentarios(BACKUP)
      .split("\n")
      .filter((l) => /pg_dump|psql|pg_restore/.test(l));
    expect(linhasDeComando.length).toBeGreaterThan(0);
    for (const linha of linhasDeComando) {
      expect(linha).not.toMatch(/--password|-W\b/);
      expect(linha).not.toMatch(/\$(\{)?PGPASSWORD/);
      expect(linha).not.toMatch(/\$(\{)?DATABASE_URL/);
    }
    // E a URL autoritativa nunca é ecoada.
    expect(semComentarios(BACKUP)).not.toMatch(/echo.*DATABASE_URL|log.*DATABASE_URL/);
  });

  /**
   * `SEC-006` — o ambiente é lido LITERALMENTE, nunca executado.
   *
   * `. "$ENV_FILE"` fazia de cada valor do arquivo de configuração código de
   * shell — e o `alfaos-backup.sh` roda como ROOT. O systemd lê o MESMO arquivo
   * literalmente, então os dois lados resolviam valores diferentes para a mesma
   * chave sempre que ela tivesse `$`, backtick, `\` ou aspas.
   */
  it("SEC-006-11 · nenhum invólucro EXECUTA o arquivo de ambiente", () => {
    for (const [nome, script] of [
      ["alfaos-job.sh", WRAPPER],
      ["alfaos-backup.sh", BACKUP],
    ] as const) {
      const corpo = semComentarios(script);
      // `. "$ENV_FILE"` e `source "$ENV_FILE"`, em qualquer forma.
      expect(corpo, nome).not.toMatch(/^\s*(\.|source)\s+["']?\$\{?ENV_FILE/m);
      expect(corpo, nome).not.toMatch(/set -a/);
      // E usa o parser compartilhado.
      expect(corpo, nome).toMatch(/alfaos_carregar_ambiente "\$ENV_FILE"/);
    }
  });

  it("SEC-006-12 · o runbook não ensina o operador a executar o ambiente", () => {
    // O runbook mandava `set -a; . /etc/alfaos/alfaos.env; set +a` no deploy —
    // um terceiro caminho com a mesma falha, desta vez sob `sudo`.
    expect(RUNBOOK).not.toMatch(/set -a\s*;\s*\.\s+\/etc\/alfaos\/alfaos\.env/);
  });

  it("SEC-006-13 · a biblioteca de ambiente chega ao servidor junto dos invólucros", () => {
    // Os dois scripts a carregam por caminho relativo ao próprio diretório: se
    // o runbook não a instalar, os dois quebram na primeira execução.
    expect(RUNBOOK).toMatch(/alfaos-env\.sh/);
    for (const script of [WRAPPER, BACKUP]) {
      expect(script).toMatch(/ENV_LIB="\$\(dirname "\$0"\)\/alfaos-env\.sh"/);
    }
  });

  it("SEC-001-13 · o alvo do dump não vem de estado herdado do ambiente", () => {
    // `unset` antes de ler o arquivo: um `PGDATABASE` no ambiente faria o libpq
    // usá-lo mesmo com o arquivo correto, e a geração sairia COMPLETE com o
    // banco errado dentro.
    expect(BACKUP).toMatch(/unset DATABASE_URL STORAGE_ROOT/);
    expect(BACKUP).toMatch(/unset PGDATABASE PGHOST PGPORT PGUSER PGPASSWORD/);
  });

  it("OPS-BACKUP-02 · inclui o storage, pela raiz de produção", () => {
    // O `tar` aponta para a RAIZ DE PRODUÇÃO, não para um caminho qualquer:
    // um backup que copia o diretório errado parece funcionar até a restauração.
    expect(BACKUP).toMatch(/tar --create[\s\S]{0,200}--directory "\$STORAGE"/);
    expect(BACKUP).toMatch(/STORAGE="\$\{STORAGE_ROOT:-\}"/);
    // Sem raiz não há backup útil: falha em vez de gerar um arquivo incompleto.
    expect(BACKUP).toMatch(/STORAGE_ROOT ausente ou inexistente/);
  });

  it("OPS-BACKUP-03 · não chama cópia local de disaster recovery", () => {
    expect(BACKUP).toMatch(/LOCAL BACKUP COMPLETE — DISASTER RECOVERY COPY NOT CONFIGURED/);
    expect(RUNBOOK).toMatch(/OWNER DECISION REQUIRED — OFF-SITE BACKUP DESTINATION/);
    // Nenhuma ferramenta remota entrou sozinha no repositório.
    expect(BACKUP).not.toMatch(/\b(rclone|restic|aws s3|borg)\b/);
  });

  it("OPS-BACKUP-04 · a restauração exige as chaves de cifra, e o backup não as carrega", () => {
    /*
      A exigência precisa estar no RUNBOOK DE RESTAURAÇÃO, não em qualquer lugar
      do documento: quem restaura segue os passos daquela seção, e sem as chaves
      o banco restaurado tem credenciais de ERP e senhas PPPoE ilegíveis — o que
      só aparece quando alguém tenta usá-las.
    */
    const restauracao = /## 10\. Restauração[\s\S]*?\n## 11\./.exec(RUNBOOK)?.[0];
    expect(restauracao, "seção de restauração não encontrada").toBeDefined();
    expect(restauracao).toMatch(/ERP_CREDENTIAL_ENCRYPTION_KEY/);
    expect(restauracao).toMatch(/CUSTOMER_CREDENTIAL_ENCRYPTION_KEY/);
    expect(BACKUP).not.toMatch(/ENCRYPTION_KEY/);
  });

  it("OPS-BACKUP-05 · banco primeiro, storage depois, com o web parado — e o runbook explica por quê", () => {
    const sequencia = /^travar \|\|[\s\S]*$/m.exec(BACKUP)?.[0] ?? "";
    const ordem = ["parar_web", "dump_banco", "arquivar_storage", "restaurar_web", "copia_externa"];
    let anterior = -1;
    for (const passo of ordem) {
      const posicao = sequencia.indexOf(passo);
      expect(posicao, passo).toBeGreaterThan(anterior);
      anterior = posicao;
    }
    /*
      Duas afirmações erradas ficam proibidas pelo texto, e as duas custam caro.
      A primeira — "com o web no ar isso só produz órfão" — escondia a perda de
      foto. A segunda seria prometer que o backup congela o PostgreSQL: ele não
      congela, e quem restaurar acreditando nisso vai procurar escrita que a
      janela nunca reteve. O que a janela garante é escopo de REFERÊNCIA.
    */
    expect(RUNBOOK).toMatch(/removeEvidence/);
    expect(RUNBOOK).toMatch(/consistente em REFERÊNCIAS DE STORAGE/i);
    expect(RUNBOOK).toMatch(/PostgreSQL \*\*não\*\* é\s*\n?congelado/i);
    // E diz, em palavras, quem continua rodando durante a janela.
    expect(RUNBOOK).toMatch(/diagnóstico e o outbox[\s\S]{0,80}continuam rodando/i);
  });
});
