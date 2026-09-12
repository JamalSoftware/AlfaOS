"use client";

import Link from "next/link";
import { memo } from "react";
import { divIcon, type DivIcon } from "leaflet";
import { Marker, Popup, Tooltip } from "react-leaflet";
import type { CtoMapMarker } from "@/lib/cto-map";
import { ctoMapStatusPresentation } from "@/lib/cto-map-presentation";
import { OPERATIONAL_MAP_PATH } from "@/lib/return-to";
import { CTO_MARKER_SIZE, ctoMarkerHtml } from "./cto-marker-icon";
import {
  MAP_POPUP_CLEARANCE_BOTTOM_RIGHT,
  MAP_POPUP_CLEARANCE_TOP_LEFT,
} from "./popup-clearance";

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
 * Os ícones são MEMORIZADOS.
 *
 * Sem cache, cada render criaria um `divIcon` por marcador e o react-leaflet
 * chamaria `setIcon` em todos eles, trocando o DOM de duzentos marcadores por
 * nada — inclusive o do marcador cujo popup está aberto.
 *
 * A chave é `(estado, selecionado)` porque é disso — e só disso — que o desenho
 * depende. Nome, código e posição não entram no ícone.
 */
const cacheDeIcones = new Map<string, DivIcon>();

function iconePara(
  marker: CtoMapMarker,
  selecionado: boolean,
  editando: boolean,
): DivIcon {
  const osAbertas = Math.min(marker.operational.openServiceOrderCount, 10);
  const chave = `${marker.status}:${selecionado ? "1" : "0"}:${
    editando ? "1" : "0"
  }:${osAbertas}`;
  const guardado = cacheDeIcones.get(chave);
  if (guardado) return guardado;

  const icone = divIcon({
    // Vazio de propósito: o padrão do Leaflet traz fundo e borda próprios, que
    // brigariam com a silhueta da caixa.
    className: "",
    html: ctoMarkerHtml(
      ctoMapStatusPresentation(marker.status),
      selecionado,
      editando,
      osAbertas,
    ),
    iconSize: [CTO_MARKER_SIZE, CTO_MARKER_SIZE],
    // A âncora fica na BASE da caixa, e não no centro: um marcador que
    // representa um objeto físico aponta para onde ele está no chão. É a ponta
    // da fibra que encosta no ponto — o poste.
    iconAnchor: [CTO_MARKER_SIZE / 2, CTO_MARKER_SIZE - 2],
    popupAnchor: [0, -CTO_MARKER_SIZE + 6],
    /*
      Onde a plaqueta encosta — CTO-3.2.1c.

      Sem este valor a plaqueta nasceria no PONTO do mapa, ou seja, em cima da
      base da caixa, cobrindo justamente o desenho que ela deveria identificar.
      Medido a partir da âncora, para que ela fique logo acima do topo do
      marcador: perto o bastante para a cauda encostar, longe o bastante para
      não tapar o selo de estado.
    */
    tooltipAnchor: [0, -CTO_MARKER_SIZE + 4],
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
function hrefDoDetalhe(id: string): string {
  /*
    A vista vem da BARRA DE ENDEREÇO, e não de uma prop.

    A primeira versão recebia a vista por prop, e o teste de navegador mostrou
    o preço: o popup deixava de abrir e o console enchia de "Maximum update
    depth exceeded". A prop mudava a cada micro-movimento da câmera, o popup
    re-renderizava, o `autoPan` do Leaflet movia o mapa para caber, isso emitia
    `moveend`, que mudava a prop de novo — uma realimentação fechada.

    A camada já espelha a vista na barra de endereço a cada mudança, então ler
    `window.location.search` aqui devolve o mesmo valor sem criar a dependência
    que fechava o laço.

    Limite declarado: se alguém abrir o popup e ARRASTAR o mapa sem fechá-lo, a
    `href` carrega a vista de antes do arrasto. A volta cai alguns metros ao
    lado, e fechar essa fresta custaria interceptar o clique — o que tiraria do
    link o "abrir em nova aba" que ele hoje tem de graça.
  */
  const params = new URLSearchParams(
    typeof window === "undefined" ? "" : window.location.search,
  );
  params.set("returnTo", OPERATIONAL_MAP_PATH);
  params.set("sel", id);
  return `/ctos/${id}?${params.toString()}`;
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
  /**
   * O zoom já permite mostrar o nome de TODAS as caixas visíveis?
   *
   * ## É um BOOLEANO, e não o zoom — essa escolha é o que fecha a
   * realimentação
   *
   * A `CTO-3.2.1` pagou caro por uma prop derivada da câmera chegando aqui: o
   * popup re-renderizava, o `autoPan` do Leaflet movia o mapa, o `moveend`
   * mudava a prop, e o console enchia de `Maximum update depth exceeded` até o
   * popup parar de abrir.
   *
   * Um número mudaria a cada micro-movimento e reabriria exatamente esse laço.
   * Um booleano só muda quando o operador **cruza** o limiar — o `memo` lá
   * embaixo bloqueia todos os outros renders, e arrastar o mapa a `z18` não
   * chega aqui.
   */
  showLabels: boolean;
  /** `ADMIN` corrige a posição da caixa pelo mapa (`CTO-3.2.1d`). */
  canEditPosition: boolean;
  /**
   * A caixa em modo de edição, ou `null`.
   *
   * **Só ela fica arrastável.** Marcador permanentemente arrastável é o defeito
   * que a fase existe para não cometer: um arrasto acidental viraria uma
   * correção de posição que ninguém pediu, e o mapa é justamente uma superfície
   * onde a mão está sempre arrastando alguma coisa.
   */
  editingId: string | null;
  /**
   * Onde a caixa em edição está AGORA, antes de salvar.
   *
   * Enquanto isto existe, o banco não sabe de nada. É o rascunho — e é a razão
   * de "arrastou" não significar "salvou".
   */
  draftPosition: { latitude: number; longitude: number } | null;
  onStartEdit: (id: string) => void;
  onDragEnd: (latitude: number, longitude: number) => void;
  /**
   * Quem vê a carteira nominal — `CTO-3.2.2`.
   *
   * O resumo operacional e a lista de clientes por porta são `ADMIN`. O
   * `DISPATCHER` continua lendo o mapa de caixas e de OS abertas, e é a mesma
   * decisão que a camada de clientes tomou: mostrar onde cada assinante mora e
   * quem ele é não foi estendido ao despacho por nenhuma decisão aprovada.
   */
  canSeeCustomers: boolean;
  onShowCustomers: (ctoId: string) => void;
}

/**
 * Uma contagem do popup: rótulo pequeno, número em destaque.
 *
 * Chip e não linha de lista — ver o comentário no popup: onze linhas
 * empilhadas faziam o popup ter 93% da altura do mapa, e era isso que
 * empurrava a vista a cada clique.
 *
 * O tom é OPCIONAL e só aparece onde a cor acrescenta leitura (online,
 * offline, OS aberta). O resto fica neutro: pintar tudo faria a cor perder o
 * significado que ela tem nos marcadores.
 */
function Contagem({
  rotulo,
  valor,
  tom,
  testId,
}: {
  rotulo: string;
  valor: number;
  tom?: "success" | "danger" | "warning";
  testId?: string;
}) {
  const cores = tom
    ? {
        success: "border-success-border bg-success-bg text-success-fg",
        danger: "border-danger-border bg-danger-bg text-danger-fg",
        warning: "border-warning-border bg-warning-bg text-warning-fg",
      }[tom]
    : "border-border-subtle bg-surface-muted text-fg";

  return (
    <span
      className={`inline-flex items-baseline gap-1 rounded-md border px-1.5 py-0.5 text-[11px] ${cores}`}
    >
      <span className="opacity-80">{rotulo}</span>
      <span className="font-semibold tabular-nums" data-testid={testId}>
        {valor}
      </span>
    </span>
  );
}


function CtoMarkers({
  markers,
  selectedId,
  onSelect,
  canOpenDetail,
  showLabels,
  canEditPosition,
  editingId,
  draftPosition,
  onStartEdit,
  onDragEnd,
  canSeeCustomers,
  onShowCustomers,
}: CtoMarkersProps) {
  return (
    <>
      {markers.map((marker) => {
        const apresentacao = ctoMapStatusPresentation(marker.status);
        const selecionado = marker.id === selectedId;
        /*
          A SELECIONADA sempre mostra o nome, em qualquer zoom.

          É esta cláusula que torna o limiar usável. Quem achou uma caixa na
          busca, ou voltou de uma CTO com `sel=` na URL, precisa saber qual das
          manchas do mapa é a dela — e num zoom afastado nenhuma outra plaqueta
          aparece para disputar espaço com essa.
        */
        const editando = marker.id === editingId;
        /*
          A plaqueta sobrevive à edição, em qualquer zoom.

          Entrar em modo de edição FECHA o popup, e fechar o popup limpa a
          seleção. Sem esta terceira cláusula, quem estivesse abaixo do limiar
          de zoom perderia o nome da caixa exatamente enquanto a arrasta — que é
          o único momento em que ele importa mais.
        */
        const comPlaqueta = showLabels || selecionado || editando;
        /*
          A inativa é a ÚNICA que escreve o estado na plaqueta.

          Derivado do `status` que o servidor mandou, e nunca de aparência: a
          tela conhece a tradução, não a precedência (`CTO-3.1`).
        */
        const inativa = marker.status === "INACTIVE";
        return (
          <Marker
            key={marker.id}
            /*
              O RASCUNHO manda enquanto a edição durar.

              O par gravado continua em `marker`, intocado, e é ele que volta
              quando alguém cancela — por isso Cancelar é confiável depois de
              quantos arrastos forem: não existe estado acumulado para desfazer,
              existe uma origem que nunca foi alterada.
            */
            position={
              editando && draftPosition
                ? [draftPosition.latitude, draftPosition.longitude]
                : [marker.latitude, marker.longitude]
            }
            /*
              Arrastável SÓ a caixa em edição, e só enquanto ela estiver.

              `draggable` é por marcador, então os demais continuam inertes ao
              arrasto mesmo com o modo ligado.
            */
            draggable={editando}
            icon={iconePara(marker, selecionado, editando)}
            // `title` vira o atributo nativo no elemento focável do Leaflet: é
            // o que dá ao marcador um nome acessível sem depender da cor nem
            // de abrir o popup.
            title={`${marker.name} — ${apresentacao.label}`}
            alt={`${marker.name} — ${apresentacao.label}`}
            eventHandlers={{
              popupopen: () => onSelect(marker.id),
              popupclose: () => onSelect(null),
              /*
                `dragend`, e NÃO `drag`.

                `drag` dispara por quadro. Como a posição do marcador é uma
                prop, atualizá-la a cada quadro re-renderizaria todos os
                marcadores dezenas de vezes por segundo — e é exatamente uma
                prop mudando durante interação com o mapa que fechou a
                realimentação `popup → autoPan → moveend → render` na
                `CTO-3.2.1`, com o popup parando de abrir.

                O rótulo NÃO precisa disto: o Leaflet move o tooltip junto com o
                marcador nativamente, então ele acompanha em tempo real de graça.
                O que espera o fim do arrasto é o painel de coordenadas, e ele é
                lido justamente quando a mão para.
              */
              dragend: (evento) => {
                const ponto = evento.target.getLatLng();
                onDragEnd(ponto.lat, ponto.lng);
              },
            }}
          >
            {/*
              A PLAQUETA com o nome da caixa.

              ## `permanent`, e a palavra é o contrato

              Um tooltip comum abre no `mouseover` e some — é dica passageira, e
              o dono pediu o oposto: o nome POR CIMA da caixa, sem clicar e sem
              apontar. Com `permanent` o Leaflet o abre junto com o marcador,
              mantém, e deixa de fechá-lo no `preclick` — clicar no mapa não
              apaga mais nada.

              ## O texto vem pelo REACT, e é isso que o mantém seguro

              O `divIcon` do marcador recebe HTML cru; este conteúdo não. O
              react-leaflet renderiza os filhos do tooltip por portal, então o
              nome digitado pelo operador é escapado como texto. Uma caixa
              batizada de `<img src=x onerror=…>` aparece com esse nome escrito.
              Injetar o mesmo texto no `divIcon` seria um elemento a menos no
              DOM e uma porta de HTML cru a mais.

              ## O `key` existe porque o Leaflet lê `className` UMA vez

              A classe é opção de construção do tooltip: trocá-la num tooltip já
              montado não muda nada. Trocar o `key` refaz o elemento — e isso
              acontece só quando a seleção muda, que é um gesto do operador, e
              nunca durante um arrasto.
            */}
            {comPlaqueta ? (
              <Tooltip
                key={`${selecionado ? "sel" : "std"}:${marker.status}`}
                permanent
                direction="top"
                className={`cto-map-label${
                  selecionado ? " cto-map-label--selected" : ""
                }${inativa ? " cto-map-label--inactive" : ""}`}
              >
                <span data-testid="cto-map-label" data-cto-id={marker.id}>
                  <span className="cto-map-label__name">{marker.name}</span>
                  {/*
                    A segunda linha existe SÓ para a inativa — CTO-3.2.1c.

                    Uma caixa apagada, sozinha, é indistinguível de um controle
                    que a interface desabilitou: "apagado" é vocabulário de
                    widget desligado, e aqui significa um fato da rede. O texto
                    é o que desfaz a ambiguidade.

                    O termo vem de `apresentacao.label`, a MESMA tabela que
                    nomeia o estado no popup e na legenda — em versalete pelo
                    `.toUpperCase()`, e não por uma segunda string escrita à
                    mão. O nome ARMAZENADO da CTO não é tocado: isto é
                    apresentação derivada do status.
                  */}
                  {inativa ? (
                    <span
                      className="cto-map-label__state"
                      data-testid="cto-map-label-state"
                    >
                      {apresentacao.label.toUpperCase()}
                    </span>
                  ) : null}
                </span>
              </Tooltip>
            ) : null}

            <Popup
              /*
                O `autoPan` VOLTOU na `CTO-3.2.2b`, e o que mudou foi o tamanho
                do popup: com 520px num mapa de 558 ele empurrava a vista 291px
                a cada clique, e era isso que o dono via como "o mapa se mexe
                sozinho". Desligar o `autoPan` foi TENTADO e medido — o popup
                passava a nascer 236px acima da borda, cortado. Um controle que
                esconde metade do próprio conteúdo é defeito pior que um
                deslocamento pequeno.

                Os respiros são os MESMOS do popup da OS (`popup-clearance.ts`):
                a `CTO-3.2.2d` deixou registrado que, perto da borda direita, o
                seletor Mapa/Satélite/Híbrido cobria o "×" deste popup, e perto
                da esquerda o zoom cobria o cabeçalho. Com 321px ele não cabia
                com 50 de topo no menor degrau do mapa; compactado (ver o
                comentário do reset de `p` em `globals.css`), cabe.

                O que matava o popup NÃO era o empurrão em si: era o recorte
                sem folga (`MAP_VIEWPORT_PADDING_RATIO`). Com a folga, o
                marcador clicado continua no resultado da releitura e o popup
                sobrevive — provado por sonda, 3,75s aberto atravessando a
                resposta.
              */
              autoPanPaddingTopLeft={MAP_POPUP_CLEARANCE_TOP_LEFT}
              autoPanPaddingBottomRight={MAP_POPUP_CLEARANCE_BOTTOM_RIGHT}
            >
              <div
                /*
                  COMPACTO — `CTO-3.2.2e`.

                  Medido antes: nome a 31px do topo, status 34px abaixo dele,
                  321px no total. Metade disso era o `p { margin: 1.3em }` do
                  Leaflet, e a outra metade era o status numa linha só dele.
                  Agora o nome e o selo de estado dividem a primeira linha, e
                  nenhum bloco aqui é `<p>` — o espaçamento é do contêiner.

                  `pr-5` na primeira linha: o "×" do Leaflet mora nos 24px do
                  canto superior direito do invólucro, por cima do conteúdo.
                */
                className="cto-map-popup--compacto w-[300px] max-w-[calc(100vw-3rem)] p-3"
                data-testid="cto-map-popup"
                data-cto-id={marker.id}
              >
                <div className="flex items-start justify-between gap-2 pr-5">
                  <div className="min-w-0">
                    <div className="break-words text-sm font-semibold leading-tight text-fg">
                      {marker.name}
                    </div>
                    {marker.code ? (
                      <div className="mt-0.5 text-[11px] text-fg-muted">
                        Código {marker.code}
                      </div>
                    ) : null}
                  </div>
                  <span
                    className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${
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
                  </span>
                </div>

                {/*
                  CONTAGENS EM CHIPS, e nunca duas listas empilhadas.

                  Medido na `CTO-3.2.2b`: com dois `<dl>` de 5 e 6 linhas, o
                  popup tinha 520px num mapa de 558 — 93% da altura. Os mesmos
                  onze números cabem em quatro linhas que quebram sozinhas.

                  Continua sendo LISTA, e nunca barra ou rosca:
                  `livres + reservadas + danificadas + ocupadas` pode passar da
                  capacidade, porque uma porta danificada com cliente dentro
                  conta nas duas (`CTO-2.2`). Um gráfico de fatias afirmaria uma
                  soma que o domínio não garante.
                */}
                <div className="mt-2 flex flex-wrap items-center gap-1">
                  <span className="mr-0.5 text-[10px] font-semibold uppercase tracking-wide text-fg-muted">
                    Portas
                  </span>
                  <Contagem rotulo="Capacidade" valor={marker.summary.capacity} />
                  <Contagem
                    rotulo="Livres"
                    valor={marker.summary.free}
                    testId="cto-map-popup-free"
                  />
                  <Contagem rotulo="Ocupadas" valor={marker.summary.occupied} />
                  <Contagem rotulo="Reservadas" valor={marker.summary.reserved} />
                  <Contagem rotulo="Danificadas" valor={marker.summary.damaged} />
                </div>

                {/*
                  O resumo OPERACIONAL, separado do de PORTAS.

                  Acima é infraestrutura; aqui é gente. São eixos independentes,
                  e a separação é o que impede alguém de somar "livres" com
                  "online". `activeCustomerCount` pode ser MENOR que ocupadas:
                  porta ocupada por cliente desativado continua ocupada.
                */}
                {canSeeCustomers ? (
                  <div data-testid="cto-map-operational">
                    <div className="mt-1.5 flex flex-wrap items-center gap-1">
                      <span className="mr-0.5 text-[10px] font-semibold uppercase tracking-wide text-fg-muted">
                        Clientes
                      </span>
                      <Contagem
                        rotulo="Ativos"
                        valor={marker.operational.activeCustomerCount}
                        testId="cto-map-active-customers"
                      />
                      <Contagem
                        rotulo="Online"
                        valor={marker.operational.onlineCount}
                        tom="success"
                      />
                      <Contagem
                        rotulo="Offline"
                        valor={marker.operational.offlineCount}
                        tom="danger"
                      />
                      {/* "Sem leitura", nunca "Offline" — são coisas diferentes. */}
                      <Contagem
                        rotulo="Sem leitura"
                        valor={marker.operational.unknownCount}
                      />
                      <Contagem
                        rotulo="OS abertas"
                        valor={marker.operational.openServiceOrderCount}
                        tom="warning"
                        testId="cto-map-open-orders"
                      />
                    </div>
                  </div>
                ) : null}

                {canOpenDetail ? (
                  <Link
                    href={hrefDoDetalhe(marker.id)}
                    /*
                      A cor vive no CSS, e nao numa utility.

                      O Leaflet pinta TODO <a> do mapa com o azul dele, e essa
                      regra vence a utility do Tailwind por especificidade — o
                      texto saia azul sobre azul. `cto-map-action` e a classe
                      que devolve a decisao ao design system; ver globals.css.
                    */
                    className="cto-map-action mt-2.5 inline-flex w-full items-center justify-center rounded-lg px-3 py-2 text-xs font-semibold transition-colors"
                    data-testid="cto-map-popup-open"
                  >
                    Abrir CTO
                  </Link>
                ) : null}

                {/*
                  As ações SECUNDÁRIAS, deliberadamente discretas.

                  O popup não vira painel de ações: "Abrir CTO" continua sendo o
                  caminho principal, cheio e com a cor do primário. Corrigir
                  coordenada é raro; abrir a ficha é o que se faz o tempo todo.
                  Quem barra continua sendo o servidor — `requireCtoAccess`
                  exige `ADMIN` e a capability antes de qualquer escrita.

                  A lista nominal NÃO vem no recorte — ela é buscada ao clicar.
                  Mandar os nomes dos clientes de cada caixa visível seria
                  espalhar nome de assinante por uma resposta cujo trabalho é
                  desenhar pontos.
                */}
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {canSeeCustomers &&
                  marker.operational.activeCustomerCount > 0 ? (
                    <button
                      type="button"
                      onClick={() => onShowCustomers(marker.id)}
                      className="cto-map-secondary inline-flex flex-1 basis-24 items-center justify-center rounded-lg px-2 py-1.5 text-xs font-medium transition-colors"
                      data-testid="cto-map-show-customers"
                    >
                      Ver clientes
                    </button>
                  ) : null}

                  {canEditPosition ? (
                    <button
                      type="button"
                      onClick={() => onStartEdit(marker.id)}
                      className="cto-map-secondary inline-flex flex-1 basis-24 items-center justify-center rounded-lg px-2 py-1.5 text-xs font-medium transition-colors"
                      data-testid="cto-map-popup-edit-position"
                    >
                      Ajustar posição
                    </button>
                  ) : null}
                </div>
              </div>
            </Popup>
          </Marker>
        );
      })}
    </>
  );
}

/**
 * `memo` NÃO é otimização aqui — é o que fecha o laço.
 *
 * A camada re-renderiza a cada `moveend`, porque ela guarda a câmera para
 * espelhar na URL. Sem , cada um desses renders recriava o conteúdo do
 * popup, o react-leaflet o atualizava, o  movia o mapa, e o 
 * seguinte recomeçava tudo. Com props idênticas o React para aqui, e o ciclo
 * não tem por onde continuar.
 */
export default memo(CtoMarkers);
