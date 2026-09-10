"use client";

import Link from "next/link";
import { memo } from "react";
import { divIcon, type DivIcon } from "leaflet";
import { Marker, Popup, Tooltip } from "react-leaflet";
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
  const chave = `${marker.status}:${selecionado ? "1" : "0"}:${
    editando ? "1" : "0"
  }`;
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
                    href={hrefDoDetalhe(marker.id)}
                    /*
                      A cor vive no CSS, e nao numa utility.

                      O Leaflet pinta TODO <a> do mapa com o azul dele, e essa
                      regra vence a utility do Tailwind por especificidade — o
                      texto saia azul sobre azul. `cto-map-action` e a classe
                      que devolve a decisao ao design system; ver globals.css.
                    */
                    className="cto-map-action mt-3 inline-flex w-full items-center justify-center rounded-lg px-3 py-2 text-xs font-semibold transition-colors"
                    data-testid="cto-map-popup-open"
                  >
                    Abrir CTO
                  </Link>
                ) : null}

                {/*
                  A ação SECUNDÁRIA, e ela é deliberadamente discreta.

                  O popup não vira painel de ações: "Abrir CTO" continua sendo o
                  caminho principal, cheio e com a cor do primário, e "Ajustar
                  posição" é um botão de texto abaixo dele. Corrigir coordenada é
                  raro; abrir a ficha é o que se faz o tempo todo.

                  Quem barra continua sendo o servidor — `requireCtoAccess`
                  exige `ADMIN` e a capability antes de qualquer escrita. Esconder
                  o botão é apresentação, e nada mais.
                */}
                {canEditPosition ? (
                  <button
                    type="button"
                    onClick={() => onStartEdit(marker.id)}
                    className="cto-map-secondary mt-1.5 inline-flex w-full items-center justify-center rounded-lg px-3 py-1.5 text-xs font-medium transition-colors"
                    data-testid="cto-map-popup-edit-position"
                  >
                    Ajustar posição
                  </button>
                ) : null}
              </div>
            </Popup>
          </Marker>
        );
      })}
    </>
  );
}

/**
 *  NÃO é otimização aqui — é o que fecha o laço.
 *
 * A camada re-renderiza a cada , porque ela guarda a câmera para
 * espelhar na URL. Sem , cada um desses renders recriava o conteúdo do
 * popup, o react-leaflet o atualizava, o  movia o mapa, e o 
 * seguinte recomeçava tudo. Com props idênticas o React para aqui, e o ciclo
 * não tem por onde continuar.
 */
export default memo(CtoMarkers);
