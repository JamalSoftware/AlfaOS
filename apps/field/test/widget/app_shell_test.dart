import 'package:alfaos_field/app/widgets/workspace_menu.dart';
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

/// Tela alta o suficiente para a gaveta INTEIRA caber sem rolagem.
///
/// O `ListView` só constrói o que está visível: num aparelho comum os últimos
/// itens da gaveta não existem na árvore, e uma asserção sobre eles falharia
/// por viewport, não por defeito. Aqui o teste é sobre CONTEÚDO — quais itens
/// e categorias a gaveta apresenta —, então a tela é esticada para tirar a
/// rolagem da equação.
///
/// Isto não esconde problema de tela pequena: o comportamento em largura real
/// tem teste próprio ("responsividade"), que usa dimensões de aparelho.
void _telaAlta(WidgetTester tester) {
  tester.view.physicalSize = const Size(1200, 3200);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
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

    testWidgets('F. Mapa NÃO é destino da barra principal', (tester) async {
      /*
        Prova negativa, complementar ao teste C. O Mapa passou a aparecer na
        GAVETA como planejado (§256, revisada depois do primeiro piloto) — mas
        continua fora da barra, que é só para o que está implementado e
        operacional. As duas superfícies têm políticas diferentes de propósito.
      */
      final harness = Harness();
      seedAuthenticated(harness.transport);
      harness.store.token = 'token-seedado';

      await harness.pumpApp(tester);
      await _settle(tester);

      final destinations = tester.widgetList<NavigationDestination>(
        find.byType(NavigationDestination),
      );
      expect(
        destinations.where((d) => d.label.toLowerCase().contains('mapa')),
        isEmpty,
      );
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

    testWidgets('H. a gaveta apresenta o Workspace INTEIRO, por categoria', (
      tester,
    ) async {
      /*
        A política do §256 foi REVISTA depois do primeiro piloto físico.

        Antes: "item que não existe não aparece" — e este teste afirmava a
        ausência de CLIENTES, MEU TRABALHO e REDE. O piloto mostrou o custo: a
        gaveta com seis linhas não comunicava o produto, e o técnico não tinha
        como saber o que o AlfaOS pretende cobrir.

        Agora a gaveta é o mapa do Workspace. A honestidade não sumiu — ela
        mudou de lugar: está no selo EM BREVE e na ausência de rota (testes
        C/E/F abaixo), não na omissão do item.
      */
      _telaAlta(tester);
      final harness = Harness();
      seedAuthenticated(harness.transport);
      harness.store.token = 'token-seedado';

      await harness.pumpApp(tester);
      await _settle(tester);

      await tester.tap(find.byIcon(Icons.menu));
      await _settle(tester);

      // A. todas as categorias aprovadas aparecem.
      for (final categoria in workspaceMenu.map((s) => s.category.label)) {
        expect(
          find.text(categoria),
          findsOneWidget,
          reason: 'categoria ausente: $categoria',
        );
      }

      /*
        B. TODOS os itens do registry aparecem — implementados e planejados.

        A varredura sai do próprio `workspaceMenu` em vez de uma lista copiada
        no teste: um item novo passa a ser exigido aqui sem ninguém precisar
        lembrar de acrescentá-lo, e um item removido do registry não deixa uma
        asserção órfã afirmando algo que já não existe.
      */
      for (final item in workspaceMenu.expand((s) => s.items)) {
        expect(
          find.byKey(Key(item.testKey)),
          findsOneWidget,
          reason: 'item ausente: ${item.label}',
        );
      }
    });

    testWidgets('C. item planejado tem indicador visível — não só opacidade', (
      tester,
    ) async {
      _telaAlta(tester);
      final harness = Harness();
      seedAuthenticated(harness.transport);
      harness.store.token = 'token-seedado';

      await harness.pumpApp(tester);
      await _settle(tester);

      await tester.tap(find.byIcon(Icons.menu));
      await _settle(tester);

      /*
        O selo é TEXTO. Cor mais fraca sozinha não distingue um item planejado
        de um item desabilitado por permissão — e quem não enxerga a diferença
        de tom fica sem nenhum sinal.

        Um selo por item planejado, nem mais nem menos.
      */
      final planejados = workspaceMenu
          .expand((s) => s.items)
          .where((i) => i.isPlanned)
          .length;
      expect(planejados, greaterThan(0));
      expect(find.text('EM BREVE'), findsNWidgets(planejados));
    });

    testWidgets('D. item IMPLEMENTADO navega de verdade', (tester) async {
      final harness = Harness();
      seedAuthenticated(harness.transport);
      harness.store.token = 'token-seedado';

      await harness.pumpApp(tester);
      await _settle(tester);

      await tester.tap(find.byIcon(Icons.menu));
      await _settle(tester);
      await tester.tap(find.byKey(const Key('drawer-orders')));
      await _settle(tester);

      // Controle positivo do teste E: a gaveta NAVEGA quando há rota.
      expect(find.text('Minhas Ordens'), findsOneWidget);
      expect(find.text('Maria da Silva'), findsOneWidget);
    });

    testWidgets('E/F. item PLANEJADO não navega — abre a folha única', (
      tester,
    ) async {
      _telaAlta(tester);
      final harness = Harness();
      seedAuthenticated(harness.transport);
      harness.store.token = 'token-seedado';

      await harness.pumpApp(tester);
      await _settle(tester);

      await tester.tap(find.byIcon(Icons.menu));
      await _settle(tester);
      await tester.tap(find.byKey(const Key('drawer-escala')));
      await _settle(tester);

      // F. a superfície genérica, nomeando o módulo.
      expect(find.byKey(const Key('planned-module-sheet')), findsOneWidget);
      expect(find.text('Minha Escala'), findsWidgets);
      expect(find.text('Módulo em preparação.'), findsOneWidget);

      /*
        E. e NENHUMA rota falsa foi criada.

        O aplicativo continua na aba de origem — o Início, com o seu título.
        Uma rota placeholder teria trocado a tela, e é exatamente isso que a
        política revisada proíbe: planejado nunca aparenta estar pronto.
      */
      expect(find.text('AlfaOS Field'), findsOneWidget);

      await tester.tap(find.byKey(const Key('planned-module-ack')));
      await _settle(tester);
      expect(find.byKey(const Key('planned-module-sheet')), findsNothing);
    });

    testWidgets('G. Sair usa o fluxo de logout existente', (tester) async {
      _telaAlta(tester);
      final harness = Harness();
      seedAuthenticated(harness.transport);
      harness.transport.onJson(
        'POST',
        '/auth/logout',
        data: {'loggedOut': true},
      );
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

    testWidgets('a gaveta rola sem estourar num aparelho comum', (
      tester,
    ) async {
      /*
        O complemento honesto de `_telaAlta`: aqui a tela é a de um celular
        real, e a gaveta com 21 itens NÃO cabe. O que se prova é que ela rola
        em vez de estourar — sem `RenderFlex overflow`, que em Flutter aparece
        como exceção e como a faixa amarela na tela do técnico.
      */
      tester.view.physicalSize = const Size(360, 640);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);

      final harness = Harness();
      seedAuthenticated(harness.transport);
      harness.store.token = 'token-seedado';

      await harness.pumpApp(tester);
      await _settle(tester);
      await tester.tap(find.byIcon(Icons.menu));
      await _settle(tester);

      expect(tester.takeException(), isNull);

      // O último item existe depois de rolar — a lista é alcançável inteira.
      await tester.scrollUntilVisible(
        find.byKey(const Key('drawer-logout')),
        160,
        scrollable: find.byType(Scrollable).last,
      );
      expect(find.byKey(const Key('drawer-logout')), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
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
