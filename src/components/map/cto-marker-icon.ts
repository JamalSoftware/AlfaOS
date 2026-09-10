import type { CtoMapStatusPresentation } from "@/lib/cto-map-presentation";

/**
 * # O marcador de CTO — uma caixa óptica de poste
 *
 * O alfinete genérico diz *"tem alguma coisa aqui"*. Num mapa que vai receber
 * cliente, OS e futuramente técnico, isso é exatamente a informação que não
 * serve: quatro camadas de alfinete são quatro camadas indistinguíveis. A
 * silhueta da caixa é o que deixa a CTO reconhecível de relance, antes de
 * qualquer cor.
 *
 * ## O que mudou na `CTO-3.2.1c`, e por quê
 *
 * A versão anterior já tinha corpo, tampa, régua de portas e prensa-cabo — e o
 * dono ainda a recusou. O diagnóstico não é "faltava detalhe": é que a
 * **proporção** estava errada. O corpo media 29 × 21, ou seja **deitado**, e
 * caixa deitada com uma faixa dentro lê como aparelho de mesa. Uma caixa de
 * terminação de poste é **em pé**.
 *
 * ```text
 *          ╭─────╮      ◀ cúpula quase semicircular — a assinatura do perfil
 *         │       │
 *         │───█───│     ◀ costura da tampa, com o fecho montado sobre ela
 *         │ ┌───┐ │
 *         │ │▌▌▌▌│ │    ◀ bandeja com a régua de adaptadores
 *         │ └───┘ │
 *         ╰───────╯
 *          ▬▬▬▬▬▬▬      ◀ placa de prensa-cabos
 *             │ ╰╮      ◀ tronco reto até o poste, drop saindo em curva
 * ```
 *
 * Quatro mudanças, e cada uma responde a uma frase do dono:
 *
 * | pedido | resposta |
 * |---|---|
 * | "corpo principal mais convincente" | proporção **em pé**, 20 × 27 |
 * | "silhueta menos genérica" | cúpula de raio 8,5 num corpo de largura 20 |
 * | "frente/tampa melhor resolvida" | costura com o **fecho** montado sobre ela |
 * | "entrada/saída de cabo" | placa de prensa-cabos, tronco **reto** e drop em **curva** |
 *
 * ## Duas tentativas foram DESCARTADAS nesta mesma fase, e o motivo fica
 *
 * A primeira pôs **orelhas** de fixação nas laterais, na esperança de quebrar a
 * silhueta genérica. Vistas a 5×, elas leem como **pés** — e, pior, somam
 * largura justamente onde a fase estava tentando estreitar: o conjunto voltava
 * a ficar mais largo que alto, anulando a única mudança que importava.
 *
 * A segunda pôs **dois prensa-cabos** separados sob a caixa. Dois blocos
 * pequenos embaixo leem como pés pelo mesmo motivo. Viraram uma placa só.
 *
 * O que ficou no lugar das duas é a **curva da drop**. Ela muda o contorno de
 * verdade, e muda para algo que só existe em telecomunicações: fibra sai
 * fazendo raio, nunca em ângulo reto.
 *
 * ## A geometria é DADO, e não string
 *
 * `CTO_MARKER_GEOMETRY` existe para que o desenho e o teste leiam o mesmo
 * número. Antes o teste extraía coordenadas do SVG com expressão regular, e um
 * desenho reescrito quebrava a asserção sem que nada estivesse errado — ou,
 * pior, continuava passando por casar com outro trecho. Com a geometria
 * exportada, a pergunta *"a bandeja está dentro do corpo?"* vira aritmética.
 *
 * ## SVG escrito à mão, e nenhuma dependência
 *
 * Não há biblioteca de ícone no projeto, e trazer uma para desenhar uma caixa
 * com uma régua seria superfície de terceiro em troca de nada.
 *
 * ## O nome da caixa NUNCA entra aqui
 *
 * `divIcon` recebe **HTML cru** e o injeta no DOM. Tudo o que este módulo monta
 * vem da tabela de apresentação — quatro formas, quatro glifos, todos
 * constantes deste repositório.
 *
 * A plaqueta com o nome da caixa, que a `CTO-3.2.1c` acrescentou, **não é
 * desenhada aqui**: ela é um `Tooltip` do react-leaflet, cujo conteúdo o React
 * renderiza por portal e escapa como texto. Uma caixa batizada de
 * `<img src=x onerror=…>` aparece com esse nome escrito, e não executa nada.
 * Era tentador injetar o texto no `divIcon` — um elemento a menos — e seria
 * abrir uma porta de HTML cru para dado digitado por gente.
 *
 * ## Cor é a QUARTA pista
 *
 * A silhueta diz "isto é uma CTO". O selo diz o estado, por **forma** e por
 * **glifo**; o tom só reforça. Um mapa impresso em preto e branco, ou visto por
 * quem não distingue vermelho de verde, continua legível.
 */

/**
 * Lado do ícone em pixels. O `viewBox` é 44×44.
 *
 * A régua de adaptadores precisa de espaço para que os traços não se fundam num
 * borrão. Acima disso o marcador começa a competir com o mapa em vez de apontar
 * para ele.
 */
export const CTO_MARKER_SIZE = 38;

interface Caixa {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Toda medida do desenho, em unidades do `viewBox`.
 *
 * O SVG é montado a partir daqui, e o teste afirma sobre os mesmos números.
 * Mudar o desenho sem atualizar a geometria é impossível: não existe segunda
 * cópia das coordenadas.
 */
export const CTO_MARKER_GEOMETRY = {
  /** Lado do `viewBox`. Quadrado, para o ícone não distorcer. */
  viewBox: 44,
  /**
   * O corpo da caixa: **em pé**, e com folga.
   *
   * 20 de largura por 27 de altura. A versão que o dono recusou media 29 × 21 —
   * deitada — e a primeira tentativa desta fase ficou em 24 × 24,5, ou seja
   * praticamente quadrada. Quadrado com uma grade dentro continua lendo como
   * aparelho, e nenhum detalhe interno compensa isso: **a proporção é o que
   * sobrevive a 38 pixels**.
   */
  shell: { x: 12, y: 6.5, width: 20, height: 27 } satisfies Caixa,
  /**
   * Cúpula quase semicircular em cima, canto seco embaixo.
   *
   * Raio 8,5 numa caixa de 20 de largura: o topo é praticamente meia
   * circunferência. É a assinatura do perfil, e é o que impede o desenho de
   * cair no "retângulo arredondado" que todo ícone de aplicativo também é.
   */
  shellRadius: { top: 8.5, bottom: 2.5 },
  /** Onde a tampa encosta na base. */
  seamY: 14,
  /** O fecho, montado SOBRE a costura: é o que diz "isto abre". */
  latch: { x: 20, y: 11.8, width: 4, height: 4.4 } satisfies Caixa,
  /** A bandeja onde os adaptadores ficam montados. */
  tray: { x: 14.5, y: 18, width: 15, height: 8 } satisfies Caixa,
  /**
   * Os adaptadores ópticos: traços verticais CONTÍGUOS.
   *
   * **Quatro, e não seis.** Seis num corpo desta largura ficavam a 2,6px um do
   * outro no tamanho real e se fundiam num borrão cinza — que é o que fazia a
   * bandeja ler como grade de radiador. O ícone não precisa contar portas: o
   * número real está no popup.
   */
  ports: { count: 4, top: 19.8, bottom: 24.2, first: 17.4, step: 3.1 },
  /**
   * A placa de prensa-cabos, na base.
   *
   * Uma barra só, e não dois blocos separados: dois blocos pequenos sob a caixa
   * leem como PÉS, e foi exatamente assim que a primeira tentativa desta fase
   * ficou. A barra lê como o que é — a face por onde os cabos passam.
   *
   * **Estreita, e bem mais estreita que o corpo.** A primeira barra tinha 14 de
   * largura contra 20 de corpo, e com os dois cabos abrindo embaixo o conjunto
   * virava um cavalete. Com 11 ela fica claramente tucada sob a caixa, que é
   * onde um prensa-cabo fica.
   */
  glandBar: { x: 16.5, y: 32.2, width: 11, height: 3.2 } satisfies Caixa,
  /** O selo de estado, encostado no canto superior direito. */
  badge: { cx: 36, cy: 8, r: 7 },
} as const;

const G = CTO_MARKER_GEOMETRY;

/** O centro horizontal do corpo — por onde o tronco desce. */
const CENTRO_X = G.shell.x + G.shell.width / 2;

/**
 * Até onde a fibra desce.
 *
 * É a âncora do marcador em unidades do `viewBox`: o ponto que representa o
 * poste no chão. Um marcador de objeto físico aponta para onde ele está, e aqui
 * quem aponta é a ponta do cabo.
 */
const BASE_DO_CABO = 42;

/**
 * O contorno do corpo, com raios diferentes em cima e embaixo.
 *
 * Quadráticas, e não arcos: neste tamanho o resultado visual é o mesmo, e o
 * caminho fica sem bandeiras de varredura para alguém interpretar errado depois.
 */
function contornoDoCorpo(): string {
  const { x, y, width: w, height: h } = G.shell;
  const rt = G.shellRadius.top;
  const rb = G.shellRadius.bottom;
  return [
    `M ${x} ${y + rt}`,
    `Q ${x} ${y} ${x + rt} ${y}`,
    `L ${x + w - rt} ${y}`,
    `Q ${x + w} ${y} ${x + w} ${y + rt}`,
    `L ${x + w} ${y + h - rb}`,
    `Q ${x + w} ${y + h} ${x + w - rb} ${y + h}`,
    `L ${x + rb} ${y + h}`,
    `Q ${x} ${y + h} ${x} ${y + h - rb}`,
    "Z",
  ].join(" ");
}

function retangulo(classe: string, caixa: Caixa, raio: number): string {
  return (
    `<rect class="${classe}" x="${caixa.x}" y="${caixa.y}" ` +
    `width="${caixa.width}" height="${caixa.height}" rx="${raio}" />`
  );
}

/** Os adaptadores, como traços verticais lado a lado. */
function reguaDePortas(): string {
  const { count, top, bottom, first, step } = G.ports;
  const tracos = Array.from({ length: count }, (_, i) => {
    const x = first + i * step;
    return `<line x1="${x}" y1="${top}" x2="${x}" y2="${bottom}" />`;
  });
  return `<g class="cto-box__ports">${tracos.join("")}</g>`;
}

/**
 * O selo de estado, por forma.
 *
 * Cada forma é um elemento SVG diferente — e não a mesma forma com outra cor.
 * É essa diferença que sobrevive a uma captura em escala de cinza.
 */
function seloDaForma(shape: CtoMapStatusPresentation["shape"]): string {
  const { cx, cy, r } = G.badge;
  switch (shape) {
    case "circle":
      return `<circle cx="${cx}" cy="${cy}" r="${r}" />`;
    case "square":
      return (
        `<rect x="${cx - r}" y="${cy - r}" width="${r * 2}" ` +
        `height="${r * 2}" rx="3" />`
      );
    case "triangle":
      return (
        `<polygon points="${cx},${cy - r} ${cx + r},${cy + r} ` +
        `${cx - r},${cy + r}" />`
      );
    case "diamond":
      return (
        `<polygon points="${cx},${cy - r} ${cx + r},${cy} ` +
        `${cx},${cy + r} ${cx - r},${cy}" />`
      );
  }
}

/**
 * O HTML do marcador.
 *
 * As cores saem de classes, e não de atributos `fill` com hexadecimal: o
 * projeto pinta por tokens semânticos (`docs/PRD.md` §149), e um marcador com
 * cor fixa seria a única superfície do produto que ignora o tema escolhido.
 *
 * A ORDEM de desenho importa. Orelhas, prensa-cabos e fibra vêm **antes** do
 * corpo, para que o corpo os cubra e eles pareçam sair de dentro da caixa em vez
 * de estarem colados por fora.
 */
export function ctoMarkerHtml(
  apresentacao: CtoMapStatusPresentation,
  selecionado: boolean,
): string {
  const classes = [
    "cto-box",
    `cto-box--${apresentacao.tone}`,
    selecionado ? "cto-box--selected" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const saidaDosCabos = G.glandBar.y + G.glandBar.height - 0.6;
  /*
    A drop sai à ESQUERDA, e perto do tronco.

    Perto porque dois cabos abrindo em V embaixo da caixa leem como pernas — é o
    mesmo defeito das orelhas, com outra forma. À esquerda porque o selo de
    estado ocupa a direita: com os dois do mesmo lado, o desenho fica torto.
  */
  const dropX = CENTRO_X - 2.6;

  return [
    `<svg class="${classes}" viewBox="0 0 ${G.viewBox} ${G.viewBox}" ` +
      `width="${CTO_MARKER_SIZE}" height="${CTO_MARKER_SIZE}" ` +
      `aria-hidden="true" focusable="false">`,

    /*
      ENTRADA e SAÍDA saindo da MESMA placa de prensa-cabos.

      O tronco desce RETO até a âncora — ele é o cabo que chega da rede, e é a
      ponta dele que toca o poste no chão. A drop do assinante sai CURVA, e a
      curva é a peça mais telecom do desenho inteiro: fibra nunca corre em
      ângulo reto, ela sempre sai fazendo raio. Duas retas paralelas seriam dois
      fios; uma reta e uma curva são um tronco e uma derivação.
    */
    retangulo("cto-box__gland", G.glandBar, 1.4),
    `<path class="cto-box__cable cto-box__cable--drop" ` +
      `d="M ${dropX} ${saidaDosCabos} C ${dropX - 0.4} 37.6 ` +
      `${dropX - 1.6} 38.6 ${dropX - 3.4} 39.2" />`,
    `<path class="cto-box__cable" d="M ${CENTRO_X} ${saidaDosCabos} ` +
      `L ${CENTRO_X} ${BASE_DO_CABO}" />`,

    // O corpo: cúpula em cima, canto seco embaixo.
    `<path class="cto-box__body" d="${contornoDoCorpo()}" />`,

    // A costura da tampa, e o fecho montado sobre ela.
    `<line class="cto-box__lid" x1="${G.shell.x}" y1="${G.seamY}" ` +
      `x2="${G.shell.x + G.shell.width}" y2="${G.seamY}" />`,
    retangulo("cto-box__latch", G.latch, 0.9),

    /*
      A RÉGUA DE ADAPTADORES.

      A bandeja e, dentro dela, traços verticais CONTÍGUOS. A contiguidade é o
      ponto: traços lado a lado leem como conector óptico, e pontos espalhados
      leem como botão — foi essa leitura de teclado que o dono recusou na
      primeira versão.
    */
    retangulo("cto-box__tray", G.tray, 1.5),
    reguaDePortas(),

    `<g class="cto-box__badge">${seloDaForma(apresentacao.shape)}</g>`,
    `<text class="cto-box__glyph" x="${G.badge.cx}" y="${G.badge.cy}" ` +
      `text-anchor="middle" dominant-baseline="central">` +
      `${apresentacao.glyph}</text>`,
    "</svg>",
  ].join("");
}
