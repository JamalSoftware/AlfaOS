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
 * Chame por cron, no intervalo do alvo:
 *
 * ```text
 * *\/5 * * * *  cd /app && npm run diagnostics:refresh
 * ```
 *
 * Um intervalo MENOR que cinco minutos também é seguro e costuma ser melhor:
 * quem já foi verificado não é elegível, então uma volta de um minuto apenas
 * distribui o mesmo trabalho em pedaços mais finos, com menos rajada contra o
 * ERP.
 *
 * # Duas execuções sobrepostas
 *
 * São seguras. A elegibilidade é "a última verificação venceu", e toda
 * verificação bem-sucedida reescreve `observedAt` — quem chega depois encontra
 * o cliente fora da faixa. A janela residual é fechada no banco pela escrita
 * monotônica: observação mais velha não sobrescreve a mais nova.
 *
 * # Não é o caminho crítico
 *
 * Se este comando não rodar, nada fica errado: o último estado conhecido
 * continua na tela, com a idade dele à vista, e o selo "Verificação atrasada"
 * aparece quando a confirmação passa do dobro do alvo. O sistema envelhece em
 * público, em vez de afirmar um estado que ninguém confirmou.
 *
 * # Saída
 *
 * Contagens, e nada mais. Sem nome de cliente, sem documento, sem credencial,
 * sem payload do provider — log de worker acaba em arquivo, em agregador e em
 * ticket de suporte.
 */

import {
  findConnectionsDueForCheck,
  runConnectivityRefreshCycle,
  CONNECTIVITY_REFRESH_BATCH_LIMIT,
  CONNECTIVITY_REFRESH_CONCURRENCY,
  CONNECTIVITY_REFRESH_TARGET_MS,
} from "../src/lib/connectivity-monitor";
import { prisma } from "../src/lib/prisma";
import { logServerError } from "../src/lib/safe-log";

function numeroDoAmbiente(nome: string, padrao: number): number {
  const cru = process.env[nome];
  if (cru === undefined || cru === "") return padrao;
  const valor = Number(cru);
  /*
    Configuração inválida DERRUBA a subida, em vez de virar `NaN` e desligar o
    teto em silêncio — a mesma regra que a `RC-1B` aplicou às variáveis de
    login.
  */
  if (!Number.isFinite(valor) || valor <= 0) {
    throw new Error(`${nome} inválido: esperado número positivo, recebido "${cru}"`);
  }
  return valor;
}

async function main(): Promise<void> {
  const targetMs = numeroDoAmbiente(
    "DIAGNOSTICS_REFRESH_TARGET_MS",
    CONNECTIVITY_REFRESH_TARGET_MS,
  );
  const limit = numeroDoAmbiente(
    "DIAGNOSTICS_REFRESH_BATCH_LIMIT",
    CONNECTIVITY_REFRESH_BATCH_LIMIT,
  );
  const concurrency = numeroDoAmbiente(
    "DIAGNOSTICS_REFRESH_CONCURRENCY",
    CONNECTIVITY_REFRESH_CONCURRENCY,
  );

  /*
    `--dry-run`: diz QUANTOS seriam consultados, e não consulta ninguém.

    Existe por segurança operacional. O ciclo fala com o ERP real da empresa, e
    a primeira execução num ambiente novo é justamente aquela em que ninguém
    sabe quantas chamadas vão sair — nem se o provider ali é um sandbox ou a
    instalação de produção de um provedor de verdade. Uma prévia transforma esse
    primeiro disparo numa decisão informada.

    Ele NÃO reserva, NÃO escreve e NÃO chama provider: roda só a seleção.
  */
  if (process.argv.includes("--dry-run")) {
    const { scanned, due } = await findConnectionsDueForCheck(
      new Date(),
      targetMs,
      limit,
    );
    console.info(
      `[diagnostics] SIMULACAO — nada foi consultado nem escrito: ` +
        `vinculos=${scanned} elegiveis=${due.length} ` +
        `alvo=${Math.round(targetMs / 1000)}s teto=${limit}`,
    );
    return;
  }

  console.info(
    `[diagnostics] ciclo iniciado alvo=${Math.round(targetMs / 1000)}s teto=${limit} concorrencia=${concurrency}`,
  );

  const r = await runConnectivityRefreshCycle({ targetMs, limit, concurrency });

  console.info(
    `[diagnostics] vinculos=${r.connectionsScanned} elegiveis=${r.eligible} ` +
      `processados=${r.processed} online=${r.online} offline=${r.offline} ` +
      `semLeitura=${r.unknown} falhasProvider=${r.providerFailures} ` +
      `empresasSemDiagnostico=${r.skippedCompanies} ms=${r.durationMs}`,
  );

  /*
    Sobrou trabalho para a volta seguinte: não é erro, é o teto funcionando.
    Fica dito para o operador saber que a cadência efetiva daquele momento foi
    maior que o alvo — e decidir se aumenta o teto ou a frequência do cron.
  */
  if (r.eligible >= limit) {
    console.warn(
      `[diagnostics] teto atingido: havia ao menos ${limit} vencidos. ` +
        `A cadencia efetiva ficou acima do alvo nesta volta.`,
    );
  }
}

main()
  .catch((error) => {
    logServerError("diagnostics", error, { operacao: "ciclo" });
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
