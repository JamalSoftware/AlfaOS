/**
 * Backfill da fila operacional de OS — roda e sai.
 *
 * # Por que um comando, e não uma migration
 *
 * A migration da DQ-1 é aditiva e não escreve linha de domínio nenhuma. Este
 * passo escreve: ele decide a ORDEM inicial da fila de cada técnico, e essa é
 * regra de negócio. Dentro de uma migration ela não teria teste, não poderia
 * ser reexecutada e não sairia num relatório.
 *
 * ```text
 * npm run build && npm run dispatch:backfill
 * ```
 *
 * # Idempotente
 *
 * Rodar duas vezes não duplica entrada, não reposiciona nada arbitrariamente e
 * não move `version` sem mudança real. Rodar de novo depois de novas OS serem
 * atribuídas completa o que falta, sem refazer o resto.
 *
 * # Saída
 *
 * Contagens, e nada mais. Sem PII, sem número de OS, sem nome de técnico — o
 * log de um comando operacional não é lugar de dado de cliente.
 */
import { prisma } from "../src/lib/prisma";
import { backfillDispatchQueues } from "../src/lib/dispatch-queue-backfill";

async function main(): Promise<void> {
  const companyId = process.argv[2];
  const result = await backfillDispatchQueues(companyId);

  console.log(
    `[dispatch-backfill] os=${result.ordersScanned} filas_criadas=${result.queuesCreated} filas_alteradas=${result.queuesChanged} entradas_criadas=${result.entriesCreated} entradas_removidas=${result.entriesRemoved}`,
  );
}

main()
  .catch((error: unknown) => {
    console.error(
      "[dispatch-backfill] falha na execução:",
      error instanceof Error ? error.message : "erro desconhecido",
    );
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
