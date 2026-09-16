import { prisma } from "../prisma";
import { getFileStorage } from "../storage";
import type { FileStorageContract } from "../storage/contract";
import { discardBlobIfUnreferenced } from "../storage/references";

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
 * status e o vencimento ainda no predicado, então o perdedor da corrida apaga
 * zero linhas e segue — e não toca no arquivo.
 *
 * ## Ordem: LINHA, depois arquivo (`RC-1E`, `RC-STO-06`)
 *
 * A ordem antiga era a inversa, e tinha uma corrida que perdia foto de
 * identificação. A varredura lia a etiqueta vencida; nesse intervalo, o
 * registro do equipamento — que decide o vencimento com o relógio lido ANTES da
 * própria transação — promovia a mesma etiqueta a `COMMITTED`; a varredura
 * apagava o ARQUIVO, e só então tentava a linha, que já não era temporária. A
 * linha sobrevivia, ligada ao equipamento, apontando para um arquivo que não
 * existia mais.
 *
 * Agora quem arbitra é o banco: o `DELETE` com `status: TEMPORARY` no
 * predicado espera o lock da promoção e reavalia a linha depois dela. Se a
 * promoção venceu, a contagem é zero e o arquivo não é tocado. Se a varredura
 * venceu, a linha já não existe e a promoção falha — sem vínculo a um arquivo
 * que vai sumir.
 *
 * A falha no meio, nesta ordem, deixa um arquivo SEM linha — órfão, que custa
 * disco e que a auditoria de storage (`npm run storage:audit`) enxerga. O
 * inverso custava a foto.
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
    const outcome = await purgeTemporaryEvidenceCandidate(storage, candidate, now);
    if (outcome === "deleted") {
      deleted += 1;
    } else {
      skipped += 1;
    }
  }

  return { found: candidates.length, deleted, skipped };
}

export interface TemporaryEvidenceCandidate {
  id: string;
  storageKey: string;
}

/**
 * Um candidato lido pela varredura — possivelmente já VELHO quando chega aqui.
 *
 * Exportado porque a corrida da `RC-STO-06` só é testável de forma determinística
 * com a leitura e a exclusão separadas: o teste lê o candidato, promove a
 * etiqueta, e só então chama esta etapa com o candidato envelhecido.
 */
export async function purgeTemporaryEvidenceCandidate(
  storage: FileStorageContract,
  candidate: TemporaryEvidenceCandidate,
  now: Date,
  /**
   * Chamado depois da conferência de vínculo e antes da exclusão — o intervalo
   * em que a corrida da `RC-STO-06` acontecia. Só o teste o usa.
   */
  afterLinkCheck?: () => Promise<void>,
): Promise<"deleted" | "kept"> {
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
    return "kept";
  }

  await afterLinkCheck?.();

  let removed: { count: number };
  try {
    removed = await prisma.serviceOrderEvidence.deleteMany({
      /*
        Status E vencimento no predicado, reavaliados pelo banco depois de
        qualquer escrita concorrente na linha. O status cobre a promoção; o
        vencimento cobre a etiqueta que foi promovida e REBAIXADA no intervalo
        (remover o equipamento a devolve a `TEMPORARY` com prazo novo) — ela
        voltou a valer, e não é mais deste expurgo.
      */
      where: {
        id: candidate.id,
        status: "TEMPORARY",
        expiresAt: { not: null, lte: now },
      },
    });
  } catch {
    // FK `Restrict` do equipamento: alguém a ligou fora da promoção. Fica.
    return "kept";
  }
  if (removed.count !== 1) {
    return "kept";
  }

  // A linha já não existe: agora, e só agora, o arquivo pode sair.
  await discardBlobIfUnreferenced(storage, candidate.storageKey, "expurgo-etiqueta");
  return "deleted";
}
