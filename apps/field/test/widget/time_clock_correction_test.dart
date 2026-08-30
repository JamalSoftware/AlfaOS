import 'package:alfaos_field/app/providers.dart';
import 'package:alfaos_field/core/location/location_service.dart';
import 'package:alfaos_field/features/timeclock/ui/time_clock_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/harness.dart';

/// # SOLICITAR CORREÇÃO, pelo aplicativo
///
/// O piloto em aparelho real encontrou a tela dizendo "para corrigir, solicite
/// um ajuste" sem nenhum lugar onde solicitar: o repositório e a rota existiam,
/// e nenhum toque chegava até eles.
///
/// A regra que estes testes seguram é a mesma do módulo inteiro: **o pedido não
/// altera a marcação**. Ele nasce pendente, e o horário novo só passa a valer
/// depois que alguém aprovar (PRD §229).
///
/// Fixtures fictícias.

class _FakeGps implements LocationService {
  @override
  Future<LocationReading> current() async =>
      const LocationReading.failed(LocationOutcome.permissionDenied);
}

Map<String, dynamic> _entry(String id, String type, String hhmm) => {
  'id': id,
  'type': type,
  'source': 'FIELD_APP',
  'occurredAt': '2026-08-29T$hhmm:00.000Z',
  'deviceOccurredAt': null,
  'latitude': null,
  'longitude': null,
  'accuracyMeters': null,
  'fromAdjustment': false,
};

Map<String, dynamic> _workday({
  required String state,
  required List<String> allowedActions,
  List<Map<String, dynamic>> entries = const [],
  String date = '2026-08-29',
}) => {
  'workdayId': 'wd-1',
  'date': date,
  'timezone': 'America/Sao_Paulo',
  'state': state,
  'allowedActions': allowedActions,
  'entries': entries,
  'workedMinutes': 480,
  'breakMinutes': 60,
  'inconsistencies': <String>[],
  'pendingAdjustments': 0,
};

Map<String, dynamic> _dia(String date, {String state = 'FINISHED'}) => {
  'date': date,
  'state': state,
  'workedMinutes': 480,
  'breakMinutes': 60,
  'entryCount': 4,
  'pendingAdjustments': 0,
};

Map<String, dynamic> _pedido({
  required String id,
  required String status,
  String? decisionReason,
}) => {
  'id': id,
  'status': status,
  'requestedType': 'WRONG_TIME',
  'requestedEntryType': 'CLOCK_IN',
  'requestedOccurredAt': '2026-08-29T11:30:00.000Z',
  'reason': 'esqueci de bater',
  'workdayDate': '2026-08-29',
  'decidedAt': status == 'PENDING' ? null : '2026-08-29T14:00:00.000Z',
  'decisionReason': decisionReason,
  'createdAt': '2026-08-29T12:00:00.000Z',
};

Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 8; i++) {
    await tester.pump(const Duration(milliseconds: 60));
  }
  await tester.pumpAndSettle(const Duration(milliseconds: 50));
}

Future<Harness> _abrir(
  WidgetTester tester, {
  required Map<String, dynamic> workday,
  List<Map<String, dynamic>> history = const [],
  List<Map<String, dynamic>> adjustments = const [],
}) async {
  tester.view.physicalSize = const Size(1200, 4000);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);

  final harness = Harness();
  harness.transport.onJson(
    'GET',
    '/time-clock/today',
    data: {'workday': workday},
  );
  harness.transport.onJson(
    'GET',
    '/time-clock/history',
    data: {'from': '2026-08-01', 'to': '2026-08-29', 'workdays': history},
  );
  harness.transport.onJson(
    'GET',
    '/time-clock/adjustments',
    data: {'adjustments': adjustments},
  );

  await harness.pump(
    tester,
    const TimeClockScreen(),
    extraOverrides: [locationServiceProvider.overrideWithValue(_FakeGps())],
  );
  await _settle(tester);
  return harness;
}

Future<void> _abrirFolha(WidgetTester tester) async {
  await tester.tap(find.byKey(const Key('request-adjustment')));
  await _settle(tester);
}

void main() {
  final comEntrada = _workday(
    state: 'FINISHED',
    allowedActions: const [],
    entries: [
      _entry('e-in', 'CLOCK_IN', '11:00'),
      _entry('e-out', 'CLOCK_OUT', '20:00'),
    ],
  );

  group('a ação existe e está à vista', () {
    testWidgets('a seção Correções oferece o botão', (tester) async {
      await _abrir(tester, workday: comEntrada);

      // Nada de gesto oculto nem menu "Mais": o botão é visível na tela.
      expect(find.byKey(const Key('request-adjustment')), findsOneWidget);
      expect(find.text('SOLICITAR CORREÇÃO'), findsWidgets);
    });

    testWidgets('a jornada encerrada oferece o botão junto da orientação', (
      tester,
    ) async {
      await _abrir(tester, workday: comEntrada);

      // A frase que manda solicitar e a ação que solicita, no mesmo cartão.
      expect(
        find.text('Jornada encerrada. Para corrigir, solicite um ajuste.'),
        findsOneWidget,
      );
      expect(find.byKey(const Key('request-adjustment-today')), findsOneWidget);
    });

    testWidgets('o formulário abre com a marcação e o horário do dia', (
      tester,
    ) async {
      await _abrir(tester, workday: comEntrada);
      await _abrirFolha(tester);

      expect(find.text('Solicitar correção'), findsOneWidget);
      expect(find.byKey(const Key('adjustment-reason')), findsOneWidget);
      // A tela deixa explícito que isto NÃO edita a marcação.
      expect(find.textContaining('não altera a marcação'), findsOneWidget);
    });
  });

  group('validação antes de enviar', () {
    testWidgets('sem motivo não envia nada', (tester) async {
      final h = await _abrir(tester, workday: comEntrada);
      await _abrirFolha(tester);

      await tester.tap(find.byKey(const Key('adjustment-submit')));
      await _settle(tester);

      expect(find.byKey(const Key('adjustment-error')), findsOneWidget);
      expect(find.text('Descreva o que aconteceu.'), findsOneWidget);
      expect(h.transport.countOf('POST', '/time-clock/adjustments'), 0);
    });

    testWidgets('sem horário — dia sem marcação — não envia nada', (
      tester,
    ) async {
      final h = await _abrir(
        tester,
        workday: _workday(state: 'NOT_STARTED', allowedActions: ['CLOCK_IN']),
      );
      await _abrirFolha(tester);

      await tester.enterText(
        find.byKey(const Key('adjustment-reason')),
        'esqueci de bater na entrada',
      );
      await tester.tap(find.byKey(const Key('adjustment-submit')));
      await _settle(tester);

      expect(find.text('Informe o horário correto.'), findsOneWidget);
      expect(h.transport.countOf('POST', '/time-clock/adjustments'), 0);
    });
  });

  group('envio', () {
    testWidgets('manda o alvo, o tipo e o motivo — e nada de identidade', (
      tester,
    ) async {
      final h = await _abrir(tester, workday: comEntrada);
      h.transport.onJson(
        'POST',
        '/time-clock/adjustments',
        status: 201,
        data: {
          'adjustment': {
            'id': 'adj-1',
            'status': 'PENDING',
            'requestedEntryType': 'CLOCK_IN',
            'requestedOccurredAt': '2026-08-29T11:00:00.000Z',
            'workdayDate': '2026-08-29',
          },
        },
      );

      await _abrirFolha(tester);
      await tester.enterText(
        find.byKey(const Key('adjustment-reason')),
        'cheguei antes',
      );
      await tester.tap(find.byKey(const Key('adjustment-submit')));
      await _settle(tester);

      final pedido = h.transport.requestFor('POST', '/time-clock/adjustments');
      final corpo = pedido.data as Map<String, dynamic>;

      // O alvo é a marcação existente, então é CORREÇÃO e não inclusão.
      expect(corpo['targetEntryId'], 'e-in');
      expect(corpo['requestedType'], 'WRONG_TIME');
      expect(corpo['requestedEntryType'], 'CLOCK_IN');
      expect(corpo['reason'], 'cheguei antes');

      /*
        Identidade NÃO viaja no corpo.

        Empresa, usuário e técnico saem do token. O schema do servidor é
        estrito e recusaria, mas o aplicativo também não tenta.
      */
      expect(corpo.containsKey('userId'), isFalse);
      expect(corpo.containsKey('companyId'), isFalse);

      // E a chave de idempotência acompanha o comando.
      expect(pedido.headers['Idempotency-Key'], isNotNull);
    });

    testWidgets('a recusa do servidor FICA na folha, sem falso sucesso', (
      tester,
    ) async {
      final h = await _abrir(tester, workday: comEntrada);
      h.transport.onError(
        'POST',
        '/time-clock/adjustments',
        status: 409,
        code: 'CONFLICT',
        message: 'Esta marcação já foi corrigida.',
      );

      await _abrirFolha(tester);
      await tester.enterText(
        find.byKey(const Key('adjustment-reason')),
        'de novo',
      );
      await tester.tap(find.byKey(const Key('adjustment-submit')));
      await _settle(tester);

      // A folha continua aberta, com a razão da recusa à vista.
      expect(find.byKey(const Key('adjustment-error')), findsOneWidget);
      expect(find.text('Esta marcação já foi corrigida.'), findsOneWidget);
      expect(find.byKey(const Key('adjustment-submit')), findsOneWidget);
    });
  });

  group('a chave de idempotência é da INTENÇÃO', () {
    testWidgets('reenviar o MESMO pedido reapresenta a mesma chave', (
      tester,
    ) async {
      final h = await _abrir(tester, workday: comEntrada);
      h.transport.onError(
        'POST',
        '/time-clock/adjustments',
        status: 500,
        code: 'INTERNAL',
        message: 'Falha temporária.',
      );

      await _abrirFolha(tester);
      await tester.enterText(
        find.byKey(const Key('adjustment-reason')),
        'mesma intenção',
      );
      await tester.tap(find.byKey(const Key('adjustment-submit')));
      await _settle(tester);
      await tester.tap(find.byKey(const Key('adjustment-submit')));
      await _settle(tester);

      final envios = h.transport.requests
          .where(
            (r) => r.path == '/time-clock/adjustments' && r.method == 'POST',
          )
          .toList();
      expect(envios.length, 2);

      /*
        DUAS tentativas, UMA intenção.

        Antes a chave nascia dentro do envio: um timeout seguido de "tentar de
        novo" abria dois pedidos idênticos, e o gestor recebia a mesma correção
        duas vezes na fila. Com a chave presa ao conteúdo, o servidor reconhece
        a retentativa e produz um efeito só.
      */
      expect(
        envios[0].headers['Idempotency-Key'],
        envios[1].headers['Idempotency-Key'],
      );
    });

    testWidgets('mudar o pedido depois da recusa gera chave NOVA', (
      tester,
    ) async {
      final h = await _abrir(tester, workday: comEntrada);
      h.transport.onError(
        'POST',
        '/time-clock/adjustments',
        status: 500,
        code: 'INTERNAL',
        message: 'Falha temporária.',
      );

      await _abrirFolha(tester);
      await tester.enterText(
        find.byKey(const Key('adjustment-reason')),
        'primeira redação',
      );
      await tester.tap(find.byKey(const Key('adjustment-submit')));
      await _settle(tester);

      await tester.enterText(
        find.byKey(const Key('adjustment-reason')),
        'segunda redação, outro pedido',
      );
      await tester.tap(find.byKey(const Key('adjustment-submit')));
      await _settle(tester);

      final envios = h.transport.requests
          .where(
            (r) => r.path == '/time-clock/adjustments' && r.method == 'POST',
          )
          .toList();
      expect(envios.length, 2);

      /*
        Corpo diferente exige chave diferente.

        Reusar a chave aqui bateria em IDEMPOTENCY_CONFLICT no servidor, e o
        técnico ficaria preso: a correção certa nunca conseguiria ser enviada
        depois de uma tentativa errada.
      */
      expect(
        envios[0].headers['Idempotency-Key'],
        isNot(envios[1].headers['Idempotency-Key']),
      );
    });
  });

  group('o desfecho do pedido é visível', () {
    testWidgets('pendente aparece como aguardando, sem aplicar o horário', (
      tester,
    ) async {
      await _abrir(
        tester,
        workday: comEntrada,
        adjustments: [_pedido(id: 'adj-1', status: 'PENDING')],
      );

      expect(find.text('Aguardando aprovação'), findsOneWidget);

      /*
        O horário PEDIDO não vira o horário que vale.

        A marcação de entrada continua a original: enquanto o pedido espera, o
        cartão de hoje mostra o que foi batido, não o que foi pedido.
      */
      expect(find.text('Entrada'), findsWidgets);
    });

    testWidgets('rejeitado aparece com o motivo da recusa', (tester) async {
      await _abrir(
        tester,
        workday: comEntrada,
        adjustments: [
          _pedido(
            id: 'adj-1',
            status: 'REJECTED',
            decisionReason: 'Horário não confere com a OS do dia.',
          ),
        ],
      );

      expect(find.text('Rejeitada'), findsOneWidget);
      // Recusa sem motivo seria decisão sem contraditório (§229).
      expect(find.text('Horário não confere com a OS do dia.'), findsOneWidget);
    });

    testWidgets('aprovado aparece como aprovado', (tester) async {
      await _abrir(
        tester,
        workday: comEntrada,
        adjustments: [_pedido(id: 'adj-1', status: 'APPROVED')],
      );

      expect(find.text('Aprovada'), findsOneWidget);
    });

    testWidgets('status desconhecido de um servidor mais novo não some', (
      tester,
    ) async {
      await _abrir(
        tester,
        workday: comEntrada,
        adjustments: [_pedido(id: 'adj-1', status: 'ESCALATED')],
      );

      // Um APK antigo mostra o texto cru em vez de esconder o pedido.
      expect(find.text('ESCALATED'), findsOneWidget);
    });
  });

  group('HISTÓRICO não repete o dia de hoje', () {
    testWidgets('a rota devolve hoje, e a seção mostra só os anteriores', (
      tester,
    ) async {
      await _abrir(
        tester,
        workday: _workday(
          state: 'FINISHED',
          allowedActions: const [],
          entries: [_entry('e-in', 'CLOCK_IN', '11:00')],
          date: '2026-08-29',
        ),
        // O servidor devolve até HOJE — é o certo para um recorte de datas.
        history: [_dia('2026-08-29'), _dia('2026-08-28'), _dia('2026-08-27')],
      );

      /*
        O dia corrente aparece UMA vez, no cartão do topo.

        No piloto em aparelho real ele aparecia duas: a jornada de hoje em cima
        e a MESMA data logo abaixo, na lista de jornadas anteriores. Duas linhas
        para o mesmo dia fazem o técnico duvidar de qual vale.
      */
      expect(find.text('2026-08-29'), findsNothing);
      expect(find.text('2026-08-28'), findsOneWidget);
      expect(find.text('2026-08-27'), findsOneWidget);
    });

    testWidgets('o corte usa a data do SERVIDOR, não a do aparelho', (
      tester,
    ) async {
      await _abrir(
        tester,
        // O dia operacional é o dia civil no fuso da EMPRESA. Um aparelho em
        // outro fuso cortaria o dia errado se o corte fosse pelo relógio dele.
        workday: _workday(
          state: 'WORKING',
          allowedActions: const ['CLOCK_OUT'],
          date: '2026-08-27',
        ),
        history: [_dia('2026-08-29'), _dia('2026-08-28'), _dia('2026-08-27')],
      );

      expect(find.text('2026-08-27'), findsNothing);
      expect(find.text('2026-08-29'), findsOneWidget);
      expect(find.text('2026-08-28'), findsOneWidget);
    });

    testWidgets('sem dias anteriores a seção diz isso, e não fica vazia', (
      tester,
    ) async {
      await _abrir(tester, workday: comEntrada, history: [_dia('2026-08-29')]);

      expect(find.text('Sem jornadas anteriores.'), findsOneWidget);
    });
  });
}
