import { describe, expect, it } from "vitest";
import { stripImageMetadata } from "@/lib/media/image-metadata";
import { lerExif, montarJpeg } from "./support/jpeg-exif";

/**
 * # `RC-IMG-DEBT` — JPEG com MAIS DE UM bloco EXIF (`RC-1`, débito §12)
 *
 * A limpeza remove todo metadado e reinjeta uma tag só: `Orientation`. Ela é
 * preservada porque o AlfaOS **não decodifica** a imagem — é essa tag que
 * endireita a foto no navegador, e perdê-la deita a evidência.
 *
 * O defeito: a orientação era sobrescrita a cada `APP1` Exif encontrado. Num
 * arquivo com dois blocos — que câmeras e editores produzem —, se o PRIMEIRO
 * tinha `Orientation` e o segundo não, o segundo apagava o valor do primeiro e
 * a foto aparecia deitada. Perde-se o que a limpeza existia para guardar.
 *
 * ## A política, e por que é o PRIMEIRO
 *
 * Vence o primeiro `Orientation` válido do arquivo. É o que um decodificador
 * faz: o Exif do JPEG é, por especificação, o primeiro `APP1` depois do `SOI`,
 * e é ele que o navegador lê. Vencer o último significaria girar a foto de um
 * jeito que nenhum leitor concorda — e "o último que aparecer" nem é
 * determinístico do ponto de vista de quem escreveu o arquivo.
 *
 * Um bloco posterior SEM a tag não apaga nada: ausência não é decisão.
 */

/** O segmento `APP1` Exif inteiro (marcador, tamanho e carga) de um JPEG. */
function extrairExif(jpeg: Buffer): Buffer {
  let i = 2;
  while (i + 3 < jpeg.length) {
    if (jpeg[i] !== 0xff) throw new Error("fixture sem marcador onde deveria");
    const codigo = jpeg[i + 1];
    if (codigo === 0xda || codigo === 0xd9) break;
    const tamanho = jpeg.readUInt16BE(i + 2);
    const carga = jpeg.subarray(i + 4, i + 2 + tamanho);
    if (codigo === 0xe1 && carga.subarray(0, 6).toString("ascii") === "Exif\0\0") {
      return Buffer.from(jpeg.subarray(i, i + 2 + tamanho));
    }
    i += 2 + tamanho;
  }
  throw new Error("fixture sem APP1 Exif");
}

/** Insere `extra` logo DEPOIS do primeiro `APP1` Exif de `base`. */
function comSegundoExif(base: Buffer, extra: Buffer): Buffer {
  let i = 2;
  while (i + 3 < base.length) {
    const codigo = base[i + 1];
    if (codigo === 0xda || codigo === 0xd9) break;
    const tamanho = base.readUInt16BE(i + 2);
    const fim = i + 2 + tamanho;
    const carga = base.subarray(i + 4, fim);
    if (codigo === 0xe1 && carga.subarray(0, 6).toString("ascii") === "Exif\0\0") {
      return Buffer.concat([base.subarray(0, fim), extra, base.subarray(fim)]);
    }
    i = fim;
  }
  throw new Error("base sem APP1 Exif");
}

const limpar = (jpeg: Buffer) => stripImageMetadata(jpeg, "image/jpeg");

describe("RC-IMG — dois blocos EXIF no mesmo JPEG", () => {
  it("RC-IMG-01 · o segundo bloco SEM orientação não apaga a do primeiro", () => {
    const entrada = comSegundoExif(
      montarJpeg({ orientacao: 6, comGps: false }),
      extrairExif(montarJpeg({ orientacao: null, comGps: false })),
    );
    // A entrada tem mesmo os dois blocos — senão o teste não testa nada.
    expect(entrada.toString("latin1").split("Exif\0\0").length - 1).toBe(2);

    const saida = lerExif(limpar(entrada));
    expect(saida.orientacao).toBe(6);
    expect(saida.tagsGps).toEqual([]);
  });

  it("RC-IMG-02 · com o primeiro sem a tag, vale a orientação do segundo", () => {
    const entrada = comSegundoExif(
      montarJpeg({ orientacao: null, comGps: false }),
      extrairExif(montarJpeg({ orientacao: 3, comGps: false })),
    );

    const saida = lerExif(limpar(entrada));
    expect(saida.orientacao).toBe(3);
  });

  it("RC-IMG-03 · em conflito, vence o PRIMEIRO — e a regra é determinística", () => {
    const entrada = comSegundoExif(
      montarJpeg({ orientacao: 6, comGps: false }),
      extrairExif(montarJpeg({ orientacao: 3, comGps: false })),
    );

    const primeira = lerExif(limpar(entrada)).orientacao;
    expect(primeira).toBe(6);
    // Determinístico: a mesma entrada dá a mesma saída, byte a byte.
    expect(limpar(entrada).equals(limpar(entrada))).toBe(true);
  });

  it("RC-IMG-04 · GPS no SEGUNDO bloco também sai", () => {
    /*
      O bloco que carrega a coordenada não é necessariamente o primeiro. Um
      editor que reescreve o arquivo acrescenta o seu e mantém o da câmera.
    */
    const entrada = comSegundoExif(
      montarJpeg({ orientacao: 6, comGps: false }),
      extrairExif(montarJpeg({ orientacao: null, comGps: true })),
    );
    expect(lerExif(entrada).tagsGps.length).toBeGreaterThan(0);

    const saida = lerExif(limpar(entrada));
    expect(saida.tagsGps).toEqual([]);
    expect(saida.orientacao).toBe(6);
  });

  it("RC-IMG-05 · a saída continua com UM bloco Exif só, e sem XMP", () => {
    const entrada = comSegundoExif(
      montarJpeg({ orientacao: 6, comGps: true, comXmp: true }),
      extrairExif(montarJpeg({ orientacao: 8, comGps: true })),
    );

    const limpa = limpar(entrada);
    expect(limpa.toString("latin1").split("Exif\0\0").length - 1).toBe(1);
    const saida = lerExif(limpa);
    expect(saida.temXmp).toBe(false);
    expect(saida.orientacao).toBe(6);
  });
});
