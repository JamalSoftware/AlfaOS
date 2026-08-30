import 'package:alfaos_field/features/dashboard/domain/attention_ranking.dart';
import 'package:alfaos_field/features/orders/domain/service_order.dart';
import 'package:flutter_test/flutter_test.dart';

/// A regra de "Atenção agora", testada sem widget nenhum.
///
/// Ordenação é lógica, não pintura: separá-la da tela é o que permite provar o
/// desempate e o corte sem montar árvore, e o que impede a regra de virar um
/// detalhe escondido dentro de um `build`.
OrderSummary _os({
  required int number,
  OrderStatus status = OrderStatus.assigned,
  OrderPriority priority = OrderPriority.normal,
}) => OrderSummary(
  id: 'os-$number',
  number: number,
  status: status,
  priority: priority,
  type: 'Instalação',
  subtype: null,
  customerName: 'Cliente $number',
  district: null,
  city: null,
  scheduledAt: null,
  hasLocation: false,
  updatedAt: DateTime.utc(2026, 8, 27),
  version: 1,
);

void main() {
  group('ranking', () {
    test('em atendimento vem antes de urgente', () {
      /*
        Deliberado: uma OS já iniciada é trabalho aberto sob o nome do técnico.
        Deixá-la para trás por causa de outra mais urgente produz duas OS pela
        metade em vez de uma concluída.
      */
      final ordenado = attentionOrders([
        _os(number: 1, priority: OrderPriority.urgent),
        _os(number: 2, status: OrderStatus.inProgress),
      ]);

      expect(ordenado.map((o) => o.number), [2, 1]);
    });

    test('urgente vem antes de alta, que vem antes de atribuída comum', () {
      final ordenado = attentionOrders([
        _os(number: 1),
        _os(number: 2, priority: OrderPriority.high),
        _os(number: 3, priority: OrderPriority.urgent),
      ]);

      expect(ordenado.map((o) => o.number), [3, 2, 1]);
    });

    test('a ordem NÃO depende da ordem do JSON', () {
      /*
        A mesma fila, embaralhada, precisa pintar o mesmo painel. Sem isto o
        técnico veria os cards trocarem de lugar entre duas leituras da mesma
        lista, sem nada ter mudado no servidor.
      */
      final a = _os(number: 10, status: OrderStatus.inProgress);
      final b = _os(number: 20, priority: OrderPriority.urgent);
      final c = _os(number: 30);

      expect(attentionOrders([a, b, c]).map((o) => o.number), [10, 20, 30]);
      expect(attentionOrders([c, b, a]).map((o) => o.number), [10, 20, 30]);
      expect(attentionOrders([b, a, c]).map((o) => o.number), [10, 20, 30]);
    });

    test('empate no mesmo nível é desfeito pelo número, crescente', () {
      final ordenado = attentionOrders([
        _os(number: 30, priority: OrderPriority.urgent),
        _os(number: 10, priority: OrderPriority.urgent),
        _os(number: 20, priority: OrderPriority.urgent),
      ]);

      // A mais antiga primeiro — e, acima de tudo, sempre a MESMA ordem.
      expect(ordenado.map((o) => o.number), [10, 20, 30]);
    });
  });

  group('o que entra e o que fica de fora', () {
    test('concluída e cancelada nunca entram', () {
      final ordenado = attentionOrders([
        _os(number: 1, status: OrderStatus.completed),
        _os(number: 2, status: OrderStatus.cancelled),
        _os(number: 3),
      ]);

      expect(ordenado.map((o) => o.number), [3]);
    });

    test('OS sem scheduledAt ENTRA — é o caso que o piloto encontrou', () {
      /*
        O defeito relatado no primeiro piloto físico: uma OS real importada do
        ReceitaNet, atribuída e sem horário, aparecia em "Minhas Ordens" e
        sumia do Início — porque o Início só conhecia "Próxima OS", que exige
        `scheduledAt`. Aqui `scheduledAt` é nulo em todas, e todas entram.
      */
      final ordenado = attentionOrders([_os(number: 7)]);

      expect(ordenado, hasLength(1));
      expect(ordenado.single.number, 7);
      expect(ordenado.single.scheduledAt, isNull);
    });

    test('status desconhecido de um servidor mais novo NÃO some', () {
      // Um APK antigo diante de um estado novo mostra a OS em vez de escondê-la.
      final ordenado = attentionOrders([
        _os(number: 1, status: OrderStatus.unknown),
      ]);

      expect(ordenado, hasLength(1));
    });

    test('o corte respeita o limite, mantendo os mais prioritários', () {
      final ordenado = attentionOrders([
        _os(number: 1),
        _os(number: 2),
        _os(number: 3),
        _os(number: 4, priority: OrderPriority.urgent),
        _os(number: 5, status: OrderStatus.inProgress),
      ]);

      expect(ordenado, hasLength(attentionLimit));
      // Em atendimento, urgente, e a primeira comum — nesta ordem.
      expect(ordenado.map((o) => o.number), [5, 4, 1]);
    });

    test('lista vazia devolve vazio, sem estourar', () {
      expect(attentionOrders(const []), isEmpty);
    });
  });
}
