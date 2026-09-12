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
import { customerFirstName } from "@/lib/customer-presentation";
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
/*
  Cliente 18 → 21 na `CTO-3.2.2d`, por pedido do dono; e a OS 20 → 23 JUNTO.

  O objetivo do dono é `CTO > OS > cliente`, com proporções próximas. Crescer só
  o cliente inverteria a segunda metade, e o número do lado do ícone esconde
  isso — o que pesa na tela é a área do DESENHO, medida no zoom neutro:

    cliente 21   disco de raio 7 (6 no viewBox de 18)      ≈ 154 px²
    OS      20   losango de diagonal 17 (no viewBox de 20) ≈ 144 px²   ← abaixo
    OS      23   losango de diagonal 19,6                  ≈ 191 px²

  Com a OS em 20 o cliente passaria a pesar mais que ela. Os dois cresceram na
  mesma medida (~15%), e a razão OS/cliente que o dono aprovou na `CTO-3.2.2c`
  (1,28 em área) ficou em 1,24. A caixa segue sendo a maior.
*/
const VISUAL_CLIENTE = 21;
const VISUAL_OS = 23;

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

/** Respiros do `autoPan` do popup da OS — ver o comentário no `<Popup>`. */
const OS_POPUP_RESPIRO_TOPO_ESQUERDA: [number, number] = [52, 50];
const OS_POPUP_RESPIRO_BASE_DIREITA: [number, number] = [24, 24];

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
        const primeiroNome = customerFirstName(cliente.name);
        return (
          <Marker
            key={cliente.id}
            position={[cliente.latitude, cliente.longitude]}
            icon={iconeDeCliente(cliente.connectivityStatus, comOs)}
            // Nome acessível sem depender de cor nem de abrir o popup.
            title={`${cliente.name} — ${apresentacao.mapLabel}`}
            alt={`${cliente.name} — ${apresentacao.mapLabel}`}
          >
            {/*
              O PRIMEIRO NOME, e ele vem por `Tooltip` — nunca pelo ícone.

              O ícone é `divIcon`, que recebe HTML CRU, e a regra do projeto
              desde a plaqueta da CTO é que nome digitado por gente não entra
              ali. A fase anterior usava INICIAIS, e podia: `[A-Z]{0,2}` não tem
              caractere com significado em HTML. Um primeiro nome não tem essa
              garantia — pode conter `<`, `&`, aspas —, então ele passa pelo
              `Tooltip`, cujo conteúdo o React escapa.

              Só o primeiro nome: o completo vive no popup, aberto por ação
              explícita.

              ## À ESQUERDA do ponto, e não à direita

              A OS usa a coordenada do cliente, e o número dela vai à direita
              do losango. Com o nome também à direita, os dois rótulos nasciam
              um em cima do outro — medido: `Camada` em (785, 418) e
              `OS-N°8800` em (786, 418), a um pixel. Cada família tem a sua
              direção, e no mesmo ponto elas não se cruzam: caixa ACIMA, OS à
              DIREITA, cliente à ESQUERDA — e a linha lê `Maria ◆ OS-N°7`.

              ABAIXO foi considerado e descartado pela conta: o nome desceria
              38px, e a plaqueta da caixa sobe 59px acima dela, então um cliente
              a 80m ao norte de uma caixa cruzaria a plaqueta dela.
            */}
            {primeiroNome ? (
              <Tooltip
                permanent
                direction="left"
                offset={[-11, 0]}
                className="cto-map-label cto-map-label--cliente"
              >
                <span data-testid="customer-map-label">{primeiroNome}</span>
              </Tooltip>
            ) : null}

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
            offset={[12, 0]}
            className="cto-map-label cto-map-label--os"
          >
            {/*
              O `!` mora no SÍMBOLO, e não aqui.

              Ele aparecia nos dois — desenho e texto — e o dono apontou a
              duplicação. O reforço que a cor não pode dispensar continua
              existindo, uma vez só, dentro do losango. O rótulo é o número, e
              nada mais: prioridade por extenso é assunto do popup.
            */}
            <span data-testid="order-map-label">{`OS-N°${os.number}`}</span>
          </Tooltip>
          <Popup
            /*
              O empurrão do `autoPan` pousa o popup FORA dos controles do mapa.

              Com 24px de respiro em todos os lados, o popup — 242px num mapa
              de 398 — quase sempre terminava com o topo a 24px da borda de
              cima, e os dois cantos de cima têm controle: medido, o zoom ocupa
              (10–44, 10–74) e o seletor Mapa/Satélite/Híbrido (776–962, 12–42).
              Perto da borda direita o seletor cobria o "×"; perto da esquerda,
              o zoom cobria o cabeçalho.

              Cada respiro limpa UM controle, e juntos limpam os dois em
              qualquer posição: topo ≥ 50 passa por baixo do seletor (termina
              em 42), e esquerda ≥ 52 passa ao lado do zoom (termina em 44). Um
              respiro de cima de 82 limparia os dois sozinho, e não caberia no
              mapa de 320px da tela estreita.

              O que impede o empurrão de DESMONTAR o marcador não é isto — é o
              popup caber no mapa. Mais alto que o mapa, o `autoPan` mostra o
              topo dele e empurra o marcador para fora da vista; a releitura
              vem sem o marcador e o conteúdo some.
            */
            autoPanPaddingTopLeft={OS_POPUP_RESPIRO_TOPO_ESQUERDA}
            autoPanPaddingBottomRight={OS_POPUP_RESPIRO_BASE_DIREITA}
          >
            <div
              /*
                COMPACTO e com as AÇÕES fora da rolagem.

                Medido antes da correção: o popup tinha 222×473px num mapa de
                398px — 119% da altura — e nascia 355px acima da borda de cima.
                Um popup mais alto que o mapa força o `autoPan` a empurrar o
                marcador para fora da vista; a releitura então vinha sem ele, o
                marcador era desmontado e o conteúdo do popup sumia junto,
                deixando só a casca com o "×". Era o "Abrir OS" que o dono via
                fora da área útil — e, às vezes, simplesmente não existia.

                A estrutura é cabeçalho fixo, conteúdo com rolagem própria e
                rodapé fixo com as ações. O teto de altura garante que o popup
                caiba no menor degrau do mapa; se um nome longo fizer o conteúdo
                crescer, quem rola é o meio — "Abrir OS" continua à vista.
              */
              className="flex max-h-[240px] w-[300px] max-w-[calc(100vw-3rem)] flex-col p-3"
              data-testid="order-map-popup"
              data-order-id={os.id}
            >
              <div className="shrink-0">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm font-semibold text-fg">OS Nº {os.number}</p>
                  {/*
                    A PRIORIDADE por extenso, e ela vem do domínio.

                    Sem `!` aqui: a regra do dono é que a exclamação mora SÓ no
                    símbolo do mapa. Neste selo a palavra "Urgente" carrega o
                    sinal, então a cor não está sozinha. O rótulo sai de
                    `SERVICE_ORDER_PRIORITY_LABELS`, a mesma tabela do despacho.
                  */}
                  <p
                    className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                      os.priority === "URGENT"
                        ? "border-danger-border bg-danger-bg text-danger-fg"
                        : "border-border-subtle bg-surface-muted text-fg-secondary"
                    }`}
                    data-testid="order-map-priority"
                  >
                    {SERVICE_ORDER_PRIORITY_LABELS[os.priority]}
                  </p>
                </div>
                <p className="mt-0.5 text-xs text-fg-muted">
                  {SERVICE_ORDER_STATUS_LABELS[os.status]}
                  {os.typeName ? ` · ${os.typeName}` : ""}
                </p>
              </div>

              <div className="mt-2 min-h-0 flex-1 overflow-y-auto">
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
                  <dt className="text-fg-muted">Cliente</dt>
                  <dd className="truncate text-right font-medium text-fg">
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
                  <dd className="truncate text-right font-medium text-fg">
                    {os.technicianName ?? "—"}
                  </dd>
                  {os.cto ? (
                    <>
                      {/*
                        O nome da caixa JÁ COMEÇA com "CTO": o rótulo à esquerda
                        é "Rede", e não "CTO", para não sair "CTO CTO QA FIELD 01"
                        — a mesma duplicação que o dono apontou no popup do
                        cliente. "Porta" vai por extenso.
                      */}
                      <dt className="text-fg-muted">Rede</dt>
                      <dd
                        className="truncate text-right font-medium text-fg"
                        data-testid="order-map-cto"
                      >
                        {os.cto.ctoName} · Porta {os.cto.portNumber}
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
              </div>

              {/*
                As AÇÕES, fora da rolagem, numa linha só.

                "Abrir OS" é a principal e vem primeiro, cheia; "Abrir cliente" é
                a secundária. Lado a lado economizam a altura que empilhadas
                custavam — e altura era exatamente o defeito.
              */}
              <div className="mt-2.5 flex shrink-0 flex-wrap gap-1.5">
                <Link
                  href={comVolta(`/ordens/${os.id}`)}
                  className="cto-map-action inline-flex flex-1 basis-24 items-center justify-center rounded-lg px-3 py-2 text-xs font-semibold transition-colors"
                  data-testid="order-map-open"
                >
                  Abrir OS
                </Link>

                {canOpenCustomer ? (
                  <Link
                    href={comVolta(`/clientes/${os.customerId}/editar`)}
                    className="cto-map-secondary inline-flex flex-1 basis-24 items-center justify-center rounded-lg px-3 py-2 text-xs font-medium transition-colors"
                    data-testid="order-map-open-customer"
                  >
                    Abrir cliente
                  </Link>
                ) : null}
              </div>
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
