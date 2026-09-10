"use client";

import { useCallback, useEffect, type ReactNode } from "react";
import type { Map as LeafletMap } from "leaflet";
import { MapContainer, TileLayer, useMap, useMapEvents } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import type { BoundingBox } from "@/lib/cto-map";
import { boundingBoxFromLatLngBounds } from "@/lib/cto-map-presentation";
import type { MapInitialView, MapTilesConfig } from "@/lib/map-config";
import type { MapMode } from "@/lib/map-view-params";

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

/** Onde a câmera está: o que a URL precisa para reconstruir a vista. */
export interface MapCamera {
  latitude: number;
  longitude: number;
  zoom: number;
}

export interface MapCanvasProps {
  tiles: MapTilesConfig;
  mode: MapMode;
  initialView: MapInitialView;
  /** Chamado ao montar e a cada `moveend`/`zoomend`, com recorte e câmera. */
  onViewportChange: (bbox: BoundingBox, camera: MapCamera) => void;
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
  onViewportChange: (bbox: BoundingBox, camera: MapCamera) => void;
}) {
  const emitir = useCallback(
    (map: LeafletMap) => {
      const limites = map.getBounds();
      const centro = map.getCenter();
      onViewportChange(
        boundingBoxFromLatLngBounds({
          north: limites.getNorth(),
          south: limites.getSouth(),
          east: limites.getEast(),
          west: limites.getWest(),
        }),
        {
          latitude: centro.lat,
          longitude: centro.lng,
          zoom: map.getZoom(),
        },
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

/**
 * As camadas de base do modo atual.
 *
 * ## UM mapa, várias bases — nunca três instâncias
 *
 * Trocar de modo troca o `TileLayer`, e não o `MapContainer`. Remontar o mapa
 * jogaria fora centro, zoom e estado de interação a cada clique no controle, e
 * o operador voltaria ao enquadramento inicial só por ter querido ver o
 * telhado. É o oposto do que a fase inteira existe para consertar.
 *
 * ## O híbrido são DUAS camadas, e a ordem importa
 *
 * A imagem embaixo, os rótulos por cima, com `zIndex` explícito. Sem ele a
 * ordem de desenho depende da ordem de inserção no painel — que sobrevive hoje
 * e quebra na primeira vez que alguém reordenar o JSX.
 *
 * O `key` por modo força remontagem da camada em vez de reaproveitar a
 * anterior trocando a URL: reaproveitar deixa os tiles antigos na tela até os
 * novos chegarem, e satélite aparecendo sob rótulos de mapa normal é pior que
 * um instante de cinza.
 */
function BaseLayers({
  tiles,
  mode,
}: {
  tiles: MapTilesConfig;
  mode: MapMode;
}) {
  if (mode === "SATELLITE" && tiles.satellite) {
    return (
      <TileLayer
        key="satellite"
        url={tiles.satellite.urlTemplate}
        attribution={tiles.satellite.attribution}
        maxZoom={tiles.satellite.maxZoom}
      />
    );
  }

  if (mode === "HYBRID" && tiles.hybrid) {
    return (
      <>
        <TileLayer
          key="hybrid-base"
          url={tiles.hybrid.base.urlTemplate}
          attribution={tiles.hybrid.base.attribution}
          maxZoom={tiles.hybrid.base.maxZoom}
          zIndex={1}
        />
        <TileLayer
          key="hybrid-labels"
          url={tiles.hybrid.labels.urlTemplate}
          attribution={tiles.hybrid.labels.attribution}
          maxZoom={tiles.hybrid.labels.maxZoom}
          zIndex={2}
        />
      </>
    );
  }

  /*
    Fallback para NORMAL, e ele é a razão de este `return` não ter condição.

    Um modo pedido sem provedor configurado — satélite desligado, URL vindo de
    um link antigo — cai aqui em vez de renderizar nada. Um mapa sem camada de
    base é um retângulo cinza com marcadores flutuando, e o operador não teria
    como saber que a culpa é da configuração.
  */
  return (
    <TileLayer
      key="normal"
      url={tiles.normal.urlTemplate}
      attribution={tiles.normal.attribution}
      maxZoom={tiles.normal.maxZoom}
    />
  );
}

export default function MapCanvas({
  tiles,
  mode,
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

  /*
    O teto de zoom do MAPA é o do provedor mais generoso.

    Preso ao do modo atual, trocar de satélite (19) para uma base com 17
    deixaria o mapa num zoom que ela não serve — e o Leaflet mostraria cinza em
    vez de esticar o último tile válido. O `TileLayer` de cada modo continua
    declarando o seu, que é quem decide de onde vem a imagem.
  */
  const zoomMaximo = Math.max(
    tiles.normal.maxZoom,
    tiles.satellite?.maxZoom ?? 0,
    tiles.hybrid?.labels.maxZoom ?? 0,
  );

  return (
    <MapContainer
      {...enquadramento}
      maxZoom={zoomMaximo}
      scrollWheelZoom
      className="h-full w-full"
      // O mapa é operado com o mouse e com o teclado: `Tab` até ele, setas para
      // mover, `+`/`-` para o zoom. É comportamento nativo do Leaflet, e
      // desligá-lo (como muitos fazem para "não roubar o scroll") tiraria a
      // única forma de operar o mapa sem apontador.
      keyboard
      data-testid="map-canvas"
    >
      <BaseLayers tiles={tiles} mode={mode} />
      <ViewportReporter onViewportChange={onViewportChange} />
      <CanvasHandle onReady={onReady} />
      <SizeWatcher />
      {children}
    </MapContainer>
  );
}
