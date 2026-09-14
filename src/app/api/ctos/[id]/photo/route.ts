import { jsonError, jsonOk, runApi } from "@/lib/api";
import { assertSameOrigin } from "@/lib/csrf";
import {
  CTO_PHOTO_MAX_BYTES,
  getCtoPhotoKey,
  setCtoPhoto,
} from "@/lib/cto";
import { requireCtoAccess } from "@/lib/cto-access";
import { multipartBodyLimit, readMultipartWithinLimit } from "@/lib/multipart-limit";
import { getOperationalCtoDetail } from "@/lib/cto-read-model";
import { getFileStorage, MIME_EXTENSIONS } from "@/lib/storage";

/**
 * A foto da caixa.
 *
 * ## Não é evidência de OS
 *
 * Não passa por `loadInProgressOwnedOrder`, não tem `serviceOrderId` e não conta
 * em política de conclusão nenhuma. A caixa é infraestrutura do provedor: a
 * autorização dela é a da infraestrutura — ADMIN da empresa dona —, e criar uma
 * OS só para permitir a foto inventaria um vínculo que não existe.
 *
 * ## O upload passa pela política do servidor
 *
 * `setCtoPhoto` chama a fronteira comum (`processImageUpload`): tipo real por
 * sniff, teto, EXIF/GPS/XMP fora, trailer depois do `EOI` fora. O navegador não
 * é consultado sobre nada disso — o `Content-Type` da parte do formulário é
 * apenas uma declaração, e a verdade vem dos bytes.
 */
export async function POST(
  request: Request,
  context: { params: { id: string } },
) {
  return runApi(async () => {
    const csrfBlocked = assertSameOrigin(request);
    if (csrfBlocked) return csrfBlocked;

    const access = await requireCtoAccess(request);
    if (!access.ok) return access.response;

    const muitoGrande = `Imagem muito grande (máximo ${Math.floor(CTO_PHOTO_MAX_BYTES / 1024 / 1024)} MB).`;

    /*
      Teto do CORPO antes de materializar qualquer coisa (RC-STO-01).

      O comentário antigo dizia "teto antes de materializar o buffer" e estava
      errado sobre onde a memória já tinha ido: `request.formData()` lê o corpo
      inteiro antes de `file.size` existir. A leitura agora é contada e
      cancelada no teto; o `Content-Length` declarado é recusado sem ler nada.
    */
    const leitura = await readMultipartWithinLimit(
      request,
      multipartBodyLimit(CTO_PHOTO_MAX_BYTES),
    );
    if (!leitura.ok) {
      return jsonError(
        leitura.reason === "TOO_LARGE" ? muitoGrande : "Envio inválido.",
        400,
      );
    }
    const form = leitura.form;

    const file = form.get("file");
    if (!(file instanceof File)) {
      return jsonError("Selecione uma imagem.", 400);
    }
    // O teto do corpo inclui a moldura do formulário; o do arquivo continua.
    if (file.size > CTO_PHOTO_MAX_BYTES) {
      return jsonError(muitoGrande, 400);
    }

    await setCtoPhoto(
      access.session.companyId,
      access.session.id,
      context.params.id,
      {
        data: Buffer.from(await file.arrayBuffer()),
        declaredMimeType: file.type,
      },
    );
    /*
      A resposta de toda mutação passa pelo MESMO read model da leitura.

      As funções de domínio da `CTO-1` devolvem o detalhe administrativo, sem
      ocupação — e a tela substitui o estado inteiro pela resposta. Devolver a
      forma menor faria `occupied` e `activeConnection` sumirem depois de
      salvar, e o defeito só apareceria quando a `CTO-2.3` os exibisse: um
      selo que desaparece ao clicar em salvar.
    */
    const detail = await getOperationalCtoDetail(
      access.session.companyId,
      context.params.id,
    );
    return jsonOk({ cto: detail });
  });
}

/**
 * Serve os bytes da foto.
 *
 * Não existe URL pública: o arquivo vive fora da árvore estática e só sai por
 * aqui, depois de sessão, capability e tenant. Saber o id da CTO — ou a chave do
 * storage — não basta para ler a foto de outra empresa.
 */
export async function GET(
  request: Request,
  context: { params: { id: string } },
) {
  return runApi(async () => {
    const access = await requireCtoAccess(request);
    if (!access.ok) return access.response;

    const key = await getCtoPhotoKey(
      access.session.companyId,
      context.params.id,
    );
    if (!key) {
      return jsonError("Foto não encontrada.", 404);
    }

    /*
      O tipo vem da EXTENSÃO DA CHAVE, e a chave foi construída pelo servidor.

      Nenhuma coluna nova foi acrescentada para guardar o mime: `buildStorageKey`
      escolhe a extensão a partir do tipo já sniffado no upload, então a chave é
      um registro do servidor sobre o servidor. Um campo separado seria uma
      segunda memória do mesmo fato, e as duas divergiriam no dia em que alguém
      escrevesse numa e esquecesse da outra.
    */
    const ext = key.slice(key.lastIndexOf(".") + 1);
    const mimeType = Object.keys(MIME_EXTENSIONS).find(
      (mime) => MIME_EXTENSIONS[mime] === ext,
    );
    if (!mimeType) {
      return jsonError("Foto não encontrada.", 404);
    }

    /*
      Blob ausente é 404, não 500.

      O estado existe e o próprio código o admite: substituir a foto deixa a
      chave anterior órfã, e nada impede que um arquivo suma do storage por
      fora. Deixar a exceção subir produziria "Erro interno do servidor." para
      uma situação que o servidor entende perfeitamente — a foto não está lá.
      Apontado pela auditoria independente.
    */
    let data: Buffer;
    try {
      data = await getFileStorage().get(key);
    } catch {
      return jsonError("Foto não encontrada.", 404);
    }

    return new Response(new Uint8Array(data), {
      status: 200,
      headers: {
        "Content-Type": mimeType,
        // `attachment` + `nosniff`: a segunda metade da defesa que começa
        // recusando SVG e HTML no upload. Nada enviado por um cliente é
        // renderizado nesta origem.
        "Content-Disposition": "attachment",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  });
}
