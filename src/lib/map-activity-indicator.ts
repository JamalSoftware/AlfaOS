/**
 * # O indicador de atividade do mapa — quando aparecer, e quando sumir
 *
 * O dono viu "Carregando CTOs…" PISCANDO a cada zoom e a cada arrasto. Medido
 * numa sonda de 20 ms: numa resposta normal a pílula existia por cerca de
 * 80 ms — tempo suficiente para o olho registrar um flash, e curto demais para
 * ler qualquer coisa. Um aviso que pisca não informa; transmite instabilidade.
 *
 * A causa era o aviso nascer no MESMO instante da requisição e morrer no
 * MESMO instante da resposta. Duas regras corrigem os dois lados:
 *
 * - **atraso para aparecer** (`MAP_ACTIVITY_SHOW_DELAY_MS`): uma leitura que
 *   volta antes disso nunca chega a existir na tela — é a maioria delas;
 * - **tempo mínimo visível** (`MAP_ACTIVITY_MIN_VISIBLE_MS`): uma leitura que
 *   demorou o bastante para o aviso aparecer o mantém na tela por um tempo
 *   legível, mesmo que a resposta chegue um milissegundo depois dele nascer.
 *
 * O pedido ao servidor sai na hora; só o AVISO espera. Nada aqui atrasa dado.
 *
 * ## Por que é uma função pura
 *
 * A decisão — mostrar, esconder, ou nada, e daqui a quanto — é testável com um
 * relógio de mentira, sem React e sem navegador. O componente só executa o que
 * ela responde, com `setTimeout`, e cancela o que estiver pendente quando a
 * atividade muda. A parte que o teste de navegador cobre é a integração; a
 * cadência é provada aqui.
 */

export const MAP_ACTIVITY_SHOW_DELAY_MS = 250;
export const MAP_ACTIVITY_MIN_VISIBLE_MS = 300;

export type MapActivityAction = "show" | "hide" | "none";

export interface MapActivityStep {
  action: MapActivityAction;
  /** Daqui a quantos ms executar. `0` para "agora". */
  afterMs: number;
}

/**
 * O próximo passo do indicador, dado o que está acontecendo e o que está na
 * tela.
 *
 * @param active   há leitura em voo em ALGUMA camada.
 * @param visible  o indicador está na tela agora.
 * @param shownAt  quando ele apareceu (ms), ou `null` se não está na tela.
 * @param now      o relógio de quem pergunta, para o teste poder mentir.
 */
export function nextMapActivityStep(
  active: boolean,
  visible: boolean,
  shownAt: number | null,
  now: number,
  options: { showDelayMs?: number; minVisibleMs?: number } = {},
): MapActivityStep {
  const showDelay = options.showDelayMs ?? MAP_ACTIVITY_SHOW_DELAY_MS;
  const minVisible = options.minVisibleMs ?? MAP_ACTIVITY_MIN_VISIBLE_MS;

  if (active) {
    // Já está na tela: fica. Uma segunda leitura emendada na primeira não
    // apaga e reacende o aviso — isso seria o flicker por outro caminho.
    if (visible) return { action: "none", afterMs: 0 };
    return { action: "show", afterMs: showDelay };
  }

  if (!visible) return { action: "none", afterMs: 0 };

  /*
    Terminou, e o aviso está na tela: some quando completar o tempo mínimo.

    `shownAt` nulo com `visible` verdadeiro não deveria acontecer; se
    acontecer, o tempo mínimo conta a partir de agora — errar para o lado de
    mostrar um pouco mais é o erro que ninguém percebe.
  */
  const decorrido = shownAt === null ? 0 : Math.max(0, now - shownAt);
  return { action: "hide", afterMs: Math.max(0, minVisible - decorrido) };
}
