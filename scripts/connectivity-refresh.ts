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
 */

import {
  findConnectionsDueForCheck,
  readConnectivityRunSettings,
  runConnectivityRefreshCycle,
} from "../src/lib/connectivity-monitor";
import { resolveConnectivityPolicy } from "../src/lib/connectivity-policy";
import { prisma } from "../src/lib/prisma";
import { logServerError } from "../src/lib/safe-log";

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
  try {
    ({ refreshTargetMs: targetMs, staleAfterMs } = resolveConnectivityPolicy());
    ({ limit, concurrency } = readConnectivityRunSettings());
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
    );
    console.info(
      `[diagnostics] SIMULACAO — nada foi consultado nem escrito: ` +
        `vinculos=${scanned} elegiveis=${due.length} ` +
        `alvo=${Math.round(targetMs / 1000)}s teto=${limit}`,
    );
    return;
  }

  console.info(
    `[diagnostics] ciclo iniciado alvo=${Math.round(targetMs / 1000)}s ` +
      `atrasoApos=${Math.round(staleAfterMs / 1000)}s teto=${limit} concorrencia=${concurrency}`,
  );

  const r = await runConnectivityRefreshCycle({ targetMs, limit, concurrency });

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
  if (r.processed >= limit) {
    console.warn(
      `[diagnostics] teto atingido: ${limit} verificacoes nesta volta. ` +
        `A cadencia efetiva pode ficar acima do alvo.`,
    );
  }
}

main()
  .catch((error) => {
    logServerError("diagnostics", error, { operacao: "ciclo" });
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
