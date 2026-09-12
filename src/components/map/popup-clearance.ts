/**
 * # Onde o `autoPan` pode pousar um popup — os respiros medidos
 *
 * Os controles do mapa ficam ACIMA dos painéis do Leaflet. Um popup que o
 * `autoPan` deixa embaixo de um deles perde o cabeçalho ou o "×", e o clique
 * cai no controle. Medido em coordenadas do mapa: o zoom ocupa (10–44, 10–74),
 * o seletor Mapa/Satélite/Híbrido termina em y=42 no canto direito, e a
 * atribuição ocupa os 22px de baixo à direita.
 *
 * Cada respiro limpa UM controle, e juntos limpam todos em qualquer posição:
 * topo ≥ 50 passa por baixo do seletor; esquerda ≥ 52 passa ao lado do zoom;
 * 24 embaixo e à direita passam por cima da atribuição. Um respiro de cima de
 * 82 limparia zoom e seletor sozinho, e não caberia no menor degrau do mapa.
 *
 * A `CTO-3.2.2d` mediu isto para o popup da OS e a `CTO-3.2.2e` estendeu ao da
 * CTO — depois de compactá-lo, porque com 321px ele não cabia com este topo
 * num mapa de 340. Os dois popups leem a MESMA constante: a geometria dos
 * controles é do mapa, não de uma camada.
 *
 * O que impede o empurrão de DESMONTAR o marcador não é isto — é o popup
 * caber no mapa (`MAP_VIEWPORT_PADDING_RATIO` cuida do recorte). Mais alto
 * que o mapa, o `autoPan` mostra o topo dele e empurra o marcador para fora
 * da vista.
 */
export const MAP_POPUP_CLEARANCE_TOP_LEFT: [number, number] = [52, 50];
export const MAP_POPUP_CLEARANCE_BOTTOM_RIGHT: [number, number] = [24, 24];
