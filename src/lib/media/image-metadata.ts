/**
 * Remoção de metadado das imagens que o AlfaOS guarda (`EXIF-01`).
 *
 * ## O problema
 *
 * Uma auditoria independente encontrou que toda foto de evidência era gravada
 * com o bloco GPS do EXIF intacto. O que torna isso grave não é o dado em si —
 * é de quem é a permissão: **o GPS do EXIF é escrito pelo aplicativo de câmera,
 * sob a permissão DELE**. O técnico que negou localização ao AlfaOS continuava
 * enviando coordenada em cada foto, e a recusa dele não tinha efeito nenhum
 * sobre essa coleta. Consentimento contornado por um canal que ninguém estava
 * olhando.
 *
 * ## Por que aqui, e não no Flutter
 *
 * Qualquer cliente pode enviar imagem: o aplicativo, um script, uma integração
 * futura, alguém com o token. Uma limpeza feita só no aparelho protegeria
 * exatamente quem já se comporta bem. A regra vale para os BYTES que chegam,
 * seja qual for a origem.
 *
 * ## Por que sem dependência nova
 *
 * Metadado de imagem vive em **segmentos de contêiner**, ao lado dos dados
 * comprimidos — não dentro deles. Removê-lo é percorrer a estrutura e não
 * copiar certos pedaços: nenhum pixel é decodificado, nada é recomprimido,
 * nenhuma qualidade se perde. Uma biblioteca de imagem faria o oposto —
 * decodificar e reencodar tudo para jogar fora um punhado de bytes —, cobrando
 * binário nativo no deploy e degradando a evidência a cada upload.
 *
 * ## A política
 *
 * | Segmento | Destino | Por quê |
 * |---|---|---|
 * | `APP0`/JFIF | **fica** | estrutural, densidade de pixel; não fala da pessoa |
 * | `APP2`/ICC | **fica** | perfil de cor; tirá-lo muda como a foto APARECE (§5) |
 * | `APP1` Exif | **sai**, menos `Orientation` | é onde mora o GPS |
 * | `APP1` XMP | **sai** | `exif:GPSLatitude` em texto |
 * | `APP13` IPTC/Photoshop | **sai** | carrega localização e autoria |
 * | demais `APPn`, `COM` | **sai** | sem valor operacional |
 *
 * `Orientation` é reinjetada num EXIF mínimo porque o AlfaOS **não decodifica**
 * a imagem: os pixels chegam como a câmera os gravou e é a tag que os endireita
 * na tela. Apagá-la faria toda foto de retrato aparecer deitada no relatório —
 * e o técnico levaria a culpa por "tirar a foto errada".
 *
 * ## O que isto NÃO faz
 *
 * Não é defesa contra esteganografia. Dado escondido nos próprios pixels
 * sobrevive, e só sobreviveria a um reencode — que também não garante nada
 * contra LSB. O alvo aqui é o metadado que a câmera escreve sozinha, que é o
 * caso real e o que ninguém escolheu enviar.
 */

/** Falha estrutural: os bytes não são a imagem que dizem ser. */
export class UnparseableImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnparseableImageError";
  }
}

const TAG_ORIENTATION = 0x0112;

/**
 * Remove o metadado de uma imagem, preservando o que ela mostra.
 *
 * Lança [UnparseableImageError] quando a estrutura não fecha. É deliberado que
 * falhe em vez de devolver a entrada: devolver o original diante de um arquivo
 * estranho transformaria "não entendi este arquivo" em "guardei tudo o que ele
 * tinha", que é a porta que esta função existe para fechar.
 */
export function stripImageMetadata(data: Buffer, mimeType: string): Buffer {
  switch (mimeType) {
    case "image/jpeg":
      return stripJpeg(data);
    case "image/png":
      return stripPng(data);
    case "image/webp":
      return stripWebp(data);
    default:
      throw new UnparseableImageError(`Tipo não suportado: ${mimeType}`);
  }
}

// ---------------------------------------------------------------------------
// JPEG
// ---------------------------------------------------------------------------

/** Marcadores que existem sozinhos, sem campo de tamanho. */
function isStandaloneMarker(code: number): boolean {
  return code === 0x01 || (code >= 0xd0 && code <= 0xd9);
}

/**
 * Teto de segmentos antes do scan.
 *
 * Um JPEG de câmera tem dezenas de segmentos antes do `SOS` — nunca mil. O teto
 * existe porque o percurso trabalha sobre bytes escolhidos por quem envia:
 * marcadores isolados (`FF D0`–`FF D9`) ocupam **dois bytes**, e um arquivo de
 * 8 MB feito só deles produz quatro milhões de iterações e de fatias, cada uma
 * virando um elemento do `concat` final.
 *
 * A auditoria independente mediu: **1452 ms de event loop bloqueado** para 8 MB,
 * contra 2 ms de um JPEG normal — 726 vezes. Em Node isso não é lentidão de uma
 * requisição, é a aplicação inteira parada, para todos os tenants, porque a
 * thread é uma só. Com o teto, o pior caso volta à ordem do `sniff` e do
 * SHA-256, que já rodam sobre a mesma entrada.
 */
const MAX_SEGMENTOS = 1024;

function stripJpeg(data: Buffer): Buffer {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) {
    throw new UnparseableImageError("JPEG sem SOI.");
  }

  const saida: Buffer[] = [data.subarray(0, 2)];
  let orientacao: number | null = null;
  let segmentos = 0;
  let i = 2;

  while (i < data.length) {
    if (++segmentos > MAX_SEGMENTOS) {
      throw new UnparseableImageError("JPEG com segmentos demais.");
    }
    if (data[i] !== 0xff) {
      throw new UnparseableImageError("marcador JPEG esperado.");
    }
    // Preenchimento: uma sequência de 0xFF antes do código é legal.
    let j = i;
    while (j < data.length && data[j] === 0xff) j++;
    if (j >= data.length) {
      throw new UnparseableImageError("JPEG termina num marcador incompleto.");
    }
    const codigo = data[j];

    if (isStandaloneMarker(codigo)) {
      saida.push(data.subarray(i, j + 1));
      i = j + 1;
      continue;
    }

    if (j + 2 >= data.length) {
      throw new UnparseableImageError("segmento JPEG sem tamanho.");
    }
    const tamanho = data.readUInt16BE(j + 1);
    if (tamanho < 2 || j + 1 + tamanho > data.length) {
      throw new UnparseableImageError("segmento JPEG truncado.");
    }
    const carga = data.subarray(j + 3, j + 1 + tamanho);

    if (codigo === 0xda) {
      /*
        Início do scan: daqui em diante vêm os dados comprimidos, que NÃO são
        segmentos e não podem ser percorridos. Nenhum pixel é tocado.

        Mas o arquivo NÃO termina necessariamente na imagem. Copiar até o fim do
        buffer — que era o que esta linha fazia — deixava passar tudo o que
        estivesse anexado DEPOIS do `EOI`, e é ali que Samsung e Google gravam o
        MP4 da Motion Photo, cujo átomo `moov/udta/©xyz` guarda coordenada. A
        auditoria independente provou a sobrevivência: um bloco arbitrário
        colado após o `EOI` atravessava a limpeza intacto, no mesmo arquivo em
        que GPS, thumbnail e IPTC eram corretamente removidos.

        Cortar no `EOI` fecha isso sem decodificar nada. `FF D9` não aparece
        dentro dos dados comprimidos: ali o `FF` é escapado como `FF 00`, e os
        únicos marcadores permitidos são os de reinício, `FF D0`–`FF D7`.

        Sem `EOI` o arquivo está truncado nos DADOS, não na estrutura — copiamos
        o que há, como antes, porque isso continua sendo uma imagem legível até
        onde vai.
      */
      const fimDaImagem = indiceDoEoi(data, i);
      saida.push(fimDaImagem === -1 ? data.subarray(i) : data.subarray(i, fimDaImagem + 2));
      break;
    }

    const ehMetadado =
      (codigo >= 0xe0 && codigo <= 0xef) || codigo === 0xfe; // APPn ou COM
    /*
      Os dois preservados são reconhecidos pelo CONTEÚDO, não pelo número.

      A versão anterior guardava qualquer `APP0` e qualquer `APP2` que
      começasse com `ICC_PROFILE` — e a auditoria mostrou que isso deixa dois
      canais abertos: `APP0` também abriga `JFXX`, que carrega thumbnail, e o
      prefixo sem o `\0` casa com carga arbitrária. Aqui a pergunta passou a ser
      "é exatamente isto?".
    */
    const ehJfif =
      codigo === 0xe0 && carga.subarray(0, 5).toString("ascii") === "JFIF\0";
    const ehIcc =
      codigo === 0xe2 &&
      carga.subarray(0, 12).toString("ascii") === "ICC_PROFILE\0";

    if (ehMetadado && !ehJfif && !ehIcc) {
      // É Exif? Guarda só a orientação antes de descartar o resto.
      if (codigo === 0xe1 && carga.subarray(0, 6).toString("ascii") === "Exif\0\0") {
        orientacao = lerOrientacao(carga.subarray(6));
      }
      i = j + 1 + tamanho;
      continue;
    }

    saida.push(data.subarray(i, j + 1 + tamanho));
    i = j + 1 + tamanho;
  }

  if (orientacao !== null) {
    /*
      Depois do `APP0`/JFIF quando ele existe, e não colado no `SOI`.

      A convenção do JFIF é que ele seja o primeiro marcador do arquivo, e a
      versão anterior enfiava o `APP1` na frente dele. Nenhum decodificador
      conhecido recusa — mas escrever fora da convenção sem motivo é apostar em
      quais leitores existem por aí.
    */
    const depoisDoJfif = saida.length > 1 && saida[1][1] === 0xe0 ? 2 : 1;
    saida.splice(depoisDoJfif, 0, exifApenasComOrientacao(orientacao));
  }

  return Buffer.concat(saida);
}

/** Onde termina a imagem. `-1` quando o arquivo não tem `EOI`. */
function indiceDoEoi(data: Buffer, inicio: number): number {
  for (let p = inicio; p + 1 < data.length; p++) {
    if (data[p] === 0xff && data[p + 1] === 0xd9) return p;
  }
  return -1;
}

/** Lê `Orientation` de um bloco TIFF, sem confiar em nada dele. */
function lerOrientacao(tiff: Buffer): number | null {
  if (tiff.length < 8) return null;
  const ordem = tiff.toString("ascii", 0, 2);
  if (ordem !== "II" && ordem !== "MM") return null;
  const little = ordem === "II";
  const u16 = (p: number) =>
    p + 2 <= tiff.length ? (little ? tiff.readUInt16LE(p) : tiff.readUInt16BE(p)) : null;
  const u32 = (p: number) =>
    p + 4 <= tiff.length ? (little ? tiff.readUInt32LE(p) : tiff.readUInt32BE(p)) : null;

  const inicio = u32(4);
  if (inicio === null) return null;
  const total = u16(inicio);
  if (total === null) return null;

  for (let k = 0; k < total; k++) {
    const p = inicio + 2 + k * 12;
    if (p + 12 > tiff.length) return null;
    if (u16(p) === TAG_ORIENTATION) {
      const valor = u16(p + 8);
      // Só os oito valores do padrão. Um número fora disso é lixo, e reescrevê-lo
      // seria propagar lixo com a nossa assinatura.
      return valor !== null && valor >= 1 && valor <= 8 ? valor : null;
    }
  }
  return null;
}

/** APP1 Exif com uma tag só. 34 bytes, e nada mais. */
function exifApenasComOrientacao(orientacao: number): Buffer {
  const carga = Buffer.alloc(32);
  carga.write("Exif\0\0", 0, "ascii");
  carga.write("II", 6, "ascii");
  carga.writeUInt16LE(0x2a, 8);
  carga.writeUInt32LE(8, 10); // IFD0 começa logo depois do cabeçalho TIFF
  carga.writeUInt16LE(1, 14); // uma entrada
  carga.writeUInt16LE(TAG_ORIENTATION, 16);
  carga.writeUInt16LE(3, 18); // SHORT
  carga.writeUInt32LE(1, 20);
  carga.writeUInt16LE(orientacao, 24);
  carga.writeUInt32LE(0, 28); // não há IFD1 — o thumbnail some junto

  const cabecalho = Buffer.alloc(4);
  cabecalho[0] = 0xff;
  cabecalho[1] = 0xe1;
  cabecalho.writeUInt16BE(carga.length + 2, 2);
  return Buffer.concat([cabecalho, carga]);
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

const PNG_ASSINATURA = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/**
 * PNG não guarda orientação — a especificação não tem essa tag —, então aqui
 * não há nada a reinjetar. Saem o `eXIf` (que pode carregar GPS igualzinho ao
 * do JPEG) e os blocos de texto.
 */
function stripPng(data: Buffer): Buffer {
  if (data.length < 8 || !data.subarray(0, 8).equals(PNG_ASSINATURA)) {
    throw new UnparseableImageError("PNG sem assinatura.");
  }

  const descartar = new Set(["eXIf", "tEXt", "iTXt", "zTXt"]);
  const saida: Buffer[] = [data.subarray(0, 8)];
  let i = 8;

  while (i + 8 <= data.length) {
    const tamanho = data.readUInt32BE(i);
    const tipo = data.toString("ascii", i + 4, i + 8);
    const fim = i + 12 + tamanho; // tamanho + tipo + dados + CRC
    if (fim > data.length) {
      throw new UnparseableImageError("chunk PNG truncado.");
    }
    if (!descartar.has(tipo)) {
      saida.push(data.subarray(i, fim));
    }
    i = fim;
    if (tipo === "IEND") break;
  }

  return Buffer.concat(saida);
}

// ---------------------------------------------------------------------------
// WebP
// ---------------------------------------------------------------------------

/**
 * RIFF, com dois cuidados que o JPEG e o PNG não pedem: o tamanho do contêiner
 * precisa ser reescrito, e o `VP8X` tem BITS que anunciam a existência de EXIF
 * e XMP. Remover os pedaços sem apagar os bits deixaria um arquivo que se
 * descreve errado.
 */
function stripWebp(data: Buffer): Buffer {
  if (
    data.length < 12 ||
    data.toString("ascii", 0, 4) !== "RIFF" ||
    data.toString("ascii", 8, 12) !== "WEBP"
  ) {
    throw new UnparseableImageError("WebP sem cabeçalho RIFF.");
  }

  const descartar = new Set(["EXIF", "XMP "]);
  const pedacos: Buffer[] = [];
  let i = 12;

  while (i + 8 <= data.length) {
    const tamanho = data.readUInt32LE(i + 4);
    const comPadding = tamanho + (tamanho % 2); // RIFF alinha em 2 bytes
    const fim = i + 8 + comPadding;
    if (fim > data.length) {
      throw new UnparseableImageError("chunk WebP truncado.");
    }
    const tipo = data.toString("ascii", i, i + 4);

    if (!descartar.has(tipo)) {
      const bloco = Buffer.from(data.subarray(i, fim));
      if (tipo === "VP8X" && bloco.length >= 9) {
        // Pela especificação: bit 2 = XMP, bit 3 = EXIF. A máscara zera os dois.
        bloco[8] &= ~0b00001100;
      }
      pedacos.push(bloco);
    }
    i = fim;
  }

  const corpo = Buffer.concat(pedacos);
  const cabecalho = Buffer.alloc(12);
  cabecalho.write("RIFF", 0, "ascii");
  cabecalho.writeUInt32LE(corpo.length + 4, 4);
  cabecalho.write("WEBP", 8, "ascii");
  return Buffer.concat([cabecalho, corpo]);
}
