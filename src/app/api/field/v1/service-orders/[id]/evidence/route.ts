import { createHash } from "node:crypto";
import { EvidenceCategory } from "@prisma/client";
import { assertCanExecute } from "@/lib/field/auth";
import { FieldError } from "@/lib/field/errors";
import { parseIdempotencyKey, withIdempotency } from "@/lib/field/idempotency";
import { fieldOk, runFieldApi } from "@/lib/field/response";
import { requireFieldPrincipal } from "@/lib/field/route";
import { addEvidence, EVIDENCE_MAX_BYTES } from "@/lib/service-order-closing";
import { INT32_MAX } from "@/lib/version";

/**
 * `POST /api/field/v1/service-orders/:id/evidence`
 *
 * Anexa uma foto categorizada à OS.
 *
 * ## Multipart, não JSON com base64
 *
 * Base64 infla 33% e obrigaria a carregar a imagem inteira como string em
 * memória, no aparelho e no servidor. Multipart é o formato nativo do upload e
 * é o que o `File` do Next entrega sem cópia extra.
 *
 * ## Só três campos são lidos do formulário
 *
 * `file`, `expectedOrderVersion` e `category` (mais `caption` e `capturedAt`,
 * opcionais). Partes extras são IGNORADAS — `companyId`, `technicianId`,
 * `storageKey` enviados pelo aplicativo não têm como chegar a um `data` do
 * Prisma. É a mesma garantia que `.strict()` dá ao JSON, obtida por não ler.
 *
 * ## Idempotência inclui os BYTES
 *
 * A impressão digital carrega o SHA-256 do arquivo. Sem isso, a mesma chave
 * reapresentada com outra foto devolveria o desfecho da primeira, e o técnico
 * perderia a segunda achando que subiu.
 *
 * ## Validação de arquivo
 *
 * Tamanho recusado pelo tamanho DECLARADO antes de bufferizar, para não
 * materializar um upload grande só para recusá-lo. Tipo real decidido pelo
 * número mágico dos bytes em `addEvidence` — nunca pela extensão nem pelo
 * `Content-Type`, ambos escolhidos pelo cliente. `.exe` renomeado `.jpg` não
 * passa, e SVG não é aceito em formato nenhum porque carrega script.
 */

/** Os valores REAIS do enum. Ver o comentário na leitura de `category`. */
const EVIDENCE_CATEGORIES = new Set<string>(Object.values(EvidenceCategory));

export async function POST(
  request: Request,
  context: { params: { id: string } },
) {
  return runFieldApi(async () => {
    const principal = await requireFieldPrincipal(request);
    assertCanExecute(principal);

    const key = parseIdempotencyKey(request);

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw new FieldError("VALIDATION_ERROR", "Envio inválido.");
    }

    const file = form.get("file");
    if (!(file instanceof File)) {
      throw new FieldError("VALIDATION_ERROR", "Arquivo é obrigatório.");
    }
    if (file.size > EVIDENCE_MAX_BYTES) {
      throw new FieldError(
        "VALIDATION_ERROR",
        `Imagem muito grande (máximo ${Math.floor(EVIDENCE_MAX_BYTES / 1024 / 1024)} MB).`,
      );
    }

    const rawVersion = form.get("expectedOrderVersion");
    const expectedOrderVersion = Number(rawVersion);
    if (
      rawVersion === null ||
      !Number.isInteger(expectedOrderVersion) ||
      expectedOrderVersion < 0 ||
      expectedOrderVersion > INT32_MAX
    ) {
      throw new FieldError("VALIDATION_ERROR", "Versão inválida.");
    }

    /*
      Categoria validada por VALOR, nunca com `in`.

      `rawCategory in EvidenceCategory` percorre a cadeia de protótipos, então
      `toString`, `constructor`, `hasOwnProperty` e `__proto__` passavam pela
      conferência — eram "chaves" de `Object.prototype` — e chegavam ao Prisma
      como valor de enum. O Prisma recusava, mas com erro de validação de
      cliente, que o envelope traduz em `INTERNAL` (500). E `INTERNAL` é
      `retryable`, então uma recusa que NUNCA vira sucesso era anunciada ao
      aplicativo como transitória, e o Flutter reenviava.

      `EVIDENCE_CATEGORIES` compara contra os valores reais do enum. O `Set` é
      construído uma vez, no módulo, e não a cada upload.
    */
    const rawCategory = form.get("category");
    const category =
      typeof rawCategory === "string" && EVIDENCE_CATEGORIES.has(rawCategory)
        ? (rawCategory as EvidenceCategory)
        : null;
    if (rawCategory !== null && category === null) {
      throw new FieldError("VALIDATION_ERROR", "Categoria de evidência inválida.");
    }

    const rawCaption = form.get("caption");
    const caption = typeof rawCaption === "string" ? rawCaption : null;

    // Carimbo do aparelho. Informativo: o relógio do celular é ajustável pelo
    // próprio usuário, então o que vale para integridade é `createdAt`, gravado
    // pelo servidor quando o arquivo chegou (PRD §162).
    const rawCapturedAt = form.get("capturedAt");
    let capturedAt: Date | null = null;
    if (typeof rawCapturedAt === "string" && rawCapturedAt.length > 0) {
      const parsed = new Date(rawCapturedAt);
      if (Number.isNaN(parsed.getTime())) {
        throw new FieldError("VALIDATION_ERROR", "Data de captura inválida.");
      }
      capturedAt = parsed;
    }

    const data = Buffer.from(await file.arrayBuffer());
    const contentHash = createHash("sha256").update(data).digest("hex");
    const orderId = context.params.id;

    const outcome = await withIdempotency(
      principal,
      "service-order.evidence.add",
      key,
      { orderId, expectedOrderVersion, category, contentHash },
      async () => {
        const evidence = await addEvidence(
          principal.user.companyId,
          principal.user.id,
          orderId,
          {
            data,
            declaredMimeType: file.type,
            originalName: file.name,
            expectedOrderVersion,
            category: category ?? "OTHER",
            caption,
            capturedAt,
          },
        );

        return {
          status: 201,
          resourceId: evidence.id,
          body: {
            evidence: {
              id: evidence.id,
              category: evidence.category,
              caption: evidence.caption,
              mimeType: evidence.mimeType,
              sizeBytes: evidence.sizeBytes,
              createdAt: evidence.createdAt.toISOString(),
            },
          },
        };
      },
    );

    return fieldOk(outcome.body, outcome.status);
  });
}
