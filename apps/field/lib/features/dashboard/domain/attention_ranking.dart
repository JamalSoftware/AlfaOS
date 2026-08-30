import '../../orders/domain/service_order.dart';

/// Quantas OS o bloco "Atenção agora" mostra.
///
/// O Início não é a lista de OS: passar disto transforma o painel em segunda
/// tela de fila, e a aba `OS` deixa de ter razão de existir.
const attentionLimit = 3;

/// As OS que merecem ação AGORA, ordenadas.
///
/// ## Por que este bloco existe
///
/// O primeiro piloto físico encontrou uma OS real do ReceitaNet, atribuída e
/// visível em "Minhas Ordens", **ausente do Início**. A causa não era um
/// defeito: o Início só mostrava "Próxima OS", e "próxima" exige `scheduledAt`
/// — que a OS importada não tinha. A proteção estava certa (não se chama de
/// "próxima" uma OS sem horário); o que faltava era um lugar para as OS **sem
/// agendamento**, que são justamente as que ninguém mais lembra.
///
/// ## O ranking, e por que é este
///
/// Só campos que o DTO realmente traz (`docs/FIELD-API.md`): `status` e
/// `priority`. Nada é inferido de texto, nada é adivinhado.
///
/// ```text
/// 0  IN_PROGRESS              o atendimento que já começou e não terminou
/// 1  URGENT   (aberta)        prioridade que o servidor marcou como urgente
/// 2  HIGH     (aberta)        prioridade alta
/// 3  demais abertas           atribuídas e pendentes
/// ```
///
/// **Em atendimento vem antes de urgente** de propósito: uma OS já iniciada é
/// trabalho em aberto sob o nome do técnico — deixá-la para trás por causa de
/// outra mais urgente produz duas OS pela metade em vez de uma concluída. É a
/// mesma ordem que a lista de OS já usa (`OrdersState.inProgress` primeiro).
///
/// Concluída e cancelada **nunca** entram: não há ação a tomar nelas.
///
/// ## Determinismo
///
/// Empate dentro do mesmo nível é desfeito por `number` crescente — a OS mais
/// antiga primeiro. Sem esse desempate a ordem dependeria da ordem do JSON, e
/// duas leituras da mesma fila poderiam pintar o painel de formas diferentes.
List<OrderSummary> attentionOrders(List<OrderSummary> items) {
  final abertas = items.where(_isOpen).toList()
    ..sort((a, b) {
      final byRank = _rank(a).compareTo(_rank(b));
      if (byRank != 0) return byRank;
      return a.number.compareTo(b.number);
    });

  return abertas.take(attentionLimit).toList(growable: false);
}

/// Aberta = ainda pede ação. `unknown` entra: um APK antigo diante de um
/// status novo deve mostrar a OS, não escondê-la.
bool _isOpen(OrderSummary order) =>
    order.status != OrderStatus.completed &&
    order.status != OrderStatus.cancelled;

int _rank(OrderSummary order) {
  if (order.status == OrderStatus.inProgress) return 0;
  if (order.priority == OrderPriority.urgent) return 1;
  if (order.priority == OrderPriority.high) return 2;
  return 3;
}
