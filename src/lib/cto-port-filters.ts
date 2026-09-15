import type {
  ConnectivityStatus,
  CtoPortAdministrativeState,
} from "@prisma/client";
import { CONNECTIVITY_PRESENTATION } from "./connectivity-presentation";

/**
 * # RC-1D — os filtros da lista de portas da CTO
 *
 * Importa **só tipo** do Prisma: roda no navegador, sobre o que a página já
 * trouxe. Filtrar é apresentação — o servidor já decidiu o que esta pessoa pode
 * ver, e esconder linha na tela não amplia nem reduz isso.
 *
 * ## Duas unidades, e elas não se misturam
 *
 * ```text
 * PORTAS     Todas · Livres · Ocupadas            conta PORTA
 * CLIENTES   Online · Offline · Sem leitura ·     conta CLIENTE ATIVO
 *            Com OS aberta
 * ```
 *
 * "Livres" e "Online" nunca aparecem como parcelas da mesma soma: uma é porta,
 * a outra é pessoa (PRD §373). E os filtros de cliente contam o MESMO conjunto
 * que o resumo — clientes de cadastro ativo (PRD §372) —, então "Online (4)" no
 * filtro e "Online 4" no resumo são o mesmo número, e há teste que prova.
 *
 * ## As definições de porta são as do resumo
 *
 * "Livre" e "Ocupada" seguem `summarizePortCounts` (`cto-read-model.ts`): só
 * portas DENTRO da capacidade; livre é `AVAILABLE` sem vínculo. Um teste
 * compara as duas contagens para a mesma caixa.
 */

export const CTO_PORT_FILTERS = [
  "ALL",
  "FREE",
  "OCCUPIED",
  "ONLINE",
  "OFFLINE",
  "UNKNOWN",
  "OPEN_OS",
] as const;
export type CtoPortFilter = (typeof CTO_PORT_FILTERS)[number];

/** Filtros de PORTA — contam posições. */
export const CTO_PORT_OCCUPANCY_FILTERS: readonly CtoPortFilter[] = [
  "ALL",
  "FREE",
  "OCCUPIED",
];

/** Filtros de CLIENTE — contam clientes de cadastro ativo. */
export const CTO_PORT_CUSTOMER_FILTERS: readonly CtoPortFilter[] = [
  "ONLINE",
  "OFFLINE",
  "UNKNOWN",
  "OPEN_OS",
];

/**
 * Os rótulos. Os de conectividade vêm da tabela ÚNICA de apresentação
 * (`mapLabel`): "Sem leitura", nunca "Desconhecido" nem "Offline".
 */
export const CTO_PORT_FILTER_LABELS: Record<CtoPortFilter, string> = {
  ALL: "Todas",
  FREE: "Livres",
  OCCUPIED: "Ocupadas",
  ONLINE: CONNECTIVITY_PRESENTATION.ONLINE.mapLabel,
  OFFLINE: CONNECTIVITY_PRESENTATION.OFFLINE.mapLabel,
  UNKNOWN: CONNECTIVITY_PRESENTATION.UNKNOWN.mapLabel,
  OPEN_OS: "Com OS aberta",
};

/** O mínimo que o filtro lê de uma porta. */
export interface FilterablePort {
  number: number;
  withinCapacity: boolean;
  administrativeState: CtoPortAdministrativeState;
  occupied: boolean;
}

/** O mínimo que o filtro lê do cliente de uma porta. */
export interface FilterablePortCustomer {
  portNumber: number;
  customerActive: boolean;
  connectivityStatus: ConnectivityStatus;
  openServiceOrderCount: number;
}

/** A porta entra no filtro? `customer` é o ocupante, quando há. */
export function portMatchesFilter(
  filter: CtoPortFilter,
  port: FilterablePort,
  customer: FilterablePortCustomer | undefined,
): boolean {
  // Filtro de cliente só vê cliente de cadastro ativo — o conjunto do resumo.
  const ativo = customer?.customerActive === true ? customer : undefined;
  switch (filter) {
    case "ALL":
      return true;
    case "FREE":
      return (
        port.withinCapacity &&
        port.administrativeState === "AVAILABLE" &&
        !port.occupied
      );
    case "OCCUPIED":
      return port.withinCapacity && port.occupied;
    case "ONLINE":
    case "OFFLINE":
    case "UNKNOWN":
      return ativo !== undefined && ativo.connectivityStatus === filter;
    case "OPEN_OS":
      return ativo !== undefined && ativo.openServiceOrderCount > 0;
  }
}

/** Quantas portas cada filtro mostraria — o número ao lado do botão. */
export function countPortFilters(
  ports: readonly FilterablePort[],
  customers: readonly FilterablePortCustomer[],
): Record<CtoPortFilter, number> {
  const porPorta = new Map(customers.map((c) => [c.portNumber, c]));
  const contagem = Object.fromEntries(
    CTO_PORT_FILTERS.map((f) => [f, 0]),
  ) as Record<CtoPortFilter, number>;
  for (const port of ports) {
    const customer = porPorta.get(port.number);
    for (const filtro of CTO_PORT_FILTERS) {
      if (portMatchesFilter(filtro, port, customer)) contagem[filtro] += 1;
    }
  }
  return contagem;
}
