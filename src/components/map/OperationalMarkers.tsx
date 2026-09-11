"use client";

import Link from "next/link";
import { memo } from "react";
import { divIcon, type DivIcon } from "leaflet";
import { Marker, Popup, Tooltip } from "react-leaflet";
import type {
  CustomerMapMarker,
  ServiceOrderMapMarker,
} from "@/lib/operational-map";
import {
  connectivityAge,
  connectivityPresentation,
} from "@/lib/connectivity-presentation";
import {
  SERVICE_ORDER_PRIORITY_LABELS,
  SERVICE_ORDER_STATUS_LABELS,
} from "@/lib/service-order-labels";
import { customerInitials } from "@/lib/customer-initials";
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
 * O tamanho do CONTÊINER é a área de clique; o do desenho é o visual.
 *
 * São coisas separadas de propósito. O visual encolhe com o zoom (ver
 * `mapAssetScale`), e se a área de clique encolhesse junto, de longe o operador
 * teria de acertar um alvo de doze pixels. O contêiner não é escalado — só o
 * wrapper de dentro —, então o alvo continua com 30px em qualquer zoom.
 */
const HIT_BOX = 30;
const VISUAL_CLIENTE = 18;
const VISUAL_OS = 20;

function iconeDeCliente(
  status: CustomerMapMarker["connectivityStatus"],
  comOs: boolean,
  iniciais: string,
): DivIcon {
  const chave = `cli:${status}:${comOs ? "1" : "0"}:${iniciais}`;
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
      /*
        O wrapper de ESCALA, entre o contêiner do Leaflet e o desenho.

        O Leaflet escreve `translate3d(...)` no contêiner para posicionar o
        marcador. Aplicar `transform: scale(...)` ali sobrescreveria esse
        posicionamento e o ponto sairia do lugar no mapa. A escala mora numa
        camada de dentro, que o Leaflet não toca.
      */
      '<span class="cto-marker-hit"><span class="cto-marker-scale">',
      `<svg class="${classes}" viewBox="0 0 18 18" width="${VISUAL_CLIENTE}" height="${VISUAL_CLIENTE}" aria-hidden="true" focusable="false">`,
      /*
        O anel de OS fica POR FORA, fino e contínuo.

        Por fora porque o miolo é o estado do link e ele não cede espaço: os
        dois sinais precisam ser lidos ao mesmo tempo. Contínuo e não tracejado
        porque, num ponto deste tamanho, o tracejado vira serrilha e some.
      */
      comOs ? '<circle class="cto-dot__order" cx="9" cy="9" r="8" />' : "",
      /*
        FORMA, e não só cor.

        O dono pediu pontinhos verdes, vermelhos e cinzas — e cor sozinha não
        distingue para quem não a enxerga, que é regra do projeto desde a
        `CTO-3.2.1c`:

          ONLINE       disco cheio
          OFFLINE      disco com furo
          SEM LEITURA  contorno tracejado
      */
      status === "ONLINE"
        ? '<circle class="cto-dot__body" cx="9" cy="9" r="6" />'
        : status === "OFFLINE"
          ? '<circle class="cto-dot__body" cx="9" cy="9" r="6" /><circle class="cto-dot__hollow" cx="9" cy="9" r="2.2" />'
          : '<circle class="cto-dot__body cto-dot__body--sem-leitura" cx="9" cy="9" r="5.6" />',
      /*
        As INICIAIS, e é a garantia de saída do helper que as autoriza aqui.

        `divIcon` recebe HTML CRU, e a regra do projeto é que nome digitado por
        gente não entra nele. `customerInitials` devolve `[A-Z]{0,2}` — nenhum
        caractere com significado em HTML sobrevive à peneira dela, e há teste
        com entrada hostil provando isso. O nome completo continua só no popup.

        Elas somem no zoom distante por CSS (`map--rotulos`), sem recriar
        marcador.
      */
      iniciais
        ? `<text class="cto-dot__initials" x="9" y="9" text-anchor="middle" dominant-baseline="central">${iniciais}</text>`
        : "",
      "</svg>",
      "</span></span>",
    ].join(""),
    iconSize: [HIT_BOX, HIT_BOX],
    iconAnchor: [HIT_BOX / 2, HIT_BOX / 2],
    popupAnchor: [0, -VISUAL_CLIENTE / 2],
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

/** O rótulo acessível da OS: número, prioridade e situação, por extenso. */
function rotuloDaOs(os: ServiceOrderMapMarker): string {
  const prioridade = SERVICE_ORDER_PRIORITY_LABELS[os.priority];
  return `OS número ${os.number}, ${prioridade}, ${SERVICE_ORDER_STATUS_LABELS[os.status]}`;
}

/**
 * O marcador da OS: losango, com o NÚMERO ao lado e a urgência na cor.
 *
 * Losango porque as três famílias precisam se distinguir sem depender de cor —
 * círculo é cliente, caixa é CTO, losango é OS.
 *
 * ## Vermelho na OS não conflita com vermelho no cliente
 *
 * No cliente, vermelho é OFFLINE; na OS, é URGENTE. São formas diferentes, com
 * rótulos diferentes e entradas próprias na legenda, então a semântica não se
 * mistura. E a cor não está sozinha: a OS urgente ganha `!` antes do número.
 */
function iconeDeOs(urgente: boolean): DivIcon {
  const chave = `os:${urgente ? "urgente" : "normal"}`;
  const guardado = cacheDeIcones.get(chave);
  if (guardado) return guardado;

  const icone = divIcon({
    className: "",
    html: [
      // O wrapper de escala — ver `iconeDeCliente`.
      '<span class="cto-marker-hit"><span class="cto-marker-scale">',
      `<svg class="cto-order${urgente ? " cto-order--urgente" : ""}" viewBox="0 0 20 20" width="${VISUAL_OS}" height="${VISUAL_OS}" aria-hidden="true" focusable="false">`,
      '<polygon class="cto-order__body" points="10,1.5 18.5,10 10,18.5 1.5,10" />',
      /*
        O `!` é REFORÇO, e não decoração.

        A cor sozinha não pode carregar a urgência — mesma regra dos estados do
        cliente. Quem não distingue vermelho de laranja continua vendo o sinal.
      */
      urgente
        ? '<text class="cto-order__bang" x="10" y="10" text-anchor="middle" dominant-baseline="central">!</text>'
        : "",
      "</svg>",
      "</span></span>",
    ].join(""),
    iconSize: [HIT_BOX, HIT_BOX],
    iconAnchor: [HIT_BOX / 2, HIT_BOX / 2],
    popupAnchor: [0, -VISUAL_OS / 2],
  });

  cacheDeIcones.set(chave, icone);
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
            icon={iconeDeCliente(
              cliente.connectivityStatus,
              comOs,
              customerInitials(cliente.name),
            )}
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
                  {/*
                    O nome da caixa JÁ COMEÇA com "CTO", e o rótulo repetia.

                    Saía "CTO CTO QA FIELD 01 · 1" — o dono apontou. O valor
                    persistido não é mexido para consertar apresentação: quem
                    sai é o rótulo redundante, e "Porta" entra por extenso
                    porque o número sozinho não dizia o que era.
                  */}
                  <span
                    className="inline-flex items-center gap-1 rounded-md border border-border-subtle bg-surface-muted px-1.5 py-0.5"
                    data-testid="customer-map-cto"
                  >
                    <span className="font-semibold text-fg">
                      {cliente.cto
                        ? `${cliente.cto.ctoName} · Porta ${cliente.cto.portNumber}`
                        : "Sem caixa vinculada"}
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
          icon={iconeDeOs(os.priority === "URGENT")}
          zIndexOffset={OS_ACIMA_DO_CLIENTE}
          /*
            O rótulo acessível carrega a URGÊNCIA por extenso.

            No desenho ela é cor mais `!`; para quem navega por leitor de tela,
            nenhum dos dois existe. A palavra entra aqui, e sai da autoridade do
            domínio — `SERVICE_ORDER_PRIORITY_LABELS`, a mesma tabela do
            despacho.
          */
          title={rotuloDaOs(os)}
          alt={rotuloDaOs(os)}
        >
          {/*
            A plaqueta traz o NÚMERO, e só ele.

            "OS-N°48-URGENTE-INSTALAÇÃO" em cima do mapa vira parede de texto na
            primeira dezena de ordens. Tipo, status e prioridade por extenso
            ficam no popup, que é aberto por ação explícita. O `!` na frente é o
            reforço da urgência que a cor sozinha não pode carregar.

            Ela some no zoom distante por CSS (`map--rotulos`), sem recriar
            marcador — e é `Tooltip`, não `divIcon`, porque o React escapa o
            conteúdo dela.
          */}
          <Tooltip
            permanent
            direction="right"
            offset={[10, 0]}
            className="cto-map-label cto-map-label--os"
          >
            <span data-testid="order-map-label">
              {os.priority === "URGENT" ? "! " : ""}
              {`OS-N°${os.number}`}
            </span>
          </Tooltip>
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

              {/*
                A PRIORIDADE por extenso, e ela vem do domínio.

                No mapa a urgência é cor mais `!`, que é o suficiente para bater
                o olho; aqui ela é escrita, porque o popup é onde se decide o
                que fazer. O rótulo sai de `SERVICE_ORDER_PRIORITY_LABELS`, a
                mesma tabela que o despacho usa — nada aqui deduz urgência de
                tipo, status ou tempo em aberto.
              */}
              <p
                className={`mt-1.5 inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                  os.priority === "URGENT"
                    ? "border-danger-border bg-danger-bg text-danger-fg"
                    : "border-border-subtle bg-surface-muted text-fg-secondary"
                }`}
                data-testid="order-map-priority"
              >
                {os.priority === "URGENT" ? "! " : ""}
                Prioridade: {SERVICE_ORDER_PRIORITY_LABELS[os.priority]}
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
