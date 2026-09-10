"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  BoundingBox,
  CtoMapSearchHit,
  CtoMapSearchResult,
  CtoMapView,
} from "@/lib/cto-map";
import {
  CTO_MAP_SEARCH_MAX_QUERY,
  CTO_MAP_STATUS_PRESENTATION as CTO_MAP_LEGEND,
  CTO_MAP_SEARCH_MIN_QUERY,
  CTO_MAP_VIEWPORT_DEBOUNCE_MS,
  boundingBoxToQuery,
  createLatestRequestGuard,
  usefulSearchLength,
} from "@/lib/cto-map-presentation";
import type { MapInitialView, MapTilesConfig } from "@/lib/map-config";
import {
  DEFAULT_MAP_MODE,
  MAP_MODE_STORAGE_KEY,
  buildMapViewQuery,
  parseMapMode,
  type MapMode,
  type MapViewState,
} from "@/lib/map-view-params";
import { OperationalMap } from "./OperationalMap";
import type { MapCamera, MapCanvasHandle } from "./MapCanvas";

/**
 * # A camada de CTO do Mapa Operacional
 *
 * O que é **de CTO** vive aqui: o DTO, a leitura de `/api/ctos/map`, a busca,
 * os marcadores, o popup, a seleção e os avisos de truncamento e de caixa sem
 * localização. O que é **do mapa** — Leaflet, tiles, viewport, moldura, modo,
 * carregamento e erro — está em `OperationalMap` e `MapCanvas`.
 *
 * ## Nada é recalculado aqui
 *
 * `status`, `free`, `occupied`, `reserved` e `damaged` chegam prontos do
 * servidor (`CTO-3.1`) e são exibidos como vieram. A tela **não** deriva estado
 * a partir do `summary`, e não conhece a precedência `INACTIVE > DAMAGED > FULL
 * > AVAILABLE`: ela conhece a tradução de cada valor para forma, glifo e
 * rótulo.
 *
 * ## A vista vive na URL (`CTO-3.2.1`)
 *
 * Centro, zoom, modo, busca e seleção são espelhados na barra de endereço a
 * cada mudança. É isso que faz o operador voltar de uma CTO para o **bairro
 * onde estava**, e não para o Brasil inteiro — o defeito que o dono encontrou
 * na validação da `CTO-3.2`.
 */

/**
 * Os marcadores entram por `dynamic`, e não por `import` normal.
 *
 * `leaflet` e `react-leaflet` tocam `window` **na carga do módulo**, e um
 * componente de cliente ainda é renderizado no servidor pelo Next. Um `import`
 * estático aqui derrubaria o `next build` com `window is not defined` — que é
 * exatamente o gate obrigatório desta fase.
 */
const CtoMarkers = dynamic(() => import("./CtoMarkers"), { ssr: false });

/**
 * Um array vazio ESTAVEL.
 *
 * Sem ele, cada render produziria um array novo, e o memo de `CtoMarkers`
 * nunca bloquearia nada. Aquele memo existe para fechar a realimentacao
 * popup -> autoPan -> moveend -> render; uma prop que muda de identidade a
 * cada render a reabriria em silencio.
 */
const SEM_MARCADORES: CtoMapView["markers"] = [];

interface CtoMapLayerProps {
  tiles: MapTilesConfig;
  /** Os modos que a configuração consegue desenhar. */
  modes: MapMode[];
  initialView: MapInitialView;
  /** A vista que veio da URL, já validada pelo servidor. */
  initialState: Partial<MapViewState>;
  /** `ADMIN` abre `/ctos/[id]`; `DISPATCHER` lê o mapa e não o detalhe. */
  canOpenDetail: boolean;
}

/** Um modo pedido que a configuração não desenha cai no padrão. */
function modoUtilizavel(pedido: MapMode | undefined, modes: MapMode[]): MapMode {
  if (pedido && modes.includes(pedido)) return pedido;
  return modes.includes(DEFAULT_MAP_MODE) ? DEFAULT_MAP_MODE : modes[0];
}

export function CtoMapLayer({
  tiles,
  modes,
  initialView,
  initialState,
  canOpenDetail,
}: CtoMapLayerProps) {
  const [view, setView] = useState<CtoMapView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [mode, setMode] = useState<MapMode>(() =>
    modoUtilizavel(initialState.mode, modes),
  );
  /*
    A câmera nasce COM o que veio na URL, e não vazia.

    Isto foi encontrado pela suíte completa, e é defeito e não instabilidade: o
    efeito que espelha a vista dispara antes de o mapa reportar a primeira
    posição, e com a câmera vazia ele montava uma query SEM `lat`/`lng` — e
    reescrevia a barra de endereço apagando justamente as coordenadas que a
    navegação acabara de trazer. Quem recarregasse ou copiasse a URL naquela
    janela perdia o lugar.

    Semeando daqui, o primeiro espelhamento escreve exatamente o que chegou.
  */
  const [camera, setCamera] = useState<MapCamera | null>(() =>
    initialState.latitude !== undefined && initialState.longitude !== undefined
      ? {
          latitude: initialState.latitude,
          longitude: initialState.longitude,
          zoom: initialState.zoom ?? 15,
        }
      : null,
  );
  const [search, setSearch] = useState(initialState.search ?? "");
  const [selectedId, setSelectedId] = useState<string | null>(
    initialState.selectedId ?? null,
  );

  const bboxRef = useRef<BoundingBox | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const guardRef = useRef(createLatestRequestGuard());
  const mapRef = useRef<MapCanvasHandle | null>(null);
  const modoVeioDaUrl = useRef(initialState.mode !== undefined);

  // ---------------------------------------------------------------------
  // Preferência de base — do aparelho
  // ---------------------------------------------------------------------

  /*
    A URL VENCE a preferência guardada, e a ordem não é arbitrária.

    Um link com `mode=SATELLITE` é uma escolha explícita para AQUELA vista —
    quem voltou de uma CTO pediu a base em que estava. A preferência do
    aparelho é o padrão de quem chega sem pedir nada.

    Lido num efeito, e não no `useState` inicial, por causa da hidratação: o
    servidor não tem `localStorage`, então ler durante o render produziria um
    HTML diferente do da primeira pintura do cliente. O preço é uma troca de
    camada logo após a montagem, e num mapa — cujos tiles chegam de forma
    assíncrona de qualquer jeito — isso não é visível.
  */
  useEffect(() => {
    if (modoVeioDaUrl.current) return;
    try {
      const guardado = parseMapMode(
        window.localStorage.getItem(MAP_MODE_STORAGE_KEY),
      );
      if (guardado && modes.includes(guardado)) setMode(guardado);
    } catch {
      // Janela anônima ou armazenamento bloqueado. O mapa não depende disso.
    }
  }, [modes]);

  const trocarModo = useCallback((novo: MapMode) => {
    setMode(novo);
    try {
      window.localStorage.setItem(MAP_MODE_STORAGE_KEY, novo);
    } catch {
      // Idem: preferência é conveniência, nunca requisito.
    }
  }, []);

  // ---------------------------------------------------------------------
  // A vista, espelhada na URL
  // ---------------------------------------------------------------------

  const viewQuery = useMemo(
    () =>
      buildMapViewQuery({
        latitude: camera?.latitude,
        longitude: camera?.longitude,
        zoom: camera?.zoom,
        mode,
        search,
        selectedId,
      }),
    [camera, mode, search, selectedId],
  );

  /*
    `history.replaceState`, e NÃO `router.replace`.

    O `router` do Next trataria cada arrasto como navegação: re-renderiza o
    componente de servidor, refaz a consulta de enquadramento inicial e pode
    remontar o mapa. `replaceState` troca só a barra de endereço, que é
    exatamente o que se quer — a URL passa a descrever a vista atual, e nada
    mais acontece.

    `replace` e não `push`: cada pan viraria uma entrada no histórico, e o botão
    voltar do navegador levaria trinta cliques para sair do mapa.
  */
  useEffect(() => {
    if (!viewQuery) return;
    /*
      Nunca escreve antes de o mapa saber onde está.

      A segunda metade da mesma correção: sem esta linha, qualquer render
      anterior ao primeiro `moveend` poderia publicar uma vista incompleta. A
      regra é simples — o espelho só reflete o que já existe.
    */
    if (!camera) return;

    /*
      O PRIMEIRO argumento é `history.state`, e passar `null` ali quebra a
      navegação do Next.

      Isto não é teoria: a primeira versão passava `null`, e o teste de
      navegador mostrou o clique em "Abrir CTO" simplesmente não acontecendo —
      a URL continuava em `/mapa`, sem erro no console. O App Router guarda o
      próprio estado de roteamento em `history.state`, e sobrescrevê-lo com
      `null` deixa o roteador sem a árvore que ele usa para navegar. O sintoma é
      um link que não faz nada.

      Repassar `window.history.state` troca só a URL e devolve ao Next
      exatamente o que ele havia guardado.
    */
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}?${viewQuery}`,
    );
  }, [viewQuery, camera]);

  // ---------------------------------------------------------------------
  // Leitura do recorte
  // ---------------------------------------------------------------------

  const carregar = useCallback(async (bbox: BoundingBox) => {
    // Cancela a leitura anterior: ninguém precisa do bairro que já saiu da tela.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const bilhete = guardRef.current.begin();
    setLoading(true);

    try {
      const res = await fetch(`/api/ctos/map?${boundingBoxToQuery(bbox)}`, {
        signal: controller.signal,
        // Uma leitura de mapa servida do cache mostra a rede de dez minutos
        // atrás sem nenhum sinal — a mesma razão do `no-store` da `DQ-5`.
        cache: "no-store",
      });
      const payload = await res.json().catch(() => null);

      /*
        Defesa em profundidade atrás do aborto — e isso foi MEDIDO.

        O modo de falha é o do bairro lento: a leitura de A demora mais que a de
        B, chega depois, e o mapa fica no lugar certo com os marcadores do outro
        lugar, sem erro nenhum na tela. No navegador quem impede isso é o
        `abort()` acima; a sabotagem `S2` da `CTO-3.2` provou que removendo esta
        linha o spec do mapa continua verde.

        Ela fica porque cobre o que o aborto não cobre: um chamador que esqueça
        o `signal`, uma troca de transporte, ou qualquer refatoração que afaste
        a decisão de escrever no estado da promessa cancelada.
      */
      if (!guardRef.current.isCurrent(bilhete)) return;

      if (!res.ok) {
        setError(
          payload?.error ?? "Não foi possível carregar as CTOs desta área.",
        );
        return;
      }
      setView(payload?.data?.map ?? null);
      setError(null);
    } catch {
      if (controller.signal.aborted) return;
      if (!guardRef.current.isCurrent(bilhete)) return;
      /*
        Falha de rede NÃO limpa os marcadores.

        Zerar a lista aqui produziria um mapa vazio, que é indistinguível de uma
        região sem caixas — e essa leitura errada é a perigosa, porque levaria o
        despachante a concluir que não há infraestrutura no bairro. O que
        aparece é o erro por cima do que já estava.
      */
      setError("Erro de conexão ao carregar as CTOs desta área.");
    } finally {
      if (guardRef.current.isCurrent(bilhete)) setLoading(false);
    }
  }, []);

  const handleViewport = useCallback(
    (bbox: BoundingBox, cameraAtual: MapCamera) => {
      bboxRef.current = bbox;
      setCamera(cameraAtual);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        void carregar(bbox);
      }, CTO_MAP_VIEWPORT_DEBOUNCE_MS);
    },
    [carregar],
  );

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      abortRef.current?.abort();
    };
  }, []);

  const tentarNovamente = useCallback(() => {
    const bbox = bboxRef.current;
    if (!bbox) return;
    setError(null);
    void carregar(bbox);
  }, [carregar]);

  /*
    Estavel, e nao um arrow inline.

    O efeito de `CanvasHandle` depende desta funcao; um arrow novo a cada
    render faria o efeito reexecutar a cada movimento do mapa.
  */
  const guardarMapa = useCallback((handle: MapCanvasHandle) => {
    mapRef.current = handle;
  }, []);

  const focarEm = useCallback((hit: CtoMapSearchHit) => {
    if (hit.latitude === null || hit.longitude === null) return;
    mapRef.current?.focusOn(hit.latitude, hit.longitude);
    setSelectedId(hit.id);
  }, []);

  const markers = view?.markers ?? SEM_MARCADORES;

  return (
    <div className="space-y-4">
      <CtoMapSearch
        value={search}
        onValueChange={setSearch}
        onSelect={focarEm}
        canOpenDetail={canOpenDetail}
      />

      <OperationalMap
        tiles={tiles}
        modes={modes}
        mode={mode}
        onModeChange={trocarModo}
        initialView={initialView}
        onViewportChange={handleViewport}
        onReady={guardarMapa}
        loading={loading}
        error={error}
        onRetry={tentarNovamente}
        overlay={
          view?.truncated ? (
            <p
              className="pointer-events-auto rounded-lg border border-warning-border bg-warning-bg px-3 py-1.5 text-xs font-medium text-warning-fg shadow-sm"
              role="status"
              data-testid="map-truncated"
            >
              Esta área tem mais de {view.limit} CTOs. Aproxime o mapa para
              carregar todas.
            </p>
          ) : null
        }
      >
        <CtoMarkers
          markers={markers}
          selectedId={selectedId}
          onSelect={setSelectedId}
          canOpenDetail={canOpenDetail}
        />
      </OperationalMap>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-muted">
        {/*
          Com a leitura falhando, a contagem NÃO afirma um número.

          Isto foi encontrado pelo teste de navegador, não por inspeção: o aviso
          de erro cobre o mapa, mas a linha de baixo continuava dizendo "0 CTOs
          nesta área" — a frase exata que a fase inteira existe para não dizer.
          O despachante leria a contagem, que parece um fato, e concluiria que o
          bairro não tem infraestrutura.

          São dois elementos e não um texto condicional de propósito: assim um
          teste consegue afirmar a AUSÊNCIA da contagem, e não apenas que o texto
          dela mudou.
        */}
        {error ? (
          <span data-testid="map-count-unavailable">
            Contagem indisponível enquanto a leitura desta área falha.
          </span>
        ) : (
          <span data-testid="map-marker-count">
            {markers.length === 1
              ? "1 CTO nesta área"
              : `${markers.length} CTOs nesta área`}
          </span>
        )}

        {/*
          O contador de caixas sem localização é da EMPRESA, não do recorte
          (`CTO-3.1`): uma caixa sem coordenada não está em região nenhuma. Por
          isso ele não muda quando o mapa se move, e o texto diz "no cadastro"
          para que ninguém o leia como "aqui perto".
        */}
        {view && view.missingLocationCount > 0 ? (
          <span data-testid="map-missing-location">
            {view.missingLocationCount === 1
              ? "1 CTO sem localização no cadastro"
              : `${view.missingLocationCount} CTOs sem localização no cadastro`}
            {canOpenDetail ? (
              <>
                {" · "}
                <Link
                  href="/ctos"
                  className="font-medium text-primary-text underline underline-offset-2 hover:text-primary-text-hover"
                >
                  ver no cadastro
                </Link>
              </>
            ) : null}
          </span>
        ) : null}
      </div>

      <MapLegend />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Busca
// ---------------------------------------------------------------------------

/**
 * A busca é GLOBAL no tenant, e não do recorte.
 *
 * Quem procura a `A16` quase sempre está olhando outro bairro. Limitar ao que
 * está na tela responderia *"não existe"* sobre uma caixa que existe — a pior
 * resposta que um campo de busca pode dar.
 *
 * O fluxo é achar → **recentralizar** → o recorte carregar. Nada aqui desenha
 * marcador: quem desenha continua sendo a leitura do recorte.
 *
 * **O termo é CONTROLADO pelo pai** desde a `CTO-3.2.1`, porque ele agora
 * atravessa a navegação: quem volta de uma CTO precisa reencontrar o que
 * digitou. Estado local aqui morreria exatamente no momento em que precisaria
 * sobreviver.
 */
function CtoMapSearch({
  value,
  onValueChange,
  onSelect,
  canOpenDetail,
}: {
  value: string;
  onValueChange: (termo: string) => void;
  onSelect: (hit: CtoMapSearchHit) => void;
  canOpenDetail: boolean;
}) {
  const [resultado, setResultado] = useState<CtoMapSearchResult | null>(null);
  const [buscando, setBuscando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const guardRef = useRef(createLatestRequestGuard());

  useEffect(() => {
    /*
      Abaixo do mínimo não consulta.

      A constante é a MESMA que o domínio usa (`normalizeMapSearchQuery`), e não
      uma cópia — é uma regra só, com dois consumidores. E o servidor continua
      valendo: quem chamar a rota direto com um termo curto recebe lista vazia
      pela decisão dele, não pela desta tela.
    */
    const limpo = value.trim();
    if (usefulSearchLength(limpo) < CTO_MAP_SEARCH_MIN_QUERY) {
      if (timerRef.current) clearTimeout(timerRef.current);
      abortRef.current?.abort();
      guardRef.current.begin();
      setResultado(null);
      setErro(null);
      setBuscando(false);
      return;
    }

    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      void (async () => {
        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;
        const bilhete = guardRef.current.begin();
        setBuscando(true);
        try {
          const res = await fetch(
            `/api/ctos/map/search?q=${encodeURIComponent(limpo)}`,
            { signal: controller.signal, cache: "no-store" },
          );
          const payload = await res.json().catch(() => null);
          if (!guardRef.current.isCurrent(bilhete)) return;
          if (!res.ok) {
            setErro(payload?.error ?? "Não foi possível buscar agora.");
            setResultado(null);
            return;
          }
          setResultado(payload?.data?.search ?? null);
          setErro(null);
        } catch {
          if (controller.signal.aborted) return;
          if (!guardRef.current.isCurrent(bilhete)) return;
          setErro("Erro de conexão na busca.");
          setResultado(null);
        } finally {
          if (guardRef.current.isCurrent(bilhete)) setBuscando(false);
        }
      })();
    }, CTO_MAP_VIEWPORT_DEBOUNCE_MS);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [value]);

  const hits = resultado?.hits ?? [];
  const digitando = usefulSearchLength(value.trim()) < CTO_MAP_SEARCH_MIN_QUERY;

  return (
    <div className="rounded-2xl border border-border bg-surface p-4 shadow-sm">
      <label
        className="mb-1 block text-sm font-medium text-fg-secondary"
        htmlFor="cto-map-search"
      >
        Buscar CTO
      </label>
      <input
        id="cto-map-search"
        type="search"
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        maxLength={CTO_MAP_SEARCH_MAX_QUERY}
        placeholder="ex.: A16 ou o código da caixa"
        autoComplete="off"
        aria-describedby="cto-map-search-hint"
        className="w-full rounded-lg border border-input-border px-3 py-2 text-sm text-fg focus:border-focus focus:outline-none focus:ring-2 focus:ring-focus-soft"
        data-testid="cto-map-search-input"
      />
      <p id="cto-map-search-hint" className="mt-1 text-xs text-fg-muted">
        A busca procura em toda a sua rede, e não apenas na área visível.
      </p>

      <div aria-live="polite" data-testid="cto-map-search-results">
        {erro ? (
          <p className="mt-3 text-sm font-medium text-danger-fg" role="alert">
            {erro}
          </p>
        ) : null}

        {!erro && buscando ? (
          <p className="mt-3 text-xs text-fg-muted">Buscando…</p>
        ) : null}

        {!erro && !buscando && !digitando && resultado && hits.length === 0 ? (
          <p className="mt-3 text-sm text-fg-secondary">
            Nenhuma CTO encontrada com esse nome ou código.
          </p>
        ) : null}

        {!erro && hits.length > 0 ? (
          <ul className="mt-3 divide-y divide-border-subtle rounded-lg border border-border">
            {hits.map((hit) => {
              const semLocalizacao =
                hit.latitude === null || hit.longitude === null;
              return (
                <li
                  key={hit.id}
                  className="flex items-center justify-between gap-3 px-3 py-2"
                  data-testid="cto-map-search-hit"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-fg">
                      {hit.name}
                    </p>
                    {hit.code ? (
                      <p className="truncate text-xs text-fg-muted">
                        Código {hit.code}
                      </p>
                    ) : null}
                  </div>

                  {/*
                    Sem coordenada NÃO recentraliza, e o botão nem existe.

                    Um "ver no mapa" que não faz nada — ou que leva a um ponto
                    inventado — é pior que a ausência dele. A caixa aparece na
                    busca, dita o motivo, e oferece o que ela realmente tem.
                  */}
                  {semLocalizacao ? (
                    <span
                      className="shrink-0 rounded-full border border-neutral-border bg-neutral-bg px-2 py-0.5 text-[11px] font-medium text-neutral-fg"
                      data-testid="cto-map-search-hit-unlocated"
                    >
                      Sem localização
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onSelect(hit)}
                      className="shrink-0 rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-fg-secondary transition-colors hover:bg-surface-muted"
                      data-testid="cto-map-search-hit-focus"
                    >
                      Ver no mapa
                    </button>
                  )}

                  {canOpenDetail ? (
                    <Link
                      href={`/ctos/${hit.id}`}
                      className="shrink-0 text-xs font-medium text-primary-text underline underline-offset-2 hover:text-primary-text-hover"
                    >
                      Abrir CTO
                    </Link>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}

        {!erro && resultado?.truncated ? (
          <p className="mt-2 text-xs text-fg-muted">
            Mostrando as {resultado.limit} primeiras. Use um termo mais
            específico.
          </p>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Legenda
// ---------------------------------------------------------------------------

/**
 * A legenda existe porque o marcador é pequeno.
 *
 * Forma e glifo carregam o estado, mas nada explica o que uma forma significa
 * na primeira vez que se olha. A legenda é o texto que fecha isso — e é ela que
 * garante que o estado esteja escrito na página mesmo com todos os popups
 * fechados.
 *
 * Ela mostra o **selo**, e não a caixa inteira: a silhueta é a mesma nos quatro
 * estados, então redesenhá-la quatro vezes não explicaria nada. O que muda — e
 * portanto o que precisa de legenda — é o selo.
 */
function MapLegend() {
  return (
    <ul
      className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-fg-secondary"
      data-testid="map-legend"
    >
      {(["AVAILABLE", "FULL", "DAMAGED", "INACTIVE"] as const).map((status) => {
        const apresentacao = CTO_MAP_LEGEND[status];
        return (
          <li key={status} className="flex items-center gap-2">
            <span
              className={`cto-marker cto-marker--${apresentacao.shape} cto-marker--${apresentacao.tone}`}
              aria-hidden="true"
              style={{ width: 20, height: 20, fontSize: 11 }}
            >
              <span>{apresentacao.glyph}</span>
            </span>
            {apresentacao.label}
          </li>
        );
      })}
    </ul>
  );
}
