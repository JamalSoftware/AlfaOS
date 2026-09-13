import type { ConnectivityStatus, ERPProvider } from "@prisma/client";
import { prisma } from "./prisma";
import { logAudit } from "./audit";
import { notFound } from "./errors";
import { resolveCompanyAdapter } from "./erp-adapter";
import {
  supportsDiagnostics,
  withIntegrationTimeout,
  type ERPCustomerRef,
} from "@/integrations/diagnostics";
import {
  IntegrationError,
  isIntegrationError,
  type IntegrationErrorCode,
} from "@/integrations/errors";

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/**
 * What the UI renders. Deliberately narrow: no raw provider payload ever
 * reaches this far, so the screen cannot accidentally display a field nobody
 * validated.
 */
export interface CustomerDiagnostic {
  connectivityStatus: ConnectivityStatus;
  observedAt: Date;
  sourceUpdatedAt: Date | null;
  provider: ERPProvider;
  /** Código cru de tecnologia do provider, quando informado. */
  technology: string | null;
  /** Servidor do cliente em manutenção, quando o provider informa. */
  serverMaintenance: boolean | null;
}

/**
 * Result of a refresh attempt.
 *
 * `snapshot` is the last VALID observation and is present even when the
 * refresh itself failed — that is what lets the UI say "could not update; last
 * known: Online at 08:42" instead of collapsing to a wrong state.
 */
export interface DiagnosticRefreshResult {
  ok: boolean;
  snapshot: CustomerDiagnostic | null;
  /** Only set when `ok` is false. Safe to render. */
  errorCode?: IntegrationErrorCode;
  errorMessage?: string;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Last known diagnostic for a customer, or null if none was ever recorded.
 *
 * Tenant-filtered in SQL rather than reached through the customer relation, so
 * a mismatched company returns nothing instead of relying on FK navigation
 * being correct — same rule as every other child read in this codebase.
 */
export async function getCustomerDiagnostic(
  companyId: string,
  customerId: string,
): Promise<CustomerDiagnostic | null> {
  const snapshot = await prisma.customerDiagnosticSnapshot.findFirst({
    where: { companyId, customerId },
    orderBy: { observedAt: "desc" },
  });
  if (!snapshot) return null;
  return {
    connectivityStatus: snapshot.connectivityStatus,
    observedAt: snapshot.observedAt,
    sourceUpdatedAt: snapshot.sourceUpdatedAt,
    provider: snapshot.externalProvider,
    technology: snapshot.technology,
    serverMaintenance: snapshot.serverMaintenance,
  };
}

/**
 * O mesmo diagnóstico, para MUITOS clientes — `CTO-3.2.2`.
 *
 * ## Isto AMPLIA a autoridade; não cria uma segunda
 *
 * O Mapa Operacional precisa de conectividade para todos os clientes de um
 * recorte, e `getCustomerDiagnostic` responde por um. Repetir a chamada num laço
 * produziria `N+1` — e com duzentos marcadores visíveis isso é duzentas
 * consultas para desenhar uma tela.
 *
 * A extração autorizada é esta: **a mesma tabela, o mesmo DTO, a mesma
 * ordenação, e nenhuma regra nova.** Tudo o que muda é o número de linhas que
 * voltam numa consulta só. Se um dia a semântica individual mudar, esta muda
 * junto, porque não há segunda decisão escrita em lugar nenhum — e há teste
 * comparando as duas saídas cliente a cliente.
 *
 * ## Nada aqui fala com provider
 *
 * Como a leitura individual, esta é uma consulta local. **Abrir, arrastar ou dar
 * zoom no mapa não dispara atualização externa**, não consome a cota de refresh
 * da OS (PRD §337) e não depende de o ERP estar no ar. O que o mapa mostra é o
 * último estado observado — e quando não há nenhum, `UNKNOWN`, que a tela lê
 * como *"sem leitura"*.
 *
 * ## Ausência é `UNKNOWN`, e nunca `OFFLINE`
 *
 * Um cliente sem snapshot simplesmente não aparece no mapa devolvido. Quem
 * compõe o DTO trata a ausência como `UNKNOWN` — e é obrigação de quem chama
 * não confundir "não sabemos" com "está fora do ar". Esse é o invariante central
 * do módulo, e ele não é enfraquecido por existir uma leitura em lote.
 */
export async function getConnectivityForCustomers(
  companyId: string,
  customerIds: string[],
): Promise<Map<string, CustomerDiagnostic>> {
  const resultado = new Map<string, CustomerDiagnostic>();
  if (customerIds.length === 0) return resultado;

  /*
    Tenant em SQL, como na leitura individual.

    O `customerId IN (…)` sozinho alcançaria a linha por id; é o `companyId` ao
    lado dele que impede um id de outra empresa, chegado por qualquer caminho,
    de devolver conectividade alheia.
  */
  const linhas = await prisma.customerDiagnosticSnapshot.findMany({
    where: { companyId, customerId: { in: customerIds } },
    orderBy: { observedAt: "desc" },
  });

  for (const [customerId, linha] of Array.from(latestPerCustomer(linhas))) {
    resultado.set(customerId, {
      connectivityStatus: linha.connectivityStatus,
      observedAt: linha.observedAt,
      sourceUpdatedAt: linha.sourceUpdatedAt,
      provider: linha.externalProvider,
      technology: linha.technology,
      serverMaintenance: linha.serverMaintenance,
    });
  }

  return resultado;
}

/**
 * A regra de desempate entre leituras de um mesmo cliente — num lugar só.
 *
 * `@@unique([companyId, customerId, externalProvider])` permite mais de uma
 * linha por cliente — uma por provider —, e uma empresa que trocou de ERP tem
 * as duas. `getCustomerDiagnostic` resolve isso com `findFirst` ordenado por
 * `observedAt desc`; as leituras em lote recebem as linhas na MESMA ordem, e a
 * primeira de cada cliente vence.
 *
 * Existe como função para que o lote por clientes e o lote da empresa inteira
 * não possam discordar sobre qual leitura vale: se discordassem, o mapa e o
 * painel mostrariam conectividades diferentes para o mesmo cliente.
 */
function latestPerCustomer<T extends { customerId: string }>(
  linhasPorObservacaoDesc: readonly T[],
): Map<string, T> {
  const ultimas = new Map<string, T>();
  for (const linha of linhasPorObservacaoDesc) {
    if (!ultimas.has(linha.customerId)) ultimas.set(linha.customerId, linha);
  }
  return ultimas;
}

/**
 * O estado de conectividade de cada cliente da EMPRESA que tem leitura — a
 * contagem de "clientes offline" do painel operacional (DASH-1, PRD §380).
 *
 * É a mesma autoridade, amplificada outra vez: mesma tabela, mesma ordem, mesma
 * regra de desempate (`latestPerCustomer`) — só que sem a lista de ids, porque o
 * painel pergunta pela carteira e não por um recorte do mapa. Mandar os ids de
 * milhares de clientes num `IN (…)` pesaria mais que ler as linhas da empresa.
 *
 * ## O que ela NÃO faz
 *
 * - **não chama provider** — é leitura de banco, como as outras duas;
 * - **não devolve cliente sem leitura**: ausência é `UNKNOWN`, e quem conta é
 *   obrigado a não confundir "não sabemos" com "está fora do ar" (§370);
 * - só traz os três campos que uma contagem precisa.
 *
 * Devolve o `observedAt` junto do estado (DASH-1a): a listagem do recorte
 * "Clientes offline" mostra a idade da leitura de cada linha, e ela já vem
 * nesta mesma consulta — lê-la de novo por cliente seria o `N+1` que o lote
 * existe para evitar.
 *
 * O `companyId` também dentro da relação: o snapshot é gravado com o tenant do
 * cliente, e conferir de novo custa nada — a mesma lição da `DQ-7.1`, onde uma
 * FK simples atravessava empresas.
 */
export interface CompanyConnectivityReading {
  status: ConnectivityStatus;
  observedAt: Date;
}

export async function getCompanyConnectivityStatuses(
  companyId: string,
  options: { activeCustomersOnly?: boolean } = {},
): Promise<Map<string, CompanyConnectivityReading>> {
  const linhas = await prisma.customerDiagnosticSnapshot.findMany({
    where: {
      companyId,
      ...(options.activeCustomersOnly
        ? { customer: { companyId, active: true } }
        : {}),
    },
    select: { customerId: true, connectivityStatus: true, observedAt: true },
    orderBy: { observedAt: "desc" },
  });

  const estados = new Map<string, CompanyConnectivityReading>();
  for (const [customerId, linha] of Array.from(latestPerCustomer(linhas))) {
    estados.set(customerId, {
      status: linha.connectivityStatus,
      observedAt: linha.observedAt,
    });
  }
  return estados;
}

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

/**
 * Which provider this company's diagnostics come from.
 *
 * Read from the company's own integration row, never from the request: a
 * caller must not be able to pick which ERP answers for a tenant, and the
 * value is what the UI labels the result with. A company with no integration
 * configured has no provider, which is a "not supported" state rather than a
 * silent fallback to the mock — labelling mock data as if it came from a real
 * ERP is precisely the confusion this avoids.
 */
async function resolveProvider(companyId: string): Promise<ERPProvider | null> {
  const integration = await prisma.eRPIntegration.findFirst({
    where: { companyId },
    select: { provider: true, enabled: true },
  });
  if (!integration || !integration.enabled) return null;
  return integration.provider;
}

/**
 * Queries the provider and, ONLY on a valid answer, records it.
 *
 * The central invariant of this module: an integration failure is a statement
 * about the integration, never about the customer. Every failure path returns
 * `ok: false` with the previous snapshot untouched. Nothing here can write
 * OFFLINE as a consequence of an error — `OFFLINE` is only ever persisted when
 * a provider positively reported it.
 *
 * A failed refresh is therefore non-destructive by construction, which is what
 * makes it safe for the technician's screen to fall back to "last known".
 */
export async function refreshCustomerDiagnostic(
  companyId: string,
  actorUserId: string,
  customerId: string,
): Promise<DiagnosticRefreshResult> {
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, companyId },
    select: {
      id: true,
      name: true,
      document: true,
      externalId: true,
    },
  });
  if (!customer) {
    throw notFound("Cliente não encontrado.");
  }

  const provider = await resolveProvider(companyId);
  const previous = await getCustomerDiagnostic(companyId, customerId);

  if (!provider) {
    return {
      ok: false,
      snapshot: previous,
      errorCode: "NOT_SUPPORTED",
      errorMessage:
        "Nenhuma integração de ERP está habilitada para esta empresa.",
    };
  }

  /**
   * A construção do adapter passou a poder falhar (credencial ausente ou
   * ilegível), então entra no caminho guardado. Fora dele, um provider sem
   * credencial derrubaria a rota inteira com 500 em vez de devolver o
   * snapshot anterior com o motivo.
   */
  let adapter;
  try {
    adapter = await resolveCompanyAdapter(companyId, provider);
  } catch (error) {
    const normalized = isIntegrationError(error)
      ? error
      : new IntegrationError("NOT_SUPPORTED", provider);
    console.warn(
      `[diagnostics] provider=${provider} company=${companyId} op=resolveAdapter outcome=${normalized.code}`,
    );
    return {
      ok: false,
      snapshot: previous,
      errorCode: normalized.code,
      errorMessage: normalized.userMessage,
    };
  }

  if (!supportsDiagnostics(adapter)) {
    return {
      ok: false,
      snapshot: previous,
      errorCode: "NOT_SUPPORTED",
      errorMessage: new IntegrationError("NOT_SUPPORTED", provider).userMessage,
    };
  }

  const ref: ERPCustomerRef = {
    externalId: customer.externalId,
    document: customer.document,
    name: customer.name,
  };

  let observation;
  try {
    // The deadline lives here, not inside the adapter: applied at the call
    // site it binds every adapter, including ones written later that forget.
    observation = await withIntegrationTimeout(
      adapter.fetchCustomerConnectivity(ref),
      provider,
    );
  } catch (error) {
    const normalized = isIntegrationError(error)
      ? error
      : // An adapter that throws something unexpected is an adapter bug, not a
        // customer state. It is normalized here rather than propagated so a
        // stray provider error can never escape as a 500 carrying a URL or
        // token in its message.
        new IntegrationError(
          "INVALID_RESPONSE",
          provider,
          error instanceof Error ? error.message : String(error),
        );

    // Structured server-side observability. Never the payload, never secrets,
    // never the customer's document — provider, tenant, operation, outcome.
    console.warn(
      `[diagnostics] provider=${provider} company=${companyId} op=fetchCustomerConnectivity outcome=${normalized.code}`,
    );

    return {
      ok: false,
      // Preserved on purpose: the previous observation is still the best true
      // thing we know.
      snapshot: previous,
      errorCode: normalized.code,
      errorMessage: normalized.userMessage,
    };
  }

  const observedAt = new Date();

  /**
   * Stale-write protection.
   *
   * Two concurrent refreshes can return out of order. When the provider tells
   * us when the state changed, that is the only reliable way to order them, so
   * an older `sourceUpdatedAt` never overwrites a newer one. When it does not
   * (both null), there is nothing to order by and last-write-wins is honest —
   * inventing an ordering from our own receive time would be fabricating
   * precision the provider never gave us.
   */
  const existing = await prisma.customerDiagnosticSnapshot.findUnique({
    where: {
      companyId_customerId_externalProvider: {
        companyId,
        customerId,
        externalProvider: provider,
      },
    },
  });

  const wouldRegress =
    existing?.sourceUpdatedAt &&
    observation.sourceUpdatedAt &&
    observation.sourceUpdatedAt < existing.sourceUpdatedAt;

  if (wouldRegress) {
    return {
      ok: true,
      snapshot: {
        connectivityStatus: existing.connectivityStatus,
        observedAt: existing.observedAt,
        sourceUpdatedAt: existing.sourceUpdatedAt,
        provider,
        technology: existing.technology,
        serverMaintenance: existing.serverMaintenance,
      },
    };
  }

  const saved = await prisma.customerDiagnosticSnapshot.upsert({
    where: {
      companyId_customerId_externalProvider: {
        companyId,
        customerId,
        externalProvider: provider,
      },
    },
    create: {
      companyId,
      customerId,
      externalProvider: provider,
      connectivityStatus: observation.status,
      observedAt,
      sourceUpdatedAt: observation.sourceUpdatedAt,
      technology: observation.technology ?? null,
      serverMaintenance: observation.serverMaintenance ?? null,
    },
    update: {
      connectivityStatus: observation.status,
      observedAt,
      sourceUpdatedAt: observation.sourceUpdatedAt,
      /**
       * Os extras acompanham a observação nova, inclusive quando vêm nulos.
       * Manter um valor antigo aqui faria a tela exibir uma tecnologia que a
       * leitura atual não confirmou — informação velha apresentada como
       * recente é pior que ausência de informação.
       */
      technology: observation.technology ?? null,
      serverMaintenance: observation.serverMaintenance ?? null,
    },
  });

  // High-value event only: a manual refresh that actually produced a new
  // observation. Reads that merely render an existing snapshot are not audited
  // — auditing every page view would bury the events that matter in noise.
  // No document, no phone, no payload: provider, customer id and outcome.
  await logAudit({
    companyId,
    userId: actorUserId,
    action: "CUSTOMER_DIAGNOSTIC.REFRESHED",
    entity: "Customer",
    entityId: customerId,
    details: `Diagnóstico atualizado via ${provider}: ${observation.status}`,
  });

  return {
    ok: true,
    snapshot: {
      connectivityStatus: saved.connectivityStatus,
      observedAt: saved.observedAt,
      sourceUpdatedAt: saved.sourceUpdatedAt,
      provider: saved.externalProvider,
      technology: saved.technology,
      serverMaintenance: saved.serverMaintenance,
    },
  };
}

/*
  Os rótulos moram em `./connectivity-presentation`, e são reexportados aqui.

  Eles existiam em duplicata — nesta tabela e dentro de `CustomerDiagnosticPanel`
  —, e o mapa ia abrir a terceira cópia. O módulo novo importa só TIPO do Prisma,
  então serve servidor e navegador; este caminho continua valendo para quem já o
  usava.
*/
export { CONNECTIVITY_LABELS } from "./connectivity-presentation";

export const PROVIDER_LABELS: Record<ERPProvider, string> = {
  MOCK: "Mock ERP",
  RECEITANET: "ReceitaNet",
  SGP: "SGP",
};
