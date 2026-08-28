import { badRequest } from "./errors";
import { coordenadaValida } from "./map-links";

/**
 * Geometria mínima do AlfaOS.
 *
 * Duas responsabilidades, e nada além: validar uma coordenada que veio de fora
 * e medir a distância entre duas. Não há projeção, não há geometria de rota e
 * não há PostGIS — nada nesta versão precisa de mais do que isto, e uma
 * dependência geoespacial existiria hoje só para ser mantida.
 */

/** Raio médio da Terra, em metros (WGS-84). */
const EARTH_RADIUS_M = 6_371_008.8;

/**
 * Precisão declarada máxima que aceitamos gravar, em metros.
 *
 * 100 km não é uma precisão: é um aparelho relatando que não faz ideia de onde
 * está. O limite existe para que um valor absurdo não entre na coluna e depois
 * apareça num relatório como se fosse medição.
 */
export const MAX_ACCURACY_METERS = 100_000;

export interface Coordinate {
  latitude: number;
  longitude: number;
}

/**
 * Aceita a coordenada, ou recusa com 400.
 *
 * Reusa `coordenadaValida`, que já é a definição de "coordenada utilizável"
 * usada pelos links de navegação. Duplicar a regra aqui deixaria a tela e o
 * banco discordarem sobre o que é um ponto válido — e a divergência só
 * apareceria quando um técnico fosse mandado para o Atlântico.
 *
 * Cobre explicitamente o que a §60 manda atacar: `NaN`, infinito, latitude
 * acima de 90, longitude acima de 180 e o `(0, 0)` de campo nunca preenchido.
 */
export function assertValidCoordinate(
  latitude: unknown,
  longitude: unknown,
): Coordinate {
  const lat = typeof latitude === "number" ? latitude : Number.NaN;
  const lng = typeof longitude === "number" ? longitude : Number.NaN;
  if (!coordenadaValida(lat, lng)) {
    throw badRequest("Coordenada inválida.");
  }
  return { latitude: lat, longitude: lng };
}

/**
 * Aceita a precisão declarada, ou recusa.
 *
 * Precisão negativa é contradição em termos — e é um dos ataques que a §60
 * manda tentar. Ausente é legítimo: nem toda origem de coordenada informa
 * precisão.
 */
export function assertValidAccuracy(
  accuracyMeters: number | null | undefined,
): number | null {
  if (accuracyMeters === null || accuracyMeters === undefined) return null;
  if (
    !Number.isFinite(accuracyMeters) ||
    accuracyMeters < 0 ||
    accuracyMeters > MAX_ACCURACY_METERS
  ) {
    throw badRequest("Precisão de localização inválida.");
  }
  return Math.round(accuracyMeters);
}

/**
 * Distância em metros entre dois pontos, pela fórmula de haversine.
 *
 * Haversine trata a Terra como esfera e erra ~0,3% no pior caso. Para a
 * pergunta que o AlfaOS faz — "o técnico está perto do ponto cadastrado?" —
 * isso é irrelevante: o próprio GPS do celular erra dezenas de metros em área
 * urbana densa. Um elipsoide (Vincenty) daria precisão que o dado de entrada
 * não tem.
 *
 * Sempre calculada NO SERVIDOR. Distância enviada pelo aparelho seria o
 * aparelho avaliando a si mesmo (PRD §167).
 */
export function distanceInMeters(a: Coordinate, b: Coordinate): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

  return Math.round(2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h))));
}
