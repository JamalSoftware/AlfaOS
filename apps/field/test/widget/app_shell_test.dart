import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/fake_transport.dart';
import '../support/harness.dart';

/// O App Shell: barra principal, gaveta, autenticação e deep links.
///
/// Diferente dos outros testes de widget, aqui a árvore é o APLICATIVO
/// inteiro — `Harness.pumpApp` — porque o que se prova é justamente a
/// navegação real entre telas, não o conteúdo de uma tela isolada.
Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 8; i++) {
    await tester.pump(const Duration(milliseconds: 60));
  }
  await tester.pumpAndSettle(const Duration(milliseconds: 50));
}

void main() {
  /// Registra as respostas de uma sessão autenticada com dado real de OS e
  /// Jornada — o suficiente para Início, OS e Jornada renderizarem sem erro.
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
          'scheduledAt': null,
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
      data: {'from': '2026-08-01', 'to': '2026-08-29', 'workdays': <dynamic>[]},
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

  group('A/B — autenticação decide o que aparece', () {
    testWidgets('A. sessão autenticada mostra o shell', (tester) async {
      final harness = Harness();
      seedAuthenticated(harness.transport);
      harness.store.token = 'token-seedado';

      await harness.pumpApp(tester);
      await _settle(tester);

      // O shell é a barra com os três destinos — prova indireta de que a
      // navegação chegou lá, e não ficou presa numa porta.
      expect(find.text('Início'), findsWidgets);
      expect(find.text('OS'), findsWidgets);
      expect(find.text('Jornada'), findsWidgets);
      expect(find.byType(NavigationBar), findsOneWidget);
    });

    testWidgets('B. sem sessão vai para o login, sem shell', (tester) async {
      final harness = Harness();
      // Nenhum token guardado: `bootstrap` não encontra nada para validar.

      await harness.pumpApp(tester);
      await _settle(tester);

      expect(find.byType(NavigationBar), findsNothing);
      expect(find.byKey(const Key('login-email')), findsOneWidget);
    });

    testWidgets(
      'B2. tentativa DIRETA de alcançar rota protegida sem sessão é recusada',
      (tester) async {
        /*
          B prova o caminho natural (abrir o app sem sessão cai no login). Este
          é o ataque: pedir explicitamente uma rota do shell — não o caminho
          que a navegação normal percorreria. O `redirect` precisa recusar os
          dois, e é o mesmo guard nos dois casos — mas só testar o natural
          deixaria uma tentativa deliberada sem cobertura própria.
        */
        final harness = Harness();

        await harness.pumpApp(tester);
        await _settle(tester);

        harness.goTo('/orders');
        await _settle(tester);

        expect(find.byType(NavigationBar), findsNothing);
        expect(find.text('Minhas Ordens'), findsNothing);
        expect(find.byKey(const Key('login-email')), findsOneWidget);
      },
    );
  });

  group('C-F — barra principal', () {
    testWidgets(
      'C. a barra tem exatamente Início, OS e Jornada — sem Mapa morto',
      (tester) async {
        /*
          O PRD §255 proíbe destino morto na barra enquanto o mapa não existe:
          "fica vago ou traz Agenda". Nenhum dos dois substitutos tem código
          nesta fase, e a barra fica com três — não quatro com um placeholder.
        */
        final harness = Harness();
        seedAuthenticated(harness.transport);
        harness.store.token = 'token-seedado';

        await harness.pumpApp(tester);
        await _settle(tester);

        final destinations = tester.widgetList<NavigationDestination>(
          find.byType(NavigationDestination),
        );
        expect(destinations.map((d) => d.label), ['Início', 'OS', 'Jornada']);
      },
    );

    testWidgets('D. tocar OS abre a tela real de Ordens de Serviço', (
      tester,
    ) async {
      final harness = Harness();
      seedAuthenticated(harness.transport);
      harness.store.token = 'token-seedado';

      await harness.pumpApp(tester);
      await _settle(tester);

      await tester.tap(find.text('OS').last);
      await _settle(tester);

      // A tela real, com o dado que o transporte devolveu — não um placeholder.
      expect(find.text('Minhas Ordens'), findsOneWidget);
      expect(find.text('Maria da Silva'), findsOneWidget);
    });

    testWidgets('E. tocar Jornada abre a tela real de Minha Jornada', (
      tester,
    ) async {
      final harness = Harness();
      seedAuthenticated(harness.transport);
      harness.store.token = 'token-seedado';

      await harness.pumpApp(tester);
      await _settle(tester);

      await tester.tap(find.text('Jornada').last);
      await _settle(tester);

      expect(find.text('Minha jornada'), findsOneWidget);
      // A ação vem do allowedActions que o transporte devolveu — não é
      // recalculada pelo app.
      expect(find.text('REGISTRAR ENTRADA'), findsWidgets);
    });

    testWidgets('F. não existe destino de Mapa nesta fase', (tester) async {
      /*
        Prova negativa, complementar ao teste C: nenhuma tela nem rota de mapa
        foi criada. Não há "placeholder" para verificar porque a decisão foi
        NÃO criar um — a barra some com o vago em vez de mostrar tela morta.
      */
      final harness = Harness();
      seedAuthenticated(harness.transport);
      harness.store.token = 'token-seedado';

      await harness.pumpApp(tester);
      await _settle(tester);

      expect(find.text('Mapa'), findsNothing);
      expect(find.textContaining('mapa', findRichText: true), findsNothing);
    });
  });

  group('G/H — gaveta', () {
    testWidgets('G. a gaveta abre a partir de qualquer aba', (tester) async {
      final harness = Harness();
      seedAuthenticated(harness.transport);
      harness.store.token = 'token-seedado';

      await harness.pumpApp(tester);
      await _settle(tester);

      expect(find.byType(Drawer), findsNothing);
      await tester.tap(find.byIcon(Icons.menu));
      await _settle(tester);
      expect(find.byType(Drawer), findsOneWidget);
    });

    testWidgets('H. a gaveta mostra só o que existe — nada de item cinza', (
      tester,
    ) async {
      /*
        PRD §256: "item planejado não vira item cinza". Escala, Contratos,
        Estoque, Ferramentas e Rede são PLANNED, sem tela — e não aparecem.
      */
      final harness = Harness();
      seedAuthenticated(harness.transport);
      harness.store.token = 'token-seedado';

      await harness.pumpApp(tester);
      await _settle(tester);

      await tester.tap(find.byIcon(Icons.menu));
      await _settle(tester);

      expect(find.text('OPERACIONAL'), findsOneWidget);
      expect(find.text('CONTA'), findsOneWidget);
      expect(find.byKey(const Key('drawer-inicio')), findsOneWidget);
      expect(find.byKey(const Key('drawer-orders')), findsOneWidget);
      expect(find.byKey(const Key('drawer-jornada')), findsOneWidget);
      expect(find.byKey(const Key('drawer-notifications')), findsOneWidget);
      expect(find.byKey(const Key('drawer-settings')), findsOneWidget);
      expect(find.byKey(const Key('drawer-logout')), findsOneWidget);

      // Nenhuma categoria ou item PLANNED — a lista negativa é o próprio teste.
      for (final planejado in [
        'CLIENTES',
        'MEU TRABALHO',
        'REDE',
        'Escala',
        'Contratos',
        'Estoque',
        'Ferramentas',
      ]) {
        expect(find.textContaining(planejado), findsNothing);
      }
    });
  });

  testWidgets('I. Sair usa o fluxo de logout existente', (tester) async {
    final harness = Harness();
    seedAuthenticated(harness.transport);
    harness.transport.onJson('POST', '/auth/logout', data: {'loggedOut': true});
    harness.store.token = 'token-seedado';

    await harness.pumpApp(tester);
    await _settle(tester);

    await tester.tap(find.byIcon(Icons.menu));
    await _settle(tester);
    await tester.tap(find.byKey(const Key('drawer-logout')));
    await _settle(tester);

    expect(harness.store.token, isNull);
    expect(find.byKey(const Key('login-email')), findsOneWidget);
  });

  group('J/K — rotas fora da barra continuam funcionando', () {
    testWidgets('J. navegar para /orders/:id abre o detalhe real', (
      tester,
    ) async {
      /*
        Simula chegar à OS por um caminho que não é a barra principal — uma
        notificação, um link salvo. A sessão precisa estar ASSENTADA primeiro:
        navegar durante `bootstrapping` perderia para o `redirect`, que é
        exatamente por que [Harness.goTo] existe em vez de um `initialUrl`
        aplicado antes da autenticação resolver.
      */
      final harness = Harness();
      seedAuthenticated(harness.transport);
      harness.store.token = 'token-seedado';

      await harness.pumpApp(tester);
      await _settle(tester);

      harness.goTo('/orders/os-1');
      await _settle(tester);

      expect(find.text('Maria da Silva'), findsOneWidget);
      expect(find.textContaining('OS Nº 7'), findsWidgets);
    });

    testWidgets('K. navegar para /jornada abre a tela real', (tester) async {
      final harness = Harness();
      seedAuthenticated(harness.transport);
      harness.store.token = 'token-seedado';

      await harness.pumpApp(tester);
      await _settle(tester);

      harness.goTo('/jornada');
      await _settle(tester);

      expect(find.text('Minha jornada'), findsOneWidget);
    });
  });
}
