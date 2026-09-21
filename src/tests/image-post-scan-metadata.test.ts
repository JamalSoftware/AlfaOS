/**
 * # `SEC-004` · metadado DEPOIS dos dados de scan
 *
 * ## O achado
 *
 * A revisão de segurança independente provou que EXIF com GPS colocado **antes**
 * do `SOS` era removido e o mesmo bloco colocado **depois** sobrevivia intacto —
 * e que `inspectStoredImage` também parava no `SOS`, então a auditoria de
 * storage declarava o arquivo forjado LIMPO. Duas afirmações erradas de uma vez:
 * o sanitizador não tirava, e o inspetor dizia que não havia nada para tirar.
 *
 * ## Por que o arquivo forjado é válido
 *
 * A gramática do JPEG permite segmentos depois de um scan: é assim que um JPEG
 * progressivo encadeia varreduras, e um decodificador de verdade continua
 * lendo dali. Não é arquivo corrompido que ninguém abre — é arquivo que abre e
 * carrega coordenada.
 *
 * ## O que este arquivo fixa
 *
 * O sanitizador e o inspetor usam a MESMA definição estrutural, e ela conhece
 * três coisas que separam um marcador de um byte de dados: `FF 00` (0xFF
 * escapado), `RST0`–`RST7` (reinício, que vive dentro do scan) e o
 * preenchimento `FF FF`. Um percurso que trate qualquer `FF` como fronteira
 * corta a imagem no meio; um que trate nenhum deixa o metadado passar.
 */
import { describe, expect, it } from "vitest";
import { stripImageMetadata } from "@/lib/media/image-metadata";
import { inspectStoredImage } from "@/lib/media/image-inspection";
import {
  jpegComMetadadoDepoisDoScan,
  lerSegmentosJpeg,
  scanComEscapes,
  segmentoJpeg,
  tiffComGps,
  tiffOrientacao,
  tiffTemGps,
} from "./support/image-containers";

const APP1 = 0xe1;
const COM = 0xfe;
const APP13 = 0xed;
const SOS = 0xda;
const EOI = 0xd9;

/** Os blocos Exif que sobraram na saída, lidos com o leitor próprio. */
function exifDaSaida(jpeg: Buffer): Buffer[] {
  return lerSegmentosJpeg(jpeg)
    .filter(
      (s) =>
        s.codigo === APP1 && s.carga.subarray(0, 6).toString("ascii") === "Exif\0\0",
    )
    .map((s) => s.carga.subarray(6));
}

describe("SEC-004 · o metadado depois do scan sai", () => {
  it("EXIF com GPS depois do scan é removido", () => {
    const sujo = jpegComMetadadoDepoisDoScan();
    // A entrada de fato carrega GPS depois do scan — sem isto o teste não
    // estaria provando nada.
    expect(exifDaSaida(sujo).some(tiffTemGps)).toBe(true);

    const limpo = stripImageMetadata(sujo, "image/jpeg");

    expect(exifDaSaida(limpo).some(tiffTemGps)).toBe(false);
    expect(limpo.includes(Buffer.from("Exif\0\0", "ascii"))).toBe(false);
  });

  it("XMP, comentário e IPTC depois do scan são removidos", () => {
    const limpo = stripImageMetadata(jpegComMetadadoDepoisDoScan(), "image/jpeg");
    const codigos = lerSegmentosJpeg(limpo).map((s) => s.codigo);

    expect(codigos).not.toContain(COM);
    expect(codigos).not.toContain(APP13);
    expect(limpo.includes(Buffer.from("script", "ascii"))).toBe(false);
    expect(limpo.includes(Buffer.from("Photoshop", "ascii"))).toBe(false);
    expect(limpo.includes(Buffer.from("ns.adobe.com", "ascii"))).toBe(false);
  });

  it("o trailer depois do EOI continua saindo", () => {
    const limpo = stripImageMetadata(jpegComMetadadoDepoisDoScan(), "image/jpeg");
    expect(limpo.includes(Buffer.from("ftypmp42", "ascii"))).toBe(false);
    expect(limpo.includes(Buffer.from("moov", "ascii"))).toBe(false);
  });

  it("os dados de scan atravessam byte a byte: FF 00, RST e preenchimento", () => {
    const sujo = jpegComMetadadoDepoisDoScan();
    const limpo = stripImageMetadata(sujo, "image/jpeg");

    // O scan da entrada tem de sair inteiro do outro lado. Se o percurso
    // tratasse `FF 00` ou `RST` como fronteira, ele cortaria aqui.
    const scan = scanComEscapes();
    expect(limpo.includes(scan)).toBe(true);
  });

  it("o EOI sobrevive: a imagem continua fechando", () => {
    const limpo = stripImageMetadata(jpegComMetadadoDepoisDoScan(), "image/jpeg");
    expect(limpo[limpo.length - 2]).toBe(0xff);
    expect(limpo[limpo.length - 1]).toBe(0xd9);
  });

  it("a orientação do Exif LEGÍTIMO, antes do scan, é preservada", () => {
    const limpo = stripImageMetadata(jpegComMetadadoDepoisDoScan(6), "image/jpeg");
    const blocos = exifDaSaida(limpo);

    expect(blocos).toHaveLength(1);
    expect(blocos.some(tiffTemGps)).toBe(false);
    expect(tiffOrientacao(blocos[0])).toBe(6);
  });

  it("a orientação de um Exif que só existe DEPOIS do scan não é aproveitada", () => {
    /*
      A posição importa. Um decodificador honra o primeiro `APP1` Exif depois do
      `SOI`; um bloco depois do scan não é a Exif da imagem. Aproveitar a
      orientação dali deixaria quem forja o arquivo escolher como a foto aparece
      — e reinjetá-la na frente faria o AlfaOS afirmar, com a própria
      assinatura, algo que a câmera não disse.
    */
    const limpo = stripImageMetadata(jpegComMetadadoDepoisDoScan(null), "image/jpeg");
    expect(exifDaSaida(limpo)).toHaveLength(0);
  });

  it("um JPEG progressivo com metadado ENTRE varreduras é limpo nas duas", () => {
    const varredura = () =>
      Buffer.concat([segmentoJpeg(SOS, Buffer.from([0x01, 0x01, 0x00])), scanComEscapes()]);
    const exifComGps = () =>
      segmentoJpeg(APP1, Buffer.concat([Buffer.from("Exif\0\0", "ascii"), tiffComGps(null)]));

    const sujo = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      varredura(),
      exifComGps(),
      varredura(),
      segmentoJpeg(COM, Buffer.from("entre varreduras", "ascii")),
      varredura(),
      Buffer.from([0xff, EOI]),
    ]);

    const limpo = stripImageMetadata(sujo, "image/jpeg");

    expect(exifDaSaida(limpo).some(tiffTemGps)).toBe(false);
    expect(limpo.includes(Buffer.from("entre varreduras", "ascii"))).toBe(false);
    // As três varreduras continuam lá: limpar não é jogar imagem fora.
    expect(lerSegmentosJpeg(limpo).filter((s) => s.codigo === SOS)).toHaveLength(3);
  });

  it("um segmento estrutural depois do scan é PRESERVADO (DHT entre varreduras)", () => {
    /*
      A recusa é da lista de metadado, não de "tudo o que vem depois do scan".
      Tabelas de Huffman entre varreduras são normais num JPEG progressivo, e
      jogá-las fora produziria um arquivo que não decodifica.
    */
    const DHT = 0xc4;
    const tabela = segmentoJpeg(DHT, Buffer.from([0x00, 0x01, 0x02, 0x03]));
    const sujo = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      segmentoJpeg(SOS, Buffer.from([0x01])),
      scanComEscapes(),
      tabela,
      segmentoJpeg(SOS, Buffer.from([0x01])),
      scanComEscapes(),
      Buffer.from([0xff, EOI]),
    ]);

    const limpo = stripImageMetadata(sujo, "image/jpeg");
    expect(limpo.includes(tabela)).toBe(true);
  });
});

describe("SEC-004 · o inspetor concorda com o sanitizador", () => {
  it("o arquivo forjado NÃO é declarado limpo", () => {
    const sujo = jpegComMetadadoDepoisDoScan();
    const inspecao = inspectStoredImage(sujo, "image/jpeg");

    expect(inspecao.parseable).toBe(true);
    expect(inspecao.needsSanitization).toBe(true);
    expect(inspecao.hasGps).toBe(true);
  });

  it("depois de limpo, o mesmo arquivo é declarado limpo", () => {
    const limpo = stripImageMetadata(jpegComMetadadoDepoisDoScan(), "image/jpeg");
    expect(inspectStoredImage(limpo, "image/jpeg")).toEqual({
      parseable: true,
      needsSanitization: false,
      hasGps: false,
    });
  });

  it("um arquivo que o sanitizador MUDARIA nunca é declarado limpo", () => {
    /*
      A propriedade que fecha o furo do §14, afirmada sobre os dois lados ao
      mesmo tempo: qualquer entrada que a política mudaria precisa aparecer no
      relatório. A afirmação vale para o conjunto de vetores, e não para um.
    */
    const vetores: [string, Buffer][] = [
      ["metadado depois do scan", jpegComMetadadoDepoisDoScan()],
      ["metadado depois do scan, com orientação", jpegComMetadadoDepoisDoScan(6)],
      [
        "só um comentário depois do scan",
        Buffer.concat([
          Buffer.from([0xff, 0xd8]),
          segmentoJpeg(SOS, Buffer.from([0x01])),
          scanComEscapes(),
          segmentoJpeg(COM, Buffer.from("oi", "ascii")),
          Buffer.from([0xff, EOI]),
        ]),
      ],
    ];

    for (const [rotulo, bytes] of vetores) {
      const mudaria = !stripImageMetadata(bytes, "image/jpeg").equals(bytes);
      const inspecao = inspectStoredImage(bytes, "image/jpeg");
      expect(mudaria, rotulo).toBe(true);
      expect(inspecao.needsSanitization, rotulo).toBe(true);
    }
  });
});
