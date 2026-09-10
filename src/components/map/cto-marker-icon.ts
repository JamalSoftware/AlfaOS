import type { CtoMapStatusPresentation } from "@/lib/cto-map-presentation";

/**
 * # O marcador de CTO — uma caixa óptica, não um alfinete
 *
 * O alfinete genérico diz *"tem alguma coisa aqui"*. Num mapa que vai receber
 * técnico, cliente e ordem de serviço (§136), isso é exatamente a informação
 * que não serve: quatro camadas de alfinete são quatro camadas indistinguíveis.
 * A silhueta da caixa é o que deixa a CTO reconhecível de relance, antes de
 * qualquer cor.
 *
 * ## SVG escrito à mão, e nenhuma dependência
 *
 * Não há biblioteca de ícone no projeto, e trazer uma para desenhar um
 * retângulo com pontinhos seria superfície de terceiro em troca de nada. O
 * desenho são doze elementos.
 *
 * ## O nome da caixa NUNCA entra aqui
 *
 * `divIcon` recebe **HTML cru** e o injeta no DOM. Tudo o que este módulo monta
 * vem da tabela de apresentação — quatro formas, quatro glifos, todos
 * constantes deste repositório. Nome e código, que são digitados por gente, vão
 * exclusivamente para dentro do `<Popup>`, que o React escapa. Uma caixa
 * chamada `<img src=x onerror=…>` aparece como esse texto.
 *
 * ## Cor é a QUARTA pista
 *
 * A silhueta diz "isto é uma CTO". O selo diz o estado, por **forma** e por
 * **glifo**; o tom só reforça. Um mapa impresso em preto e branco, ou visto por
 * quem não distingue vermelho de verde, continua legível.
 */

/** Lado do ícone em pixels. O `viewBox` é 40×40; o desenho ocupa 36. */
export const CTO_MARKER_SIZE = 36;

/**
 * O selo de estado, por forma.
 *
 * Cada forma é um elemento SVG diferente — e não a mesma forma com outra cor.
 * É essa diferença que sobrevive a uma captura em escala de cinza.
 */
function seloDaForma(shape: CtoMapStatusPresentation["shape"]): string {
  switch (shape) {
    case "circle":
      return '<circle cx="30" cy="10" r="8.5" />';
    case "square":
      return '<rect x="21.5" y="1.5" width="17" height="17" rx="3" />';
    case "triangle":
      return '<polygon points="30,1 39,18 21,18" />';
    case "diamond":
      return '<polygon points="30,1 39,10 30,19 21,10" />';
  }
}

/**
 * O HTML do marcador.
 *
 * As cores saem de classes, e não de atributos `fill` com hexadecimal: o
 * projeto pinta por tokens semânticos (`docs/PRD.md` §149), e um marcador com
 * cor fixa seria a única superfície que ignora o tema escolhido.
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

  return [
    `<svg class="${classes}" viewBox="0 0 40 40" width="${CTO_MARKER_SIZE}" height="${CTO_MARKER_SIZE}" aria-hidden="true" focusable="false">`,
    // O corpo da caixa: retângulo com cantos suaves, e a tampa marcada por uma
    // linha — é o que faz a silhueta ler como "caixa" e não como "botão".
    '<rect class="cto-box__body" x="4.5" y="14.5" width="31" height="23" rx="3.5" />',
    '<line class="cto-box__lid" x1="4.5" y1="21" x2="35.5" y2="21" />',
    // Duas fileiras de três portas. Seis e não oito: acima disso os pontos se
    // fundem num borrão cinza no tamanho real.
    '<g class="cto-box__ports">',
    '<circle cx="12" cy="27" r="2" /><circle cx="20" cy="27" r="2" /><circle cx="28" cy="27" r="2" />',
    '<circle cx="12" cy="33" r="2" /><circle cx="20" cy="33" r="2" /><circle cx="28" cy="33" r="2" />',
    "</g>",
    `<g class="cto-box__badge">${seloDaForma(apresentacao.shape)}</g>`,
    `<text class="cto-box__glyph" x="30" y="10" text-anchor="middle" dominant-baseline="central">${apresentacao.glyph}</text>`,
    "</svg>",
  ].join("");
}
