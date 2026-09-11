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
      `<svg class="${classes}" viewBox="0 0 18 18" width="16" height="16" aria-hidden="true" focusable="false">`,
      /*
        O anel de OS fica POR FORA, fino e contínuo.

        Por fora porque o miolo é o estado do link e ele não cede espaço: os
        dois sinais precisam ser lidos ao mesmo tempo. Contínuo e não tracejado
        porque, num ponto de 16px, o tracejado vira serrilha e some.
      */
      comOs ? '<circle class="cto-dot__order" cx="9" cy="9" r="7" />' : "",
      /*
        FORMA, e não só cor.

        O dono pediu pontinhos verdes, vermelhos e cinzas — e cor sozinha não
        distingue para quem não a enxerga, que é regra do projeto desde a
        `CTO-3.2.1c`. Um glifo de 7px seria ilegível neste tamanho, então quem
        carrega a diferença é o DESENHO do miolo:

          ONLINE       disco cheio          — ligado
          OFFLINE      disco com furo       — apagado por dentro
          SEM LEITURA  contorno tracejado   — não sabemos

        As três se distinguem em escala de cinza, e o popup e a legenda dizem
        em palavras.
      */
      status === "ONLINE"
        ? '<circle class="cto-dot__body" cx="9" cy="9" r="4.5" />'
        : status === "OFFLINE"
          ? '<circle class="cto-dot__body" cx="9" cy="9" r="4.5" /><circle class="cto-dot__hollow" cx="9" cy="9" r="1.7" />'
          : '<circle class="cto-dot__body cto-dot__body--sem-leitura" cx="9" cy="9" r="4.2" />',
      "</svg>",
    ].join(""),
    iconSize: [16, 16],
    iconAnchor: [8, 8],
    popupAnchor: [0, -9],
  });

  cacheDeIcones.set(chave, icone);
  return icone;
}

/**
 * # A OS fica ACIMA do ponto do cliente, e isso precisa ser DECIDIDO
 *
 * O marcador da OS usa a coordenada do CLIENTE — é a única que existe. Então
 * todo cliente com OS aberta tem o losango exatamente sobre o ponto, e não
 * "quase": mesma latitude, mesma longitude, mesmo pixel.
 *
 * Sem `zIndexOffset` os dois recebem o **mesmo** z, porque o Leaflet o deriva
 * da latitude. Medido no navegador: `239` nos dois. O desempate cai para a
 * ordem no DOM, que é a ordem em que as duas respostas HTTP chegaram — e um
 * mapa em que o popup aberto depende de uma corrida de rede não é um mapa, é
 * um sorteio.
 *
 * ## Por que a OS vence
 *
 * O popup dela já carrega nome do cliente, conectividade com idade, CTO e
 * porta, e ainda oferece **Abrir cliente**. O popup do cliente, no mesmo
 * ponto, não teria como levar à OS. Deixar o cliente por cima esconderia o
 * objeto mais rico atrás do mais pobre.
 *
 * Para ver o cliente sozinho, o operador **desliga a camada de OS** — e aí o
 * ponto fica clicável, com a contagem de OS abertas no popup.
 *
 * `1000` é maior que qualquer diferença de latitude em pixels dentro de um
 * recorte, então a regra vale para a CAMADA inteira, e não só para o
 * desempate do mesmo ponto.
 */
const OS_ACIMA_DO_CLIENTE = 1000;

/** O marcador da OS: losango, para não se confundir com o ponto do cliente. */
function iconeDeOs(): DivIcon {
  const guardado = cacheDeIcones.get("os");
  if (guardado) return guardado;

  const icone = divIcon({
    className: "",
    html: [
      '<svg class="cto-order" viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">',
      /*
        Losango pequeno e limpo, SEM texto dentro.

        A sigla "OS" ficava com 7px e não se lia em tamanho nenhum — ocupava o
        miolo e obrigava o marcador a ser grande para caber. A forma já
        distingue: círculo é cliente, caixa é CTO, losango é OS.

        E o tamanho é decisão de hierarquia: a OS é visível, mas não disputa
        protagonismo com a caixa (20×27). Quem manda no mapa é a
        infraestrutura; a OS é o trabalho aberto em cima dela.
      */
      '<polygon class="cto-order__body" points="8,1.5 14.5,8 8,14.5 1.5,8" />',
      "</svg>",
    ].join(""),
    iconSize: [15, 15],
    iconAnchor: [7.5, 7.5],
    popupAnchor: [0, -8],
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
                <p className="text-sm font-semibold leading-snug text-fg">
                  {cliente.name}
                </p>

                {/*
                  CADASTRO e CONECTIVIDADE lado a lado, e nomeados.

                  "Ativo" responde se é cliente; "Offline" responde se o link
                  está no ar. A camada só traz cadastralmente ativos, então o
                  primeiro é constante aqui — e é escrito mesmo assim, porque é
                  a única forma de o operador não ler o vermelho como
                  "cancelado".

                  Ele virou SELO em vez de linha cinza: como texto solto do
                  mesmo tamanho do resto, ficava indistinguível do endereço e da
                  contagem, e a distinção que ele existe para fazer se perdia.
                */}
                <p className="mt-1.5 inline-flex items-center rounded-full border border-border-subtle bg-surface-muted px-2 py-0.5 text-[11px] font-medium text-fg-secondary">
                  Cadastro: Ativo
                </p>

                <LinhaDeEstado
                  status={cliente.connectivityStatus}
                  observedAt={cliente.connectivityObservedAt}
                />

                {/*
                  ONDE ele está e QUANTO trabalho tem aberto, em uma linha.

                  Três linhas de lista para três valores curtos empurravam as
                  ações para baixo sem acrescentar leitura. CTO e porta andam
                  juntas — são um endereço só —, e a contagem de OS ganha tom
                  próprio quando há trabalho aberto, porque é ela que muda o que
                  o despachante faz a seguir.
                */}
                <div className="mt-2.5 flex flex-wrap items-center gap-1.5 text-[11px]">
                  <span className="inline-flex items-center gap-1 rounded-md border border-border-subtle bg-surface-muted px-1.5 py-0.5">
                    <span className="opacity-80">CTO</span>
                    <span className="font-semibold text-fg">
                      {cliente.cto
                        ? `${cliente.cto.ctoName} · ${cliente.cto.portNumber}`
                        : "—"}
                    </span>
                  </span>
                  <span
                    className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 ${
                      cliente.openServiceOrderCount > 0
                        ? "border-warning-border bg-warning-bg text-warning-fg"
                        : "border-border-subtle bg-surface-muted text-fg"
                    }`}
                  >
                    <span className="opacity-80">OS abertas</span>
                    <span
                      className="font-semibold tabular-nums"
                      data-testid="customer-map-open-os"
                    >
                      {cliente.openServiceOrderCount}
                    </span>
                  </span>
                </div>

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
          zIndexOffset={OS_ACIMA_DO_CLIENTE}
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
