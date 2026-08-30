import 'package:alfaos_field/app/providers.dart';
import 'package:alfaos_field/core/location/location_service.dart';
import 'package:alfaos_field/features/timeclock/ui/time_clock_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/harness.dart';

/// # MINHA JORNADA
///
/// A regra que estes testes seguram: **o servidor decide a transição**. A tela
/// desenha o botão a partir de `allowedActions` e não deriva nada (PRD §229).
///
/// Um aplicativo que decidisse sozinho seria uma segunda máquina de estados, e
/// um APK antigo em campo continuaria oferecendo uma ação que o servidor já não
/// aceita.
///
/// Fixtures fictícias.

class _FakeGps implements LocationService {
  _FakeGps(this.reading);
  final LocationReading reading;
  int chamadas = 0;

  @override
  Future<LocationReading> current() async {
    chamadas += 1;
    return reading;
  }
}

const _comGps = LocationReading.ok(
  DeviceLocation(latitude: -23.55, longitude: -46.63, accuracyMeters: 9),
);
const _semGps = LocationReading.failed(LocationOutcome.permissionDenied);

Map<String, dynamic> _workday({
  required String state,
  required List<String> allowedActions,
  List<Map<String, dynamic>> entries = const [],
  int workedMinutes = 0,
  int breakMinutes = 0,
  int pendingAdjustments = 0,
  List<String> inconsistencies = const [],
}) => {
  'workdayId': 'wd-1',
  'date': '2026-08-29',
  'timezone': 'America/Sao_Paulo',
  // O deslocamento acompanha o dia: sem ele a tela cairia no relógio da
  // máquina que roda o teste, e a hora exibida mudaria de CI para CI.
  'utcOffset': '-03:00',
  'state': state,
  'allowedActions': allowedActions,
  'entries': entries,
  'workedMinutes': workedMinutes,
  'breakMinutes': breakMinutes,
  'inconsistencies': inconsistencies,
  'pendingAdjustments': pendingAdjustments,
};

Map<String, dynamic> _entry(String type, String hhmm, {bool ajuste = false}) =>
    {
      'id': 'e-$type-$hhmm',
      'type': type,
      'source': ajuste ? 'ADJUSTMENT' : 'FIELD_APP',
      'occurredAt': '2026-08-29T$hhmm:00.000Z',
      'deviceOccurredAt': null,
      'latitude': null,
      'longitude': null,
      'accuracyMeters': null,
      'fromAdjustment': ajuste,
    };

Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 8; i++) {
    await tester.pump(const Duration(milliseconds: 60));
  }
  await tester.pumpAndSettle(const Duration(milliseconds: 50));
}

Future<({Harness harness, _FakeGps gps})> _abrir(
  WidgetTester tester, {
  required Map<String, dynamic> workday,
  LocationReading location = _comGps,
  List<Map<String, dynamic>> history = const [],
}) async {
  tester.view.physicalSize = const Size(1200, 3000);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);

  final harness = Harness();
  final gps = _FakeGps(location);

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

  await harness.pump(
    tester,
    const TimeClockScreen(),
    extraOverrides: [locationServiceProvider.overrideWithValue(gps)],
  );
  await _settle(tester);
  return (harness: harness, gps: gps);
}

/// Toca o botão e confirma o diálogo.
Future<void> _bater(WidgetTester tester, String tipo) async {
  await tester.tap(find.byKey(Key('punch-$tipo')));
  await _settle(tester);
  await tester.tap(find.byKey(const Key('punch-confirm')));
  await _settle(tester);
}

void main() {
  group('o botão vem do SERVIDOR', () {
    testWidgets('NOT_STARTED oferece só REGISTRAR ENTRADA', (tester) async {
      await _abrir(
        tester,
        workday: _workday(state: 'NOT_STARTED', allowedActions: ['CLOCK_IN']),
      );

      expect(find.text('NÃO INICIADA'), findsOneWidget);
      expect(find.text('REGISTRAR ENTRADA'), findsOneWidget);
      expect(find.text('INICIAR INTERVALO'), findsNothing);
      expect(find.text('ENCERRAR JORNADA'), findsNothing);
    });

    testWidgets('WORKING oferece intervalo e encerramento', (tester) async {
      await _abrir(
        tester,
        workday: _workday(
          state: 'WORKING',
          allowedActions: ['BREAK_START', 'CLOCK_OUT'],
          entries: [_entry('CLOCK_IN', '11:02')],
          workedMinutes: 125,
        ),
      );

      expect(find.text('TRABALHANDO'), findsOneWidget);
      expect(find.text('INICIAR INTERVALO'), findsOneWidget);
      expect(find.text('ENCERRAR JORNADA'), findsOneWidget);
      expect(find.text('REGISTRAR ENTRADA'), findsNothing);
      // Os totais vêm calculados: a tela não soma nada.
      expect(find.textContaining('Trabalhado: 2h 5min'), findsOneWidget);
    });

    testWidgets('ON_BREAK oferece SÓ o retorno', (tester) async {
      await _abrir(
        tester,
        workday: _workday(
          state: 'ON_BREAK',
          allowedActions: ['BREAK_END'],
          entries: [
            _entry('CLOCK_IN', '11:00'),
            _entry('BREAK_START', '15:00'),
          ],
        ),
      );

      expect(find.text('EM INTERVALO'), findsOneWidget);
      expect(find.text('RETORNAR DO INTERVALO'), findsOneWidget);
      // Encerrar em intervalo deixaria um intervalo aberto para sempre.
      expect(find.text('ENCERRAR JORNADA'), findsNothing);
    });

    testWidgets('FINISHED não oferece botão nenhum', (tester) async {
      await _abrir(
        tester,
        workday: _workday(
          state: 'FINISHED',
          allowedActions: [],
          entries: [_entry('CLOCK_IN', '11:00'), _entry('CLOCK_OUT', '20:00')],
          workedMinutes: 540,
        ),
      );

      expect(find.text('ENCERRADA'), findsOneWidget);
      expect(find.byType(FilledButton), findsNothing);
      // E diz o que fazer: reabrir não é batida, é correção — que mora na
      // seção Correções, a porta única do §258.
      expect(find.textContaining('use Correções'), findsOneWidget);
    });

    testWidgets('ação desconhecida de um servidor mais novo é ignorada', (
      tester,
    ) async {
      /*
        Compatibilidade para frente.

        Um servidor que ganhe uma quinta marcação não pode fazer o APK antigo
        desenhar um botão sem rótulo nem estourar. Ele ignora o que não conhece
        e mostra o que conhece.
      */
      await _abrir(
        tester,
        workday: _workday(
          state: 'WORKING',
          allowedActions: ['BREAK_START', 'ALGO_NOVO'],
        ),
      );

      expect(tester.takeException(), isNull);
      expect(find.text('INICIAR INTERVALO'), findsOneWidget);
      expect(find.byType(FilledButton), findsOneWidget);
    });
  });

  group('bater ponto', () {
    testWidgets('confirma antes de gravar, e o horário vem do servidor', (
      tester,
    ) async {
      final ctx = await _abrir(
        tester,
        workday: _workday(state: 'NOT_STARTED', allowedActions: ['CLOCK_IN']),
      );
      ctx.harness.transport.onJson(
        'POST',
        '/time-clock/entries',
        status: 201,
        data: {
          'entry': {
            'id': 'e-1',
            'type': 'CLOCK_IN',
            'occurredAt': '2026-08-29T11:02:00.000Z',
            'source': 'FIELD_APP',
          },
          'workday': _workday(
            state: 'WORKING',
            allowedActions: ['BREAK_START', 'CLOCK_OUT'],
          ),
        },
      );

      await tester.tap(find.byKey(const Key('punch-CLOCK_IN')));
      await _settle(tester);

      /*
        O diálogo NÃO é enfeite.

        A marcação é imutável: um toque acidental em "encerrar jornada" só se
        desfaz por pedido com aprovação. Um diálogo é barato perto disso.
      */
      expect(find.text('Entrada?'), findsOneWidget);
      expect(ctx.harness.transport.countOf('POST', '/time-clock/entries'), 0);

      // A releitura pós-batida traz a lista com o horário OFICIAL.
      ctx.harness.transport.onJson(
        'GET',
        '/time-clock/today',
        data: {
          'workday': _workday(
            state: 'WORKING',
            allowedActions: ['BREAK_START', 'CLOCK_OUT'],
            entries: [_entry('CLOCK_IN', '11:02')],
          ),
        },
      );

      await tester.tap(find.byKey(const Key('punch-confirm')));
      await _settle(tester);

      expect(ctx.harness.transport.countOf('POST', '/time-clock/entries'), 1);
      /*
        O horário aparece no fuso da EMPRESA, e por isso pode ser CRAVADO.

        Antes a asserção derivava o esperado de `.toLocal()`, porque a tela
        lia o relógio do aparelho e um número escrito à mão só passaria na
        máquina de quem o escreveu. Isso deixou de ser verdade com o §253
        (LOW-3): o dia traz `utcOffset`, e 11:02Z em `-03:00` é 08:02 em
        qualquer máquina.

        Derivar de `.toLocal()` AGORA seria pior que rígido — seria um teste
        que passa no fuso de quem o escreveu e esconde a regressão nos outros.
      */
      expect(find.textContaining('Entrada às 08:02'), findsOneWidget);
    });

    testWidgets('cancelar o diálogo não bate nada', (tester) async {
      final ctx = await _abrir(
        tester,
        workday: _workday(state: 'NOT_STARTED', allowedActions: ['CLOCK_IN']),
      );
      ctx.harness.transport.onJson('POST', '/time-clock/entries', status: 201);

      await tester.tap(find.byKey(const Key('punch-CLOCK_IN')));
      await _settle(tester);
      await tester.tap(find.text('Cancelar'));
      await _settle(tester);

      expect(ctx.harness.transport.countOf('POST', '/time-clock/entries'), 0);
    });

    testWidgets('o corpo leva o carimbo do APARELHO como metadata', (
      tester,
    ) async {
      final ctx = await _abrir(
        tester,
        workday: _workday(state: 'NOT_STARTED', allowedActions: ['CLOCK_IN']),
      );
      ctx.harness.transport.onJson(
        'POST',
        '/time-clock/entries',
        status: 201,
        data: {
          'workday': _workday(state: 'WORKING', allowedActions: ['CLOCK_OUT']),
        },
      );

      await _bater(tester, 'CLOCK_IN');

      final request = ctx.harness.transport.requestFor(
        'POST',
        '/time-clock/entries',
      );
      final body = request.data as Map<String, dynamic>;
      expect(body['type'], 'CLOCK_IN');
      // Metadata, nunca autoridade — quem carimba o oficial é o servidor.
      expect(body['deviceOccurredAt'], isA<String>());
      expect(body['latitude'], closeTo(-23.55, 0.001));
      // Identidade NÃO viaja no corpo: ela sai do token.
      expect(body.containsKey('userId'), isFalse);
      expect(body.containsKey('technicianId'), isFalse);
      expect(request.headers['Idempotency-Key'], isNotNull);
    });

    testWidgets('sem GPS a batida acontece do mesmo jeito', (tester) async {
      final ctx = await _abrir(
        tester,
        workday: _workday(state: 'NOT_STARTED', allowedActions: ['CLOCK_IN']),
        location: _semGps,
      );
      ctx.harness.transport.onJson(
        'POST',
        '/time-clock/entries',
        status: 201,
        data: {
          'workday': _workday(state: 'WORKING', allowedActions: ['CLOCK_OUT']),
        },
      );

      await _bater(tester, 'CLOCK_IN');

      /*
        Permissão negada NÃO bloqueia (PRD §228).

        Uma jornada que não pode ser registrada porque o prédio é de concreto
        transfere ao funcionário um problema que não é dele.
      */
      expect(ctx.harness.transport.countOf('POST', '/time-clock/entries'), 1);
      final body =
          ctx.harness.transport.requestFor('POST', '/time-clock/entries').data
              as Map<String, dynamic>;
      expect(body.containsKey('latitude'), isFalse);
    });

    testWidgets('o GPS é pedido só no TOQUE, não ao abrir a tela', (
      tester,
    ) async {
      final ctx = await _abrir(
        tester,
        workday: _workday(state: 'NOT_STARTED', allowedActions: ['CLOCK_IN']),
      );

      // Abrir a tela não pede localização: nada de rastreamento por abertura.
      expect(ctx.gps.chamadas, 0);

      ctx.harness.transport.onJson(
        'POST',
        '/time-clock/entries',
        status: 201,
        data: {
          'workday': _workday(state: 'WORKING', allowedActions: ['CLOCK_OUT']),
        },
      );
      await _bater(tester, 'CLOCK_IN');

      expect(ctx.gps.chamadas, 1);
    });

    testWidgets('recusa do servidor aparece e não inventa marcação', (
      tester,
    ) async {
      final ctx = await _abrir(
        tester,
        workday: _workday(state: 'NOT_STARTED', allowedActions: ['CLOCK_IN']),
      );
      ctx.harness.transport.onError(
        'POST',
        '/time-clock/entries',
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'A jornada de hoje já foi encerrada.',
      );

      await _bater(tester, 'CLOCK_IN');

      expect(tester.takeException(), isNull);
      expect(find.text('A jornada de hoje já foi encerrada.'), findsOneWidget);
    });
  });

  group('marcações do dia', () {
    testWidgets('correção aprovada aparece marcada como tal', (tester) async {
      await _abrir(
        tester,
        workday: _workday(
          state: 'FINISHED',
          allowedActions: [],
          entries: [
            _entry('CLOCK_IN', '11:00'),
            _entry('CLOCK_OUT', '20:00', ajuste: true),
          ],
        ),
      );

      // Correção aprovada é VISÍVEL, não silenciosa: quem lê o espelho precisa
      // saber o que foi batido e o que foi corrigido (§229).
      expect(find.text('Correção aprovada'), findsOneWidget);
      expect(find.text('Entrada'), findsOneWidget);
      expect(find.text('Saída'), findsOneWidget);
    });

    testWidgets('pendência de correção é anunciada', (tester) async {
      await _abrir(
        tester,
        workday: _workday(
          state: 'WORKING',
          allowedActions: ['CLOCK_OUT'],
          pendingAdjustments: 2,
        ),
      );
      expect(
        find.textContaining('2 correção(ões) aguardando decisão'),
        findsOneWidget,
      );
    });
  });

  _regressaoFusoNaBatida();
}

/*
  A RESPOSTA DA BATIDA TAMBÉM CARREGA O FUSO (§253, LOW-3).

  Achado da revisão de segurança do endurecimento final. A batida é a OUTRA
  fonte de `Workday` do aplicativo: o controlador grava o que volta do `POST` e
  só depois relê `today`. Quando a releitura falha — rede caindo logo depois de
  bater, que é o caso comum em campo —, o estado FICA com o que veio da batida.

  Sem `utcOffset` nessa resposta, essa janela devolvia o aplicativo ao relógio
  do aparelho: horário exibido no fuso errado e, pior, correção montada no fuso
  errado. A janela não é de um quadro — dura até a próxima leitura que der certo.
*/
void _regressaoFusoNaBatida() {
  group('o fuso sobrevive à batida com releitura falhando', () {
    testWidgets('a hora continua no fuso da EMPRESA, não no do aparelho', (
      tester,
    ) async {
      final ctx = await _abrir(
        tester,
        workday: _workday(state: 'NOT_STARTED', allowedActions: ['CLOCK_IN']),
      );

      ctx.harness.transport.onJson(
        'POST',
        '/time-clock/entries',
        status: 201,
        data: {
          'entry': {
            'id': 'e-1',
            'type': 'CLOCK_IN',
            'occurredAt': '2026-08-29T11:02:00.000Z',
            'source': 'FIELD_APP',
          },
          'workday': _workday(
            state: 'WORKING',
            allowedActions: ['BREAK_START', 'CLOCK_OUT'],
            entries: [_entry('CLOCK_IN', '11:02')],
          ),
        },
      );

      // A RELEITURA FALHA. É este o caminho que o defeito exigia.
      ctx.harness.transport.onError(
        'GET',
        '/time-clock/today',
        status: 503,
        code: 'UPSTREAM_UNAVAILABLE',
        message: 'Servidor indisponível.',
      );

      await tester.tap(find.byKey(const Key('punch-CLOCK_IN')));
      await _settle(tester);
      await tester.tap(find.byKey(const Key('punch-confirm')));
      await _settle(tester);

      // 11:02Z em -03:00 é 08:02, e continua sendo depois da falha.
      expect(find.textContaining('Entrada às 08:02'), findsOneWidget);
    });
  });

  group('inconsistências vêm do servidor (JOR-A2)', () {
    testWidgets('o alerta aparece quando o servidor manda', (tester) async {
      /*
        O campo existia desde a Fase 1 e nunca era exibido.

        A tela APRESENTA a lista; não a deduz de `state`. Quem sabe se um dia em
        jornada é progresso ou buraco é o servidor, que conhece o fuso da
        empresa — o aplicativo não tem como decidir isso sozinho.
      */
      await _abrir(
        tester,
        workday: _workday(
          state: 'WORKING',
          allowedActions: ['BREAK_START', 'CLOCK_OUT'],
          entries: [_entry('CLOCK_IN', '11:00')],
          workedMinutes: 240,
          inconsistencies: ['Jornada em aberto.'],
        ),
      );

      expect(find.byKey(const Key('workday-inconsistencies')), findsOneWidget);
      expect(find.text('Jornada em aberto.'), findsOneWidget);
      expect(
        find.textContaining('Existe uma marcação incompleta neste dia'),
        findsOneWidget,
      );
    });

    testWidgets('sem inconsistência, nenhum alerta na tela', (tester) async {
      // Controle negativo: sem ele, o teste acima passaria com um alerta fixo.
      await _abrir(
        tester,
        workday: _workday(
          state: 'WORKING',
          allowedActions: ['BREAK_START', 'CLOCK_OUT'],
          entries: [_entry('CLOCK_IN', '11:00')],
        ),
      );

      expect(find.byKey(const Key('workday-inconsistencies')), findsNothing);
      expect(
        find.textContaining('Existe uma marcação incompleta'),
        findsNothing,
      );
    });

    testWidgets('o alerta NÃO cria uma segunda porta de correção', (
      tester,
    ) async {
      /*
        A porta única do §258 é a seção Correções.

        O teste conta o RÓTULO, não a chave: um segundo botão com outra `Key`
        foi exatamente o caso que o piloto físico encontrou.
      */
      await _abrir(
        tester,
        workday: _workday(
          state: 'WORKING',
          allowedActions: ['BREAK_START', 'CLOCK_OUT'],
          inconsistencies: ['Jornada em aberto.'],
        ),
      );

      expect(find.byKey(const Key('workday-inconsistencies')), findsOneWidget);
      expect(find.text('SOLICITAR CORREÇÃO'), findsOneWidget);
    });

    testWidgets('o histórico mostra a inconsistência do dia passado', (
      tester,
    ) async {
      /*
        A superfície REAL do sinal.

        Um dia passado em aberto mostra o tempo CONFIRMADO (4h, não as centenas
        de horas que o defeito produzia) ao lado do motivo de ele parecer curto.
      */
      await _abrir(
        tester,
        workday: _workday(state: 'NOT_STARTED', allowedActions: ['CLOCK_IN']),
        history: [
          {
            'date': '2026-08-20',
            'state': 'WORKING',
            'workedMinutes': 240,
            'breakMinutes': 60,
            'entryCount': 3,
            'pendingAdjustments': 0,
            'inconsistencies': ['Jornada em aberto.'],
          },
        ],
      );

      expect(find.text('2026-08-20'), findsOneWidget);
      expect(find.textContaining('Jornada em aberto.'), findsOneWidget);
      expect(find.text('4h'), findsOneWidget);
    });
  });
}
