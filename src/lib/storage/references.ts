import { prisma } from "../prisma";
import { logServerError } from "../safe-log";
import type { FileStorageContract } from "./contract";

/**
 * # Quem aponta para um arquivo do storage (`RC-1E`)
 *
 * Três colunas guardam chave de storage, e são as ÚNICAS três:
 *
 * ```text
 * ServiceOrderEvidence.storageKey    @unique   foto de evidência e etiqueta
 * ServiceOrderSignature.storageKey   @unique   assinatura do cliente
 * CTO.photoStorageKey                          foto da caixa
 * ```
 *
 * "Referenciado" é uma linha, **de qualquer empresa**, apontando para a chave.
 * A consulta não filtra tenant de propósito: a pergunta aqui não é "quem pode
 * ler este arquivo" — essa é das rotas —, é "apagar este arquivo quebra alguma
 * linha?". Filtrar por empresa faria um arquivo referenciado por outra empresa
 * parecer livre, e é exatamente esse o arquivo que não pode sumir.
 *
 * Uma coluna nova de chave de storage PRECISA entrar aqui. O teste
 * `ORPHAN-REF-COLUMNS` lê o schema e falha se ela não entrar.
 */
export const STORAGE_REFERENCE_COLUMNS = [
  "ServiceOrderEvidence.storageKey",
  "ServiceOrderSignature.storageKey",
  "CTO.photoStorageKey",
] as const;

export async function isStorageKeyReferenced(storageKey: string): Promise<boolean> {
  const [evidencias, assinaturas, caixas] = await prisma.$transaction([
    prisma.serviceOrderEvidence.count({ where: { storageKey } }),
    prisma.serviceOrderSignature.count({ where: { storageKey } }),
    prisma.cTO.count({ where: { photoStorageKey: storageKey } }),
  ]);
  return evidencias + assinaturas + caixas > 0;
}

export type BlobDiscardOutcome = "deleted" | "referenced" | "unknown";

/**
 * Apaga um blob recém-gravado **só se nenhuma linha o referencia**.
 *
 * É a limpeza de todo caminho que grava o arquivo e depois tenta ligá-lo no
 * banco. A versão anterior apagava em qualquer erro, e erro não prova que a
 * transação voltou: o `COMMIT` pode ter efetivado e a conexão cair antes da
 * confirmação chegar (`RC-STO-07`). Apagar ali deixava uma linha COMMITADA
 * apontando para um arquivo que não existe mais — perda silenciosa de foto.
 *
 * Na dúvida, o arquivo FICA: se a própria conferência falhar, a resposta é
 * `unknown` e nada é apagado. Um blob a mais é órfão, que a auditoria de
 * storage enxerga; uma foto a menos não volta.
 */
export async function discardBlobIfUnreferenced(
  storage: FileStorageContract,
  storageKey: string,
  operacao: string,
): Promise<BlobDiscardOutcome> {
  let referenciado: boolean;
  try {
    referenciado = await isStorageKeyReferenced(storageKey);
  } catch (error) {
    logServerError("storage", error, { operacao, etapa: "conferir-referencia" });
    return "unknown";
  }
  if (referenciado) return "referenced";
  try {
    await storage.delete(storageKey);
    return "deleted";
  } catch (error) {
    logServerError("storage", error, { operacao, etapa: "apagar-blob" });
    return "unknown";
  }
}
