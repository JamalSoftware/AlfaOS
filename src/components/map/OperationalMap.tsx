"use client";

import dynamic from "next/dynamic";
import { type ReactNode } from "react";
import type { BoundingBox } from "@/lib/cto-map";
import type { MapInitialView, MapTileConfig } from "@/lib/map-config";
import type { MapCanvasHandle } from "./MapCanvas";

/**
 * # O Mapa Operacional — o invólucro genérico
 *
 * ```text
 * OperationalMap   moldura, SSR, tiles, carregamento, erro   ← genérico
 *   MapCanvas      Leaflet, viewport, zoom/pan               ← genérico
 *     children     marcadores da camada                      ← específico
 * ```
 *
 * Nada aqui sabe o que é uma CTO. Quando a camada de técnico, de cliente ou de
 * OS existir (§136, §207), ela entra como `children` e traz os próprios
 * marcadores, o próprio popup e o próprio carregamento — este arquivo não muda.
 *
 * **E também não há abstração para camada que não existe.** Não existe registro
 * de camadas, seletor, nem interface `MapLayer`: hoje há uma, e inventar o
 * mecanismo de composição antes da segunda produziria uma forma escolhida sem
 * nenhum caso real para validá-la.
 *
 * ## `ssr: false` não é preferência
 *
 * O Leaflet toca `window` na construção do mapa. Num render de servidor isso é
 * `window is not defined`, e o `next build` — gate obrigatório — falha. O
 * `dynamic` com `ssr: false` faz o canvas ser carregado só no navegador; o
 * esqueleto abaixo é o que ocupa o lugar até lá.
 */

const MapCanvas = dynamic(() => import("./MapCanvas"), {
  ssr: false,
  loading: () => <MapSkeleton />,
});

function MapSkeleton() {
  return (
    <div
      className="flex h-full w-full items-center justify-center bg-surface-muted"
      data-testid="map-skeleton"
    >
      <p className="text-sm text-fg-muted">Carregando o mapa…</p>
    </div>
  );
}

export interface OperationalMapProps {
  tiles: MapTileConfig;
  initialView: MapInitialView;
  onViewportChange: (bbox: BoundingBox) => void;
  onReady?: (handle: MapCanvasHandle) => void;
  /** Uma leitura está em voo. Vira um aviso discreto, nunca um mapa em branco. */
  loading?: boolean;
  /** A leitura falhou. Substitui o conteúdo por uma explicação e um botão. */
  error?: string | null;
  onRetry?: () => void;
  /** Faixa da camada — contagem, truncamento, o que a camada precisar dizer. */
  overlay?: ReactNode;
  children?: ReactNode;
}

export function OperationalMap({
  tiles,
  initialView,
  onViewportChange,
  onReady,
  loading = false,
  error = null,
  onRetry,
  overlay,
  children,
}: OperationalMapProps) {
  return (
    <div
      /*
        Altura EXPLÍCITA, e o motivo é banal e fatal: o Leaflet mede o
        contêiner, e um contêiner sem altura declarada colapsa em zero. O mapa
        "não aparece" sem nenhum erro — só um `div` de 0px.

        `min-h` junto do `vh` porque numa janela baixa (notebook com a barra de
        tarefas, tablet deitado) 60vh pode dar 250px, e aí o mapa existe mas não
        serve para nada.
      */
      className="cto-map-shell relative h-[60vh] min-h-[380px] w-full overflow-hidden rounded-2xl border border-border bg-surface-muted lg:h-[calc(100vh-14rem)]"
      data-testid="operational-map"
    >
      <MapCanvas
        tiles={tiles}
        initialView={initialView}
        onViewportChange={onViewportChange}
        onReady={onReady}
      >
        {children}
      </MapCanvas>

      {overlay ? (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-[500] flex flex-col items-center gap-2 p-3">
          {overlay}
        </div>
      ) : null}

      {/*
        O aviso de carregamento é uma FAIXA, e não uma cortina.

        Cobrir o mapa a cada arrasto tiraria da tela justamente a referência que
        a pessoa está usando para se localizar. O mapa continua visível com os
        marcadores anteriores, e a faixa diz que vem coisa nova.
      */}
      {loading && !error ? (
        <div
          className="absolute left-1/2 top-3 z-[600] -translate-x-1/2 rounded-full border border-border bg-surface px-3 py-1 text-xs font-medium text-fg-secondary shadow-sm"
          role="status"
          data-testid="map-loading"
        >
          Carregando CTOs…
        </div>
      ) : null}

      {/*
        Erro COBRE o mapa, e essa assimetria é a regra.

        Um mapa vazio depois de uma falha é indistinguível de uma região sem
        caixas — e a leitura errada é a perigosa: o despachante concluiria que
        não há infraestrutura ali. Enquanto a leitura estiver falhando, o mapa
        não pode ser apresentado como se fosse resposta.
      */}
      {error ? (
        <div
          className="absolute inset-0 z-[700] flex flex-col items-center justify-center gap-3 bg-surface/95 p-6 text-center"
          role="alert"
          data-testid="map-error"
        >
          <p className="max-w-md text-sm font-medium text-danger-fg">{error}</p>
          <p className="max-w-md text-xs text-fg-muted">
            O mapa não está mostrando as CTOs desta área. Isto não significa que
            não existam caixas aqui.
          </p>
          {onRetry ? (
            <button
              type="button"
              onClick={onRetry}
              className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm font-medium text-fg-secondary transition-colors hover:bg-surface-muted"
            >
              Tentar novamente
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
