import 'dart:async';

import 'package:alfaos_field/core/location/operational_position.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fake_position_source.dart';

/// # A captura de Confirmar e Corrigir — RC-1C-HOTFIX
///
/// O defeito da validação física: no mesmo telefone, o Google Maps acertou o
/// lugar e o AlfaOS gravou um ponto a mais de 1 km. O aplicativo tinha só a
/// permissão APROXIMADA; o Android entregou uma posição com precisão de
/// 2000 m, `getCurrentPosition` a devolveu por ser a primeira, e ninguém
/// olhou a precisão.
///
/// O contrato aprovado: precisão até 50 m, leitura de até 10 s e nunca de
/// antes da captura, várias leituras até ~20 s, e nenhuma leitura ruim usada —
/// nem quando é a melhor que apareceu.

/// Perto do ponto dos cenários — fictício.
const _lat = -20.3155;
const _lng = -40.3128;

/// ~1,8 km ao norte: onde a posição aproximada caiu no caso físico.
const _latLonge = -20.2993;

/// Uma política com o tempo esgotando rápido — o resto é o contrato.
const _rapida = OperationalFixPolicy(timeout: Duration(milliseconds: 200));

Future<OperationalFixResult> capturar(
  FakePositionSource gps, {
  OperationalFixPolicy policy = const OperationalFixPolicy(),
  List<double>? progresso,
  Future<void>? cancel,
}) {
  return OperationalPositionAcquirer(gps)
      .acquire(policy: policy, onReading: progresso?.add, cancel: cancel);
}

OperationalFix aceita(OperationalFixResult r) {
  if (r case OperationalFixAcquired(:final fix)) return fix;
  fail('esperava uma posição aceita, veio $r');
}

OperationalFixFailed falhou(OperationalFixResult r) {
  if (r case OperationalFixFailed()) return r;
  fail('esperava falha, veio uma posição');
}

const _passo = Duration(milliseconds: 5);

/// Espera a captura abrir o GPS — passou permissão e precisão.
Future<void> esperarEscuta(FakePositionSource gps) async {
  for (var i = 0; i < 200 && !gps.listening; i++) {
    await Future<void>.delayed(const Duration(milliseconds: 1));
  }
  expect(gps.listening, isTrue, reason: 'a captura não abriu o GPS');
}

void main() {
  group('o contrato', () {
    test('precisão até 50 m, leitura de até 10 s, espera de 20 s', () {
      const p = OperationalFixPolicy();
      expect(p.maxAccuracyMeters, 50);
      expect(p.maxAge, const Duration(seconds: 10));
      expect(p.timeout, const Duration(seconds: 20));
    });
  });

  group('GPS-01..09 — a leitura aceita', () {
    test('GPS-01 · 1200 m e depois 25 m: devolve a de 25 m', () async {
      final gps = FakePositionSource(
        script: const [
          ScriptedReading(_latLonge, _lng, accuracy: 1200),
          ScriptedReading(_lat, _lng, accuracy: 25, after: _passo),
        ],
      );
      final fix = aceita(await capturar(gps));
      expect(fix.accuracyMeters, 25);
      expect(fix.latitude, _lat);
    });

    test(
      'GPS-02 · 900 → 300 → 80 e o tempo esgota: FALHA, sem posição',
      () async {
        final gps = FakePositionSource(
          script: const [
            ScriptedReading(_lat, _lng, accuracy: 900),
            ScriptedReading(_lat, _lng, accuracy: 300, after: _passo),
            ScriptedReading(_lat, _lng, accuracy: 80, after: _passo),
          ],
        );
        final f = falhou(await capturar(gps, policy: _rapida));
        expect(f.reason, OperationalFixFailure.timeout);
        // A melhor que apareceu vai na MENSAGEM — nunca como posição.
        expect(f.bestAccuracyMeters, 80);
        expect(f.message, contains('Precisão do GPS insuficiente: 80 m.'));
        expect(f.message, contains('até 50 m'));
      },
    );

    test('GPS-03 · 50,0 m: aceita', () async {
      final gps = FakePositionSource(
        script: const [ScriptedReading(_lat, _lng, accuracy: 50.0)],
      );
      expect(aceita(await capturar(gps)).accuracyMeters, 50.0);
    });

    test('GPS-04 · 50,1 m: não aceita — sem arredondar para liberar', () async {
      final gps = FakePositionSource(
        script: const [ScriptedReading(_lat, _lng, accuracy: 50.1)],
      );
      final f = falhou(await capturar(gps, policy: _rapida));
      expect(f.reason, OperationalFixFailure.timeout);
      expect(f.message, contains('50,1 m'));
    });

    test('GPS-05 · leitura de 2 s: aceita', () async {
      // A captura abre às 10:00:00; a leitura chega às 10:00:03 com 2 s de
      // idade — nasceu DEPOIS da abertura, e é recente.
      var agora = DateTime(2026, 9, 15, 10);
      final gps = FakePositionSource(clock: () => agora);
      final captura = OperationalPositionAcquirer(
        gps,
        clock: () => agora,
      ).acquire();
      await esperarEscuta(gps);
      agora = agora.add(const Duration(seconds: 3));
      gps.emit(
        const ScriptedReading(
          _lat,
          _lng,
          accuracy: 10,
          age: Duration(seconds: 2),
        ),
      );
      expect(aceita(await captura).accuracyMeters, 10);
    });

    test('GPS-06 · leitura de 30 s: não aceita', () async {
      final gps = FakePositionSource(
        script: const [
          ScriptedReading(_lat, _lng, accuracy: 10, age: Duration(seconds: 30)),
        ],
      );
      final f = falhou(await capturar(gps, policy: _rapida));
      expect(f.reason, OperationalFixFailure.timeout);
    });

    test('GPS-07 · precisa (5 m) mas GUARDADA: velha, ou de antes da captura, não serve', () async {
      final velha = FakePositionSource(
        script: const [
          ScriptedReading(_lat, _lng, accuracy: 5, age: Duration(minutes: 3)),
        ],
      );
      expect(
        falhou(await capturar(velha, policy: _rapida)).reason,
        OperationalFixFailure.timeout,
      );

      // 5 s antes de a captura abrir, e entregue na abertura: tem só 5 s de
      // idade — e mesmo assim é a posição que o sistema tinha guardada.
      final guardada = FakePositionSource(
        script: const [
          ScriptedReading(_lat, _lng, accuracy: 5, age: Duration(seconds: 5)),
        ],
      );
      final f = falhou(await capturar(guardada, policy: _rapida));
      expect(f.reason, OperationalFixFailure.timeout);
      // E ela nem aparece como "precisão atual": não é leitura desta captura.
      expect(f.bestAccuracyMeters, isNull);
    });

    test('GPS-08 · recente com 500 m: não aceita', () async {
      final gps = FakePositionSource(
        script: const [ScriptedReading(_lat, _lng, accuracy: 500)],
      );
      expect(
        falhou(await capturar(gps, policy: _rapida)).bestAccuracyMeters,
        500,
      );
    });

    test('GPS-09 · recente com 15 m: aceita', () async {
      final gps = FakePositionSource(
        script: const [ScriptedReading(_lat, _lng, accuracy: 15)],
      );
      final fix = aceita(await capturar(gps));
      expect(fix.accuracyMeters, 15);
      expect(fix.longitude, _lng);
    });
  });

  group('GPS-10..14 — as recusas antes de medir, e o cancelamento', () {
    test('GPS-10 · permissão negada: FALHA, e o GPS nem é aberto', () async {
      final gps = FakePositionSource(
        permission: PositionPermission.denied,
        permissionAfterRequest: PositionPermission.denied,
      );
      final f = falhou(await capturar(gps));
      expect(f.reason, OperationalFixFailure.permissionDenied);
      expect(gps.requestCalls, 1);
      expect(gps.watchCalls, 0);
    });

    test(
      'GPS-11 · negada para sempre: FALHA com a saída das configurações',
      () async {
        final gps = FakePositionSource(
          permission: PositionPermission.deniedForever,
        );
        final f = falhou(await capturar(gps));
        expect(f.reason, OperationalFixFailure.permissionDeniedForever);
        expect(f.message, contains('configurações'));
        expect(gps.watchCalls, 0);
      },
    );

    test('GPS-12 · GPS desligado: FALHA', () async {
      final gps = FakePositionSource(serviceEnabled: false);
      final f = falhou(await capturar(gps));
      expect(f.reason, OperationalFixFailure.serviceDisabled);
      expect(gps.watchCalls, 0);
    });

    test(
      'GPS-13 · coordenada inválida com precisão ótima: não aceita',
      () async {
        for (final (lat, lng) in [
          (double.nan, _lng),
          (91.0, _lng),
          (_lat, double.infinity),
          (0.0, 0.0),
        ]) {
          final gps = FakePositionSource(
            script: [ScriptedReading(lat, lng, accuracy: 4)],
          );
          expect(
            falhou(await capturar(gps, policy: _rapida)).reason,
            OperationalFixFailure.timeout,
            reason: '($lat, $lng) não é coordenada',
          );
        }
      },
    );

    test('GPS-14 · cancelada: nada é devolvido, e o GPS é desligado', () async {
      final gps = FakePositionSource(
        script: const [ScriptedReading(_lat, _lng, accuracy: 300)],
      );
      final cancel = Completer<void>();
      final captura = capturar(gps, cancel: cancel.future);
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(gps.listening, isTrue);
      cancel.complete();
      final f = falhou(await captura);
      expect(f.reason, OperationalFixFailure.cancelled);
      expect(f.message, isNull, reason: 'cancelar não é erro');
      expect(gps.listening, isFalse);
    });
  });

  group('o caso físico — posição APROXIMADA', () {
    test('GPS-REAL · a primeira leitura (>1 km, 2000 m) é ignorada; a devolvida é a segunda', () async {
      final progresso = <double>[];
      final gps = FakePositionSource(
        script: const [
          ScriptedReading(_latLonge, _lng, accuracy: 2000),
          ScriptedReading(_lat, _lng, accuracy: 12, after: _passo),
        ],
      );
      final fix = aceita(await capturar(gps, progresso: progresso));
      expect(fix.latitude, _lat, reason: 'a posição a 1,8 km não pode sair');
      expect(fix.accuracyMeters, 12);
      expect(progresso, [2000, 12]);
    });

    test('só a APROXIMADA concedida: pede a precisa uma vez; recusada, falha sem medir', () async {
      final gps = FakePositionSource(precise: false);
      final f = falhou(await capturar(gps));
      expect(f.reason, OperationalFixFailure.approximateOnly);
      expect(f.message, startsWith('Ative Localização precisa'));
      expect(gps.requestCalls, 1);
      expect(gps.watchCalls, 0);
    });

    test('a precisa concedida no pedido: a captura segue', () async {
      final gps = FakePositionSource(
        precise: false,
        preciseAfterRequest: true,
        script: const [ScriptedReading(_lat, _lng, accuracy: 9)],
      );
      expect(aceita(await capturar(gps)).accuracyMeters, 9);
      expect(gps.requestCalls, 1);
    });
  });

  group('o fluxo de leituras', () {
    test(
      'aceita a primeira boa e DESLIGA o GPS — leituras depois são ignoradas',
      () async {
        final gps = FakePositionSource(
          script: const [
            ScriptedReading(_lat, _lng, accuracy: 20),
            ScriptedReading(_latLonge, _lng, accuracy: 3, after: _passo),
          ],
        );
        final fix = aceita(await capturar(gps));
        expect(fix.accuracyMeters, 20);
        expect(gps.listening, isFalse);
        expect(gps.cancels, 1);
      },
    );

    test('o tempo esgotado também desliga o GPS', () async {
      final gps = FakePositionSource(
        script: const [ScriptedReading(_lat, _lng, accuracy: 70)],
      );
      await capturar(gps, policy: _rapida);
      expect(gps.listening, isFalse);
    });

    test(
      'cada tentativa abre um fluxo NOVO — nada da anterior é reaproveitado',
      () async {
        final gps = FakePositionSource(
          script: const [ScriptedReading(_lat, _lng, accuracy: 90)],
        );
        final acquirer = OperationalPositionAcquirer(gps);
        final primeira = await acquirer.acquire(policy: _rapida);
        expect(falhou(primeira).reason, OperationalFixFailure.timeout);

        gps.script = const [ScriptedReading(_latLonge, _lng, accuracy: 11)];
        final fix = aceita(await acquirer.acquire(policy: _rapida));
        expect(fix.latitude, _latLonge);
        expect(gps.watchCalls, 2);
      },
    );

    test(
      'sem leitura nenhuma: a mensagem de tempo esgotado, sem número',
      () async {
        final f = falhou(await capturar(FakePositionSource(), policy: _rapida));
        expect(f.reason, OperationalFixFailure.timeout);
        expect(f.bestAccuracyMeters, isNull);
        expect(
          f.message,
          'Não foi possível obter uma localização com precisão suficiente. '
          'Precisão necessária: até 50 m. Vá para um local mais aberto, '
          'aguarde alguns segundos e tente novamente.',
        );
      },
    );

    test('precisão não medida (null) ou zero: não aceita', () async {
      for (final precisao in [null, 0.0, -4.0, double.infinity]) {
        final gps = FakePositionSource(
          script: [ScriptedReading(_lat, _lng, accuracy: precisao)],
        );
        expect(
          falhou(await capturar(gps, policy: _rapida)).reason,
          OperationalFixFailure.timeout,
          reason: 'precisão $precisao',
        );
      }
    });

    test(
      'o limite é o que a política diz — o do servidor, quando ele manda',
      () async {
        final gps = FakePositionSource(
          script: const [ScriptedReading(_lat, _lng, accuracy: 35)],
        );
        final f = falhou(
          await capturar(
            gps,
            policy: const OperationalFixPolicy(
              maxAccuracyMeters: 30,
              timeout: Duration(milliseconds: 200),
            ),
          ),
        );
        expect(f.message, contains('até 30 m'));
      },
    );

    test('erro do plugin vira falha tipada, sem derrubar nada', () async {
      final gps = FakePositionSource()
        ..streamError = const PositionSourceException(
          OperationalFixFailure.serviceDisabled,
        );
      expect(
        falhou(await capturar(gps)).reason,
        OperationalFixFailure.serviceDisabled,
      );

      final estranho = FakePositionSource()..streamError = StateError('x');
      expect(
        falhou(await capturar(estranho)).reason,
        OperationalFixFailure.unavailable,
      );
    });
  });

  group('evaluateReading — o juízo de uma leitura', () {
    final inicio = DateTime(2026, 9, 15, 10);
    const p = OperationalFixPolicy();
    RawPositionReading leitura({
      double lat = _lat,
      double lng = _lng,
      double? precisao = 10,
      Duration desdeOInicio = const Duration(seconds: 1),
    }) => RawPositionReading(
      latitude: lat,
      longitude: lng,
      accuracyMeters: precisao,
      timestamp: inicio.add(desdeOInicio),
    );
    ReadingVerdict julgar(
      RawPositionReading r, {
      Duration depois = const Duration(seconds: 2),
    }) => evaluateReading(
      r,
      now: inicio.add(depois),
      startedAt: inicio,
      policy: p,
    );

    test('recente e precisa: aceita', () {
      expect(julgar(leitura()), ReadingVerdict.accepted);
    });

    test('10 s de idade aceita; 10,001 s não', () {
      final r = leitura(desdeOInicio: const Duration(seconds: 1));
      expect(
        julgar(r, depois: const Duration(seconds: 11)),
        ReadingVerdict.accepted,
      );
      expect(
        julgar(r, depois: const Duration(seconds: 11, milliseconds: 1)),
        ReadingVerdict.stale,
      );
    });

    test(
      'poucos milissegundos no futuro não reprovam; muitos segundos sim',
      () {
        expect(
          julgar(
            leitura(desdeOInicio: const Duration(seconds: 2, milliseconds: 40)),
          ),
          ReadingVerdict.accepted,
          reason: 'relógio do sistema e do GNSS discordam por milissegundos',
        );
        expect(
          julgar(leitura(desdeOInicio: const Duration(seconds: 30))),
          ReadingVerdict.stale,
        );
      },
    );

    test('de antes da captura (além da tolerância): guardada', () {
      expect(
        julgar(leitura(desdeOInicio: const Duration(seconds: -3))),
        ReadingVerdict.stale,
      );
      expect(
        julgar(leitura(desdeOInicio: const Duration(seconds: -1))),
        ReadingVerdict.accepted,
        reason: 'um segundo antes está dentro da tolerância de relógio',
      );
    });

    test(
      'precisão: ausente, inválida, acima — cada uma com o seu veredito',
      () {
        expect(julgar(leitura(precisao: null)), ReadingVerdict.noAccuracy);
        expect(julgar(leitura(precisao: 0)), ReadingVerdict.invalidAccuracy);
        expect(julgar(leitura(precisao: 51)), ReadingVerdict.inaccurate);
        expect(julgar(leitura(precisao: 50)), ReadingVerdict.accepted);
      },
    );

    test('coordenada inválida vem antes de tudo', () {
      expect(julgar(leitura(lat: 0, lng: 0)), ReadingVerdict.invalidCoordinate);
    });
  });

  group('formatAccuracyMeters — igual ao servidor', () {
    // Os vetores de `customer-location-confirm.test.ts`.
    for (final (v, texto) in [
      (74.0, '74 m'),
      (50.0, '50 m'),
      (50.04, '50,1 m'),
      (50.6, '50,6 m'),
      (18.3, '18,3 m'),
      (184.2, '185 m'),
      (2000.0, '2000 m'),
    ]) {
      test('$v → $texto', () => expect(formatAccuracyMeters(v), texto));
    }
  });
}
