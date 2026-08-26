/**
 * Links de navegação para o técnico em campo.
 *
 * Duas fontes possíveis, com prioridade: coordenada quando ela existe e é
 * plausível, endereço textual como alternativa. Coordenada leva o técnico ao
 * ponto; endereço leva ao número da rua, que às vezes é o que existe.
 *
 * A coordenada NUNCA aparece como texto na tela — ela vai só dentro do `href`.
 * Latitude e longitude cruas não ajudam ninguém a chegar num lugar e ocupam a
 * linha onde deveria estar o endereço.
 */

/** Dados de localização que a OS carrega sobre o cliente. */
export interface LocalizacaoCliente {
  address?: string | null;
  number?: string | null;
  complement?: string | null;
  district?: string | null;
  city?: string | null;
  state?: string | null;
  zipCode?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}

export interface LinksDeNavegacao {
  googleMaps: string;
  waze: string;
  /** De onde saiu o destino. A tela usa para decidir o que dizer ao usuário. */
  origem: "coordenada" | "endereco";
}

/**
 * Coordenada utilizável.
 *
 * `(0, 0)` é rejeitado de propósito: fica no Atlântico, ao sul de Gana, e é o
 * que um cadastro devolve quando o campo nunca foi preenchido. Mandar um
 * técnico para lá é pior do que não oferecer navegação nenhuma.
 */
export function coordenadaValida(
  lat: number | null | undefined,
  lng: number | null | undefined,
): lat is number {
  if (lat == null || lng == null) return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return false;
  if (lat === 0 && lng === 0) return false;
  return true;
}

/**
 * Endereço legível, na ordem em que se lê um endereço em português.
 *
 * O complemento entra porque "fundos", "bloco B" e "portão azul" são
 * exatamente o que decide se o técnico encontra a casa. Campos vazios somem —
 * um endereço com vírgulas soltas parece defeito de tela.
 */
export function formatarEndereco(
  local: LocalizacaoCliente,
): string | null {
  const rua = [local.address, local.number].filter(Boolean).join(", ");
  const partes = [
    rua,
    local.complement,
    local.district,
    [local.city, local.state].filter(Boolean).join("/"),
    local.zipCode,
  ]
    .map((p) => (typeof p === "string" ? p.trim() : ""))
    .filter((p) => p.length > 0);

  return partes.length > 0 ? partes.join(" · ") : null;
}

/**
 * String de busca enviada aos aplicativos de mapa.
 *
 * Mais enxuta que a exibida: o complemento sai porque "portão azul" atrapalha
 * a geocodificação em vez de ajudar, e o CEP entra porque desempata rua
 * homônima.
 */
function consultaDeEndereco(local: LocalizacaoCliente): string | null {
  const partes = [
    [local.address, local.number].filter(Boolean).join(", "),
    local.district,
    local.city,
    local.state,
    local.zipCode,
  ]
    .map((p) => (typeof p === "string" ? p.trim() : ""))
    .filter((p) => p.length > 0);

  return partes.length > 0 ? partes.join(", ") : null;
}

/**
 * Monta os dois links, ou `null` quando não há destino nenhum.
 *
 * Tudo que vem do cadastro passa por `encodeURIComponent`. O endereço é texto
 * digitado por gente: um `&` num complemento acrescentaria um parâmetro à URL,
 * e um `#` cortaria o resto fora.
 */
export function linksDeNavegacao(
  local: LocalizacaoCliente,
): LinksDeNavegacao | null {
  const lat = local.latitude ?? null;
  const lng = local.longitude ?? null;

  if (coordenadaValida(lat, lng)) {
    // 6 casas ≈ 11 cm. Além disso é ruído de GPS apresentado como precisão.
    const ll = `${lat.toFixed(6)},${(lng as number).toFixed(6)}`;
    return {
      googleMaps: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(ll)}`,
      waze: `https://waze.com/ul?ll=${encodeURIComponent(ll)}&navigate=yes`,
      origem: "coordenada",
    };
  }

  const consulta = consultaDeEndereco(local);
  if (!consulta) return null;

  return {
    googleMaps: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(consulta)}`,
    waze: `https://waze.com/ul?q=${encodeURIComponent(consulta)}&navigate=yes`,
    origem: "endereco",
  };
}
