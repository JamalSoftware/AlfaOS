import 'package:alfaos_field/features/orders/domain/dispatch_queue.dart';
import 'package:alfaos_field/features/orders/domain/service_order.dart';
import 'package:flutter_test/flutter_test.dart';

/// # O contrato da fila, lido do jeito que o servidor manda (DQ-6)
///
/// Sem widget e sem rede: o que se prova aqui é que o aplicativo **não**
/// reordena e **não** inventa posição — e que a ausência de `position` é
/// reconhecida como "servidor antigo", não como fila vazia.
Map<String, dynamic> item({
  required int number,
  int? position,
  String priority = 'NORMAL',
  String status = 'ASSIGNED',
  String? scheduledAt,
}) => {
  'id': 'os-$number',
  'number': number,
  'status': status,
  'priority': priority,
  'type': 'Instalação',
  'subtype': null,
  'customerName': 'Cliente $number',
  'district': 'Centro',
  'city': 'Guaçuí',
  'scheduledAt': scheduledAt,
  'hasLocation': true,
  'updatedAt': '2026-08-31T10:00:00.000Z',
  'version': 3,
  'position': ?position,
};

void main() {
  group('leitura do contrato', () {
    test('preserva a ORDEM que o servidor mandou', () {
      /*
        O defeito que o piloto encontrou, na sua forma mínima.

        A OS Nº 5 tem número MENOR e prioridade IGUAL à Nº 7, e mesmo assim
        vem depois — porque o despachante decidiu. Qualquer ordenação local
        inverteria isto.
      */
      final queue = DispatchQueue.tryParse({
        'queueVersion': 4,
        'inProgress': <dynamic>[],
        'queued': [item(number: 7, position: 1), item(number: 5, position: 2)],
      });

      expect(queue, isNotNull);
      expect(queue!.queued.map((q) => q.order.number), [7, 5]);
      expect(queue.queued.map((q) => q.position), [1, 2]);
      expect(queue.queueVersion, 4);
    });

    test('a ordem inversa também é preservada', () {
      final queue = DispatchQueue.tryParse({
        'queueVersion': 5,
        'inProgress': <dynamic>[],
        'queued': [item(number: 5, position: 1), item(number: 7, position: 2)],
      })!;
      expect(queue.queued.map((q) => q.order.number), [5, 7]);
    });

    test('inProgress é coleção e não recebe posição', () {
      final queue = DispatchQueue.tryParse({
        'queueVersion': 1,
        'inProgress': [
          item(number: 1, status: 'IN_PROGRESS'),
          item(number: 2, status: 'IN_PROGRESS'),
        ],
        'queued': [item(number: 3, position: 1)],
      })!;

      expect(queue.inProgress, hasLength(2));
      expect(queue.queued.single.position, 1);
    });

    test('os QUATRO valores de prioridade chegam sem colapso', () {
      final queue = DispatchQueue.tryParse({
        'queueVersion': 1,
        'inProgress': <dynamic>[],
        'queued': [
          item(number: 1, position: 1, priority: 'URGENT'),
          item(number: 2, position: 2, priority: 'HIGH'),
          item(number: 3, position: 3, priority: 'NORMAL'),
          item(number: 4, position: 4, priority: 'LOW'),
        ],
      })!;

      expect(queue.queued.map((q) => q.order.priority), [
        OrderPriority.urgent,
        OrderPriority.high,
        OrderPriority.normal,
        OrderPriority.low,
      ]);
    });

    test('scheduledAt viaja e é independente da posição', () {
      final queue = DispatchQueue.tryParse({
        'queueVersion': 1,
        'inProgress': <dynamic>[],
        'queued': [
          item(number: 1, position: 1),
          item(number: 2, position: 2, scheduledAt: '2026-09-01T13:00:00.000Z'),
        ],
      })!;

      // A 1ª da fila NÃO tem horário; a 2ª tem. As duas frases são diferentes.
      expect(queue.queued.first.order.scheduledAt, isNull);
      expect(queue.queued.last.order.scheduledAt, isNotNull);
    });

    test('fila vazia é fila vazia, não indisponível', () {
      final queue = DispatchQueue.tryParse({
        'queueVersion': 0,
        'inProgress': <dynamic>[],
        'queued': <dynamic>[],
      });
      expect(queue, isNotNull);
      expect(queue!.isEmpty, isTrue);
      expect(queue.nextInQueue, isNull);
    });
  });

  group('F-2 · ausência de position', () {
    test('item sem `position` torna a fila INDISPONÍVEL, não vazia', () {
      /*
        O caso do APK novo contra servidor anterior à DQ-5.

        Devolver uma fila sem posição seria pior que devolver nada: o
        aplicativo passaria a exibir uma ordem inventada como se fosse a do
        despachante. `null` aqui é o sinal para o modo de compatibilidade.
      */
      final queue = DispatchQueue.tryParse({
        'queueVersion': 1,
        'inProgress': <dynamic>[],
        'queued': [item(number: 7)],
      });
      expect(queue, isNull);
    });

    test('corpo sem as listas também é indisponível', () {
      expect(DispatchQueue.tryParse({'queueVersion': 1}), isNull);
      expect(
        DispatchQueue.tryParse({'inProgress': <dynamic>[], 'queued': 'nada'}),
        isNull,
      );
    });
  });

  group('contagens do Hero', () {
    test('OS abertas = em atendimento + na fila', () {
      final queue = DispatchQueue.tryParse({
        'queueVersion': 1,
        'inProgress': [item(number: 1, status: 'IN_PROGRESS')],
        'queued': [
          item(number: 2, position: 1, priority: 'URGENT'),
          item(number: 3, position: 2),
        ],
      })!;

      expect(queue.openCount, 3);
      expect(queue.urgentCount, 1);
    });

    test('urgência conta as em atendimento também', () {
      final queue = DispatchQueue.tryParse({
        'queueVersion': 1,
        'inProgress': [
          item(number: 1, status: 'IN_PROGRESS', priority: 'URGENT'),
        ],
        'queued': [item(number: 2, position: 1, priority: 'URGENT')],
      })!;
      expect(queue.urgentCount, 2);
    });
  });

  group('ordinal', () {
    test('1ª, 2ª, 3ª', () {
      expect(QueuedOrder(order: _dummy, position: 1).ordinal, '1ª');
      expect(QueuedOrder(order: _dummy, position: 12).ordinal, '12ª');
    });
  });
}

final _dummy = OrderSummary(
  id: 'x',
  number: 1,
  status: OrderStatus.assigned,
  priority: OrderPriority.normal,
  type: 'Instalação',
  subtype: null,
  customerName: 'C',
  district: null,
  city: null,
  scheduledAt: null,
  hasLocation: false,
  updatedAt: DateTime(2026),
  version: 0,
);
