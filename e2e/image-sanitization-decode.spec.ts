import { test, expect, type Page } from "@playwright/test";
import { stripImageMetadata } from "../src/lib/media/image-metadata";
import { inspectStoredImage } from "../src/lib/media/image-inspection";
import {
  jpegComMetadado,
  lerChunksPng,
  lerWebp,
  pngComMetadado,
  webpComMetadado,
} from "../src/tests/support/image-containers";
import { montarPngReal } from "../src/tests/support/png-real";

/**
 * # RC-1E · a imagem limpa ABRE — num decodificador de verdade
 *
 * Os testes de Vitest provam a ESTRUTURA da saída com leitores próprios. Eles
 * não provam que a imagem aparece: "os chunks estão certos" e "o navegador
 * desenha" são afirmações diferentes, e foi a diferença entre as duas que
 * escondeu a foto quebrada da `CTO-1.8`.
 *
 * Aqui o JPEG e o WebP de partida são codificados PELO PRÓPRIO Chromium
 * (`canvas.toDataURL`), o PNG é o `montarPngReal` — nenhum fixture de mentira,
 * nenhuma dependência nova. Cada um ganha o metadado que a política manda
 * tirar, passa pelo sanitizador, e volta ao navegador para ser decodificado.
 * A entrada suja também é decodificada, como CONTROLE: sem ela, uma saída que
 * abre poderia só significar que o fixture já abria por acaso.
 *
 * Sem login e sem rota: a página é `setContent`. O que está em teste é o
 * byte, não o servidor.
 */

const LARGURA = 40;
const ALTURA = 20;

async function codificarNoNavegador(page: Page, mime: string): Promise<Buffer> {
  const dataUrl = await page.evaluate(
    ({ mime, largura, altura }) => {
      const canvas = document.createElement("canvas");
      canvas.width = largura;
      canvas.height = altura;
      const ctx = canvas.getContext("2d")!;
      const g = ctx.createLinearGradient(0, 0, largura, altura);
      g.addColorStop(0, "#1d4ed8");
      g.addColorStop(1, "#f59e0b");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, largura, altura);
      return canvas.toDataURL(mime, 0.9);
    },
    { mime, largura: LARGURA, altura: ALTURA },
  );
  expect(dataUrl.startsWith(`data:${mime};base64,`), `o Chromium codificou ${mime}`).toBe(true);
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
}

/** Decodifica no navegador. `null` quando a imagem não abre. */
async function decodificar(
  page: Page,
  bytes: Buffer,
  mime: string,
): Promise<{ largura: number; altura: number } | null> {
  return page.evaluate(
    async ({ base64, mime }) => {
      const img = new Image();
      img.src = `data:${mime};base64,${base64}`;
      try {
        await img.decode();
      } catch {
        return null;
      }
      return img.naturalWidth > 0
        ? { largura: img.naturalWidth, altura: img.naturalHeight }
        : null;
    },
    { base64: bytes.toString("base64"), mime },
  );
}

test.beforeEach(async ({ page }) => {
  await page.setContent("<!doctype html><title>decodificação</title>");
});

test("DECODE-JPEG · JPEG com EXIF/GPS, XMP e anexo: a saída limpa abre com as mesmas dimensões", async ({
  page,
}) => {
  const base = await codificarNoNavegador(page, "image/jpeg");
  const sujo = jpegComMetadado(base, 1);
  const limpo = stripImageMetadata(sujo, "image/jpeg");

  expect(inspectStoredImage(sujo, "image/jpeg").hasGps).toBe(true);
  expect(inspectStoredImage(limpo, "image/jpeg")).toEqual({
    parseable: true,
    needsSanitization: false,
    hasGps: false,
  });
  expect(await decodificar(page, sujo, "image/jpeg")).toEqual({ largura: LARGURA, altura: ALTURA });
  expect(await decodificar(page, limpo, "image/jpeg")).toEqual({ largura: LARGURA, altura: ALTURA });
});

test("DECODE-JPEG-ORIENTATION · a orientação sobrevive à limpeza — a foto não deita", async ({
  page,
}) => {
  /*
    O AlfaOS não gira pixel: é a tag `Orientation` que endireita a foto na
    tela, e a limpeza a reinjeta. Com orientação 6 o navegador troca largura e
    altura. Se a limpeza a perdesse, a foto de retrato apareceria deitada — e o
    teste veria 40×20 em vez de 20×40.
  */
  const base = await codificarNoNavegador(page, "image/jpeg");
  const limpoReto = stripImageMetadata(jpegComMetadado(base, 1), "image/jpeg");
  const limpoGirado = stripImageMetadata(jpegComMetadado(base, 6), "image/jpeg");

  expect(await decodificar(page, limpoReto, "image/jpeg")).toEqual({ largura: LARGURA, altura: ALTURA });
  expect(await decodificar(page, limpoGirado, "image/jpeg")).toEqual({
    largura: ALTURA,
    altura: LARGURA,
  });
});

test("DECODE-JPEG-MULTI-EXIF · com dois blocos EXIF, a orientação do PRIMEIRO sobrevive — e o GPS do segundo não", async ({
  page,
}) => {
  /*
    `RC-IMG-DEBT` (`RC-1`, débito §12). Câmera e editor deixam dois `APP1` Exif
    no mesmo arquivo. A limpeza sobrescrevia a orientação a cada bloco: o
    segundo, SEM a tag, apagava a do primeiro, e a foto de retrato aparecia
    deitada. Aqui isso é medido onde importa — num JPEG REAL, decodificado pelo
    Chromium, com as dimensões trocadas provando que a tag sobreviveu.
  */
  const base = await codificarNoNavegador(page, "image/jpeg");
  const primeiro = jpegComMetadado(base, 6);
  const segundo = jpegComMetadado(base, null);

  // O `APP1` Exif do segundo arquivo, enxertado depois do Exif do primeiro.
  const exifDoSegundo = (() => {
    let i = 2;
    while (i + 3 < segundo.length) {
      const codigo = segundo[i + 1];
      if (codigo === 0xda || codigo === 0xd9) break;
      const tamanho = segundo.readUInt16BE(i + 2);
      const carga = segundo.subarray(i + 4, i + 2 + tamanho);
      if (codigo === 0xe1 && carga.subarray(0, 6).toString("ascii") === "Exif\0\0") {
        return Buffer.from(segundo.subarray(i, i + 2 + tamanho));
      }
      i += 2 + tamanho;
    }
    throw new Error("fixture sem APP1 Exif");
  })();

  let corte = 2;
  while (corte + 3 < primeiro.length) {
    const codigo = primeiro[corte + 1];
    const tamanho = primeiro.readUInt16BE(corte + 2);
    const carga = primeiro.subarray(corte + 4, corte + 2 + tamanho);
    if (codigo === 0xe1 && carga.subarray(0, 6).toString("ascii") === "Exif\0\0") {
      corte = corte + 2 + tamanho;
      break;
    }
    corte += 2 + tamanho;
  }
  const doisBlocos = Buffer.concat([
    primeiro.subarray(0, corte),
    exifDoSegundo,
    primeiro.subarray(corte),
  ]);

  const limpo = stripImageMetadata(doisBlocos, "image/jpeg");
  expect(inspectStoredImage(limpo, "image/jpeg").hasGps).toBe(false);
  // Orientação 6 preservada: o navegador troca largura e altura.
  expect(await decodificar(page, limpo, "image/jpeg")).toEqual({
    largura: ALTURA,
    altura: LARGURA,
  });
});

test("DECODE-PNG · PNG com eXIf, texto, tIME, chunk privado e anexo: a saída limpa abre", async ({
  page,
}) => {
  const sujo = pngComMetadado(montarPngReal(LARGURA, ALTURA));
  const limpo = stripImageMetadata(sujo, "image/png");

  expect(lerChunksPng(limpo).chunks.map((c) => c.tipo)).toEqual(["IHDR", "pHYs", "sRGB", "IDAT", "IEND"]);
  expect(await decodificar(page, sujo, "image/png")).toEqual({ largura: LARGURA, altura: ALTURA });
  expect(await decodificar(page, limpo, "image/png")).toEqual({ largura: LARGURA, altura: ALTURA });
});

test("DECODE-WEBP · WebP estendido com EXIF/GPS, XMP, chunk desconhecido e anexo: a saída limpa abre", async ({
  page,
}) => {
  const base = await codificarNoNavegador(page, "image/webp");
  const sujo = webpComMetadado(base, { largura: LARGURA, altura: ALTURA });
  const limpo = stripImageMetadata(sujo, "image/webp");
  const leitura = lerWebp(limpo);

  expect(leitura.tipos[0]).toBe("VP8X");
  expect(leitura.tipos).not.toContain("EXIF");
  expect(leitura.tipos).not.toContain("XMP ");
  expect(leitura.tipos).not.toContain("LOCN");
  expect(leitura.riffCoerente).toBe(true);
  expect(await decodificar(page, sujo, "image/webp")).toEqual({ largura: LARGURA, altura: ALTURA });
  expect(await decodificar(page, limpo, "image/webp")).toEqual({ largura: LARGURA, altura: ALTURA });
});
