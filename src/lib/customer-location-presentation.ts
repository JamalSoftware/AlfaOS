import type { CustomerLocationSource } from "@prisma/client";

/**
 * # Localização do cliente — como a tela e as mensagens a DIZEM (RC-1C)
 *
 * Só apresentação: nenhuma consulta, nenhum `import` de valor do Prisma. Pode
 * ser usada pelo domínio (a mensagem de recusa da confirmação), pela timeline
 * e pelo cartão administrativo — e por isso a distância é escrita num lugar só.
 * Duas funções de formatação produziriam "2,36 km" numa tela e "2357 m" na
 * mensagem que explica a recusa.
 */

/**
 * A distância como uma pessoa lê.
 *
 * Abaixo de 1 km, metros inteiros ("82 m"); a partir dele, quilômetros com duas
 * casas e vírgula ("2,36 km"). A entrada já é o metro inteiro que o servidor
 * calculou (`distanceInMeters` arredonda) — é o mesmo número que decide o
 * limite, então a tela e a regra nunca discordam.
 */
export function formatDistanceMeters(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} m`;
  const km = (meters / 1000).toFixed(2).replace(".", ",");
  return `${km} km`;
}

/** De onde a coordenada veio — o eixo `source`, que não é o `verified`. */
export const LOCATION_SOURCE_LABELS: Record<CustomerLocationSource, string> = {
  TECHNICIAN_GPS: "Técnico em campo (GPS do aparelho)",
  IMPORTED: "Importação do ERP",
  GEOCODED: "Geocodificação do endereço",
  MANUAL: "Digitada manualmente",
};

/**
 * Latitude ou longitude com as sete casas que a coluna guarda.
 *
 * Sete, e não "o que o `Number` imprimir": `-20.3` e `-20.3000000` são o mesmo
 * ponto, e a tela precisa mostrar o valor com a precisão em que ele existe — a
 * coluna é `Decimal(10, 7)`.
 */
export function formatCoordinate(value: number): string {
  return value.toFixed(7);
}
