import type {
  ERPConnectionResult,
  ERPIntegrationContract,
  ERPListServiceOrdersResult,
} from "./contract";

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
export class MockERPAdapter implements ERPIntegrationContract {
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
}

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
