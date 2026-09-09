import type { BoundingBox, CtoMapStatus } from "./cto-map";

/**
 * # A tradução do estado da caixa para a tela — e só isso
 *
 * Este módulo é **apresentação**. Ele não decide `status`: quem decide é
 * `deriveCtoMapStatus`, no servidor, com as portas na mão. Aqui só existe a
 * pergunta *"como o `DAMAGED` que o servidor mandou aparece?"*.
 *
 * A separação não é estética. Se o cliente recalculasse status a partir do
 * `summary`, existiriam duas precedências — e a que divergiria seria a que
 * ninguém revisou, porque a tela é onde a regra parece óbvia. É a mesma razão
 * pela qual `OCCUPIED` nunca virou coluna e `summarizePortCounts` é uma função
 * só.
 *
 * ## Cor NÃO é o sinal
 *
 * Cada estado carrega **forma**, **glifo** e **rótulo em texto**, além do tom.
 * Um marcador que só mudasse de cor deixaria de fora quem tem daltonismo — e,
 * mais prosaicamente, quem imprime o mapa ou olha a tela sob sol. A cor é a
 * quarta pista, nunca a primeira.
 */

export type MapStatusShape = "circle" | "square" | "triangle" | "diamond";
export type MapStatusTone = "success" | "warning" | "danger" | "neutral";

export interface CtoMapStatusPresentation {
  status: CtoMapStatus;
  /** O rótulo curto, para o selo do popup e para o `aria-label` do marcador. */
  label: string;
  /** A frase que explica o que fazer com a informação. */
  description: string;
  shape: MapStatusShape;
  /** Um caractere dentro do marcador. Legível sem cor e sem forma. */
  glyph: string;
  tone: MapStatusTone;
}

/**
 * A tabela, e a ordem das entradas segue a precedência aprovada para deixar
 * visível o que está sendo traduzido:
 *
 * ```text
 * INACTIVE > DAMAGED > FULL > AVAILABLE
 * ```
 */
export const CTO_MAP_STATUS_PRESENTATION: Record<
  CtoMapStatus,
  CtoMapStatusPresentation
> = {
  INACTIVE: {
    status: "INACTIVE",
    label: "Inativa",
    description: "A caixa está fora de operação.",
    shape: "diamond",
    glyph: "×",
    tone: "neutral",
  },
  DAMAGED: {
    status: "DAMAGED",
    label: "Com defeito",
    description: "Há posição danificada. Alguém precisa ir até a caixa.",
    shape: "triangle",
    glyph: "!",
    tone: "danger",
  },
  FULL: {
    status: "FULL",
    label: "Sem vaga",
    description: "Todas as posições estão em uso. Não cabe instalação nova.",
    shape: "square",
    glyph: "0",
    tone: "warning",
  },
  AVAILABLE: {
    status: "AVAILABLE",
    label: "Com vaga",
    description: "Há posição livre para um cliente novo.",
    shape: "circle",
    glyph: "+",
    tone: "success",
  },
};

export function ctoMapStatusPresentation(
  status: CtoMapStatus,
): CtoMapStatusPresentation {
  return CTO_MAP_STATUS_PRESENTATION[status];
}

// ---------------------------------------------------------------------------
// O recorte que o Leaflet entrega
// ---------------------------------------------------------------------------

function clamp(valor: number, minimo: number, maximo: number): number {
  return Math.min(Math.max(valor, minimo), maximo);
}

/**
 * Traz a longitude para `[-180, 180]`, que é o que o servidor aceita.
 *
 * **Valor já dentro da faixa sai INTACTO**, e a guarda não é cosmética: a conta
 * de módulo não é exata em ponto flutuante, e `-41.8` volta dela como
 * `-41.799999999999997`. O recorte continuaria válido, mas mudaria a cada
 * leitura — o que polui a query, quebra qualquer comparação de recorte e faz um
 * teste de identidade falhar por um motivo que não tem nada a ver com mapa.
 */
function wrapLongitude(valor: number): number {
  if (valor >= -180 && valor <= 180) return valor;
  const voltas = (((valor + 180) % 360) + 360) % 360;
  return voltas - 180;
}

/**
 * O retângulo do Leaflet, traduzido para o que a API aceita.
 *
 * ## Por que existe tradução, em vez de mandar direto
 *
 * O Leaflet não limita o retângulo ao planeta. Com zoom baixo ele devolve
 * longitudes fora de `[-180, 180]` (o mapa repete horizontalmente) e latitudes
 * fora de `[-90, 90]` (a projeção sobra em cima e embaixo). A API recusa os
 * dois com `400` — corretamente —, e o efeito na tela seria um mapa que
 * simplesmente para de carregar quando alguém afasta demais.
 *
 * ## A volta ao mundo vira o mundo
 *
 * Duas situações levam ao mesmo lugar. Se a vista abrange mais de 360°, ela
 * **é** o mundo. Se ela cruza o antimeridiano, o domínio recusa por decisão da
 * `CTO-3.1` — tratar a faixa partida custaria consulta em duas partes para um
 * caso que uma rede de distribuição local nunca produz.
 *
 * Nos dois, o cliente pede `[-180, 180]`. **Isso não afrouxa a regra do
 * domínio**: ele continua recusando um recorte partido, e continua havendo teto
 * de 200. O que muda é que a tela nunca constrói um pedido que ela mesma sabe
 * que seria recusado — quem está com o mapa no zoom do planeta quer ver o que
 * existe, não uma mensagem de erro sobre a linha de data.
 */
export function boundingBoxFromLatLngBounds(bruto: {
  north: number;
  south: number;
  east: number;
  west: number;
}): BoundingBox {
  const north = clamp(bruto.north, -90, 90);
  const south = clamp(bruto.south, -90, 90);

  if (bruto.east - bruto.west >= 360) {
    return { north, south, west: -180, east: 180 };
  }

  const west = wrapLongitude(bruto.west);
  const east = wrapLongitude(bruto.east);
  if (west > east) {
    return { north, south, west: -180, east: 180 };
  }

  return { north, south, west, east };
}

export function boundingBoxToQuery(bbox: BoundingBox): string {
  const params = new URLSearchParams({
    north: String(bbox.north),
    south: String(bbox.south),
    east: String(bbox.east),
    west: String(bbox.west),
  });
  return params.toString();
}

// ---------------------------------------------------------------------------
// Resposta atrasada não substitui resposta nova
// ---------------------------------------------------------------------------

/**
 * Quantos milissegundos de quietude antes de consultar o recorte.
 *
 * O `moveend` do Leaflet já dispara uma vez por arrasto, e não por pixel. O
 * atraso existe para a outra coisa: uma sequência de zoom, ou um arrasto
 * seguido de outro, produz vários `moveend` em menos de meio segundo. Sem ele,
 * ajustar o enquadramento renderia três consultas das quais só a última
 * interessa.
 */
export const CTO_MAP_VIEWPORT_DEBOUNCE_MS = 350;

export interface LatestRequestGuard {
  /** Abre um pedido e devolve o bilhete dele. */
  begin: () => number;
  /** Este bilhete ainda é o mais recente? */
  isCurrent: (bilhete: number) => boolean;
}

/**
 * O guarda de "resposta atrasada não substitui resposta nova".
 *
 * ## O modo de falha que ele fecha
 *
 * Arrastar o mapa do bairro A para o bairro B dispara duas leituras. Se a de A
 * demorar mais que a de B — e isso é normal quando A tem 200 caixas e B tem
 * três —, ela chega **depois** e sobrescreve o resultado certo. O despachante
 * fica olhando o bairro B com os marcadores do bairro A, sem nenhum sinal de
 * que algo está errado: o mapa está no lugar certo, os marcadores são reais, e
 * a associação entre os dois é que está trocada.
 *
 * ## O que ele é, MEDIDO — e não o que parecia ser
 *
 * A primeira redação daqui dizia que o bilhete decide e o `AbortController` não
 * basta. A sabotagem `S2` da `CTO-3.2` mediu o contrário no navegador:
 * desativando esta guarda, o spec do mapa **continua verde**, porque o aborto
 * rejeita a leitura anterior antes de ela chegar ao `.then`.
 *
 * Então, honestamente: no navegador o aborto é o mecanismo principal, e o
 * bilhete é **defesa em profundidade**. Ele continua valendo a pena por cobrir
 * o que o aborto não cobre — um chamador que esqueça o `signal`, uma
 * refatoração que troque o transporte, e qualquer caminho em que a decisão de
 * escrever no estado aconteça longe da promessa que foi cancelada. Quem o
 * detecta são os testes de unidade, e é assim que está registrado.
 *
 * É deliberadamente um contador, e não um comparativo de `bbox`: dois recortes
 * podem ser iguais e ainda assim a resposta velha estar errada, se um filtro
 * tiver mudado no meio.
 */
export function createLatestRequestGuard(): LatestRequestGuard {
  let atual = 0;
  return {
    begin: () => ++atual,
    isCurrent: (bilhete: number) => bilhete === atual,
  };
}

// ---------------------------------------------------------------------------
// Os limites do termo de busca
// ---------------------------------------------------------------------------

/**
 * # Por que estas constantes moram aqui, e não em `cto-map.ts`
 *
 * `cto-map.ts` importa `prisma`. A tela precisa saber a partir de quantos
 * caracteres vale consultar — e importar a constante de lá arrastaria o cliente
 * do Prisma para o bundle do navegador.
 *
 * **Isso não é hipótese.** Na `DQ-4` um componente importou rótulos de
 * `service-orders.ts`, esse módulo alcançava `node:crypto`, e o webpack derrubou
 * a página de **login** inteira. O conserto foi exatamente este: os valores que
 * o cliente precisa mudam para um módulo que não alcança o servidor, e o módulo
 * do servidor passa a consumi-los.
 *
 * Continua havendo **uma** regra: `normalizeMapSearchQuery`, no domínio, decide
 * usando estas mesmas constantes. A tela não repete a regra — ela reusa.
 */

/** Teto de tamanho do termo. Acima disso é engano ou abuso, e recusa. */
export const CTO_MAP_SEARCH_MAX_QUERY = 60;

/**
 * Mínimo de caracteres **úteis** para consultar o banco.
 *
 * "Útil" exclui `%` e `_`, e a distinção não é preciosismo: os dois são
 * curingas de `LIKE`, e o `contains` do Prisma os repassa sem escapar. Sem esta
 * contagem, um termo de dois caracteres `%%` satisfaria o mínimo e casaria com
 * **tudo** — o mínimo existiria no código e não na prática, e a busca viraria a
 * listagem da carteira que o teto do mapa existe para impedir.
 */
export const CTO_MAP_SEARCH_MIN_QUERY = 2;

/** Quantos caracteres do termo não são curinga de `LIKE`. */
export function usefulSearchLength(termo: string): number {
  return termo.replace(/[%_]/g, "").length;
}
