import type { LatLngTuple } from "leaflet";

/**
 * # A posição de um marcador é o MESMO array enquanto o par não muda — RC-1D
 *
 * O react-leaflet 4 decide se reposiciona um marcador comparando a prop
 * `position` **por referência** (`Marker.updateMarker`: `props.position !==
 * prevProps.position` → `marker.setLatLng`). Um array literal escrito no JSX é
 * novo a cada render, então TODO render reposicionava TODO marcador — com o par
 * que o React tinha, e não com o que o Leaflet estava mostrando.
 *
 * Isso era inofensivo para marcador parado e fatal para o marcador na mão:
 * uma releitura do recorte que chegasse durante o arrasto re-renderizava a
 * camada, o react-leaflet devolvia a caixa ao par gravado, e o `dragend` lia de
 * volta o ponto antigo. Era o MAPEDIT intermitente (`e2e/operational-map.spec.ts`,
 * `MAPEDIT-15`, reproduzido segurando a leitura no meio do gesto).
 *
 * Com a mesma referência para o mesmo par, só uma mudança REAL de posição chega
 * ao Leaflet — o rascunho novo no `dragend`, ou o ponto gravado ao cancelar.
 *
 * O cache é por marcador e cresce com as caixas que a sessão já viu — no
 * máximo as CTOs da empresa, dezenas a centenas de pares.
 */
export function stablePosition(
  cache: Map<string, LatLngTuple>,
  id: string,
  latitude: number,
  longitude: number,
): LatLngTuple {
  const guardada = cache.get(id);
  if (guardada && guardada[0] === latitude && guardada[1] === longitude) {
    return guardada;
  }
  const nova: LatLngTuple = [latitude, longitude];
  cache.set(id, nova);
  return nova;
}
