import type {
  ServiceOrderPriority,
  ServiceOrderStatus,
} from "@prisma/client";

/**
 * # DTOs do Field
 *
 * Projeções PRÓPRIAS, e não o `PublicServiceOrder` da web.
 *
 * A tentação de reaproveitar é grande e está errada. `PublicServiceOrder`
 * carrega `customer.document` — o CPF — porque a tela administrativa precisa
 * dele. Devolvê-lo ao aplicativo colocaria CPF no cache de dezenas de
 * aparelhos que andam pela rua e são roubados, para uma tela que não usa o
 * campo. Um DTO compartilhado também faz a minimização depender de ninguém
 * nunca acrescentar um campo ao lado errado; separado, acrescentar campo ao
 * Field é uma decisão explícita.
 *
 * ## O que NUNCA entra
 *
 * ```text
 * CPF · senha PPPoE · token · ciphertext de credencial
 * payload cru de provider · dado financeiro
 * dados de outros técnicos · internals de auditoria
 * ```
 *
 * ## Provider não aparece
 *
 * `origin`, `externalProvider`, `externalId` e `externalNumber` ficam de fora.
 * Uma OS importada do ReceitaNet tem de funcionar no Field **exatamente como
 * uma interna** depois de atribuída (§48): se o app não recebe o dado, não
 * existe `if (RECEITANET)` para escrever — a ausência é a garantia.
 */

/** `Decimal` do Prisma vira número, ou nulo se não der. */
function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export interface FieldServiceOrderListItem {
  id: string;
  /** Identidade operacional. É o que o técnico fala ao telefone. */
  number: number;
  status: ServiceOrderStatus;
  priority: ServiceOrderPriority;
  type: string;
  subtype: string | null;
  /** Só o nome. Sem documento, sem contato, sem endereço. */
  customerName: string;
  /** O suficiente para o técnico ordenar o dia mentalmente. */
  district: string | null;
  city: string | null;
  scheduledAt: string | null;
  /**
   * Existe coordenada utilizável para navegação?
   *
   * Booleano, não a coordenada. A lista não navega para lugar nenhum — ela só
   * precisa decidir se mostra o ícone. Mandar latitude e longitude de toda a
   * carteira do dia seria distribuir o endereço de cada cliente para um cache
   * que não tem uso para eles.
   */
  hasLocation: boolean;
  updatedAt: string;
  /** Token do compare-and-set. Volta como `expectedVersion` na mutação. */
  version: number;
}

export interface FieldOrderCustomer {
  name: string;
  /** Os dois contatos: telefone que não atende é o motivo nº 1 de visita perdida. */
  phone: string | null;
  secondaryPhone: string | null;
  address: string | null;
  number: string | null;
  complement: string | null;
  district: string | null;
  city: string | null;
  state: string | null;
  zipCode: string | null;
  /**
   * Coordenada para o app montar o destino no Google Maps / Waze.
   *
   * Vai como número, não como URL pronta: quem sabe se o aparelho tem Waze
   * instalado é o aparelho. O backend montar o link obrigaria a decidir aqui
   * qual aplicativo o técnico usa, e a trocar o servidor quando isso mudar.
   *
   * A tela não mostra o par cru — ele existe para virar destino.
   */
  latitude: number | null;
  longitude: number | null;
}

export interface FieldOrderConnection {
  id: string;
  type: string;
  username: string;
  /**
   * Se existe senha gravada — **nunca a senha**, nem um fragmento.
   *
   * O texto claro sai apenas pela revelação explícita e auditada, e não é
   * persistido no aparelho (`docs/SECURITY.md` §8.9).
   */
  passwordConfigured: boolean;
}

export interface FieldOrderExecution {
  id: string;
  diagnosis: string | null;
  workPerformed: string | null;
  notes: string | null;
  /** Lock PRÓPRIO da execução, separado do lock da OS. */
  version: number;
}

export interface FieldOrderDiagnostic {
  /**
   * `ONLINE` · `OFFLINE` · `UNKNOWN`.
   *
   * `UNKNOWN` é resposta de primeira classe, não código de falha. "Não
   * conseguimos falar com o ERP" e "o ERP diz que o cliente está fora" são
   * fatos diferentes, e colapsar o primeiro em `OFFLINE` mandaria um técnico
   * ao endereço por causa de uma integração instável.
   */
  connectivityStatus: string;
  observedAt: string | null;
}

export interface FieldServiceOrderDetail {
  id: string;
  number: number;
  status: ServiceOrderStatus;
  priority: ServiceOrderPriority;
  type: string;
  subtype: string | null;
  description: string;
  scheduledAt: string | null;
  assignedAt: string | null;
  startedAt: string | null;
  updatedAt: string;
  version: number;
  customer: FieldOrderCustomer;
  connection: FieldOrderConnection | null;
  execution: FieldOrderExecution | null;
  diagnostic: FieldOrderDiagnostic | null;
}

/** Entrada mínima que a projeção de lista consome. */
export interface ListRow {
  id: string;
  number: number;
  status: ServiceOrderStatus;
  priority: ServiceOrderPriority;
  type: string;
  subtype: string | null;
  scheduledAt: Date | null;
  updatedAt: Date;
  version: number;
  customer: {
    name: string;
    district: string | null;
    city: string | null;
    latitude: unknown;
    longitude: unknown;
  };
}

export function toFieldListItem(row: ListRow): FieldServiceOrderListItem {
  const lat = toNumber(row.customer.latitude);
  const lng = toNumber(row.customer.longitude);
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    priority: row.priority,
    type: row.type,
    subtype: row.subtype,
    customerName: row.customer.name,
    district: row.customer.district,
    city: row.customer.city,
    scheduledAt: row.scheduledAt?.toISOString() ?? null,
    hasLocation: lat !== null && lng !== null && !(lat === 0 && lng === 0),
    updatedAt: row.updatedAt.toISOString(),
    version: row.version,
  };
}

export interface DetailRow extends ListRow {
  description: string;
  assignedAt: Date | null;
  startedAt: Date | null;
  customer: ListRow["customer"] & {
    phone: string | null;
    secondaryPhone: string | null;
    address: string | null;
    number: string | null;
    complement: string | null;
    state: string | null;
    zipCode: string | null;
  };
}

export function toFieldDetail(
  row: DetailRow,
  extras: {
    connection: FieldOrderConnection | null;
    execution: FieldOrderExecution | null;
    diagnostic: FieldOrderDiagnostic | null;
  },
): FieldServiceOrderDetail {
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    priority: row.priority,
    type: row.type,
    subtype: row.subtype,
    description: row.description,
    scheduledAt: row.scheduledAt?.toISOString() ?? null,
    assignedAt: row.assignedAt?.toISOString() ?? null,
    startedAt: row.startedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
    version: row.version,
    customer: {
      name: row.customer.name,
      phone: row.customer.phone,
      secondaryPhone: row.customer.secondaryPhone,
      address: row.customer.address,
      number: row.customer.number,
      complement: row.customer.complement,
      district: row.customer.district,
      city: row.customer.city,
      state: row.customer.state,
      zipCode: row.customer.zipCode,
      latitude: toNumber(row.customer.latitude),
      longitude: toNumber(row.customer.longitude),
    },
    connection: extras.connection,
    execution: extras.execution,
    diagnostic: extras.diagnostic,
  };
}
