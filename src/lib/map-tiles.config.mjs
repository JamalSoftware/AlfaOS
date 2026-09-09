/**
 * # O provedor de tiles — uma autoridade, dois consumidores
 *
 * Este arquivo é `.mjs` por uma razão concreta, e não por gosto: ele precisa
 * ser lido por **dois** mundos que não compartilham compilador.
 *
 * ```text
 * next.config.mjs   monta a CSP  → precisa da ORIGEM do provedor em `img-src`
 * src/lib/map-config.ts  monta o componente → precisa da URL e da atribuição
 * ```
 *
 * `next.config.mjs` roda em Node puro, antes de qualquer transpilação, e não
 * consegue importar TypeScript. Se a configuração vivesse só no `.ts`, a CSP
 * teria de repetir o host — e a primeira troca de provedor deixaria o mapa
 * cinza, com a URL certa no `TileLayer` e o host velho na política. O sintoma
 * seria "os tiles não carregam" sem nenhum erro visível, porque violação de CSP
 * não quebra a página: ela apaga a imagem.
 *
 * **A configuração de tiles que não alimenta a CSP não é configurável.** Ela só
 * parece.
 *
 * ## O que é configuração e o que é entrada
 *
 * Tudo aqui vem de **variável de ambiente**, lida no servidor. Nada vem de
 * query string, corpo, cabeçalho ou preferência de usuário — uma URL de tile
 * escolhida por quem visita seria um pedido de saída de rede escolhido por
 * terceiro, feito pelo navegador de quem despacha.
 */

/**
 * O padrão de desenvolvimento: OpenStreetMap.
 *
 * Sem chave, sem faturamento, licença permissiva — é o que permite abrir o mapa
 * numa máquina nova sem contratar nada.
 *
 * > **AVISO OPERACIONAL, e ele não é formalidade.** A política de uso dos tiles
 * > públicos do OpenStreetMap **não** é infraestrutura para produção: ela é
 * > mantida por doação, pede identificação de aplicação e proíbe uso pesado
 * > automatizado. Um AlfaOS com dezenas de despachantes arrastando o mapa o dia
 * > inteiro é exatamente o perfil que ela recusa.
 * >
 * > Antes de produção: contratar um provedor (MapTiler, Stadia, Mapbox) ou
 * > servir tiles próprios, e apontar `MAP_TILE_URL` para lá. Nada no código
 * > muda — é essa a razão de este arquivo existir.
 */
export const DEFAULT_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

/**
 * Atribuição do padrão.
 *
 * Não é enfeite: a licença ODbL do OpenStreetMap **exige** o crédito visível.
 * Trocar o provedor sem trocar isto atribuiria o mapa de um a outro, e é por
 * isso que a atribuição viaja junto da URL em vez de estar escrita na tela.
 */
export const DEFAULT_TILE_ATTRIBUTION =
  '&copy; colaboradores do <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer noopener">OpenStreetMap</a>';

/** Zoom máximo do padrão. O OSM publica até 19. */
export const DEFAULT_TILE_MAX_ZOOM = 19;

/**
 * A configuração efetiva, a partir do ambiente.
 *
 * Recebe `env` por parâmetro para ser testável sem mexer em `process.env` do
 * processo — o mesmo padrão que `src/lib/env.ts` usa.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ urlTemplate: string, attribution: string, maxZoom: number }}
 */
export function readMapTileConfig(env = process.env) {
  const urlTemplate = trimmedOr(env.MAP_TILE_URL, DEFAULT_TILE_URL);
  const attribution = trimmedOr(
    env.MAP_TILE_ATTRIBUTION,
    urlTemplate === DEFAULT_TILE_URL ? DEFAULT_TILE_ATTRIBUTION : "",
  );

  const zoomBruto = Number(env.MAP_TILE_MAX_ZOOM);
  const maxZoom =
    Number.isInteger(zoomBruto) && zoomBruto >= 1 && zoomBruto <= 22
      ? zoomBruto
      : DEFAULT_TILE_MAX_ZOOM;

  return { urlTemplate, attribution, maxZoom };
}

/**
 * A origem que a CSP precisa liberar em `img-src` para este provedor.
 *
 * ## Por que não basta guardar o host numa segunda variável
 *
 * Porque as duas divergiriam. Derivar a origem **da própria URL** faz a CSP ser
 * consequência da configuração em vez de uma cópia dela: trocar `MAP_TILE_URL`
 * move as duas ao mesmo tempo, e não há um segundo lugar para esquecer.
 *
 * ## O `{s}` vira curinga, e só ele
 *
 * Vários provedores distribuem carga por subdomínio (`{s}.tile.exemplo.com`).
 * A CSP não tem placeholder, então esse caso — e **apenas** esse — produz
 * `https://*.tile.exemplo.com`. O curinga fica preso ao domínio configurado;
 * ele nunca vira `https:` solto, que liberaria imagem de qualquer lugar da
 * internet e transformaria a CSP em decoração.
 *
 * Esquema fora de `http`/`https` é **erro de configuração e falha alto**. Um
 * `javascript:` ou `data:` aqui não é ataque plausível (isto é ambiente do
 * servidor, não entrada de usuário), mas é o tipo de engano que produziria uma
 * CSP silenciosamente inútil.
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
      "MAP_TILE_URL não é uma URL absoluta válida. Exemplo: " +
        DEFAULT_TILE_URL,
    );
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(
      `MAP_TILE_URL precisa usar http ou https (recebido: ${url.protocol}).`,
    );
  }

  if (!curinga) return url.origin;

  const host = url.host.replace(/^sonda\./, "");
  return `${url.protocol}//*.${host}`;
}

/**
 * O valor da variável quando ela existe e não está em branco; o padrão quando
 * não. Variável definida como string vazia é o jeito mais comum de "desligar"
 * uma configuração num `.env`, e tratá-la como valor produziria uma URL vazia.
 *
 * @param {string | undefined} valor
 * @param {string} padrao
 * @returns {string}
 */
function trimmedOr(valor, padrao) {
  const limpo = typeof valor === "string" ? valor.trim() : "";
  return limpo === "" ? padrao : limpo;
}
