"use client";

import Link from "next/link";
import { divIcon } from "leaflet";
import { Marker, Popup } from "react-leaflet";
import type { CtoMapMarker } from "@/lib/cto-map";
import { ctoMapStatusPresentation } from "@/lib/cto-map-presentation";

/**
 * # Os marcadores da camada de CTO
 *
 * Renderiza **dentro** do canvas: `react-leaflet` entrega o mapa por contexto
 * de React, e um `Marker` fora da árvore do `MapContainer` não tem onde se
 * desenhar.
 *
 * ## O nome da caixa nunca entra em HTML de string
 *
 * O ícone é montado por `divIcon`, que recebe **HTML cru** e o injeta no DOM.
 * Por isso o `html` daqui é montado só a partir da tabela de apresentação —
 * quatro formas, quatro glifos, todos constantes escritas neste repositório.
 *
 * Nome e código da CTO são digitados por gente e vão **exclusivamente** para
 * dentro do `<Popup>`, que o React renderiza como texto e escapa. Uma caixa
 * chamada `<img src=x onerror=...>` aparece como esse texto, e não como uma
 * tag. Se algum dia alguém quiser o nome dentro do marcador, o caminho é um
 * `Tooltip` do react-leaflet — nunca concatenar no `html`.
 */

function iconePara(marker: CtoMapMarker, selecionado: boolean) {
  const apresentacao = ctoMapStatusPresentation(marker.status);
  const classes = [
    "cto-marker",
    `cto-marker--${apresentacao.shape}`,
    `cto-marker--${apresentacao.tone}`,
    selecionado ? "cto-marker--selected" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return divIcon({
    // Vazio de propósito: o padrão do Leaflet traz fundo e borda próprios, que
    // brigariam com a forma.
    className: "",
    html: `<span class="${classes}"><span>${apresentacao.glyph}</span></span>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    popupAnchor: [0, -16],
  });
}

interface CtoMarkersProps {
  markers: CtoMapMarker[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
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
                    href={`/ctos/${marker.id}`}
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
