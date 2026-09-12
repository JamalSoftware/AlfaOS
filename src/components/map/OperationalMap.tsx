"use client";

import dynamic from "next/dynamic";
import { type ReactNode } from "react";
import type { BoundingBox } from "@/lib/cto-map";
import type { MapInitialView, MapTilesConfig } from "@/lib/map-config";
import type { MapMode } from "@/lib/map-view-params";
import type { MapCamera, MapCanvasHandle } from "./MapCanvas";

/**
 * # O Mapa Operacional — o invólucro genérico
 *
 * ```text
 * OperationalMap   moldura, SSR, tiles, modo, carregamento, erro   ← genérico
 *   MapCanvas      Leaflet, viewport, zoom/pan, camadas de base    ← genérico
 *     children     marcadores da camada                            ← específico
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
 * O controle de base (`NORMAL`/`SATELLITE`/`HYBRID`) mora aqui, e não na camada
 * de CTO, porque ele é sobre o **fundo do mapa** — vale igual para qualquer
 * camada que venha depois.
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

const ROTULO_DO_MODO: Record<MapMode, string> = {
  NORMAL: "Mapa",
  SATELLITE: "Satélite",
  HYBRID: "Híbrido",
};

/**
 * O seletor de base.
 *
 * **Só aparecem os modos que a configuração consegue desenhar.** Um botão de
 * satélite sem provedor responderia com o mapa cinza — e o operador não teria
 * como saber que a culpa é do ambiente. É a mesma escolha do botão "Abrir CTO"
 * ausente para o `DISPATCHER` na `CTO-3.2`: melhor não oferecer do que oferecer
 * algo que não funciona.
 *
 * Com um modo só, o controle inteiro some: um seletor de uma opção é ruído.
 */
function MapModeControl({
  modes,
  mode,
  onChange,
}: {
  modes: MapMode[];
  mode: MapMode;
  onChange: (modo: MapMode) => void;
}) {
  if (modes.length < 2) return null;

  return (
    <div
      className="pointer-events-auto absolute right-3 top-3 z-[600] flex overflow-hidden rounded-lg border border-border bg-surface shadow-sm"
      role="group"
      aria-label="Tipo de mapa"
      data-testid="map-mode-control"
    >
      {modes.map((valor) => {
        const ativo = valor === mode;
        return (
          <button
            key={valor}
            type="button"
            onClick={() => onChange(valor)}
            // `aria-pressed` e não só uma classe de cor: quem usa leitor de
            // tela precisa saber qual base está ativa, e a cor não é lida.
            aria-pressed={ativo}
            data-testid={`map-mode-${valor.toLowerCase()}`}
            className={`px-3 py-1.5 text-xs font-medium transition-colors ${
              ativo
                ? "bg-primary text-primary-fg"
                : "text-fg-secondary hover:bg-surface-muted"
            }`}
          >
            {ROTULO_DO_MODO[valor]}
          </button>
        );
      })}
    </div>
  );
}

export interface OperationalMapProps {
  tiles: MapTilesConfig;
  /** Os modos que a configuração consegue desenhar. */
  modes: MapMode[];
  mode: MapMode;
  onModeChange: (modo: MapMode) => void;
  initialView: MapInitialView;
  onViewportChange: (bbox: BoundingBox, camera: MapCamera) => void;
  onReady?: (handle: MapCanvasHandle) => void;
  /*
    NÃO existe prop de carregamento aqui — e existiu, até a `CTO-3.2.2e`.

    O invólucro desenhava "Carregando CTOs…" no instante em que a camada de
    CTO começava a ler e o apagava no instante em que ela terminava. Numa
    resposta normal isso dava um flash de ~80 ms a cada zoom e a cada arrasto
    (medido em sonda de 20 ms), e o dono via o mapa "piscando". Em paralelo a
    camada já tinha o aviso único "Atualizando mapa…", com atraso — eram DOIS
    indicadores para a mesma coisa, e o que piscava era o que não esperava.

    O aviso de atividade é responsabilidade da CAMADA, que sabe quantas
    leituras estão em voo, e entra por `overlay`. A cadência dele mora em
    `src/lib/map-activity-indicator.ts`.
  */
  /** A leitura falhou. Substitui o conteúdo por uma explicação e um botão. */
  error?: string | null;
  onRetry?: () => void;
  /** Faixa da camada — contagem, truncamento, o que a camada precisar dizer. */
  overlay?: ReactNode;
  /**
   * Painel de edição, ancorado DENTRO do mapa — `CTO-3.2.1d`.
   *
   * ## Ele não pode empurrar o mapa, e isso foi medido
   *
   * A primeira versão renderizava o painel de ajuste de posição **acima** do
   * mapa, no fluxo da página. Medido no navegador: entrar em modo de edição
   * descia o mapa **206 pixels** — ou seja, o mapa saltava debaixo da mão
   * exatamente no instante em que a pessoa vai arrastar com precisão. Somado
   * aos 138px que o `autoPan` do popup já havia deslocado, a caixa que se quer
   * mover simplesmente muda de lugar duas vezes antes do primeiro arrasto.
   *
   * Ancorado dentro do mapa, nada no fluxo se move: a caixa fica onde estava, e
   * o painel aparece garantidamente na área visível, perto do que ele controla.
   *
   * Canto inferior ESQUERDO: o controle de base ocupa o superior direito e a
   * faixa de status o topo central.
   */
  editor?: ReactNode;
  children?: ReactNode;
}

export function OperationalMap({
  tiles,
  modes,
  mode,
  onModeChange,
  initialView,
  onViewportChange,
  onReady,
  error = null,
  onRetry,
  overlay,
  editor,
  children,
}: OperationalMapProps) {
  return (
    <div
      /*
        Altura EXPLÍCITA, em PIXELS, e por dois motivos diferentes.

        O primeiro é banal e fatal: o Leaflet mede o contêiner, e um contêiner
        sem altura declarada colapsa em zero. O mapa "não aparece" sem nenhum
        erro — só um `div` de 0px.

        O segundo veio da validação do dono: com `vh`, o mapa crescia com a
        tela e empurrava busca, contadores e legenda para fora da primeira
        dobra. **Altura de mapa não é fração de tela**, é uma faixa de leitura:
        acima de uns 560px ela deixa de acrescentar contexto e só passa a
        esconder o resto da página.

        ```text
        celular   340px      desktop            410px
        pequeno   380px      desktop ALTO       440px
        tablet    400px      (≥ 1024 × ≥ 860)
        ```

        ## O degrau de ALTURA — `CTO-3.2.2e`

        O dono pediu mais área vertical, e a resposta honesta depende de
        quanto sobra abaixo do mapa. Medido com o topo do mapa em 309px de
        documento (com a camada de clientes ligada, o cartão de camadas ganha
        o filtro e cresce 11px): numa janela de 720 de altura, um mapa de 410
        termina em 719 — um pixel a mais e ele é cortado na dobra, que é pior
        que ser pequeno. Numa de 900 sobram 200, e 440 é o maior mapa que
        ainda deixa resumo E legenda inteiros na primeira dobra com as TRÊS
        camadas ligadas (a legenda termina em 895) — a propriedade que a
        `CTO-3.2.2` corrigiu e a `LAYER-21` guarda. 460 seria possível ao custo
        de 15px de legenda abaixo da dobra; ficou registrado como decisão do
        dono, não tomada aqui.

        Por isso o último degrau é por LARGURA e ALTURA de janela, e continua
        sendo um número de pixels — um degrau discreto, previsível, e não um
        mapa que cresce junto com a janela. A regra não mudou: nenhuma unidade
        de viewport, em degrau nenhum.

        `100vh` continua fora de propósito, e não só como padrão: num notebook
        com barra de tarefas ele produz um mapa que nunca cabe inteiro.
      */
      className="cto-map-shell relative h-[340px] w-full overflow-hidden rounded-2xl border border-border bg-surface-muted sm:h-[380px] md:h-[400px] lg:h-[410px] [@media(min-width:1024px)_and_(min-height:860px)]:h-[440px]"
      data-testid="operational-map"
    >
      <MapCanvas
        tiles={tiles}
        mode={mode}
        initialView={initialView}
        onViewportChange={onViewportChange}
        onReady={onReady}
      >
        {children}
      </MapCanvas>

      <MapModeControl modes={modes} mode={mode} onChange={onModeChange} />

      {overlay ? (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-[500] flex flex-col items-center gap-2 p-3">
          {overlay}
        </div>
      ) : null}

      {editor ? (
        <div className="pointer-events-auto absolute bottom-3 left-3 z-[600] w-[min(19rem,calc(100%-1.5rem))]">
          {editor}
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
