import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/fake_transport.dart';
import '../support/harness.dart';

/// # O Field OBEDECE ao despacho (DQ-6)
///
/// O teste central desta fase é o do piloto: o despachante põe a OS Nº 7 em
/// 1ª e a Nº 5 em 2ª, e o aplicativo mostra `7, 5` — mesmo com a Nº 5 tendo
/// número menor e prioridade igual. Depois a ordem inverte no servidor, o
/// técnico atualiza, e a tela acompanha.
///
/// Antes desta fase o aplicativo mostrava a ordem que ele mesmo calculava, e
/// a decisão do despachante não chegava a campo.
Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 8; i++) {
    await tester.pump(const Duration(milliseconds: 60));
  }
  await tester.pumpAndSettle(const Duration(milliseconds: 50));
}

void _tela(WidgetTester tester) {
  tester.view.physicalSize = const Size(390, 900);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
}

Map<String, dynamic> _os({
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

void _base(FakeTransport transport) {
  transport.onJson(
    'GET',
    '/me',
    data: {
      'user': {'id': 'u1', 'name': 'Joana Torres', 'email': 'j@a.test'},
      'technician': {'id': 't1', 'active': true, 'executionIssue': null},
      'company': {'id': 'c1', 'name': 'Alfa Telecom'},
      'device': {'id': 'd1', 'platform': 'ANDROID'},
      'capabilities': {'startOrder': true},
    },
  );
  transport.onJson(
    'GET',
    '/time-clock/today',
    data: {
      'workday': {
        'workdayId': 'wd-1',
        'date': '2026-08-31',
        'timezone': 'America/Sao_Paulo',
        'utcOffset': '-03:00',
        'state': 'WORKING',
        'allowedActions': ['BREAK_START', 'CLOCK_OUT'],
        'entries': <dynamic>[],
        'workedMinutes': 125,
        'breakMinutes': 0,
        'inconsistencies': <String>[],
        'pendingAdjustments': 0,
      },
    },
  );
  transport.onJson(
    'GET',
    '/time-clock/history',
    data: {'workdays': <dynamic>[]},
  );
  transport.onJson(
    'GET',
    '/time-clock/adjustments',
    data: {'adjustments': <dynamic>[]},
  );
  transport.onJson(
    'GET',
    '/notifications',
    data: {'items': <dynamic>[], 'nextCursor': null, 'unreadCount': 0},
  );
}

/// A lista paginada devolve a ordem "natural" — número crescente.
///
/// É de propósito: se o aplicativo estivesse ordenando por conta própria, ele
/// mostraria `5, 7`, e o teste central falharia.
void _ordersList(
  FakeTransport transport,
  List<int> numbers, {
  String? scheduledAt,
}) {
  transport.onJson(
    'GET',
    '/service-orders',
    data: {
      'items': [
        for (final n in numbers) _os(number: n, scheduledAt: scheduledAt),
      ],
      'nextCursor': null,
    },
  );
}

void _queue(FakeTransport transport, List<Map<String, dynamic>> queued) {
  transport.onJson(
    'GET',
    '/dispatch-queue',
    data: {'queueVersion': 4, 'inProgress': <dynamic>[], 'queued': queued},
  );
}

/// Os números das OS na ordem em que a tela pinta os CARDS.
///
/// O casamento é EXATO de propósito: a linha de agendamento também começa com
/// "OS Nº", e um `startsWith` a contaria como se fosse mais um card —
/// exatamente a duplicação que este arquivo existe para verificar.
List<int> _ordemNaTela(WidgetTester tester) {
  final padrao = RegExp(r'^OS Nº (\d+)$');
  return tester
      .widgetList<Text>(find.byType(Text))
      .map((t) => padrao.firstMatch(t.data ?? ''))
      .whereType<RegExpMatch>()
      .map((m) => int.parse(m.group(1)!))
      .toList();
}

void main() {
  group('F-1 · a ordem é a do backend', () {
    testWidgets('o Início mostra 7 antes de 5, como o despacho definiu', (
      tester,
    ) async {
      _tela(tester);
      final harness = Harness();
      _base(harness.transport);
      // A lista paginada devolve 5 antes de 7 — a ordem "natural".
      _ordersList(harness.transport, [5, 7]);
      // O despacho diz o contrário.
      _queue(harness.transport, [
        _os(number: 7, position: 1),
        _os(number: 5, position: 2),
      ]);
      harness.store.token = 'token-seedado';

      await harness.pumpApp(tester);
      await _settle(tester);

      expect(_ordemNaTela(tester).take(2), [7, 5]);
    });

    testWidgets('Minhas Ordens também obedece', (tester) async {
      _tela(tester);
      final harness = Harness();
      _base(harness.transport);
      _ordersList(harness.transport, [5, 7]);
      _queue(harness.transport, [
        _os(number: 7, position: 1),
        _os(number: 5, position: 2),
      ]);
      harness.store.token = 'token-seedado';

      await harness.pumpApp(tester);
      await _settle(tester);
      harness.goTo('/orders');
      await _settle(tester);

      expect(_ordemNaTela(tester), [7, 5]);
    });

    testWidgets('não ordena por número nem por horário', (tester) async {
      /*
        A armadilha montada de propósito: a 1ª da fila é a de número MAIOR e
        SEM agendamento; a 2ª tem número menor e horário marcado. Qualquer
        ordenação local — por `number` ou por `scheduledAt` — inverteria.
      */
      _tela(tester);
      final harness = Harness();
      _base(harness.transport);
      _ordersList(harness.transport, [5, 9]);
      _queue(harness.transport, [
        _os(number: 9, position: 1),
        _os(number: 5, position: 2, scheduledAt: '2026-09-01T09:00:00.000Z'),
      ]);
      harness.store.token = 'token-seedado';

      await harness.pumpApp(tester);
      await _settle(tester);

      expect(_ordemNaTela(tester).take(2), [9, 5]);
    });
  });

  group('F-3 · a posição é visível', () {
    testWidgets('1ª e 2ª aparecem como ordinal', (tester) async {
      _tela(tester);
      final harness = Harness();
      _base(harness.transport);
      _ordersList(harness.transport, [5, 7]);
      _queue(harness.transport, [
        _os(number: 7, position: 1),
        _os(number: 5, position: 2),
      ]);
      harness.store.token = 'token-seedado';

      await harness.pumpApp(tester);
      await _settle(tester);

      expect(find.text('1ª'), findsWidgets);
      expect(find.text('2ª'), findsWidgets);
    });
  });

  group('F-4 · urgente é TEXTO, não só cor', () {
    testWidgets('o rótulo aparece por extenso', (tester) async {
      _tela(tester);
      final harness = Harness();
      _base(harness.transport);
      _ordersList(harness.transport, [7]);
      _queue(harness.transport, [
        _os(number: 7, position: 1, priority: 'URGENT'),
      ]);
      harness.store.token = 'token-seedado';

      await harness.pumpApp(tester);
      await _settle(tester);

      expect(find.text('Urgente'), findsWidgets);
    });
  });

  group('F-5 · IN_PROGRESS em seção própria', () {
    testWidgets('duas em atendimento aparecem, e sem posição', (tester) async {
      _tela(tester);
      final harness = Harness();
      _base(harness.transport);
      _ordersList(harness.transport, [1, 2, 3]);
      harness.transport.onJson(
        'GET',
        '/dispatch-queue',
        data: {
          'queueVersion': 2,
          'inProgress': [
            _os(number: 1, status: 'IN_PROGRESS'),
            _os(number: 2, status: 'IN_PROGRESS'),
          ],
          'queued': [_os(number: 3, position: 1)],
        },
      );
      harness.store.token = 'token-seedado';

      await harness.pumpApp(tester);
      await _settle(tester);
      harness.goTo('/orders');
      await _settle(tester);

      expect(find.text('EM ATENDIMENTO'), findsOneWidget);
      expect(find.text('PRÓXIMAS NA FILA'), findsOneWidget);
      // Só a enfileirada tem ordinal.
      expect(find.text('1ª'), findsOneWidget);
      expect(_ordemNaTela(tester), [1, 2, 3]);
    });
  });

  group('F-6 · "na fila" nunca é "agendada"', () {
    testWidgets('os dois rótulos não se confundem', (tester) async {
      _tela(tester);
      final harness = Harness();
      _base(harness.transport);
      _ordersList(harness.transport, [
        7,
      ], scheduledAt: '2026-09-01T13:00:00.000Z');
      _queue(harness.transport, [
        _os(number: 7, position: 1, scheduledAt: '2026-09-01T13:00:00.000Z'),
      ]);
      harness.store.token = 'token-seedado';

      await harness.pumpApp(tester);
      await _settle(tester);

      // O bloco de agendamento diz AGENDADA; a fila diz a posição. Nunca
      // "PRÓXIMA OS" para os dois.
      expect(find.text('PRÓXIMA AGENDADA'), findsOneWidget);
      expect(find.text('PRÓXIMA OS'), findsNothing);
    });

    testWidgets('a mesma OS não aparece como card duas vezes', (tester) async {
      _tela(tester);
      final harness = Harness();
      _base(harness.transport);
      _ordersList(harness.transport, [
        7,
      ], scheduledAt: '2026-09-01T13:00:00.000Z');
      _queue(harness.transport, [
        _os(number: 7, position: 1, scheduledAt: '2026-09-01T13:00:00.000Z'),
      ]);
      harness.store.token = 'token-seedado';

      await harness.pumpApp(tester);
      await _settle(tester);

      // Card em ATENÇÃO AGORA; no bloco de agendamento ela é uma LINHA.
      expect(find.byKey(const Key('attention-order-os-7')), findsOneWidget);
      expect(find.byKey(const Key('scheduled-order-os-7')), findsOneWidget);
      // Duas representações, UM card só: a OS aparece uma vez como cartão e
      // uma vez como linha de agendamento.
      expect(_ordemNaTela(tester).where((n) => n == 7).length, 1);
    });
  });

  group('F-8 · o modo de compatibilidade é DECLARADO', () {
    /*
      Servidor anterior à DQ-5 responde 404 na rota da fila. O aplicativo volta
      a ordenar sozinho — e precisa DIZER isso.

      Um fallback silencioso é pior que a ausência de fallback: a lista local
      teria a mesma aparência da fila do despachante, e o técnico seguiria uma
      sequência inventada com a confiança de estar seguindo o despacho.
    */
    void semFila(FakeTransport transport) {
      transport.onJson(
        'GET',
        '/dispatch-queue',
        status: 404,
        data: {
          'error': {'code': 'NOT_FOUND', 'message': 'Rota inexistente.'},
        },
      );
    }

    testWidgets('sem a rota, o Início marca a procedência da ordem', (
      tester,
    ) async {
      _tela(tester);
      final harness = Harness();
      _base(harness.transport);
      _ordersList(harness.transport, [5, 7]);
      semFila(harness.transport);
      harness.store.token = 'token-seedado';

      await harness.pumpApp(tester);
      await _settle(tester);

      expect(find.byKey(const Key('local-order-note')), findsOneWidget);
      // E a lista local aparece: marcar não é esconder.
      expect(_ordemNaTela(tester), isNotEmpty);
      // Sem fila não há posição: `1ª` seria um número inventado.
      expect(find.byKey(const Key('position-badge-1')), findsNothing);
    });

    testWidgets('sem a rota, Minhas Ordens marca também', (tester) async {
      _tela(tester);
      final harness = Harness();
      _base(harness.transport);
      _ordersList(harness.transport, [5, 7]);
      semFila(harness.transport);
      harness.store.token = 'token-seedado';

      await harness.pumpApp(tester);
      await _settle(tester);
      harness.goTo('/orders');
      await _settle(tester);

      expect(find.byKey(const Key('local-order-note')), findsOneWidget);
      expect(_ordemNaTela(tester), isNotEmpty);
    });

    testWidgets('com a fila autoritativa, o aviso NÃO aparece', (tester) async {
      // Controle positivo: o aviso é sobre procedência, não decoração fixa.
      _tela(tester);
      final harness = Harness();
      _base(harness.transport);
      _ordersList(harness.transport, [5, 7]);
      _queue(harness.transport, [
        _os(number: 7, position: 1),
        _os(number: 5, position: 2),
      ]);
      harness.store.token = 'token-seedado';

      await harness.pumpApp(tester);
      await _settle(tester);
      expect(find.byKey(const Key('local-order-note')), findsNothing);

      harness.goTo('/orders');
      await _settle(tester);
      expect(find.byKey(const Key('local-order-note')), findsNothing);
    });
  });

  group('F-7 · a urgência é um número no topo', () {
    testWidgets('o Hero conta as urgentes da FILA, e diz a palavra', (
      tester,
    ) async {
      /*
        O piloto reclamou de um topo que não respondia "quanto disso é
        urgente". A métrica existe para isso — e a contagem vem da fila
        autoritativa, não de uma varredura própria da lista paginada.

        O rótulo é por extenso: cor sozinha não é sinal, e o técnico daltônico
        precisa ler a mesma informação que os outros veem.
      */
      _tela(tester);
      final harness = Harness();
      _base(harness.transport);
      _ordersList(harness.transport, [5, 7, 9]);
      _queue(harness.transport, [
        _os(number: 9, position: 1, priority: 'URGENT'),
        _os(number: 7, position: 2, priority: 'URGENT'),
        _os(number: 5, position: 3),
      ]);
      harness.store.token = 'token-seedado';

      await harness.pumpApp(tester);
      await _settle(tester);

      final urgentes = find.byKey(const Key('hero-metric-URGENTES'));
      expect(urgentes, findsOneWidget);
      expect(
        find.descendant(of: urgentes, matching: find.text('2')),
        findsOneWidget,
      );
      // E o total continua sendo o total, não o de urgentes.
      expect(
        find.descendant(
          of: find.byKey(const Key('hero-metric-OS abertas')),
          matching: find.text('3'),
        ),
        findsOneWidget,
      );
    });

    testWidgets('sem urgente, a métrica não aparece zerada', (tester) async {
      // "0 URGENTES" é ruído com aparência de alarme.
      _tela(tester);
      final harness = Harness();
      _base(harness.transport);
      _ordersList(harness.transport, [5]);
      _queue(harness.transport, [_os(number: 5, position: 1)]);
      harness.store.token = 'token-seedado';

      await harness.pumpApp(tester);
      await _settle(tester);

      expect(find.byKey(const Key('hero-metric-URGENTES')), findsNothing);
      expect(find.byKey(const Key('hero-metric-URGENTE')), findsNothing);
    });
  });

  group('o técnico atualiza e a ordem acompanha', () {
    testWidgets('TESTE CENTRAL DO PILOTO: 7,5 vira 5,7 no refresh', (
      tester,
    ) async {
      _tela(tester);
      final harness = Harness();
      _base(harness.transport);
      _ordersList(harness.transport, [5, 7]);
      _queue(harness.transport, [
        _os(number: 7, position: 1),
        _os(number: 5, position: 2),
      ]);
      harness.store.token = 'token-seedado';

      await harness.pumpApp(tester);
      await _settle(tester);
      expect(_ordemNaTela(tester).take(2), [7, 5]);

      // O despachante inverte no servidor.
      _queue(harness.transport, [
        _os(number: 5, position: 1),
        _os(number: 7, position: 2),
      ]);

      // O técnico puxa para atualizar.
      await tester.fling(
        find.byType(ListView).first,
        const Offset(0, 400),
        1000,
      );
      await _settle(tester);

      expect(_ordemNaTela(tester).take(2), [5, 7]);
    });
  });

  group('erro da fila fica contido', () {
    testWidgets('a Jornada continua de pé, e há como tentar de novo', (
      tester,
    ) async {
      _tela(tester);
      final harness = Harness();
      _base(harness.transport);
      _ordersList(harness.transport, <int>[]);
      harness.transport.onJson(
        'GET',
        '/dispatch-queue',
        status: 500,
        data: {
          'error': {'code': 'INTERNAL', 'message': 'Falha no servidor.'},
        },
      );
      harness.store.token = 'token-seedado';

      await harness.pumpApp(tester);
      await _settle(tester);

      expect(find.byKey(const Key('dashboard-queue-error')), findsOneWidget);
      expect(find.byKey(const Key('dashboard-queue-retry')), findsOneWidget);
      // O card de Jornada não foi derrubado pelo erro da fila.
      expect(find.byKey(const Key('dashboard-jornada-action')), findsOneWidget);
    });
  });
}
