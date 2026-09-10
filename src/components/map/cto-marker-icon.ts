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
 * ## O que mudou na `CTO-3.2.1b`, e por quê
 *
 * A primeira versão desenhava as portas como **duas fileiras de três pontos**.
 * Funcionava e o dono a recusou pelo motivo certo: no tamanho real aquilo lê
 * como teclado ou calculadora, não como equipamento de rede.
 *
 * O desenho agora segue a forma de uma caixa de terminação de poste de verdade:
 *
 * ```text
 *        ╭─────────────╮ ◀ tampa, com a linha de fecho
 *        │             │
 *        │ ▌▌▌▌▌▌      │ ◀ régua de portas — traços verticais, lado a lado
 *        ╰──────┬──────╯
 *               │        ◀ prensa-cabo e a descida do cabo
 * ```
 *
 * A **régua** é a diferença: portas ópticas ficam enfileiradas numa bandeja, e
 * traços verticais contíguos leem como conector — pontos espalhados leem como
 * botão. O **prensa-cabo** embaixo é o que remove qualquer leitura de
 * "roteador" ou "caixa de luz": é por ali que a fibra entra.
 *
 * ## SVG escrito à mão, e nenhuma dependência
 *
 * Não há biblioteca de ícone no projeto, e trazer uma para desenhar um
 * retângulo com uma régua seria superfície de terceiro em troca de nada.
 *
 * ## O nome da caixa NUNCA entra aqui
 *
 * `divIcon` recebe **HTML cru** e o injeta no DOM. Tudo o que este módulo monta
 * vem da tabela de apresentação — quatro formas, quatro glifos, todos
 * constantes deste repositório. Nome e código, que são digitados por gente, vão
 * exclusivamente para dentro do `<Popup>`, que o React renderiza como texto e
 * escapa. Uma caixa chamada `<img src=x onerror=…>` aparece como esse texto.
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
 * Cresceu de 36 para 38 junto com o redesenho: a régua de portas precisa de
 * espaço para que os traços não se fundam num borrão. Acima disso o marcador
 * começa a competir com o mapa em vez de apontar para ele.
 */
export const CTO_MARKER_SIZE = 38;

/**
 * O selo de estado, por forma.
 *
 * Cada forma é um elemento SVG diferente — e não a mesma forma com outra cor.
 * É essa diferença que sobrevive a uma captura em escala de cinza.
 */
function seloDaForma(shape: CtoMapStatusPresentation["shape"]): string {
  switch (shape) {
    case "circle":
      return '<circle cx="33" cy="11" r="8.5" />';
    case "square":
      return '<rect x="24.5" y="2.5" width="17" height="17" rx="3" />';
    case "triangle":
      return '<polygon points="33,2 42,19 24,19" />';
    case "diamond":
      return '<polygon points="33,2 42,11 33,20 24,11" />';
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
    `<svg class="${classes}" viewBox="0 0 44 44" width="${CTO_MARKER_SIZE}" height="${CTO_MARKER_SIZE}" aria-hidden="true" focusable="false">`,

    // O cabo desce do prensa-cabo até a base do ícone: é o que diz "isto é
    // equipamento de rede", e não uma caixa de luz.
    '<path class="cto-box__cable" d="M18 34 L18 41" />',
    // Prensa-cabo: o bloco por onde a fibra entra, na base da caixa.
    '<rect class="cto-box__gland" x="15" y="32" width="6" height="4" rx="1.2" />',

    // O corpo, com cantos discretamente arredondados.
    '<rect class="cto-box__body" x="3.5" y="12.5" width="29" height="21" rx="3" />',
    // A linha de fecho da tampa.
    '<line class="cto-box__lid" x1="3.5" y1="19" x2="32.5" y2="19" />',

    /*
      A RÉGUA DE PORTAS.

      Um retângulo de fundo com seis traços verticais dentro — a bandeja e os
      conectores. Contíguos de propósito: é a contiguidade que lê como régua.
      Espalhá-los em grade foi o que fez a primeira versão parecer calculadora.
    */
    '<rect class="cto-box__tray" x="7" y="22.5" width="22" height="8" rx="1.5" />',
    '<g class="cto-box__ports">',
    '<line x1="9.5" y1="24" x2="9.5" y2="29" />',
    '<line x1="13" y1="24" x2="13" y2="29" />',
    '<line x1="16.5" y1="24" x2="16.5" y2="29" />',
    '<line x1="20" y1="24" x2="20" y2="29" />',
    '<line x1="23.5" y1="24" x2="23.5" y2="29" />',
    '<line x1="27" y1="24" x2="27" y2="29" />',
    "</g>",

    `<g class="cto-box__badge">${seloDaForma(apresentacao.shape)}</g>`,
    `<text class="cto-box__glyph" x="33" y="11" text-anchor="middle" dominant-baseline="central">${apresentacao.glyph}</text>`,
    "</svg>",
  ].join("");
}
