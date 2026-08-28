import 'package:alfaos_field/features/orders/ui/order_detail_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/harness.dart';

Map<String, dynamic> detail({
  String status = 'ASSIGNED',
  int version = 3,
  String? phone = '(28) 99999-0001',
  String? secondaryPhone = '(28) 99999-0002',
  Map<String, dynamic>? connection,
  Map<String, dynamic>? diagnostic,
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
    'assignedAt': '2026-08-27T09:00:00.000Z',
    'startedAt': null,
    'updatedAt': '2026-08-27T10:00:00.000Z',
    'version': version,
    'customer': <String, dynamic>{
      'name': 'Maria da Silva',
      'phone': phone,
      'secondaryPhone': secondaryPhone,
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
    'connection': connection,
    'execution': null,
    'diagnostic': diagnostic,
  },
};

const _pppoe = {
  'id': 'conn-1',
  'type': 'PPPOE',
  'username': '11-teixeira-ftth',
  'passwordConfigured': true,
};

void main() {
  /*
    Superfície alta de propósito.

    O detalhe tem sete seções e passa de 600dp — a altura padrão do
    `WidgetTester`. Numa `ListView`, o que está fora da viewport nem é
    construído, então `find` não encontraria PPPoE nem diagnóstico e o teste
    falharia por motivo errado: não porque a tela está errada, mas porque a
    janela do teste é curta.

    Alternativa seria `scrollUntilVisible` em cada asserção, o que testaria
    rolagem em vez de conteúdo. Aqui o objeto é o conteúdo.
  */
  setUp(() {
    final view =
        TestWidgetsFlutterBinding.instance.platformDispatcher.implicitView!;
    view.physicalSize = const Size(1080, 3000);
    view.devicePixelRatio = 1.0;
  });

  tearDown(() {
    final view =
        TestWidgetsFlutterBinding.instance.platformDispatcher.implicitView!;
    view.resetPhysicalSize();
    view.resetDevicePixelRatio();
  });

  Future<Harness> abrir(
    WidgetTester tester, {
    Map<String, dynamic>? payload,
  }) async {
    final h = Harness();
    h.transport.onJson(
      'GET',
      '/service-orders/os-1',
      data: payload ?? detail(),
    );
    await h.pump(tester, const OrderDetailScreen(orderId: 'os-1'));
    await tester.pumpAndSettle();
    return h;
  }

  group('hierarquia e cliente', () {
    testWidgets('a ação principal vem antes do cadastro', (tester) async {
      await abrir(tester);

      final acao = tester.getTopLeft(find.byKey(const Key('order-start'))).dy;
      final cliente = tester.getTopLeft(find.text('Maria da Silva')).dy;
      // Quem está de pé, no sol, com uma mão, precisa da ação primeiro.
      expect(acao, lessThan(cliente));
    });

    testWidgets('mostra os DOIS telefones como botões', (tester) async {
      await abrir(tester);

      expect(find.byKey(const Key('customer-phone-0')), findsOneWidget);
      expect(find.byKey(const Key('customer-phone-1')), findsOneWidget);
      expect(find.text('(28) 99999-0001'), findsOneWidget);
      expect(find.text('(28) 99999-0002'), findsOneWidget);
    });

    testWidgets('sem telefone, diz que não há em vez de deixar vazio', (
      tester,
    ) async {
      await abrir(tester, payload: detail(phone: null, secondaryPhone: null));

      expect(find.byKey(const Key('customer-no-phone')), findsOneWidget);
      expect(find.byKey(const Key('customer-phone-0')), findsNothing);
    });

    testWidgets('endereço aparece e a coordenada NÃO', (tester) async {
      await abrir(tester);

      expect(find.textContaining('Rua das Flores, 84'), findsOneWidget);
      expect(find.byKey(const Key('open-maps')), findsOneWidget);
      expect(find.byKey(const Key('open-waze')), findsOneWidget);
      /*
        Latitude e longitude cruas não ajudam ninguém a chegar num lugar e
        ocupariam a linha do endereço. Elas existem só dentro do destino da
        navegação.
      */
      expect(find.textContaining('-20.77'), findsNothing);
      expect(find.textContaining('-41.67'), findsNothing);
    });

    testWidgets('não mostra CPF nem dado de provedor', (tester) async {
      await abrir(tester);

      expect(find.textContaining('RECEITANET'), findsNothing);
      expect(find.textContaining('externalId'), findsNothing);
      expect(find.textContaining('CPF'), findsNothing);
    });
  });

  group('PPPoE', () {
    testWidgets('sem conexão, diz que não está configurado', (tester) async {
      await abrir(tester);
      expect(find.byKey(const Key('pppoe-absent')), findsOneWidget);
      expect(find.byKey(const Key('pppoe-reveal')), findsNothing);
    });

    testWidgets('com conexão, nasce mascarado com tamanho FIXO', (
      tester,
    ) async {
      await abrir(tester, payload: detail(connection: _pppoe));

      expect(find.text('11-teixeira-ftth'), findsOneWidget);
      // Quatro pontos, sempre. Uma máscara do tamanho real vazaria o
      // comprimento da senha — informação de graça para quem tenta adivinhá-la.
      expect(find.text('••••'), findsOneWidget);
      expect(find.byKey(const Key('pppoe-reveal')), findsOneWidget);
    });

    testWidgets('revelar mostra a senha e oferece ocultar e copiar', (
      tester,
    ) async {
      final h = await abrir(tester, payload: detail(connection: _pppoe));
      h.transport.onJson(
        'POST',
        '/service-orders/os-1/pppoe/reveal',
        data: {'password': 'senha-secreta-real'},
      );

      await tester.tap(find.byKey(const Key('pppoe-reveal')));
      await tester.pumpAndSettle();

      expect(find.text('senha-secreta-real'), findsOneWidget);
      expect(find.byKey(const Key('pppoe-hide')), findsOneWidget);
      expect(find.byKey(const Key('pppoe-copy')), findsOneWidget);
    });

    testWidgets('ocultar DESCARTA o texto claro e volta à máscara', (
      tester,
    ) async {
      final h = await abrir(tester, payload: detail(connection: _pppoe));
      h.transport.onJson(
        'POST',
        '/service-orders/os-1/pppoe/reveal',
        data: {'password': 'senha-secreta-real'},
      );

      await tester.tap(find.byKey(const Key('pppoe-reveal')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('pppoe-hide')));
      await tester.pumpAndSettle();

      expect(find.text('senha-secreta-real'), findsNothing);
      expect(find.text('••••'), findsOneWidget);
    });

    testWidgets('copiar USUÁRIO não exige revelar a senha', (tester) async {
      final h = await abrir(tester, payload: detail(connection: _pppoe));

      // O botão existe já na tela mascarada.
      expect(find.byKey(const Key('pppoe-copy-username')), findsOneWidget);
      expect(find.text('••••'), findsOneWidget);

      final copiado = <MethodCall>[];
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        (call) async {
          if (call.method == 'Clipboard.setData') copiado.add(call);
          return null;
        },
      );
      addTearDown(
        () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          SystemChannels.platform,
          null,
        ),
      );

      await tester.tap(find.byKey(const Key('pppoe-copy-username')));
      await tester.pumpAndSettle();

      // Copiou o usuário, e SÓ ele.
      expect(copiado, hasLength(1));
      expect((copiado.single.arguments as Map)['text'], '11-teixeira-ftth');
      expect(find.text('Usuário copiado.'), findsOneWidget);

      /*
        E nada foi revelado.

        Este é o ponto da mudança: antes, copiar só existia depois do reveal, e
        quem precisava apenas do login para conferir no roteador era obrigado a
        expor o segredo para chegar ao botão.
      */
      expect(
        h.transport.countOf('POST', '/service-orders/os-1/pppoe/reveal'),
        0,
      );
      expect(find.text('••••'), findsOneWidget);
    });

    testWidgets('copiar SENHA só existe depois do reveal', (tester) async {
      final h = await abrir(tester, payload: detail(connection: _pppoe));

      // Antes de revelar: não há como copiar a senha.
      expect(find.byKey(const Key('pppoe-copy')), findsNothing);
      expect(find.text('COPIAR SENHA'), findsNothing);

      h.transport.onJson(
        'POST',
        '/service-orders/os-1/pppoe/reveal',
        data: {'password': 'senha-secreta-real'},
      );

      final copiado = <MethodCall>[];
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        (call) async {
          if (call.method == 'Clipboard.setData') copiado.add(call);
          return null;
        },
      );
      addTearDown(
        () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          SystemChannels.platform,
          null,
        ),
      );

      await tester.tap(find.byKey(const Key('pppoe-reveal')));
      await tester.pumpAndSettle();

      expect(find.text('COPIAR SENHA'), findsOneWidget);
      await tester.tap(find.byKey(const Key('pppoe-copy')));
      await tester.pumpAndSettle();

      expect(copiado, hasLength(1));
      expect((copiado.single.arguments as Map)['text'], 'senha-secreta-real');
      expect(find.text('Senha copiada.'), findsOneWidget);
    });

    testWidgets('as duas ações de cópia são distinguíveis', (tester) async {
      final h = await abrir(tester, payload: detail(connection: _pppoe));
      h.transport.onJson(
        'POST',
        '/service-orders/os-1/pppoe/reveal',
        data: {'password': 'senha-secreta-real'},
      );

      await tester.tap(find.byKey(const Key('pppoe-reveal')));
      await tester.pumpAndSettle();

      // Rótulo explícito: com duas cópias na mesma seção, "COPIAR" sozinho
      // deixaria o técnico adivinhando qual delas ele tocou.
      expect(find.text('COPIAR SENHA'), findsOneWidget);
      expect(find.text('COPIAR'), findsNothing);
      expect(find.byKey(const Key('pppoe-copy-username')), findsOneWidget);
    });

    testWidgets('a senha não vem no detalhe — só na revelação', (tester) async {
      final h = await abrir(tester, payload: detail(connection: _pppoe));

      // O detalhe já carregou e nenhuma revelação foi pedida.
      expect(
        h.transport.countOf('POST', '/service-orders/os-1/pppoe/reveal'),
        0,
      );
      expect(find.text('••••'), findsOneWidget);
    });
  });

  group('diagnóstico', () {
    testWidgets('mostra o estado e o momento da leitura', (tester) async {
      await abrir(
        tester,
        payload: detail(
          diagnostic: {
            'connectivityStatus': 'ONLINE',
            'observedAt': DateTime.now()
                .subtract(const Duration(minutes: 5))
                .toIso8601String(),
          },
        ),
      );

      expect(find.byKey(const Key('diagnostic-status')), findsOneWidget);
      expect(find.text('Online'), findsOneWidget);
      expect(find.textContaining('há 5 min'), findsOneWidget);
    });

    testWidgets('falha ao atualizar NÃO vira offline falso', (tester) async {
      final h = await abrir(
        tester,
        payload: detail(
          diagnostic: {
            'connectivityStatus': 'ONLINE',
            'observedAt': '2026-08-27T09:00:00.000Z',
          },
        ),
      );
      h.transport.onError(
        'POST',
        '/service-orders/os-1/diagnostic',
        status: 503,
        code: 'UPSTREAM_UNAVAILABLE',
      );

      await tester.tap(find.byKey(const Key('diagnostic-refresh')));
      await tester.pumpAndSettle();

      /*
        "Não conseguimos falar com o provedor" e "o provedor diz que está fora"
        são fatos diferentes. Colapsar o primeiro no segundo mandaria o técnico
        procurar defeito onde não há.
      */
      expect(find.text('Online'), findsOneWidget);
      expect(find.text('Offline'), findsNothing);
      expect(find.byKey(const Key('diagnostic-warning')), findsOneWidget);
    });

    testWidgets('429 vira mensagem de espera, não erro técnico', (
      tester,
    ) async {
      final h = await abrir(tester);
      h.transport.onError(
        'POST',
        '/service-orders/os-1/diagnostic',
        status: 429,
        code: 'RATE_LIMITED',
      );

      await tester.tap(find.byKey(const Key('diagnostic-refresh')));
      await tester.pumpAndSettle();

      expect(find.textContaining('Muitas solicitações'), findsOneWidget);
    });
  });

  group('iniciar atendimento', () {
    // Dois testes, e não um com dois `pumpWidget`: montar uma segunda árvore
    // sobre a primeira reaproveita o tester e confunde o ciclo de vida dos
    // providers da árvore anterior.
    testWidgets('ASSIGNED oferece iniciar', (tester) async {
      await abrir(tester);
      expect(find.byKey(const Key('order-start')), findsOneWidget);
      expect(find.text('INICIAR ATENDIMENTO'), findsOneWidget);
    });

    testWidgets('IN_PROGRESS mostra o estado, sem botão de iniciar', (
      tester,
    ) async {
      await abrir(tester, payload: detail(status: 'IN_PROGRESS'));
      expect(find.byKey(const Key('order-start')), findsNothing);
      expect(find.byKey(const Key('order-in-progress')), findsOneWidget);
      expect(find.text('ATENDIMENTO EM ANDAMENTO'), findsOneWidget);
    });

    testWidgets('nenhuma tela oferece CONCLUIR nesta Alpha', (tester) async {
      await abrir(tester, payload: detail(status: 'IN_PROGRESS'));

      // Conclusão depende de checklist, fotos, materiais e assinatura, e a
      // validação é do servidor. Um "concluir" incompleto produziria OS
      // fechadas sem evidência.
      expect(find.textContaining('CONCLUIR'), findsNothing);
      expect(find.textContaining('Concluir'), findsNothing);
    });

    testWidgets('iniciar manda expectedVersion e Idempotency-Key', (
      tester,
    ) async {
      final h = await abrir(tester);
      h.transport.onJson(
        'POST',
        '/service-orders/os-1/start',
        data: {
          'serviceOrder': {
            'id': 'os-1',
            'number': 7,
            'status': 'IN_PROGRESS',
            'priority': 'NORMAL',
            'startedAt': '2026-08-27T11:00:00.000Z',
            'updatedAt': '2026-08-27T11:00:00.000Z',
            'version': 4,
          },
          'execution': {
            'id': 'exec-1',
            'diagnosis': null,
            'workPerformed': null,
            'notes': null,
            'version': 0,
          },
        },
      );

      await tester.tap(find.byKey(const Key('order-start')));
      await tester.pumpAndSettle();

      final request = h.transport.requestFor(
        'POST',
        '/service-orders/os-1/start',
      );
      expect((request.data as Map)['expectedVersion'], 3);
      expect(request.headers['Idempotency-Key'], isNotNull);

      // O estado novo vem do RETORNO da mutação, sem releitura.
      expect(h.transport.countOf('GET', '/service-orders/os-1'), 1);
      expect(find.byKey(const Key('order-in-progress')), findsOneWidget);
    });

    testWidgets('duplo toque não dispara duas mutações', (tester) async {
      final h = await abrir(tester);
      h.transport.onJson(
        'POST',
        '/service-orders/os-1/start',
        data: {
          'serviceOrder': {
            'id': 'os-1',
            'number': 7,
            'status': 'IN_PROGRESS',
            'priority': 'NORMAL',
            'startedAt': null,
            'updatedAt': '2026-08-27T11:00:00.000Z',
            'version': 4,
          },
          'execution': null,
        },
      );

      await tester.tap(find.byKey(const Key('order-start')));
      await tester.pump();
      // Segundo toque enquanto o primeiro ainda envia: o botão está
      // desabilitado, e a chave de idempotência cobre o resto.
      await tester.tap(
        find.byKey(const Key('order-start')),
        warnIfMissed: false,
      );
      await tester.pumpAndSettle();

      expect(h.transport.countOf('POST', '/service-orders/os-1/start'), 1);
    });

    testWidgets('409 avisa e recarrega em vez de sobrescrever', (tester) async {
      final h = await abrir(tester);
      h.transport.onError(
        'POST',
        '/service-orders/os-1/start',
        status: 409,
        code: 'CONFLICT',
        conflict: true,
        message: 'A OS foi modificada por outra requisição.',
      );

      await tester.tap(find.byKey(const Key('order-start')));
      await tester.pumpAndSettle();

      expect(find.textContaining('atualizada em outro lugar'), findsOneWidget);
      // Recarregou: o detalhe foi buscado de novo.
      expect(h.transport.countOf('GET', '/service-orders/os-1'), 2);
    });
  });

  testWidgets('OS reatribuída mostra explicação, não erro', (tester) async {
    final h = Harness();
    h.transport.onError(
      'GET',
      '/service-orders/os-1',
      status: 404,
      code: 'NOT_FOUND',
    );
    await h.pump(tester, const OrderDetailScreen(orderId: 'os-1'));
    await tester.pumpAndSettle();

    expect(
      find.text('Esta ordem não está mais atribuída a você.'),
      findsOneWidget,
    );
    expect(find.text('Tentar novamente'), findsNothing);
  });
}
