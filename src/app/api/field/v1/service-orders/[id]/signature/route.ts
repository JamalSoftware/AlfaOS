import { createHash } from "node:crypto";
import { assertCanExecute } from "@/lib/field/auth";
import { FieldError } from "@/lib/field/errors";
import { parseIdempotencyKey, withIdempotency } from "@/lib/field/idempotency";
import { fieldOk, runFieldApi } from "@/lib/field/response";
import { requireFieldPrincipal } from "@/lib/field/route";
import { putSignature, SIGNATURE_MAX_BYTES } from "@/lib/service-order-closing";
import { INT32_MAX } from "@/lib/version";

/**
 * `PUT /api/field/v1/service-orders/:id/signature`
 *
 * Recolhe (ou substitui) a assinatura do cliente.
 *
 * `PUT`, não `POST`: há no máximo uma assinatura por OS, e redesenhar
 * SUBSTITUI a anterior em vez de acumular. Isso mantém "a assinatura"
 * inequívoca no fechamento.
 *
 * ## O que a assinatura sela
 *
 * `putSignature` grava, junto, o resumo do conteúdo do atendimento naquele
 * instante. Qualquer mudança posterior — outra foto, outro material, outro
 * texto — torna a assinatura OBSOLETA, e a conclusão recusa até ela ser
 * recolhida de novo (§37). Sem esse vínculo, a assinatura provaria apenas que
 * alguém desenhou num vidro.
 *
 * ## Assinatura vazia
 *
 * Recusada antes de chegar ao domínio pelo tamanho, e no domínio pelo conteúdo:
 * os bytes precisam ser uma imagem raster válida. Um canvas em branco enviado
 * como PNG é tecnicamente uma imagem válida — a conferência de "não está em
 * branco" é do aplicativo, que sabe se houve traço; o servidor garante que é
 * uma imagem, que pertence a esta OS e que corresponde ao conteúdo assinado.
 *
 * ## Não é autenticação
 *
 * A assinatura confirma recebimento e execução. Ela não autentica juridicamente
 * a identidade de quem assinou além do que o contrato entre empresa e cliente
 * já previr, e o AlfaOS não afirma o contrário em lugar nenhum.
 */
export async function PUT(
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
      throw new FieldError("VALIDATION_ERROR", "Imagem da assinatura é obrigatória.");
    }
    if (file.size > SIGNATURE_MAX_BYTES) {
      throw new FieldError("VALIDATION_ERROR", "Imagem de assinatura muito grande.");
    }

    const rawSignerName = form.get("signerName");
    if (typeof rawSignerName !== "string" || rawSignerName.trim().length === 0) {
      throw new FieldError("VALIDATION_ERROR", "Nome de quem assina é obrigatório.");
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

    const data = Buffer.from(await file.arrayBuffer());
    const contentHash = createHash("sha256").update(data).digest("hex");
    const orderId = context.params.id;

    const outcome = await withIdempotency(
      principal,
      "service-order.signature.put",
      key,
      {
        orderId,
        expectedOrderVersion,
        signerName: rawSignerName.trim(),
        contentHash,
      },
      async () => {
        const signature = await putSignature(
          principal.user.companyId,
          principal.user.id,
          orderId,
          {
            signerName: rawSignerName,
            data,
            declaredMimeType: file.type,
            expectedOrderVersion,
          },
        );

        return {
          status: 200,
          resourceId: signature.id,
          body: {
            signature: {
              id: signature.id,
              signerName: signature.signerName,
              signedAt: signature.signedAt.toISOString(),
              sizeBytes: signature.sizeBytes,
            },
          },
        };
      },
    );

    return fieldOk(outcome.body, outcome.status);
  });
}
