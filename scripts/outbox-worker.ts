/**
 * Worker do outbox — processa a fila e sai.
 *
 * # Por que um comando, e não um daemon
 *
 * O AlfaOS roda hoje em instância única, sem Redis, sem Kubernetes e sem
 * supervisor de processos. Um worker permanente exigiria justamente isso — ou
 * viveria dentro do processo do Next.js, onde ele morre a cada deploy, não
 * reinicia sozinho e duplica quando a hospedagem escala.
 *
 * Este script roda até esvaziar o lote e termina. Chame por cron:
 *
 * ```text
 * * * * * *  cd /app && npm run outbox:work
 * ```
 *
 * Duas execuções que se sobreponham são seguras: a reivindicação é um
 * `updateMany` com predicado de status, então o banco arbitra e o perdedor
 * simplesmente não pega nada. É o que torna o cron de um minuto viável sem
 * lockfile.
 *
 * # Não é o caminho crítico
 *
 * Se este worker não rodar por um dia, nenhuma OS fica errada: a atribuição já
 * está gravada, a `Notification` já existe e o técnico a vê ao abrir o
 * aplicativo. O que atrasa é só o aviso — push nunca foi fonte de verdade.
 *
 * # Saída
 *
 * Contagens, e nada mais. Sem PII, sem segredo, sem payload — o log de um
 * worker acaba em arquivo, em agregador e em ticket de suporte.
 */

import { processOutboxBatch } from "../src/lib/outbox";
import { handleOutboxEvent } from "../src/lib/outbox-handlers";
import { prisma } from "../src/lib/prisma";

/** Teto por execução: mantém o comando curto e previsível para o cron. */
const BATCH_LIMIT = Number(process.env.OUTBOX_BATCH_LIMIT ?? 50);

async function main(): Promise<void> {
  const started = Date.now();
  const result = await processOutboxBatch(handleOutboxEvent, BATCH_LIMIT);
  const ms = Date.now() - started;

  console.info(
    `[outbox] reivindicados=${result.claimed} processados=${result.processed} ` +
      `adiados=${result.failed} esgotados=${result.exhausted} ms=${ms}`,
  );

  /*
    Esgotado é a única saída diferente de zero.

    Adiamento é operação normal — o provider caiu, a fila tenta de novo. Já um
    evento que gastou todas as tentativas precisa acordar alguém: ele não vai
    ser reprocessado sozinho, e falha definitiva que ninguém vê é pior que job
    que nunca rodou (PRD §157).
  */
  if (result.exhausted > 0) {
    console.error(
      `[outbox] ${result.exhausted} evento(s) esgotaram as tentativas e estão FAILED`,
    );
    process.exitCode = 1;
  }
}

main()
  .catch((error: unknown) => {
    console.error(
      "[outbox] falha na execução:",
      error instanceof Error ? error.message : "erro desconhecido",
    );
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
