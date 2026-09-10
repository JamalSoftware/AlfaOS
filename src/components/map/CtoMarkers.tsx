"use client";

import Link from "next/link";
import { divIcon, type DivIcon } from "leaflet";
import { Marker, Popup } from "react-leaflet";
import type { CtoMapMarker } from "@/lib/cto-map";
import { ctoMapStatusPresentation } from "@/lib/cto-map-presentation";
import { OPERATIONAL_MAP_PATH } from "@/lib/return-to";
import { CTO_MARKER_SIZE, ctoMarkerHtml } from "./cto-marker-icon";

/**
 * # Os marcadores da camada de CTO
 *
 * Renderiza **dentro** do canvas: `react-leaflet` entrega o mapa por contexto
 * de React, e um `Marker` fora da árvore do `MapContainer` não tem onde se
 * desenhar.
 *
 * O desenho em si mora em `cto-marker-icon.ts`, que não conhece React nem
 * Leaflet — é o que permite um teste afirmar sobre o SVG sem montar um mapa.
 */

/**
 * Os ícones são MEMORIZADOS, e isso deixou de ser detalhe na `CTO-3.2.1`.
 *
 * O marcador agora é reconstruído sempre que a vista muda, porque a `href` de
 * "Abrir CTO" carrega centro, zoom e modo — e a vista muda a cada arrasto. Sem
 * cache, cada pan criaria duzentos `divIcon` novos e o react-leaflet chamaria
 * `setIcon` em duzentos marcadores, trocando o DOM de todos eles.
 *
 * A chave é `(estado, selecionado)` porque é disso — e só disso — que o desenho
 * depende. Nome, código e posição não entram no ícone.
 */
const cacheDeIcones = new Map<string, DivIcon>();

function iconePara(marker: CtoMapMarker, selecionado: boolean): DivIcon {
  const chave = `${marker.status}:${selecionado ? "1" : "0"}`;
  const guardado = cacheDeIcones.get(chave);
  if (guardado) return guardado;

  const icone = divIcon({
    // Vazio de propósito: o padrão do Leaflet traz fundo e borda próprios, que
    // brigariam com a silhueta da caixa.
    className: "",
    html: ctoMarkerHtml(ctoMapStatusPresentation(marker.status), selecionado),
    iconSize: [CTO_MARKER_SIZE, CTO_MARKER_SIZE],
    // A âncora fica na BASE da caixa, e não no centro: um marcador que
    // representa um objeto físico aponta para onde ele está no chão.
    iconAnchor: [CTO_MARKER_SIZE / 2, CTO_MARKER_SIZE - 2],
    popupAnchor: [0, -CTO_MARKER_SIZE + 6],
  });

  cacheDeIcones.set(chave, icone);
  return icone;
}

/**
 * O destino do "Abrir CTO", carregando a vista de volta.
 *
 * ```text
 * returnTo   a ORIGEM, comparada contra allowlist do outro lado
 * lat lng z  onde o mapa estava
 * mode       qual base estava desenhada
 * q          o que estava digitado na busca
 * sel        esta caixa, para o mapa devolvê-la em destaque
 * ```
 *
 * `URLSearchParams` monta tudo — nada de concatenar string, que é onde a
 * codificação de um termo de busca com `&` quebraria o resto da URL.
 */
function hrefDoDetalhe(id: string, viewQuery: string): string {
  const params = new URLSearchParams(viewQuery);
  params.set("returnTo", OPERATIONAL_MAP_PATH);
  params.set("sel", id);
  return `/ctos/${id}?${params.toString()}`;
}

interface CtoMarkersProps {
  markers: CtoMapMarker[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** A vista atual, já serializada. Viaja na `href` de "Abrir CTO". */
  viewQuery: string;
  /**
   * O detalhe da CTO é de `ADMIN` (`/ctos/[id]` roda `requirePageProfile`).
   *
   * O `DISPATCHER` lê o mapa — decisão da `CTO-3.1` —, e oferecer a ele um
   * botão que o servidor redireciona seria pior que não oferecer: ele clicaria
   * e cairia no painel, sem explicação. Isto é **apresentação**; quem barra
   * continua sendo a página.
   */
  canOpenDetail: boolean;
}

export default function CtoMarkers({
  markers,
  selectedId,
  onSelect,
  viewQuery,
  canOpenDetail,
}: CtoMarkersProps) {
  return (
    <>
      {markers.map((marker) => {
        const apresentacao = ctoMapStatusPresentation(marker.status);
        return (
          <Marker
            key={marker.id}
            position={[marker.latitude, marker.longitude]}
            icon={iconePara(marker, marker.id === selectedId)}
            // `title` vira o atributo nativo no elemento focável do Leaflet: é
            // o que dá ao marcador um nome acessível sem depender da cor nem
            // de abrir o popup.
            title={`${marker.name} — ${apresentacao.label}`}
            alt={`${marker.name} — ${apresentacao.label}`}
            eventHandlers={{
              popupopen: () => onSelect(marker.id),
              popupclose: () => onSelect(null),
            }}
          >
            <Popup>
              <div
                className="min-w-[220px] max-w-[280px] p-3"
                data-testid="cto-map-popup"
                data-cto-id={marker.id}
              >
                <p className="text-sm font-semibold text-fg">{marker.name}</p>
                {marker.code ? (
                  <p className="mt-0.5 text-xs text-fg-muted">
                    Código {marker.code}
                  </p>
                ) : null}

                <p
                  className={`mt-2 inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${
                    {
                      success:
                        "border-success-border bg-success-bg text-success-fg",
                      warning:
                        "border-warning-border bg-warning-bg text-warning-fg",
                      danger: "border-danger-border bg-danger-bg text-danger-fg",
                      neutral:
                        "border-neutral-border bg-neutral-bg text-neutral-fg",
                    }[apresentacao.tone]
                  }`}
                  data-testid="cto-map-popup-status"
                >
                  <span aria-hidden="true">{apresentacao.glyph}</span>
                  {apresentacao.label}
                </p>

                {/*
                  Uma LISTA, e nunca uma barra ou uma rosca.

                  `livres + reservadas + danificadas + ocupadas` pode passar da
                  capacidade: uma porta danificada com cliente dentro conta nas
                  duas (`CTO-2.2`). Um gráfico de fatias afirmaria uma soma que
                  o domínio não garante, e a primeira caixa quebrada com cliente
                  faria o desenho mentir.
                */}
                <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                  <dt className="text-fg-muted">Capacidade</dt>
                  <dd className="text-right font-medium text-fg">
                    {marker.summary.capacity}
                  </dd>
                  <dt className="text-fg-muted">Livres</dt>
                  <dd
                    className="text-right font-medium text-fg"
                    data-testid="cto-map-popup-free"
                  >
                    {marker.summary.free}
                  </dd>
                  <dt className="text-fg-muted">Ocupadas</dt>
                  <dd className="text-right font-medium text-fg">
                    {marker.summary.occupied}
                  </dd>
                  <dt className="text-fg-muted">Reservadas</dt>
                  <dd className="text-right font-medium text-fg">
                    {marker.summary.reserved}
                  </dd>
                  <dt className="text-fg-muted">Danificadas</dt>
                  <dd className="text-right font-medium text-fg">
                    {marker.summary.damaged}
                  </dd>
                </dl>

                <p className="mt-2 text-[11px] leading-snug text-fg-muted">
                  {apresentacao.description}
                </p>

                {canOpenDetail ? (
                  <Link
                    href={hrefDoDetalhe(marker.id, viewQuery)}
                    className="mt-3 inline-flex w-full items-center justify-center rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-fg transition-colors hover:bg-primary-hover"
                    data-testid="cto-map-popup-open"
                  >
                    Abrir CTO
                  </Link>
                ) : null}
              </div>
            </Popup>
          </Marker>
        );
      })}
    </>
  );
}
