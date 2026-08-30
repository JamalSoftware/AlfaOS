import 'package:alfaos_field/app/widgets/workspace_menu.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/fake_transport.dart';
import '../support/harness.dart';

/// Ergonomia de toque, MEDIDA — não estimada.
///
/// O técnico usa o aparelho de pé, com uma mão, às vezes de luva, num poste ou
/// na casa do cliente. O mínimo do Material para Android é **48dp**, e um alvo
/// abaixo disso vira toque perdido — que em campo custa uma segunda tentativa
/// com a outra mão ocupada.
///
/// Estes testes leem o tamanho RENDERIZADO de cada alvo. Estimar por soma de
/// paddings erra: a altura final depende da fonte, do tema e da escala de
/// texto do aparelho.
const _minTouch = 48.0;

Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 8; i++) {
    await tester.pump(const Duration(milliseconds: 60));
  }
  await tester.pumpAndSettle(const Duration(milliseconds: 50));
}

void _telaAlta(WidgetTester tester) {
  tester.view.physicalSize = const Size(1200, 3200);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
}

/// Falha dizendo QUAL alvo é pequeno e por quanto — um `expect` genérico
/// mandaria procurar o culpado à mão.
void _expectTouchTarget(WidgetTester tester, Finder finder, String nome) {
  final size = tester.getSize(finder);
  expect(
    size.height,
    greaterThanOrEqualTo(_minTouch),
    reason: '$nome tem ${size.height}dp de altura; mínimo é $_minTouch',
  );
}

void main() {
  void seedAuthenticated(FakeTransport transport) {
    transport.onJson(
      'GET',
      '/me',
      data: {
        'user': {'id': 'u1', 'name': 'Tecnico Alfa', 'email': 't@a.test'},
        'technician': {'id': 't1', 'active': true, 'executionIssue': null},
        'company': {'id': 'c1', 'name': 'Alfa Telecom'},
        'device': {'id': 'd1', 'platform': 'ANDROID'},
        'capabilities': {'startOrder': true},
      },
    );
    transport.onJson(
      'GET',
      '/service-orders',
      data: {
        'items': [
          {
            'id': 'os-1',
            'number': 7,
            'status': 'ASSIGNED',
            'priority': 'NORMAL',
            'type': 'Instalação',
            'subtype': null,
            'customerName': 'Maria da Silva',
            'district': 'Centro',
            'city': 'Guaçuí',
            'scheduledAt': null,
            'hasLocation': true,
            'updatedAt': '2026-08-27T10:00:00.000Z',
            'version': 3,
          },
        ],
        'nextCursor': null,
      },
    );
    transport.onJson(
      'GET',
      '/time-clock/today',
      data: {
        'workday': {
          'workdayId': 'wd-1',
          'date': '2026-08-29',
          'timezone': 'America/Sao_Paulo',
          'utcOffset': '-03:00',
          'state': 'NOT_STARTED',
          'allowedActions': ['CLOCK_IN'],
          'entries': <dynamic>[],
          'workedMinutes': 0,
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

  group('gaveta', () {
    testWidgets('todo item tem 48dp de altura mínima', (tester) async {
      /*
        Vinte e um itens: se a densidade for apertada demais para caber mais
        linhas na tela, o toque começa a errar de linha — e errar de linha numa
        gaveta significa navegar para o lugar errado.
      */
      _telaAlta(tester);
      final harness = Harness();
      seedAuthenticated(harness.transport);
      harness.store.token = 'token-seedado';

      await harness.pumpApp(tester);
      await _settle(tester);
      await tester.tap(find.byIcon(Icons.menu));
      await _settle(tester);

      for (final item in workspaceMenu.expand((s) => s.items)) {
        _expectTouchTarget(
          tester,
          find.byKey(Key(item.testKey)),
          'item "${item.label}"',
        );
      }
    });
  });

  group('dashboard', () {
    testWidgets('a ação da jornada e o link de OS respeitam 48dp', (
      tester,
    ) async {
      _telaAlta(tester);
      final harness = Harness();
      seedAuthenticated(harness.transport);
      harness.store.token = 'token-seedado';

      await harness.pumpApp(tester);
      await _settle(tester);

      // A ação mais frequente do dia — e a que o técnico toca com pressa.
      _expectTouchTarget(
        tester,
        find.byKey(const Key('dashboard-jornada-action')),
        'ação da jornada',
      );

      _expectTouchTarget(
        tester,
        find.byKey(const Key('dashboard-see-all-orders')),
        'ver todas as OS',
      );
    });

    testWidgets('o card de OS é uma superfície de toque generosa', (
      tester,
    ) async {
      _telaAlta(tester);
      final harness = Harness();
      seedAuthenticated(harness.transport);
      harness.store.token = 'token-seedado';

      await harness.pumpApp(tester);
      await _settle(tester);

      // O card inteiro é tocável, não só o número da OS.
      _expectTouchTarget(
        tester,
        find.byKey(const Key('attention-order-os-1')),
        'card da OS',
      );
    });
  });

  group('cabeçalho', () {
    testWidgets('hambúrguer e sino respeitam 48dp', (tester) async {
      _telaAlta(tester);
      final harness = Harness();
      seedAuthenticated(harness.transport);
      harness.store.token = 'token-seedado';

      await harness.pumpApp(tester);
      await _settle(tester);

      _expectTouchTarget(tester, find.byTooltip('Abrir menu'), 'hambúrguer');
      _expectTouchTarget(
        tester,
        find.byKey(const Key('notifications-bell')),
        'sino',
      );
    });
  });
}
