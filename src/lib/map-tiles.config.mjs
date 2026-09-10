/**
 * # Os provedores de tiles — uma autoridade, dois consumidores
 *
 * Este arquivo é `.mjs` por uma razão concreta, e não por gosto: ele precisa
 * ser lido por **dois** mundos que não compartilham compilador.
 *
 * ```text
 * next.config.mjs   monta a CSP  → precisa das ORIGENS em `img-src`
 * src/lib/map-config.ts  monta o componente → precisa das URLs e atribuições
 * ```
 *
 * `next.config.mjs` roda em Node puro, antes de qualquer transpilação, e não
 * consegue importar TypeScript. Se a configuração vivesse só no `.ts`, a CSP
 * teria de repetir os hosts — e a primeira troca de provedor deixaria o mapa
 * cinza, com a URL certa no `TileLayer` e o host velho na política. O sintoma
 * seria "os tiles não carregam" sem nenhum erro visível, porque violação de CSP
 * não quebra a página: ela apaga a imagem.
 *
 * **A configuração de tiles que não alimenta a CSP não é configurável.** Ela só
 * parece. Foi assim que a `CTO-3.2` descobriu que `img-src 'self' data:`
 * bloqueava todo tile externo, e é por isso que a `CTO-3.2.1`, ao acrescentar
 * satélite e híbrido, acrescenta as origens deles no MESMO lugar.
 *
 * ## O que é configuração e o que é entrada
 *
 * Tudo aqui vem de **variável de ambiente**, lida no servidor. Nada vem de
 * query string, corpo, cabeçalho ou preferência de usuário — uma URL de tile
 * escolhida por quem visita seria um pedido de saída de rede escolhido por
 * terceiro, feito pelo navegador de quem despacha. O usuário escolhe o MODO
 * (`NORMAL`/`SATELLITE`/`HYBRID`); ele nunca escolhe a URL.
 */

/** Os três modos da V1. `NORMAL` é o único que sempre existe. */
export const MAP_MODES = ["NORMAL", "SATELLITE", "HYBRID"];

/**
 * Base cartográfica padrão: OpenStreetMap.
 *
 * > **AVISO OPERACIONAL, e ele não é formalidade.** A política de uso dos tiles
 * > públicos do OpenStreetMap **não** é infraestrutura para produção: ela é
 * > mantida por doação, pede identificação de aplicação e proíbe uso pesado
 * > automatizado. Um AlfaOS com dezenas de despachantes arrastando o mapa o dia
 * > inteiro é exatamente o perfil que ela recusa.
 */
export const DEFAULT_NORMAL_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

export const DEFAULT_NORMAL_ATTRIBUTION =
  '&copy; colaboradores do <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer noopener">OpenStreetMap</a>';

/**
 * Imagem de satélite padrão: Esri World Imagery.
 *
 * Escolhido para **dev e QA** pelos mesmos critérios do OSM — sem chave, sem
 * faturamento, sem cadastro — e testado ao vivo antes de virar padrão: o tile
 * responde `200 image/jpeg` com imagem real.
 *
 * **Repare na ordem dos segmentos: `{z}/{y}/{x}`.** O Esri publica linha antes
 * de coluna, ao contrário do padrão `{z}/{x}/{y}` do OSM. Isso foi medido, não
 * suposto; escrever na ordem habitual devolve tiles de outro lugar do planeta,
 * que é o pior tipo de defeito — o mapa carrega, parece funcionar, e mostra a
 * cidade errada. O Leaflet aceita qualquer ordem de marcadores.
 *
 * > **O MESMO AVISO do OSM vale aqui, e com mais força.** Os termos do ArcGIS
 * > Online não são um contrato de produção para um SaaS comercial. Antes de
 * > produção: `MAP_TILE_SATELLITE_URL` para um provedor contratado (MapTiler,
 * > Stadia, Mapbox) ou imagem própria. Nada no código muda.
 */
export const DEFAULT_SATELLITE_URL =
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";

export const DEFAULT_SATELLITE_ATTRIBUTION =
  "Imagem &copy; Esri, Maxar, Earthstar Geographics";

/**
 * Rótulos do híbrido: a camada `dark_only_labels` da CARTO.
 *
 * É uma camada **só de rótulos**, com fundo transparente, feita para ir por
 * cima de outra. A variante `dark` é a de texto CLARO — a legível sobre imagem
 * de satélite, que é escura. A `light` tem texto escuro e sumiria sobre asfalto
 * e telhado.
 *
 * Também testada ao vivo: `200 image/png`, com conteúdo real numa área urbana
 * (1,8 KB sobre São Paulo) e tile praticamente vazio no oceano — que é o
 * comportamento correto de uma camada de rótulos.
 */
export const DEFAULT_HYBRID_LABELS_URL =
  "https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}.png";

export const DEFAULT_HYBRID_LABELS_ATTRIBUTION =
  'Rótulos &copy; <a href="https://carto.com/attributions" target="_blank" rel="noreferrer noopener">CARTO</a>';

export const DEFAULT_TILE_MAX_ZOOM = 19;

/**
 * A configuração efetiva, a partir do ambiente.
 *
 * ## `satellite` e `hybrid` podem ser `null`, e o mapa continua inteiro
 *
 * `MAP_SATELLITE_ENABLED=false` desliga os dois — a comparação é exata com
 * `"false"`, o mesmo padrão de `SGP_ACTIVATION_ENABLED`. Um operador que não
 * possa usar imagem aérea por licença desliga por configuração, e o que ele
 * perde é o botão; a base cartográfica não depende disso.
 *
 * O híbrido cai junto por consequência, e não por regra separada: ele **é** o
 * satélite com uma camada de rótulos por cima. Sem base, não há o que rotular.
 *
 * @param {Record<string, string | undefined>} [env]
 */
export function readMapTileConfig(env = process.env) {
  const normal = {
    urlTemplate: trimmedOr(env.MAP_TILE_URL, DEFAULT_NORMAL_URL),
    attribution: "",
    maxZoom: zoomOr(env.MAP_TILE_MAX_ZOOM),
  };
  normal.attribution = trimmedOr(
    env.MAP_TILE_ATTRIBUTION,
    normal.urlTemplate === DEFAULT_NORMAL_URL ? DEFAULT_NORMAL_ATTRIBUTION : "",
  );

  // Comparação exata com "false": qualquer outro valor mantém ligado. Uma
  // variável escrita errada não deve desligar silenciosamente uma camada.
  const satelliteHabilitado =
    (env.MAP_SATELLITE_ENABLED ?? "true").trim() !== "false";

  if (!satelliteHabilitado) {
    return { normal, satellite: null, hybrid: null };
  }

  const satellite = {
    urlTemplate: trimmedOr(env.MAP_TILE_SATELLITE_URL, DEFAULT_SATELLITE_URL),
    attribution: "",
    maxZoom: zoomOr(env.MAP_TILE_SATELLITE_MAX_ZOOM),
  };
  satellite.attribution = trimmedOr(
    env.MAP_TILE_SATELLITE_ATTRIBUTION,
    satellite.urlTemplate === DEFAULT_SATELLITE_URL
      ? DEFAULT_SATELLITE_ATTRIBUTION
      : "",
  );

  const labels = {
    urlTemplate: trimmedOr(
      env.MAP_TILE_HYBRID_LABELS_URL,
      DEFAULT_HYBRID_LABELS_URL,
    ),
    attribution: "",
    maxZoom: zoomOr(env.MAP_TILE_HYBRID_LABELS_MAX_ZOOM),
  };
  labels.attribution = trimmedOr(
    env.MAP_TILE_HYBRID_LABELS_ATTRIBUTION,
    labels.urlTemplate === DEFAULT_HYBRID_LABELS_URL
      ? DEFAULT_HYBRID_LABELS_ATTRIBUTION
      : "",
  );

  return { normal, satellite, hybrid: { base: satellite, labels } };
}

/**
 * Todas as origens que a CSP precisa liberar em `img-src`.
 *
 * **Uma lista derivada, e nunca um curinga.** `img-src *` resolveria o sintoma
 * e destruiria a política: qualquer host da internet passaria a poder entregar
 * imagem para dentro da aplicação. O que sai daqui são exatamente os hosts que
 * a configuração nomeia — três no padrão, e os que o operador apontar.
 *
 * @param {ReturnType<typeof readMapTileConfig>} config
 * @returns {string[]}
 */
export function tileImageSources(config) {
  const camadas = [config.normal, config.satellite, config.hybrid?.labels];
  const origens = [];
  for (const camada of camadas) {
    if (!camada) continue;
    const origem = tileImageSource(camada.urlTemplate);
    if (!origens.includes(origem)) origens.push(origem);
  }
  return origens;
}

/**
 * A origem que a CSP precisa liberar para UMA camada.
 *
 * ## Por que não basta guardar o host numa segunda variável
 *
 * Porque as duas divergiriam. Derivar a origem **da própria URL** faz a CSP ser
 * consequência da configuração em vez de uma cópia dela: trocar a URL move as
 * duas ao mesmo tempo, e não há um segundo lugar para esquecer.
 *
 * ## O `{s}` vira curinga, e só ele
 *
 * Vários provedores distribuem carga por subdomínio (`{s}.basemaps.cartocdn.com`
 * é o caso do híbrido padrão). A CSP não tem placeholder, então esse caso — e
 * **apenas** esse — produz `https://*.basemaps.cartocdn.com`. O curinga fica
 * preso ao domínio configurado; ele nunca vira `https:` solto.
 *
 * Esquema fora de `http`/`https` é **erro de configuração e falha alto**.
 *
 * @param {string} urlTemplate
 * @returns {string}
 */
export function tileImageSource(urlTemplate) {
  const curinga = urlTemplate.includes("{s}.");
  // `{` e `}` não são válidos em host; troca por um rótulo qualquer só para
  // que a URL possa ser analisada. O valor não sobrevive ao retorno.
  const sonda = urlTemplate.replace("{s}", "sonda");

  let url;
  try {
    url = new URL(sonda);
  } catch {
    throw new Error(
      "URL de tile inválida (precisa ser absoluta). Exemplo: " +
        DEFAULT_NORMAL_URL,
    );
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(
      `URL de tile precisa usar http ou https (recebido: ${url.protocol}).`,
    );
  }

  if (!curinga) return url.origin;

  const host = url.host.replace(/^sonda\./, "");
  return `${url.protocol}//*.${host}`;
}

function zoomOr(bruto) {
  const valor = Number(bruto);
  return Number.isInteger(valor) && valor >= 1 && valor <= 22
    ? valor
    : DEFAULT_TILE_MAX_ZOOM;
}

/**
 * O valor da variável quando ela existe e não está em branco; o padrão quando
 * não. Variável definida como string vazia é o jeito mais comum de "desligar"
 * uma configuração num `.env`, e tratá-la como valor produziria uma URL vazia.
 */
function trimmedOr(valor, padrao) {
  const limpo = typeof valor === "string" ? valor.trim() : "";
  return limpo === "" ? padrao : limpo;
}
