import { AccessProfile } from "@prisma/client";
import { jsonError, runApi } from "@/lib/api";
import { getSessionUser } from "@/lib/session";
import { getTechnicianByUserId } from "@/lib/service-orders";
import { loadEvidenceForDownload } from "@/lib/service-order-closing";

/**
 * Authorized download of an evidence file.
 *
 * There is no public URL for an evidence photo. The bytes live outside the
 * Next.js public tree and only leave through here, after session, tenant and —
 * for technicians — ownership are checked. Knowing an id or a storageKey is
 * therefore not enough to read another company's file.
 */
export async function GET(
  request: Request,
  context: { params: { id: string; evidenceId: string } },
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

    const file = await loadEvidenceForDownload(
      session.companyId,
      context.params.id,
      context.params.evidenceId,
      { isStaff, technicianId: technician?.id ?? null },
    );

    return new Response(new Uint8Array(file.data), {
      status: 200,
      headers: {
        "Content-Type": file.mimeType,
        // `attachment` and `nosniff` together stop the browser from ever
        // rendering an uploaded file in this origin, which is the second half
        // of the defence that starts with refusing SVG/HTML at upload time.
        "Content-Disposition": "attachment",
        "X-Content-Type-Options": "nosniff",
        // Private: the response is tenant- and owner-specific, so no shared
        // cache may keep it.
        "Cache-Control": "private, no-store",
      },
    });
  });
}
