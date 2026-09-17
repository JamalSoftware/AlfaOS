import { createHash } from "node:crypto";
import { prisma } from "../prisma";
import { logAuditWithin } from "../audit";
import { logServerError } from "../safe-log";
import { stripImageMetadata } from "../media/image-metadata";
import { inspectStoredImage } from "../media/image-inspection";
import { sniffImageMime } from "../media/image-upload";
import {
  assertSafeStorageKey,
  MIME_EXTENSIONS,
  type FileStorageContract,
} from "./contract";
import { buildStorageKey } from "./index";
import { discardBlobIfUnreferenced, isStorageKeyReferenced } from "./references";

/**
 * # Auditoria de fotos e storage (`RC-1E`)
 *
 * Três perguntas sobre o que JÁ está gravado, e duas ações que só acontecem por
 * ordem explícita de quem opera:
 *
 * ```text
 * PERGUNTA                                         RESPONDIDA POR
 * que foto gravada ainda carrega metadado?         auditPhotoStorage   (lê)
 * que linha aponta para arquivo que não existe?    auditPhotoStorage   (lê)
 * que arquivo nenhuma linha referencia?            auditPhotoStorage   (lê)
 *
 * AÇÃO                                             EXIGE
 * re-sanitizar a foto legada                       apply: true
 * apagar arquivo órfão                             apply: true
 * ```
 *
 * ## O padrão é NÃO mudar nada
 *
 * Sem `apply`, as duas ações devolvem só o que FARIAM. A auditoria nem recebe a
 * opção: ela não chama `put`, não chama `delete` e não escreve no banco. Os
 * testes provam isso pelo SHA-256 de cada arquivo e pelo retrato das linhas,
 * antes e depois.
 *
 * ## O que é ÓRFÃO — e o que não é
 *
 * Órfão é um arquivo cuja chave casa com `STORAGE_KEY_PATTERN` e que **nenhuma
 * linha, de nenhuma empresa**, referencia em uma das três colunas de
 * `references.ts`. Três coisas NÃO são órfãs, e cada uma tem motivo:
 *
 * - **arquivo referenciado por outra empresa** — a pergunta é "apagar quebra
 *   alguma linha?", e a resposta não depende de quem está olhando;
 * - **arquivo recente** — gravado há menos de `ORPHAN_GRACE_MS`. Todo caminho
 *   do AlfaOS grava o arquivo e o liga na MESMA requisição, segundos depois; um
 *   arquivo de um minuto sem linha é, muito provavelmente, um upload em
 *   andamento, e é exatamente esse o arquivo que um expurgo não pode apagar;
 * - **entrada não reconhecida** — temporário de gravação interrompida, arquivo
 *   posto à mão, link simbólico. É contada, nunca lida nem apagada: nada que o
 *   AlfaOS não escreveu é decidido por ele.
 *
 * A direção inversa — **linha apontando para arquivo ausente** — é outro
 * problema e fica em outra contagem. Apagar não o resolve, e confundir os dois
 * levaria alguém a "limpar" justamente a evidência de que um arquivo sumiu.
 */

export type StorageReferenceKind = "EVIDENCE" | "SIGNATURE" | "CTO_PHOTO";

export interface StorageReference {
  kind: StorageReferenceKind;
  /** O id da LINHA — evidência, assinatura ou CTO. Nunca nome de pessoa. */
  id: string;
  companyId: string;
  storageKey: string;
  mimeType: string;
}

/**
 * Janela em que um arquivo sem linha ainda não é órfão.
 *
 * 24 horas, e não segundos, de propósito: o custo de um órfão esperar um dia é
 * disco; o custo de apagar um upload que estava a milissegundos de ser ligado é
 * uma foto. A janela real entre gravar e ligar é a duração de uma requisição.
 */
export const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;

/** Toda linha que aponta para o storage, de todas as empresas. */
export async function loadStorageReferences(): Promise<StorageReference[]> {
  const [evidencias, assinaturas, caixas] = await prisma.$transaction([
    prisma.serviceOrderEvidence.findMany({
      select: { id: true, companyId: true, storageKey: true, mimeType: true },
      orderBy: { id: "asc" },
    }),
    prisma.serviceOrderSignature.findMany({
      select: { id: true, companyId: true, storageKey: true, mimeType: true },
      orderBy: { id: "asc" },
    }),
    prisma.cTO.findMany({
      where: { photoStorageKey: { not: null } },
      select: { id: true, companyId: true, photoStorageKey: true },
      orderBy: { id: "asc" },
    }),
  ]);

  return [
    ...evidencias.map((e) => ({ kind: "EVIDENCE" as const, ...e })),
    ...assinaturas.map((s) => ({ kind: "SIGNATURE" as const, ...s })),
    ...caixas.map((c) => ({
      kind: "CTO_PHOTO" as const,
      id: c.id,
      companyId: c.companyId,
      storageKey: c.photoStorageKey!,
      // Como a rota GET da foto: o tipo vem da extensão que o servidor escolheu.
      mimeType: mimeDaExtensao(c.photoStorageKey!) ?? "application/octet-stream",
    })),
  ];
}

function mimeDaExtensao(storageKey: string): string | null {
  const ext = storageKey.slice(storageKey.lastIndexOf(".") + 1);
  return Object.keys(MIME_EXTENSIONS).find((m) => MIME_EXTENSIONS[m] === ext) ?? null;
}

// ---------------------------------------------------------------------------
// Auditoria — só leitura
// ---------------------------------------------------------------------------

export type LegacyPhotoState =
  /** A política atual não mudaria nada. */
  | "CLEAN"
  /** A política atual tiraria metadado deste arquivo. */
  | "NEEDS_SANITIZATION"
  /** Os bytes não são o contêiner que a linha diz — nada é feito com ele. */
  | "UNPARSEABLE";

export interface LegacyPhotoFinding {
  kind: StorageReferenceKind;
  id: string;
  companyId: string;
  state: Exclude<LegacyPhotoState, "CLEAN">;
  hasGps: boolean;
}

export interface MissingFileFinding {
  kind: StorageReferenceKind;
  id: string;
  companyId: string;
}

export interface PhotoStorageAuditReport {
  references: number;
  /** Arquivos referenciados que existem e foram lidos. */
  examined: number;
  clean: number;
  needsSanitization: number;
  /** Subconjunto de `needsSanitization` com a IFD de GPS apontada. */
  withGps: number;
  unparseable: number;
  /** Linhas apontando para arquivo ausente — a direção inversa do órfão. */
  missingFiles: number;
  /** Arquivos com chave reconhecida no storage. */
  storageFiles: number;
  /** Sem linha e mais velhos que a carência: candidatos a expurgo. */
  orphanCandidates: number;
  /** Sem linha, mas dentro da carência: podem ser upload em andamento. */
  recentUnreferenced: number;
  /** Candidatos cuja empresa (primeiro segmento da chave) nem existe mais. */
  orphansOfMissingCompanies: number;
  /** Candidatos de empresa que EXISTE — histórico, decisão de retenção. */
  orphansOfExistingCompanies: number;
  /** Entradas que não casam com o padrão de chave: contadas, nunca tocadas. */
  unrecognizedEntries: number;
  legacy: LegacyPhotoFinding[];
  missing: MissingFileFinding[];
  /** Chaves candidatas: ids de servidor, sem dado pessoal. */
  orphans: string[];
  /** Subconjunto de `orphans` cuja empresa não existe mais. */
  missingCompanyOrphans: string[];
  /** Subconjunto de `orphans` cuja empresa existe. */
  activeCompanyOrphans: string[];
}

export interface AuditOptions {
  storage: FileStorageContract;
  now?: Date;
  graceMs?: number;
}

export async function auditPhotoStorage(options: AuditOptions): Promise<PhotoStorageAuditReport> {
  const { storage } = options;
  const now = options.now ?? new Date();
  const graceMs = options.graceMs ?? ORPHAN_GRACE_MS;

  const referencias = await loadStorageReferences();
  const relatorio: PhotoStorageAuditReport = {
    references: referencias.length,
    examined: 0,
    clean: 0,
    needsSanitization: 0,
    withGps: 0,
    unparseable: 0,
    missingFiles: 0,
    storageFiles: 0,
    orphanCandidates: 0,
    recentUnreferenced: 0,
    orphansOfMissingCompanies: 0,
    orphansOfExistingCompanies: 0,
    unrecognizedEntries: 0,
    legacy: [],
    missing: [],
    orphans: [],
    missingCompanyOrphans: [],
    activeCompanyOrphans: [],
  };

  for (const ref of referencias) {
    const bytes = await lerSeExistir(storage, ref.storageKey);
    if (!bytes) {
      relatorio.missingFiles += 1;
      relatorio.missing.push({ kind: ref.kind, id: ref.id, companyId: ref.companyId });
      continue;
    }
    relatorio.examined += 1;
    const estado = classificar(bytes, ref);
    if (estado.state === "CLEAN") {
      relatorio.clean += 1;
      continue;
    }
    if (estado.state === "UNPARSEABLE") relatorio.unparseable += 1;
    if (estado.state === "NEEDS_SANITIZATION") relatorio.needsSanitization += 1;
    if (estado.hasGps) relatorio.withGps += 1;
    relatorio.legacy.push({
      kind: ref.kind,
      id: ref.id,
      companyId: ref.companyId,
      state: estado.state,
      hasGps: estado.hasGps,
    });
  }

  const referenciadas = new Set(referencias.map((r) => r.storageKey));
  const empresas = new Set(
    (await prisma.company.findMany({ select: { id: true } })).map((c) => c.id.toLowerCase()),
  );

  for await (const entrada of storage.list()) {
    if (!entrada.recognized) {
      relatorio.unrecognizedEntries += 1;
      continue;
    }
    relatorio.storageFiles += 1;
    if (referenciadas.has(entrada.key)) continue;
    if (now.getTime() - entrada.modifiedAt.getTime() < graceMs) {
      relatorio.recentUnreferenced += 1;
      continue;
    }
    relatorio.orphanCandidates += 1;
    relatorio.orphans.push(entrada.key);
    if (empresas.has(entrada.key.slice(0, entrada.key.indexOf("/")))) {
      relatorio.orphansOfExistingCompanies += 1;
      relatorio.activeCompanyOrphans.push(entrada.key);
    } else {
      relatorio.orphansOfMissingCompanies += 1;
      relatorio.missingCompanyOrphans.push(entrada.key);
    }
  }

  return relatorio;
}

async function lerSeExistir(storage: FileStorageContract, storageKey: string): Promise<Buffer | null> {
  try {
    assertSafeStorageKey(storageKey);
  } catch {
    // Uma chave que não casa com o padrão não é lida — nem para auditar.
    return null;
  }
  try {
    return await storage.get(storageKey);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function classificar(
  bytes: Buffer,
  ref: StorageReference,
): { state: LegacyPhotoState; hasGps: boolean } {
  /*
    O tipo registrado precisa ser o dos bytes. Uma linha dizendo PNG sobre um
    JPEG não é limpa "como PNG": isso aplicaria a política errada ao arquivo e
    daria um veredito falso. Fica como não interpretável, para alguém olhar.
  */
  if (sniffImageMime(bytes) !== ref.mimeType) {
    return { state: "UNPARSEABLE", hasGps: false };
  }
  const inspecao = inspectStoredImage(bytes, ref.mimeType);
  if (!inspecao.parseable) return { state: "UNPARSEABLE", hasGps: false };
  return {
    state: inspecao.needsSanitization ? "NEEDS_SANITIZATION" : "CLEAN",
    hasGps: inspecao.hasGps,
  };
}

// ---------------------------------------------------------------------------
// Re-sanitização legada — só com apply
// ---------------------------------------------------------------------------

export interface ResanitizeOptions {
  storage: FileStorageContract;
  apply: boolean;
}

export interface ResanitizeResult {
  apply: boolean;
  /** Fotos que a política atual limparia. */
  candidates: number;
  /** Linhas que passaram a apontar para a versão limpa. */
  resanitized: number;
  /** Linhas que mudaram durante a execução e não foram tocadas. */
  skippedChanged: number;
  failed: number;
}

/**
 * Re-sanitiza foto legada SEM destruir a original.
 *
 * ```text
 * lê a original → limpa → grava numa CHAVE NOVA (atômico) → liga a linha à chave
 * nova, com a chave velha no predicado → a original FICA no disco
 * ```
 *
 * Não reescreve o arquivo no lugar. O storage de produção, o volume e a política
 * de backup são decisão aberta do dono (`RC-1A`, `RC-1F`), e sobrescrever a
 * única cópia de uma evidência sem esse contrato seria apostar que nada dá
 * errado. Assim, a original vira órfã — sem linha, fora de toda rota — e só sai
 * por um expurgo de órfãos, que é outra ordem explícita.
 *
 * O `contentHash` e o `sizeBytes` da linha passam a descrever o arquivo NOVO,
 * porque é para isso que existem. O hash do fechamento (`closingContentHash`) e
 * o conteúdo assinado NÃO mudam: eles usam o `id` e a categoria da evidência,
 * nunca os bytes.
 *
 * A linha só muda se ainda apontar para a chave lida (compare-and-set). Se ela
 * mudou no intervalo, o blob novo é recolhido pela limpeza verificada e a linha
 * fica como está.
 */
export async function resanitizeLegacyPhotos(options: ResanitizeOptions): Promise<ResanitizeResult> {
  const { storage, apply } = options;
  const resultado: ResanitizeResult = {
    apply,
    candidates: 0,
    resanitized: 0,
    skippedChanged: 0,
    failed: 0,
  };

  for (const ref of await loadStorageReferences()) {
    const bytes = await lerSeExistir(storage, ref.storageKey);
    if (!bytes || classificar(bytes, ref).state !== "NEEDS_SANITIZATION") continue;
    resultado.candidates += 1;
    if (!apply) continue;

    let chaveNova: string | null = null;
    try {
      const limpo = stripImageMetadata(bytes, ref.mimeType);
      const escopo = ref.storageKey.split("/")[1];
      chaveNova = buildStorageKey(ref.companyId, escopo, ref.mimeType);
      await storage.put(chaveNova, limpo, ref.mimeType);

      const ligou = await ligarVersaoLimpa(ref, chaveNova, limpo);
      if (ligou) {
        resultado.resanitized += 1;
      } else {
        resultado.skippedChanged += 1;
        await discardBlobIfUnreferenced(storage, chaveNova, "re-sanitizacao-descartada");
      }
    } catch (error) {
      resultado.failed += 1;
      logServerError("storage", error, { operacao: "re-sanitizacao", tipo: ref.kind });
      if (chaveNova) {
        await discardBlobIfUnreferenced(storage, chaveNova, "re-sanitizacao-falhou");
      }
    }
  }

  return resultado;
}

async function ligarVersaoLimpa(
  ref: StorageReference,
  chaveNova: string,
  limpo: Buffer,
): Promise<boolean> {
  const tamanho = limpo.byteLength;
  return prisma.$transaction(async (tx) => {
    let count = 0;
    if (ref.kind === "EVIDENCE") {
      count = (
        await tx.serviceOrderEvidence.updateMany({
          where: { id: ref.id, companyId: ref.companyId, storageKey: ref.storageKey },
          data: {
            storageKey: chaveNova,
            sizeBytes: tamanho,
            contentHash: createHash("sha256").update(limpo).digest("hex"),
          },
        })
      ).count;
    } else if (ref.kind === "SIGNATURE") {
      count = (
        await tx.serviceOrderSignature.updateMany({
          where: { id: ref.id, companyId: ref.companyId, storageKey: ref.storageKey },
          data: { storageKey: chaveNova, sizeBytes: tamanho },
        })
      ).count;
    } else {
      count = (
        await tx.cTO.updateMany({
          where: { id: ref.id, companyId: ref.companyId, photoStorageKey: ref.storageKey },
          data: { photoStorageKey: chaveNova },
        })
      ).count;
    }
    if (count !== 1) return false;

    await logAuditWithin(tx, {
      companyId: ref.companyId,
      userId: null,
      action: "STORAGE.PHOTO_RESANITIZED",
      entity:
        ref.kind === "EVIDENCE"
          ? "ServiceOrderEvidence"
          : ref.kind === "SIGNATURE"
            ? "ServiceOrderSignature"
            : "CTO",
      entityId: ref.id,
      // Nem chave, nem bytes, nem metadado removido: só o fato e o tamanho novo.
      details: `Metadado removido de foto antiga (${tamanho} bytes)`,
    });
    return true;
  });
}

// ---------------------------------------------------------------------------
// Expurgo de órfãos — só com apply E escopo explícito
// ---------------------------------------------------------------------------

/**
 * Os escopos de órfão, e por que só UM deles apaga.
 *
 * Os candidatos a órfão não são uma coisa só. No banco de desenvolvimento, a
 * mesma auditoria achou resíduo de empresas de teste que não existem mais E
 * fotos antigas de uma CTO de uma empresa que continua operando — histórico
 * da caixa, cuja retenção é decisão do dono. Um `--apply` que apagasse "todos
 * os candidatos" misturaria as duas decisões num comando só, e documentação
 * dizendo "não execute" não é proteção para um comando destrutivo.
 *
 * - `missing-company` — a empresa do prefixo da chave não existe mais. É o
 *   ÚNICO escopo que apaga.
 * - `active-company` — a empresa existe. Pode ser AUDITADO (simulação), e é
 *   recusado com `--apply` até haver decisão de retenção.
 *
 * Não existe escopo "todos", de propósito: seria o atalho que devolve a mistura.
 */
export const ORPHAN_SCOPE_MISSING_COMPANY = "missing-company";
export const ORPHAN_SCOPE_ACTIVE_COMPANY = "active-company";
export type OrphanScope =
  | typeof ORPHAN_SCOPE_MISSING_COMPANY
  | typeof ORPHAN_SCOPE_ACTIVE_COMPANY;

/** O pedido de expurgo não tem escopo que permita apagar. Nada foi lido nem apagado. */
export class OrphanPurgeScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrphanPurgeScopeError";
  }
}

/**
 * Decide o escopo ANTES de qualquer leitura de storage ou banco.
 *
 * Com `apply`, só `missing-company` passa. A validação mora aqui, e não só no
 * comando de linha: um chamador futuro da função não pode apagar os dois grupos
 * por não ter passado pelo mesmo `if` do script.
 */
export function resolveOrphanScope(apply: boolean, scope: string | undefined): OrphanScope | null {
  if (
    scope !== undefined &&
    scope !== ORPHAN_SCOPE_MISSING_COMPANY &&
    scope !== ORPHAN_SCOPE_ACTIVE_COMPANY
  ) {
    throw new OrphanPurgeScopeError(
      `Escopo de órfão desconhecido. Use --scope ${ORPHAN_SCOPE_MISSING_COMPANY}. Nada foi apagado.`,
    );
  }
  if (!apply) return scope ?? null;
  if (scope === ORPHAN_SCOPE_ACTIVE_COMPANY) {
    throw new OrphanPurgeScopeError(
      "active-company orphan purge requires owner decision — o expurgo de órfãos de empresa existente depende de decisão de retenção do dono. Nada foi apagado.",
    );
  }
  if (scope !== ORPHAN_SCOPE_MISSING_COMPANY) {
    throw new OrphanPurgeScopeError(
      `--purge-orphans --apply exige --scope ${ORPHAN_SCOPE_MISSING_COMPANY}. Nada foi apagado.`,
    );
  }
  return ORPHAN_SCOPE_MISSING_COMPANY;
}

export interface PurgeOrphansOptions {
  storage: FileStorageContract;
  apply: boolean;
  /** Obrigatório com `apply`: só `missing-company` apaga. */
  scope?: string;
  now?: Date;
  graceMs?: number;
  /**
   * Chamado entre classificar e apagar cada candidato. Existe para o teste da
   * corrida: é ali que outro fluxo pode ligar o arquivo a uma linha.
   */
  beforeDelete?: (storageKey: string) => Promise<void>;
}

export interface PurgeOrphansResult {
  apply: boolean;
  scope: OrphanScope | null;
  candidates: number;
  deleted: number;
  /** Ganharam referência entre a classificação e a exclusão. */
  relinked: number;
  /** A empresa do prefixo passou a existir entre a classificação e a exclusão. */
  companyNowExists: number;
  failed: number;
}

export async function purgeOrphanFiles(options: PurgeOrphansOptions): Promise<PurgeOrphansResult> {
  const { storage, apply } = options;
  const scope = resolveOrphanScope(apply, options.scope);

  const relatorio = await auditPhotoStorage({
    storage,
    now: options.now,
    graceMs: options.graceMs,
  });
  const candidatos =
    scope === ORPHAN_SCOPE_MISSING_COMPANY
      ? relatorio.missingCompanyOrphans
      : scope === ORPHAN_SCOPE_ACTIVE_COMPANY
        ? relatorio.activeCompanyOrphans
        : relatorio.orphans;
  const resultado: PurgeOrphansResult = {
    apply,
    scope,
    candidates: candidatos.length,
    deleted: 0,
    relinked: 0,
    companyNowExists: 0,
    failed: 0,
  };
  if (!apply) return resultado;

  for (const chave of candidatos) {
    await options.beforeDelete?.(chave);
    try {
      /*
        A classificação é uma fotografia, e ela envelheceu. Imediatamente antes
        de apagar, o banco é consultado de novo — a mesma pergunta da limpeza
        verificada. Um arquivo que ganhou linha no intervalo fica, seja qual for
        a empresa da linha.
      */
      if (await isStorageKeyReferenced(chave)) {
        resultado.relinked += 1;
        continue;
      }
      // E o escopo continua valendo: empresa que passou a existir não é resíduo.
      if (await empresaExiste(prefixoDaEmpresa(chave))) {
        resultado.companyNowExists += 1;
        continue;
      }
      await storage.delete(chave);
      resultado.deleted += 1;
    } catch (error) {
      resultado.failed += 1;
      logServerError("storage", error, { operacao: "expurgo-orfao" });
    }
  }
  return resultado;
}

function prefixoDaEmpresa(storageKey: string): string {
  return storageKey.slice(0, storageKey.indexOf("/"));
}

async function empresaExiste(prefixo: string): Promise<boolean> {
  const n = await prisma.company.count({
    where: { id: { equals: prefixo, mode: "insensitive" } },
  });
  return n > 0;
}
