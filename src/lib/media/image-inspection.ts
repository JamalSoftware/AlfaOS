import {
  percorrerJpeg,
  stripImageMetadata,
  UnparseableImageError,
} from "./image-metadata";

/**
 * # O que uma imagem JÁ GRAVADA ainda carrega (`RC-1E`)
 *
 * A limpeza de metadado (`PC-1`, `EXIF-01`) roda no UPLOAD. Foto gravada antes
 * dela — ou antes de a limpeza de PNG e WebP virar lista de permitidos —
 * continua com os bytes de então. Esta inspeção responde, sobre um arquivo que
 * já está no storage, duas perguntas que a auditoria precisa separar:
 *
 * - **precisa de limpeza?** — a política atual mudaria estes bytes;
 * - **tem GPS?** — há um bloco EXIF com o ponteiro da IFD de GPS preenchido.
 *
 * A primeira é a que decide a re-sanitização; a segunda é a que dá gravidade
 * ao relatório, e é por isso que ela lê a ESTRUTURA do EXIF em vez de procurar
 * texto nos bytes: "GPS" escrito num comentário não é coordenada, e coordenada
 * não precisa conter a palavra "GPS".
 *
 * **Só lê.** Nenhum byte é escrito, e a inspeção nunca devolve a imagem.
 */

export interface ImageInspection {
  /** A estrutura do contêiner fecha. `false` é arquivo corrompido ou estranho. */
  parseable: boolean;
  /** A política de limpeza ATUAL mudaria estes bytes. */
  needsSanitization: boolean;
  /** Existe EXIF com a IFD de GPS apontada. */
  hasGps: boolean;
}

const TAG_GPS_IFD_POINTER = 0x8825;

export function inspectStoredImage(data: Buffer, mimeType: string): ImageInspection {
  let limpo: Buffer;
  try {
    limpo = stripImageMetadata(data, mimeType);
  } catch (error) {
    if (error instanceof UnparseableImageError) {
      return { parseable: false, needsSanitization: false, hasGps: false };
    }
    throw error;
  }
  return {
    parseable: true,
    needsSanitization: !limpo.equals(data),
    hasGps: blocosExif(data, mimeType).some(temPonteiroDeGps),
  };
}

/**
 * Os blocos TIFF de EXIF que o contêiner carrega, sem confiar em nada deles.
 *
 * Só é alcançado DEPOIS de [stripImageMetadata] ter aceitado o arquivo, e a
 * ordem é parte da proteção (`SEC-002`): os percursos de PNG e de WebP daqui
 * procuram um chunk específico e não têm orçamento próprio, então é a recusa do
 * sanitizador que impede uma enxurrada de chunks forjados de ser percorrida
 * duas vezes. Inverter a ordem devolveria o custo.
 */
function blocosExif(data: Buffer, mimeType: string): Buffer[] {
  switch (mimeType) {
    case "image/jpeg":
      return exifDoJpeg(data);
    case "image/png":
      return exifDoPng(data);
    case "image/webp":
      return exifDoWebp(data);
    default:
      return [];
  }
}

/**
 * Os blocos Exif de um JPEG — pelo MESMO percurso do sanitizador (`SEC-004`).
 *
 * A versão anterior tinha um percurso próprio, e ele parava no `SOS`. O
 * resultado é que um arquivo com EXIF depois dos dados de scan atravessava a
 * limpeza **e** era declarado limpo pela auditoria de storage: o sanitizador
 * não tirava, e o inspetor dizia que não havia nada para tirar. Duas
 * afirmações erradas com a mesma causa — dois percursos respondendo à mesma
 * pergunta.
 *
 * Agora quem decide o que é um segmento é [percorrerJpeg], e os dois lados
 * herdam a resposta. É por isso que `needsSanitization` e `hasGps` não têm como
 * discordar sobre a POSIÇÃO de um bloco.
 */
function exifDoJpeg(data: Buffer): Buffer[] {
  const blocos: Buffer[] = [];
  for (const unidade of percorrerJpeg(data)) {
    if (
      unidade.tipo === "segmento" &&
      unidade.codigo === 0xe1 &&
      unidade.carga.subarray(0, 6).toString("ascii") === "Exif\0\0"
    ) {
      blocos.push(unidade.carga.subarray(6));
    }
  }
  return blocos;
}

function exifDoPng(data: Buffer): Buffer[] {
  const blocos: Buffer[] = [];
  let i = 8;
  while (i + 8 <= data.length) {
    const tamanho = data.readUInt32BE(i);
    const tipo = data.toString("ascii", i + 4, i + 8);
    if (i + 12 + tamanho > data.length) break;
    if (tipo === "eXIf") blocos.push(data.subarray(i + 8, i + 8 + tamanho));
    i += 12 + tamanho;
    if (tipo === "IEND") break;
  }
  return blocos;
}

function exifDoWebp(data: Buffer): Buffer[] {
  const blocos: Buffer[] = [];
  const percorrer = (inicio: number, fim: number): void => {
    let i = inicio;
    while (i + 8 <= fim) {
      const tipo = data.toString("ascii", i, i + 4);
      const tamanho = data.readUInt32LE(i + 4);
      const termino = i + 8 + tamanho + (tamanho % 2);
      if (i + 8 + tamanho > data.length) break;
      if (tipo === "EXIF") {
        const carga = data.subarray(i + 8, i + 8 + tamanho);
        // Alguns codificadores repetem o prefixo do JPEG antes do TIFF.
        blocos.push(
          carga.subarray(0, 6).toString("ascii") === "Exif\0\0" ? carga.subarray(6) : carga,
        );
      }
      if (tipo === "ANMF" && tamanho > 16) {
        percorrer(i + 8 + 16, Math.min(i + 8 + tamanho, data.length));
      }
      i = termino;
    }
  };
  // O arquivo inteiro, e não só o RIFF declarado: o que está anexado depois
  // também é o que a auditoria precisa enxergar.
  percorrer(12, data.length);
  return blocos;
}

/** A IFD0 tem a tag 0x8825 com um ponteiro diferente de zero? */
function temPonteiroDeGps(tiff: Buffer): boolean {
  if (tiff.length < 8) return false;
  const ordem = tiff.toString("ascii", 0, 2);
  if (ordem !== "II" && ordem !== "MM") return false;
  const little = ordem === "II";
  const u16 = (p: number) => (little ? tiff.readUInt16LE(p) : tiff.readUInt16BE(p));
  const u32 = (p: number) => (little ? tiff.readUInt32LE(p) : tiff.readUInt32BE(p));

  const ifd0 = u32(4);
  if (ifd0 + 2 > tiff.length) return false;
  const entradas = u16(ifd0);
  for (let k = 0; k < entradas; k++) {
    const p = ifd0 + 2 + k * 12;
    if (p + 12 > tiff.length) return false;
    if (u16(p) === TAG_GPS_IFD_POINTER) {
      return u32(p + 8) !== 0;
    }
  }
  return false;
}
