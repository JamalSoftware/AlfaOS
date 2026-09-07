import { createHash } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  GET as photoGetRoute,
  POST as photoPostRoute,
} from "@/app/api/ctos/[id]/photo/route";
import { createCto } from "@/lib/cto";
import { getFileStorage } from "@/lib/storage";
import { lerExif, montarJpeg } from "./support/jpeg-exif";
import { lerPng, montarPngReal } from "./support/png-real";
import {
  apiRequest,
  createTokenFor,
  seedTestData,
  type TestFixture,
} from "./helpers";

/**
 * # CTO-1.8 — os BYTES que a rota de foto devolve
 *
 * ## O que a validação humana encontrou
 *
 * A rota respondia `200` com `Content-Type: image/jpeg` e o preview ficava
 * quebrado. Os testes que já existiam não podiam pegar isso, e a razão é
 * instrutiva: todos afirmavam presença, autorização ou identidade de conteúdo.
 * Um corpo que chega inteiro e não abre satisfaz os três.
 *
 * O fixture `montarJpeg` diz no próprio docstring que não precisa ser
 * decodificável — *"nada no AlfaOS decodifica imagem"*. Era verdade até a
 * `CTO-1.7` acrescentar o preview, que é justamente um consumidor que
 * decodifica. O fixture continua certo para o que ele existe (provar que o
 * EXIF sai); o que faltava era um segundo fixture, real, para as afirmações
 * novas.
 *
 * ## O que este arquivo prova
 *
 * Que o corpo servido é **byte a byte** o que está no storage, que o header
 * concorda com os bytes, que o formato não é presumido, e que nada disso é
 * afrouxado por tenant, chave ou substituição. A decodificação de verdade —
 * `naturalWidth` num navegador — é o `e2e/ctos.spec.ts`; aqui a fronteira é o
 * corpo HTTP.
 */

let fixture: TestFixture;
let adminToken: string;
let adminBToken: string;

beforeEach(async () => {
  fixture = await seedTestData();
  adminToken = await createTokenFor(fixture.adminA.id);
  adminBToken = await createTokenFor(fixture.adminB.id);
  await prisma.company.updateMany({
    where: { id: { in: [fixture.companyA.id, fixture.companyB.id] } },
    data: { ctoNetworkEnabled: true },
  });
});

async function semeiaCto(nome = "A16") {
  return createCto(fixture.companyA.id, fixture.adminA.id, {
    name: nome,
    capacity: 8,
  });
}

function envio(ctoId: string, bytes: Buffer, mime: string, token: string) {
  const form = new FormData();
  form.append(
    "file",
    new File([new Uint8Array(bytes)], `foto.${mime.split("/")[1]}`, {
      type: mime,
    }),
  );
  return new Request(`http://localhost/api/ctos/${ctoId}/photo`, {
    method: "POST",
    headers: {
      Origin: "http://localhost",
      Cookie: `alfaos_session=${encodeURIComponent(token)}`,
    },
    body: form,
  });
}

async function leFoto(ctoId: string, token = adminToken) {
  return photoGetRoute(apiRequest(`/api/ctos/${ctoId}/photo`, {}, token), {
    params: { id: ctoId },
  });
}

function sha(buf: Buffer) {
  return createHash("sha256").update(buf).digest("hex");
}

// ---------------------------------------------------------------------------

describe("CTO1PV-PHOTO-BYTES · o corpo servido", () => {
  it("BYTES-01 — a rota devolve corpo NÃO VAZIO", async () => {
    const cto = await semeiaCto();
    const envioOk = await photoPostRoute(
      envio(cto.id, montarPngReal(24, 16), "image/png", adminToken),
      { params: { id: cto.id } },
    );
    expect(envioOk.status).toBe(200);

    const res = await leFoto(cto.id);
    expect(res.status).toBe(200);
    const corpo = Buffer.from(await res.arrayBuffer());
    /*
      Zero bytes com `200` é o pior desfecho possível: a rota afirma sucesso e
      não entrega nada, e a única evidência do problema fica no navegador de
      quem estiver olhando. `Content-Length`, quando presente, tem de contar a
      mesma história.
    */
    expect(corpo.byteLength).toBeGreaterThan(0);
    const declarado = res.headers.get("content-length");
    if (declarado !== null) {
      expect(Number(declarado)).toBe(corpo.byteLength);
    }
  });

  it("BYTES-02 — os magic bytes CONCORDAM com o Content-Type", async () => {
    const cto = await semeiaCto();
    await photoPostRoute(
      envio(cto.id, montarPngReal(24, 16), "image/png", adminToken),
      { params: { id: cto.id } },
    );

    const res = await leFoto(cto.id);
    const corpo = Buffer.from(await res.arrayBuffer());

    /*
      O tipo NÃO é fixo no código.

      Um `image/jpeg` constante passaria despercebido em qualquer teste que só
      enviasse JPEG — e o AlfaOS aceita três formatos. Aqui o PNG entra e o PNG
      sai, com o header dizendo a verdade sobre os bytes que o acompanham.
    */
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(corpo.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("BYTES-03 — o hash do corpo HTTP é o hash do arquivo no storage", async () => {
    const cto = await semeiaCto();
    await photoPostRoute(
      envio(cto.id, montarPngReal(30, 20), "image/png", adminToken),
      { params: { id: cto.id } },
    );

    const linha = await prisma.cTO.findUniqueOrThrow({
      where: { id: cto.id },
      select: { photoStorageKey: true },
    });
    const doStorage = await getFileStorage().get(linha.photoStorageKey!);
    const doHttp = Buffer.from(await (await leFoto(cto.id)).arrayBuffer());

    // A boundary exata: se estes dois divergirem, o defeito é da ENTREGA. Se
    // forem iguais e a imagem não abrir, o defeito é do que foi GRAVADO.
    expect(sha(doHttp)).toBe(sha(doStorage));
    expect(doHttp.byteLength).toBe(doStorage.byteLength);
  });

  it("BYTES-04 — o binário não passa por string nem por JSON", async () => {
    const cto = await semeiaCto();
    const png = montarPngReal(40, 28);
    await photoPostRoute(envio(cto.id, png, "image/png", adminToken), {
      params: { id: cto.id },
    });

    const res = await leFoto(cto.id);
    expect(res.headers.get("content-type")).not.toContain("application/json");
    const corpo = Buffer.from(await res.arrayBuffer());

    /*
      A prova é o byte ALTO, não o tamanho.

      `Buffer.toString()` (UTF-8) troca toda sequência inválida por U+FFFD, que
      volta como `EF BF BD` — três bytes onde havia um. Um corpo assim continua
      não-vazio, continua tendo `Content-Type` de imagem e continua começando
      pela assinatura do PNG; o que ele NÃO tem é nenhum byte acima de 0x7f
      preservado. É por isso que o fixture é um gradiente: cor chapada comprime
      a um punhado de bytes e poderia não produzir nenhum.
    */
    const altosOriginais = png.filter((b) => b > 0x7f).length;
    expect(altosOriginais).toBeGreaterThan(20);
    expect(corpo.filter((b) => b > 0x7f).length).toBe(altosOriginais);
    expect(corpo.includes(Buffer.from([0xef, 0xbf, 0xbd]))).toBe(false);
  });

  it("BYTES-05 — o upload novo produz uma imagem ESTRUTURALMENTE completa", async () => {
    const cto = await semeiaCto();
    await photoPostRoute(
      envio(cto.id, montarPngReal(48, 32), "image/png", adminToken),
      { params: { id: cto.id } },
    );

    const corpo = Buffer.from(await (await leFoto(cto.id)).arrayBuffer());
    const png = lerPng(corpo);

    /*
      "Tem a assinatura certa" não é "é uma imagem".

      O blob que a validação humana encontrou tinha assinatura JPEG, segmentos
      plausíveis e `EOI` no fim — e nenhum quadro: sem `SOF`, sem tabelas de
      Huffman, com quatro bytes de scan inventados. Ele passava em toda
      afirmação de assinatura já escrita. A afirmação que separa os dois casos é
      a estrutura COMPLETA, com dimensões reais.
    */
    expect(png.ok).toBe(true);
    expect(png.crcOk).toBe(true);
    expect(png.largura).toBe(48);
    expect(png.altura).toBe(32);
    expect(png.pedacos).toContain("IDAT");
    expect(png.sobra).toBe(0);
  });

  it("BYTES-06 — a substituição também devolve imagem completa, e é OUTRA", async () => {
    const cto = await semeiaCto();
    await photoPostRoute(
      envio(cto.id, montarPngReal(48, 32), "image/png", adminToken),
      { params: { id: cto.id } },
    );
    const primeira = Buffer.from(await (await leFoto(cto.id)).arrayBuffer());

    await photoPostRoute(
      envio(cto.id, montarPngReal(20, 60), "image/png", adminToken),
      { params: { id: cto.id } },
    );
    const segunda = Buffer.from(await (await leFoto(cto.id)).arrayBuffer());

    expect(sha(segunda)).not.toBe(sha(primeira));
    // A troca é provada pela DIMENSÃO, e não só pelo hash: dois blobs
    // diferentes provam que algo mudou, a dimensão prova O QUE mudou.
    expect(lerPng(segunda)).toMatchObject({ ok: true, largura: 20, altura: 60 });
  });

  it("BYTES-07 — envio inválido preserva a foto anterior, inteira", async () => {
    const cto = await semeiaCto();
    await photoPostRoute(
      envio(cto.id, montarPngReal(36, 24), "image/png", adminToken),
      { params: { id: cto.id } },
    );
    const antes = Buffer.from(await (await leFoto(cto.id)).arrayBuffer());
    const chaveAntes = (
      await prisma.cTO.findUniqueOrThrow({
        where: { id: cto.id },
        select: { photoStorageKey: true },
      })
    ).photoStorageKey;

    const lixo = await photoPostRoute(
      envio(
        cto.id,
        Buffer.from("isto nao e uma imagem"),
        "image/png",
        adminToken,
      ),
      { params: { id: cto.id } },
    );
    expect(lixo.status).toBe(400);

    const depois = Buffer.from(await (await leFoto(cto.id)).arrayBuffer());
    expect(sha(depois)).toBe(sha(antes));
    expect(lerPng(depois).ok).toBe(true);
    expect(
      (
        await prisma.cTO.findUniqueOrThrow({
          where: { id: cto.id },
          select: { photoStorageKey: true },
        })
      ).photoStorageKey,
    ).toBe(chaveAntes);
  });

  it("BYTES-08 — outro tenant recebe 404, e nenhum byte", async () => {
    const cto = await semeiaCto();
    await photoPostRoute(
      envio(cto.id, montarPngReal(24, 16), "image/png", adminToken),
      { params: { id: cto.id } },
    );

    // Controle POSITIVO: o caminho autorizado devolve a imagem de verdade —
    // sem ele, o 404 abaixo poderia estar passando por ausência de foto.
    const legitimo = await leFoto(cto.id, adminToken);
    expect(legitimo.status).toBe(200);
    expect(Buffer.from(await legitimo.arrayBuffer()).byteLength).toBeGreaterThan(
      0,
    );

    const cruzado = await leFoto(cto.id, adminBToken);
    expect(cruzado.status).toBe(404);
    const corpo = await cruzado.text();
    expect(corpo).not.toContain("PNG");
    expect(corpo).toContain("não encontrada");
  });

  it("BYTES-09 — nem a chave nem o caminho em disco saem na resposta", async () => {
    const cto = await semeiaCto();
    await photoPostRoute(
      envio(cto.id, montarPngReal(24, 16), "image/png", adminToken),
      { params: { id: cto.id } },
    );
    const linha = await prisma.cTO.findUniqueOrThrow({
      where: { id: cto.id },
      select: { photoStorageKey: true },
    });
    const chave = linha.photoStorageKey!;

    const res = await leFoto(cto.id);
    /*
      A chave carrega o `companyId` e o id do recurso, e o nome do arquivo é a
      única parte imprevisível dela. Vazá-la não abre a foto de ninguém — a
      leitura passa por sessão e tenant de qualquer forma —, mas entrega
      estrutura interna de graça, e `Content-Disposition` é onde um nome de
      arquivo costuma escapar sem que ninguém repare.
    */
    const linhas: string[] = [];
    res.headers.forEach((valor, nome) => linhas.push(`${nome}:${valor}`));
    const cabecalhos = linhas.join("\n");
    expect(cabecalhos).not.toContain(chave);
    expect(cabecalhos).not.toContain(chave.split("/").pop()!);
    expect(cabecalhos).not.toContain(fixture.companyA.id);
    expect(cabecalhos.toLowerCase()).not.toContain(".storage");
    expect(res.headers.get("content-disposition")).toBe("attachment");
  });

  it("BYTES-10 — o GPS continua fora do que é servido", async () => {
    const cto = await semeiaCto();
    const comGps = montarJpeg({ comGps: true, orientacao: 6 });
    expect(lerExif(comGps).tagsGps.length).toBeGreaterThan(0);

    await photoPostRoute(envio(cto.id, comGps, "image/jpeg", adminToken), {
      params: { id: cto.id },
    });

    const servido = Buffer.from(await (await leFoto(cto.id)).arrayBuffer());
    const exif = lerExif(servido);
    // Sai o GPS, fica a orientação: é a tag que endireita a foto, e o AlfaOS
    // não decodifica imagem para endireitá-la por conta própria.
    expect(exif.tagsGps).toEqual([]);
    expect(exif.temXmp).toBe(false);
    expect(exif.orientacao).toBe(6);
  });
});
