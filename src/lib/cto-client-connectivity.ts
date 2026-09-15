import {
  getCtoOperationalSummaries,
  getCtoPortCustomers,
  type CtoOperationalSummary,
  type CtoPortCustomer,
} from "./operational-map";

/**
 * # RC-1D — os clientes da caixa, na tela da CTO
 *
 * A tela da CTO respondia bem *"como estão as portas?"* e mal *"como estão os
 * clientes desta caixa?"*. Esta leitura responde a segunda, **só lendo**.
 *
 * ## Nenhuma autoridade nova
 *
 * As duas perguntas já tinham resposta no Mapa Operacional, e a tela reusa as
 * MESMAS funções — não uma cópia delas:
 *
 * ```text
 * resumo     getCtoOperationalSummaries   o que o popup da caixa mostra
 * por porta  getCtoPortCustomers          o que "Ver clientes" do popup lista
 * ```
 *
 * Por isso o detalhe e o popup não têm como divergir: é a mesma função, sobre o
 * mesmo vínculo (`CustomerNetworkConnection` ativa), o mesmo snapshot
 * (`CustomerDiagnosticSnapshot`, pela leitura em lote de `customer-diagnostics`)
 * e o mesmo predicado de OS aberta (`OPEN_SERVICE_ORDER_STATUSES`). A semântica
 * é a da PRD §372: "clientes ativos" são os de cadastro ativo com vínculo ativo
 * na caixa, e online, offline e sem leitura contam **esses**.
 *
 * ## Nada é consultado fora do banco
 *
 * Abrir a CTO não fala com ERP, OLT nem provider nenhum, e não dispara
 * atualização de diagnóstico: o que aparece é o último snapshot conhecido, e
 * sem snapshot é `UNKNOWN` — "Sem leitura", nunca "Offline" (PRD §370).
 *
 * ## Quantas consultas
 *
 * Constante, independente de quantas portas estão ocupadas: três para o resumo
 * e três para a lista (vínculos, snapshots, OS abertas agrupadas). Nunca uma por
 * cliente.
 *
 * ## Tenant
 *
 * Quem chama já provou que a caixa é da empresa (`getOperationalCtoDetail`), e
 * mesmo assim as duas leituras filtram vínculo, snapshot e OS por `companyId`:
 * uma caixa de outra empresa devolve zero, e um snapshot ou uma OS de outra
 * empresa apontando para um cliente daqui não conta.
 */

export interface CtoClientConnectivity {
  /** O MESMO resumo do popup da caixa no mapa. */
  summary: CtoOperationalSummary;
  /** Quem está em cada porta agora, com cadastro, conectividade e OS abertas. */
  customers: CtoPortCustomer[];
}

export async function getCtoClientConnectivity(
  companyId: string,
  ctoId: string,
): Promise<CtoClientConnectivity> {
  const [leitura, customers] = await Promise.all([
    getCtoOperationalSummaries(companyId, [ctoId]),
    getCtoPortCustomers(companyId, ctoId),
  ]);
  return {
    summary: leitura.summaries.get(ctoId) ?? {
      activeCustomerCount: 0,
      onlineCount: 0,
      offlineCount: 0,
      unknownCount: 0,
      openServiceOrderCount: 0,
    },
    customers,
  };
}
