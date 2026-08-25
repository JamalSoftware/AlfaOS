import type { ERPProvider } from "@prisma/client";
import type {
  ERPCustomerDetail,
  ERPCustomerSummary,
} from "@/integrations/customer-lookup";
import { supportsCustomerLookup } from "@/integrations/customer-lookup";
import { IntegrationError, isIntegrationError } from "@/integrations/errors";
import { withIntegrationTimeout } from "@/integrations/diagnostics";
import { logAudit } from "./audit";
import { resolveCompanyAdapter } from "./erp-adapter";
import { badRequest, conflict, isUniqueConstraintError, notFound } from "./errors";
import { prisma } from "./prisma";
import {
  provisionPppoeFromErp,
  type PppoeProvisionOutcome,
} from "./pppoe-provisioning";

/**
 * Busca e importação de cliente a partir do ERP.
 *
 * A regra que governa este módulo: **o Customer do AlfaOS continua sendo
 * entidade própria** (PRD §128). O ERP é fonte de dados, não dono do cadastro.
 * Nada aqui apaga informação local só porque a API não devolveu aquele campo.
 */

export interface ErpCustomerSearchHit extends ERPCustomerSummary {
  /** Id do Customer local já vinculado a esta identidade externa, se houver. */
  localCustomerId: string | null;
}

export interface ErpCustomerSearchResult {
  provider: ERPProvider;
  hits: ErpCustomerSearchHit[];
}

async function resolveEnabledProvider(
  companyId: string,
): Promise<ERPProvider> {
  const integration = await prisma.eRPIntegration.findUnique({
    where: { companyId },
    select: { provider: true, enabled: true },
  });
  if (!integration || !integration.enabled) {
    throw badRequest(
      "Nenhuma integração de ERP está habilitada para esta empresa.",
    );
  }
  return integration.provider;
}

export async function searchErpCustomers(
  companyId: string,
  query: { name?: string; document?: string; phone?: string },
): Promise<ErpCustomerSearchResult> {
  const provider = await resolveEnabledProvider(companyId);
  const adapter = await resolveCompanyAdapter(companyId, provider);

  if (!supportsCustomerLookup(adapter)) {
    throw badRequest(
      `O provider ${provider} não oferece busca de clientes.`,
    );
  }

  // Mesmo deadline estrutural do diagnóstico, aplicado no CALL SITE: um adapter
  // futuro herda o limite sem precisar lembrar dele.
  const hits = await withIntegrationTimeout(
    adapter.searchCustomers(query),
    provider,
  );

  /**
   * Anota o que já existe localmente, em UMA consulta.
   *
   * É isto que permite à tela dizer "este cliente já está no AlfaOS" antes de o
   * operador clicar — sem isso ele descobriria só depois, e a única forma de
   * evitar duplicata seria confiar na memória de quem cadastra.
   */
  const externalIds = hits.map((h) => h.externalId);
  const locals = externalIds.length
    ? await prisma.customer.findMany({
        where: {
          companyId,
          externalProvider: provider,
          externalId: { in: externalIds },
        },
        select: { id: true, externalId: true },
      })
    : [];
  const byExternalId = new Map(locals.map((c) => [c.externalId, c.id]));

  return {
    provider,
    hits: hits.map((hit) => ({
      ...hit,
      localCustomerId: byExternalId.get(hit.externalId) ?? null,
    })),
  };
}

export type ErpCustomerImportOutcome =
  /** Já existia vinculado a esta identidade externa. Nada foi criado. */
  | "ALREADY_LINKED"
  /** Existia sem identidade externa e foi vinculado. Nada foi duplicado. */
  | "LINKED"
  /** Não existia; foi criado. */
  | "CREATED";

export interface ErpCustomerImportResult {
  customerId: string;
  outcome: ErpCustomerImportOutcome;
  detail: ERPCustomerDetail;
  /**
   * O que o provisionamento automático de PPPoE fez.
   *
   * Obrigatório de propósito: o operador precisa distinguir “o provider
   * não informou login” de “tentou e falhou”, e um campo opcional
   * permitiria a um caminho novo esquecer de responder.
   */
  pppoe: PppoeProvisionOutcome;
}

/**
 * Só sobrescreve o que o ERP realmente devolveu.
 *
 * Campo nulo na resposta significa "o ERP não informou", NÃO "o ERP informou
 * vazio". Apagar um endereço que um despachante digitou porque a API não o
 * devolveu destruiria trabalho humano com dado que não existe.
 */
function nonNull<T extends Record<string, unknown>>(source: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== null && value !== undefined) out[key] = value;
  }
  return out as Partial<T>;
}

/**
 * Encontra ou cria o Customer local correspondente a um cliente do ERP.
 *
 * Ordem de resolução, do mais forte para o mais fraco:
 *
 *  1. **Identidade externa** `(companyId, provider, externalId)` — é a única
 *     correspondência com garantia. Se casar, atualiza e pronto.
 *  2. **Documento** dentro da empresa, apenas quando o local ainda NÃO tem
 *     identidade externa. Vincula em vez de duplicar.
 *  3. Nada casou: cria.
 *
 * O caso 2 é o que impede duplicata silenciosa de um cliente que já foi
 * cadastrado à mão. E ele é deliberadamente estreito: se o Customer local já
 * aponta para OUTRA identidade externa, isso é conflito real e vira erro — a
 * escolha errada aqui vincularia o atendimento à pessoa errada.
 */
export async function importErpCustomer(
  companyId: string,
  actorUserId: string,
  externalId: string,
): Promise<ErpCustomerImportResult> {
  const provider = await resolveEnabledProvider(companyId);
  const adapter = await resolveCompanyAdapter(companyId, provider);

  if (!supportsCustomerLookup(adapter)) {
    throw badRequest(`O provider ${provider} não oferece busca de clientes.`);
  }

  let detail: ERPCustomerDetail;
  try {
    detail = await withIntegrationTimeout(
      adapter.getCustomerDetail(externalId),
      provider,
    );
  } catch (error) {
    if (isIntegrationError(error) && error.code === "CUSTOMER_NOT_FOUND") {
      throw notFound("Cliente não localizado no sistema externo.");
    }
    throw error;
  }

  /**
   * Campos que o ERP pode fornecer. `number` (número do endereço), telefone,
   * e-mail e coordenadas ficam de fora de propósito: o contrato CallCenter
   * **não os devolve**, e preenchê-los seria invenção. O técnico precisa do
   * número para chegar — ele continua vindo do cadastro AlfaOS.
   */
  const fromErp = nonNull({
    name: detail.name,
    document: detail.document,
    address: detail.address,
    district: detail.district,
    city: detail.city,
    state: detail.state,
    zipCode: detail.zipCode,
  });

  /**
   * Provisiona o acesso PPPoE e devolve o resultado da importação já
   * anotado. Roda DEPOIS de o cliente existir, porque a conexão referencia
   * o `customerId`; e nunca lança, para que a credencial não derrube a
   * importação (ver `provisionPppoeFromErp`).
   */
  const withPppoe = async (
    result: Omit<ErpCustomerImportResult, "pppoe">,
  ): Promise<ErpCustomerImportResult> => ({
    ...result,
    pppoe: await provisionPppoeFromErp(companyId, actorUserId, {
      customerId: result.customerId,
      login: detail.login,
      document: detail.document,
    }),
  });

  const linked = await prisma.customer.findFirst({
    where: { companyId, externalProvider: provider, externalId },
    select: { id: true },
  });
  if (linked) {
    await prisma.customer.update({ where: { id: linked.id }, data: fromErp });
    await audit(companyId, actorUserId, linked.id, provider, externalId, "ALREADY_LINKED");
    return withPppoe({ customerId: linked.id, outcome: "ALREADY_LINKED", detail });
  }

  if (detail.document) {
    const sameDocument = await prisma.customer.findFirst({
      where: { companyId, document: detail.document },
      select: { id: true, externalProvider: true, externalId: true },
    });
    if (sameDocument) {
      if (sameDocument.externalId !== null) {
        // Já aponta para outra identidade externa. Adivinhar aqui vincularia o
        // atendimento à pessoa errada.
        throw conflict(
          "Já existe um cliente com este documento vinculado a outra identidade externa. Verifique o cadastro antes de importar.",
        );
      }
      const updated = await prisma.customer.update({
        where: { id: sameDocument.id },
        data: { ...fromErp, externalProvider: provider, externalId },
      });
      await audit(companyId, actorUserId, updated.id, provider, externalId, "LINKED");
      return withPppoe({ customerId: updated.id, outcome: "LINKED", detail });
    }
  }

  let created;
  try {
    created = await prisma.customer.create({
      data: {
        companyId,
        externalProvider: provider,
        externalId,
        // `name` é obrigatório no schema; o adapter já garante um valor.
        name: detail.name,
        ...fromErp,
      },
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      // Corrida: outra requisição importou o mesmo cliente entre a busca e a
      // criação. O banco arbitrou; releio em vez de duplicar.
      const raced = await prisma.customer.findFirst({
        where: { companyId, externalProvider: provider, externalId },
        select: { id: true },
      });
      if (raced) {
        return withPppoe({ customerId: raced.id, outcome: "ALREADY_LINKED", detail });
      }
    }
    throw error;
  }

  await audit(companyId, actorUserId, created.id, provider, externalId, "CREATED");
  return withPppoe({ customerId: created.id, outcome: "CREATED", detail });
}

async function audit(
  companyId: string,
  actorUserId: string,
  customerId: string,
  provider: ERPProvider,
  externalId: string,
  outcome: ErpCustomerImportOutcome,
): Promise<void> {
  await logAudit({
    companyId,
    userId: actorUserId,
    action: "ERP_CUSTOMER.IMPORTED",
    entity: "Customer",
    entityId: customerId,
    // Identificadores e desfecho. Nunca token, nunca payload do provider.
    details: `Cliente ${outcome} a partir de ${provider} (externalId ${externalId})`,
  });
}

/** Reexportado para os testes exercitarem o mesmo erro que a rota devolve. */
export { IntegrationError };
