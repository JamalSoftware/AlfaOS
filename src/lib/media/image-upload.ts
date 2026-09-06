import { badRequest } from "../errors";
import { MIME_EXTENSIONS } from "../storage/contract";
import { stripImageMetadata, UnparseableImageError } from "./image-metadata";

/**
 * # A fronteira de upload seguro de imagem
 *
 * Um lugar só decide o que é uma imagem aceitável e o que sai dela antes de ser
 * gravada. Todo caminho que persiste imagem no AlfaOS passa por aqui.
 *
 * ## Por que ela existe
 *
 * A limpeza de metadado nasceu no `PC-1` com **dois** consumidores — evidência
 * de OS e assinatura —, cada um repetindo a mesma sequência de validações com
 * as próprias mensagens. Enquanto foram dois, a duplicação era visível. A CTO
 * seria o terceiro, e é assim que o `EXIF-01` aconteceu em primeiro lugar: um
 * ponto de upload nasceu fora da política, e ninguém notou porque não havia
 * política, havia repetição.
 *
 * A extração veio ANTES do terceiro consumidor, de propósito. Acrescentar
 * primeiro e refatorar depois teria significado, por um intervalo, três cópias
 * — e o intervalo é exatamente quando o release sai.
 *
 * ## A ordem das etapas não é arbitrária
 *
 * ```text
 * 1. vazio           400 imediato
 * 2. tamanho         antes de olhar UM byte do conteúdo
 * 3. sniff           o tipo vem dos BYTES, nunca do header
 * 4. tipo aceito     o declarado precisa estar na allowlist
 * 5. concordância    declarado === detectado
 * 6. sanitização     metadado sai
 * ```
 *
 * O teto vem antes do sniff e da sanitização porque as duas percorrem o
 * arquivo: aceitar 500 MB para só então decidir que não é imagem entrega o
 * trabalho ao atacante. E a sanitização vem por último porque é a única etapa
 * que **produz** bytes — quem chama recebe o arquivo que será gravado, e é
 * sobre ele que hash e tamanho são calculados.
 *
 * ## O que a fronteira NÃO faz
 *
 * Não grava, não escolhe chave de storage, não conhece tenant e não sabe o que
 * é uma OS ou uma CTO. Ela responde uma pergunta só — *"estes bytes podem ser
 * persistidos, e em que forma?"* —, e é isso que a torna reutilizável sem
 * arrastar autorização junto.
 */

/**
 * Os tipos aceitos, derivados do storage.
 *
 * Deriva de `MIME_EXTENSIONS` porque um tipo que o storage não sabe nomear não
 * tem como ser gravado: as duas listas divergirem produziria um upload aceito
 * na validação e recusado na escrita. SVG não está lá, e a ausência é
 * deliberada — SVG executa script na origem de quem o renderiza.
 */
export const ACCEPTED_IMAGE_MIME = Object.keys(MIME_EXTENSIONS);

/**
 * Decide o tipo real pelos BYTES, nunca pelo mime declarado ou pela extensão.
 *
 * Um cliente pode declarar `image/png` para um script PHP ou chamar um
 * executável de `foto.jpg`. O número mágico é a única parte de um upload sobre
 * a qual o cliente não consegue mentir sem de fato produzir uma imagem válida.
 */
export function sniffImageMime(data: Buffer): string | null {
  if (
    data.length >= 3 &&
    data[0] === 0xff &&
    data[1] === 0xd8 &&
    data[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    data.length >= 8 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47 &&
    data[4] === 0x0d &&
    data[5] === 0x0a &&
    data[6] === 0x1a &&
    data[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    data.length >= 12 &&
    data.toString("ascii", 0, 4) === "RIFF" &&
    data.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

/**
 * As mensagens que cada superfície mostra.
 *
 * Parametrizadas, e não unificadas, porque quem envia uma assinatura e quem
 * envia a foto de uma caixa estão fazendo coisas diferentes: "Assinatura
 * vazia." orienta, "Arquivo vazio." confunde no meio de uma coleta de
 * assinatura. Unificar teria trocado uma duplicação de lógica por uma
 * regressão de texto em superfícies já homologadas.
 */
export interface ImageUploadMessages {
  empty: string;
  tooLarge: string;
  notAnImage: string;
  unsupportedType: string;
  /** Bytes que não são um contêiner íntegro. Uma só, porque a causa é uma só. */
  unparseable?: string;
}

export interface ImageUploadPolicy {
  maxBytes: number;
  messages: ImageUploadMessages;
}

export interface SafeImage {
  /** Os bytes JÁ SANITIZADOS. É este arquivo que deve ser gravado e hasheado. */
  data: Buffer;
  /** O tipo DETECTADO, que a esta altura é igual ao declarado. */
  mimeType: string;
}

const DEFAULT_UNPARSEABLE = "Imagem inválida ou corrompida.";

/**
 * Valida, sanitiza e devolve os bytes que devem ser persistidos.
 *
 * Lança `DomainError` de 400 em qualquer recusa — inclusive quando o
 * sanitizador não entende o arquivo. Essa escolha é dele e continua sendo:
 * nunca devolver a entrada intacta diante de um arquivo estranho, porque isso
 * transformaria "não entendi" em "guardei tudo o que ele tinha".
 */
export function processImageUpload(
  data: Buffer,
  declaredMimeType: string,
  policy: ImageUploadPolicy,
): SafeImage {
  if (data.byteLength === 0) {
    throw badRequest(policy.messages.empty);
  }
  if (data.byteLength > policy.maxBytes) {
    throw badRequest(policy.messages.tooLarge);
  }

  /*
    O tipo declarado precisa ser aceitável E os bytes precisam concordar com
    ele. Qualquer um dos dois sozinho é contornável: o header é controlado pelo
    cliente, e só o sniff aceitaria alegremente um JPEG enviado como
    `application/x-msdownload`.
  */
  const sniffed = sniffImageMime(data);
  if (!sniffed) {
    throw badRequest(policy.messages.notAnImage);
  }
  if (!ACCEPTED_IMAGE_MIME.includes(declaredMimeType)) {
    throw badRequest(policy.messages.unsupportedType);
  }
  if (sniffed !== declaredMimeType) {
    throw badRequest("O conteúdo do arquivo não corresponde ao tipo informado.");
  }

  /*
    O metadado sai AQUI, e o lugar é metade da correção (`EXIF-01`).

    Antes do hash, antes do tamanho, antes da transação: o que vem daqui em
    diante — inclusive o `contentHash`, que existe para conferir integridade —
    descreve o ARQUIVO GRAVADO, não o que o cliente mandou. Sanitizar depois do
    hash faria o campo que prova "o arquivo não mudou" acusar corrupção em toda
    foto.

    E é no servidor porque qualquer cliente pode enviar imagem. Uma limpeza só
    no aplicativo protegeria exatamente quem já se comporta bem — e o GPS do
    EXIF é escrito pelo aplicativo de CÂMERA, sob a permissão dele, então nem o
    técnico que negou localização ao AlfaOS está protegido sem esta etapa.
  */
  try {
    return { data: stripImageMetadata(data, sniffed), mimeType: sniffed };
  } catch (error) {
    if (error instanceof UnparseableImageError) {
      throw badRequest(policy.messages.unparseable ?? DEFAULT_UNPARSEABLE);
    }
    throw error;
  }
}
