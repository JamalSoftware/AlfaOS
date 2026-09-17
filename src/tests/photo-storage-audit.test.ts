import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { closingContentHash } from "@/lib/service-order-completion";
import { addEvidence, removeEvidence } from "@/lib/service-order-closing";
import { startServiceOrder } from "@/lib/service-orders";
import {
  LocalFileStorageAdapter,
  setFileStorage,
  STORAGE_KEY_PATTERN,
  type FileStorageContract,
} from "@/lib/storage";
import {
  auditPhotoStorage,
  ORPHAN_GRACE_MS,
  purgeOrphanFiles,
  resanitizeLegacyPhotos,
} from "@/lib/storage/photo-audit";
import { STORAGE_REFERENCE_COLUMNS } from "@/lib/storage/references";
import { allocateTestServiceOrderNumber, seedTestData, type TestFixture } from "./helpers";
import { lerExif, montarJpeg, montarJpegSimples } from "./support/jpeg-exif";
import { montarPngReal } from "./support/png-real";
import { pngChunk } from "./support/image-containers";

/**
 * # RC-1E · auditoria de fotos e storage
 *
 * Foto gravada antes da limpeza de metadado continua com os bytes de então —
 * no banco de desenvolvimento, a do piloto da OS Nº 6 ainda tem GPS
 * (`MASTER-PLAN` §12). Este arquivo prova as três coisas que a auditoria
 * precisa garantir antes de alguém confiar nela:
 *
 * - ela ENXERGA o que diz (GPS legado, arquivo ausente, órfão) e não confunde
 *   uma coisa com a outra;
 * - sem `apply`, ela NÃO MUDA NADA — nem um byte, nem uma linha;
 * - com `apply`, ela não destrói o que ainda é referenciado, não cruza empresa
 *   e não sai da raiz do storage.
 *
 * O legado é montado DIRETO no disco e no banco, sem passar pelo upload — que é
 * exatamente como dado antigo existe. Nenhuma foto real; a latitude é inventada.
 */

let fixture: TestFixture;
let raiz: string;
let storage: FileStorageContract;

beforeAll(async () => {
  raiz = await fs.mkdtemp(path.join(os.tmpdir(), "alfaos-auditoria-storage-"));
});
afterAll(async () => {
  setFileStorage(null);
  await fs.rm(raiz, { recursive: true, force: true });
});
beforeEach(async () => {
  // Raiz limpa por teste: a auditoria percorre TUDO, e um arquivo de outro
  // teste mudaria as contagens.
  await fs.rm(raiz, { recursive: true, force: true });
  await fs.mkdir(raiz, { recursive: true });
  storage = new LocalFileStorageAdapter(raiz);
  setFileStorage(storage);
  fixture = await seedTestData();
});

const DIA = 24 * 60 * 60 * 1000;
const depoisDaCarencia = () => new Date(Date.now() + ORPHAN_GRACE_MS + DIA);
/** Prefixo de empresa que não existe no banco — o resíduo que o expurgo pode apagar. */
const EMPRESA_INEXISTENTE = "empresaapagada000000000000";
const MISSING = { scope: "missing-company" } as const;
const chaveDe = (companyId: string, escopo = "legado", ext = "jpg") =>
  `${companyId}/${escopo}/${randomUUID().replace(/-/g, "")}.${ext}`;

async function envelhecer(chave: string) {
  const antigo = new Date(Date.now() - 3 * DIA);
  await fs.utimes(path.join(raiz, chave), antigo, antigo);
}

async function gravarNoDisco(chave: string, bytes: Buffer) {
  const cheio = path.join(raiz, chave);
  await fs.mkdir(path.dirname(cheio), { recursive: true });
  await fs.writeFile(cheio, bytes);
}

async function ordem(companyId: string) {
  const customer = await prisma.customer.create({
    data: { companyId, name: "Cliente Legado Sigiloso" },
  });
  return prisma.serviceOrder.create({
    data: {
      companyId,
      number: await allocateTestServiceOrderNumber(companyId),
      customerId: customer.id,
      type: "Instalação",
      description: "OS do legado.",
      status: "COMPLETED",
      completedAt: new Date(),
    },
  });
}

/** Evidência legada: bytes gravados SEM limpeza, linha criada direto. */
async function evidenciaLegada(companyId: string, bytes: Buffer, mimeType = "image/jpeg") {
  const os_ = await ordem(companyId);
  const ext = mimeType === "image/png" ? "png" : "jpg";
  const chave = chaveDe(companyId, os_.id, ext);
  await gravarNoDisco(chave, bytes);
  const linha = await prisma.serviceOrderEvidence.create({
    data: {
      companyId,
      serviceOrderId: os_.id,
      storageKey: chave,
      originalName: "piloto-original.jpg",
      mimeType,
      sizeBytes: bytes.byteLength,
      contentHash: createHash("sha256").update(bytes).digest("hex"),
    },
  });
  return { linha, chave, ordemId: os_.id };
}

async function hashesDoDisco(): Promise<Record<string, string>> {
  const saida: Record<string, string> = {};
  for await (const entrada of new LocalFileStorageAdapter(raiz).list()) {
    const bytes = await fs.readFile(path.join(raiz, entrada.key));
    saida[entrada.key] = createHash("sha256").update(bytes).digest("hex");
  }
  return saida;
}

async function retratoDoBanco() {
  return {
    evidencias: await prisma.serviceOrderEvidence.findMany({
      select: { id: true, storageKey: true, sizeBytes: true, contentHash: true, status: true },
      orderBy: { id: "asc" },
    }),
    assinaturas: await prisma.serviceOrderSignature.findMany({
      select: { id: true, storageKey: true, sizeBytes: true },
      orderBy: { id: "asc" },
    }),
    caixas: await prisma.cTO.findMany({
      select: { id: true, photoStorageKey: true, updatedAt: true },
      orderBy: { id: "asc" },
    }),
    auditoria: await prisma.auditLog.count(),
  };
}

/** Storage que CONTA escritas — para provar que a leitura não escreve. */
function storageQueConta(real: FileStorageContract) {
  const contagem = { put: 0, delete: 0 };
  const espiao: FileStorageContract = {
    put: (k, d, m) => {
      contagem.put += 1;
      return real.put(k, d, m);
    },
    delete: (k) => {
      contagem.delete += 1;
      return real.delete(k);
    },
    get: (k) => real.get(k),
    exists: (k) => real.exists(k),
    list: () => real.list(),
  };
  return { espiao, contagem };
}

describe("LEGACY-01/02 · a auditoria enxerga o GPS legado, e só ele", () => {
  it("foto antiga com GPS é apontada; foto limpa pelo upload não é", async () => {
    const legado = await evidenciaLegada(fixture.companyA.id, montarJpeg({ comGps: true, orientacao: 6 }));

    // Uma foto que passou pelo upload ATUAL, na mesma empresa.
    const tecnico = await prisma.technician.upsert({
      where: { userId: fixture.techA.id },
      update: {},
      create: { companyId: fixture.companyA.id, userId: fixture.techA.id },
    });
    const customer = await prisma.customer.create({
      data: { companyId: fixture.companyA.id, name: "Cliente Atual" },
    });
    const atual = await prisma.serviceOrder.create({
      data: {
        companyId: fixture.companyA.id,
        number: await allocateTestServiceOrderNumber(fixture.companyA.id),
        customerId: customer.id,
        technicianId: tecnico.id,
        type: "Instalação",
        description: "Atual.",
        status: "ASSIGNED",
        assignedAt: new Date(),
      },
    });
    await startServiceOrder(fixture.companyA.id, fixture.techA.id, atual.id, atual.version);
    await addEvidence(fixture.companyA.id, fixture.techA.id, atual.id, {
      data: montarJpeg({ comGps: true, orientacao: 1 }),
      declaredMimeType: "image/jpeg",
      originalName: "nova.jpg",
      expectedOrderVersion: (await prisma.serviceOrder.findUniqueOrThrow({ where: { id: atual.id } })).version,
    });

    const r = await auditPhotoStorage({ storage });

    expect(r.references).toBe(2);
    expect(r.examined).toBe(2);
    expect(r.clean).toBe(1);
    expect(r.needsSanitization).toBe(1);
    expect(r.withGps).toBe(1);
    expect(r.legacy).toEqual([
      {
        kind: "EVIDENCE",
        id: legado.linha.id,
        companyId: fixture.companyA.id,
        state: "NEEDS_SANITIZATION",
        hasGps: true,
      },
    ]);
  });

  it("metadado SEM GPS também é apontado — mas não conta como GPS", async () => {
    const comTexto = Buffer.concat([
      montarPngReal(3, 3).subarray(0, 33),
      pngChunk("tEXt", Buffer.from("Author\0alguem", "latin1")),
      montarPngReal(3, 3).subarray(33),
    ]);
    await evidenciaLegada(fixture.companyA.id, comTexto, "image/png");

    const r = await auditPhotoStorage({ storage });

    expect(r.needsSanitization).toBe(1);
    expect(r.withGps).toBe(0);
    expect(r.legacy[0].hasGps).toBe(false);
  });
});

describe("LEGACY-03/04 · SIMULAR não muda nada — nem byte, nem linha", () => {
  it("auditoria, re-sanitização simulada e expurgo simulado: SHA-256 e banco iguais, zero escritas", async () => {
    await evidenciaLegada(fixture.companyA.id, montarJpeg({ comGps: true, orientacao: 3 }));
    const orfao = chaveDe(fixture.companyA.id, "sobra");
    await gravarNoDisco(orfao, montarJpegSimples());
    await envelhecer(orfao);

    const bytesAntes = await hashesDoDisco();
    const bancoAntes = await retratoDoBanco();
    const { espiao, contagem } = storageQueConta(storage);

    const auditoria = await auditPhotoStorage({ storage: espiao, now: depoisDaCarencia() });
    const reSan = await resanitizeLegacyPhotos({ storage: espiao, apply: false });
    const expurgo = await purgeOrphanFiles({ storage: espiao, apply: false, now: depoisDaCarencia() });

    // Controle: havia o que fazer — a simulação não passou por vazio.
    expect(auditoria.needsSanitization).toBe(1);
    expect(reSan.candidates).toBe(1);
    expect(expurgo.candidates).toBeGreaterThanOrEqual(1);

    expect(contagem).toEqual({ put: 0, delete: 0 });
    expect(reSan.resanitized).toBe(0);
    expect(expurgo.deleted).toBe(0);
    expect(await hashesDoDisco()).toEqual(bytesAntes);
    expect(await retratoDoBanco()).toEqual(bancoAntes);
  });
});

describe("LEGACY-05 · arquivo corrompido é apontado, e nunca destruído", () => {
  it("fica como não interpretável; a re-sanitização aplicada não o toca", async () => {
    const lixo = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(40, 0x02)]);
    const { linha, chave } = await evidenciaLegada(fixture.companyA.id, lixo);
    // E um PNG declarado onde há JPEG: o tipo registrado não bate com os bytes.
    const trocado = await evidenciaLegada(fixture.companyA.id, montarJpeg({ comGps: true }), "image/png");

    const r = await auditPhotoStorage({ storage });
    expect(r.unparseable).toBe(2);
    expect(r.legacy.map((f) => f.state)).toEqual(["UNPARSEABLE", "UNPARSEABLE"]);

    const aplicada = await resanitizeLegacyPhotos({ storage, apply: true });
    expect(aplicada.candidates).toBe(0);
    expect(await fs.readFile(path.join(raiz, chave))).toEqual(lixo);
    expect((await prisma.serviceOrderEvidence.findUniqueOrThrow({ where: { id: linha.id } })).storageKey).toBe(
      chave,
    );
    expect(
      (await prisma.serviceOrderEvidence.findUniqueOrThrow({ where: { id: trocado.linha.id } })).storageKey,
    ).toBe(trocado.chave);
  });
});

describe("LEGACY-06 · a empresa e o tipo certos, e nenhum dado de pessoa no relatório", () => {
  it("achados de duas empresas chegam separados, só com ids", async () => {
    const a = await evidenciaLegada(fixture.companyA.id, montarJpeg({ comGps: true }));
    const b = await evidenciaLegada(fixture.companyB.id, montarJpeg({ comGps: true }));

    const r = await auditPhotoStorage({ storage });

    expect(r.legacy).toHaveLength(2);
    const porId = new Map(r.legacy.map((f) => [f.id, f]));
    expect(porId.get(a.linha.id)?.companyId).toBe(fixture.companyA.id);
    expect(porId.get(b.linha.id)?.companyId).toBe(fixture.companyB.id);

    const texto = JSON.stringify(r);
    expect(texto).not.toContain("Cliente Legado Sigiloso");
    expect(texto).not.toContain("piloto-original");
    expect(texto).not.toContain(raiz);
  });
});

describe("LEGACY-APPLY · re-sanitização aplicada, sem destruir a original", () => {
  it("a linha passa a apontar para a versão limpa; a original fica; fechamento e assinatura não mudam", async () => {
    const original = montarJpeg({ comGps: true, orientacao: 6 });
    const { linha, chave, ordemId } = await evidenciaLegada(fixture.companyA.id, original);
    const hashFechamento = () =>
      prisma.$transaction((tx) => closingContentHash(tx, fixture.companyA.id, ordemId));
    const fechamentoAntes = await hashFechamento();

    const r = await resanitizeLegacyPhotos({ storage, apply: true });
    expect(r).toEqual({ apply: true, candidates: 1, resanitized: 1, skippedChanged: 0, failed: 0 });

    const depois = await prisma.serviceOrderEvidence.findUniqueOrThrow({ where: { id: linha.id } });
    expect(depois.storageKey).not.toBe(chave);
    expect(depois.storageKey.startsWith(`${fixture.companyA.id}/${ordemId}/`)).toBe(true);
    const limpo = await fs.readFile(path.join(raiz, depois.storageKey));
    expect(lerExif(limpo).tagsGps).toEqual([]);
    expect(lerExif(limpo).orientacao).toBe(6);
    expect(depois.sizeBytes).toBe(limpo.byteLength);
    expect(depois.contentHash).toBe(createHash("sha256").update(limpo).digest("hex"));

    // A original NÃO foi destruída: continua no disco, sem linha.
    expect(await fs.readFile(path.join(raiz, chave))).toEqual(original);
    // O hash do fechamento usa id e categoria, nunca bytes.
    expect(await hashFechamento()).toBe(fechamentoAntes);

    const auditoria = await prisma.auditLog.findFirstOrThrow({
      where: { action: "STORAGE.PHOTO_RESANITIZED", entityId: linha.id },
    });
    expect(auditoria.companyId).toBe(fixture.companyA.id);
    expect(auditoria.details).not.toContain(chave);

    // Idempotente: rodar de novo não acha mais nada.
    expect((await resanitizeLegacyPhotos({ storage, apply: true })).candidates).toBe(0);

    // A original virou órfã — mas só sai depois da carência, por outra ordem.
    const agora = await auditPhotoStorage({ storage });
    expect(agora.recentUnreferenced).toBe(1);
    expect(agora.orphans).toEqual([]);
  });

  it("a linha mudou no meio: nada é ligado, e o blob novo é recolhido", async () => {
    const { linha, chave } = await evidenciaLegada(fixture.companyA.id, montarJpeg({ comGps: true }));
    const outra = chaveDe(fixture.companyA.id, "concorrente");
    await gravarNoDisco(outra, montarJpegSimples());

    // Entre gravar a versão limpa e ligá-la, outro fluxo repõe a linha.
    const concorrente: FileStorageContract = {
      ...storage,
      put: async (k, d, m) => {
        const r = await storage.put(k, d, m);
        await prisma.serviceOrderEvidence.update({ where: { id: linha.id }, data: { storageKey: outra } });
        return r;
      },
      get: (k) => storage.get(k),
      delete: (k) => storage.delete(k),
      exists: (k) => storage.exists(k),
      list: () => storage.list(),
    };

    const r = await resanitizeLegacyPhotos({ storage: concorrente, apply: true });

    expect(r.skippedChanged).toBe(1);
    expect(r.resanitized).toBe(0);
    expect((await prisma.serviceOrderEvidence.findUniqueOrThrow({ where: { id: linha.id } })).storageKey).toBe(
      outra,
    );
    const arquivos = Object.keys(await hashesDoDisco()).sort();
    expect(arquivos).toEqual([chave, outra].sort());
  });
});

describe("ORPHAN-01/02 · órfão é arquivo sem linha e velho; referenciado nunca é", () => {
  it("arquivo sem linha e antigo é candidato; referenciado e antigo, não", async () => {
    const { chave: referenciada } = await evidenciaLegada(fixture.companyA.id, montarJpegSimples());
    await envelhecer(referenciada);
    const semLinha = chaveDe(fixture.companyA.id, "sobra");
    await gravarNoDisco(semLinha, montarJpegSimples());
    await envelhecer(semLinha);

    const r = await auditPhotoStorage({ storage });

    expect(r.storageFiles).toBe(2);
    expect(r.orphans).toEqual([semLinha]);
    expect(r.orphans).not.toContain(referenciada);
  });

  it("arquivo sem linha RECENTE não é candidato — pode ser upload em andamento", async () => {
    const recente = chaveDe(EMPRESA_INEXISTENTE, "emandamento");
    await gravarNoDisco(recente, montarJpegSimples());

    const r = await auditPhotoStorage({ storage });
    expect(r.recentUnreferenced).toBe(1);
    expect(r.orphans).toEqual([]);

    const expurgo = await purgeOrphanFiles({ storage, apply: true, ...MISSING });
    expect(expurgo.deleted).toBe(0);
    expect(existsSync(path.join(raiz, recente))).toBe(true);
  });

  it("chave de empresa que não existe mais é contada à parte (resíduo)", async () => {
    const fantasma = chaveDe(EMPRESA_INEXISTENTE, "sobra");
    await gravarNoDisco(fantasma, montarJpegSimples());
    await envelhecer(fantasma);

    const r = await auditPhotoStorage({ storage });
    expect(r.orphansOfMissingCompanies).toBe(1);
  });
});

describe("ORPHAN-03 · referência de OUTRA empresa protege o arquivo", () => {
  it("arquivo sob prefixo de empresa INEXISTENTE, referenciado por linha da B, não é órfão nem é apagado", async () => {
    // O pior caso para o escopo missing-company: o prefixo diz "resíduo", a linha diz "em uso".
    const chave = chaveDe(EMPRESA_INEXISTENTE, "cruzada");
    await gravarNoDisco(chave, montarJpegSimples());
    await envelhecer(chave);
    await prisma.cTO.create({
      data: { companyId: fixture.companyB.id, name: "CTO da B", capacity: 2, photoStorageKey: chave },
    });

    const r = await auditPhotoStorage({ storage });
    expect(r.orphans).not.toContain(chave);
    expect(r.missingCompanyOrphans).not.toContain(chave);

    const expurgo = await purgeOrphanFiles({ storage, apply: true, ...MISSING });
    expect(expurgo.deleted).toBe(0);
    expect(existsSync(path.join(raiz, chave))).toBe(true);
  });

  it("empresa A não remove a evidência da empresa B, mesmo com o id conhecido", async () => {
    const b = await evidenciaLegada(fixture.companyB.id, montarJpegSimples());
    const tecnico = await prisma.technician.upsert({
      where: { userId: fixture.techA.id },
      update: {},
      create: { companyId: fixture.companyA.id, userId: fixture.techA.id },
    });
    const customer = await prisma.customer.create({ data: { companyId: fixture.companyA.id, name: "C" } });
    const daA = await prisma.serviceOrder.create({
      data: {
        companyId: fixture.companyA.id,
        number: await allocateTestServiceOrderNumber(fixture.companyA.id),
        customerId: customer.id,
        technicianId: tecnico.id,
        type: "Instalação",
        description: "A.",
        status: "ASSIGNED",
        assignedAt: new Date(),
      },
    });
    await startServiceOrder(fixture.companyA.id, fixture.techA.id, daA.id, daA.version);
    const versao = (await prisma.serviceOrder.findUniqueOrThrow({ where: { id: daA.id } })).version;

    await expect(
      removeEvidence(fixture.companyA.id, fixture.techA.id, daA.id, b.linha.id, versao),
    ).rejects.toMatchObject({ status: 404 });

    expect(await prisma.serviceOrderEvidence.findUnique({ where: { id: b.linha.id } })).not.toBeNull();
    expect(existsSync(path.join(raiz, b.chave))).toBe(true);
  });
});

describe("ORPHAN-04 · linha sem arquivo é outro problema, em outra contagem", () => {
  it("é apontada como ausente, não vira órfã, e o expurgo não mexe na linha", async () => {
    const { linha, chave } = await evidenciaLegada(fixture.companyA.id, montarJpegSimples());
    await fs.unlink(path.join(raiz, chave));

    const r = await auditPhotoStorage({ storage });
    expect(r.missingFiles).toBe(1);
    expect(r.missing).toEqual([{ kind: "EVIDENCE", id: linha.id, companyId: fixture.companyA.id }]);
    expect(r.orphans).toEqual([]);

    await purgeOrphanFiles({ storage, apply: true, now: depoisDaCarencia(), ...MISSING });
    expect(await prisma.serviceOrderEvidence.findUnique({ where: { id: linha.id } })).not.toBeNull();
  });
});

describe("ORPHAN-05 · expurgo: simular não apaga; aplicar apaga só o órfão", () => {
  it("controle positivo: com apply e escopo, o resíduo sai; o referenciado e o de empresa existente ficam", async () => {
    const { chave: referenciada } = await evidenciaLegada(fixture.companyA.id, montarJpegSimples());
    await envelhecer(referenciada);
    const orfao = chaveDe(EMPRESA_INEXISTENTE, "sobra");
    await gravarNoDisco(orfao, montarJpegSimples());
    await envelhecer(orfao);
    const historica = chaveDe(fixture.companyA.id, "historica");
    await gravarNoDisco(historica, montarJpegSimples());
    await envelhecer(historica);

    const simulado = await purgeOrphanFiles({ storage, apply: false });
    expect(simulado.candidates).toBe(2);
    expect(existsSync(path.join(raiz, orfao))).toBe(true);

    const aplicado = await purgeOrphanFiles({ storage, apply: true, ...MISSING });
    expect(aplicado.deleted).toBe(1);
    expect(existsSync(path.join(raiz, orfao))).toBe(false);
    expect(existsSync(path.join(raiz, historica))).toBe(true);
    expect(existsSync(path.join(raiz, referenciada))).toBe(true);
  });
});

describe("ORPHAN-06 · nada fora da raiz, nada que o AlfaOS não escreveu", () => {
  it("o padrão de chave recusa travessia, caminho absoluto e maiúsculas", () => {
    for (const ruim of [
      "../fora.jpg",
      "a/../../fora.jpg",
      "/etc/passwd",
      "C:/Windows/x.jpg",
      "a\\b\\c.jpg",
      "a/b/c.jpg\0",
      "A/b/c.jpg",
      "a/b/c/d.jpg",
      "a/b/c.svg",
    ]) {
      expect(STORAGE_KEY_PATTERN.test(ruim), ruim).toBe(false);
    }
  });

  it("delete com chave que sai da raiz é recusado, e o arquivo de fora continua lá", async () => {
    const fora = path.join(path.dirname(raiz), `fora-${randomUUID()}.jpg`);
    await fs.writeFile(fora, "fora");
    try {
      await expect(storage.delete(`../${path.basename(fora)}`)).rejects.toThrow("inválida");
      expect(existsSync(fora)).toBe(true);
    } finally {
      await fs.rm(fora, { force: true });
    }
  });

  it("linha com chave maliciosa não é lida; entrada não reconhecida é contada e nunca apagada", async () => {
    const fora = path.join(path.dirname(raiz), `alvo-${randomUUID()}.jpg`);
    await fs.writeFile(fora, montarJpeg({ comGps: true }));
    const os_ = await ordem(fixture.companyA.id);
    await prisma.serviceOrderEvidence.create({
      data: {
        companyId: fixture.companyA.id,
        serviceOrderId: os_.id,
        storageKey: `../${path.basename(fora)}`,
        originalName: "x.jpg",
        mimeType: "image/jpeg",
        sizeBytes: 1,
      },
    });
    const estranho = path.join(raiz, fixture.companyA.id, "Leia-me.TXT");
    await fs.mkdir(path.dirname(estranho), { recursive: true });
    await fs.writeFile(estranho, "não é do AlfaOS");
    await fs.writeFile(path.join(raiz, `${randomUUID()}.jpg.tmp`), "temporario");

    try {
      const r = await auditPhotoStorage({ storage, now: depoisDaCarencia() });
      expect(r.missingFiles).toBe(1);
      expect(r.withGps).toBe(0);
      expect(r.unrecognizedEntries).toBe(2);

      const expurgo = await purgeOrphanFiles({ storage, apply: true, now: depoisDaCarencia(), ...MISSING });
      expect(expurgo.deleted).toBe(0);
      expect(existsSync(estranho)).toBe(true);
      expect(existsSync(fora)).toBe(true);
      expect(await resanitizeLegacyPhotos({ storage, apply: true })).toMatchObject({ candidates: 0 });
    } finally {
      await fs.rm(fora, { force: true });
    }
  });

  it("link simbólico dentro da raiz não é seguido", async (ctx) => {
    const alvo = await fs.mkdtemp(path.join(os.tmpdir(), "alfaos-fora-"));
    await fs.writeFile(path.join(alvo, "a".repeat(32) + ".jpg"), montarJpegSimples());
    const link = path.join(raiz, fixture.companyA.id);
    try {
      await fs.symlink(alvo, link, "junction");
    } catch {
      ctx.skip();
      return;
    }
    try {
      const listados: string[] = [];
      for await (const e of storage.list()) listados.push(e.key);
      expect(listados.some((k) => k.endsWith(".jpg"))).toBe(false);
      await purgeOrphanFiles({ storage, apply: true, now: depoisDaCarencia(), ...MISSING });
      expect(existsSync(path.join(alvo, "a".repeat(32) + ".jpg"))).toBe(true);
    } finally {
      await fs.rm(link, { force: true, recursive: false }).catch(() => undefined);
      await fs.rm(alvo, { recursive: true, force: true });
    }
  });
});

describe("PURGE-07 · a corrida do expurgo de órfãos", () => {
  it("classificado como órfão, ligado a uma linha antes de apagar: FICA", async () => {
    const chave = chaveDe(EMPRESA_INEXISTENTE, "religada");
    await gravarNoDisco(chave, montarJpegSimples());
    await envelhecer(chave);

    const r = await purgeOrphanFiles({
      storage,
      apply: true,
      ...MISSING,
      // Entre a classificação e a exclusão, outro fluxo liga o arquivo.
      beforeDelete: async (k) => {
        await prisma.cTO.create({
          data: { companyId: fixture.companyA.id, name: `CTO ${k.slice(-8)}`, capacity: 2, photoStorageKey: k },
        });
      },
    });

    expect(r).toMatchObject({ candidates: 1, deleted: 0, relinked: 1 });
    expect(existsSync(path.join(raiz, chave))).toBe(true);
  });
});

describe("ORPHAN-REF-COLUMNS · toda coluna de chave de storage entra na definição de referência", () => {
  it("o schema não tem chave de storage fora das três colunas conhecidas", () => {
    const schema = readFileSync(path.join(process.cwd(), "prisma/schema.prisma"), "utf8");
    const encontradas: string[] = [];
    let modelo = "";
    for (const linha of schema.split(/\r?\n/)) {
      const m = linha.match(/^model\s+(\w+)\s*\{/);
      if (m) modelo = m[1];
      const campo = linha.match(/^\s+(\w*[sS]torageKey\w*)\s+String/);
      if (campo) encontradas.push(`${modelo}.${campo[1]}`);
    }
    expect(encontradas.sort()).toEqual([...STORAGE_REFERENCE_COLUMNS].sort());
  });
});
