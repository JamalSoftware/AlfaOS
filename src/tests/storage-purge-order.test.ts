import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { createCto, setCtoPhoto } from "@/lib/cto";
import {
  addEvidence,
  putSignature,
} from "@/lib/service-order-closing";
import { addServiceOrderEquipment, removeServiceOrderEquipment } from "@/lib/service-order-equipment";
import { purgeTemporaryEvidenceCandidate } from "@/lib/field/evidence-cleanup";
import { startServiceOrder } from "@/lib/service-orders";
import {
  getFileStorage,
  LocalFileStorageAdapter,
  setFileStorage,
  type FileStorageContract,
} from "@/lib/storage";
import { isStorageKeyReferenced } from "@/lib/storage/references";
import { allocateTestServiceOrderNumber, seedTestData, type TestFixture } from "./helpers";
import { montarPngReal } from "./support/png-real";

/**
 * # RC-1E · a ordem de gravar, ligar e apagar
 *
 * Três achados da `RC-1A`, todos da mesma família — o arquivo e a linha
 * mudando em momentos diferentes, e um erro no meio:
 *
 * - `RC-STO-05` — a foto da CTO era gravada antes da transação, e ninguém a
 *   recolhia se a transação falhasse;
 * - `RC-STO-06` — o expurgo de etiqueta apagava o ARQUIVO antes da LINHA, e uma
 *   promoção no intervalo deixava a linha ligada ao equipamento sem arquivo;
 * - `RC-STO-07` — evidência e assinatura apagavam o blob em QUALQUER erro, e
 *   erro não prova que o COMMIT voltou.
 *
 * A invariante que atravessa todos: **uma linha nunca aponta para um arquivo
 * apagado por nós, e a foto válida anterior nunca some por causa de uma
 * substituição que falhou.** O preço declarado é órfão — arquivo sem linha —,
 * que a auditoria de storage enxerga.
 */

let fixture: TestFixture;
let raiz: string;

beforeAll(async () => {
  raiz = await fs.mkdtemp(path.join(os.tmpdir(), "alfaos-purge-order-"));
});
afterAll(async () => {
  setFileStorage(null);
  await fs.rm(raiz, { recursive: true, force: true });
});
beforeEach(async () => {
  setFileStorage(new LocalFileStorageAdapter(raiz));
  fixture = await seedTestData();
});
afterEach(() => {
  vi.restoreAllMocks();
});

const noDisco = (chave: string) => existsSync(path.join(raiz, chave));
const png = (lado: number) => montarPngReal(lado, lado);

/** Arquivos sob um prefixo `<empresa>/<recurso>/`, temporários inclusive. */
async function arquivosDe(prefixo: string): Promise<string[]> {
  const dir = path.join(raiz, prefixo);
  if (!existsSync(dir)) return [];
  return (await fs.readdir(dir)).sort();
}

async function ordemEmAtendimento() {
  const companyId = fixture.companyA.id;
  const customer = await prisma.customer.create({
    data: { companyId, name: "Cliente Ordem de Expurgo" },
  });
  const tecnico = await prisma.technician.upsert({
    where: { userId: fixture.techA.id },
    update: {},
    create: { companyId, userId: fixture.techA.id },
  });
  const ordem = await prisma.serviceOrder.create({
    data: {
      companyId,
      number: await allocateTestServiceOrderNumber(companyId),
      customerId: customer.id,
      technicianId: tecnico.id,
      type: "Instalação",
      description: "Ordem de expurgo.",
      status: "ASSIGNED",
      assignedAt: new Date(),
    },
  });
  await startServiceOrder(companyId, fixture.techA.id, ordem.id, ordem.version);
  return { companyId, userId: fixture.techA.id, orderId: ordem.id };
}

async function versao(orderId: string) {
  return (await prisma.serviceOrder.findUniqueOrThrow({ where: { id: orderId } })).version;
}

async function assinar(ctx: Awaited<ReturnType<typeof ordemEmAtendimento>>, data: Buffer) {
  await putSignature(ctx.companyId, ctx.userId, ctx.orderId, {
    signerName: "Cliente Teste",
    data,
    declaredMimeType: "image/png",
    expectedOrderVersion: await versao(ctx.orderId),
  });
  return (
    await prisma.serviceOrderSignature.findFirstOrThrow({ where: { serviceOrderId: ctx.orderId } })
  ).storageKey;
}

async function caixaComFoto() {
  const companyId = fixture.companyA.id;
  const cto = await createCto(companyId, fixture.adminA.id, { name: "CTO Expurgo", capacity: 4 });
  await setCtoPhoto(companyId, fixture.adminA.id, cto.id, {
    data: png(4),
    declaredMimeType: "image/png",
  });
  const chave = (await prisma.cTO.findUniqueOrThrow({ where: { id: cto.id } })).photoStorageKey!;
  return { companyId, ctoId: cto.id, chave };
}

/** A transação VOLTA: o callback roda inteiro e falha antes do COMMIT. */
function transacaoQueVolta() {
  const original = prisma.$transaction.bind(prisma);
  vi.spyOn(prisma, "$transaction").mockImplementationOnce(((fn: unknown, opcoes: unknown) =>
    original(async (tx: unknown) => {
      await (fn as (tx: unknown) => Promise<unknown>)(tx);
      throw new Error("falha simulada antes do COMMIT");
    }, opcoes as never)) as never);
}

/** O COMMIT efetiva, e o erro chega assim mesmo — a conexão caiu na resposta. */
function commitAmbiguo() {
  const original = prisma.$transaction.bind(prisma);
  vi.spyOn(prisma, "$transaction").mockImplementationOnce((async (fn: unknown, opcoes: unknown) => {
    await original(fn as never, opcoes as never);
    throw new Error("conexão caiu depois do COMMIT");
  }) as never);
}

describe("PURGE-01 · substituição bem-sucedida", () => {
  it("assinatura: a nova vale, e a anterior sai só DEPOIS do commit", async () => {
    const ctx = await ordemEmAtendimento();
    const primeira = await assinar(ctx, png(2));
    const segunda = await assinar(ctx, png(3));

    expect(segunda).not.toBe(primeira);
    expect(noDisco(segunda)).toBe(true);
    expect(noDisco(primeira)).toBe(false);
  });

  it("CTO: a nova vale, e a anterior FICA no disco — sem linha, candidata a órfã", async () => {
    const caixa = await caixaComFoto();
    await setCtoPhoto(caixa.companyId, fixture.adminA.id, caixa.ctoId, {
      data: png(5),
      declaredMimeType: "image/png",
    });
    const nova = (await prisma.cTO.findUniqueOrThrow({ where: { id: caixa.ctoId } })).photoStorageKey!;

    expect(nova).not.toBe(caixa.chave);
    expect(noDisco(nova)).toBe(true);
    // Decisão da CTO-1 preservada: substituir não apaga.
    expect(noDisco(caixa.chave)).toBe(true);
    expect(await isStorageKeyReferenced(caixa.chave)).toBe(false);
  });
});

describe("PURGE-02 · a nova falha na limpeza de metadado", () => {
  it("a assinatura anterior fica, com linha e bytes intactos, e nada novo nasce no disco", async () => {
    const ctx = await ordemEmAtendimento();
    const anterior = await assinar(ctx, png(2));
    const bytesAntes = await fs.readFile(path.join(raiz, anterior));
    const arquivosAntes = await arquivosDe(path.dirname(anterior));

    const corrompido = Buffer.concat([png(2).subarray(0, 8), Buffer.from([0, 0, 0, 99, 73, 72])]);
    await expect(assinar(ctx, corrompido)).rejects.toMatchObject({ status: 400 });

    expect(
      (await prisma.serviceOrderSignature.findFirstOrThrow({ where: { serviceOrderId: ctx.orderId } }))
        .storageKey,
    ).toBe(anterior);
    expect(await fs.readFile(path.join(raiz, anterior))).toEqual(bytesAntes);
    expect(await arquivosDe(path.dirname(anterior))).toEqual(arquivosAntes);
  });
});

describe("PURGE-03 · a gravação da nova falha", () => {
  it("CTO: a foto anterior continua sendo a da caixa, e continua no disco", async () => {
    const caixa = await caixaComFoto();
    const real = getFileStorage();
    const quebrado: FileStorageContract = {
      put: () => Promise.reject(new Error("disco cheio")),
      get: (k) => real.get(k),
      delete: (k) => real.delete(k),
      exists: (k) => real.exists(k),
      list: () => real.list(),
    };
    setFileStorage(quebrado);

    await expect(
      setCtoPhoto(caixa.companyId, fixture.adminA.id, caixa.ctoId, {
        data: png(6),
        declaredMimeType: "image/png",
      }),
    ).rejects.toThrow("disco cheio");

    expect((await prisma.cTO.findUniqueOrThrow({ where: { id: caixa.ctoId } })).photoStorageKey).toBe(
      caixa.chave,
    );
    expect(noDisco(caixa.chave)).toBe(true);
    expect(await arquivosDe(path.dirname(caixa.chave))).toEqual([path.basename(caixa.chave)]);
  });
});

describe("PURGE-04 · a ligação no banco falha", () => {
  it("CTO (RC-STO-05): a anterior fica; a nova, que ninguém referencia, é recolhida", async () => {
    const caixa = await caixaComFoto();
    transacaoQueVolta();

    await expect(
      setCtoPhoto(caixa.companyId, fixture.adminA.id, caixa.ctoId, {
        data: png(7),
        declaredMimeType: "image/png",
      }),
    ).rejects.toThrow("antes do COMMIT");

    expect((await prisma.cTO.findUniqueOrThrow({ where: { id: caixa.ctoId } })).photoStorageKey).toBe(
      caixa.chave,
    );
    expect(await arquivosDe(path.dirname(caixa.chave))).toEqual([path.basename(caixa.chave)]);
  });

  it("assinatura: a anterior fica com linha e arquivo; a nova é recolhida", async () => {
    const ctx = await ordemEmAtendimento();
    const anterior = await assinar(ctx, png(2));
    transacaoQueVolta();

    await expect(assinar(ctx, png(3))).rejects.toThrow("antes do COMMIT");

    expect(
      (await prisma.serviceOrderSignature.findFirstOrThrow({ where: { serviceOrderId: ctx.orderId } }))
        .storageKey,
    ).toBe(anterior);
    expect(await arquivosDe(path.dirname(anterior))).toEqual([path.basename(anterior)]);
  });

  it("commit AMBÍGUO (RC-STO-07): evidência gravada não perde o arquivo", async () => {
    const ctx = await ordemEmAtendimento();
    commitAmbiguo();

    await expect(
      addEvidence(ctx.companyId, ctx.userId, ctx.orderId, {
        data: png(2),
        declaredMimeType: "image/png",
        originalName: "foto.png",
        expectedOrderVersion: await versao(ctx.orderId),
      }),
    ).rejects.toThrow("depois do COMMIT");

    const linhas = await prisma.serviceOrderEvidence.findMany({ where: { serviceOrderId: ctx.orderId } });
    expect(linhas).toHaveLength(1);
    expect(noDisco(linhas[0].storageKey)).toBe(true);
  });

  it("commit AMBÍGUO numa substituição de assinatura: a linha nova não fica sem arquivo", async () => {
    const ctx = await ordemEmAtendimento();
    const anterior = await assinar(ctx, png(2));
    commitAmbiguo();

    await expect(assinar(ctx, png(3))).rejects.toThrow("depois do COMMIT");

    const atual = (
      await prisma.serviceOrderSignature.findFirstOrThrow({ where: { serviceOrderId: ctx.orderId } })
    ).storageKey;
    expect(atual).not.toBe(anterior);
    expect(noDisco(atual)).toBe(true);
  });

  it("commit AMBÍGUO na foto da CTO: a linha nova não fica sem arquivo", async () => {
    const caixa = await caixaComFoto();
    commitAmbiguo();

    await expect(
      setCtoPhoto(caixa.companyId, fixture.adminA.id, caixa.ctoId, {
        data: png(8),
        declaredMimeType: "image/png",
      }),
    ).rejects.toThrow("depois do COMMIT");

    const atual = (await prisma.cTO.findUniqueOrThrow({ where: { id: caixa.ctoId } })).photoStorageKey!;
    expect(atual).not.toBe(caixa.chave);
    expect(noDisco(atual)).toBe(true);
  });
});

describe("PURGE-05 · a corrida do expurgo de etiqueta (RC-STO-06)", () => {
  async function etiquetaTemporaria() {
    const ctx = await ordemEmAtendimento();
    const ev = await addEvidence(ctx.companyId, ctx.userId, ctx.orderId, {
      data: png(2),
      declaredMimeType: "image/png",
      originalName: "etiqueta.png",
      category: "EQUIPMENT_LABEL",
      expectedOrderVersion: await versao(ctx.orderId),
    });
    const linha = await prisma.serviceOrderEvidence.findUniqueOrThrow({ where: { id: ev.id } });
    return { ctx, candidato: { id: linha.id, storageKey: linha.storageKey } };
  }

  it("promovida DEPOIS da conferência de vínculo e antes da exclusão: a foto do equipamento NÃO some", async () => {
    /*
      A corrida exata da RC-STO-06. Promover ANTES de chamar o expurgo não a
      exercita: a conferência de vínculo já veria o equipamento e devolveria
      "kept" — medido, a sabotagem que volta a apagar o arquivo antes da linha
      passava por um teste montado assim. A promoção precisa acontecer DEPOIS da
      conferência, que é quando só a ordem linha→arquivo protege a foto.
    */
    const { ctx, candidato } = await etiquetaTemporaria();
    const depois = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);

    const desfecho = await purgeTemporaryEvidenceCandidate(getFileStorage(), candidato, depois, async () => {
      await addServiceOrderEquipment(ctx.companyId, ctx.userId, ctx.orderId, {
        expectedOrderVersion: await versao(ctx.orderId),
        equipmentType: "ONU",
        labelEvidenceId: candidato.id,
      });
    });

    expect(desfecho).toBe("kept");
    const linha = await prisma.serviceOrderEvidence.findUniqueOrThrow({ where: { id: candidato.id } });
    expect(linha.status).toBe("COMMITTED");
    expect(noDisco(candidato.storageKey)).toBe(true);
  });

  it("promovida e REBAIXADA no intervalo, com prazo novo: não é mais deste expurgo", async () => {
    const { ctx, candidato } = await etiquetaTemporaria();
    const equipamento = await addServiceOrderEquipment(ctx.companyId, ctx.userId, ctx.orderId, {
      expectedOrderVersion: await versao(ctx.orderId),
      equipmentType: "ONU",
      labelEvidenceId: candidato.id,
    });
    await removeServiceOrderEquipment(
      ctx.companyId,
      ctx.userId,
      ctx.orderId,
      equipamento.id,
      await versao(ctx.orderId),
    );

    const desfecho = await purgeTemporaryEvidenceCandidate(getFileStorage(), candidato, new Date());

    expect(desfecho).toBe("kept");
    expect((await prisma.serviceOrderEvidence.findUnique({ where: { id: candidato.id } }))?.status).toBe(
      "TEMPORARY",
    );
    expect(noDisco(candidato.storageKey)).toBe(true);
  });

  it("controle positivo: a vencida sem vínculo sai — linha E arquivo", async () => {
    const { candidato } = await etiquetaTemporaria();
    const depois = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);

    const desfecho = await purgeTemporaryEvidenceCandidate(getFileStorage(), candidato, depois);

    expect(desfecho).toBe("deleted");
    expect(await prisma.serviceOrderEvidence.findUnique({ where: { id: candidato.id } })).toBeNull();
    expect(noDisco(candidato.storageKey)).toBe(false);
  });
});

describe("PURGE-06 · o processo morre no meio da gravação", () => {
  it("a chave final ou não existe, ou tem o arquivo inteiro — e nenhum temporário sobra", async () => {
    const storage = new LocalFileStorageAdapter(raiz);
    const chave = `${fixture.companyA.id.toLowerCase()}/atomico/${"a".repeat(32)}.png`;
    vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("processo interrompido"));

    await expect(storage.put(chave, png(2), "image/png")).rejects.toThrow("interrompido");
    expect(noDisco(chave)).toBe(false);
    expect(await arquivosDe(path.dirname(chave))).toEqual([]);

    // Controle: sem a interrupção, grava inteiro e também não deixa temporário.
    await storage.put(chave, png(2), "image/png");
    expect(await fs.readFile(path.join(raiz, chave))).toEqual(png(2));
    expect(await arquivosDe(path.dirname(chave))).toEqual([path.basename(chave)]);
  });
});
