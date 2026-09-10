"use client";

import { useCallback, useEffect, type ReactNode } from "react";
import type { Map as LeafletMap } from "leaflet";
import { MapContainer, TileLayer, useMap, useMapEvents } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import type { BoundingBox } from "@/lib/cto-map";
import { boundingBoxFromLatLngBounds } from "@/lib/cto-map-presentation";
import type { MapInitialView, MapTilesConfig } from "@/lib/map-config";
/*
  Os valores vem do .mjs PURO, e nao de `map-config`.

  `map-config` importa `prisma`. Importar valor dele num componente de cliente
  arrastaria o Prisma para o bundle do navegador — o defeito que a `DQ-4` pagou
  com a pagina de login inteira. O teste estrutural da `CTO-3.2` pegou esta
  regressao no momento em que ela nasceu.
*/
import {
  MAP_INITIAL_FIT_MAX_ZOOM,
  MAP_MAX_ZOOM,
} from "@/lib/map-tiles.config.mjs";
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
  /**
   * Fecha o popup aberto, se houver.
   *
   * Existe para a `CTO-3.2.1d`: entrar em modo de edição precisa tirar o popup
   * da frente da caixa que vai ser arrastada. É do canvas e não da camada
   * porque quem conhece o mapa do Leaflet é este arquivo — a camada de CTO não
   * tem, e não deve ter, a instância dele.
   */
  closePopup: () => void;
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
        map.setView(
          [latitude, longitude],
          // Nunca AFASTA: quem clicou num resultado quer chegar. E o piso e o
          // mesmo enquadramento confortavel do mapa recem-aberto.
          zoom ?? Math.max(map.getZoom(), MAP_INITIAL_FIT_MAX_ZOOM),
        );
      },
      closePopup: () => {
        map.closePopup();
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
        maxNativeZoom={tiles.satellite.maxNativeZoom}
        maxZoom={MAP_MAX_ZOOM}
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
          maxNativeZoom={tiles.hybrid.base.maxNativeZoom}
          maxZoom={MAP_MAX_ZOOM}
          zIndex={1}
        />
        <TileLayer
          key="hybrid-labels"
          url={tiles.hybrid.labels.urlTemplate}
          attribution={tiles.hybrid.labels.attribution}
          maxNativeZoom={tiles.hybrid.labels.maxNativeZoom}
          maxZoom={MAP_MAX_ZOOM}
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
      maxNativeZoom={tiles.normal.maxNativeZoom}
      maxZoom={MAP_MAX_ZOOM}
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
            maxZoom: MAP_INITIAL_FIT_MAX_ZOOM,
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
    O teto do MAPA é único; o de cada CAMADA é próprio.

    `MAP_MAX_ZOOM` diz até onde a pessoa pode aproximar, e vale igual nos três
    modos — assim trocar de base nunca muda o zoom debaixo da mão de quem está
    olhando. Quem diz "até onde existe tile" é o `maxNativeZoom` de cada
    `TileLayer`, e acima dele o Leaflet amplia o último nível real.

    Foi essa separação que tirou a placa "Map data not yet available" da tela: o
    satélite tem imagem até `z18` na maior parte do país, o mapa vai até `z20`, e
    os dois últimos níveis são ampliação — não um pedido a um tile que não
    existe. Ver a medição em `map-tiles.config.mjs`.
  */

  return (
    <MapContainer
      {...enquadramento}
      maxZoom={MAP_MAX_ZOOM}
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
