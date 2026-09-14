import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  MULTIPART_FORM_OVERHEAD_BYTES,
  multipartBodyLimit,
  parseContentLength,
  readMultipartWithinLimit,
} from "@/lib/multipart-limit";
import { EVIDENCE_MAX_BYTES, SIGNATURE_MAX_BYTES } from "@/lib/service-order-closing";
import { CTO_PHOTO_MAX_BYTES } from "@/lib/cto";
import { startServiceOrder } from "@/lib/service-orders";
import { LocalFileStorageAdapter, setFileStorage } from "@/lib/storage";
import { POST as webEvidence } from "@/app/api/service-orders/[id]/evidence/route";
import { PUT as webSignature } from "@/app/api/service-orders/[id]/signature/route";
import { POST as fieldEvidence } from "@/app/api/field/v1/service-orders/[id]/evidence/route";
import { PUT as fieldSignature } from "@/app/api/field/v1/service-orders/[id]/signature/route";
import { POST as ctoPhoto } from "@/app/api/ctos/[id]/photo/route";
import {
  allocateTestServiceOrderNumber,
  createTokenFor,
  registerTestDevice,
  seedTestData,
  type TestFixture,
} from "./helpers";
import { montarPng } from "./support/jpeg-exif";

/**
 * RC-STO-01 — o corpo multipart é limitado ANTES de ser materializado.
 *
 * As cinco rotas de upload chamavam `request.formData()` e só depois olhavam
 * `file.size`: àquela altura o corpo inteiro já estava na memória do processo
 * — que é um só, e atende todas as empresas. A checagem do tamanho vinha tarde
 * demais para proteger o que ela dizia proteger.
 *
 * O Next 14 entrega ao route handler o CORPO EM FLUXO (nada é bufferizado antes
 * dele sem middleware), então dá para recusar de verdade: pelo
 * `Content-Length` sem ler nada, e pela contagem de bytes durante a leitura
 * quando o cabeçalho falta ou mente.
 */

let storageRoot: string;
let fixture: TestFixture;

beforeAll(async () => {
  storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "alfaos-multipart-"));
  setFileStorage(new LocalFileStorageAdapter(storageRoot));
});

afterAll(async () => {
  setFileStorage(null);
  await fs.rm(storageRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  fixture = await seedTestData();
});

// ---------------------------------------------------------------------------
// Corpo de teste
// ---------------------------------------------------------------------------

/** Multipart serializado de verdade, com o boundary que o runtime escolher. */
async function serializar(
  form: FormData,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; contentType: string }> {
  const res = new Response(form);
  return {
    bytes: new Uint8Array(await res.arrayBuffer()),
    contentType: res.headers.get("content-type") ?? "",
  };
}

/**
 * Um corpo que CONTA o que foi lido dele.
 *
 * É a única forma de afirmar "não foi materializado": se a recusa vier antes
 * da leitura, `lidos` fica em zero; se vier durante, fica perto do limite — e
 * nunca perto do tamanho total anunciado.
 */
function corpoContado(totalBytes: number, pedaco = 64 * 1024) {
  const estado = { lidos: 0, cancelado: false };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (estado.lidos >= totalBytes) {
          controller.close();
          return;
        }
        const n = Math.min(pedaco, totalBytes - estado.lidos);
        estado.lidos += n;
        controller.enqueue(new Uint8Array(n));
      },
      cancel() {
        estado.cancelado = true;
      },
    },
    /*
      `highWaterMark: 0`: o fluxo só produz quando alguém PEDE. Com o padrão (1),
      ele já enfileira um pedaço sozinho ao nascer, e a contagem mediria o que
      o fluxo produziu — não o que a rota leu. Foi assim que a primeira versão
      deste teste acusou 64 KiB "lidos" numa recusa que não leu nada.
    */
    { highWaterMark: 0 },
  );
  return { stream, estado };
}

function pedido(
  url: string,
  options: {
    method?: string;
    body: BodyInit | ReadableStream<Uint8Array>;
    contentType?: string;
    contentLength?: string;
    headers?: Record<string, string>;
  },
): Request {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  headers["content-type"] = options.contentType ?? "multipart/form-data; boundary=x";
  if (options.contentLength !== undefined) headers["content-length"] = options.contentLength;
  return new Request(`http://localhost${url}`, {
    method: options.method ?? "POST",
    headers,
    body: options.body as BodyInit,
    duplex: "half",
  } as RequestInit);
}

// ---------------------------------------------------------------------------
// A primitiva
// ---------------------------------------------------------------------------

describe("parseContentLength", () => {
  it("ausente é null; inteiro sem sinal é o número", () => {
    expect(parseContentLength(null)).toBeNull();
    expect(parseContentLength("0")).toBe(0);
    expect(parseContentLength("1024")).toBe(1024);
  });

  it.each(["abc", "-1", "1.5", "1e3", "+10", "", " ", "10, 20", "0x10", "9".repeat(30)])(
    "recusa %j como inválido",
    (valor) => {
      expect(parseContentLength(valor)).toBe("invalid");
    },
  );
});

describe("readMultipartWithinLimit", () => {
  const LIMITE = 4096;

  it("abaixo do limite: devolve o formulário, com o arquivo inteiro", async () => {
    const form = new FormData();
    form.set("file", new File([new Uint8Array(1000)], "a.png", { type: "image/png" }));
    form.set("expectedOrderVersion", "3");
    const { bytes, contentType } = await serializar(form);

    const r = await readMultipartWithinLimit(
      pedido("/x", { body: bytes, contentType, contentLength: String(bytes.byteLength) }),
      LIMITE,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const file = r.form.get("file") as File;
    expect(file.size).toBe(1000);
    expect(r.form.get("expectedOrderVersion")).toBe("3");
  });

  it("EXATAMENTE no limite: aceito (o teto é inclusivo)", async () => {
    const vazio = await serializar(
      (() => {
        const f = new FormData();
        f.set("file", new File([new Uint8Array(0)], "a.png", { type: "image/png" }));
        return f;
      })(),
    );
    const moldura = vazio.bytes.byteLength;
    const form = new FormData();
    form.set("file", new File([new Uint8Array(LIMITE - moldura)], "a.png", { type: "image/png" }));
    const { bytes, contentType } = await serializar(form);
    expect(bytes.byteLength).toBe(LIMITE); // pré-condição: o corpo tem o tamanho do teto

    const comCabecalho = await readMultipartWithinLimit(
      pedido("/x", { body: bytes, contentType, contentLength: String(LIMITE) }),
      LIMITE,
    );
    expect(comCabecalho.ok).toBe(true);

    const semCabecalho = await readMultipartWithinLimit(
      pedido("/x", { body: bytes, contentType }),
      LIMITE,
    );
    expect(semCabecalho.ok).toBe(true);
  });

  it("um byte acima do limite: recusado, com e sem Content-Length", async () => {
    const form = new FormData();
    form.set("file", new File([new Uint8Array(LIMITE)], "a.png", { type: "image/png" }));
    const { bytes, contentType } = await serializar(form);
    expect(bytes.byteLength).toBeGreaterThan(LIMITE);

    const comCabecalho = await readMultipartWithinLimit(
      pedido("/x", { body: bytes, contentType, contentLength: String(bytes.byteLength) }),
      LIMITE,
    );
    expect(comCabecalho).toEqual({ ok: false, reason: "TOO_LARGE" });

    const semCabecalho = await readMultipartWithinLimit(pedido("/x", { body: bytes, contentType }), LIMITE);
    expect(semCabecalho).toEqual({ ok: false, reason: "TOO_LARGE" });
  });

  it("Content-Length acima: recusa SEM ler um byte, e sem chamar formData()", async () => {
    const { stream, estado } = corpoContado(50 * 1024 * 1024);
    const req = pedido("/x", { body: stream, contentLength: String(50 * 1024 * 1024) });
    const formData = vi.spyOn(req, "formData");

    const r = await readMultipartWithinLimit(req, LIMITE);
    expect(r).toEqual({ ok: false, reason: "TOO_LARGE" });
    expect(estado.lidos).toBe(0);
    expect(formData).not.toHaveBeenCalled();
  });

  it.each(["abc", "-1", "1.5", ""])(
    "Content-Length inválido (%j): recusa sem ler o corpo",
    async (valor) => {
      const { stream, estado } = corpoContado(10_000);
      const req = pedido("/x", { body: stream, contentLength: valor });
      const r = await readMultipartWithinLimit(req, LIMITE);
      expect(r).toEqual({ ok: false, reason: "INVALID_LENGTH" });
      expect(estado.lidos).toBe(0);
    },
  );

  it("sem Content-Length e com corpo gigante: para no teto e cancela o fluxo", async () => {
    const { stream, estado } = corpoContado(200 * 1024 * 1024, 16 * 1024);
    const req = pedido("/x", { body: stream });
    const formData = vi.spyOn(req, "formData");

    const r = await readMultipartWithinLimit(req, LIMITE);
    expect(r).toEqual({ ok: false, reason: "TOO_LARGE" });
    // Leu no máximo o teto mais um pedaço — nunca os 200 MB anunciados pelo fluxo.
    expect(estado.lidos).toBeLessThanOrEqual(LIMITE + 16 * 1024);
    expect(estado.cancelado).toBe(true);
    expect(formData).not.toHaveBeenCalled();
  });

  it("Content-Length que MENTE (diz pouco, manda muito): a contagem ainda para no teto", async () => {
    const { stream, estado } = corpoContado(10 * 1024 * 1024, 16 * 1024);
    const req = pedido("/x", { body: stream, contentLength: "100" });
    const r = await readMultipartWithinLimit(req, LIMITE);
    expect(r).toEqual({ ok: false, reason: "TOO_LARGE" });
    expect(estado.lidos).toBeLessThanOrEqual(LIMITE + 16 * 1024);
  });

  it("corpo que não é multipart: MALFORMED, não exceção", async () => {
    const r = await readMultipartWithinLimit(
      pedido("/x", { body: "isto não é um formulário", contentType: "text/plain" }),
      LIMITE,
    );
    expect(r).toEqual({ ok: false, reason: "MALFORMED" });
  });

  it("o teto de cada rota é o do arquivo mais a moldura do formulário — os limites de tipo não mudaram", () => {
    expect(EVIDENCE_MAX_BYTES).toBe(8 * 1024 * 1024);
    expect(SIGNATURE_MAX_BYTES).toBe(2 * 1024 * 1024);
    expect(CTO_PHOTO_MAX_BYTES).toBe(8 * 1024 * 1024);
    expect(multipartBodyLimit(EVIDENCE_MAX_BYTES)).toBe(
      EVIDENCE_MAX_BYTES + MULTIPART_FORM_OVERHEAD_BYTES,
    );
  });
});

// ---------------------------------------------------------------------------
// As rotas
// ---------------------------------------------------------------------------

const GIGANTE = String(500 * 1024 * 1024);

async function tecnicoComSessao() {
  await prisma.technician.upsert({
    where: { userId: fixture.techA.id },
    update: {},
    create: { companyId: fixture.companyA.id, userId: fixture.techA.id },
  });
  return createTokenFor(fixture.techA.id);
}

describe("as cinco rotas recusam antes de materializar", () => {
  it("web · evidência: Content-Length acima do teto é 400, sem formData() e sem linha", async () => {
    const token = await tecnicoComSessao();
    const { stream, estado } = corpoContado(Number(GIGANTE));
    const req = pedido("/api/service-orders/os-x/evidence", {
      body: stream,
      contentLength: GIGANTE,
      headers: { Cookie: `alfaos_session=${encodeURIComponent(token)}` },
    });
    const formData = vi.spyOn(req, "formData");

    const res = await webEvidence(req, { params: { id: "os-x" } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/muito grande/i);
    expect(formData).not.toHaveBeenCalled();
    expect(estado.lidos).toBe(0);
    expect(await prisma.serviceOrderEvidence.count()).toBe(0);
  });

  it("web · evidência: sem sessão continua 401 — o teto não passa na frente da autenticação", async () => {
    const { stream } = corpoContado(1024);
    const res = await webEvidence(
      pedido("/api/service-orders/os-x/evidence", { body: stream, contentLength: GIGANTE }),
      { params: { id: "os-x" } },
    );
    expect(res.status).toBe(401);
  });

  it("web · evidência: Content-Length inválido é 400 'Envio inválido.'", async () => {
    const token = await tecnicoComSessao();
    const res = await webEvidence(
      pedido("/api/service-orders/os-x/evidence", {
        body: corpoContado(10).stream,
        contentLength: "abc",
        headers: { Cookie: `alfaos_session=${encodeURIComponent(token)}` },
      }),
      { params: { id: "os-x" } },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Envio inválido.");
  });

  it("web · assinatura: acima do teto é 400, sem formData()", async () => {
    const token = await tecnicoComSessao();
    const req = pedido("/api/service-orders/os-x/signature", {
      method: "PUT",
      body: corpoContado(Number(GIGANTE)).stream,
      contentLength: GIGANTE,
      headers: { Cookie: `alfaos_session=${encodeURIComponent(token)}` },
    });
    const formData = vi.spyOn(req, "formData");
    const res = await webSignature(req, { params: { id: "os-x" } });
    expect(res.status).toBe(400);
    expect(formData).not.toHaveBeenCalled();
  });

  it("Field · evidência: acima do teto é VALIDATION_ERROR, sem formData()", async () => {
    await tecnicoComSessao();
    const { token } = await registerTestDevice(fixture.techA.id);
    const req = pedido("/api/field/v1/service-orders/os-x/evidence", {
      body: corpoContado(Number(GIGANTE)).stream,
      contentLength: GIGANTE,
      headers: { Authorization: `Bearer ${token}`, "Idempotency-Key": "k-multipart-1" },
    });
    const formData = vi.spyOn(req, "formData");
    const res = await fieldEvidence(req, { params: { id: "os-x" } });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toMatch(/muito grande/i);
    expect(formData).not.toHaveBeenCalled();
  });

  it("Field · assinatura: acima do teto é VALIDATION_ERROR, sem formData()", async () => {
    await tecnicoComSessao();
    const { token } = await registerTestDevice(fixture.techA.id);
    const req = pedido("/api/field/v1/service-orders/os-x/signature", {
      method: "PUT",
      body: corpoContado(Number(GIGANTE)).stream,
      contentLength: GIGANTE,
      headers: { Authorization: `Bearer ${token}`, "Idempotency-Key": "k-multipart-2" },
    });
    const formData = vi.spyOn(req, "formData");
    const res = await fieldSignature(req, { params: { id: "os-x" } });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
    expect(formData).not.toHaveBeenCalled();
  });

  it("CTO · foto: acima do teto é 400, sem formData()", async () => {
    await prisma.company.update({
      where: { id: fixture.companyA.id },
      data: { ctoNetworkEnabled: true },
    });
    const token = await createTokenFor(fixture.adminA.id);
    const req = pedido("/api/ctos/cto-x/photo", {
      body: corpoContado(Number(GIGANTE)).stream,
      contentLength: GIGANTE,
      headers: { Cookie: `alfaos_session=${encodeURIComponent(token)}` },
    });
    const formData = vi.spyOn(req, "formData");
    const res = await ctoPhoto(req, { params: { id: "cto-x" } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/muito grande/i);
    expect(formData).not.toHaveBeenCalled();
  });

  it("upload legítimo COM Content-Length correto continua funcionando (201)", async () => {
    await tecnicoComSessao();
    const tecnico = await prisma.technician.findFirstOrThrow({ where: { userId: fixture.techA.id } });
    const cliente = await prisma.customer.create({
      data: { companyId: fixture.companyA.id, name: "Cliente Upload" },
    });
    const ordem = await prisma.serviceOrder.create({
      data: {
        companyId: fixture.companyA.id,
        number: await allocateTestServiceOrderNumber(fixture.companyA.id),
        customerId: cliente.id,
        technicianId: tecnico.id,
        type: "Instalação",
        description: "Upload legítimo.",
        status: "ASSIGNED",
        assignedAt: new Date(),
      },
    });
    await startServiceOrder(fixture.companyA.id, fixture.techA.id, ordem.id, ordem.version);
    const emAtendimento = await prisma.serviceOrder.findUniqueOrThrow({ where: { id: ordem.id } });

    const form = new FormData();
    form.set("file", new File([new Uint8Array(montarPng())], "foto.png", { type: "image/png" }));
    form.set("expectedOrderVersion", String(emAtendimento.version));
    const { bytes, contentType } = await serializar(form);
    const token = await createTokenFor(fixture.techA.id);

    const res = await webEvidence(
      pedido(`/api/service-orders/${ordem.id}/evidence`, {
        body: bytes,
        contentType,
        contentLength: String(bytes.byteLength),
        headers: { Cookie: `alfaos_session=${encodeURIComponent(token)}` },
      }),
      { params: { id: ordem.id } },
    );
    expect(res.status).toBe(201);
    expect(await prisma.serviceOrderEvidence.count({ where: { serviceOrderId: ordem.id } })).toBe(1);
  });
});
