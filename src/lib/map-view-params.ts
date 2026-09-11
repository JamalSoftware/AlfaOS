import { CTO_MAP_SEARCH_MAX_QUERY } from "./cto-map-presentation";

/**
 * # O estado do Mapa Operacional que sobrevive à navegação
 *
 * O dono observou o defeito na validação da `CTO-3.2`: abrir uma CTO pelo mapa
 * e voltar devolvia o operador ao **Brasil inteiro**. Ele perdia o bairro, o
 * zoom, a busca digitada e a caixa selecionada — todo o contexto que levou dez
 * segundos e três arrastos para montar.
 *
 * A cura é a URL carregar o mínimo necessário para reconstruir a vista.
 *
 * ## Por que URL, e não só memória do componente
 *
 * Memória de componente morre na navegação, que é exatamente o momento em que
 * ela precisaria sobreviver. A URL atravessa `F5`, aba nova, link colado no
 * chat e o botão do navegador — e é o único lugar que o servidor consegue ler
 * ao renderizar a página de destino.
 *
 * ## O MÍNIMO, e nada além
 *
 * ```text
 * lat lng z    onde o mapa está
 * mode         NORMAL · SATELLITE · HYBRID
 * q            o que estava digitado na busca
 * sel          qual caixa estava selecionada
 * ```
 *
 * Marcador nenhum entra aqui, e nenhum DTO. A URL não é cache: ela é o endereço
 * de uma vista, e quem tem os dados é o servidor. Serializar duzentos
 * marcadores produziria uma URL quilométrica que envelheceria no primeiro
 * vínculo criado por outra pessoa.
 *
 * ## Tudo é ENTRADA DE USUÁRIO
 *
 * Cada valor destes pode ser digitado, colado ou montado por terceiro. O
 * parser aqui é a única porta: número fora da faixa não chega ao Leaflet (que
 * lançaria e derrubaria o mapa), modo desconhecido vira `null`, e o
 * identificador é conferido contra o formato de `cuid()` antes de virar rota.
 */

export const MAP_MODES = ["NORMAL", "SATELLITE", "HYBRID"] as const;

export type MapMode = (typeof MAP_MODES)[number];

export const DEFAULT_MAP_MODE: MapMode = "NORMAL";

/**
 * Chave da preferência de modo no navegador.
 *
 * A preferência é **do aparelho**, não do usuário no banco: é o tipo de escolha
 * que muda por contexto (o despachante quer satélite ao conferir um poste e
 * mapa normal ao ler nome de rua), e criar coluna e migration para ela seria
 * infraestrutura para um consumidor só — o mesmo critério que manteve o tema em
 * `localStorage`.
 */
export const MAP_MODE_STORAGE_KEY = "alfaos.map.mode";

/**
 * As camadas operacionais — `CTO-3.2.2`.
 *
 * **Não confundir com a base do mapa.** `NORMAL`/`SATELLITE`/`HYBRID` é o fundo
 * sobre o qual se desenha; isto é o que se desenha em cima. São dois controles
 * diferentes, e a tela precisa deixar isso claro — misturá-los faria "Satélite"
 * e "Clientes" parecerem alternativas entre si.
 */
export const MAP_LAYERS = ["CTOS", "ORDERS", "CUSTOMERS"] as const;
export type MapLayer = (typeof MAP_LAYERS)[number];

/**
 * O estado PADRÃO das camadas, e a razão de clientes nascer desligada.
 *
 * Caixas e OS abertas são o trabalho do despacho, e são poucas o bastante para
 * caber na tela. Clientes é a camada de milhares de pontos: ligada por padrão,
 * ela cobriria a rede de bolinhas antes de alguém pedir, e o mapa abriria
 * poluído em vez de informativo.
 *
 * Ela continua a um clique de distância — e quem a liga sabe o que está pedindo.
 */
export const DEFAULT_MAP_LAYERS: Record<MapLayer, boolean> = {
  CTOS: true,
  ORDERS: true,
  CUSTOMERS: false,
};

/** Os filtros da camada de clientes. Simples de propósito. */
export const CUSTOMER_FILTERS = [
  "ALL",
  "ONLINE",
  "OFFLINE",
  "UNKNOWN",
  "WITH_OPEN_OS",
  "WITHOUT_OPEN_OS",
] as const;
export type CustomerFilter = (typeof CUSTOMER_FILTERS)[number];
export const DEFAULT_CUSTOMER_FILTER: CustomerFilter = "ALL";

export interface MapViewState {
  latitude: number;
  longitude: number;
  zoom: number;
  mode: MapMode;
  search: string;
  selectedId: string | null;
  layers: Record<MapLayer, boolean>;
  customerFilter: CustomerFilter;
}

/**
 * Formato de `cuid()`, o mesmo de `return-to.ts`.
 *
 * Restringir o formato **não é** o controle de acesso — é a primeira peneira.
 * O `sel` só destaca um marcador que a leitura do recorte já devolveu, e essa
 * leitura continua filtrando por `companyId` da sessão. Um id de outra empresa
 * que passe por aqui não encontra marcador nenhum, e o destaque simplesmente
 * não acontece.
 */
const ID_INTERNO = /^c[a-z0-9]{20,32}$/;

export function parseMapMode(raw: unknown): MapMode | null {
  if (typeof raw !== "string") return null;
  const valor = raw.trim().toUpperCase();
  return (MAP_MODES as readonly string[]).includes(valor)
    ? (valor as MapMode)
    : null;
}

function numeroNaFaixa(
  raw: unknown,
  minimo: number,
  maximo: number,
): number | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const valor = Number(raw);
  /*
    `Number.isFinite` e não `!isNaN`: `"Infinity"` atravessa a segunda inteiro,
    e um `Infinity` chegando ao `setView` do Leaflet não é um mapa em lugar
    errado — é uma exceção que derruba o componente. Mesma lição da `CTO-1.1`.
  */
  if (!Number.isFinite(valor) || valor < minimo || valor > maximo) return null;
  return valor;
}

type Bruto = string | string[] | undefined;

const primeiro = (raw: Bruto): string | undefined =>
  Array.isArray(raw) ? raw[0] : raw;

/**
 * Lê a vista da query string, campo a campo.
 *
 * Devolve **parcial** de propósito: cada campo é independente, e um `zoom`
 * inválido não pode descartar uma `lat`/`lng` boa. Quem chama completa o que
 * faltar com o padrão dele — o enquadramento da empresa, no caso da página.
 *
 * `lat` e `lng` só valem **juntas**: meia coordenada não posiciona nada, e é a
 * mesma regra que a `CTO-3.1` aplica à caixa sem localização.
 */
export function parseMapViewParams(
  raw: Record<string, Bruto> | undefined,
): Partial<MapViewState> {
  if (!raw) return {};

  const parcial: Partial<MapViewState> = {};

  const latitude = numeroNaFaixa(primeiro(raw.lat), -90, 90);
  const longitude = numeroNaFaixa(primeiro(raw.lng), -180, 180);
  if (latitude !== null && longitude !== null) {
    parcial.latitude = latitude;
    parcial.longitude = longitude;
  }

  const zoom = numeroNaFaixa(primeiro(raw.z), 1, 22);
  if (zoom !== null) parcial.zoom = zoom;

  const mode = parseMapMode(primeiro(raw.mode));
  if (mode) parcial.mode = mode;

  const busca = primeiro(raw.q);
  if (typeof busca === "string") {
    const limpo = busca.trim();
    // O mesmo teto do domínio da busca: a URL não é um caminho alternativo
    // para um termo que a rota recusaria.
    if (limpo !== "" && limpo.length <= CTO_MAP_SEARCH_MAX_QUERY) {
      parcial.search = limpo;
    }
  }

  const selecionado = primeiro(raw.sel);
  if (typeof selecionado === "string" && ID_INTERNO.test(selecionado)) {
    parcial.selectedId = selecionado;
  }

  /*
    As camadas viajam como uma lista de LIGADAS, e não como três booleanos.

    `?layers=CTOS,ORDERS` é curto e diz tudo; `?ctos=1&orders=1&customers=0`
    ocuparia três parâmetros para a mesma informação. E o parser é uma
    allowlist: o que não está em `MAP_LAYERS` é descartado, então um valor
    inventado na URL não liga camada nenhuma.

    Ausência do parâmetro significa PADRÃO, e não "tudo desligado" — quem chega
    por um link sem `layers` recebe o mapa como ele abre normalmente.
  */
  const camadas = primeiro(raw.layers);
  if (typeof camadas === "string") {
    const pedidas = new Set(
      camadas
        .split(",")
        .map((c) => c.trim().toUpperCase())
        .filter((c): c is MapLayer =>
          (MAP_LAYERS as readonly string[]).includes(c),
        ),
    );
    // Uma lista vazia é uma escolha válida: o operador desligou tudo.
    parcial.layers = {
      CTOS: pedidas.has("CTOS"),
      ORDERS: pedidas.has("ORDERS"),
      CUSTOMERS: pedidas.has("CUSTOMERS"),
    };
  }

  const filtro = primeiro(raw.cf);
  if (
    typeof filtro === "string" &&
    (CUSTOMER_FILTERS as readonly string[]).includes(filtro.toUpperCase())
  ) {
    parcial.customerFilter = filtro.toUpperCase() as CustomerFilter;
  }

  return parcial;
}

/**
 * Monta a query da vista.
 *
 * As duas pontas usam esta função e o parser acima, então o que é escrito é
 * exatamente o que consegue ser lido de volta — sem uma delas montar à mão uma
 * string que a outra recusa.
 *
 * Campo vazio é **omitido**, e não escrito em branco: `?q=&sel=` polui a barra
 * de endereço sem dizer nada, e faz duas vistas iguais terem URLs diferentes.
 */
export function buildMapViewQuery(estado: Partial<MapViewState>): string {
  const params = new URLSearchParams();

  if (
    typeof estado.latitude === "number" &&
    typeof estado.longitude === "number" &&
    Number.isFinite(estado.latitude) &&
    Number.isFinite(estado.longitude)
  ) {
    // Seis casas ≈ 11 cm. Mais que isso é ruído numa URL que descreve a vista
    // de um mapa, não a posição de uma caixa.
    params.set("lat", estado.latitude.toFixed(6));
    params.set("lng", estado.longitude.toFixed(6));
  }

  if (typeof estado.zoom === "number" && Number.isFinite(estado.zoom)) {
    params.set("z", String(Math.round(estado.zoom)));
  }

  if (estado.mode) params.set("mode", estado.mode);

  const busca = estado.search?.trim();
  if (busca) params.set("q", busca.slice(0, CTO_MAP_SEARCH_MAX_QUERY));

  if (estado.selectedId && ID_INTERNO.test(estado.selectedId)) {
    params.set("sel", estado.selectedId);
  }

  /*
    A camada só é escrita quando DIFERE do padrão.

    Escrever sempre encheria a barra de endereço de `?layers=CTOS,ORDERS` para
    quem não mexeu em nada — e faria a vista padrão ter uma URL diferente da
    vista padrão de ontem, se o padrão mudasse. Omitir significa "como abre".

    Note que "nenhuma camada ligada" TAMBÉM difere do padrão, e por isso é
    escrito: `?layers=` é uma escolha, e ela precisa sobreviver à navegação.
  */
  if (estado.layers) {
    const ligadas = MAP_LAYERS.filter((camada) => estado.layers![camada]);
    const ehPadrao = MAP_LAYERS.every(
      (camada) => estado.layers![camada] === DEFAULT_MAP_LAYERS[camada],
    );
    if (!ehPadrao) params.set("layers", ligadas.join(","));
  }

  if (estado.customerFilter && estado.customerFilter !== DEFAULT_CUSTOMER_FILTER) {
    params.set("cf", estado.customerFilter);
  }

  return params.toString();
}
