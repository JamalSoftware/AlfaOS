import { AccessProfile } from "@prisma/client";
import { z } from "zod";
import { assertProfile, jsonError, jsonOk, runApi } from "@/lib/api";
import { assertSameOrigin } from "@/lib/csrf";
import { getSessionUser } from "@/lib/session";
import {
  getCompanyServiceOrder,
  getTechnicianByUserId,
} from "@/lib/service-orders";
import {
  getCustomerDiagnostic,
  refreshCustomerDiagnostic,
} from "@/lib/customer-diagnostics";
import {
  enforceCapabilityLimit,
  ERP_CAPABILITIES,
} from "@/lib/capability-rate-limit";

/**
 * Diagnostics are scoped to a SERVICE ORDER, not to a customer id.
 *
 * The order is the authorization surface AlfaOS already proves: staff of the
 * company may read it, and a technician may read only their own. Exposing a
 * `/customers/:id/diagnostic` route instead would hand every authenticated
 * technician an oracle over the company's whole customer base — probe ids,
 * observe 200 vs 404, enumerate. Going through the order means the answer is
 * only ever about a customer the caller was already entitled to see.
 *
 * The customer id therefore comes from the order, server-side. It is never
 * accepted from the request.
 */

const ALL_PROFILES = [
  AccessProfile.ADMIN,
  AccessProfile.DISPATCHER,
  AccessProfile.TECHNICIAN,
];

/**
 * Resolves the order and proves the caller may see it.
 *
 * Non-owner technicians get 404, never 403 — the same anti-enumeration
 * convention the rest of the order surface uses. Returning 403 would confirm
 * the order exists and belongs to a colleague.
 */
async function authorizeOrder(request: Request, orderId: string) {
  const session = await getSessionUser(request);
  if (!session) {
    return { error: jsonError("Não autenticado.", 401) };
  }
  const denied = assertProfile(session.profile, ALL_PROFILES);
  if (denied) return { error: denied };

  const order = await getCompanyServiceOrder(session.companyId, orderId);
  if (!order) {
    return { error: jsonError("Ordem de serviço não encontrada.", 404) };
  }

  if (session.profile === AccessProfile.TECHNICIAN) {
    const technician = await getTechnicianByUserId(
      session.companyId,
      session.id,
    );
    if (!technician || technician.id !== order.technician?.id) {
      return { error: jsonError("Ordem de serviço não encontrada.", 404) };
    }
  }

  return { session, order };
}

export async function GET(
  request: Request,
  context: { params: { id: string } },
) {
  return runApi(async () => {
    const auth = await authorizeOrder(request, context.params.id);
    if (auth.error) return auth.error;

    const diagnostic = await getCustomerDiagnostic(
      auth.session.companyId,
      auth.order.customer.id,
    );
    return jsonOk({ diagnostic });
  });
}

/** Body carries nothing: everything needed is derived from the order. */
const refreshSchema = z.object({}).strict();

export async function POST(
  request: Request,
  context: { params: { id: string } },
) {
  return runApi(async () => {
    const csrfBlocked = assertSameOrigin(request);
    if (csrfBlocked) return csrfBlocked;

    const auth = await authorizeOrder(request, context.params.id);
    if (auth.error) return auth.error;

    // `.strict()` on an empty object: a caller trying to steer the refresh by
    // sending `customerId`, `companyId`, `externalProvider` or a forged status
    // gets 400 rather than a 200 that silently ignored it.
    let body: unknown = {};
    try {
      const text = await request.text();
      body = text ? JSON.parse(text) : {};
    } catch {
      return jsonError("Corpo da requisição inválido.", 400);
    }
    const parsed = refreshSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError("Dados inválidos.", 400, parsed.error.flatten());
    }

    /**
     * O único amplificador que o TECHNICIAN alcança — e o mais fácil de
     * repetir, porque "Atualizar diagnóstico" é um botão que se aperta de novo
     * quando o cliente ainda está offline. Sem teto, um celular em campo gasta
     * a cota da EMPRESA.
     *
     * Só o POST: o GET lê o snapshot local e não fala com ninguém.
     *
     * Teto DEPOIS da autorização, para que sondar OS de outro técnico não
     * consuma cota nenhuma.
     */
    const limited = enforceCapabilityLimit(
      auth.session.companyId,
      auth.session.id,
      ERP_CAPABILITIES.CUSTOMER_DIAGNOSTIC,
    );
    if (limited) return limited;

    const result = await refreshCustomerDiagnostic(
      auth.session.companyId,
      auth.session.id,
      auth.order.customer.id,
    );

    // 200 even when the provider failed: the REQUEST succeeded, and the body
    // carries both the failure reason and the preserved last-known snapshot.
    // A 5xx here would be AlfaOS reporting its own failure for someone else's
    // outage, and would make the UI unable to distinguish "we are broken" from
    // "the ERP is unreachable but here is what we last knew".
    return jsonOk({
      ok: result.ok,
      diagnostic: result.snapshot,
      errorCode: result.errorCode ?? null,
      errorMessage: result.errorMessage ?? null,
    });
  });
}
