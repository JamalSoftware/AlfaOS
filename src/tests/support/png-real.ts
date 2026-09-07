import { deflateSync } from "node:zlib";

/**
 * Um PNG DECODIFICÁVEL de verdade, montado byte a byte.
 *
 * ## Por que ele precisou existir
 *
 * O `montarJpeg` deste mesmo diretório declara, no próprio docstring, que não
 * precisa ser decodificável — *"nada no AlfaOS decodifica imagem"*. Isso era
 * verdade enquanto o servidor era o único consumidor: a pipeline valida
 * assinatura, tipo e estrutura de contêiner, e nunca abre a imagem.
 *
 * A `CTO-1.7` acrescentou um consumidor que ABRE: o preview. A partir dele,
 * "os bytes chegaram" e "a imagem apareceu" viraram afirmações diferentes, e
 * um fixture que satisfaz a primeira pode falhar a segunda sem que nenhum teste
 * perceba. Foi exatamente assim que a validação humana encontrou um quadro
 * quebrado com a rota respondendo 200.
 *
 * ## Por que PNG, e não JPEG
 *
 * Um JPEG de linha de base exige tabelas de quantização e de Huffman coerentes
 * com o scan — montá-lo à mão é escrever meio codificador. O PNG é
 * estruturalmente simples e o `zlib` do Node fecha a única parte difícil, então
 * o fixture é curto e, principalmente, **verdadeiro**: um decodificador real
 * abre o resultado.
 *
 * Ele também prova uma segunda coisa de graça — que o `Content-Type` servido
 * acompanha o FORMATO. Um `image/jpeg` fixo no código passaria despercebido em
 * qualquer teste que só enviasse JPEG.
 */
export function montarPngReal(largura: number, altura: number): Buffer {
  const assinatura = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(largura, 0);
  ihdr.writeUInt32BE(altura, 4);
  ihdr[8] = 8; // 8 bits por canal
  ihdr[9] = 2; // truecolor RGB
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // filtro adaptativo
  ihdr[12] = 0; // sem entrelace

  /*
    Um gradiente, e não uma cor chapada.

    Cor chapada comprime a quase nada, e dois fixtures de tamanhos diferentes
    podem acabar com o mesmo número de bytes — o que enfraqueceria qualquer
    asserção que compare conteúdo. O gradiente também garante bytes acima de
    0x7f no fluxo comprimido, e é isso que faz o teste de serialização binária
    ter o que provar: uma conversão para string os trocaria por U+FFFD.
  */
  const linhas: Buffer[] = [];
  for (let y = 0; y < altura; y++) {
    const linha = Buffer.alloc(1 + largura * 3);
    linha[0] = 0; // filtro "none"
    for (let x = 0; x < largura; x++) {
      const p = 1 + x * 3;
      linha[p] = (x * 37 + y * 11) & 0xff;
      linha[p + 1] = (x * 5 + y * 97) & 0xff;
      linha[p + 2] = (x * 131 + y * 3) & 0xff;
    }
    linhas.push(linha);
  }

  return Buffer.concat([
    assinatura,
    pedaco("IHDR", ihdr),
    pedaco("IDAT", deflateSync(Buffer.concat(linhas))),
    pedaco("IEND", Buffer.alloc(0)),
  ]);
}

function pedaco(tipo: string, dados: Buffer): Buffer {
  const tamanho = Buffer.alloc(4);
  tamanho.writeUInt32BE(dados.length, 0);
  const corpo = Buffer.concat([Buffer.from(tipo, "ascii"), dados]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(corpo), 0);
  return Buffer.concat([tamanho, corpo, crc]);
}

let tabela: Uint32Array | null = null;
function crc32(buf: Buffer): number {
  if (!tabela) {
    tabela = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      tabela[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = tabela[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Percorre a estrutura do PNG e diz se um decodificador conseguiria abri-lo.
 *
 * INDEPENDENTE do construtor acima: refaz o CRC de cada pedaço por conta
 * própria. Se as duas metades compartilhassem a verificação, um defeito no
 * percurso apareceria dos dois lados e o teste passaria por concordância.
 */
export function lerPng(buf: Buffer): {
  ok: boolean;
  largura: number;
  altura: number;
  pedacos: string[];
  crcOk: boolean;
  sobra: number;
} {
  const assinatura = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const vazio = { ok: false, largura: 0, altura: 0, pedacos: [], crcOk: false, sobra: 0 };
  if (buf.length < 8 || !buf.subarray(0, 8).equals(assinatura)) return vazio;

  let off = 8;
  const pedacos: string[] = [];
  let largura = 0;
  let altura = 0;
  let crcOk = true;
  while (off + 8 <= buf.length) {
    const tamanho = buf.readUInt32BE(off);
    const tipo = buf.subarray(off + 4, off + 8).toString("ascii");
    const fim = off + 8 + tamanho;
    if (fim + 4 > buf.length) return { ...vazio, pedacos };
    pedacos.push(tipo);
    if (tipo === "IHDR") {
      largura = buf.readUInt32BE(off + 8);
      altura = buf.readUInt32BE(off + 12);
    }
    if (buf.readUInt32BE(fim) !== crc32(buf.subarray(off + 4, fim))) crcOk = false;
    off = fim + 4;
    if (tipo === "IEND") break;
  }

  return {
    ok:
      crcOk &&
      pedacos.includes("IHDR") &&
      pedacos.includes("IDAT") &&
      pedacos.includes("IEND") &&
      largura > 0 &&
      altura > 0,
    largura,
    altura,
    pedacos,
    crcOk,
    sobra: buf.length - off,
  };
}
