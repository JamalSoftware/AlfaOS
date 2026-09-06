import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { DomainError } from "@/lib/errors";
import { LocalFileStorageAdapter, setFileStorage } from "@/lib/storage";
import { addEvidence, putSignature } from "@/lib/service-order-closing";
import { startServiceOrder } from "@/lib/service-orders";
import {
  allocateTestServiceOrderNumber,
  seedTestData,
  type TestFixture,
} from "./helpers";
import { montarJpeg, lerExif, GPS_TAGS } from "./support/jpeg-exif";

/**
 * # A foto de evidência não guarda onde a pessoa estava (`EXIF-01`)
 *
 * Achado de auditoria independente: toda foto subia com o bloco GPS do EXIF
 * intacto. O detalhe que o torna grave é este — **o GPS do EXIF é escrito pelo
 * aplicativo de câmera, sob a permissão DELE**. O técnico que negou localização
 * ao AlfaOS continuava enviando coordenada em cada foto, e a recusa dele não
 * tinha efeito nenhum sobre essa coleta.
 *
 * A correção é do SERVIDOR, e a fronteira foi escolhida por isso: qualquer
 * cliente pode enviar imagem, e o Flutter não pode ser a única barreira de
 * privacidade. Os bytes que chegam ao armazenamento já estão limpos.
 */

let fixture: TestFixture;
let storageRoot: string;

beforeAll(async () => {
  storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "alfaos-exif-test-"));
  setFileStorage(new LocalFileStorageAdapter(storageRoot));
});

afterAll(async () => {
  setFileStorage(null);
  await fs.rm(storageRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  fixture = await seedTestData();
});

const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489",
  "hex",
);

async function scenario() {
  const customer = await prisma.customer.create({
    data: { companyId: fixture.companyA.id, name: "Cliente EXIF" },
  });
  const techA = await prisma.technician.upsert({
    where: { userId: fixture.techA.id },
    update: {},
    create: { companyId: fixture.companyA.id, userId: fixture.techA.id },
  });
  const order = await prisma.serviceOrder.create({
    data: {
      companyId: fixture.companyA.id,
      number: await allocateTestServiceOrderNumber(fixture.companyA.id),
      customerId: customer.id,
      technicianId: techA.id,
      type: "Instalação",
      description: "Instalação de fibra.",
      status: "ASSIGNED",
      assignedAt: new Date(),
    },
  });
  await startServiceOrder(
    fixture.companyA.id,
    fixture.techA.id,
    order.id,
    order.version,
  );
  const atual = await prisma.serviceOrder.findUniqueOrThrow({
    where: { id: order.id },
  });
  return { order: atual, orderVersion: atual.version };
}

/** Os bytes que REALMENTE ficaram no disco.
 *
 * A chave vem do REGISTRO, e não do DTO: o DTO publico nao expoe caminho de
 * armazenamento, e e assim que deve continuar.
 */
async function bytesArmazenados(evidenceId: string): Promise<Buffer> {
  const registro = await prisma.serviceOrderEvidence.findUniqueOrThrow({
    where: { id: evidenceId },
    select: { storageKey: true },
  });
  return fs.readFile(path.join(storageRoot, registro.storageKey));
}

async function bytesDaAssinatura(storageKey: string): Promise<Buffer> {
  return fs.readFile(path.join(storageRoot, storageKey));
}

async function subirFoto(
  s: Awaited<ReturnType<typeof scenario>>,
  data: Buffer,
  mime = "image/jpeg",
) {
  return addEvidence(fixture.companyA.id, fixture.techA.id, s.order.id, {
    data,
    declaredMimeType: mime,
    originalName: mime === "image/png" ? "foto.png" : "foto.jpg",
    expectedOrderVersion: s.orderVersion,
  });
}

describe("EXIF-01 · JPEG com GPS é armazenado sem GPS", () => {
  it("nenhuma tag de GPS sobrevive à persistência", async () => {
    const s = await scenario();
    const original = montarJpeg({ comGps: true, orientacao: 6 });

    // Controle positivo: o fixture REALMENTE tem GPS. Sem isto, um teste que
    // procura ausência passaria contra uma imagem que nunca teve coordenada.
    const antes = lerExif(original);
    expect(antes.tagsGps).toContain(GPS_TAGS.latitude);
    expect(antes.tagsGps).toContain(GPS_TAGS.longitude);

    const ev = await subirFoto(s, original);
    const guardado = await bytesArmazenados(ev.id);
    const depois = lerExif(guardado);

    expect(depois.tagsGps).toEqual([]);
    for (const tag of Object.values(GPS_TAGS)) {
      expect(depois.tagsGps).not.toContain(tag);
    }
  });

  it("o XMP também vai embora, e não só a IFD de GPS", async () => {
    /*
      Coordenada aparece em DOIS lugares num JPEG: a IFD de GPS do Exif e o
      XMP, que é outro APP1 com outro cabeçalho. Uma correção cirúrgica sobre a
      IFD deixaria o XMP passar inteiro — e o texto `exif:GPSLatitude` que o
      fixture escreve é exatamente o que o Lightroom e vários apps de câmera
      gravam.
    */
    const s = await scenario();
    const original = montarJpeg({ comGps: true, comXmp: true });
    expect(lerExif(original).temXmp).toBe(true);

    const ev = await subirFoto(s, original);
    const guardado = await bytesArmazenados(ev.id);

    expect(lerExif(guardado).temXmp).toBe(false);
    expect(guardado.toString("latin1")).not.toContain("GPSLatitude");
  });
});

describe("EXIF-02 · JPEG sem GPS continua válido", () => {
  it("a imagem sobe, é aceita e continua sendo JPEG", async () => {
    const s = await scenario();
    const original = montarJpeg({ comGps: false, orientacao: 1 });

    const ev = await subirFoto(s, original);
    const guardado = await bytesArmazenados(ev.id);

    expect(ev.mimeType).toBe("image/jpeg");
    expect(guardado.subarray(0, 3).toString("hex")).toBe("ffd8ff");
    expect(guardado.subarray(-2).toString("hex")).toBe("ffd9");
    expect(lerExif(guardado).tagsGps).toEqual([]);
  });
});

describe("EXIF-03 · a orientação sobrevive", () => {
  it("cada orientação declarada volta igual do armazenamento", async () => {
    /*
      Isto é o que impede a correção de virar um defeito visual.

      O AlfaOS **não decodifica** a imagem — não há biblioteca de imagem na
      pipeline —, então os pixels chegam na orientação em que a câmera os
      gravou e quem endireita é a tag. Apagar o EXIF inteiro sem preservá-la
      faria toda foto de retrato aparecer deitada no relatório, e o técnico
      levaria a culpa por "tirar a foto errada".

      As seis orientações reais de câmera são cobertas: 1 (normal), 3 (180°),
      6 (90° horário) e 8 (90° anti-horário) são as que aparecem em campo; 2, 4,
      5 e 7 são espelhadas e existem no padrão.
    */
    for (const orientacao of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const s = await scenario();
      const original = montarJpeg({ comGps: true, orientacao });
      const ev = await subirFoto(s, original);
      const guardado = await bytesArmazenados(ev.id);

      const lido = lerExif(guardado);
      expect(lido.orientacao, `orientação ${orientacao}`).toBe(orientacao);
      expect(lido.tagsGps).toEqual([]);
    }
  });

  it("imagem sem orientação declarada não ganha uma inventada", async () => {
    const s = await scenario();
    const original = montarJpeg({ comGps: true, orientacao: null });
    const ev = await subirFoto(s, original);
    const guardado = await bytesArmazenados(ev.id);

    // Nem tag falsa, nem GPS. Escrever `Orientation: 1` onde não havia nada
    // seria afirmar sobre a foto algo que a câmera não afirmou.
    expect(lerExif(guardado).orientacao).toBeNull();
    expect(lerExif(guardado).tagsGps).toEqual([]);
  });
});

describe("EXIF-04 · arquivo inválido continua bloqueado", () => {
  it("as regras que já existiam não foram afrouxadas pela limpeza", async () => {
    const s = await scenario();

    // Não é imagem nenhuma.
    await expect(
      subirFoto(s, Buffer.from("isto nao e uma imagem", "ascii")),
    ).rejects.toBeInstanceOf(DomainError);

    // JPEG de verdade, declarado como PNG.
    await expect(
      subirFoto(s, montarJpeg({ comGps: true }), "image/png"),
    ).rejects.toBeInstanceOf(DomainError);

    // Vazio.
    await expect(subirFoto(s, Buffer.alloc(0))).rejects.toBeInstanceOf(
      DomainError,
    );

    expect(
      await prisma.serviceOrderEvidence.count({
        where: { serviceOrderId: s.order.id },
      }),
    ).toBe(0);
  });

  it("JPEG truncado no meio de um segmento não vira exceção nem passa sujo", async () => {
    /*
      A limpeza percorre segmentos, e um arquivo cortado é o vetor clássico
      para um percurso desses estourar. O contrato é: ou recusa como imagem
      inválida, ou aceita e entrega bytes limpos — nunca 500, nunca GPS.
    */
    const s = await scenario();
    const inteiro = montarJpeg({ comGps: true });
    const cortado = inteiro.subarray(0, Math.floor(inteiro.length / 2));

    try {
      const ev = await subirFoto(s, cortado);
      const guardado = await bytesArmazenados(ev.id);
      expect(lerExif(guardado).tagsGps).toEqual([]);
    } catch (erro) {
      expect(erro).toBeInstanceOf(DomainError);
    }
  });
});

describe("EXIF-05 · PNG e assinatura seguem funcionando", () => {
  it("PNG é aceito e permanece PNG", async () => {
    const s = await scenario();
    const ev = await subirFoto(s, PNG, "image/png");
    const guardado = await bytesArmazenados(ev.id);

    expect(ev.mimeType).toBe("image/png");
    expect(guardado.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  });

  it("a assinatura do cliente também passa pela limpeza", async () => {
    /*
      A assinatura é o segundo ponto de escrita de imagem do fechamento. Ela é
      desenhada na tela e não deveria ter EXIF nenhum — mas "não deveria" é
      exatamente o tipo de premissa que um cliente futuro quebra, e a política
      do §3 vale para qualquer origem de upload.
    */
    const s = await scenario();
    const assinatura = montarJpeg({ comGps: true, orientacao: 1 });
    const salva = await putSignature(
      fixture.companyA.id,
      fixture.techA.id,
      s.order.id,
      {
        data: assinatura,
        declaredMimeType: "image/jpeg",
        signerName: "Cliente Teste",
        expectedOrderVersion: s.orderVersion,
      },
    );
    const registro = await prisma.serviceOrderSignature.findFirstOrThrow({
      where: { serviceOrderId: s.order.id },
      select: { storageKey: true },
    });
    expect(salva.mimeType).toBe("image/jpeg");
    const guardado = await bytesDaAssinatura(registro.storageKey);
    expect(lerExif(guardado).tagsGps).toEqual([]);
  });
});

describe("EXIF-06 · a limpeza não vaza coordenada para lugar nenhum", () => {
  it("nem timeline, nem auditoria, nem o registro da evidência", async () => {
    const s = await scenario();
    const ev = await subirFoto(s, montarJpeg({ comGps: true, comXmp: true }));

    const registro = await prisma.serviceOrderEvidence.findUniqueOrThrow({
      where: { id: ev.id },
    });
    const eventos = await prisma.serviceOrderEvent.findMany({
      where: { serviceOrderId: s.order.id },
    });
    const auditoria = await prisma.auditLog.findMany({
      where: { companyId: fixture.companyA.id },
    });

    const tudo = JSON.stringify({ registro, eventos, auditoria });
    // As coordenadas do fixture, em qualquer forma reconhecível.
    for (const agulha of ["GPSLatitude", "GPSLongitude", "20,27", "41,40"]) {
      expect(tudo).not.toContain(agulha);
    }
  });
});

describe("EXIF-07 · o que ficou no disco é o sanitizado", () => {
  it("os bytes armazenados não são os originais", async () => {
    const s = await scenario();
    const original = montarJpeg({ comGps: true, comXmp: true, comentario: "x" });

    const ev = await subirFoto(s, original);
    const guardado = await bytesArmazenados(ev.id);

    expect(guardado.equals(original)).toBe(false);
    expect(guardado.byteLength).toBeLessThan(original.byteLength);
  });

  it("tamanho e hash gravados descrevem o ARQUIVO, não a entrada", async () => {
    /*
      Se o registro guardasse o tamanho e o hash do original enquanto o disco
      tem o sanitizado, a conferência de integridade acusaria corrupção em toda
      foto — e o campo que existe para provar que o arquivo não mudou passaria
      a provar o contrário.
    */
    const s = await scenario();
    const original = montarJpeg({ comGps: true, comXmp: true });

    const ev = await subirFoto(s, original);
    const guardado = await bytesArmazenados(ev.id);
    const registro = await prisma.serviceOrderEvidence.findUniqueOrThrow({
      where: { id: ev.id },
    });

    expect(registro.sizeBytes).toBe(guardado.byteLength);
    expect(ev.sizeBytes).toBe(guardado.byteLength);
    expect(registro.contentHash).toBe(
      createHash("sha256").update(guardado).digest("hex"),
    );
  });
});

describe("EXIF-08 · cliente malicioso não escapa", () => {
  it("EXIF forjado fora do Field é sanitizado igual", async () => {
    /*
      O Flutter não é a barreira. Esta chamada não passa por aplicativo nenhum:
      é a camada de domínio recebendo bytes escolhidos por quem ataca, que é
      exatamente o que uma integração futura, um script ou um cliente
      reimplementado fariam.
    */
    const s = await scenario();
    const forjado = montarJpeg({
      comGps: true,
      comXmp: true,
      comentario: "GPSLatitude=20,27.123S GPSLongitude=41,40.456W",
    });

    const ev = await subirFoto(s, forjado);
    const guardado = await bytesArmazenados(ev.id);

    expect(lerExif(guardado).tagsGps).toEqual([]);
    expect(lerExif(guardado).temXmp).toBe(false);
    // O comentário livre é outro esconderijo, e some junto: metadado sem valor
    // operacional não fica.
    expect(guardado.toString("latin1")).not.toContain("GPSLatitude");
  });
});

describe("EXIF-09 · nada sobrevive depois do fim da imagem", () => {
  it("o trailer da Motion Photo é cortado junto", async () => {
    /*
      Achado da auditoria independente sobre a PRIMEIRA versão desta correção.

      A limpeza copiava tudo a partir do `SOS` — o que está certo para os dados
      comprimidos, e errado para o que vem DEPOIS do `EOI`. Samsung e Google
      anexam ali um MP4 inteiro (Motion Photo, Top Shot), e o `moov/udta/©xyz`
      dele guarda coordenada. O arquivo tinha GPS, thumbnail e IPTC removidos
      corretamente, e o trailer atravessava inteiro.

      Alcançável pela WEB, onde o `<input type="file">` envia o arquivo cru. O
      Field não chegaria aqui porque o `image_picker` reencoda — e o Field não
      pode ser a barreira, que é a premissa deste arquivo.
    */
    const s = await scenario();
    const trailer = Buffer.concat([
      Buffer.from("ftypmp42", "ascii"),
      Buffer.from("moovudta", "ascii"),
      Buffer.from("©xyz+20.4500-041.6700/", "latin1"),
    ]);
    const original = montarJpeg({ comGps: true, trailer });
    expect(original.toString("latin1")).toContain("xyz+20.4500");

    const ev = await subirFoto(s, original);
    const guardado = await bytesArmazenados(ev.id);

    expect(guardado.toString("latin1")).not.toContain("xyz+20.4500");
    expect(guardado.toString("latin1")).not.toContain("ftypmp42");
    // E a imagem continua terminando onde deve.
    expect(guardado.subarray(-2).toString("hex")).toBe("ffd9");
    expect(lerExif(guardado).tagsGps).toEqual([]);
  });
});

describe("EXIF-10 · o percurso não vira arma", () => {
  it("enxurrada de marcadores é recusada, e depressa", async () => {
    /*
      A auditoria mediu 1452 ms de event loop BLOQUEADO com 8 MB de marcadores
      isolados de dois bytes — 726 vezes o custo de um JPEG normal. Em Node isso
      não é uma requisição lenta: é a aplicação inteira parada, para todos os
      tenants, porque a thread é uma só.

      O teste afirma as duas metades: recusa, e em tempo de imagem — não em
      tempo de ataque.
    */
    const s = await scenario();
    const enxurrada = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      Buffer.alloc(2 * 1024 * 1024, 0xd0).map((_, i) => (i % 2 === 0 ? 0xff : 0xd0)),
    ]);

    const inicio = Date.now();
    await expect(subirFoto(s, enxurrada)).rejects.toBeInstanceOf(DomainError);
    expect(Date.now() - inicio).toBeLessThan(2000);
  });

  it("APP0 que não é JFIF e APP2 que não é ICC vão embora", async () => {
    // Preservar por NÚMERO de marcador deixava dois canais abertos: `JFXX`
    // carrega thumbnail, e um prefixo parecido com `ICC_PROFILE` passava.
    const s = await scenario();
    const original = montarJpeg({
      comGps: true,
      app0Falso: true,
      app2Falso: true,
    });

    const ev = await subirFoto(s, original);
    const guardado = await bytesArmazenados(ev.id);

    expect(guardado.toString("latin1")).not.toContain("JFXX");
    expect(guardado.toString("latin1")).not.toContain("ICC_PROFILEX");
    // O JFIF de verdade continua lá.
    expect(guardado.toString("latin1")).toContain("JFIF");
  });
});
