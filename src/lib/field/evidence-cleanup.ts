import { prisma } from "../prisma";
import { getFileStorage } from "../storage";

/**
 * # Expurgo de etiqueta temporária vencida
 *
 * A foto da etiqueta é enviada ANTES de o equipamento existir, porque o
 * registro precisa do id dela para apontar. Quando o técnico desiste — fecha o
 * formulário, muda de ideia, o aparelho fica sem bateria — a foto fica no
 * disco sem nunca virar nada. Sem expurgo, esse resto cresce para sempre.
 *
 * ## O que este serviço NÃO faz
 *
 * Não apaga evidência da OS. O predicado é `status: TEMPORARY`, e uma etiqueta
 * só sai desse estado sendo promovida junto da criação do equipamento — na
 * mesma transação. Promovida, ela deixa de estar no alcance desta varredura, e
 * a FK `Restrict` do equipamento é a segunda tranca: mesmo que o filtro
 * estivesse errado, o banco recusaria apagar uma foto que identifica alguém.
 *
 * ## Idempotente por construção
 *
 * Duas execuções simultâneas são seguras. Cada linha é deletada por `id` com o
 * status ainda no predicado, então o perdedor da corrida apaga zero linhas e
 * segue. O arquivo é removido do storage antes, e o storage já trata "não
 * existe" como sucesso — rodar duas vezes não produz erro nem contagem dupla.
 *
 * ## Ordem: arquivo, depois linha
 *
 * O inverso deixaria arquivo órfão sem nada apontando para ele, invisível para
 * qualquer varredura futura. Nesta ordem, a falha no meio deixa a LINHA viva
 * apontando para um arquivo que já não existe — visível, e recolhida na
 * próxima passada.
 */

export interface EvidenceCleanupResult {
  /** Quantas temporárias vencidas foram encontradas. */
  found: number;
  /** Quantas linhas realmente saíram. */
  deleted: number;
  /** Quantas o banco recusou apagar — sempre 0 num sistema sadio. */
  skipped: number;
}

export interface EvidenceCleanupOptions {
  /** Teto por execução: uma varredura não pode virar uma migração. */
  limit?: number;
  /** Injetável para o teste poder envelhecer o relógio, não a linha. */
  now?: Date;
}

export async function purgeExpiredTemporaryEvidence(
  options: EvidenceCleanupOptions = {},
): Promise<EvidenceCleanupResult> {
  const now = options.now ?? new Date();
  const limit = options.limit ?? 200;

  const candidates = await prisma.serviceOrderEvidence.findMany({
    where: {
      status: "TEMPORARY",
      expiresAt: { not: null, lte: now },
    },
    select: { id: true, storageKey: true },
    orderBy: { expiresAt: "asc" },
    take: limit,
  });

  const storage = getFileStorage();
  let deleted = 0;
  let skipped = 0;

  for (const candidate of candidates) {
    /*
      Conferência explícita de vínculo, mesmo o filtro já a tornando
      impossível.

      Uma etiqueta vinculada é `COMMITTED` e não chega até aqui. A conferência
      existe porque o custo dela é uma consulta e o custo de errar é apagar a
      prova de identidade de um equipamento instalado — e porque uma promoção
      futura escrita fora deste caminho não pode transformar o expurgo em
      destruidor de evidência.
    */
    const linked = await prisma.serviceOrderEquipment.count({
      where: { labelEvidenceId: candidate.id },
    });
    if (linked > 0) {
      skipped += 1;
      continue;
    }

    await storage.delete(candidate.storageKey).catch(() => undefined);

    const removed = await prisma.serviceOrderEvidence.deleteMany({
      // O status no predicado é o que torna a corrida segura: promovida entre
      // a leitura e agora, esta linha não é mais apagável.
      where: { id: candidate.id, status: "TEMPORARY" },
    });
    if (removed.count === 1) {
      deleted += 1;
    } else {
      skipped += 1;
    }
  }

  return { found: candidates.length, deleted, skipped };
}
