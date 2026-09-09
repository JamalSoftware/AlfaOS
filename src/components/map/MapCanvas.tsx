"use client";

import { useCallback, useEffect, type ReactNode } from "react";
import type { Map as LeafletMap } from "leaflet";
import { MapContainer, TileLayer, useMap, useMapEvents } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import type { BoundingBox } from "@/lib/cto-map";
import { boundingBoxFromLatLngBounds } from "@/lib/cto-map-presentation";
import type { MapInitialView, MapTileConfig } from "@/lib/map-config";

/**
 * # O canvas do Mapa Operacional — infraestrutura, sem domínio
 *
 * Este arquivo conhece Leaflet, tiles, viewport e zoom. Ele **não** conhece
 * CTO: não sabe o que é porta, capacidade, `summary` ou status derivado, e não
 * importa nada de `cto-map` além do formato do retângulo.
 *
 * A fronteira é o ponto da fase. O Mapa Operacional vai receber camadas de
 * técnico, cliente e ordem de serviço (§136, §207), e cada uma delas entra como
 * `children` — sem tocar aqui. Se o canvas soubesse o que é uma CTO, a segunda
 * camada começaria com uma refatoração.
 *
 * ## Por que ele nunca é renderizado no servidor
 *
 * O Leaflet mede o contêiner com `window` e `document` **no construtor**.
 * Importado num render de servidor, ele quebra o build com `window is not
 * defined`. Quem resolve isso é `OperationalMap`, com `dynamic(..., { ssr:
 * false })` — este arquivo simplesmente assume o navegador, e é por isso que
 * ele é o único do módulo que pode assumir.
 */

export interface MapCanvasHandle {
  /**
   * Leva o mapa até um ponto.
   *
   * `setView` e não `flyTo`: a animação do `flyTo` dispara `moveend` só no fim,
   * e uma segunda busca durante o voo cancelaria a primeira no meio. Um salto
   * instantâneo também é honesto — quem clicou num resultado quer chegar, não
   * assistir ao trajeto.
   */
  focusOn: (latitude: number, longitude: number, zoom?: number) => void;
}

export interface MapCanvasProps {
  tiles: MapTileConfig;
  initialView: MapInitialView;
  /** Chamado ao montar e a cada `moveend`/`zoomend`, com o recorte já válido. */
  onViewportChange: (bbox: BoundingBox) => void;
  /** Preenchido no mount; a camada usa para recentralizar. */
  onReady?: (handle: MapCanvasHandle) => void;
  children?: ReactNode;
}

/**
 * O zoom máximo do enquadramento inicial.
 *
 * Uma empresa com uma caixa só — ou com todas no mesmo poste — produz um
 * retângulo de área zero, e `fitBounds` sem teto vai ao zoom máximo. O mapa
 * abriria mostrando uma calçada, sem nenhuma referência de onde aquilo fica.
 */
const INITIAL_FIT_MAX_ZOOM = 16;

function ViewportReporter({
  onViewportChange,
}: {
  onViewportChange: (bbox: BoundingBox) => void;
}) {
  const emitir = useCallback(
    (map: LeafletMap) => {
      const limites = map.getBounds();
      onViewportChange(
        boundingBoxFromLatLngBounds({
          north: limites.getNorth(),
          south: limites.getSouth(),
          east: limites.getEast(),
          west: limites.getWest(),
        }),
      );
    },
    [onViewportChange],
  );

  /*
    `moveend` e `zoomend`, e NÃO `move`/`zoom`.

    O Leaflet emite `move` a cada quadro do arrasto — dezenas por segundo. É
    literalmente a "requisição por pixel" que o contrato proíbe. O `moveend`
    dispara uma vez, quando a mão solta.
  */
  const map = useMapEvents({
    moveend: () => emitir(map),
    zoomend: () => emitir(map),
  });

  // A primeira leitura: sem ela o mapa abriria vazio até alguém encostar nele.
  useEffect(() => {
    emitir(map);
  }, [map, emitir]);

  return null;
}

function CanvasHandle({ onReady }: { onReady?: (h: MapCanvasHandle) => void }) {
  const map = useMap();

  useEffect(() => {
    if (!onReady) return;
    onReady({
      focusOn: (latitude, longitude, zoom) => {
        map.setView([latitude, longitude], zoom ?? Math.max(map.getZoom(), 16));
      },
    });
  }, [map, onReady]);

  return null;
}

/**
 * Corrige a altura quando o contêiner nasce escondido ou muda de tamanho.
 *
 * O Leaflet mede uma vez, no mount. Um mapa montado dentro de um contêiner que
 * ainda não tem altura final — o que acontece com layout responsivo e com fonte
 * carregando — fica com os tiles em faixas cinzentas até alguém arrastar. O
 * `ResizeObserver` transforma isso em algo que o usuário nunca vê.
 */
function SizeWatcher() {
  const map = useMap();

  useEffect(() => {
    const alvo = map.getContainer();
    const observer = new ResizeObserver(() => {
      map.invalidateSize();
    });
    observer.observe(alvo);
    return () => observer.disconnect();
  }, [map]);

  return null;
}

export default function MapCanvas({
  tiles,
  initialView,
  onViewportChange,
  onReady,
  children,
}: MapCanvasProps) {
  const enquadramento =
    initialView.kind === "bounds"
      ? {
          bounds: [
            [initialView.bounds.south, initialView.bounds.west],
            [initialView.bounds.north, initialView.bounds.east],
          ] as [[number, number], [number, number]],
          boundsOptions: {
            maxZoom: INITIAL_FIT_MAX_ZOOM,
            padding: [32, 32] as [number, number],
          },
        }
      : {
          center: [
            initialView.point.latitude,
            initialView.point.longitude,
          ] as [number, number],
          zoom: initialView.point.zoom,
        };

  return (
    <MapContainer
      {...enquadramento}
      maxZoom={tiles.maxZoom}
      scrollWheelZoom
      className="h-full w-full"
      // O mapa é operado com o mouse e com o teclado: `Tab` até ele, setas para
      // mover, `+`/`-` para o zoom. É comportamento nativo do Leaflet, e
      // desligá-lo (como muitos fazem para "não roubar o scroll") tiraria a
      // única forma de operar o mapa sem apontador.
      keyboard
      data-testid="map-canvas"
    >
      <TileLayer
        url={tiles.urlTemplate}
        attribution={tiles.attribution}
        maxZoom={tiles.maxZoom}
      />
      <ViewportReporter onViewportChange={onViewportChange} />
      <CanvasHandle onReady={onReady} />
      <SizeWatcher />
      {children}
    </MapContainer>
  );
}
