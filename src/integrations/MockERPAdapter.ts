import type {
  ERPConnectionResult,
  ERPIntegrationContract,
  ERPListServiceOrdersResult,
} from "./contract";
import type {
  ERPConnectivityObservation,
  ERPCustomerRef,
  ERPDiagnosticsCapability,
} from "./diagnostics";
import { IntegrationError } from "./errors";

/**
 * MockERPAdapter
 *
 * Simulates an ERP connection for development and tests.
 * Useful for exercising the integration layer (e.g. the "test connection"
 * feature and the service order sync) without an external ERP system.
 *
 * The data below is local only: no external calls are made and no real
 * ReceitaNet endpoints are invented.
 */
export class MockERPAdapter
  implements ERPIntegrationContract, ERPDiagnosticsCapability
{
  readonly provider = "MOCK";

  async testConnection(): Promise<ERPConnectionResult> {
    const startedAt = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 25));
    return {
      ok: true,
      provider: this.provider,
      latencyMs: Date.now() - startedAt,
      message: "Conexão com o Mock ERP estabelecida com sucesso.",
    };
  }

  async listServiceOrders(): Promise<ERPListServiceOrdersResult> {
    await new Promise((resolve) => setTimeout(resolve, 15));
    return { orders: MOCK_SERVICE_ORDERS };
  }

  /**
   * Deterministic connectivity per customer, so UI and E2E can exercise every
   * branch — including the failure ones — without a network.
   *
   * Keyed on `externalId` because that is the only stable provider-side handle
   * AlfaOS holds. A customer the mock does not know resolves to UNKNOWN rather
   * than CUSTOMER_NOT_FOUND: absence from this tiny fixture list is not
   * evidence that a real ERP would not know them, and UNKNOWN is the honest
   * answer for "no information".
   */
  async fetchCustomerConnectivity(
    ref: ERPCustomerRef,
  ): Promise<ERPConnectivityObservation> {
    await new Promise((resolve) => setTimeout(resolve, 10));
    const id = ref.externalId ?? "";

    // Suffix conventions come FIRST, and are matched rather than compared
    // exactly, so a test can mint as many distinct customers as it needs
    // (`DIAG-A-FAIL`, `DIAG-B-FAIL`, ...) without colliding on
    // `@@unique([companyId, externalProvider, externalId])`. Exact-matching a
    // single magic id would force every scenario in a suite to share one
    // customer row.
    if (id.endsWith(MOCK_UPSTREAM_FAILURE_SUFFIX)) {
      // Simulated outage. Thrown, never returned as OFFLINE — this is the
      // branch that proves the domain keeps the two apart.
      throw new IntegrationError(
        "UPSTREAM_UNAVAILABLE",
        this.provider,
        "cenário determinístico de indisponibilidade do Mock ERP",
      );
    }
    if (id.endsWith(MOCK_INVALID_RESPONSE_SUFFIX)) {
      throw new IntegrationError(
        "INVALID_RESPONSE",
        this.provider,
        "cenário determinístico de payload inválido do Mock ERP",
      );
    }
    if (id.endsWith(MOCK_TIMEOUT_SUFFIX)) {
      // Never settles: exercises the caller's deadline rather than pretending
      // to be one.
      return new Promise<ERPConnectivityObservation>(() => {});
    }
    if (id.endsWith(MOCK_ONLINE_SUFFIX)) {
      return {
        status: "ONLINE",
        sourceUpdatedAt: new Date(Date.now() - 5 * 60_000),
      };
    }
    if (id.endsWith(MOCK_OFFLINE_SUFFIX)) {
      return { status: "OFFLINE", sourceUpdatedAt: new Date(Date.now() - 60_000) };
    }

    switch (id) {
      case "MOCK-CUST-1":
        return {
          status: "ONLINE",
          // A provider that reports when the state changed lets the domain
          // order two concurrent responses correctly.
          sourceUpdatedAt: new Date(Date.now() - 5 * 60_000),
        };
      case "MOCK-CUST-2":
        return { status: "OFFLINE", sourceUpdatedAt: new Date(Date.now() - 60_000) };
      case "MOCK-CUST-3":
        // Provider answered, but with nothing classifiable.
        return { status: "UNKNOWN", sourceUpdatedAt: null };
      default:
        // Not knowing a customer is not evidence about their link.
        return { status: "UNKNOWN", sourceUpdatedAt: null };
    }
  }
}

/**
 * Suffixes that drive the mock's scenario branches. Any external id ending in
 * one of these selects that behaviour, so callers can build unique ids.
 */
export const MOCK_UPSTREAM_FAILURE_SUFFIX = "-FAIL";
export const MOCK_INVALID_RESPONSE_SUFFIX = "-INVALID";
export const MOCK_TIMEOUT_SUFFIX = "-TIMEOUT";
export const MOCK_ONLINE_SUFFIX = "-ONLINE";
export const MOCK_OFFLINE_SUFFIX = "-OFFLINE";

const MOCK_SERVICE_ORDERS = [
  {
    externalId: "MOCK-10001",
    externalNumber: "10001",
    type: "Manutenção",
    description: "Cliente sem conexão de internet.",
    priority: "HIGH" as const,
    customer: {
      externalId: "MOCK-CUST-1",
      name: "João da Silva",
      document: "123.456.789-01",
      phone: "(11) 99999-0001",
      email: "joao.silva@example.com",
      address: "Rua das Flores",
      number: "123",
      district: "Centro",
      city: "São Paulo",
      state: "SP",
      zipCode: "01001-000",
    },
  },
  {
    externalId: "MOCK-10002",
    externalNumber: "10002",
    type: "Instalação",
    description: "Instalação de novo ponto de fibra óptica.",
    priority: "NORMAL" as const,
    customer: {
      externalId: "MOCK-CUST-2",
      name: "Maria Oliveira",
      document: "987.654.321-00",
      phone: "(11) 99999-0002",
      email: "maria.oliveira@example.com",
      address: "Av. Paulista",
      number: "1000",
      district: "Bela Vista",
      city: "São Paulo",
      state: "SP",
      zipCode: "01310-100",
    },
  },
  {
    externalId: "MOCK-10003",
    externalNumber: "10003",
    type: "Suporte",
    subtype: "Internet lenta",
    description: "Cliente relata navegação lenta no período noturno.",
    priority: "NORMAL" as const,
    customer: {
      externalId: "MOCK-CUST-3",
      name: "Carlos Souza",
      document: "111.222.333-44",
      phone: "(11) 99999-0003",
      email: "carlos.souza@example.com",
      address: "Rua das Acácias",
      number: "45",
      district: "Jardim América",
      city: "São Paulo",
      state: "SP",
      zipCode: "01430-000",
    },
  },
];
