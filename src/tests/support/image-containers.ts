/**
 * # Contêineres de imagem sintéticos, e leitores PRÓPRIOS (`RC-1E`)
 *
 * Duas metades, e a separação é o ponto:
 *
 * - **montar** — PNG, WebP e JPEG com metadado que a política manda tirar
 *   (EXIF com GPS, XMP, texto, `tIME`, chunk privado, bloco anexado depois do
 *   fim). Tudo sintético: nenhuma foto real, nenhuma coordenada real — a
 *   latitude do fixture é um número inventado.
 * - **ler** — listas de chunks e conferência de CRC e de tamanho RIFF escritas
 *   AQUI, sem importar o sanitizador. Um teste que lê a saída com o mesmo
 *   código que a produziu só prova que o código concorda consigo mesmo.
 */

// ---------------------------------------------------------------------------
// CRC-32 do PNG
// ---------------------------------------------------------------------------

const TABELA_CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = TABELA_CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// EXIF com GPS
// ---------------------------------------------------------------------------

/** Latitude inventada — não é lugar de ninguém. */
export const LATITUDE_SINTETICA = [12, 34, 56];

/**
 * Um bloco TIFF little-endian: IFD0 com `Orientation` (opcional) e o ponteiro
 * da IFD de GPS; a IFD de GPS com `GPSLatitudeRef` e `GPSLatitude`.
 */
export function tiffComGps(orientacao: number | null = null): Buffer {
  const entradasIfd0 = orientacao === null ? 1 : 2;
  const ifd0 = 8;
  const gps = ifd0 + 2 + entradasIfd0 * 12 + 4;
  const racionais = gps + 2 + 2 * 12 + 4;
  const t = Buffer.alloc(racionais + 24);

  t.write("II", 0, "ascii");
  t.writeUInt16LE(42, 2);
  t.writeUInt32LE(ifd0, 4);

  t.writeUInt16LE(entradasIfd0, ifd0);
  let p = ifd0 + 2;
  if (orientacao !== null) {
    t.writeUInt16LE(0x0112, p);
    t.writeUInt16LE(3, p + 2);
    t.writeUInt32LE(1, p + 4);
    t.writeUInt16LE(orientacao, p + 8);
    p += 12;
  }
  t.writeUInt16LE(0x8825, p);
  t.writeUInt16LE(4, p + 2);
  t.writeUInt32LE(1, p + 4);
  t.writeUInt32LE(gps, p + 8);
  t.writeUInt32LE(0, ifd0 + 2 + entradasIfd0 * 12);

  t.writeUInt16LE(2, gps);
  t.writeUInt16LE(0x0001, gps + 2); // GPSLatitudeRef
  t.writeUInt16LE(2, gps + 4);
  t.writeUInt32LE(2, gps + 6);
  t.write("S\0", gps + 10, "ascii");
  t.writeUInt16LE(0x0002, gps + 14); // GPSLatitude
  t.writeUInt16LE(5, gps + 16);
  t.writeUInt32LE(3, gps + 18);
  t.writeUInt32LE(racionais, gps + 22);
  t.writeUInt32LE(0, gps + 26);

  LATITUDE_SINTETICA.forEach((v, k) => {
    t.writeUInt32LE(v, racionais + k * 8);
    t.writeUInt32LE(1, racionais + k * 8 + 4);
  });
  return t;
}

/** A IFD0 do TIFF aponta para uma IFD de GPS? Leitura independente. */
export function tiffTemGps(tiff: Buffer): boolean {
  if (tiff.length < 8 || tiff.toString("ascii", 0, 2) !== "II") return false;
  const ifd0 = tiff.readUInt32LE(4);
  const n = tiff.readUInt16LE(ifd0);
  for (let k = 0; k < n; k++) {
    const p = ifd0 + 2 + k * 12;
    if (tiff.readUInt16LE(p) === 0x8825 && tiff.readUInt32LE(p + 8) !== 0) return true;
  }
  return false;
}

const XMP_COM_GPS = Buffer.from(
  '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:Description exif:GPSLatitude="12,34.9S"/></x:xmpmeta>',
  "utf8",
);

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

export function pngChunk(tipo: string, dados: Buffer): Buffer {
  const tamanho = Buffer.alloc(4);
  tamanho.writeUInt32BE(dados.length, 0);
  const corpo = Buffer.concat([Buffer.from(tipo, "ascii"), dados]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(corpo), 0);
  return Buffer.concat([tamanho, corpo, crc]);
}

export interface ChunkPng {
  tipo: string;
  dados: Buffer;
  crcOk: boolean;
}

/** Os chunks de um PNG, na ordem, e o que sobra depois do IEND. */
export function lerChunksPng(png: Buffer): { chunks: ChunkPng[]; depoisDoIend: number } {
  const chunks: ChunkPng[] = [];
  let i = 8;
  while (i + 12 <= png.length) {
    const tamanho = png.readUInt32BE(i);
    const tipo = png.toString("ascii", i + 4, i + 8);
    const dados = png.subarray(i + 8, i + 8 + tamanho);
    const crc = png.readUInt32BE(i + 8 + tamanho);
    chunks.push({ tipo, dados, crcOk: crc32(png.subarray(i + 4, i + 8 + tamanho)) === crc });
    i += 12 + tamanho;
    if (tipo === "IEND") break;
  }
  return { chunks, depoisDoIend: png.length - i };
}

/**
 * Um PNG com todo metadado que a política manda tirar — e os auxiliares que ela
 * manda manter, para provar que a limpeza não virou "tira tudo".
 */
export function pngComMetadado(base: Buffer): Buffer {
  const { chunks } = lerChunksPng(base);
  const ihdr = chunks.find((c) => c.tipo === "IHDR")!;
  const resto = chunks.filter((c) => c.tipo !== "IHDR" && c.tipo !== "IEND");

  const phys = Buffer.alloc(9);
  phys.writeUInt32BE(2835, 0);
  phys.writeUInt32BE(2835, 4);
  phys[8] = 1;
  const time = Buffer.from([0x07, 0xea, 9, 16, 12, 0, 0]);

  return Buffer.concat([
    base.subarray(0, 8),
    pngChunk("IHDR", ihdr.dados),
    pngChunk("pHYs", phys),
    pngChunk("sRGB", Buffer.from([0])),
    pngChunk("eXIf", tiffComGps()),
    pngChunk("tEXt", Buffer.from("Comment\0lat 12.34 S", "latin1")),
    pngChunk("iTXt", Buffer.concat([Buffer.from("XML:com.adobe.xmp\0\0\0\0\0", "latin1"), XMP_COM_GPS])),
    pngChunk("zTXt", Buffer.from("Author\0\0x", "latin1")),
    pngChunk("tIME", time),
    pngChunk("prVt", Buffer.from("coordenada privada", "utf8")),
    pngChunk("gpSx", Buffer.from("12.34,-56.78", "utf8")),
    ...resto.map((c) => pngChunk(c.tipo, c.dados)),
    pngChunk("IEND", Buffer.alloc(0)),
    // Anexo depois do fim da imagem, com forma de chunk.
    pngChunk("tEXt", Buffer.from("trailer\0depois do IEND", "latin1")),
  ]);
}

// ---------------------------------------------------------------------------
// WebP
// ---------------------------------------------------------------------------

export function riffChunk(tipo: string, dados: Buffer): Buffer {
  const cabecalho = Buffer.alloc(8);
  cabecalho.write(tipo, 0, "ascii");
  cabecalho.writeUInt32LE(dados.length, 4);
  const padding = dados.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0);
  return Buffer.concat([cabecalho, dados, padding]);
}

export function riff(corpo: Buffer): Buffer {
  const cabecalho = Buffer.alloc(12);
  cabecalho.write("RIFF", 0, "ascii");
  cabecalho.writeUInt32LE(corpo.length + 4, 4);
  cabecalho.write("WEBP", 8, "ascii");
  return Buffer.concat([cabecalho, corpo]);
}

export interface LeituraWebp {
  /** Tipos de primeiro nível, na ordem. */
  tipos: string[];
  /** Tipos dentro de cada `ANMF`. */
  quadros: string[][];
  /** O RIFF declara exatamente o tamanho do arquivo. */
  riffCoerente: boolean;
  /** Flags do `VP8X`, quando existe. */
  flagsVp8x: number | null;
}

export function lerWebp(webp: Buffer): LeituraWebp {
  const leitura: LeituraWebp = {
    tipos: [],
    quadros: [],
    riffCoerente: webp.readUInt32LE(4) + 8 === webp.length,
    flagsVp8x: null,
  };
  const percorrer = (inicio: number, fim: number, destino: string[], topo: boolean) => {
    let i = inicio;
    while (i + 8 <= fim) {
      const tipo = webp.toString("ascii", i, i + 4);
      const tamanho = webp.readUInt32LE(i + 4);
      destino.push(tipo);
      if (topo && tipo === "VP8X") leitura.flagsVp8x = webp[i + 8];
      if (topo && tipo === "ANMF") {
        const internos: string[] = [];
        percorrer(i + 8 + 16, i + 8 + tamanho, internos, false);
        leitura.quadros.push(internos);
      }
      i += 8 + tamanho + (tamanho % 2);
    }
  };
  percorrer(12, webp.length, leitura.tipos, true);
  return leitura;
}

/** Bits do `VP8X`: ICC = 0x20, alfa = 0x10, EXIF = 0x08, XMP = 0x04, animação = 0x02. */
export const VP8X = { ICC: 0x20, ALFA: 0x10, EXIF: 0x08, XMP: 0x04, ANIMACAO: 0x02 };

function vp8x(flags: number, largura: number, altura: number): Buffer {
  const d = Buffer.alloc(10);
  d[0] = flags;
  d.writeUIntLE(largura - 1, 4, 3);
  d.writeUIntLE(altura - 1, 7, 3);
  return riffChunk("VP8X", d);
}

/**
 * Um WebP estendido com EXIF (GPS), XMP, chunk desconhecido e um bloco anexado
 * DEPOIS do RIFF. `base` é um WebP simples (`VP8 ` ou `VP8L`), de onde sai o
 * bitstream; `icc` acrescenta um perfil — de mentira, então só para leitura
 * estrutural, nunca para decodificar.
 */
export function webpComMetadado(
  base: Buffer,
  opcoes: { largura: number; altura: number; icc?: boolean },
): Buffer {
  /*
    A base pode ser simples (`VP8 `/`VP8L`) ou já estendida — o WebP que o
    Chromium codifica vem como `VP8X` + `ICCP` + `VP8 `. Os chunks de imagem e
    o perfil da base são reaproveitados, e um único `VP8X` novo os descreve:
    dois `VP8X` no mesmo arquivo não decodificam.
  */
  const fimDaBase = 8 + base.readUInt32LE(4);
  let iccp: Buffer | null = null;
  const imagem: Buffer[] = [];
  let temAlfa = false;
  for (let i = 12; i + 8 <= fimDaBase; ) {
    const tipo = base.toString("ascii", i, i + 4);
    const tamanho = base.readUInt32LE(i + 4);
    const bloco = base.subarray(i, i + 8 + tamanho + (tamanho % 2));
    if (tipo === "ICCP") iccp = bloco;
    if (tipo === "ALPH") temAlfa = true;
    if (tipo === "VP8 " || tipo === "VP8L" || tipo === "ALPH") imagem.push(bloco);
    i += bloco.length;
  }
  if (!iccp && opcoes.icc) iccp = riffChunk("ICCP", Buffer.alloc(24, 0x11));

  const flags =
    VP8X.EXIF | VP8X.XMP | (iccp ? VP8X.ICC : 0) | (temAlfa ? VP8X.ALFA : 0);
  const corpo = Buffer.concat([
    vp8x(flags, opcoes.largura, opcoes.altura),
    ...(iccp ? [iccp] : []),
    ...imagem,
    riffChunk("EXIF", tiffComGps()),
    riffChunk("XMP ", XMP_COM_GPS),
    riffChunk("LOCN", Buffer.from("12.34,-56.78", "utf8")),
  ]);
  return Buffer.concat([
    riff(corpo),
    /*
      Anexo DEPOIS do RIFF declarado, com forma de chunk — e de um tipo
      PERMITIDO. Só um chunk permitido prova o corte no tamanho do RIFF: um
      `EXIF` anexado cairia pela lista de permitidos mesmo que o corte sumisse,
      e o teste passaria sem enxergar a regressão.
    */
    riffChunk("ICCP", Buffer.from("12.34,-56.78", "utf8")),
    riffChunk("EXIF", tiffComGps()),
  ]);
}

/** WebP animado: um `ANMF` com um chunk desconhecido escondido dentro. */
export function webpAnimadoComChunkEscondido(base: Buffer): Buffer {
  const bitstream = base.subarray(12, 8 + base.readUInt32LE(4));
  const cabecalhoQuadro = Buffer.alloc(16);
  const quadro = riffChunk(
    "ANMF",
    Buffer.concat([cabecalhoQuadro, bitstream, riffChunk("EXIF", tiffComGps())]),
  );
  return riff(
    Buffer.concat([
      vp8x(VP8X.ANIMACAO, 1, 1),
      riffChunk("ANIM", Buffer.alloc(6)),
      quadro,
    ]),
  );
}

// ---------------------------------------------------------------------------
// JPEG
// ---------------------------------------------------------------------------

/**
 * Troca os segmentos de aplicação de um JPEG por EXIF (com GPS e,
 * opcionalmente, orientação), XMP e comentário, e anexa um bloco depois do EOI.
 *
 * Os `APPn` da base saem, menos o `APP0`/JFIF: uma base que já tivesse EXIF
 * próprio teria DOIS blocos, e o segundo decidiria a orientação — o fixture
 * estaria testando qual dos dois vence, e não a limpeza.
 */
export function jpegComMetadado(base: Buffer, orientacao: number | null = null): Buffer {
  const segmento = (codigo: number, carga: Buffer): Buffer => {
    const cabecalho = Buffer.from([0xff, codigo, 0, 0]);
    cabecalho.writeUInt16BE(carga.length + 2, 2);
    return Buffer.concat([cabecalho, carga]);
  };
  const mantidos: Buffer[] = [];
  let i = 2;
  while (i + 4 <= base.length && base[i] === 0xff) {
    const codigo = base[i + 1];
    if (!((codigo >= 0xe0 && codigo <= 0xef) || codigo === 0xfe)) break;
    const fim = i + 2 + base.readUInt16BE(i + 2);
    if (codigo === 0xe0 && base.toString("ascii", i + 4, i + 9) === "JFIF\0") {
      mantidos.push(base.subarray(i, fim));
    }
    i = fim;
  }
  const jpeg = Buffer.concat([base.subarray(0, 2), ...mantidos, base.subarray(i)]);
  const exif = segmento(0xe1, Buffer.concat([Buffer.from("Exif\0\0", "ascii"), tiffComGps(orientacao)]));
  const xmp = segmento(
    0xe1,
    Buffer.concat([Buffer.from("http://ns.adobe.com/xap/1.0/\0", "ascii"), XMP_COM_GPS]),
  );
  const comentario = segmento(0xfe, Buffer.from("lat 12.34 S", "ascii"));
  return Buffer.concat([
    jpeg.subarray(0, 2),
    exif,
    xmp,
    comentario,
    jpeg.subarray(2),
    Buffer.from("ftypmp42 moov udta xyz +12.34-056.78", "ascii"),
  ]);
}
