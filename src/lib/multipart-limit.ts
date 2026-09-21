/**
 * Leitura de corpo multipart COM teto (RC-STO-01).
 *
 * ## O defeito
 *
 * As rotas de upload chamavam `request.formData()` e só depois conferiam
 * `file.size`. Àquela altura o corpo inteiro já estava na memória do processo
 * — um processo só, atendendo todas as empresas —, e um usuário autenticado
 * derrubava a aplicação com um POST de alguns gigabytes. O comentário das rotas
 * dizia "recusar antes de bufferizar"; o código fazia o contrário.
 *
 * ## Por que a aplicação consegue recusar de verdade
 *
 * O Next entrega ao route handler o corpo EM FLUXO: sem middleware, nada o lê
 * antes do handler (`next/dist/server/body-streams.js` só bufferiza quando
 * precisa clonar o corpo para um middleware, e o projeto não tem nenhum).
 * Verificado no 14 e REVERIFICADO no `next@15.5.25` (`SEC-003`): o 15
 * acrescentou um caminho de middleware no runtime Node que clona o corpo, e ele
 * também só roda se houver middleware — ausência que `SEC-003-11` afirma. Então:
 *
 * 1. `Content-Length` presente: formato validado e teto conferido SEM ler um
 *    byte do corpo;
 * 2. durante a leitura, os bytes são contados e o fluxo é CANCELADO ao passar
 *    do teto — o que cobre o cabeçalho ausente (transferência em pedaços) e o
 *    cabeçalho que mente;
 * 3. só então o formulário é interpretado, a partir do que foi lido.
 *
 * ## O que ela NÃO resolve
 *
 * O teto daqui protege a memória do processo Node. A conexão, os bytes que o
 * cliente continua mandando e o tempo de socket são do servidor web à frente:
 * **a proteção definitiva em produção exige limite de corpo no proxy reverso**
 * (`client_max_body_size` no nginx, ou equivalente), no mesmo valor ou abaixo
 * do teto desta função. Ver `docs/SECURITY.md`.
 *
 * Nenhuma dependência de parser em fluxo: o formulário continua sendo
 * interpretado pelo `Response.formData()` do próprio runtime, só que sobre um
 * corpo que já se provou pequeno.
 */

/**
 * Folga para a moldura do formulário: boundaries, cabeçalhos das partes e os
 * campos de texto (`expectedOrderVersion`, `category`, `caption`,
 * `capturedAt`, `signerName`). Todos eles juntos cabem com sobra em 64 KiB.
 */
export const MULTIPART_FORM_OVERHEAD_BYTES = 64 * 1024;

/** O teto do CORPO de uma rota cujo arquivo tem teto `fileMaxBytes`. */
export function multipartBodyLimit(fileMaxBytes: number): number {
  return fileMaxBytes + MULTIPART_FORM_OVERHEAD_BYTES;
}

export type MultipartRefusal = "INVALID_LENGTH" | "TOO_LARGE" | "MALFORMED";

export type MultipartReadResult =
  | { ok: true; form: FormData }
  | { ok: false; reason: MultipartRefusal };

/**
 * `null` quando o cabeçalho falta; `"invalid"` para qualquer coisa que não seja
 * um inteiro decimal sem sinal — inclusive `"1e3"`, `"-1"`, vazio e a lista
 * `"10, 20"` que um proxy mal configurado pode produzir.
 */
export function parseContentLength(header: string | null): number | null | "invalid" {
  if (header === null) {
    return null;
  }
  const text = header.trim();
  if (!/^\d+$/.test(text)) {
    return "invalid";
  }
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : "invalid";
}

export async function readMultipartWithinLimit(
  request: Request,
  maxBodyBytes: number,
): Promise<MultipartReadResult> {
  const declared = parseContentLength(request.headers.get("content-length"));
  if (declared === "invalid") {
    return { ok: false, reason: "INVALID_LENGTH" };
  }
  if (declared !== null && declared > maxBodyBytes) {
    return { ok: false, reason: "TOO_LARGE" };
  }

  if (!request.body) {
    return { ok: false, reason: "MALFORMED" };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBodyBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: "TOO_LARGE" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: "MALFORMED" };
  }

  try {
    const body = Buffer.concat(chunks, total);
    const form = await new Response(body, {
      headers: { "content-type": request.headers.get("content-type") ?? "" },
    }).formData();
    return { ok: true, form };
  } catch {
    return { ok: false, reason: "MALFORMED" };
  }
}
