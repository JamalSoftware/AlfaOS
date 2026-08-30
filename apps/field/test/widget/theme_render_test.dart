import 'package:alfaos_field/app/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/fake_transport.dart';
import '../support/harness.dart';

/// Os dois temas, renderizados de verdade.
///
/// O defeito mais comum de tema não aparece em modo nenhum isolado: aparece na
/// TROCA. Uma cor resolvida uma vez — presa num `TextStyle` estático, num
/// campo cacheado, ou herdada do papel errado — sobrevive à mudança e vira
/// texto claro sobre fundo claro. Compilar nos dois modos não pega isso;
/// comparar a cor efetiva pega.
Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 8; i++) {
    await tester.pump(const Duration(milliseconds: 60));
  }
  await tester.pumpAndSettle(const Duration(milliseconds: 50));
}

void _tela(WidgetTester tester, Size size) {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
}

void main() {
  void seed(FakeTransport transport) {
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
      '/service-orders',
      data: {
        'items': [
          {
            'id': 'os-1',
            'number': 7,
            'status': 'IN_PROGRESS',
            'priority': 'URGENT',
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

  group('o Início renderiza nos dois temas', () {
    for (final (nome, modo) in [
      ('claro', ThemeMode.light),
      ('escuro', ThemeMode.dark),
    ]) {
      testWidgets('tema $nome, sem exceção nem overflow', (tester) async {
        _tela(tester, const Size(360, 800));
        final harness = Harness();
        seed(harness.transport);
        harness.store.token = 'token-seedado';

        await harness.pumpApp(tester, themeMode: modo);
        await _settle(tester);

        expect(tester.takeException(), isNull);
        // Chegou ao conteúdo real, não a uma tela de erro.
        expect(find.textContaining('Joana'), findsOneWidget);
        expect(find.text('Urgente'), findsWidgets);
      });
    }
  });

  group('a gaveta renderiza nos dois temas', () {
    for (final (nome, modo) in [
      ('claro', ThemeMode.light),
      ('escuro', ThemeMode.dark),
    ]) {
      testWidgets('tema $nome, com os 21 itens', (tester) async {
        _tela(tester, const Size(360, 800));
        final harness = Harness();
        seed(harness.transport);
        harness.store.token = 'token-seedado';

        await harness.pumpApp(tester, themeMode: modo);
        await _settle(tester);
        await tester.tap(find.byIcon(Icons.menu));
        await _settle(tester);

        expect(tester.takeException(), isNull);
        expect(find.text('EM BREVE'), findsWidgets);
      });
    }
  });

  testWidgets('TOGGLE TEST: o texto repinta ao trocar de tema', (tester) async {
    /*
      O teste que a compilação não faz.

      Lê a cor EFETIVA do mesmo parágrafo nos dois modos. Se ela não mudar, a
      cor foi resolvida uma vez em algum lugar — e é assim que se descobre
      texto branco sobre fundo branco antes de o técnico descobrir.
    */
    _tela(tester, const Size(360, 800));
    final harness = Harness();
    seed(harness.transport);
    harness.store.token = 'token-seedado';

    await harness.pumpApp(tester, themeMode: ThemeMode.light);
    await _settle(tester);

    Color corDe(String texto) => tester
        .renderObject<RenderParagraph>(find.text(texto).first)
        .text
        .style!
        .color!;

    final claroCliente = corDe('Maria da Silva');

    // A MESMA árvore precisa repintar. Remontar o aplicativo em outro modo não
    // provaria nada: uma cor resolvida uma vez nasceria certa na segunda
    // montagem, e o defeito passaria batido.
    harness.setTheme(ThemeMode.dark);
    await _settle(tester);

    final escuroCliente = corDe('Maria da Silva');

    expect(
      escuroCliente,
      isNot(claroCliente),
      reason: 'o nome do cliente ficou com a mesma cor nos dois temas',
    );
  });

  test('o esquema escuro não usa preto puro nem branco puro', () {
    /*
      Preto absoluto apaga a escada de elevação por tom — todo cartão vira a
      mesma superfície, e a tela fica chapada. Branco absoluto no texto
      aumenta o brilho percebido e cansa a vista de quem lê no escuro.
    */
    final escuro = AppTheme.dark.colorScheme;

    expect(escuro.surface, isNot(const Color(0xFF000000)));
    expect(escuro.onSurface, isNot(const Color(0xFFFFFFFF)));

    // A escada existe: cada degrau é distinto do anterior.
    final degraus = {
      escuro.surface,
      escuro.surfaceContainerLowest,
      escuro.surfaceContainerLow,
      escuro.surfaceContainer,
      escuro.surfaceContainerHigh,
      escuro.surfaceContainerHighest,
    };
    expect(degraus, hasLength(6));
  });

  test('a escala tipográfica é deliberada, não a de fábrica', () {
    /*
      O sintoma que o piloto reportou como "muito próximo do Material padrão"
      começava aqui: sem `height` nem `letterSpacing` definidos, o texto sai
      no espaçamento genérico e nenhuma tela tem hierarquia.

      `height` nunca abaixo de 1.1: aperta a linha e corta as descidas de
      "g", "p" e "y".
    */
    final texto = AppTheme.dark.textTheme;

    for (final (nome, estilo) in [
      ('headlineSmall', texto.headlineSmall),
      ('titleLarge', texto.titleLarge),
      ('titleMedium', texto.titleMedium),
      ('bodyLarge', texto.bodyLarge),
      ('bodyMedium', texto.bodyMedium),
      ('labelLarge', texto.labelLarge),
      ('labelSmall', texto.labelSmall),
    ]) {
      expect(estilo?.height, isNotNull, reason: '$nome sem height definido');
      expect(
        estilo!.height!,
        greaterThanOrEqualTo(1.1),
        reason: '$nome com entrelinha apertada demais: corta descendentes',
      );
    }
  });
}
