/**
 * # Provider de push — abstração
 *
 * Nesta versão o AlfaOS **não** integra o FCM. Integrar exigiria projeto no
 * Google, credencial de serviço e uma decisão de infraestrutura que não cabe
 * numa fundação de backend — e travar a fundação atrás disso atrasaria tudo o
 * que já é possível entregar sem push (a §68 é explícita).
 *
 * O que existe é a fronteira: uma interface e uma implementação inerte. Quando
 * o FCM entrar, junto do Flutter, ele implementa `PushNotificationProvider` e
 * nada mais no AlfaOS muda — o outbox, a notificação e o registro de aparelho
 * já estarão prontos e testados.
 *
 * **Push não é fonte de verdade.** A `Notification` já foi gravada antes de
 * qualquer coisa aqui rodar; se esta camada falhar por completo, o técnico
 * ainda vê a atribuição ao abrir o aplicativo.
 */

export interface PushMessage {
  /** Tokens de destino. Um técnico pode ter mais de um aparelho. */
  tokens: string[];
  title: string;
  body: string;
  /**
   * Dados de navegação. Só identificador — nunca conteúdo sensível.
   *
   * A prévia do push aparece sobre a tela bloqueada e fica dias na central do
   * sistema operacional. O detalhe fica atrás do toque, e a autorização é
   * conferida na abertura.
   */
  data?: Record<string, string>;
}

export interface PushDeliveryResult {
  /** Quantos destinos aceitaram. */
  delivered: number;
  /**
   * Tokens que o provider recusou como definitivamente inválidos.
   *
   * Existe para que a rotação seja possível: token morto precisa sair do
   * `MobileDevice`, senão o worker tenta para sempre um aparelho que foi
   * desinstalado.
   */
  invalidTokens: string[];
  /**
   * Destinos que falharam por causa **transitória** e merecem outra tentativa.
   *
   * Contagem, e não lista de tokens: quem tenta de novo é o outbox, que relê os
   * aparelhos elegíveis do zero — a lista de agora estaria velha na próxima
   * execução.
   *
   * ## Por que é obrigatório
   *
   * Um provider que falhasse de forma transitória sem dizer faria o handler
   * concluir o evento, e o aviso sumiria em silêncio: entregue para ninguém,
   * marcado como processado. Campo opcional convidaria exatamente esse
   * esquecimento no próximo provider que alguém escrever.
   */
  retryableFailures: number;
}

export interface PushNotificationProvider {
  readonly name: string;
  send(message: PushMessage): Promise<PushDeliveryResult>;
}

/**
 * Não entrega nada, e diz isso honestamente.
 *
 * Deliberadamente **não** finge sucesso silencioso: `delivered: 0` é o número
 * verdadeiro, e é o que as métricas do worker vão mostrar. Um stub que
 * reportasse entrega criaria a impressão de que o push funciona e esconderia,
 * no dia da integração real, se ele parou de funcionar.
 *
 * ## `retryableFailures: 0` é deliberado
 *
 * Não configurar o Firebase **não é uma falha transitória**: tentar de novo
 * daqui a um minuto não vai configurá-lo. Reportar retry aqui deixaria toda
 * instalação de desenvolvimento com a fila girando até esgotar as tentativas,
 * e transformaria "push desligado" em "outbox quebrado" (`NF-1`, §39 do plano).
 */
export class NoopPushProvider implements PushNotificationProvider {
  readonly name = "noop";

  async send(message: PushMessage): Promise<PushDeliveryResult> {
    // Só a contagem. Token de push nunca vai para log (§34).
    console.info(
      `[push:noop] ${message.tokens.length} destino(s) ignorado(s) — provider de push não configurado`,
    );
    return { delivered: 0, invalidTokens: [], retryableFailures: 0 };
  }
}

let provider: PushNotificationProvider = new NoopPushProvider();

export function getPushProvider(): PushNotificationProvider {
  return provider;
}

/** Ponto de injeção — usado pelo teste e pela futura integração FCM. */
export function setPushProvider(next: PushNotificationProvider): void {
  provider = next;
}

export function resetPushProvider(): void {
  provider = new NoopPushProvider();
}
