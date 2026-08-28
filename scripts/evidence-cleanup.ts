/**
 * Expurgo de etiquetas temporárias vencidas — roda e sai.
 *
 * # Por que um comando, e não um daemon
 *
 * Mesma razão do worker do outbox: o AlfaOS roda em instância única, sem
 * scheduler ativo nesta fase. Um processo permanente exigiria supervisor, ou
 * viveria dentro do Next.js — onde morre a cada deploy e duplica quando a
 * hospedagem escala. Este script varre um lote e termina. Chame por cron:
 *
 * ```text
 * 15 3 * * *  cd /app && npm run evidence:cleanup
 * ```
 *
 * Uma vez por dia basta: o prazo da etiqueta é de 24 horas, e nada quebra se a
 * varredura atrasar. Duas execuções sobrepostas são seguras — a exclusão é um
 * `deleteMany` com o status no predicado, e o banco arbitra.
 *
 * # Não é o caminho crítico
 *
 * Se este comando não rodar por um mês, nenhuma OS fica errada e nenhum
 * equipamento perde identificação: a foto vencida já não conta em lugar nenhum
 * desde o instante em que venceu. O que cresce é disco.
 *
 * # Saída
 *
 * Contagens, e nada mais. Sem PII, sem nome de arquivo, sem chave de storage —
 * o log de um comando operacional não é lugar de dado de cliente.
 */
import { prisma } from "../src/lib/prisma";
import { purgeExpiredTemporaryEvidence } from "../src/lib/field/evidence-cleanup";

async function main(): Promise<void> {
  const result = await purgeExpiredTemporaryEvidence();

  console.log(
    `[evidence-cleanup] vencidas=${result.found} apagadas=${result.deleted} mantidas=${result.skipped}`,
  );

  /*
    `skipped` acima de zero merece atenção.

    Num sistema sadio ele é sempre zero: uma temporária vencida não tem vínculo,
    e nada mais compete por essas linhas. Diferente de zero significa que uma
    etiqueta foi promovida durante a varredura — normal e inofensivo — ou que
    alguma escrita fora do caminho da promoção criou vínculo sem trocar o
    status, que é um defeito de verdade.
  */
  if (result.skipped > 0) {
    console.warn(
      `[evidence-cleanup] ${result.skipped} linha(s) mantidas por vínculo; confira se houve promoção fora da transação`,
    );
  }
}

main()
  .catch((error: unknown) => {
    console.error(
      "[evidence-cleanup] falha na execução:",
      error instanceof Error ? error.message : "erro desconhecido",
    );
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
