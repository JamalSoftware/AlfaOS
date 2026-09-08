import 'package:alfaos_field/features/network/ui/network_section.dart';
import 'package:alfaos_field/features/orders/ui/order_detail_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/fake_transport.dart';
import '../support/harness.dart';

/// # `CTO-2.5` — a seção de rede na tela da OS
///
/// Os testes montam a TELA REAL do detalhe, e não a seção isolada: é assim que
/// ela existe em campo, e o portão de status, a rolagem e a barra de mensagem
/// só significam alguma coisa dentro dela.
///
/// Todas as fixturas são fictícias.
void main() {
  const base = '/service-orders/os-1/network';

  Map<String, dynamic> detail({
    String status = 'IN_PROGRESS',
    int version = 3,
  }) => {
    'serviceOrder': {
      'id': 'os-1',
      'number': 7,
      'status': status,
      'priority': 'NORMAL',
      'type': 'Instalação',
      'subtype': null,
      'description': 'Sem sinal no cliente.',
      'scheduledAt': null,
      'assignedAt': '2026-09-01T09:00:00.000Z',
      'startedAt': status == 'IN_PROGRESS' ? '2026-09-01T10:00:00.000Z' : null,
      'updatedAt': '2026-09-01T10:00:00.000Z',
      'version': version,
      'customer': <String, dynamic>{
        'name': 'Maria da Silva',
        'phone': null,
        'secondaryPhone': null,
        'address': 'Rua das Flores',
        'number': '84',
        'complement': null,
        'district': 'Centro',
        'city': 'Cidade Ficticia',
        'state': 'ES',
        'zipCode': '29560-000',
        'latitude': null,
        'longitude': null,
      },
      'connection': null,
      'execution': null,
      'diagnostic': null,
    },
  };

  Map<String, dynamic> porta({
    String id = 'porta-4',
    int number = 4,
    String state = 'AVAILABLE',
    bool occupied = false,
    bool available = true,
  }) => {
    'id': id,
    'number': number,
    'administrativeState': state,
    'occupied': occupied,
    'availableForConnection': available,
  };

  Map<String, dynamic> vinculo({
    String state = 'AVAILABLE',
    String ctoName = 'CTO Central',
    bool ctoActive = true,
    int number = 4,
  }) => {
    'connection': {
      'connectionId': 'vinc-1',
      'cto': {
        'id': 'cto-1',
        'name': ctoName,
        'code': 'CX-01',
        'active': ctoActive,
      },
      'port': porta(
        number: number,
        state: state,
        occupied: true,
        available: false,
      ),
      'connectedAt': '2026-09-01T12:00:00.000Z',
    },
  };

  Map<String, dynamic> caixa({
    String id = 'cto-1',
    String name = 'CTO Central',
    List<Map<String, dynamic>>? ports,
  }) => {
    'cto': {
      'id': id,
      'name': name,
      'code': 'CX-01',
      'active': true,
      'capacity': 8,
      'availablePorts': (ports ?? [porta()])
          .where((p) => p['availableForConnection'] == true)
          .length,
      'ports': ports ?? [porta()],
    },
  };

  void telaAlta() {
    final view =
        TestWidgetsFlutterBinding.instance.platformDispatcher.implicitView!;
    view.physicalSize = const Size(1080, 3000);
    view.devicePixelRatio = 1.0;
  }

  setUp(telaAlta);

  tearDown(() {
    final view =
        TestWidgetsFlutterBinding.instance.platformDispatcher.implicitView!;
    view.resetPhysicalSize();
    view.resetDevicePixelRatio();
  });

  Future<Harness> abrir(
    WidgetTester tester, {
    String status = 'IN_PROGRESS',
    Map<String, dynamic>? rede,
  }) async {
    final h = Harness();
    h.transport.onJson(
      'GET',
      '/service-orders/os-1',
      data: detail(status: status),
    );
    h.transport.onJson('GET', base, data: rede ?? {'connection': null});
    await h.pump(tester, const OrderDetailScreen(orderId: 'os-1'));
    await tester.pumpAndSettle();
    return h;
  }

  // -------------------------------------------------------------------------
  // Leitura
  // -------------------------------------------------------------------------

  group('leitura', () {
    testWidgets('FU-01 sem vínculo diz isso e oferece vincular', (
      tester,
    ) async {
      await abrir(tester);
      expect(find.byKey(const Key('network-empty')), findsOneWidget);
      expect(find.byKey(const Key('network-connect')), findsOneWidget);
      expect(find.byKey(const Key('network-move')), findsNothing);
      expect(find.byKey(const Key('network-disconnect')), findsNothing);
    });

    testWidgets('FU-02 com vínculo mostra CTO e porta pelo NÚMERO', (
      tester,
    ) async {
      await abrir(tester, rede: vinculo(number: 4));
      expect(find.text('CTO Central'), findsOneWidget);
      expect(find.text('Porta 04'), findsOneWidget);
      expect(find.text('CX-01'), findsOneWidget);
      // Nenhum id interno na tela do técnico.
      expect(find.textContaining('vinc-1'), findsNothing);
      expect(find.textContaining('porta-4'), findsNothing);
      expect(find.byKey(const Key('network-connect')), findsNothing);
    });

    testWidgets('FU-03 DANIFICADA e OCUPADA mostra as DUAS', (tester) async {
      await abrir(tester, rede: vinculo(state: 'DAMAGED'));
      expect(find.byKey(const Key('network-badge-occupied')), findsOneWidget);
      expect(find.byKey(const Key('network-badge-admin')), findsOneWidget);
      expect(find.text('Ocupada'), findsOneWidget);
      // Colapsar em "Ocupada" apagaria justamente a informação que fez alguém
      // marcar a porta.
      expect(find.text('Danificada'), findsOneWidget);
      // E continua operável: desativar não pode aprisionar quem está dentro.
      expect(find.byKey(const Key('network-move')), findsOneWidget);
      expect(find.byKey(const Key('network-disconnect')), findsOneWidget);
      expect(find.byKey(const Key('network-connect')), findsNothing);
    });

    testWidgets('FU-04 legado RESERVADA e OCUPADA mostra as DUAS', (
      tester,
    ) async {
      await abrir(tester, rede: vinculo(state: 'RESERVED'));
      expect(find.text('Ocupada'), findsOneWidget);
      expect(find.text('Reservada'), findsOneWidget);
      expect(find.byKey(const Key('network-disconnect')), findsOneWidget);
    });

    testWidgets('FU-04b estado que este APK não conhece não some nem estoura', (
      tester,
    ) async {
      await abrir(tester, rede: vinculo(state: 'ALGO_NOVO'));
      expect(find.byKey(const Key('network-badge-admin')), findsOneWidget);
      expect(find.text('Estado desconhecido'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('FU-14 CTO inativa continua permitindo sair', (tester) async {
      await abrir(tester, rede: vinculo(ctoActive: false));
      expect(find.text('CTO inativa'), findsOneWidget);
      expect(find.byKey(const Key('network-move')), findsOneWidget);
      expect(find.byKey(const Key('network-disconnect')), findsOneWidget);
    });

    testWidgets('FU-05 fora de atendimento não oferece mutação nem lê', (
      tester,
    ) async {
      final h = await abrir(tester, status: 'ASSIGNED');
      expect(find.byKey(const Key('network-locked')), findsOneWidget);
      expect(find.byKey(const Key('network-connect')), findsNothing);
      expect(find.byKey(const Key('network-move')), findsNothing);
      expect(find.byKey(const Key('network-disconnect')), findsNothing);
      // A leitura também exige atendimento em andamento: chamar assim mesmo
      // produziria um 409 garantido a cada abertura de OS.
      expect(h.transport.countOf('GET', base), 0);
    });

    testWidgets('FU-05b OS concluída também não oferece mutação', (
      tester,
    ) async {
      await abrir(tester, status: 'COMPLETED');
      expect(find.byKey(const Key('network-locked')), findsOneWidget);
      expect(find.byKey(const Key('network-connect')), findsNothing);
    });

    testWidgets('falha de leitura oferece nova tentativa', (tester) async {
      final h = Harness();
      h.transport.onJson('GET', '/service-orders/os-1', data: detail());
      h.transport.onError(
        'GET',
        base,
        status: 500,
        code: 'INTERNAL',
        message: 'Erro interno do servidor.',
        retryable: true,
      );
      await h.pump(tester, const OrderDetailScreen(orderId: 'os-1'));
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('network-retry')), findsOneWidget);
      h.transport.onJson('GET', base, data: vinculo());
      await tester.tap(find.byKey(const Key('network-retry')));
      await tester.pumpAndSettle();
      expect(find.text('Porta 04'), findsOneWidget);
    });
  });

  // -------------------------------------------------------------------------
  // Vincular
  // -------------------------------------------------------------------------

  group('vincular', () {
    Future<Harness> comCandidatas(
      WidgetTester tester, {
      List<Map<String, dynamic>>? ctos,
      List<Map<String, dynamic>>? ports,
    }) async {
      final h = await abrir(tester);
      h.transport.onJson(
        'GET',
        '$base/ctos',
        data: {
          'ctos':
              ctos ??
              [
                {
                  'id': 'cto-1',
                  'name': 'CTO Central',
                  'code': 'CX-01',
                  'active': true,
                  'capacity': 8,
                  'availablePorts': 3,
                },
              ],
        },
      );
      h.transport.onJson('GET', '$base/ctos/cto-1', data: caixa(ports: ports));
      return h;
    }

    testWidgets('FU-08 escolher caixa, porta e confirmar vincula', (
      tester,
    ) async {
      final h = await comCandidatas(tester);
      h.transport.onJson(
        'POST',
        '$base/connect',
        data: {
          'connection': {
            'connectionId': 'vinc-1',
            'ctoId': 'cto-1',
            'ctoPortId': 'porta-4',
            'portNumber': 4,
          },
          'previous': null,
        },
      );

      await tester.tap(find.byKey(const Key('network-connect')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('network-cto-cto-1')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('network-port-porta-4')));
      await tester.pumpAndSettle();

      // O resumo é lido em NOME e NÚMERO, nunca em id.
      expect(find.text('CTO Central'), findsWidgets);
      expect(find.text('Porta 04'), findsWidgets);

      // A resposta do servidor é quem manda no estado seguinte.
      h.transport.onJson('GET', base, data: vinculo());
      await tester.tap(find.byKey(const Key('network-confirm')));
      await tester.pumpAndSettle();

      expect(h.transport.countOf('POST', '$base/connect'), 1);
      expect(find.byKey(const Key('network-empty')), findsNothing);
      expect(find.byKey(const Key('network-disconnect')), findsOneWidget);
      expect(
        find.textContaining('Cliente vinculado à porta 04'),
        findsOneWidget,
      );
    });

    testWidgets('FU-07 duplo toque no confirmar não duplica a requisição', (
      tester,
    ) async {
      final h = await comCandidatas(tester);
      h.transport.on(
        'POST',
        '$base/connect',
        FakeReply(
          status: 201,
          body: {
            'ok': true,
            'data': {'connection': null, 'previous': null},
          },
          delay: const Duration(milliseconds: 120),
        ),
      );

      await tester.tap(find.byKey(const Key('network-connect')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('network-cto-cto-1')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('network-port-porta-4')));
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const Key('network-confirm')));
      await tester.pump(const Duration(milliseconds: 20));
      // Segundo toque com o comando EM VOO.
      await tester.tap(
        find.byKey(const Key('network-confirm')),
        warnIfMissed: false,
      );
      await tester.pumpAndSettle();

      expect(h.transport.countOf('POST', '$base/connect'), 1);
    });

    testWidgets('FU-09 porta ocupada no intervalo recusa e relê', (
      tester,
    ) async {
      final h = await comCandidatas(tester);
      h.transport.onError(
        'POST',
        '$base/connect',
        status: 409,
        code: 'CONFLICT',
        message: 'Esta porta já está ocupada por outro cliente.',
        conflict: true,
      );

      await tester.tap(find.byKey(const Key('network-connect')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('network-cto-cto-1')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('network-port-porta-4')));
      await tester.pumpAndSettle();

      // Enquanto o técnico decidia, outra pessoa conectou este mesmo cliente.
      h.transport.onJson('GET', base, data: vinculo(ctoName: 'CTO Outra'));
      await tester.tap(find.byKey(const Key('network-confirm')));
      await tester.pumpAndSettle();

      // A folha some, a recusa fica NA SEÇÃO, e o estado é o do servidor.
      expect(find.byKey(const Key('network-confirm')), findsNothing);
      expect(find.byKey(const Key('network-action-error')), findsOneWidget);
      expect(find.textContaining('já está ocupada'), findsOneWidget);
      expect(find.text('CTO Outra'), findsOneWidget);
      expect(find.textContaining('Cliente vinculado'), findsNothing);
    });

    testWidgets('FU-06 sem rede a operação não acontece e não é enfileirada', (
      tester,
    ) async {
      final h = await comCandidatas(tester);

      await tester.tap(find.byKey(const Key('network-connect')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('network-cto-cto-1')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('network-port-porta-4')));
      await tester.pumpAndSettle();

      h.transport.offline = true;
      await tester.tap(find.byKey(const Key('network-confirm')));
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('network-action-error')), findsOneWidget);
      expect(find.textContaining('precisa de internet'), findsOneWidget);
      // Nada de "tentaremos sincronizar depois": seria falso.
      expect(find.textContaining('sincroniz'), findsNothing);
      expect(find.textContaining('Cliente vinculado'), findsNothing);
      // A seção continua no estado de antes.
      expect(find.byKey(const Key('network-empty')), findsOneWidget);
    });

    testWidgets('FU-15 caixa sem porta livre mostra vazio e não confirma', (
      tester,
    ) async {
      final h = await comCandidatas(
        tester,
        ports: [
          porta(id: 'p1', number: 1, occupied: true, available: false),
          porta(id: 'p2', number: 2, state: 'DAMAGED', available: false),
        ],
      );
      await tester.tap(find.byKey(const Key('network-connect')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('network-cto-cto-1')));
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('network-port-empty')), findsOneWidget);
      expect(find.byKey(const Key('network-confirm')), findsNothing);
      // Nunca sugerir a reservada nem a danificada como destino.
      expect(find.byKey(const Key('network-port-p1')), findsNothing);
      expect(find.byKey(const Key('network-port-p2')), findsNothing);
      expect(h.transport.countOf('POST', '$base/connect'), 0);
    });

    testWidgets('FU-15b rede sem caixa candidata mostra vazio', (tester) async {
      await comCandidatas(tester, ctos: const []);
      await tester.tap(find.byKey(const Key('network-connect')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('network-cto-empty')), findsOneWidget);
    });

    testWidgets('a busca vai ao servidor, e com debounce', (tester) async {
      final h = await comCandidatas(tester);
      await tester.tap(find.byKey(const Key('network-connect')));
      await tester.pumpAndSettle();
      expect(h.transport.countOf('GET', '$base/ctos'), 1);

      await tester.enterText(find.byKey(const Key('network-cto-search')), 'CX');
      await tester.pump(const Duration(milliseconds: 100));
      // Uma requisição por tecla gastaria a pior rede do sistema.
      expect(h.transport.countOf('GET', '$base/ctos'), 1);

      await tester.pump(const Duration(milliseconds: 400));
      await tester.pumpAndSettle();
      expect(h.transport.countOf('GET', '$base/ctos'), 2);
      expect(
        h.transport.requests
            .lastWhere((r) => r.path == '$base/ctos')
            .queryParameters['search'],
        'CX',
      );
    });
  });

  // -------------------------------------------------------------------------
  // Mover
  // -------------------------------------------------------------------------

  group('mover', () {
    Future<Harness> conectado(WidgetTester tester) async {
      final h = await abrir(tester, rede: vinculo());
      h.transport.onJson(
        'GET',
        '$base/ctos',
        data: {
          'ctos': [
            {
              'id': 'cto-2',
              'name': 'CTO Vizinha',
              'code': 'CX-02',
              'active': true,
              'capacity': 8,
              'availablePorts': 1,
            },
          ],
        },
      );
      h.transport.onJson(
        'GET',
        '$base/ctos/cto-2',
        data: {
          'cto': {
            'id': 'cto-2',
            'name': 'CTO Vizinha',
            'code': 'CX-02',
            'active': true,
            'capacity': 8,
            'availablePorts': 1,
            'ports': [porta(id: 'porta-9', number: 9)],
          },
        },
      );
      return h;
    }

    testWidgets('FU-10 mover é UMA requisição, nunca desconectar e conectar', (
      tester,
    ) async {
      final h = await conectado(tester);
      h.transport.onJson(
        'POST',
        '$base/move',
        data: {
          'connection': {
            'connectionId': 'vinc-2',
            'ctoId': 'cto-2',
            'ctoPortId': 'porta-9',
            'portNumber': 9,
          },
          'previous': {
            'connectionId': 'vinc-1',
            'ctoId': 'cto-1',
            'ctoPortId': 'porta-4',
            'portNumber': 4,
          },
        },
      );

      await tester.tap(find.byKey(const Key('network-move')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('network-cto-cto-2')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('network-port-porta-9')));
      await tester.pumpAndSettle();

      // A confirmação mostra ORIGEM e DESTINO.
      expect(find.text('DE'), findsOneWidget);
      expect(find.text('PARA'), findsOneWidget);
      expect(find.text('CTO Vizinha'), findsWidgets);

      h.transport.onJson(
        'GET',
        base,
        data: {
          'connection': {
            'connectionId': 'vinc-2',
            'cto': {
              'id': 'cto-2',
              'name': 'CTO Vizinha',
              'code': 'CX-02',
              'active': true,
            },
            'port': porta(
              id: 'porta-9',
              number: 9,
              occupied: true,
              available: false,
            ),
            'connectedAt': '2026-09-01T13:00:00.000Z',
          },
        },
      );
      await tester.tap(find.byKey(const Key('network-confirm')));
      await tester.pumpAndSettle();

      expect(h.transport.countOf('POST', '$base/move'), 1);
      // O par desconectar+conectar abriria uma janela sem vínculo.
      expect(h.transport.countOf('POST', '$base/disconnect'), 0);
      expect(h.transport.countOf('POST', '$base/connect'), 0);
      expect(find.text('Porta 09'), findsOneWidget);
    });

    testWidgets('FU-11 mover recusado relê e mostra o vínculo verdadeiro', (
      tester,
    ) async {
      final h = await conectado(tester);
      h.transport.onError(
        'POST',
        '$base/move',
        status: 409,
        code: 'CONFLICT',
        message: 'Este vínculo mudou desde que a tela foi carregada.',
        conflict: true,
      );

      await tester.tap(find.byKey(const Key('network-move')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('network-cto-cto-2')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('network-port-porta-9')));
      await tester.pumpAndSettle();

      // O despacho moveu o cliente para OUTRO lugar no intervalo.
      h.transport.onJson(
        'GET',
        base,
        data: vinculo(ctoName: 'CTO Do Despacho'),
      );
      await tester.tap(find.byKey(const Key('network-confirm')));
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('network-action-error')), findsOneWidget);
      // Jamais o destino falso.
      expect(find.text('CTO Vizinha'), findsNothing);
      expect(find.text('CTO Do Despacho'), findsOneWidget);
      expect(find.textContaining('Cliente movido'), findsNothing);
    });

    testWidgets('a porta atual não é oferecida como destino', (tester) async {
      final h = await abrir(tester, rede: vinculo());
      h.transport.onJson(
        'GET',
        '$base/ctos',
        data: {
          'ctos': [
            {
              'id': 'cto-1',
              'name': 'CTO Central',
              'code': 'CX-01',
              'active': true,
              'capacity': 8,
              'availablePorts': 1,
            },
          ],
        },
      );
      // A porta 4 chega OCUPADA — o próprio cliente está nela.
      h.transport.onJson(
        'GET',
        '$base/ctos/cto-1',
        data: {
          'cto': {
            'id': 'cto-1',
            'name': 'CTO Central',
            'code': 'CX-01',
            'active': true,
            'capacity': 8,
            'availablePorts': 1,
            'ports': [
              porta(id: 'porta-4', number: 4, occupied: true, available: false),
              porta(id: 'porta-5', number: 5),
            ],
          },
        },
      );

      await tester.tap(find.byKey(const Key('network-move')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('network-cto-cto-1')));
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('network-port-porta-4')), findsNothing);
      expect(find.byKey(const Key('network-port-porta-5')), findsOneWidget);
    });
  });

  // -------------------------------------------------------------------------
  // Desconectar
  // -------------------------------------------------------------------------

  group('desconectar', () {
    testWidgets('FU-12 envia o vínculo QUE A TELA VIU', (tester) async {
      final h = await abrir(tester, rede: vinculo());
      h.transport.onJson(
        'POST',
        '$base/disconnect',
        data: {
          'connection': null,
          'previous': {
            'connectionId': 'vinc-1',
            'ctoId': 'cto-1',
            'ctoPortId': 'porta-4',
            'portNumber': 4,
          },
        },
      );

      await tester.tap(find.byKey(const Key('network-disconnect')));
      await tester.pumpAndSettle();
      expect(find.textContaining('histórico será preservado'), findsOneWidget);

      h.transport.onJson('GET', base, data: {'connection': null});
      await tester.tap(find.byKey(const Key('network-disconnect-confirm')));
      await tester.pumpAndSettle();

      final corpo =
          h.transport.requestFor('POST', '$base/disconnect').data
              as Map<String, dynamic>;
      expect(corpo['expectedConnectionId'], 'vinc-1');
      expect(corpo.containsKey('customerId'), isFalse);
      expect(find.byKey(const Key('network-empty')), findsOneWidget);
      expect(find.textContaining('Cliente desconectado'), findsOneWidget);
    });

    testWidgets('FU-13 recusado, NÃO remove o vínculo novo da tela', (
      tester,
    ) async {
      final h = await abrir(tester, rede: vinculo());
      h.transport.onError(
        'POST',
        '$base/disconnect',
        status: 409,
        code: 'CONFLICT',
        message: 'Este vínculo mudou desde que a tela foi carregada.',
        conflict: true,
      );

      await tester.tap(find.byKey(const Key('network-disconnect')));
      await tester.pumpAndSettle();

      // Entre a leitura e a confirmação, o despacho moveu o cliente.
      h.transport.onJson(
        'GET',
        base,
        data: vinculo(ctoName: 'CTO Nova', number: 9),
      );
      await tester.tap(find.byKey(const Key('network-disconnect-confirm')));
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('network-action-error')), findsOneWidget);
      expect(find.byKey(const Key('network-empty')), findsNothing);
      expect(find.text('CTO Nova'), findsOneWidget);
      expect(find.text('Porta 09'), findsOneWidget);
      expect(find.textContaining('Cliente desconectado'), findsNothing);
    });

    testWidgets('cancelar não envia nada', (tester) async {
      final h = await abrir(tester, rede: vinculo());
      await tester.tap(find.byKey(const Key('network-disconnect')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Cancelar'));
      await tester.pumpAndSettle();
      expect(h.transport.countOf('POST', '$base/disconnect'), 0);
      expect(find.text('Porta 04'), findsOneWidget);
    });
  });

  // -------------------------------------------------------------------------
  // Resiliência de layout
  // -------------------------------------------------------------------------

  group('layout', () {
    testWidgets('FU-16 nome longo de CTO não estoura e não esconde a porta', (
      tester,
    ) async {
      final view =
          TestWidgetsFlutterBinding.instance.platformDispatcher.implicitView!;
      view.physicalSize = const Size(320, 3000);
      view.devicePixelRatio = 1.0;

      await abrir(
        tester,
        rede: vinculo(
          ctoName:
              'CTO Distribuicao Bairro Sao Sebastiao das Aguas Claras Poste 4471 '
              'Ramal Secundario Norte',
          state: 'DAMAGED',
        ),
      );

      expect(tester.takeException(), isNull);
      // O número da porta é a informação que o técnico procura: ele não pode
      // ser empurrado para fora por um nome comprido.
      expect(find.byKey(const Key('network-port')), findsOneWidget);
      expect(find.text('Porta 04'), findsOneWidget);
      expect(find.text('Danificada'), findsOneWidget);
    });

    testWidgets('390x844 com escala de texto grande não estoura', (
      tester,
    ) async {
      final view =
          TestWidgetsFlutterBinding.instance.platformDispatcher.implicitView!;
      view.physicalSize = const Size(390, 844);
      view.devicePixelRatio = 1.0;

      final h = Harness();
      h.transport.onJson('GET', '/service-orders/os-1', data: detail());
      h.transport.onJson('GET', base, data: vinculo(state: 'DAMAGED'));
      /*
        A escala precisa vir DE DENTRO do MaterialApp.

        A primeira versão montava um `MediaQuery` e depois chamava
        `h.pump`, que substitui a árvore inteira pelo MaterialApp do harness —
        a escala era descartada e o teste passava sem nunca ter testado texto
        grande.
      */
      await h.pump(
        tester,
        Builder(
          builder: (context) => MediaQuery(
            data: MediaQuery.of(context)
                .copyWith(textScaler: const TextScaler.linear(1.3)),
            child: const OrderDetailScreen(orderId: 'os-1'),
          ),
        ),
      );
      await tester.pumpAndSettle();

      /*
        Rolar até a seção é PARTE do teste.

        Numa `ListView` de tela real, o que está fora da viewport nem é
        construído — e a primeira versão deste teste passou duas vezes pelo
        motivo errado: sem a rolagem, não havia widget para estourar. É também
        o que o técnico faz: a rede fica abaixo do cliente e do diagnóstico.
      */
      await tester.scrollUntilVisible(
        find.byKey(const Key('network-port')),
        300,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.pumpAndSettle();

      final texto = tester.widget<Text>(find.byKey(const Key('network-port')));
      expect(texto.data, 'Porta 04');
      expect(find.text('Danificada'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('os botões de rede respeitam 48dp', (tester) async {
      await abrir(tester, rede: vinculo());
      for (final chave in ['network-move', 'network-disconnect']) {
        final tamanho = tester.getSize(find.byKey(Key(chave)));
        expect(tamanho.height, greaterThanOrEqualTo(48.0), reason: chave);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Fronteira Field/Admin em runtime
  // -------------------------------------------------------------------------

  testWidgets('FU-17 nenhuma requisição sai para a API administrativa', (
    tester,
  ) async {
    final h = await abrir(tester, rede: vinculo());
    h.transport.onJson('GET', '$base/ctos', data: {'ctos': []});
    await tester.tap(find.byKey(const Key('network-move')));
    await tester.pumpAndSettle();

    for (final req in h.transport.requests) {
      expect(req.path, isNot(contains('cto-connections')));
    }
  });

  testWidgets('FU-18 nenhum segredo de PPPoE chega à seção de rede', (
    tester,
  ) async {
    /*
      Escopado à SEÇÃO, e não à tela.

      A primeira versão procurava "PPPoE" no detalhe inteiro e falhou — na
      seção de PPPoE, que é legítima, tem porta própria e é auditada
      (`docs/SECURITY.md` §8.9). Um teste que confunde as duas mede vazamento
      onde há contrato.
    */
    await abrir(tester, rede: vinculo());
    final secao = find.byType(NetworkSection);
    expect(secao, findsOneWidget);
    for (final proibido in ['pppoe', 'PPPoE', 'senha', 'Senha', 'password']) {
      expect(
        find.descendant(of: secao, matching: find.textContaining(proibido)),
        findsNothing,
        reason: proibido,
      );
    }
    // Controle positivo: a seção realmente foi encontrada e tem conteúdo.
    expect(
      find.descendant(of: secao, matching: find.text('Porta 04')),
      findsOneWidget,
    );
  });
}
