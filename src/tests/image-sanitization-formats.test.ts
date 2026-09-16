import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { DomainError } from "@/lib/errors";
import { processImageUpload, sniffImageMime } from "@/lib/media/image-upload";
import { inspectStoredImage } from "@/lib/media/image-inspection";
import { LocalFileStorageAdapter, MIME_EXTENSIONS, setFileStorage } from "@/lib/storage";
import { addEvidence } from "@/lib/service-order-closing";
import { startServiceOrder } from "@/lib/service-orders";
import { allocateTestServiceOrderNumber, seedTestData, type TestFixture } from "./helpers";
import { lerExif, montarJpegSimples } from "./support/jpeg-exif";
import { montarPngReal } from "./support/png-real";
import {
  jpegComMetadado,
  lerChunksPng,
  lerWebp,
  pngComMetadado,
  riff,
  riffChunk,
  VP8X,
  webpAnimadoComChunkEscondido,
  webpComMetadado,
} from "./support/image-containers";

/**
 * # RC-1E · a limpeza é a mesma nos três formatos aceitos
 *
 * O AlfaOS aceita JPEG, PNG e WebP (`MIME_EXTENSIONS`). O JPEG ganhou lista de
 * PERMITIDOS no `PC-1`; PNG e WebP ficaram com lista de proibidos, e a `RC-1A`
 * registrou o furo (`RC-EXIF-09`): chunk privado, `tIME` e bloco anexado depois
 * do RIFF atravessavam. Estes testes leem a saída com leitores PRÓPRIOS
 * (`support/image-containers.ts`), não com o sanitizador.
 *
 * Que a saída DECODIFICA é provado num navegador de verdade:
 * `e2e/image-sanitization-decode.spec.ts`.
 */

/** WebP lossless 1×1 real (o mesmo que navegadores usam para detectar suporte). */
const WEBP_VP8L_1X1 = Buffer.from("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==", "base64");

const POLITICA = {
  maxBytes: 5 * 1024 * 1024,
  messages: {
    empty: "vazio",
    tooLarge: "grande",
    notAnImage: "não é imagem",
    unsupportedType: "tipo não suportado",
    unparseable: "corrompido",
  },
};

function recusa(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).status).toBe(400);
    return (error as Error).message;
  }
  throw new Error("era para recusar");
}

describe("PHOTO-NEW-01 · JPEG com EXIF/GPS sai sem metadado proibido", () => {
  it("GPS, XMP, comentário e o anexo depois do EOI saem; a orientação fica", () => {
    const entrada = jpegComMetadado(montarJpegSimples(), 6);
    // Controle: a entrada TEM o que a limpeza precisa tirar.
    expect(lerExif(entrada).tagsGps.length).toBeGreaterThan(0);
    expect(inspectStoredImage(entrada, "image/jpeg")).toEqual({
      parseable: true,
      needsSanitization: true,
      hasGps: true,
    });

    const { data, mimeType } = processImageUpload(entrada, "image/jpeg", POLITICA);
    const leitura = lerExif(data);

    expect(mimeType).toBe("image/jpeg");
    expect(sniffImageMime(data)).toBe("image/jpeg");
    expect(leitura.tagsGps).toEqual([]);
    expect(leitura.temXmp).toBe(false);
    expect(leitura.segmentos).not.toContain(0xfe);
    expect(leitura.orientacao).toBe(6);
    // Termina no EOI: nada anexado sobreviveu.
    expect(data.subarray(-2).toString("hex")).toBe("ffd9");
    expect(inspectStoredImage(data, "image/jpeg")).toEqual({
      parseable: true,
      needsSanitization: false,
      hasGps: false,
    });
  });
});

describe("PHOTO-NEW-02 · PNG: só o que a imagem precisa para aparecer", () => {
  it("eXIf, texto, tIME, chunk privado, desconhecido e anexo saem; pHYs e sRGB ficam", () => {
    const entrada = pngComMetadado(montarPngReal(4, 3));
    expect(inspectStoredImage(entrada, "image/png").hasGps).toBe(true);

    const { data, mimeType } = processImageUpload(entrada, "image/png", POLITICA);
    const { chunks, depoisDoIend } = lerChunksPng(data);

    expect(mimeType).toBe("image/png");
    expect(sniffImageMime(data)).toBe("image/png");
    expect(chunks.map((c) => c.tipo)).toEqual(["IHDR", "pHYs", "sRGB", "IDAT", "IEND"]);
    expect(chunks.every((c) => c.crcOk)).toBe(true);
    expect(depoisDoIend).toBe(0);
    expect(inspectStoredImage(data, "image/png")).toEqual({
      parseable: true,
      needsSanitization: false,
      hasGps: false,
    });
  });
});

describe("PHOTO-NEW-03 · WebP: só o que a imagem precisa, e só até onde o RIFF diz", () => {
  it("EXIF, XMP, chunk desconhecido e o anexo depois do RIFF saem; ICC fica, e os bits acompanham", () => {
    const entrada = webpComMetadado(WEBP_VP8L_1X1, { largura: 1, altura: 1, icc: true });
    expect(inspectStoredImage(entrada, "image/webp").hasGps).toBe(true);

    const { data, mimeType } = processImageUpload(entrada, "image/webp", POLITICA);
    const leitura = lerWebp(data);

    expect(mimeType).toBe("image/webp");
    expect(sniffImageMime(data)).toBe("image/webp");
    expect(leitura.tipos).toEqual(["VP8X", "ICCP", "VP8L"]);
    expect(leitura.riffCoerente).toBe(true);
    expect(leitura.flagsVp8x! & VP8X.EXIF).toBe(0);
    expect(leitura.flagsVp8x! & VP8X.XMP).toBe(0);
    expect(leitura.flagsVp8x! & VP8X.ICC).toBe(VP8X.ICC);
    expect(inspectStoredImage(data, "image/webp")).toEqual({
      parseable: true,
      needsSanitization: false,
      hasGps: false,
    });
  });

  it("dentro do quadro de animação a lista também vale — nada se esconde num ANMF", () => {
    const entrada = webpAnimadoComChunkEscondido(WEBP_VP8L_1X1);
    expect(lerWebp(entrada).quadros[0]).toContain("EXIF");

    const { data } = processImageUpload(entrada, "image/webp", POLITICA);
    const leitura = lerWebp(data);

    expect(leitura.tipos).toEqual(["VP8X", "ANIM", "ANMF"]);
    expect(leitura.quadros).toEqual([["VP8L"]]);
    expect(leitura.riffCoerente).toBe(true);
  });

  it("RIFF que declara mais bytes do que existem é arquivo truncado, e é recusado", () => {
    const inteiro = riff(riffChunk("VP8L", WEBP_VP8L_1X1.subarray(20)));
    const truncado = inteiro.subarray(0, inteiro.length - 4);
    expect(recusa(() => processImageUpload(truncado, "image/webp", POLITICA))).toBe("corrompido");
  });
});

describe("PHOTO-NEW-04 · arquivo disfarçado de imagem é recusado", () => {
  it("texto com nome .jpg, e assinatura de JPEG seguida de lixo", () => {
    const script = Buffer.from("<?php system($_GET['c']); ?>", "utf8");
    expect(recusa(() => processImageUpload(script, "image/jpeg", POLITICA))).toBe("não é imagem");

    const lixo = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(64, 0x02)]);
    expect(recusa(() => processImageUpload(lixo, "image/jpeg", POLITICA))).toBe("corrompido");

    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>', "utf8");
    expect(recusa(() => processImageUpload(svg, "image/svg+xml", POLITICA))).toBe("não é imagem");
  });
});

describe("PHOTO-NEW-05 · tipo declarado e bytes precisam concordar", () => {
  it("PNG declarado como JPEG, e WebP declarado como PNG, são recusados", () => {
    const png = montarPngReal(2, 2);
    expect(recusa(() => processImageUpload(png, "image/jpeg", POLITICA))).toMatch(/não corresponde/);
    expect(recusa(() => processImageUpload(WEBP_VP8L_1X1, "image/png", POLITICA))).toMatch(
      /não corresponde/,
    );
  });
});

describe("PHOTO-NEW-06 · o que fica gravado é coerente: bytes, tipo e extensão", () => {
  let fixture: TestFixture;
  let raiz: string;

  beforeAll(async () => {
    raiz = await fs.mkdtemp(path.join(os.tmpdir(), "alfaos-formatos-"));
    setFileStorage(new LocalFileStorageAdapter(raiz));
  });
  afterAll(async () => {
    setFileStorage(null);
    await fs.rm(raiz, { recursive: true, force: true });
  });
  beforeEach(async () => {
    fixture = await seedTestData();
  });

  it("JPEG, PNG e WebP: o registro, a extensão da chave e os bytes no disco dizem o mesmo tipo", async () => {
    const customer = await prisma.customer.create({
      data: { companyId: fixture.companyA.id, name: "Cliente Formatos" },
    });
    const tecnico = await prisma.technician.upsert({
      where: { userId: fixture.techA.id },
      update: {},
      create: { companyId: fixture.companyA.id, userId: fixture.techA.id },
    });
    const ordem = await prisma.serviceOrder.create({
      data: {
        companyId: fixture.companyA.id,
        number: await allocateTestServiceOrderNumber(fixture.companyA.id),
        customerId: customer.id,
        technicianId: tecnico.id,
        type: "Instalação",
        description: "Formatos.",
        status: "ASSIGNED",
        assignedAt: new Date(),
      },
    });
    await startServiceOrder(fixture.companyA.id, fixture.techA.id, ordem.id, ordem.version);

    const casos: Array<[string, Buffer]> = [
      ["image/jpeg", jpegComMetadado(montarJpegSimples(), 1)],
      ["image/png", pngComMetadado(montarPngReal(3, 3))],
      ["image/webp", webpComMetadado(WEBP_VP8L_1X1, { largura: 1, altura: 1 })],
    ];
    for (const [mime, bytes] of casos) {
      const versao = (await prisma.serviceOrder.findUniqueOrThrow({ where: { id: ordem.id } }))
        .version;
      const ev = await addEvidence(fixture.companyA.id, fixture.techA.id, ordem.id, {
        data: bytes,
        declaredMimeType: mime,
        originalName: "foto.bin",
        expectedOrderVersion: versao,
      });
      const registro = await prisma.serviceOrderEvidence.findUniqueOrThrow({
        where: { id: ev.id },
      });
      const gravado = await fs.readFile(path.join(raiz, registro.storageKey));

      expect(registro.mimeType, mime).toBe(mime);
      expect(registro.storageKey.endsWith(`.${MIME_EXTENSIONS[mime]}`), mime).toBe(true);
      expect(sniffImageMime(gravado), mime).toBe(mime);
      expect(registro.sizeBytes, mime).toBe(gravado.byteLength);
      expect(inspectStoredImage(gravado, mime), mime).toEqual({
        parseable: true,
        needsSanitization: false,
        hasGps: false,
      });
    }
  });
});
