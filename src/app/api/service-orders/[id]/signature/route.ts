import { AccessProfile } from "@prisma/client";
import { assertProfile, jsonError, jsonOk, runApi } from "@/lib/api";
import { assertSameOrigin } from "@/lib/csrf";
import { getSessionUser } from "@/lib/session";
import { INT32_MAX } from "@/lib/version";
import { getTechnicianByUserId } from "@/lib/service-orders";
import {
  loadSignatureForDownload,
  putSignature,
  SIGNATURE_MAX_BYTES,
  SIGNER_NAME_MAX,
} from "@/lib/service-order-closing";

const TECHNICIAN_PROFILES = [AccessProfile.TECHNICIAN];

/**
 * PUT, not POST: an order has at most one signature, so capturing it twice
 * replaces rather than appends. The verb matches the semantics the schema
 * enforces with `serviceOrderId @unique`.
 */
export async function PUT(
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

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return jsonError("Envio inválido.", 400);
    }

    const file = form.get("file");
    if (!(file instanceof File)) {
      return jsonError("Imagem da assinatura é obrigatória.", 400);
    }
    if (file.size > SIGNATURE_MAX_BYTES) {
      return jsonError("Imagem de assinatura muito grande.", 400);
    }

    const signerNameRaw = form.get("signerName");
    if (typeof signerNameRaw !== "string" || !signerNameRaw.trim()) {
      return jsonError("Nome de quem assina é obrigatório.", 400);
    }
    if (signerNameRaw.length > SIGNER_NAME_MAX) {
      return jsonError("Nome muito longo.", 400);
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

    const signature = await putSignature(
      session.companyId,
      session.id,
      context.params.id,
      {
        signerName: signerNameRaw,
        data,
        declaredMimeType: file.type,
        expectedOrderVersion,
      },
    );
    return jsonOk({ signature });
  });
}

/** Authorized read of the signature image — same rules as evidence content. */
export async function GET(
  request: Request,
  context: { params: { id: string } },
) {
  return runApi(async () => {
    const session = await getSessionUser(request);
    if (!session) {
      return jsonError("Não autenticado.", 401);
    }

    const isStaff =
      session.profile === AccessProfile.ADMIN ||
      session.profile === AccessProfile.DISPATCHER;
    const technician = isStaff
      ? null
      : await getTechnicianByUserId(session.companyId, session.id);

    const file = await loadSignatureForDownload(
      session.companyId,
      context.params.id,
      { isStaff, technicianId: technician?.id ?? null },
    );

    return new Response(new Uint8Array(file.data), {
      status: 200,
      headers: {
        "Content-Type": file.mimeType,
        "Content-Disposition": "attachment",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  });
}
