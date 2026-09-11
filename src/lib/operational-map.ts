import type { ConnectivityStatus, ServiceOrderPriority,
  ServiceOrderStatus } from "@prisma/client";
import { prisma } from "./prisma";
import { getConnectivityForCustomers } from "./customer-diagnostics";
import { OPEN_SERVICE_ORDER_STATUSES } from "./service-order-labels";
import type { BoundingBox } from "./cto-map";

/**
 * # As camadas operacionais do mapa — clientes e OS abertas
 *
 * ## O que este módulo NÃO faz
 *
 * Ele **não decide conectividade**. `ONLINE`, `OFFLINE` e `UNKNOWN` vêm de
 * `customer-diagnostics`, que é a mesma autoridade que a tela da OS consulta —
 * e vêm por `getConnectivityForCustomers`, que é a leitura em lote sobre a mesma
 * tabela e o mesmo DTO. Se a OS diz `ONLINE`, o mapa diz `ONLINE`; se a OS diz
 * `UNKNOWN`, o mapa diz *sem leitura*.
 *
 * Ele **não fala com ERP**. Nenhum import daqui alcança ReceitaNet, SGP ou
 * adapter de provider: abrir, arrastar ou dar zoom no mapa não dispara
 * atualização externa e não consome a cota de refresh da OS. O mapa lê o último
 * snapshot conhecido, e quando não há nenhum a resposta é `UNKNOWN` — nunca
 * `OFFLINE`.
 *
 * Ele **não infere incidente**. Cinco clientes offline na mesma CTO são cinco
 * fatos, e não um rompimento: falha coletiva é V2, com regra própria.
 *
 * ## O que ele faz, e em quantas consultas
 *
 * ```text
 * clientes do recorte ....... 5 consultas, constante
 * OS abertas do recorte ..... 4 consultas, constante
 * resumo por CTO ............ 3 consultas, constante  (independe de quantas CTOs)
 * clientes por porta ........ 3 consultas, constante
 * ```
 *
 * **Constante é o ponto.** A leitura individual de conectividade, repetida num
 * laço, daria `N+1` — duzentos marcadores seriam duzentas consultas para
 * desenhar uma tela. Cada função aqui resolve o conjunto inteiro de uma vez:
 * uma consulta para as entidades, uma para conectividade, uma para contagem de
 * OS, uma para o vínculo de porta.
 */

// ---------------------------------------------------------------------------
// Tetos
// ---------------------------------------------------------------------------

/**
 * Teto de marcadores de cliente por recorte.
 *
 * Maior que o da CTO (200) porque a ordem de grandeza é outra: uma rede tem
 * dezenas de caixas e milhares de assinantes, e um bairro inteiro cabe em
 * trezentos pontos. Maior que isso a tela deixa de ser legível antes de o
 * servidor reclamar — e a saída correta é aproximar o mapa, que é o que a
 * mensagem de truncamento diz.
 *
 * O teto é do SERVIDOR. Confiar no `limit` que o navegador manda seria deixar
 * o cliente escolher quanto do banco quer levar.
 */
export const CUSTOMER_MAP_MAX_MARKERS = 300;

/** Teto de OS abertas por recorte. Menos numerosas que clientes, por definição. */
export const SERVICE_ORDER_MAP_MAX_MARKERS = 200;

// ---------------------------------------------------------------------------
// DTOs — mínimos de propósito
// ---------------------------------------------------------------------------

/**
 * O vínculo operacional do cliente, quando existe.
 *
 * Ele vem **exclusivamente** de `CustomerNetworkConnection` ativa. Nunca de
 * proximidade, endereço, mesma rua ou qualquer heurística: a pergunta *"em qual
 * caixa este cliente está?"* tem uma resposta registrada, e inventá-la a partir
 * de distância produziria uma afirmação que ninguém fez.
 */
export interface MapCtoLink {
  ctoId: string;
  ctoName: string;
  portNumber: number;
}

/**
 * O cliente, como o mapa precisa dele — e nada além.
 *
 * Sem documento, sem telefone, sem e-mail, sem endereço textual, sem dado
 * financeiro, sem credencial, sem `companyId`, sem payload de ERP. O mapa
 * desenha um ponto e explica o estado dele; quem quiser a ficha abre a ficha.
 */
export interface CustomerMapMarker {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  connectivityStatus: ConnectivityStatus;
  /** ISO, ou `null` quando nunca houve leitura. */
  connectivityObservedAt: string | null;
  openServiceOrderCount: number;
  cto: MapCtoLink | null;
}

export interface CustomerMapView {
  markers: CustomerMapMarker[];
  truncated: boolean;
  limit: number;
  /**
   * Clientes ativos sem localização, **da empresa** — não do recorte.
   *
   * Um cliente sem coordenada não está em região nenhuma, então contá-lo por
   * recorte seria inventar uma pertinência. Mesma decisão da `CTO-3.1` para
   * caixas sem localização.
   */
  missingLocationCount: number;
}

/** A OS aberta, como o mapa precisa dela. */
export interface ServiceOrderMapMarker {
  id: string;
  number: number;
  status: ServiceOrderStatus;
  /**
   * A PRIORIDADE, e ela é a única autoridade de urgência.
   *
   * O enum tem quatro valores e só `URGENT` é urgente: `HIGH` é "Alta", que é
   * outra coisa. Nada no mapa pode deduzir urgência de tipo, status, título ou
   * tempo em aberto — a pergunta "esta OS é urgente?" tem uma resposta no
   * domínio, e é esta.
   */
  priority: ServiceOrderPriority;
  typeName: string | null;
  latitude: number;
  longitude: number;
  customerId: string;
  customerName: string;
  /** A conectividade do CLIENTE da OS — a mesma autoridade, nunca outra. */
  connectivityStatus: ConnectivityStatus;
  connectivityObservedAt: string | null;
  /** ISO. A idade é calculada na tela; nada de `ageMinutes` persistido. */
  openedAt: string;
  technicianName: string | null;
  cto: MapCtoLink | null;
}

export interface ServiceOrderMapView {
  markers: ServiceOrderMapMarker[];
  truncated: boolean;
  limit: number;
  /** OS abertas cujo cliente não tem localização. Contador, nunca marcador falso. */
  missingLocationCount: number;
}

/**
 * O resumo operacional de uma CTO — **derivado, nunca persistido**.
 *
 * Não existe `cto.onlineCount` no schema, e não deve existir: seria um segundo
 * lugar que precisa concordar com o vínculo e com o snapshot, e o que diverge é
 * sempre o que ninguém revisou. É a mesma razão pela qual `OCCUPIED` nunca virou
 * coluna.
 */
export interface CtoOperationalSummary {
  /**
   * Clientes **cadastralmente ativos** com vínculo ativo nesta caixa.
   *
   * Pode ser MENOR que `occupied` do resumo de portas, e a diferença é
   * informação: uma porta ocupada por cliente desativado continua ocupada — o
   * cabo está lá — mas o cliente não conta como ativo. Colapsar os dois números
   * esconderia exatamente esse caso.
   */
  activeCustomerCount: number;
  onlineCount: number;
  offlineCount: number;
  /** Sem leitura. Nunca apresentado como `OFFLINE`. */
  unknownCount: number;
  openServiceOrderCount: number;
}

/** Um cliente numa porta, para o detalhe da caixa. */
export interface CtoPortCustomer {
  portNumber: number;
  customerId: string;
  customerName: string;
  /** Situação CADASTRAL. Não confundir com conectividade. */
  customerActive: boolean;
  connectivityStatus: ConnectivityStatus;
  connectivityObservedAt: string | null;
  openServiceOrderCount: number;
}

// ---------------------------------------------------------------------------
// Peças compartilhadas
// ---------------------------------------------------------------------------

/** O predicado de OS aberta, numa forma só, para todas as consultas daqui. */
const OS_ABERTA = { status: { in: OPEN_SERVICE_ORDER_STATUSES } };

/**
 * Quantas OS abertas cada cliente tem, numa consulta.
 *
 * `groupBy` e não `findMany`: a pergunta é uma contagem, e trazer as linhas para
 * contá-las em memória levaria o conteúdo das OS junto — payload e exposição
 * por nada.
 */
async function contarOsAbertasPorCliente(
  companyId: string,
  customerIds: string[],
): Promise<Map<string, number>> {
  const resultado = new Map<string, number>();
  if (customerIds.length === 0) return resultado;

  const grupos = await prisma.serviceOrder.groupBy({
    by: ["customerId"],
    where: { companyId, customerId: { in: customerIds }, ...OS_ABERTA },
    _count: { _all: true },
  });
  for (const grupo of grupos) {
    resultado.set(grupo.customerId, grupo._count._all);
  }
  return resultado;
}

/**
 * Em qual caixa e porta cada cliente está AGORA, numa consulta.
 *
 * `disconnectedAt: null` é o que separa "está" de "esteve". O histórico existe
 * de propósito (`CTO-2`), e lê-lo como vínculo atual faria a caixa antiga
 * continuar contando o cliente que saiu dela.
 */
async function vinculoAtualPorCliente(
  companyId: string,
  customerIds: string[],
): Promise<Map<string, MapCtoLink>> {
  const resultado = new Map<string, MapCtoLink>();
  if (customerIds.length === 0) return resultado;

  const vinculos = await prisma.customerNetworkConnection.findMany({
    where: { companyId, customerId: { in: customerIds }, disconnectedAt: null },
    select: {
      customerId: true,
      ctoPort: {
        select: { number: true, cto: { select: { id: true, name: true } } },
      },
    },
  });
  for (const vinculo of vinculos) {
    resultado.set(vinculo.customerId, {
      ctoId: vinculo.ctoPort.cto.id,
      ctoName: vinculo.ctoPort.cto.name,
      portNumber: vinculo.ctoPort.number,
    });
  }
  return resultado;
}

/** A ausência de snapshot é `UNKNOWN`. Nunca `OFFLINE`. */
function semLeitura(): { status: ConnectivityStatus; observedAt: string | null } {
  return { status: "UNKNOWN", observedAt: null };
}

// ---------------------------------------------------------------------------
// Camada de clientes ativos
// ---------------------------------------------------------------------------

/**
 * Os clientes ativos localizáveis dentro do recorte.
 *
 * ## `CustomerLocation` é a autoridade geográfica
 *
 * `Customer.latitude`/`longitude` continuam existindo e são mantidas como
 * **projeção de leitura** — o próprio schema diz isso. Ler a projeção aqui
 * funcionaria hoje e passaria a mentir no dia em que a sincronia falhasse, e o
 * sintoma seria um cliente desenhado no lugar errado sem nada quebrando.
 *
 * Nenhuma segunda coordenada é criada, e a semântica de `CustomerLocation` —
 * `accuracyMeters`, `source`, `verified`, `verifiedBy`, histórico — fica
 * intocada. **Localização não verificada continua aparecendo**, porque é o que
 * o produto já faz: inventar aqui uma regra de "só verificado no mapa"
 * esconderia a maior parte da carteira sem que ninguém tivesse decidido isso.
 *
 * ## Cadastro e conectividade são eixos separados
 *
 * A camada é de clientes **cadastralmente ativos** (`active: true`). Um deles
 * pode estar `OFFLINE`, e isso é normal: `ATIVO` responde "é cliente?", e
 * `OFFLINE` responde "o link está no ar?".
 */
export async function getCustomerMapView(
  companyId: string,
  options: {
    bbox: BoundingBox;
    limit?: number;
    /** Filtros da camada, aplicados no SERVIDOR quando barateiam a leitura. */
    connectivity?: ConnectivityStatus[];
    withOpenServiceOrder?: boolean;
  },
): Promise<CustomerMapView> {
  const limit = Math.min(
    Math.max(options.limit ?? CUSTOMER_MAP_MAX_MARKERS, 1),
    CUSTOMER_MAP_MAX_MARKERS,
  );
  const { north, south, east, west } = options.bbox;

  /*
    Recorte e tenant no MESMO predicado SQL.

    Trazer a carteira e filtrar em memória produziria exatamente a mesma lista —
    e é isso que torna o defeito invisível para um teste de resultado. O que
    muda é o banco devolver milhares de linhas antes.
  */
  const clientes = await prisma.customer.findMany({
    where: {
      companyId,
      active: true,
      location: {
        is: {
          latitude: { gte: south, lte: north },
          longitude: { gte: west, lte: east },
        },
      },
    },
    select: {
      id: true,
      name: true,
      location: { select: { latitude: true, longitude: true } },
    },
    orderBy: [{ name: "asc" }],
    // `limit + 1` responde "tem mais?" sem uma segunda consulta de contagem.
    take: limit + 1,
  });

  const missingLocationCount = await prisma.customer.count({
    where: { companyId, active: true, location: { is: null } },
  });

  const truncated = clientes.length > limit;
  const visiveis = truncated ? clientes.slice(0, limit) : clientes;

  if (visiveis.length === 0) {
    return { markers: [], truncated, limit, missingLocationCount };
  }

  const ids = visiveis.map((c) => c.id);
  const [conectividade, osAbertas, vinculos] = await Promise.all([
    getConnectivityForCustomers(companyId, ids),
    contarOsAbertasPorCliente(companyId, ids),
    vinculoAtualPorCliente(companyId, ids),
  ]);

  let markers: CustomerMapMarker[] = visiveis.map((cliente) => {
    const leitura = conectividade.get(cliente.id);
    const estado = leitura
      ? {
          status: leitura.connectivityStatus,
          observedAt: leitura.observedAt.toISOString(),
        }
      : semLeitura();
    return {
      id: cliente.id,
      name: cliente.name,
      latitude: cliente.location!.latitude.toNumber(),
      longitude: cliente.location!.longitude.toNumber(),
      connectivityStatus: estado.status,
      connectivityObservedAt: estado.observedAt,
      openServiceOrderCount: osAbertas.get(cliente.id) ?? 0,
      cto: vinculos.get(cliente.id) ?? null,
    };
  });

  /*
    Os filtros são aplicados DEPOIS da composição, e de propósito.

    Conectividade e contagem de OS não são colunas de `Customer` — elas moram em
    outras tabelas e só existem depois do lote. Empurrá-las para o `where` da
    primeira consulta exigiria juntar `CustomerDiagnosticSnapshot` e
    `ServiceOrder` ali, e o teto passaria a ser aplicado ANTES do filtro: o mapa
    diria "trezentos e truncado" tendo desenhado quatro.

    O custo é ler até `limit` linhas e descartar algumas. O teto continua sendo o
    do servidor, e o recorte continua sendo SQL — o que se descarta é sempre um
    subconjunto do que já estava limitado.
  */
  if (options.connectivity && options.connectivity.length > 0) {
    const aceitos = new Set(options.connectivity);
    markers = markers.filter((m) => aceitos.has(m.connectivityStatus));
  }
  if (options.withOpenServiceOrder !== undefined) {
    markers = markers.filter((m) =>
      options.withOpenServiceOrder
        ? m.openServiceOrderCount > 0
        : m.openServiceOrderCount === 0,
    );
  }

  return { markers, truncated, limit, missingLocationCount };
}

// ---------------------------------------------------------------------------
// Camada de OS abertas
// ---------------------------------------------------------------------------

/**
 * As OS abertas cujo cliente é localizável dentro do recorte.
 *
 * ## A coordenada da OS é a do CLIENTE, e isso foi verificado
 *
 * `ServiceOrder` **não tem coordenada própria** — nenhuma coluna de latitude,
 * longitude ou snapshot geográfico. O que ela tem é `customerId` obrigatório.
 * Então a única autoridade disponível é `CustomerLocation`, e é ela que
 * posiciona a OS.
 *
 * **Nada é aproximado.** Uma OS cujo cliente não tem coordenada não recebe
 * marcador: nem a posição da CTO, nem o centro do bairro, nem geocodificação do
 * endereço textual. Ela entra no contador de "sem localização", que é uma
 * afirmação verdadeira, em vez de virar um ponto no mapa que ninguém colocou lá.
 */
export async function getServiceOrderMapView(
  companyId: string,
  options: { bbox: BoundingBox; limit?: number },
): Promise<ServiceOrderMapView> {
  const limit = Math.min(
    Math.max(options.limit ?? SERVICE_ORDER_MAP_MAX_MARKERS, 1),
    SERVICE_ORDER_MAP_MAX_MARKERS,
  );
  const { north, south, east, west } = options.bbox;

  const ordens = await prisma.serviceOrder.findMany({
    where: {
      companyId,
      ...OS_ABERTA,
      customer: {
        location: {
          is: {
            latitude: { gte: south, lte: north },
            longitude: { gte: west, lte: east },
          },
        },
      },
    },
    select: {
      id: true,
      number: true,
      status: true,
      priority: true,
      createdAt: true,
      customerId: true,
      customer: {
        select: {
          name: true,
          location: { select: { latitude: true, longitude: true } },
        },
      },
      type: true,
      serviceOrderType: { select: { name: true } },
      technician: { select: { user: { select: { name: true } } } },
    },
    orderBy: [{ createdAt: "asc" }],
    take: limit + 1,
  });

  const missingLocationCount = await prisma.serviceOrder.count({
    where: { companyId, ...OS_ABERTA, customer: { location: { is: null } } },
  });

  const truncated = ordens.length > limit;
  const visiveis = truncated ? ordens.slice(0, limit) : ordens;

  if (visiveis.length === 0) {
    return { markers: [], truncated, limit, missingLocationCount };
  }

  const customerIds = Array.from(new Set(visiveis.map((o) => o.customerId)));
  const [conectividade, vinculos] = await Promise.all([
    getConnectivityForCustomers(companyId, customerIds),
    vinculoAtualPorCliente(companyId, customerIds),
  ]);

  const markers: ServiceOrderMapMarker[] = visiveis.map((ordem) => {
    const leitura = conectividade.get(ordem.customerId);
    const estado = leitura
      ? {
          status: leitura.connectivityStatus,
          observedAt: leitura.observedAt.toISOString(),
        }
      : semLeitura();
    return {
      id: ordem.id,
      number: ordem.number,
      status: ordem.status,
      priority: ordem.priority,
      typeName: ordem.serviceOrderType?.name ?? ordem.type ?? null,
      latitude: ordem.customer.location!.latitude.toNumber(),
      longitude: ordem.customer.location!.longitude.toNumber(),
      customerId: ordem.customerId,
      customerName: ordem.customer.name,
      connectivityStatus: estado.status,
      connectivityObservedAt: estado.observedAt,
      openedAt: ordem.createdAt.toISOString(),
      technicianName: ordem.technician?.user.name ?? null,
      cto: vinculos.get(ordem.customerId) ?? null,
    };
  });

  return { markers, truncated, limit, missingLocationCount };
}

// ---------------------------------------------------------------------------
// Resumo operacional por CTO
// ---------------------------------------------------------------------------

/**
 * Conectividade e OS abertas agregadas por caixa, em TRÊS consultas.
 *
 * Independe de quantas CTOs estão visíveis: cem caixas custam as mesmas três
 * consultas que uma. O caminho ingênuo — percorrer as caixas perguntando os
 * vínculos, depois cada vínculo perguntando a conectividade, depois cada cliente
 * perguntando as OS — daria trezentas consultas para desenhar a mesma tela.
 *
 * Nada disso é persistido: são valores derivados do vínculo ativo, do snapshot e
 * do predicado de OS aberta, calculados na leitura.
 */
export interface CtoOperationalReadout {
  summaries: Map<string, CtoOperationalSummary>;
  /**
   * As portas com vínculo ativo, para o resumo de OCUPAÇÃO.
   *
   * Sai daqui porque a consulta é a MESMA: "quais vínculos estão abertos nestas
   * caixas?" responde às duas perguntas. `getCtoMapView` fazia essa consulta por
   * conta própria, e manter as duas seria pedir ao banco duas vezes a mesma
   * coisa para derivar respostas diferentes dela.
   *
   * Note que este conjunto inclui vínculo de cliente INATIVO, e o
   * `activeCustomerCount` não — a porta ocupada por cliente desativado continua
   * ocupada. É a mesma linha respondendo duas perguntas diferentes, e é por isso
   * que os dois números podem divergir.
   */
  occupiedPortIds: Set<string>;
}

export async function getCtoOperationalSummaries(
  companyId: string,
  ctoIds: string[],
): Promise<CtoOperationalReadout> {
  const resumo = new Map<string, CtoOperationalSummary>();
  const occupiedPortIds = new Set<string>();
  if (ctoIds.length === 0) return { summaries: resumo, occupiedPortIds };

  for (const id of ctoIds) {
    resumo.set(id, {
      activeCustomerCount: 0,
      onlineCount: 0,
      offlineCount: 0,
      unknownCount: 0,
      openServiceOrderCount: 0,
    });
  }

  /*
    UMA consulta responde OCUPAÇÃO e RESUMO.

    `disconnectedAt: null` separa "está" de "esteve" — o histórico existe e não
    pode contar como presença. O filtro de cliente ativo **não** entra no
    `where`: a ocupação da porta independe da situação cadastral, e filtrar aqui
    faria a porta de um cliente desativado parecer livre. A distinção acontece na
    contagem, abaixo.
  */
  const vinculos = await prisma.customerNetworkConnection.findMany({
    where: {
      companyId,
      disconnectedAt: null,
      ctoPort: { ctoId: { in: ctoIds } },
    },
    select: {
      customerId: true,
      ctoPortId: true,
      ctoPort: { select: { ctoId: true } },
      customer: { select: { active: true } },
    },
  });

  for (const vinculo of vinculos) {
    occupiedPortIds.add(vinculo.ctoPortId);
  }

  // Só clientes cadastralmente ativos entram no resumo operacional.
  const ativos = vinculos.filter((v) => v.customer.active);
  if (ativos.length === 0) return { summaries: resumo, occupiedPortIds };

  const customerIds = Array.from(new Set(ativos.map((v) => v.customerId)));
  const [conectividade, osAbertas] = await Promise.all([
    getConnectivityForCustomers(companyId, customerIds),
    contarOsAbertasPorCliente(companyId, customerIds),
  ]);

  for (const vinculo of ativos) {
    const alvo = resumo.get(vinculo.ctoPort.ctoId);
    if (!alvo) continue;
    alvo.activeCustomerCount += 1;

    const leitura = conectividade.get(vinculo.customerId);
    const estado = leitura?.connectivityStatus ?? "UNKNOWN";
    if (estado === "ONLINE") alvo.onlineCount += 1;
    else if (estado === "OFFLINE") alvo.offlineCount += 1;
    else alvo.unknownCount += 1;

    alvo.openServiceOrderCount += osAbertas.get(vinculo.customerId) ?? 0;
  }

  return { summaries: resumo, occupiedPortIds };
}

// ---------------------------------------------------------------------------
// Clientes por porta — só no detalhe da caixa
// ---------------------------------------------------------------------------

/**
 * Quem está em cada porta desta CTO.
 *
 * ## Por que isto NÃO vem junto do recorte
 *
 * O recorte devolve **contagens**. Mandar a lista nominal de clientes de cada
 * caixa visível seria payload enorme, custo inútil e — o que pesa mais —
 * espalhar nome de assinante por uma resposta que existe para desenhar pontos.
 * O nome só viaja quando alguém pede aquela caixa.
 *
 * ## A relação é o VÍNCULO, e nada além
 *
 * Exclusivamente `CustomerNetworkConnection` ativa. Nunca proximidade, endereço
 * ou mesma rua: o mapa mostra o que foi registrado, e não o que parece provável.
 */
export async function getCtoPortCustomers(
  companyId: string,
  ctoId: string,
): Promise<CtoPortCustomer[]> {
  const vinculos = await prisma.customerNetworkConnection.findMany({
    where: {
      companyId,
      disconnectedAt: null,
      ctoPort: { ctoId },
    },
    select: {
      customerId: true,
      customer: { select: { name: true, active: true } },
      ctoPort: { select: { number: true } },
    },
  });

  if (vinculos.length === 0) return [];

  const customerIds = vinculos.map((v) => v.customerId);
  const [conectividade, osAbertas] = await Promise.all([
    getConnectivityForCustomers(companyId, customerIds),
    contarOsAbertasPorCliente(companyId, customerIds),
  ]);

  return vinculos
    .map((vinculo) => {
      const leitura = conectividade.get(vinculo.customerId);
      return {
        portNumber: vinculo.ctoPort.number,
        customerId: vinculo.customerId,
        customerName: vinculo.customer.name,
        customerActive: vinculo.customer.active,
        connectivityStatus: leitura?.connectivityStatus ?? "UNKNOWN",
        connectivityObservedAt: leitura?.observedAt.toISOString() ?? null,
        openServiceOrderCount: osAbertas.get(vinculo.customerId) ?? 0,
      };
    })
    .sort((a, b) => a.portNumber - b.portNumber);
}
