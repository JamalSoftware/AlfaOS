import { AccessProfile } from "@prisma/client";
import { z } from "zod";
import { jsonError, jsonOk, runApi } from "@/lib/api";
import { assertSameOrigin } from "@/lib/csrf";
import { getSessionUser } from "@/lib/session";
import {
  CREDENTIAL_MAX_LENGTH,
  CREDENTIAL_MIN_LENGTH,
  CredentialEncryptionUnavailableError,
  getCredentialStatus,
  removeCredential,
  saveCredential,
} from "@/lib/erp-credentials";

/**
 * ERP credential management. ADMIN only, for the caller's OWN company.
 *
 * `companyId` is never read from the request — it comes from the session, so
 * there is no shape of payload that reaches another tenant's credential.
 */

/**
 * `.strict()` with exactly one field.
 *
 * Rejecting rather than stripping matters more here than anywhere else: a
 * caller sending `ciphertext`, `iv`, `authTag`, `last4` or `companyId` is
 * either confused or probing, and a 200 that silently ignored those fields
 * would suggest they were accepted.
 *
 * The token is NOT trimmed. Provider tokens may legitimately contain leading
 * or trailing characters that look like whitespace-adjacent padding, and
 * silently altering a secret before storing it produces an authentication
 * failure that is nearly impossible to diagnose. Length is validated on the
 * exact value that will be encrypted.
 */
const saveSchema = z
  .object({
    token: z.string().min(CREDENTIAL_MIN_LENGTH).max(CREDENTIAL_MAX_LENGTH),
  })
  .strict();

async function requireAdmin(request: Request) {
  const session = await getSessionUser(request);
  if (!session) {
    return { error: jsonError("Não autenticado.", 401) };
  }
  if (session.profile !== AccessProfile.ADMIN) {
    return { error: jsonError("Acesso negado. Requer perfil ADMIN.", 403) };
  }
  return { session };
}

/**
 * Read-only status. Returns provider / configured / last4 / updatedAt and
 * nothing else — there is no code path, for any role, that returns the token.
 */
export async function GET(request: Request) {
  return runApi(async () => {
    const auth = await requireAdmin(request);
    if (auth.error) return auth.error;

    const status = await getCredentialStatus(auth.session.companyId);
    return jsonOk({ credential: status });
  });
}

/** Save or replace. Same verb for both: the credential is a single slot. */
export async function PUT(request: Request) {
  return runApi(async () => {
    const csrfBlocked = assertSameOrigin(request);
    if (csrfBlocked) return csrfBlocked;

    const auth = await requireAdmin(request);
    if (auth.error) return auth.error;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonError("Corpo da requisição inválido.", 400);
    }

    const parsed = saveSchema.safeParse(body);
    if (!parsed.success) {
      // `flatten()` reports which FIELD failed and why (too short, unknown
      // key) — it never echoes the submitted value, so a rejected token does
      // not come back in the error body.
      return jsonError("Dados inválidos.", 400, parsed.error.flatten());
    }

    try {
      const status = await saveCredential(
        auth.session.companyId,
        auth.session.id,
        parsed.data.token,
      );
      return jsonOk({ credential: status });
    } catch (error) {
      if (error instanceof CredentialEncryptionUnavailableError) {
        // Fail closed and say so plainly. The alternative — storing the token
        // unencrypted "for now" — is the exact outcome this whole design
        // exists to prevent. The message names the missing configuration,
        // never the key.
        return jsonError(
          "Criptografia de credenciais indisponível. A credencial NÃO foi salva. " +
            "Configure ERP_CREDENTIAL_ENCRYPTION_KEY no servidor.",
          503,
        );
      }
      throw error;
    }
  });
}

export async function DELETE(request: Request) {
  return runApi(async () => {
    const csrfBlocked = assertSameOrigin(request);
    if (csrfBlocked) return csrfBlocked;

    const auth = await requireAdmin(request);
    if (auth.error) return auth.error;

    // Deliberately does not require encryption to be available: removing a
    // secret must not depend on being able to read it.
    const status = await removeCredential(
      auth.session.companyId,
      auth.session.id,
    );
    return jsonOk({ credential: status });
  });
}
