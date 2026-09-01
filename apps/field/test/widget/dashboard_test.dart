import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/fake_transport.dart';
import '../support/harness.dart';

/// INÍCIO — hero, "Atenção agora", Jornada e Ordens.
///
/// O que cada bloco NÃO pode fazer: inventar dado, recalcular estado que é do
/// servidor, chamar de "próxima" uma OS sem horário, ou derrubar os vizinhos
/// quando a própria fonte falha.
Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 8; i++) {
    await tester.pump(const Duration(milliseconds: 60));
  }
  await tester.pumpAndSettle(const Duration(milliseconds: 50));
}

/// Tela alta: o Início tem quatro blocos, e num aparelho comum os de baixo
/// ficam fora da viewport — o `ListView` nem os constrói. Estes testes são
/// sobre CONTEÚDO, então a rolagem sai da equação. Overflow em tela pequena
/// tem teste próprio, no fim do arquivo.
void _telaAlta(WidgetTester tester) {
  tester.view.physicalSize = const Size(1200, 2400);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
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
    String priority = 'NORMAL',
    String? scheduledAt,
    String customerName = 'Maria da Silva',
    String type = 'Instalação',
  }) => {
    'id': id,
    'number': number,
    'status': status,
    'priority': priority,
    'type': type,
    'subtype': null,
    'customerName': customerName,
    'district': 'Centro',
    'city': 'Guaçuí',
    'scheduledAt': scheduledAt,
    'hasLocation': true,
    'updatedAt': '2026-08-27T10:00:00.000Z',
    'version': 3,
  };

  /// Detalhe real da OS, para provar que o toque abre a tela verdadeira.
  Map<String, dynamic> detailJson({int number = 7}) => {
    'serviceOrder': {
      'id': 'os-1',
      'number': number,
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
  };

  group('A-C — hero', () {
    testWidgets('A. mostra saudação com o primeiro nome real e a empresa', (
      tester,
    ) async {
      _telaAlta(tester);
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

      // Primeiro nome só — "Joana Torres" não caberia no topo.
      expect(find.textContaining('Joana'), findsOneWidget);
      expect(find.text('Alfa Telecom'), findsOneWidget);
    });

    testWidgets('B. o hero sobrevive à falha da JORNADA', (tester) async {
      _telaAlta(tester);
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

      // A identidade continua; o resumo de OS também. Some só o que falhou.
      expect(find.textContaining('Joana'), findsOneWidget);
      // A métrica virou NÚMERO + rótulo (DQ-6): o valor pesa mais que a frase.
      expect(find.byKey(const Key('hero-metric-OS aberta')), findsOneWidget);
      expect(find.text('Não foi possível carregar a jornada.'), findsOneWidget);
    });

    testWidgets('C. o hero sobrevive à falha das ORDENS', (tester) async {
      _telaAlta(tester);
      final harness = Harness();
      seedMe(harness.transport);
      harness.transport.onJson(
        'GET',
        '/time-clock/today',
        data: {'workday': workdayJson(state: 'WORKING', workedMinutes: 125)},
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

      expect(find.textContaining('Joana'), findsOneWidget);
      // A jornada real continua no hero, com o total que o SERVIDOR calculou.
      expect(find.textContaining('TRABALHANDO · 2h 5min'), findsOneWidget);
      expect(
        find.text('Não foi possível carregar suas ordens.'),
        findsOneWidget,
      );
    });
  });

  group('D — jornada', () {
    testWidgets('D. a ação vem de allowedActions — não é recalculada', (
      tester,
    ) async {
      _telaAlta(tester);
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
        `ON_BREAK` só permite retorno. Se o Dashboard derivasse a ação por
        conta própria — por exemplo, oferecendo sempre "encerrar" —, este botão
        diria outra coisa.
      */
      expect(find.byKey(const Key('dashboard-jornada-action')), findsOneWidget);
      expect(find.text('RETORNAR DO INTERVALO'), findsOneWidget);
    });

    testWidgets('ENCERRADA não oferece batida nenhuma', (tester) async {
      _telaAlta(tester);
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

      expect(find.byKey(const Key('dashboard-jornada-action')), findsNothing);
      expect(find.text('Jornada encerrada.'), findsOneWidget);
    });
  });

  group('E-K — atenção agora', () {
    /// Registra jornada e ordens de uma vez, para os testes do bloco.
    void seedComOrdens(
      FakeTransport transport,
      List<Map<String, dynamic>> ordens,
    ) {
      seedMe(transport);
      transport.onJson(
        'GET',
        '/time-clock/today',
        data: {'workday': workdayJson()},
      );
      transport.onJson(
        'GET',
        '/service-orders',
        data: {'items': ordens, 'nextCursor': null},
      );
    }

    testWidgets('E. OS EM ATENDIMENTO aparece', (tester) async {
      _telaAlta(tester);
      final harness = Harness();
      seedComOrdens(harness.transport, [
        orderJson(id: 'os-9', number: 9, status: 'IN_PROGRESS'),
      ]);
      harness.store.token = 'token-seedado';

      await harness.pumpApp(tester);
      await _settle(tester);

      expect(find.text('ATENÇÃO AGORA'), findsOneWidget);
      expect(find.byKey(const Key('attention-order-os-9')), findsOneWidget);
      // O estado é TEXTO, não só a borda colorida.
      expect(find.text('Em atendimento'), findsWidgets);
    });

    testWidgets('F. OS URGENTE aparece, com rótulo — não só cor', (
      tester,
    ) async {
      _telaAlta(tester);
      final harness = Harness();
      seedComOrdens(harness.transport, [
        orderJson(id: 'os-5', number: 5, priority: 'URGENT'),
      ]);
      harness.store.token = 'token-seedado';

      await harness.pumpApp(tester);
      await _settle(tester);

      expect(find.byKey(const Key('attention-order-os-5')), findsOneWidget);
      // `PriorityBadge` escreve "Urgente": quem não distingue a cor tem o texto.
      expect(find.text('Urgente'), findsWidgets);
    });

    testWidgets(
      'G/H. OS ATRIBUÍDA sem scheduledAt aparece — o caso do piloto',
      (tester) async {
        /*
          O defeito relatado: uma OS real importada do ReceitaNet, atribuída e
          sem horário, aparecia em "Minhas Ordens" e sumia do Início. A causa
          não era um bug — era a ausência de um bloco para OS sem agendamento.

          Não há badge de origem, e isso é deliberado: o DTO do Field não traz
          `origin`/`externalProvider` (`src/lib/field/dto.ts`), justamente para
          que uma OS importada seja indistinguível de uma interna no aplicativo.
          Deduzir a origem do texto do tipo seria inventar o dado.
        */
        _telaAlta(tester);
        final harness = Harness();
        seedComOrdens(harness.transport, [
          orderJson(
            id: 'os-7',
            number: 7,
            status: 'ASSIGNED',
            type: 'Chamado ReceitaNet',
          ),
        ]);
        harness.store.token = 'token-seedado';

        await harness.pumpApp(tester);
        await _settle(tester);

        expect(find.byKey(const Key('attention-order-os-7')), findsOneWidget);
        expect(find.textContaining('OS Nº 7'), findsWidgets);
        expect(find.text('Chamado ReceitaNet'), findsOneWidget);
      },
    );

    testWidgets('I. OS sem scheduledAt NÃO vira "Próxima OS"', (tester) async {
      /*
        O bloco novo não relaxou a regra antiga: "próxima" continua exigindo
        `scheduledAt` autoritativo. As duas seções respondem perguntas
        diferentes, e a OS sem horário só entra na que não promete cronologia.
      */
      _telaAlta(tester);
      final harness = Harness();
      seedComOrdens(harness.transport, [orderJson(id: 'os-7', number: 7)]);
      harness.store.token = 'token-seedado';

      await harness.pumpApp(tester);
      await _settle(tester);

      expect(find.byKey(const Key('attention-order-os-7')), findsOneWidget);
      expect(find.text('PRÓXIMA OS'), findsNothing);
    });

    testWidgets('com scheduledAt real, PRÓXIMA OS continua existindo', (
      tester,
    ) async {
      // Controle positivo do teste I: a seção não sumiu, ela é condicional.
      _telaAlta(tester);
      final harness = Harness();
      seedComOrdens(harness.transport, [
        orderJson(scheduledAt: '2026-08-30T14:00:00.000Z'),
      ]);
      harness.store.token = 'token-seedado';

      await harness.pumpApp(tester);
      await _settle(tester);

      /*
        O rótulo mudou para PRÓXIMA AGENDADA em DQ-6, e a mudança é o ponto.

        "Próxima na fila" é ordem operacional, do despacho; "próxima agendada"
        é compromisso de horário. A tela chamava as duas de "PRÓXIMA OS", e uma
        OS pode ser a 1ª da fila sem ter horário nenhum.
      */
      expect(find.text('PRÓXIMA AGENDADA'), findsOneWidget);
      expect(find.text('PRÓXIMA OS'), findsNothing);
    });

    testWidgets('J. o bloco não vira lista: no máximo três cards', (
      tester,
    ) async {
      _telaAlta(tester);
      final harness = Harness();
      seedComOrdens(harness.transport, [
        for (var n = 1; n <= 6; n++) orderJson(id: 'os-$n', number: n),
      ]);
      harness.store.token = 'token-seedado';

      await harness.pumpApp(tester);
      await _settle(tester);

      expect(find.byKey(const Key('attention-order-os-1')), findsOneWidget);
      expect(find.byKey(const Key('attention-order-os-2')), findsOneWidget);
      expect(find.byKey(const Key('attention-order-os-3')), findsOneWidget);
      // A quarta em diante fica para a aba OS.
      expect(find.byKey(const Key('attention-order-os-4')), findsNothing);
      expect(find.byKey(const Key('dashboard-see-all-orders')), findsOneWidget);
    });

    testWidgets('K. tocar um card abre o DETALHE real da OS', (tester) async {
      _telaAlta(tester);
      final harness = Harness();
      seedComOrdens(harness.transport, [orderJson()]);
      harness.transport.onJson(
        'GET',
        '/service-orders/os-1',
        data: detailJson(),
      );
      harness.store.token = 'token-seedado';

      await harness.pumpApp(tester);
      await _settle(tester);

      await tester.tap(find.byKey(const Key('attention-order-os-1')));
      await _settle(tester);

      // A tela real, reconhecida pela descrição — que só o detalhe mostra.
      expect(find.text('Sem sinal.'), findsOneWidget);
    });

    testWidgets('sem OS aberta, o bloco não aparece — nem vazio', (
      tester,
    ) async {
      _telaAlta(tester);
      final harness = Harness();
      seedComOrdens(harness.transport, [
        orderJson(id: 'os-1', status: 'COMPLETED'),
      ]);
      harness.store.token = 'token-seedado';

      await harness.pumpApp(tester);
      await _settle(tester);

      // Card gigante dizendo "nenhuma OS" é ruído no topo da tela.
      expect(find.text('ATENÇÃO AGORA'), findsNothing);
      expect(find.byKey(const Key('attention-order-os-1')), findsNothing);
    });
  });

  group('métricas', () {
    testWidgets('conta total, em atendimento e pendentes — sem inventar', (
      tester,
    ) async {
      _telaAlta(tester);
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
            orderJson(id: 'os-1', number: 1),
            orderJson(id: 'os-2', number: 2, status: 'IN_PROGRESS'),
            orderJson(id: 'os-3', number: 3, status: 'PENDING'),
          ],
          'nextCursor': null,
        },
      );
      harness.store.token = 'token-seedado';

      await harness.pumpApp(tester);
      await _settle(tester);

      /*
        os-1 ASSIGNED e os-3 PENDING são pendentes (2); os-2 IN_PROGRESS é 1.

        A busca é ESCOPADA ao contador, por chave. Desde a DQ-6 o hero também
        pinta números soltos, e um `find.text('3')` global casava com os dois —
        o teste passaria a medir a tela errada sem ninguém perceber.
      */
      Finder contador(String rotulo) => find.byKey(Key('order-metric-$rotulo'));
      expect(
        find.descendant(of: contador('Total'), matching: find.text('3')),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: contador('Em atendimento'),
          matching: find.text('1'),
        ),
        findsOneWidget,
      );
      expect(
        find.descendant(of: contador('Pendentes'), matching: find.text('2')),
        findsOneWidget,
      );
    });
  });

  group('responsividade', () {
    testWidgets('o Início não estoura num aparelho pequeno', (tester) async {
      /*
        Complemento honesto de `_telaAlta`: aqui a tela é a de um celular
        real. O que se prova é a ausência de `RenderFlex overflow` — a faixa
        amarela que o técnico veria em campo — com hero, cards de OS e nomes
        longos ao mesmo tempo.
      */
      tester.view.physicalSize = const Size(360, 640);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);

      final harness = Harness();
      seedMe(harness.transport);
      harness.transport.onJson(
        'GET',
        '/time-clock/today',
        data: {'workday': workdayJson(state: 'WORKING', workedMinutes: 125)},
      );
      harness.transport.onJson(
        'GET',
        '/service-orders',
        data: {
          'items': [
            orderJson(
              id: 'os-1',
              number: 1,
              priority: 'URGENT',
              customerName:
                  'Maria Aparecida da Silva Gonçalves de Albuquerque Neta',
              type: 'Instalação de fibra óptica com configuração completa',
            ),
            orderJson(id: 'os-2', number: 2, status: 'IN_PROGRESS'),
          ],
          'nextCursor': null,
        },
      );
      harness.store.token = 'token-seedado';

      await harness.pumpApp(tester);
      await _settle(tester);

      expect(tester.takeException(), isNull);
    });
  });
}
