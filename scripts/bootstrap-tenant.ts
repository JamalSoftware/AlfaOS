/**
 * Inicialização da instalação — roda uma vez e sai (`APP-001`).
 *
 * ```text
 * npx prisma migrate deploy
 * npm run build            # compila este script para dist/
 * npm run tenant:bootstrap -- --company "Alfa Telecom" \
 *     --admin-name "Maria Silva" --admin-email maria@alfatelecom.com.br \
 *     --timezone America/Sao_Paulo
 * ```
 *
 * A senha é pedida no terminal, com eco mascarado, e confirmada. Ela **não**
 * entra em `argv` — `--password` é recusado de propósito: argumento de linha de
 * comando aparece em `ps`, no histórico do shell e em qualquer log de auditoria
 * do sistema operacional.
 *
 * `--dry-run` confere tudo — validação, fuso e se a instalação está vazia — e
 * não escreve nada.
 *
 * # O que este comando NÃO é
 *
 * Não é o seed de desenvolvimento (que continua recusando em produção,
 * `RC-OPS-04`) e não é cadastro de empresas: ele só funciona com a base vazia.
 * Depois dele, contas se criam em `/usuarios`, que já é auditado.
 */
import { Writable } from "node:stream";
import * as readline from "node:readline";
import {
  BOOTSTRAP_PASSWORD_MAX,
  BOOTSTRAP_PASSWORD_MIN,
  bootstrapTenant,
  type BootstrapTenantInput,
} from "../src/lib/bootstrap";
import { badRequest, DomainError } from "../src/lib/errors";
import { prisma } from "../src/lib/prisma";
import { logServerError } from "../src/lib/safe-log";

const ENV_PASSWORD = "ALFAOS_BOOTSTRAP_PASSWORD";

/** Flags que carregariam a senha em `argv`. Recusadas, nunca lidas. */
const FLAGS_DE_SENHA = ["--password", "--senha", "--admin-password"];

const USO = `Uso:
  npm run tenant:bootstrap -- --company "<nome>" --admin-name "<nome>" \\
      --admin-email <email> [--document <cnpj>] [--timezone <IANA>] \\
      [--cto-network] [--dry-run]

A senha é pedida no terminal (eco mascarado) e confirmada.
Sem terminal interativo, defina ${ENV_PASSWORD} e remova-a do ambiente em
seguida (\`unset ${ENV_PASSWORD}\`). A senha nunca é aceita em argv.`;

/**
 * Lê `--flag valor` ou `--flag=valor`.
 *
 * Nunca devolve a flag seguinte como valor: `--company --dry-run` é ausência de
 * valor, não uma empresa chamada `--dry-run`.
 */
function valorDaFlag(argv: readonly string[], flag: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag) {
      const proximo = argv[i + 1];
      return proximo === undefined || proximo.startsWith("--") ? "" : proximo;
    }
    if (argv[i].startsWith(`${flag}=`)) {
      return argv[i].slice(flag.length + 1);
    }
  }
  return undefined;
}

/**
 * Pergunta no terminal. Com `mascarado`, o que é digitado não é ecoado.
 *
 * Sem dependência nova: a saída do `readline` é um `Writable` que descarta o
 * eco. O prompt é escrito direto no `stdout`, antes de o descarte começar.
 */
function perguntar(rotulo: string, mascarado: boolean): Promise<string> {
  process.stdout.write(rotulo);
  const saida = new Writable({
    write(chunk, encoding, callback) {
      if (!mascarado) {
        process.stdout.write(chunk as Buffer, encoding);
      }
      callback();
    },
  });
  const rl = readline.createInterface({
    input: process.stdin,
    output: saida,
    terminal: true,
  });
  return new Promise<string>((resolve) => {
    rl.question("", (resposta) => {
      rl.close();
      process.stdout.write("\n");
      resolve(resposta);
    });
  });
}

/**
 * De onde a senha vem, em ordem: terminal interativo, senão a variável.
 *
 * A variável existe para instalação automatizada e é apagada do processo
 * depois de lida — o que não substitui removê-la do shell, e o runbook diz
 * isso. Ela nunca é impressa, nem em erro.
 */
async function obterSenha(): Promise<string> {
  const doAmbiente = process.env[ENV_PASSWORD];
  if (process.stdin.isTTY) {
    const senha = await perguntar("Senha do ADMIN: ", true);
    const confirmacao = await perguntar("Repita a senha: ", true);
    if (senha !== confirmacao) {
      throw badRequest("As senhas não conferem.");
    }
    return senha;
  }
  if (doAmbiente !== undefined && doAmbiente.length > 0) {
    delete process.env[ENV_PASSWORD];
    return doAmbiente;
  }
  throw badRequest(
    `Sem terminal interativo: defina ${ENV_PASSWORD} (e remova-a do ambiente ` +
      `depois). A senha não é aceita em argv.`,
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.includes("--help") || argv.includes("-h")) {
    console.info(USO);
    return;
  }

  // Antes de qualquer leitura: uma senha em argv já vazou para `ps` e para o
  // histórico do shell. O valor não é lido, não é usado e não é impresso.
  const flagDeSenha = FLAGS_DE_SENHA.find((flag) =>
    argv.some((arg) => arg === flag || arg.startsWith(`${flag}=`)),
  );
  if (flagDeSenha) {
    console.error(
      `[bootstrap] RECUSADO: ${flagDeSenha} não é aceito — a senha em argv ` +
        `aparece em \`ps\` e no histórico do shell. Rode sem essa flag e ` +
        `responda ao prompt, ou use ${ENV_PASSWORD}.`,
    );
    process.exitCode = 2;
    return;
  }

  const dryRun = argv.includes("--dry-run");
  const entrada: BootstrapTenantInput = {
    companyName: valorDaFlag(argv, "--company") ?? "",
    document: valorDaFlag(argv, "--document") ?? null,
    adminName: valorDaFlag(argv, "--admin-name") ?? "",
    adminEmail: valorDaFlag(argv, "--admin-email") ?? "",
    timezone: valorDaFlag(argv, "--timezone") ?? null,
    ctoNetworkEnabled: argv.includes("--cto-network"),
  };

  if (!dryRun) {
    entrada.password = await obterSenha();
  }

  const r = await bootstrapTenant(entrada, { dryRun });

  if (r.dryRun) {
    console.info(
      `[bootstrap] SIMULADO — nada foi escrito: empresa="${r.companyName}" ` +
        `documento=${r.document ?? "-"} admin="${r.adminName}" <${r.adminEmail}> ` +
        `fuso=${r.timezone} ctoNetwork=${r.ctoNetworkEnabled}`,
    );
    console.info(
      "[bootstrap] A senha será pedida na execução real, com eco mascarado.",
    );
    return;
  }

  console.info(
    `[bootstrap] APLICADO: empresa=${r.companyId} admin=${r.userId} ` +
      `email=${r.adminEmail} fuso=${r.timezone} ctoNetwork=${r.ctoNetworkEnabled}`,
  );
  console.info(
    "[bootstrap] Entre pela tela de login com esse e-mail e a senha digitada. " +
      "Próximas contas: /usuarios.",
  );
}

main()
  .catch((error: unknown) => {
    if (error instanceof DomainError) {
      // Mensagem de domínio é texto de operação — nomeia o campo recusado e
      // nunca carrega a senha, que o domínio não devolve em erro nenhum.
      console.error(`[bootstrap] RECUSADO: ${error.message}`);
      process.exitCode = 2;
      return;
    }
    logServerError("bootstrap", error, { operacao: "execucao" });
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
