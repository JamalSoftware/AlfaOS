/**
 * `DIAG-AUTO-1` — reconfere a conectividade dos clientes ligados, e sai.
 *
 * # Por que um comando, e não um daemon
 *
 * Pelos mesmos motivos já escritos em `scripts/outbox-worker.ts`: o AlfaOS roda
 * em instância única, sem Redis, sem supervisor de processos e sem agendador
 * dentro do repositório. Um worker permanente morreria no deploy, não
 * reiniciaria sozinho e duplicaria quando a hospedagem escalasse.
 *
 * # Cadência — contrato PLANEJADO (`RC-1F-A`), nenhum agendador ativo
 *
 * ```text
 * tick do agendador   1 min      * * * * *  cd <raiz-do-deploy> && npm run diagnostics:refresh
 * alvo de frescor     5 min      DIAGNOSTICS_REFRESH_TARGET_MS
 * aviso na tela      10 min      DIAGNOSTICS_STALE_AFTER_MS
 * ```
 *
 * O tick é mais curto que o alvo de propósito. Com tick igual ao alvo, quem foi
 * verificado segundos depois de um disparo ainda não venceu no disparo seguinte,
 * e a revisita real ficava em ~10 min (`DIAG-CADENCE-01`). Tick de 1 minuto NÃO
 * é consultar cada cliente a cada minuto: quem está dentro do alvo não é
 * elegível, e a revisita fica entre 5 e 6 min.
 *
 * # Duas execuções sobrepostas
 *
 * Com tick de 1 minuto, uma volta longa se sobrepõe à seguinte. As duas leem a
 * lista no começo e a lista envelhece, então nenhuma confia nela: cada cliente é
 * RESERVADO antes da chamada, e com a reserva na mão o banco é consultado de
 * novo — quem outro ciclo verificou nesse meio-tempo é descartado sem chamar o
 * provider (`DIAG-OVERLAP-01`). A primeira verificação da vida do cliente é
 * arbitrada por advisory lock, e a escrita é monotônica.
 *
 * # Não é o caminho crítico
 *
 * Se este comando não rodar, nada fica errado: o último estado conhecido
 * continua na tela, com a idade dele à vista, e o aviso "Leitura desatualizada"
 * aparece quando a confirmação passa do limiar. O sistema envelhece em público,
 * em vez de afirmar um estado que ninguém confirmou.
 *
 * # Saída
 *
 * Contagens, e nada mais. Sem nome de cliente, sem documento, sem credencial,
 * sem payload do provider — log de worker acaba em arquivo, em agregador e em
 * ticket de suporte.
 *
 * ```text
 * 0   a volta rodou (falha de provider é contagem, não erro do comando)
 * 1   a volta quebrou
 * 2   configuração inválida — nada foi consultado
 * ```
 *
 * # Um cliente só: `--customer-id <id>`
 *
 * Validação operacional de UM cliente (id interno do AlfaOS), sem varrer a
 * carteira. É a MESMA volta com a seleção estreitada: o cliente ainda precisa
 * de vínculo ativo e de verificação vencida, passa pela mesma reserva, pelo
 * mesmo prazo e pela mesma escrita. Se ele não for elegível, nada é consultado
 * e o motivo é impresso — nunca outro cliente no lugar. Não é `teto=1`: o teto
 * limita quantos, não QUEM.
 */

import {
  findConnectionsDueForCheck,
  readConnectivityRunSettings,
  runConnectivityRefreshCycle,
} from "../src/lib/connectivity-monitor";
import { resolveConnectivityPolicy } from "../src/lib/connectivity-policy";
import { prisma } from "../src/lib/prisma";
import { logServerError } from "../src/lib/safe-log";

const FLAG_CLIENTE = "--customer-id";

/**
 * Lê `--customer-id <id>` ou `--customer-id=<id>`. Ausente: `undefined`.
 *
 * Presente e malformado derruba com saída 2, como qualquer configuração: um id
 * vazio ou engolindo a flag seguinte (`--customer-id --dry-run`) não pode virar
 * "sem filtro" e sair consultando a carteira inteira. O valor recebido não é
 * ecoado — veio da linha de comando, não se sabe o que tem.
 */
function lerClienteAlvo(argv: readonly string[]): string | undefined {
  const posicoes = argv
    .map((arg, i) => (arg === FLAG_CLIENTE || arg.startsWith(`${FLAG_CLIENTE}=`) ? i : -1))
    .filter((i) => i >= 0);
  if (posicoes.length === 0) return undefined;
  if (posicoes.length > 1) {
    throw new Error(`${FLAG_CLIENTE} informado mais de uma vez`);
  }
  const arg = argv[posicoes[0]];
  const valor = arg === FLAG_CLIENTE ? argv[posicoes[0] + 1] : arg.slice(FLAG_CLIENTE.length + 1);
  if (valor === undefined || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(valor)) {
    throw new Error(`${FLAG_CLIENTE} inválido: informe o id interno do cliente`);
  }
  return valor;
}

async function main(): Promise<void> {
  /*
    Configuração PRIMEIRO, e o motivo impresso.

    O alvo vem da POLÍTICA, não de uma leitura própria do ambiente: é a mesma
    grandeza que decide o aviso na tela, e duas leituras independentes da mesma
    variável foi exatamente o que produziu a divergência anterior.

    O `catch` do fim registra só o tipo do erro (RC-LOG-01), então um valor
    inválido sairia como "erro=Error" sem dizer qual variável. Configuração não é
    segredo: a mensagem vai inteira, e a saída 2 separa "configurado errado" de
    "falhou rodando".
  */
  let targetMs: number;
  let staleAfterMs: number;
  let limit: number;
  let concurrency: number;
  let customerId: string | undefined;
  try {
    ({ refreshTargetMs: targetMs, staleAfterMs } = resolveConnectivityPolicy());
    ({ limit, concurrency } = readConnectivityRunSettings());
    customerId = lerClienteAlvo(process.argv.slice(2));
  } catch (error) {
    console.error(
      `[diagnostics] configuracao invalida: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 2;
    return;
  }

  /*
    `--dry-run`: diz QUANTOS seriam consultados, e não consulta ninguém.

    Existe por segurança operacional. O ciclo fala com o ERP real da empresa, e
    a primeira execução num ambiente novo é justamente aquela em que ninguém
    sabe quantas chamadas vão sair — nem se o provider ali é um sandbox ou a
    instalação de produção de um provedor de verdade. Uma prévia transforma esse
    primeiro disparo numa decisão informada.

    Ele NÃO reserva, NÃO escreve e NÃO chama provider: roda só a seleção. O teto
    conta tentativas que chegam ao provider, então a prévia mostra os elegíveis
    e o teto separados.
  */
  if (process.argv.includes("--dry-run")) {
    const { scanned, due } = await findConnectionsDueForCheck(
      new Date(),
      targetMs,
      Number.POSITIVE_INFINITY,
      limit,
      customerId,
    );
    console.info(
      `[diagnostics] SIMULACAO — nada foi consultado nem escrito: ` +
        `vinculos=${scanned} elegiveis=${due.length} ` +
        `alvo=${Math.round(targetMs / 1000)}s teto=${limit}${escopo(customerId)}`,
    );
    return;
  }

  console.info(
    `[diagnostics] ciclo iniciado alvo=${Math.round(targetMs / 1000)}s ` +
      `atrasoApos=${Math.round(staleAfterMs / 1000)}s teto=${limit} concorrencia=${concurrency}` +
      escopo(customerId),
  );

  const r = await runConnectivityRefreshCycle({ targetMs, limit, concurrency, customerId });

  console.info(
    `[diagnostics] vinculos=${r.connectionsScanned} elegiveis=${r.eligible} ` +
      `processados=${r.processed} online=${r.online} offline=${r.offline} ` +
      `semLeitura=${r.unknown} falhasProvider=${r.providerFailures} ` +
      `empresasSemDiagnostico=${r.skippedCompanies} reservadosPorOutro=${r.claimedByOther} ` +
      `recemVerificados=${r.skippedFresh} ms=${r.durationMs}`,
  );

  /*
    Sobrou trabalho para a volta seguinte: não é erro, é o teto funcionando.
    Fica dito para o operador saber que a cadência efetiva daquele momento foi
    maior que o alvo — e decidir se aumenta o teto.
  */
  /*
    No modo de um cliente, "nada aconteceu" precisa dizer POR QUÊ — é a
    diferença entre "ele está fresco" e "o id está errado".
  */
  if (customerId !== undefined && r.processed === 0) {
    console.warn(`[diagnostics] cliente-unico nao consultado: ${motivoSemConsulta(r)}`);
  }

  if (r.processed >= limit) {
    console.warn(
      `[diagnostics] teto atingido: ${limit} verificacoes nesta volta. ` +
        `A cadencia efetiva pode ficar acima do alvo.`,
    );
  }
}

function escopo(customerId: string | undefined): string {
  return customerId === undefined ? "" : " escopo=cliente-unico";
}

function motivoSemConsulta(r: Awaited<ReturnType<typeof runConnectivityRefreshCycle>>): string {
  if (r.connectionsScanned === 0) return "sem vinculo ativo (ou id inexistente)";
  if (r.eligible === 0) return "verificado dentro do alvo";
  if (r.claimedByOther > 0) return "reservado por outra execucao";
  if (r.skippedFresh > 0) return "verificado por outra execucao durante a volta";
  if (r.skippedCompanies > 0) return "o ERP da empresa nao oferece diagnostico";
  return "nenhuma tentativa chegou ao provider";
}

main()
  .catch((error) => {
    logServerError("diagnostics", error, { operacao: "ciclo" });
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
