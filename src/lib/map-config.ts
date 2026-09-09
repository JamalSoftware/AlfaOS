import {
  readMapTileConfig,
  tileImageSource,
} from "./map-tiles.config.mjs";
import type { BoundingBox } from "./cto-map";
import { prisma } from "./prisma";

/**
 * # A configuração do Mapa Operacional — resolvida no SERVIDOR
 *
 * O provedor de tiles e a posição inicial são decididos aqui e descem como
 * `props`. Nenhum componente lê ambiente, e é de propósito.
 *
 * ## Por que não `NEXT_PUBLIC_`
 *
 * Variável `NEXT_PUBLIC_` é **inlinada no bundle em tempo de build**. Trocar o
 * provedor de tiles passaria a exigir recompilar a aplicação — e a promessa da
 * `CTO-3.2` é trocar por configuração, não por release. Resolvida no servidor,
 * a troca é `.env` mais reinício.
 *
 * O efeito colateral bom: existe **um** ponto que lê a configuração, e um teste
 * consegue afirmar que nenhum componente contém URL de tile.
 */

export interface MapTileConfig {
  urlTemplate: string;
  attribution: string;
  maxZoom: number;
}

/**
 * O provedor de tiles em vigor.
 *
 * Chama `tileImageSource` de propósito, sem usar o resultado: é o mesmo cálculo
 * que a CSP faz em `next.config.mjs`, e uma URL que a política não conseguiria
 * liberar deve falhar **aqui**, ao montar a página, e não como um mapa cinza
 * sem explicação no navegador de quem despacha.
 */
export function getMapTileConfig(env: Record<string, string | undefined> = process.env): MapTileConfig {
  const config = readMapTileConfig(env);
  tileImageSource(config.urlTemplate);
  return config;
}

// ---------------------------------------------------------------------------
// Posição inicial
// ---------------------------------------------------------------------------

export interface MapPoint {
  latitude: number;
  longitude: number;
  zoom: number;
}

/**
 * Onde o mapa abre.
 *
 * Duas formas, e a distinção importa para quem olha: `bounds` significa *"isto
 * é a sua rede"*; `point` significa *"não sei onde você opera, aqui está o
 * país"*. Colapsar as duas num par de coordenadas faria a segunda parecer a
 * primeira — a mesma lição do `LocalOrderNote` da `DQ-6`, onde uma ordem
 * calculada tinha a cara de uma ordem informada.
 */
export type MapInitialView =
  | { kind: "bounds"; bounds: BoundingBox }
  | { kind: "point"; point: MapPoint };

/**
 * O último recurso, e ele é configurável.
 *
 * **Não é a coordenada de nenhuma empresa**, e não deve virar uma. É uma vista
 * de PAÍS — zoom 4 sobre o Brasil —, escolhida justamente por não parecer um
 * endereço: quem abre entende na hora que o mapa não sabe onde ele opera, em
 * vez de procurar a própria cidade num ponto plausível e errado.
 *
 * É o mesmo defeito que a `CTO-1.2` corrigiu, uma camada acima: lá um
 * placeholder de coordenada real era indistinguível de valor gravado.
 */
export const MAP_FALLBACK_POINT: MapPoint = {
  latitude: -14.235,
  longitude: -51.925,
  zoom: 4,
};

function numeroDoAmbiente(
  bruto: string | undefined,
  minimo: number,
  maximo: number,
): number | null {
  if (typeof bruto !== "string" || bruto.trim() === "") return null;
  const valor = Number(bruto);
  if (!Number.isFinite(valor) || valor < minimo || valor > maximo) return null;
  return valor;
}

export function getMapFallbackPoint(env: Record<string, string | undefined> = process.env): MapPoint {
  const latitude = numeroDoAmbiente(env.MAP_FALLBACK_LAT, -90, 90);
  const longitude = numeroDoAmbiente(env.MAP_FALLBACK_LNG, -180, 180);
  const zoom = numeroDoAmbiente(env.MAP_FALLBACK_ZOOM, 1, 22);

  // Meia configuração não vira posição: latitude sem longitude produziria um
  // ponto metade escolhido e metade padrão, que não é o que ninguém pediu.
  if (latitude === null || longitude === null) {
    return {
      ...MAP_FALLBACK_POINT,
      zoom: zoom ?? MAP_FALLBACK_POINT.zoom,
    };
  }
  return { latitude, longitude, zoom: zoom ?? 12 };
}

/**
 * A vista inicial da empresa: o retângulo que contém as caixas dela.
 *
 * ## Por que daqui, e não de GPS ou de uma constante
 *
 * Não existe localização de empresa no modelo (`Company` tem `timezone` e
 * capabilities, nada geográfico), e **pedir GPS só para abrir o mapa seria
 * cobrar uma permissão do navegador para responder a uma pergunta que o banco
 * já responde** — além de mostrar onde está quem despacha, e não onde está a
 * rede. O GPS do técnico é outra fatia (§339) e continua fora.
 *
 * ## Uma consulta, quatro agregados
 *
 * `min`/`max` de latitude e longitude, no banco. Não traz linha nenhuma, não
 * cresce com a carteira, e é o mesmo `companyId` de sessão de todo o módulo.
 *
 * O retângulo pode ser **degenerado** — uma caixa só, ou várias no mesmo poste.
 * Isso é tratado no cliente, que limita o zoom do enquadramento: sem limite,
 * `fitBounds` de área zero vai ao zoom máximo e o despachante abre o mapa
 * enxergando uma calçada.
 */
export async function getCtoMapInitialView(
  companyId: string,
  env: Record<string, string | undefined> = process.env,
): Promise<MapInitialView> {
  const extremos = await prisma.cTO.aggregate({
    where: {
      companyId,
      latitude: { not: null },
      longitude: { not: null },
    },
    _min: { latitude: true, longitude: true },
    _max: { latitude: true, longitude: true },
  });

  const { _min: minimo, _max: maximo } = extremos;
  if (
    minimo.latitude === null ||
    minimo.longitude === null ||
    maximo.latitude === null ||
    maximo.longitude === null
  ) {
    return { kind: "point", point: getMapFallbackPoint(env) };
  }

  return {
    kind: "bounds",
    bounds: {
      south: Number(minimo.latitude),
      north: Number(maximo.latitude),
      west: Number(minimo.longitude),
      east: Number(maximo.longitude),
    },
  };
}
