import { AccessProfile } from "@prisma/client";
import { z } from "zod";
import { assertProfile, jsonError, jsonOk, runApi } from "@/lib/api";
import { assertSameOrigin } from "@/lib/csrf";
import { getSessionUser } from "@/lib/session";
import { createCompanyCustomer, listCompanyCustomers } from "@/lib/customers";

const CUSTOMER_PROFILES = [AccessProfile.ADMIN, AccessProfile.DISPATCHER];

const createCustomerSchema = z
  .object({
    name: z.string().min(2, "Nome deve ter ao menos 2 caracteres.").max(200),
    document: z.string().max(30).optional().or(z.literal("")),
    phone: z.string().max(30).optional().or(z.literal("")),
    secondaryPhone: z.string().max(30).optional().or(z.literal("")),
    email: z.string().email("E-mail inválido.").max(255).optional().or(z.literal("")),
    address: z.string().max(200).optional().or(z.literal("")),
    number: z.string().max(20).optional().or(z.literal("")),
    complement: z.string().max(100).optional().or(z.literal("")),
    district: z.string().max(100).optional().or(z.literal("")),
    city: z.string().max(100).optional().or(z.literal("")),
    state: z.string().max(2).optional().or(z.literal("")),
    zipCode: z.string().max(15).optional().or(z.literal("")),
    // `externalProvider` NAO entra aqui: e derivado da integracao da empresa
    // no servidor. Schema strict, entao envia-lo resulta em 400.
    externalId: z.string().max(64).optional().or(z.literal("")),
  })
  .strict();

const listQuerySchema = z.object({
  search: z.string().optional(),
  active: z.enum(["true", "false"]).optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
});

export async function GET(request: Request) {
  return runApi(async () => {
    const session = await getSessionUser(request);
    if (!session) {
      return jsonError("Não autenticado.", 401);
    }
    const denied = assertProfile(session.profile, CUSTOMER_PROFILES);
    if (denied) return denied;

    const url = new URL(request.url);
    const parsed = listQuerySchema.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) {
      return jsonError("Parâmetros inválidos.", 400);
    }

    const result = await listCompanyCustomers(session.companyId, {
      search: parsed.data.search,
      active:
        parsed.data.active === undefined
          ? undefined
          : parsed.data.active === "true",
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
    });
    return jsonOk(result);
  });
}

export async function POST(request: Request) {
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

    const parsed = createCustomerSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError("Dados inválidos.", 400, parsed.error.flatten());
    }

    const customer = await createCompanyCustomer(
      session.companyId,
      parsed.data,
      session.id,
    );
    return jsonOk({ customer }, 201);
  });
}
