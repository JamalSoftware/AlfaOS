import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/fake_transport.dart';
import '../support/harness.dart';

/// INÍCIO — o card de Jornada, o card de OS, e o que cada um NÃO pode fazer:
/// inventar dado, recalcular estado, ou derrubar o outro card quando falha.
Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 8; i++) {
    await tester.pump(const Duration(milliseconds: 60));
  }
  await tester.pumpAndSettle(const Duration(milliseconds: 50));
}

void main() {
  void seedMe(FakeTransport transport) {
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
  }

  Map<String, dynamic> workdayJson({
    String state = 'NOT_STARTED',
    List<String> allowedActions = const ['CLOCK_IN'],
    List<Map<String, dynamic>> entries = const [],
    int workedMinutes = 0,
  }) => {
    'workdayId': 'wd-1',
    'date': '2026-08-29',
    'timezone': 'America/Sao_Paulo',
    'utcOffset': '-03:00',
    'state': state,
    'allowedActions': allowedActions,
    'entries': entries,
    'workedMinutes': workedMinutes,
    'breakMinutes': 0,
    'inconsistencies': <String>[],
    'pendingAdjustments': 0,
  };

  Map<String, dynamic> orderJson({
    String id = 'os-1',
    int number = 7,
    String status = 'ASSIGNED',
    String? scheduledAt,
  }) => {
    'id': id,
    'number': number,
    'status': status,
    'priority': 'NORMAL',
    'type': 'Instalação',
    'subtype': null,
    'customerName': 'Maria da Silva',
    'district': 'Centro',
    'city': 'Guaçuí',
    'scheduledAt': scheduledAt,
    'hasLocation': true,
    'updatedAt': '2026-08-27T10:00:00.000Z',
    'version': 3,
  };

  group('saudação', () {
    testWidgets('mostra o primeiro nome de quem está autenticado', (
      tester,
    ) async {
      final harness = Harness();
      seedMe(harness.transport);
      harness.transport.onJson(
        'GET',
        '/time-clock/today',
        data: {'workday': workdayJson()},
      );
      harness.transport.onJson(
        'GET',
        '/service-orders',
        data: {'items': <dynamic>[], 'nextCursor': null},
      );
      harness.store.token = 'token-seedado';

      await harness.pumpApp(tester);
      await _settle(tester);

      // "Joana Torres" → primeiro nome só, para caber na tela.
      expect(find.text('Joana'), findsOneWidget);
      expect(find.text('Joana Torres'), findsNothing);
    });
  });

  group('card Jornada', () {
    testWidgets('mostra estado, tempo trabalhado e última marcação', (
      tester,
    ) async {
      final harness = Harness();
      seedMe(harness.transport);
      harness.transport.onJson(
        'GET',
        '/time-clock/today',
        data: {
          'workday': workdayJson(
            state: 'WORKING',
            allowedActions: ['BREAK_START', 'CLOCK_OUT'],
            entries: [
              {
                'id': 'e1',
                'type': 'CLOCK_IN',
                'source': 'FIELD_APP',
                'occurredAt': '2026-08-29T11:02:00.000Z',
                'deviceOccurredAt': null,
                'latitude': null,
                'longitude': null,
                'accuracyMeters': null,
                'fromAdjustment': false,
              },
            ],
            workedMinutes: 125,
          ),
        },
      );
      harness.transport.onJson(
        'GET',
        '/service-orders',
        data: {'items': <dynamic>[], 'nextCursor': null},
      );
      harness.store.token = 'token-seedado';

      await harness.pumpApp(tester);
      await _settle(tester);

      expect(find.text('TRABALHANDO'), findsOneWidget);
      expect(find.textContaining('Trabalhado: 2h 5min'), findsOneWidget);
      // 11:02Z em -03:00 é 08:02 — o horário da EMPRESA, não o UTC cru.
      expect(find.textContaining('Entrada às 08:02'), findsOneWidget);
    });

    testWidgets('a ação vem de allowedActions — não é recalculada', (
      tester,
    ) async {
      final harness = Harness();
      seedMe(harness.transport);
      harness.transport.onJson(
        'GET',
        '/time-clock/today',
        data: {
          'workday': workdayJson(
            state: 'ON_BREAK',
            allowedActions: ['BREAK_END'],
          ),
        },
      );
      harness.transport.onJson(
        'GET',
        '/service-orders',
        data: {'items': <dynamic>[], 'nextCursor': null},
      );
      harness.store.token = 'token-seedado';

      await harness.pumpApp(tester);
      await _settle(tester);

      /*
        `ON_BREAK` só permite retorno — se o Dashboard inventasse a ação por
        conta própria (por exemplo, sempre oferecendo "encerrar"), este botão
        diria outra coisa.
      */
      expect(find.byKey(const Key('dashboard-jornada-action')), findsOneWidget);
      expect(find.text('RETORNAR DO INTERVALO'), findsOneWidget);
    });

    testWidgets('ENCERRADA não mostra ação nenhuma de bater ponto', (
      tester,
    ) async {
      final harness = Harness();
      seedMe(harness.transport);
      harness.transport.onJson(
        'GET',
        '/time-clock/today',
        data: {
          'workday': workdayJson(state: 'FINISHED', allowedActions: const []),
        },
      );
      harness.transport.onJson(
        'GET',
        '/service-orders',
        data: {'items': <dynamic>[], 'nextCursor': null},
      );
      harness.store.token = 'token-seedado';

      await harness.pumpApp(tester);
      await _settle(tester);

      expect(find.text('ENCERRADA'), findsOneWidget);
      expect(find.byKey(const Key('dashboard-jornada-action')), findsNothing);
      expect(find.text('Jornada encerrada.'), findsOneWidget);
    });

    testWidgets('tocar a ação abre a tela real de Jornada', (tester) async {
      final harness = Harness();
      seedMe(harness.transport);
      harness.transport.onJson(
        'GET',
        '/time-clock/today',
        data: {'workday': workdayJson()},
      );
      harness.transport.onJson(
        'GET',
        '/time-clock/history',
        data: {'workdays': <dynamic>[]},
      );
      harness.transport.onJson(
        'GET',
        '/time-clock/adjustments',
        data: {'adjustments': <dynamic>[]},
      );
      harness.transport.onJson(
        'GET',
        '/service-orders',
        data: {'items': <dynamic>[], 'nextCursor': null},
      );
      harness.store.token = 'token-seedado';

      await harness.pumpApp(tester);
      await _settle(tester);

      await tester.tap(find.byKey(const Key('dashboard-jornada-action')));
      await _settle(tester);

      // A tela REAL, não uma cópia — é onde a confirmação de bater ponto vive.
      expect(find.text('Minha jornada'), findsOneWidget);
    });
  });

  group('card Ordens de Serviço', () {
    testWidgets('conta total, em andamento e pendentes — sem inventar dado', (
      tester,
    ) async {
      final harness = Harness();
      seedMe(harness.transport);
      harness.transport.onJson(
        'GET',
        '/time-clock/today',
        data: {'workday': workdayJson()},
      );
      harness.transport.onJson(
        'GET',
        '/service-orders',
        data: {
          'items': [
            orderJson(id: 'os-1', status: 'ASSIGNED'),
            orderJson(id: 'os-2', number: 8, status: 'IN_PROGRESS'),
            orderJson(id: 'os-3', number: 9, status: 'PENDING'),
          ],
          'nextCursor': null,
        },
      );
      harness.store.token = 'token-seedado';

      await harness.pumpApp(tester);
      await _settle(tester);

      // os-1 ASSIGNED e os-3 PENDING contam como pendentes (2); os-2
      // IN_PROGRESS conta à parte (1). Total é a soma das três.
      expect(find.text('3'), findsOneWidget); // Total
      expect(find.text('1'), findsOneWidget); // Em andamento
      expect(find.text('2'), findsOneWidget); // Pendentes
    });

    testWidgets('PRÓXIMA OS usa o scheduledAt real — e abre o detalhe real', (
      tester,
    ) async {
      final harness = Harness();
      seedMe(harness.transport);
      harness.transport.onJson(
        'GET',
        '/time-clock/today',
        data: {'workday': workdayJson()},
      );
      harness.transport.onJson(
        'GET',
        '/service-orders',
        data: {
          'items': [
            orderJson(
              id: 'os-1',
              number: 7,
              scheduledAt: '2026-08-30T14:00:00.000Z',
            ),
          ],
          'nextCursor': null,
        },
      );
      harness.transport.onJson(
        'GET',
        '/service-orders/os-1',
        data: {
          'serviceOrder': {
            'id': 'os-1',
            'number': 7,
            'status': 'ASSIGNED',
            'priority': 'NORMAL',
            'type': 'Instalação',
            'subtype': null,
            'description': 'Sem sinal.',
            'scheduledAt': '2026-08-30T14:00:00.000Z',
            'assignedAt': '2026-08-27T09:00:00.000Z',
            'startedAt': null,
            'updatedAt': '2026-08-27T10:00:00.000Z',
            'version': 3,
            'customer': <String, dynamic>{
              'name': 'Maria da Silva',
              'phone': '(28) 99999-0001',
              'secondaryPhone': null,
              'address': 'Rua das Flores',
              'number': '84',
              'complement': null,
              'district': 'Centro',
              'city': 'Guaçuí',
              'state': 'ES',
              'zipCode': '29560-000',
              'latitude': -20.7746,
              'longitude': -41.6789,
            },
            'connection': null,
            'execution': null,
            'diagnostic': null,
          },
        },
      );
      harness.store.token = 'token-seedado';

      await harness.pumpApp(tester);
      await _settle(tester);

      expect(find.text('PRÓXIMA OS'), findsOneWidget);
      expect(find.text('Maria da Silva'), findsOneWidget);

      await tester.tap(find.text('Maria da Silva'));
      await _settle(tester);

      // A tela real do detalhe — reconhecida pelo título, que só ela mostra.
      expect(find.textContaining('OS Nº 7'), findsWidgets);
    });

    testWidgets(
      'sem scheduledAt em nenhuma OS, mostra VER MINHAS OS — sem palpite',
      (tester) async {
        /*
          §16 do escopo: sem critério autoritativo, não inventar ordenação.
          Todas as OS aqui têm `scheduledAt: null` — não existe base real para
          apontar qual é "a próxima".
        */
        final harness = Harness();
        seedMe(harness.transport);
        harness.transport.onJson(
          'GET',
          '/time-clock/today',
          data: {'workday': workdayJson()},
        );
        harness.transport.onJson(
          'GET',
          '/service-orders',
          data: {
            'items': [orderJson()],
            'nextCursor': null,
          },
        );
        harness.store.token = 'token-seedado';

        await harness.pumpApp(tester);
        await _settle(tester);

        expect(find.text('PRÓXIMA OS'), findsNothing);
        expect(
          find.byKey(const Key('dashboard-orders-see-all')),
          findsOneWidget,
        );

        await tester.tap(find.byKey(const Key('dashboard-orders-see-all')));
        await _settle(tester);

        expect(find.text('Minhas Ordens'), findsOneWidget);
      },
    );
  });

  group('um card com erro não derruba o outro', () {
    testWidgets('Jornada falha, OS continua mostrando dado real', (
      tester,
    ) async {
      final harness = Harness();
      seedMe(harness.transport);
      harness.transport.onError(
        'GET',
        '/time-clock/today',
        status: 500,
        code: 'INTERNAL',
      );
      harness.transport.onJson(
        'GET',
        '/service-orders',
        data: {
          'items': [orderJson()],
          'nextCursor': null,
        },
      );
      harness.store.token = 'token-seedado';

      await harness.pumpApp(tester);
      await _settle(tester);

      expect(find.text('Não foi possível carregar a jornada.'), findsOneWidget);
      // O card de OS não sabe que o de Jornada falhou.
      expect(find.text('1'), findsWidgets);
    });

    testWidgets('OS falha, Jornada continua mostrando dado real', (
      tester,
    ) async {
      final harness = Harness();
      seedMe(harness.transport);
      harness.transport.onJson(
        'GET',
        '/time-clock/today',
        data: {'workday': workdayJson(state: 'WORKING')},
      );
      harness.transport.onError(
        'GET',
        '/service-orders',
        status: 500,
        code: 'INTERNAL',
      );
      harness.store.token = 'token-seedado';

      await harness.pumpApp(tester);
      await _settle(tester);

      expect(find.text('TRABALHANDO'), findsOneWidget);
      expect(
        find.text('Não foi possível carregar suas ordens.'),
        findsOneWidget,
      );
    });
  });
}
