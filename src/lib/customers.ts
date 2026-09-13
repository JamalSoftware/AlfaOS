import type { ConnectivityStatus, Customer } from "@prisma/client";
import { logAudit } from "./audit";
import {
  badRequest,
  conflict,
  isUniqueConstraintError,
  notFound,
} from "./errors";
import {
  getCompanyConnectivityStatuses,
  type CompanyConnectivityReading,
} from "./customer-diagnostics";
import { prisma } from "./prisma";

export const EXTERNAL_ID_MAX_LENGTH = 64;

export interface PublicCustomer {
  id: string;
  name: string;
  document: string | null;
  phone: string | null;
  secondaryPhone: string | null;
  email: string | null;
  address: string | null;
  number: string | null;
  complement: string | null;
  district: string | null;
  city: string | null;
  state: string | null;
  zipCode: string | null;
  /** Contrato / ID do cliente no ERP da empresa. Opcional. */
  externalId: string | null;
  /**
   * Sistema ao qual `externalId` pertence. Somente leitura para o cliente HTTP:
   * é derivado da integração da própria empresa, nunca aceito do request — caso
   * contrário um operador poderia reivindicar a identidade externa de outro
   * provider.
   */
  externalProvider: string | null;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateCustomerInput {
  name: string;
  document?: string;
  phone?: string;
  secondaryPhone?: string;
  email?: string;
  address?: string;
  number?: string;
  complement?: string;
  district?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  externalId?: string | null;
}

export interface UpdateCustomerInput {
  name?: string;
  document?: string;
  secondaryPhone?: string;
  phone?: string;
  email?: string;
  address?: string;
  number?: string;
  complement?: string;
  district?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  externalId?: string | null;
  active?: boolean;
}

/**
 * `externalId` passou a ser editável pelo ADMIN/DISPATCHER (v0.5.1), então
 * aparece aqui junto do provider que o qualifica. Ambos só trafegam em telas
 * administrativas — a rota de clientes já é restrita a ADMIN e DISPATCHER.
 */
export function toPublicCustomer(customer: Customer): PublicCustomer {
  return {
    id: customer.id,
    name: customer.name,
    document: customer.document,
    phone: customer.phone,
    secondaryPhone: customer.secondaryPhone,
    email: customer.email,
    address: customer.address,
    number: customer.number,
    complement: customer.complement,
    district: customer.district,
    city: customer.city,
    state: customer.state,
    zipCode: customer.zipCode,
    externalId: customer.externalId,
    externalProvider: customer.externalProvider,
    active: customer.active,
    createdAt: customer.createdAt,
    updatedAt: customer.updatedAt,
  };
}

/** A leitura que colocou o cliente no recorte "Clientes offline". */
export interface CustomerListConnectivity {
  status: ConnectivityStatus;
  observedAt: Date;
}

export interface CustomerListResult {
  customers: PublicCustomer[];
  total: number;
  page: number;
  pageSize: number;
  /**
   * Só com o recorte de conectividade ativo: a leitura de cada cliente DA
   * PÁGINA, por id. Vem do mesmo lote que decidiu quem entra no recorte — a
   * tela explica por que a linha está ali sem nenhuma consulta a mais.
   */
  connectivity?: Record<string, CustomerListConnectivity>;
}

export interface ListCustomersParams {
  search?: string;
  active?: boolean;
  /**
   * Só clientes cuja ÚLTIMA leitura de conectividade é `OFFLINE` — o recorte do
   * cartão "Clientes offline" do painel (DASH-1). Quem decide se o chamador
   * pode usá-lo é a página: ele é `ADMIN`, como a camada de clientes do mapa.
   */
  connectivity?: "OFFLINE";
  page?: number;
  pageSize?: number;
}

/**
 * O `where` da listagem de clientes — e do cartão do painel que abre nela.
 *
 * O recorte de conectividade NÃO reescreve a regra de qual leitura vale: ele
 * pergunta a `getCompanyConnectivityStatuses`, a mesma autoridade do mapa e da
 * OS (§370), e filtra pelos ids que ela devolve como `OFFLINE`. Cliente sem
 * leitura nunca entra: "sem leitura" não é "offline".
 */
async function buildCustomerListQuery(
  companyId: string,
  params: ListCustomersParams,
): Promise<{
  where: Record<string, unknown>;
  readings: Map<string, CompanyConnectivityReading> | null;
}> {
  const where: Record<string, unknown> = { companyId };
  let readings: Map<string, CompanyConnectivityReading> | null = null;
  if (params.connectivity === "OFFLINE") {
    readings = await getCompanyConnectivityStatuses(companyId);
    where.id = {
      in: Array.from(readings)
        .filter(([, leitura]) => leitura.status === "OFFLINE")
        .map(([customerId]) => customerId),
    };
  }
  if (params.active !== undefined) where.active = params.active;
  if (params.search) Object.assign(where, customerSearchFilter(params.search));
  return { where, readings };
}

/**
 * Os dígitos de um termo com cara de telefone ou documento — ou `null`.
 *
 * "Cara de" é: só dígitos e a pontuação que telefone e documento usam, com pelo
 * menos quatro dígitos. Menos que isso casaria com quase todo telefone da base.
 */
export function phoneOrDocumentDigits(search: string): string | null {
  const termo = search.trim();
  if (!/^[\d\s().\-/+]+$/.test(termo)) return null;
  const digitos = termo.replace(/\D/g, "");
  return digitos.length >= 4 ? digitos : null;
}

const CUSTOMER_SEARCH_FIELDS = [
  "name",
  "document",
  "email",
  "phone",
  "secondaryPhone",
  "address",
  "district",
  "city",
  "zipCode",
] as const;

/**
 * O predicado da busca de cliente — o da listagem `/clientes` e o da busca
 * global (GS-1, PRD §384).
 *
 * UM só, porque busca duplicada é autorização duplicada (§201): a segunda
 * implementação esquece um campo ou uma checagem que a primeira tem. Com o
 * mesmo `where`, o "ver todos" da busca global abre a listagem e mostra os
 * mesmos clientes.
 *
 * Telefone e documento chegam gravados de dois jeitos: só dígitos (o ERP
 * normaliza) e como foram digitados no cadastro manual. Um termo com cara de
 * número também procura a versão só-dígitos, então "(92) 99999-1234" acha o
 * telefone gravado como 92999991234. O inverso — gravado com máscara, digitado
 * sem — não é coberto: exigiria normalizar a coluna, e isso é migration.
 *
 * O tenant NÃO está aqui: quem chama põe `companyId` no mesmo `where`.
 */
export function customerSearchFilter(search: string): { OR: Record<string, unknown>[] } {
  const OR: Record<string, unknown>[] = CUSTOMER_SEARCH_FIELDS.map((field) => ({
    [field]: { contains: search, mode: "insensitive" },
  }));
  const digitos = phoneOrDocumentDigits(search);
  if (digitos !== null && digitos !== search) {
    for (const field of ["phone", "secondaryPhone", "document"] as const) {
      OR.push({ [field]: { contains: digitos } });
    }
  }
  return { OR };
}

export async function listCompanyCustomers(
  companyId: string,
  params: ListCustomersParams = {},
): Promise<CustomerListResult> {
  const page = Math.max(1, params.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, params.pageSize ?? 20));
  const { where, readings } = await buildCustomerListQuery(companyId, params);

  const [customers, total] = await Promise.all([
    prisma.customer.findMany({
      where,
      orderBy: { name: "asc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.customer.count({ where }),
  ]);

  const result: CustomerListResult = {
    customers: customers.map(toPublicCustomer),
    total,
    page,
    pageSize,
  };
  if (readings) {
    // Só as linhas desta página: o mapa inteiro da empresa não sai daqui.
    result.connectivity = {};
    for (const customer of customers) {
      const leitura = readings.get(customer.id);
      if (leitura) result.connectivity[customer.id] = leitura;
    }
  }
  return result;
}

/** Quantos clientes a listagem mostraria — pelo MESMO `where` da tela. */
export async function countCompanyCustomers(
  companyId: string,
  params: Omit<ListCustomersParams, "page" | "pageSize"> = {},
): Promise<number> {
  const { where } = await buildCustomerListQuery(companyId, params);
  return prisma.customer.count({ where });
}

export async function getCompanyCustomer(
  companyId: string,
  customerId: string,
): Promise<PublicCustomer | null> {
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, companyId },
  });
  return customer ? toPublicCustomer(customer) : null;
}

/**
 * Lightweight list of active customers (for form dropdowns).
 */
export async function listCustomerOptions(
  companyId: string,
): Promise<{ id: string; name: string }[]> {
  const customers = await prisma.customer.findMany({
    where: { companyId, active: true },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });
  return customers;
}

/**
 * Resolve a identidade externa a partir do que o operador digitou.
 *
 * O `externalProvider` vem SEMPRE da integração da própria empresa, lida no
 * servidor. Aceitá-lo do request deixaria um operador gravar um cliente como
 * se pertencesse a outro sistema, e a unique
 * `(companyId, externalProvider, externalId)` deixaria de significar o que
 * promete.
 */
async function resolveExternalIdentity(
  companyId: string,
  raw: string | null | undefined,
): Promise<{ externalProvider: string | null; externalId: string | null }> {
  const externalId = raw?.trim() || null;

  // Limpar o id limpa o provider junto: um provider órfão deixaria a linha
  // afirmando pertencer a um sistema sem dizer com que identificador.
  if (!externalId) {
    return { externalProvider: null, externalId: null };
  }

  if (externalId.length > EXTERNAL_ID_MAX_LENGTH) {
    throw badRequest(
      `Contrato / ID externo deve ter no máximo ${EXTERNAL_ID_MAX_LENGTH} caracteres.`,
    );
  }

  const integration = await prisma.eRPIntegration.findUnique({
    where: { companyId },
    select: { provider: true },
  });
  if (!integration) {
    throw badRequest(
      "Configure a integração ERP da empresa antes de vincular um contrato / ID externo.",
    );
  }

  return { externalProvider: integration.provider, externalId };
}

function externalIdConflict(): never {
  throw conflict(
    "Já existe um cliente com esse contrato / ID externo nesta empresa.",
  );
}

export async function createCompanyCustomer(
  companyId: string,
  input: CreateCustomerInput,
  actorId: string,
): Promise<PublicCustomer> {
  const external = await resolveExternalIdentity(companyId, input.externalId);

  let customer;
  try {
    customer = await prisma.customer.create({
      data: {
        companyId,
        ...external,
        name: input.name.trim(),
        document: input.document?.trim() || null,
        phone: input.phone?.trim() || null,
        secondaryPhone: input.secondaryPhone?.trim() || null,
        email: input.email?.trim().toLowerCase() || null,
        address: input.address?.trim() || null,
        number: input.number?.trim() || null,
        complement: input.complement?.trim() || null,
        district: input.district?.trim() || null,
        city: input.city?.trim() || null,
        state: input.state?.trim().toUpperCase() || null,
        zipCode: input.zipCode?.trim() || null,
      },
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) externalIdConflict();
    throw error;
  }

  await logAudit({
    companyId,
    userId: actorId,
    action: "CUSTOMER.CREATED",
    entity: "Customer",
    entityId: customer.id,
    details: `Cliente criado: ${customer.name}`,
  });

  return toPublicCustomer(customer);
}

export async function updateCompanyCustomer(
  companyId: string,
  customerId: string,
  input: UpdateCustomerInput,
  actorId: string,
): Promise<PublicCustomer> {
  const existing = await prisma.customer.findFirst({
    where: { id: customerId, companyId },
  });
  if (!existing) {
    throw notFound("Cliente não encontrado.");
  }

  const data: Record<string, unknown> = {};
  if (input.name !== undefined) data.name = input.name.trim();
  if (input.document !== undefined)
    data.document = input.document?.trim() || null;
  if (input.phone !== undefined) data.phone = input.phone?.trim() || null;
  if (input.secondaryPhone !== undefined)
    data.secondaryPhone = input.secondaryPhone?.trim() || null;
  if (input.email !== undefined)
    data.email = input.email?.trim().toLowerCase() || null;
  if (input.address !== undefined) data.address = input.address?.trim() || null;
  if (input.number !== undefined) data.number = input.number?.trim() || null;
  if (input.complement !== undefined)
    data.complement = input.complement?.trim() || null;
  if (input.district !== undefined)
    data.district = input.district?.trim() || null;
  if (input.city !== undefined) data.city = input.city?.trim() || null;
  if (input.state !== undefined)
    data.state = input.state?.trim().toUpperCase() || null;
  if (input.zipCode !== undefined) data.zipCode = input.zipCode?.trim() || null;
  if (input.active !== undefined) data.active = input.active;
  if (input.externalId !== undefined) {
    Object.assign(
      data,
      await resolveExternalIdentity(companyId, input.externalId),
    );
  }

  let updated;
  try {
    updated = await prisma.customer.update({
      where: { id: customerId },
      data,
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) externalIdConflict();
    throw error;
  }

  await logAudit({
    companyId,
    userId: actorId,
    action: "CUSTOMER.UPDATED",
    entity: "Customer",
    entityId: customerId,
    details: `Cliente atualizado: ${updated.name}`,
  });

  return toPublicCustomer(updated);
}
