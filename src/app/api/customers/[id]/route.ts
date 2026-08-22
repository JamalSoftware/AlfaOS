import { AccessProfile } from "@prisma/client";
import { z } from "zod";
import { assertProfile, jsonError, jsonOk, runApi } from "@/lib/api";
import { assertSameOrigin } from "@/lib/csrf";
import { getSessionUser } from "@/lib/session";
import {
  getCompanyCustomer,
  updateCompanyCustomer,
} from "@/lib/customers";

const CUSTOMER_PROFILES = [AccessProfile.ADMIN, AccessProfile.DISPATCHER];

const updateCustomerSchema = z
  .object({
    name: z.string().min(2).max(200).optional(),
    document: z.string().max(30).optional().or(z.literal("")),
    phone: z.string().max(30).optional().or(z.literal("")),
    secondaryPhone: z.string().max(30).optional().or(z.literal("")),
    email: z.string().email().max(255).optional().or(z.literal("")),
    address: z.string().max(200).optional().or(z.literal("")),
    number: z.string().max(20).optional().or(z.literal("")),
    complement: z.string().max(100).optional().or(z.literal("")),
    district: z.string().max(100).optional().or(z.literal("")),
    city: z.string().max(100).optional().or(z.literal("")),
    state: z.string().max(2).optional().or(z.literal("")),
    zipCode: z.string().max(15).optional().or(z.literal("")),
    active: z.boolean().optional(),
  })
  .strict();

export async function GET(
  request: Request,
  context: { params: { id: string } },
) {
  return runApi(async () => {
    const session = await getSessionUser(request);
    if (!session) {
      return jsonError("Não autenticado.", 401);
    }
    const denied = assertProfile(session.profile, CUSTOMER_PROFILES);
    if (denied) return denied;

    const customer = await getCompanyCustomer(
      session.companyId,
      context.params.id,
    );
    if (!customer) {
      return jsonError("Cliente não encontrado.", 404);
    }
    return jsonOk({ customer });
  });
}

export async function PATCH(
  request: Request,
  context: { params: { id: string } },
) {
  return runApi(async () => {
    const csrfBlocked = assertSameOrigin(request);
    if (csrfBlocked) {
      return csrfBlocked;
    }

    const session = await getSessionUser(request);
    if (!session) {
      return jsonError("Não autenticado.", 401);
    }
    const denied = assertProfile(session.profile, CUSTOMER_PROFILES);
    if (denied) return denied;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonError("Corpo da requisição inválido.", 400);
    }

    const parsed = updateCustomerSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError("Dados inválidos.", 400, parsed.error.flatten());
    }

    const customer = await updateCompanyCustomer(
      session.companyId,
      context.params.id,
      parsed.data,
      session.id,
    );
    return jsonOk({ customer });
  });
}
