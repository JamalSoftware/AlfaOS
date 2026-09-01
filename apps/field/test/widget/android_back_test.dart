import 'package:alfaos_field/app/shell_back.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/fake_transport.dart';
import '../support/harness.dart';

/// # O Voltar do Android (DQ-6, `B-1`–`B-8`)
///
/// Bug do piloto físico: o aplicativo **fechava** quando o técnico apertava
/// Voltar em telas principais. A causa é estrutural — trocar de aba num
/// `indexedStack` não empilha rota, e sem pilha o pop chega ao sistema.
///
/// Estes testes disparam o pop do SISTEMA (`handlePopRoute`), que é o mesmo
/// caminho do botão e do gesto — não um `Navigator.pop` de mentira.
Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 8; i++) {
    await tester.pump(const Duration(milliseconds: 60));
  }
  await tester.pumpAndSettle(const Duration(milliseconds: 50));
}

/// O Voltar do sistema. Devolve `true` quando o app o consumiu, e `false`
/// quando ele "sairia" — que é como o Flutter reporta o fim da pilha.
Future<bool> _back(WidgetTester tester) async {
  final consumido = await tester.binding.handlePopRoute();
  await _settle(tester);
  return consumido;
}

void _seed(FakeTransport transport) {
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
          'id': 'os-7',
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
          'updatedAt': '2026-08-31T10:00:00.000Z',
          'version': 3,
        },
      ],
      'nextCursor': null,
    },
  );
  transport.onJson(
    'GET',
    '/dispatch-queue',
    data: {
      'queueVersion': 1,
      'inProgress': <dynamic>[],
      'queued': [
        {
          'id': 'os-7',
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
          'updatedAt': '2026-08-31T10:00:00.000Z',
          'version': 3,
          'position': 1,
        },
      ],
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
        'workedMinutes': 60,
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

Future<Harness> _app(WidgetTester tester) async {
  tester.view.physicalSize = const Size(390, 900);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);

  final harness = Harness();
  _seed(harness.transport);
  harness.store.token = 'token-seedado';
  await harness.pumpApp(tester);
  await _settle(tester);
  return harness;
}

void main() {
  group('a decisão, isolada', () {
    test('a ordem das perguntas é a da expectativa', () {
      // O que está POR CIMA fecha primeiro; sair é o último recurso.
      expect(
        resolveShellBack(branchIndex: 1, drawerOpen: true),
        ShellBackAction.closeDrawer,
      );
      expect(
        resolveShellBack(branchIndex: 0, drawerOpen: true),
        ShellBackAction.closeDrawer,
      );
      expect(
        resolveShellBack(branchIndex: 1, drawerOpen: false),
        ShellBackAction.goHome,
      );
      expect(
        resolveShellBack(branchIndex: 2, drawerOpen: false),
        ShellBackAction.goHome,
      );
      expect(
        resolveShellBack(branchIndex: 0, drawerOpen: false),
        ShellBackAction.exitApp,
      );
    });
  });

  group('B-1..B-3 · as abas', () {
    testWidgets('B-1 · Início na raiz: o sistema pode sair', (tester) async {
      await _app(tester);
      // `false` = o app não consumiu o pop. É o ÚNICO lugar onde isso é certo.
      expect(await _back(tester), isFalse);
    });

    testWidgets('B-2 · OS → Voltar → Início, sem fechar o app', (tester) async {
      final harness = await _app(tester);
      harness.goTo('/orders');
      await _settle(tester);
      expect(find.text('Minhas Ordens'), findsOneWidget);

      expect(await _back(tester), isTrue);
      expect(find.text('AlfaOS Field'), findsOneWidget);
      expect(find.text('Minhas Ordens'), findsNothing);
    });

    testWidgets('B-3 · Jornada → Voltar → Início', (tester) async {
      final harness = await _app(tester);
      harness.goTo('/jornada');
      await _settle(tester);

      expect(await _back(tester), isTrue);
      expect(find.text('AlfaOS Field'), findsOneWidget);
    });

    testWidgets('e do Início, depois de voltar, o app pode sair', (
      tester,
    ) async {
      // A sequência inteira do piloto: OS → Voltar → Início → Voltar → sai.
      final harness = await _app(tester);
      harness.goTo('/orders');
      await _settle(tester);
      expect(await _back(tester), isTrue);
      expect(await _back(tester), isFalse);
    });
  });

  group('B-4, B-5 · o detalhe volta para de onde veio', () {
    testWidgets('B-4 · aberto da aba OS, volta para a aba OS', (tester) async {
      final harness = await _app(tester);
      harness.goTo('/orders');
      await _settle(tester);

      await tester.tap(find.text('OS Nº 7').first);
      await _settle(tester);
      expect(find.text('Minhas Ordens'), findsNothing);

      expect(await _back(tester), isTrue);
      // Voltou para a ABA OS — e não para o Início, que seria o erro fácil.
      expect(find.text('Minhas Ordens'), findsOneWidget);
    });

    testWidgets('B-5 · aberto do Início, volta para o Início', (tester) async {
      await _app(tester);
      await tester.tap(find.byKey(const Key('attention-order-os-7')));
      await _settle(tester);

      expect(await _back(tester), isTrue);
      expect(find.text('AlfaOS Field'), findsOneWidget);
    });
  });

  group('B-6 · a gaveta fecha, e nada mais', () {
    testWidgets('Voltar com a gaveta aberta não troca de aba nem sai', (
      tester,
    ) async {
      final harness = await _app(tester);
      harness.goTo('/orders');
      await _settle(tester);

      await tester.tap(find.byIcon(Icons.menu));
      await _settle(tester);
      expect(find.byType(Drawer), findsOneWidget);

      expect(await _back(tester), isTrue);
      expect(find.byType(Drawer), findsNothing);
      // Continua na aba OS: fechar a gaveta não é navegar.
      expect(find.text('Minhas Ordens'), findsOneWidget);
    });
  });

  group('B-7 · a folha modal fecha primeiro', () {
    testWidgets('Voltar fecha o modal e mantém a tela', (tester) async {
      final harness = await _app(tester);
      harness.goTo('/orders');
      await _settle(tester);

      await tester.tap(find.byIcon(Icons.menu));
      await _settle(tester);
      // Um item planejado abre a folha genérica "Módulo em preparação".
      await tester.tap(find.text('Meu Estoque'));
      await _settle(tester);
      expect(find.text('Módulo em preparação.'), findsOneWidget);

      expect(await _back(tester), isTrue);
      expect(find.text('Módulo em preparação.'), findsNothing);
      expect(find.text('Minhas Ordens'), findsOneWidget);
    });
  });

  group('B-8 · deep link sem histórico', () {
    testWidgets('o detalhe aberto direto não deixa o técnico sem saída', (
      tester,
    ) async {
      /*
        Um push de notificação abre `/orders/os-7` sem nada por baixo. Voltar
        precisa levar a uma superfície útil — e não fechar o aplicativo, que é
        o que faria o técnico reabrir tudo para ver a OS seguinte.
      */
      final harness = await _app(tester);
      harness.goTo('/orders/os-7');
      await _settle(tester);

      expect(await _back(tester), isTrue);
      /*
        Voltou para dentro do aplicativo, não para fora dele — e para "Minhas
        Ordens", não para o Início: quem abriu uma OS estava tratando de OS.

        O `false` aqui seria o bug do piloto na sua forma mais cruel: o técnico
        toca a notificação, vê a OS, aperta Voltar e o aplicativo fecha.
      */
      expect(find.text('Minhas Ordens'), findsOneWidget);
    });
  });
}
