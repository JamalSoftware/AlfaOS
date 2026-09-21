import type { ERPProvider } from "@prisma/client";
import { isIntegrationError } from "@/integrations/errors";
import { supportsCustomerLookup } from "@/integrations/customer-lookup";
import {
  supportsServiceTickets,
  type ERPServiceTicket,
} from "@/integrations/service-tickets";
import { resolveCompanyAdapter } from "./erp-adapter";
import {
  matchesActiveProvider,
  resolveActiveErpProvider,
} from "./erp-active-provider";
import { prisma } from "./prisma";
import { withIntegrationTimeout } from "@/integrations/diagnostics";

/**
 * Contexto operacional do cliente no ERP — leitura, agregada para uma tela.
 *
 * Duas consultas independentes (detalhe e chamados abertos) que falham
 * separadamente de propósito: o ERP não responder sobre chamados não pode
 * apagar o plano que já veio, e vice-versa. Uma resposta parcial é mais útil
 * ao despachante que um erro inteiro.
 *
 * Nada aqui vira estado: este módulo não grava snapshot, não cria OS e não
 * altera cadastro. É contexto de leitura, descartado quando a tela fecha.
 */

export interface ErpOperationalContext {
  /** Cliente vinculado a um provider? Sem isso não há o que consultar. */
  linked: boolean;
  provider: string | null;
  contract: {
    status: string | null;
    plan: string | null;
    /**
     * Código de tecnologia como o provider o expõe.
     *
     * O contrato declara um inteiro e NÃO publica o significado dos valores.
     * Fica como código, sem rótulo: escrever "3 = Fibra" produziria uma tela
     * que parece informada e mente (`docs/RECEITANET-HOMOLOGATION.md`).
     */
    technologyCode: string | null;
    serverMaintenance: boolean | null;
    /** Motivo da falha, quando o detalhe não pôde ser lido. */
    error: string | null;
  };
  tickets: {
    items: ERPServiceTicket[];
    /** Teto do provider. A lista pode estar truncada e a tela precisa dizer. */
    cap: number | null;
    error: string | null;
  };
  fetchedAt: string;
}

function errorCode(error: unknown): string {
  return isIntegrationError(error) ? error.code : "UNKNOWN";
}

export async function loadErpOperationalContext(
  companyId: string,
  customerId: string,
): Promise<ErpOperationalContext> {
  const now = new Date().toISOString();

  const customer = await prisma.customer.findFirst({
    // Tenant em SQL. O `customerId` já veio da OS, mas confiar nisso e não
    // filtrar de novo deixaria a segurança dependente do chamador.
    where: { id: customerId, companyId },
    select: { externalProvider: true, externalId: true },
  });

  const empty: ErpOperationalContext = {
    linked: false,
    provider: null,
    contract: {
      status: null,
      plan: null,
      technologyCode: null,
      serverMaintenance: null,
      error: null,
    },
    tickets: { items: [], cap: null, error: null },
    fetchedAt: now,
  };

  if (!customer?.externalProvider || !customer.externalId) {
    return empty;
  }

  /*
    O adapter vem do ERP **ATIVO**, nunca do histórico do cliente (`SEC-008`).

    Esta linha lia `customer.externalProvider` — que é registro de ORIGEM, não
    seleção: uma OS importada do ReceitaNet continua ReceitaNet depois da troca
    de ERP, porque o campo diz de onde o dado veio. O efeito era que uma empresa
    já migrada continuava mandando dado operacional de cliente para o provider
    DESATIVADO, usando a credencial que a troca preserva ociosa justamente para
    permitir rollback.

    Quando o ativo não é o do histórico, não há o que consultar: o `externalId`
    guardado só tem significado dentro do provider que o emitiu. O cliente não
    está vinculado ao ERP atual, e o caminho para isso é reimportá-lo — não
    falar com o sistema de onde a empresa saiu.
  */
  const activeProvider = await resolveActiveErpProvider(companyId);
  if (!matchesActiveProvider(activeProvider, customer.externalProvider)) {
    return empty;
  }

  const provider = activeProvider as ERPProvider;
  const externalId = customer.externalId;

  let adapter;
  try {
    adapter = await resolveCompanyAdapter(companyId, provider);
  } catch (error) {
    return {
      ...empty,
      linked: true,
      provider,
      contract: { ...empty.contract, error: errorCode(error) },
      tickets: { items: [], cap: null, error: errorCode(error) },
    };
  }

  /**
   * As duas leituras em paralelo e com falha independente. `allSettled`, não
   * `all`: com `all`, a primeira rejeição descartaria o resultado da outra que
   * já tinha chegado.
   */
  const [detailResult, ticketsResult] = await Promise.allSettled([
    supportsCustomerLookup(adapter)
      ? withIntegrationTimeout(adapter.getCustomerDetail(externalId), provider)
      : Promise.reject(new Error("NOT_SUPPORTED")),
    supportsServiceTickets(adapter)
      ? withIntegrationTimeout(adapter.listOpenTickets(externalId), provider)
      : Promise.reject(new Error("NOT_SUPPORTED")),
  ]);

  return {
    linked: true,
    provider,
    contract:
      detailResult.status === "fulfilled"
        ? {
            status: detailResult.value.contractStatus,
            plan: detailResult.value.plan,
            technologyCode: detailResult.value.technology,
            serverMaintenance: detailResult.value.serverMaintenance,
            error: null,
          }
        : { ...empty.contract, error: errorCode(detailResult.reason) },
    tickets:
      ticketsResult.status === "fulfilled"
        ? {
            items: ticketsResult.value.tickets,
            cap: ticketsResult.value.cap,
            error: null,
          }
        : { items: [], cap: null, error: errorCode(ticketsResult.reason) },
    fetchedAt: now,
  };
}
