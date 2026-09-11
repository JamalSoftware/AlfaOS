"use client";

import Link from "next/link";
import { memo } from "react";
import { divIcon, type DivIcon } from "leaflet";
import { Marker, Popup } from "react-leaflet";
import type {
  CustomerMapMarker,
  ServiceOrderMapMarker,
} from "@/lib/operational-map";
import {
  connectivityAge,
  connectivityPresentation,
} from "@/lib/connectivity-presentation";
import { SERVICE_ORDER_STATUS_LABELS } from "@/lib/service-order-labels";
import { OPERATIONAL_MAP_PATH } from "@/lib/return-to";

/**
 * # Os marcadores de cliente e de OS
 *
 * ## Eles não competem com a CTO, e isso é decisão de hierarquia
 *
 * A caixa é o ativo de rede: ela tem silhueta, contorno de estado e plaqueta com
 * nome. Cliente e OS são **pontos** — pequenos, sem nome flutuante, sem
 * contorno grosso. Num bairro com uma caixa e oitenta assinantes, dar a cada
 * assinante o mesmo peso visual da caixa transformaria o mapa numa nuvem
 * uniforme onde a infraestrutura desaparece.
 *
 * ## Estado nunca é só cor
 *
 * `ONLINE`, `OFFLINE` e `UNKNOWN` carregam **glifo** além do tom, e o rótulo em
 * texto aparece no popup. Um mapa que distinguisse os três só por matiz seria
 * ilegível para quem tem daltonismo, sob sol, ou impresso.
 *
 * ## OS não substitui conectividade
 *
 * Um cliente offline **com** OS aberta precisa mostrar as duas coisas: o ponto
 * continua vermelho com o glifo de offline, e ganha um anel de OS por fora.
 * Trocar o estado por "tem OS" esconderia justamente a informação que explica a
 * OS existir.
 */

const cacheDeIcones = new Map<string, DivIcon>();

/**
 * O ponto do cliente.
 *
 * SVG próprio, sem dependência nova — o projeto já desenha o marcador da CTO
 * assim, e trazer uma biblioteca de ícones para um círculo com um glifo seria
 * superfície de terceiro em troca de nada.
 *
 * O nome do cliente **não** entra aqui: `divIcon` recebe HTML cru, e nome é
 * digitado por gente. Ele vive no popup, que o React escapa.
 */
function iconeDeCliente(
  status: CustomerMapMarker["connectivityStatus"],
  comOs: boolean,
): DivIcon {
  const chave = `cli:${status}:${comOs ? "1" : "0"}`;
  const guardado = cacheDeIcones.get(chave);
  if (guardado) return guardado;

  const apresentacao = connectivityPresentation(status);
  const classes = [
    "cto-dot",
    `cto-dot--${apresentacao.tone}`,
    comOs ? "cto-dot--with-order" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const icone = divIcon({
    className: "",
    html: [
      `<svg class="${classes}" viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" focusable="false">`,
      /*
        O anel de OS é DESENHADO POR FORA, e só quando há OS.

        Por fora porque o miolo é o estado de conectividade, e ele não pode
        ceder espaço: os dois sinais precisam ser lidos ao mesmo tempo.
      */
      comOs ? '<circle class="cto-dot__order" cx="10" cy="10" r="8.5" />' : "",
      '<circle class="cto-dot__body" cx="10" cy="10" r="5.5" />',
      `<text class="cto-dot__glyph" x="10" y="10" text-anchor="middle" dominant-baseline="central">${apresentacao.glyph}</text>`,
      "</svg>",
    ].join(""),
    iconSize: [18, 18],
    iconAnchor: [9, 9],
    popupAnchor: [0, -10],
  });

  cacheDeIcones.set(chave, icone);
  return icone;
}

/** O marcador da OS: losango, para não se confundir com o ponto do cliente. */
function iconeDeOs(): DivIcon {
  const guardado = cacheDeIcones.get("os");
  if (guardado) return guardado;

  const icone = divIcon({
    className: "",
    html: [
      '<svg class="cto-order" viewBox="0 0 22 22" width="20" height="20" aria-hidden="true" focusable="false">',
      // Losango: forma distinta do círculo do cliente e da caixa da CTO, então
      // os três se distinguem sem depender de cor.
      '<polygon class="cto-order__body" points="11,1.5 20.5,11 11,20.5 1.5,11" />',
      '<text class="cto-order__glyph" x="11" y="11" text-anchor="middle" dominant-baseline="central">OS</text>',
      "</svg>",
    ].join(""),
    iconSize: [20, 20],
    iconAnchor: [10, 10],
    popupAnchor: [0, -11],
  });

  cacheDeIcones.set("os", icone);
  return icone;
}

/**
 * A vista atual, para o link de volta.
 *
 * Lida da barra de endereço, e não recebida por prop: uma prop derivada da
 * câmera muda a cada micro-movimento e fecha a realimentação
 * `popup → autoPan → moveend → render` que custou o popup inteiro na
 * `CTO-3.2.1`. A camada já espelha a vista na URL, então ler dali devolve o
 * mesmo valor sem criar a dependência.
 */
function comVolta(destino: string): string {
  const params = new URLSearchParams(
    typeof window === "undefined" ? "" : window.location.search,
  );
  params.set("returnTo", OPERATIONAL_MAP_PATH);
  return `${destino}?${params.toString()}`;
}

function LinhaDeEstado({
  status,
  observedAt,
}: {
  status: CustomerMapMarker["connectivityStatus"];
  observedAt: string | null;
}) {
  const apresentacao = connectivityPresentation(status);
  const idade = connectivityAge(observedAt);
  return (
    <>
      <p
        className={`mt-2 inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${
          {
            success: "border-success-border bg-success-bg text-success-fg",
            danger: "border-danger-border bg-danger-bg text-danger-fg",
            neutral: "border-neutral-border bg-neutral-bg text-neutral-fg",
          }[apresentacao.tone]
        }`}
        data-testid="map-connectivity"
        data-status={status}
      >
        <span aria-hidden="true">{apresentacao.glyph}</span>
        {/* "Sem leitura" para UNKNOWN — nunca "Offline". */}
        {apresentacao.mapLabel}
      </p>
      {/*
        A IDADE da leitura, quando existe. Nenhum limiar de frescor é aplicado:
        o produto não tem política de `STALE`, e inventar um corte aqui seria
        uma regra que ninguém definiu para um provider cuja cadência ninguém
        mediu.
      */}
      {idade ? (
        <p className="mt-1 text-[11px] text-fg-muted" data-testid="map-observed-age">
          Leitura {idade}
        </p>
      ) : null}
    </>
  );
}

interface CustomerMarkersProps {
  markers: CustomerMapMarker[];
  canOpenCustomer: boolean;
}

function CustomerMarkersBase({ markers, canOpenCustomer }: CustomerMarkersProps) {
  return (
    <>
      {markers.map((cliente) => {
        const apresentacao = connectivityPresentation(
          cliente.connectivityStatus,
        );
        const comOs = cliente.openServiceOrderCount > 0;
        return (
          <Marker
            key={cliente.id}
            position={[cliente.latitude, cliente.longitude]}
            icon={iconeDeCliente(cliente.connectivityStatus, comOs)}
            // Nome acessível sem depender de cor nem de abrir o popup.
            title={`${cliente.name} — ${apresentacao.mapLabel}`}
            alt={`${cliente.name} — ${apresentacao.mapLabel}`}
          >
            <Popup>
              <div
                className="min-w-[220px] max-w-[280px] p-3"
                data-testid="customer-map-popup"
                data-customer-id={cliente.id}
              >
                <p className="text-sm font-semibold text-fg">{cliente.name}</p>
                {/*
                  CADASTRO e CONECTIVIDADE lado a lado, e nomeados.

                  "Ativo" responde se é cliente; "Offline" responde se o link
                  está no ar. A camada só traz cadastralmente ativos, então o
                  primeiro é constante aqui — e é escrito mesmo assim, porque é
                  a única forma de o operador não ler o vermelho como
                  "cancelado".
                */}
                <p className="mt-0.5 text-xs text-fg-muted">Cadastro: Ativo</p>

                <LinhaDeEstado
                  status={cliente.connectivityStatus}
                  observedAt={cliente.connectivityObservedAt}
                />

                <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                  <dt className="text-fg-muted">CTO</dt>
                  <dd className="text-right font-medium text-fg">
                    {cliente.cto ? cliente.cto.ctoName : "—"}
                  </dd>
                  <dt className="text-fg-muted">Porta</dt>
                  <dd className="text-right font-medium text-fg">
                    {cliente.cto ? cliente.cto.portNumber : "—"}
                  </dd>
                  <dt className="text-fg-muted">OS abertas</dt>
                  <dd
                    className="text-right font-medium text-fg"
                    data-testid="customer-map-open-os"
                  >
                    {cliente.openServiceOrderCount}
                  </dd>
                </dl>

                {canOpenCustomer ? (
                  <Link
                    href={comVolta(`/clientes/${cliente.id}/editar`)}
                    className="cto-map-action mt-3 inline-flex w-full items-center justify-center rounded-lg px-3 py-2 text-xs font-semibold transition-colors"
                    data-testid="customer-map-open"
                  >
                    Abrir cliente
                  </Link>
                ) : null}

                {cliente.cto ? (
                  <Link
                    href={comVolta(`/ctos/${cliente.cto.ctoId}`)}
                    className="cto-map-secondary mt-1.5 inline-flex w-full items-center justify-center rounded-lg px-3 py-1.5 text-xs font-medium transition-colors"
                    data-testid="customer-map-open-cto"
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

interface ServiceOrderMarkersProps {
  markers: ServiceOrderMapMarker[];
  canOpenCustomer: boolean;
}

function ServiceOrderMarkersBase({
  markers,
  canOpenCustomer,
}: ServiceOrderMarkersProps) {
  return (
    <>
      {markers.map((os) => (
        <Marker
          key={os.id}
          position={[os.latitude, os.longitude]}
          icon={iconeDeOs()}
          title={`OS Nº ${os.number} — ${SERVICE_ORDER_STATUS_LABELS[os.status]}`}
          alt={`OS Nº ${os.number} — ${SERVICE_ORDER_STATUS_LABELS[os.status]}`}
        >
          <Popup>
            <div
              className="min-w-[220px] max-w-[280px] p-3"
              data-testid="order-map-popup"
              data-order-id={os.id}
            >
              <p className="text-sm font-semibold text-fg">OS Nº {os.number}</p>
              <p className="mt-0.5 text-xs text-fg-muted">
                {SERVICE_ORDER_STATUS_LABELS[os.status]}
                {os.typeName ? ` · ${os.typeName}` : ""}
              </p>

              <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                <dt className="text-fg-muted">Cliente</dt>
                <dd className="text-right font-medium text-fg">
                  {os.customerName}
                </dd>
                <dt className="text-fg-muted">Aberta</dt>
                <dd className="text-right font-medium text-fg">
                  {/*
                    Calculado a partir do instante canônico. Nada de
                    `ageMinutes` persistido — estaria errado no segundo
                    seguinte.
                  */}
                  {connectivityAge(os.openedAt) ?? "—"}
                </dd>
                <dt className="text-fg-muted">Técnico</dt>
                <dd className="text-right font-medium text-fg">
                  {os.technicianName ?? "—"}
                </dd>
                {os.cto ? (
                  <>
                    <dt className="text-fg-muted">CTO</dt>
                    <dd className="text-right font-medium text-fg">
                      {os.cto.ctoName} · {os.cto.portNumber}
                    </dd>
                  </>
                ) : null}
              </dl>

              {/*
                A conectividade do CLIENTE, dentro do popup da OS.

                É a informação que mais muda o que o despachante faz a seguir:
                uma OS de um cliente offline é outra conversa que a mesma OS de
                um cliente online.
              */}
              <LinhaDeEstado
                status={os.connectivityStatus}
                observedAt={os.connectivityObservedAt}
              />

              <Link
                href={comVolta(`/ordens/${os.id}`)}
                className="cto-map-action mt-3 inline-flex w-full items-center justify-center rounded-lg px-3 py-2 text-xs font-semibold transition-colors"
                data-testid="order-map-open"
              >
                Abrir OS
              </Link>

              {canOpenCustomer ? (
                <Link
                  href={comVolta(`/clientes/${os.customerId}/editar`)}
                  className="cto-map-secondary mt-1.5 inline-flex w-full items-center justify-center rounded-lg px-3 py-1.5 text-xs font-medium transition-colors"
                  data-testid="order-map-open-customer"
                >
                  Abrir cliente
                </Link>
              ) : null}
            </div>
          </Popup>
        </Marker>
      ))}
    </>
  );
}

/**
 * `memo` pelo mesmo motivo dos marcadores de CTO: a camada re-renderiza a cada
 * `moveend` para espelhar a vista na URL, e sem isto cada um desses renders
 * recriaria o conteúdo de todos os popups.
 */
export const CustomerMarkers = memo(CustomerMarkersBase);
export const ServiceOrderMarkers = memo(ServiceOrderMarkersBase);
