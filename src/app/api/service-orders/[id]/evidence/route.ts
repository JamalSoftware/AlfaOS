import { AccessProfile } from "@prisma/client";
import { assertProfile, jsonError, jsonOk, runApi } from "@/lib/api";
import { assertSameOrigin } from "@/lib/csrf";
import { getSessionUser } from "@/lib/session";
import { INT32_MAX } from "@/lib/version";
import { addEvidence, EVIDENCE_MAX_BYTES } from "@/lib/service-order-closing";
import { multipartBodyLimit, readMultipartWithinLimit } from "@/lib/multipart-limit";

const TECHNICIAN_PROFILES = [AccessProfile.TECHNICIAN];

/**
 * Multipart upload, so the payload is read as form data rather than JSON.
 *
 * Zod is not used for the file itself — a `File` is not a JSON value. The
 * equivalent guarantees are enforced explicitly here and in `addEvidence`:
 * only `file` and `expectedOrderVersion` are ever read from the form, so
 * extra parts (`companyId`, `storageKey`, `status`, ...) are ignored the same
 * way `.strict()` would refuse them — they can never reach a Prisma `data`.
 */
export async function POST(
  request: Request,
  context: { params: { id: string } },
) {
  return runApi(async () => {
    const csrfBlocked = assertSameOrigin(request);
    if (csrfBlocked) return csrfBlocked;

    const session = await getSessionUser(request);
    if (!session) {
      return jsonError("Não autenticado.", 401);
    }
    const denied = assertProfile(session.profile, TECHNICIAN_PROFILES);
    if (denied) return denied;

    const tooLarge = `Imagem muito grande (máximo ${Math.floor(EVIDENCE_MAX_BYTES / 1024 / 1024)} MB).`;

    // The BODY is capped before it is materialized (RC-STO-01): by the
    // declared Content-Length without reading a byte, and by counting while
    // reading when the header is missing or lies. `request.formData()` would
    // buffer the whole body first.
    const read = await readMultipartWithinLimit(
      request,
      multipartBodyLimit(EVIDENCE_MAX_BYTES),
    );
    if (!read.ok) {
      return jsonError(read.reason === "TOO_LARGE" ? tooLarge : "Envio inválido.", 400);
    }
    const form = read.form;

    const file = form.get("file");
    if (!(file instanceof File)) {
      return jsonError("Arquivo é obrigatório.", 400);
    }

    // The body cap includes the form's framing; the FILE keeps its own cap.
    if (file.size > EVIDENCE_MAX_BYTES) {
      return jsonError(tooLarge, 400);
    }

    const rawVersion = form.get("expectedOrderVersion");
    const expectedOrderVersion = Number(rawVersion);
    if (
      rawVersion === null ||
      !Number.isInteger(expectedOrderVersion) ||
      expectedOrderVersion < 0 ||
      expectedOrderVersion > INT32_MAX
    ) {
      return jsonError("Versão inválida.", 400);
    }

    const data = Buffer.from(await file.arrayBuffer());

    const evidence = await addEvidence(
      session.companyId,
      session.id,
      context.params.id,
      {
        data,
        declaredMimeType: file.type,
        originalName: file.name,
        expectedOrderVersion,
      },
    );
    return jsonOk({ evidence }, 201);
  });
}
