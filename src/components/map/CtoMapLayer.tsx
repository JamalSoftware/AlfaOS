"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
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
import type { MapInitialView, MapTileConfig } from "@/lib/map-config";
import { OperationalMap } from "./OperationalMap";
import type { MapCanvasHandle } from "./MapCanvas";

/**
 * # A camada de CTO do Mapa Operacional
 *
 * O que é **de CTO** vive aqui: o DTO, a leitura de `/api/ctos/map`, a busca,
 * os marcadores, o popup, a seleção e os avisos de truncamento e de caixa sem
 * localização. O que é **do mapa** — Leaflet, tiles, viewport, moldura,
 * carregamento e erro — está em `OperationalMap` e `MapCanvas`, e esta camada
 * não sabe como nada disso funciona.
 *
 * ## Nada é recalculado aqui
 *
 * `status`, `free`, `occupied`, `reserved` e `damaged` chegam prontos do
 * servidor (`CTO-3.1`) e são exibidos como vieram. A tela **não** deriva estado
 * a partir do `summary`, e não conhece a precedência `INACTIVE > DAMAGED > FULL
 * > AVAILABLE`: ela conhece a tradução de cada valor para forma, glifo e
 * rótulo. Duas precedências divergiriam, e a que ninguém revisaria seria a
 * daqui.
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

interface CtoMapLayerProps {
  tiles: MapTileConfig;
  initialView: MapInitialView;
  /** `ADMIN` abre `/ctos/[id]`; `DISPATCHER` lê o mapa e não o detalhe. */
  canOpenDetail: boolean;
}

export function CtoMapLayer({
  tiles,
  initialView,
  canOpenDetail,
}: CtoMapLayerProps) {
  const [view, setView] = useState<CtoMapView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const bboxRef = useRef<BoundingBox | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const guardRef = useRef(createLatestRequestGuard());
  const mapRef = useRef<MapCanvasHandle | null>(null);

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
        O bilhete decide, e não o `AbortController`.

        Abortar é um PEDIDO de cancelamento: uma resposta já em trânsito pode
        chegar assim mesmo. Sem esta linha, a leitura lenta do bairro anterior
        sobrescreveria a do bairro atual, e o mapa mostraria os marcadores de um
        lugar sobre a geografia de outro — sem erro nenhum na tela.
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
    (bbox: BoundingBox) => {
      bboxRef.current = bbox;
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

  const focarEm = useCallback((hit: CtoMapSearchHit) => {
    if (hit.latitude === null || hit.longitude === null) return;
    mapRef.current?.focusOn(hit.latitude, hit.longitude);
    setSelectedId(hit.id);
  }, []);

  const markers = view?.markers ?? [];

  return (
    <div className="space-y-4">
      <CtoMapSearch onSelect={focarEm} canOpenDetail={canOpenDetail} />

      <OperationalMap
        tiles={tiles}
        initialView={initialView}
        onViewportChange={handleViewport}
        onReady={(handle) => {
          mapRef.current = handle;
        }}
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
 * marcador: quem desenha continua sendo a leitura do recorte, com a mesma
 * autoridade de sempre.
 */
function CtoMapSearch({
  onSelect,
  canOpenDetail,
}: {
  onSelect: (hit: CtoMapSearchHit) => void;
  canOpenDetail: boolean;
}) {
  const [termo, setTermo] = useState("");
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
    const limpo = termo.trim();
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
  }, [termo]);

  const hits = resultado?.hits ?? [];
  const digitando = usefulSearchLength(termo.trim()) < CTO_MAP_SEARCH_MIN_QUERY;

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
        value={termo}
        onChange={(e) => setTermo(e.target.value)}
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
