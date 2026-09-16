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
import {
  MAP_POPUP_CLEARANCE_BOTTOM_RIGHT,
  MAP_POPUP_CLEARANCE_TOP_LEFT,
} from "./popup-clearance";

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

/**
 * # O cliente com OS URGENTE aberta fica em destaque — `CTO-3.2.2e`
 *
 * É um sinal ADICIONAL ao de conectividade, nunca um substituto: o miolo
 * continua dizendo online/offline/sem leitura, e a urgência entra por FORA —
 * anel vermelho no lugar do anel âmbar de OS, mais um `!` num selo no canto.
 * `OFFLINE` já é vermelho, então "mais vermelho" não distinguiria nada; quem
 * distingue é o anel a mais e o selo.
 *
 * A autoridade é a do domínio: `hasUrgentOpenServiceOrder` vem da MESMA
 * agregação que conta as OS abertas (`priority === URGENT`, e só ABERTA).
 * Nada aqui deduz urgência de cor, tipo ou tempo.
 *
 * Destaque ESTÁTICO. Sem `pulse`, sem `blink`: um mapa operacional chama
 * atenção sem cansar quem passa o turno olhando para ele.
 *
 * O `!` é texto constante do código, não dado de usuário — por isso pode
 * entrar no `divIcon`, que recebe HTML cru.
 */
function iconeDeCliente(
  status: CustomerMapMarker["connectivityStatus"],
  comOs: boolean,
  urgente: boolean,
): DivIcon {
  const chave = `cli:${status}:${comOs ? "1" : "0"}:${urgente ? "1" : "0"}`;
  const guardado = cacheDeIcones.get(chave);
  if (guardado) return guardado;

  const apresentacao = connectivityPresentation(status);
  const classes = [
    "cto-dot",
    `cto-dot--${apresentacao.tone}`,
    comOs ? "cto-dot--with-order" : "",
    urgente ? "cto-dot--urgente" : "",
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
      // `overflow="visible"`: o selo de urgência mora no canto, FORA do viewBox.
      `<svg class="${classes}" viewBox="0 0 18 18" width="${VISUAL_CLIENTE}" height="${VISUAL_CLIENTE}" overflow="visible" aria-hidden="true" focusable="false">`,
      /*
        O anel de OS fica POR FORA, fino e contínuo.

        Por fora porque o miolo é o estado do link e ele não cede espaço: os
        dois sinais precisam ser lidos ao mesmo tempo. Contínuo e não tracejado
        porque, num ponto deste tamanho, o tracejado vira serrilha e some.

        URGENTE tem precedência: anel vermelho no lugar do âmbar, e nunca os
        dois — dois anéis num ponto de 21px viram um alvo de tiro.
      */
      urgente
        ? '<circle class="cto-dot__order cto-dot__order--urgente" cx="9" cy="9" r="8" />'
        : comOs
          ? '<circle class="cto-dot__order" cx="9" cy="9" r="8" />'
          : "",
      /*
        FORMA, e não só cor.

        O dono pediu pontinhos verdes, vermelhos e cinzas — e cor sozinha não
        distingue para quem não a enxerga, que é regra do projeto desde a
        `CTO-3.2.1c`:

          ONLINE       disco cheio
          OFFLINE      disco com furo
          SEM LEITURA  disco claro com contorno tracejado escuro e centro

        SEM LEITURA ganhou corpo na `CTO-3.2.2e`. Antes era só o contorno
        tracejado, sem preenchimento, e sobre satélite e híbrido ele sumia:
        um traço fino de 1,75px numa imagem de telhado. Agora tem um HALO na
        cor da superfície (o mesmo recurso que dá contraste ao online e ao
        offline pelo traço deles), um preenchimento neutro claro, o contorno
        tracejado mais grosso e um centro — quatro sinais, e a forma continua
        sendo o que o distingue. O raio do halo (6,9) dá ao ponto a mesma área
        aparente do disco cheio com o traço dele (6 + 1,25 ⁄ 2).
      */
      status === "ONLINE"
        ? '<circle class="cto-dot__body" cx="9" cy="9" r="6" />'
        : status === "OFFLINE"
          ? '<circle class="cto-dot__body" cx="9" cy="9" r="6" /><circle class="cto-dot__hollow" cx="9" cy="9" r="2.2" />'
          : '<circle class="cto-dot__halo" cx="9" cy="9" r="6.9" /><circle class="cto-dot__body cto-dot__body--sem-leitura" cx="9" cy="9" r="5.4" /><circle class="cto-dot__core" cx="9" cy="9" r="1.7" />',
      /*
        O selo `!` de urgência, no canto superior direito, por fora do disco.

        Fora porque dentro ele disputaria com o furo do offline e com o centro
        do sem leitura. Tem halo na cor da superfície para ler sobre qualquer
        tile — e o selo do marcador é o MESMO desenho que a legenda mostra.
      */
      urgente
        ? '<circle class="cto-dot__bang-bg" cx="15.4" cy="2.6" r="3.6" /><text class="cto-dot__bang" x="15.4" y="2.9" text-anchor="middle" dominant-baseline="central">!</text>'
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

/**
 * A conectividade do cliente DENTRO do popup da OS — com o sujeito escrito.
 *
 * Difere da `LinhaDeEstado` do popup do cliente em duas coisas, e as duas são
 * deliberadas: o rótulo é `customerLabel` ("Cliente offline"), porque num popup
 * que fala de uma OS "Offline" sozinho não diz de quê; e a idade da leitura
 * fica na MESMA linha do selo, porque altura é o que este popup não tem.
 *
 * Não é `<p>`: ver o reset de parágrafo dos popups compactos em `globals.css`.
 */
function SeloDeConectividade({
  status,
  observedAt,
}: {
  status: CustomerMapMarker["connectivityStatus"];
  observedAt: string | null;
}) {
  const apresentacao = connectivityPresentation(status);
  const idade = connectivityAge(observedAt);
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
      <span
        className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-semibold ${
          {
            success: "border-success-border bg-success-bg text-success-fg",
            danger: "border-danger-border bg-danger-bg text-danger-fg",
            neutral: "border-neutral-border bg-neutral-bg text-neutral-fg",
          }[apresentacao.tone]
        }`}
        data-testid="map-connectivity"
        data-status={status}
      >
        {apresentacao.glyph && (
          <span aria-hidden="true">{apresentacao.glyph}</span>
        )}
        {apresentacao.customerLabel}
      </span>
      {idade ? (
        <span className="text-[11px] text-fg-muted" data-testid="map-observed-age">
          Leitura {idade}
        </span>
      ) : null}
    </div>
  );
}

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
        {apresentacao.glyph && (
          <span aria-hidden="true">{apresentacao.glyph}</span>
        )}
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
        const urgente = cliente.hasUrgentOpenServiceOrder;
        const primeiroNome = customerFirstName(cliente.name);
        // O rótulo acessível carrega a urgência por extenso: no desenho ela é
        // anel e selo, e para quem lê por leitor de tela nenhum dos dois existe.
        const rotulo = `${cliente.name} — ${apresentacao.mapLabel}${
          urgente ? ", com OS urgente" : ""
        }`;
        return (
          <Marker
            key={cliente.id}
            position={[cliente.latitude, cliente.longitude]}
            icon={iconeDeCliente(cliente.connectivityStatus, comOs, urgente)}
            // Nome acessível sem depender de cor nem de abrir o popup.
            title={rotulo}
            alt={rotulo}
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
                  {/*
                    O chip de urgência — `CTO-3.2.2e`, e só isto.

                    O popup do cliente foi aprovado pelo dono; a fase autorizou
                    UM chip, na linha que já existe, quando o cliente tem OS
                    urgente aberta. A mesma autoridade do marcador.
                  */}
                  {cliente.hasUrgentOpenServiceOrder ? (
                    <span
                      className="inline-flex items-center rounded-md border border-danger-border bg-danger-bg px-1.5 py-0.5 font-semibold text-danger-fg"
                      data-testid="customer-map-urgent"
                    >
                      OS urgente
                    </span>
                  ) : null}
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
              O empurrão do `autoPan` pousa o popup FORA dos controles do mapa
              — ver `popup-clearance.ts`, onde os respiros estão medidos. O que
              impede o empurrão de DESMONTAR o marcador não é isto: é o popup
              caber no mapa. Mais alto que o mapa, o `autoPan` mostra o topo
              dele e empurra o marcador para fora da vista; a releitura vem sem
              o marcador e o conteúdo some.
            */
            autoPanPaddingTopLeft={MAP_POPUP_CLEARANCE_TOP_LEFT}
            autoPanPaddingBottomRight={MAP_POPUP_CLEARANCE_BOTTOM_RIGHT}
          >
            <div
              /*
                COMPACTO, com as AÇÕES fora da rolagem — e agora usando a
                LARGURA.

                A `CTO-3.2.2d` trouxe o popup de 473px para 242, com cabeçalho
                fixo, miolo rolável e rodapé fixo. Medido depois: o cabeçalho
                tinha 104px para uns 40 de conteúdo (o `p { margin: 1.3em }` do
                Leaflet — ver `globals.css`), e a conectividade do cliente
                ficava FORA da área rolável, a 210px num miolo que terminava em
                187. Era isso que o dono via como "pouco evidente": ela não
                estava na tela.

                A `CTO-3.2.2e` reorganiza: o cliente ocupa a largura inteira e
                pode quebrar em duas linhas em vez de ser truncado numa coluna
                estreita; a conectividade vira selo com o SUJEITO ("Cliente
                offline"), logo abaixo dele; "Aberta" e "Técnico" dividem uma
                linha em duas colunas; e a caixa, quando existe, fecha o miolo.
                Nenhum bloco é `<p>`: o espaçamento é do contêiner.
              */
              className="cto-map-popup--compacto flex max-h-[280px] w-[300px] max-w-[calc(100vw-3rem)] flex-col p-3"
              data-testid="order-map-popup"
              data-order-id={os.id}
            >
              <div className="shrink-0 pr-5">
                <div className="flex items-start justify-between gap-2">
                  <div className="text-sm font-semibold leading-tight text-fg">
                    OS Nº {os.number}
                  </div>
                  {/*
                    A PRIORIDADE por extenso, e ela vem do domínio.

                    Sem `!` aqui: a regra do dono é que a exclamação mora SÓ no
                    símbolo do mapa. Neste selo a palavra "Urgente" carrega o
                    sinal, então a cor não está sozinha. O rótulo sai de
                    `SERVICE_ORDER_PRIORITY_LABELS`, a mesma tabela do despacho.
                  */}
                  <span
                    className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                      os.priority === "URGENT"
                        ? "border-danger-border bg-danger-bg text-danger-fg"
                        : "border-border-subtle bg-surface-muted text-fg-secondary"
                    }`}
                    data-testid="order-map-priority"
                  >
                    {SERVICE_ORDER_PRIORITY_LABELS[os.priority]}
                  </span>
                </div>
                <div className="mt-0.5 text-[11px] text-fg-muted">
                  {SERVICE_ORDER_STATUS_LABELS[os.status]}
                  {os.typeName ? ` · ${os.typeName}` : ""}
                </div>
              </div>

              <div className="mt-2 min-h-0 flex-1 overflow-y-auto">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-fg-muted">
                  Cliente
                </div>
                {/*
                  Duas linhas no máximo, na largura toda. Antes o nome vivia
                  numa coluna à direita de "Cliente" e era truncado num sinal de
                  reticências — "ROSELI JESUNO DE SOUZA TEIXEIRA" virava
                  "ROSELI JESUNO DE…". O nome completo é o que o popup existe
                  para mostrar.
                */}
                <div
                  className="line-clamp-2 break-words text-xs font-medium leading-snug text-fg"
                  data-testid="order-map-customer"
                >
                  {os.customerName}
                </div>

                {/*
                  A conectividade do CLIENTE, e com o sujeito escrito.

                  É a informação que mais muda o que o despachante faz a
                  seguir: uma OS de um cliente offline é outra conversa que a
                  mesma OS de um cliente online. Num popup que fala de uma OS,
                  "Offline" sozinho não diz de quê — "Cliente offline" diz.
                */}
                <SeloDeConectividade
                  status={os.connectivityStatus}
                  observedAt={os.connectivityObservedAt}
                />

                <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
                  <div className="min-w-0">
                    <dt className="text-[10px] font-semibold uppercase tracking-wide text-fg-muted">
                      Aberta
                    </dt>
                    <dd className="font-medium text-fg" data-testid="order-map-age">
                      {/*
                        Calculado a partir do instante canônico. Nada de
                        `ageMinutes` persistido — estaria errado no segundo
                        seguinte.
                      */}
                      {connectivityAge(os.openedAt) ?? "—"}
                    </dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-[10px] font-semibold uppercase tracking-wide text-fg-muted">
                      Técnico
                    </dt>
                    <dd
                      className="truncate font-medium text-fg"
                      title={os.technicianName ?? undefined}
                    >
                      {os.technicianName ?? "—"}
                    </dd>
                  </div>
                  {os.cto ? (
                    <div className="col-span-2 min-w-0">
                      {/*
                        O nome da caixa JÁ COMEÇA com "CTO": o rótulo é "Rede",
                        e não "CTO", para não sair "CTO CTO QA FIELD 01" — a
                        mesma duplicação que o dono apontou no popup do cliente.
                        "Porta" vai por extenso.
                      */}
                      <dt className="text-[10px] font-semibold uppercase tracking-wide text-fg-muted">
                        Rede
                      </dt>
                      <dd
                        className="truncate font-medium text-fg"
                        data-testid="order-map-cto"
                      >
                        {os.cto.ctoName} · Porta {os.cto.portNumber}
                      </dd>
                    </div>
                  ) : null}
                </dl>
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
