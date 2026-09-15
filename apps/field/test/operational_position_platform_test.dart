import 'dart:async';

import 'package:alfaos_field/core/location/operational_position.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:geolocator/geolocator.dart';

import 'support/fake_geolocator_platform.dart';

/// # A precisão que o plugin do Android esconde — RC-1C-HOTFIX-3
///
/// A validação física da RC-1C-HOTFIX-2, no `logcat`:
///
/// ```
/// gps_reading n=1 verdict=noAccuracy ageMs=5059 accuracyMeters=-
/// gps_reading n=2 verdict=noAccuracy ageMs=5039 accuracyMeters=-
/// gps_capture outcome=timeout readings=2 bestAccuracyMeters=-
/// ```
///
/// Leituras recentes, recusadas só por não terem precisão — com o sistema
/// medindo de 7 a 27 m. A causa é da versão instalada do plugin:
/// `geolocator_platform_interface` 4.3.0 criou `Position.hasAccuracy`
/// (padrão `false`), e o `geolocator_android` 4.6.2 reconstrói cada leitura em
/// `AndroidPosition.fromMap` por um construtor que não conhece o campo. No
/// Android, TODA leitura chega com `hasAccuracy == false`, com o número medido
/// intacto em `accuracy`; a captura confiava na bandeira.
///
/// Os testes da captura (`operational_position_test.dart`) entregam leituras
/// ABAIXO da fronteira `PositionSource`, e por isso nunca passaram pela
/// conversão do plugin — onde o defeito morava. Aqui a `GeolocatorPositionSource`
/// real roda sobre o plugin do Android até a borda do canal nativo: as
/// mensagens têm a forma do `LocationMapper` nativo e viram `Position` pela
/// mesma `AndroidPosition.fromMap`.

/// Perto do ponto dos cenários — fictício.
const _lat = -20.3155;
const _lng = -40.3128;

void main() {
  // A captura abre às 18:40:05; cada leitura nasce com a idade pedida.
  final agora = DateTime(2026, 9, 15, 18, 40, 5);
  const rapida = OperationalFixPolicy(timeout: Duration(milliseconds: 300));

  Map<String, dynamic> nativa({
    Duration idade = const Duration(seconds: 5),
    double? precisao,
  }) => nativeAndroidLocation(
    latitude: _lat,
    longitude: _lng,
    timestamp: agora.subtract(idade),
    accuracy: precisao,
  );

  Future<OperationalFixResult> capturar(
    FakeAndroidGeolocatorPlatform plugin,
    List<Map<String, dynamic>> mensagens, {
    OperationalFixPolicy policy = rapida,
    List<double>? progresso,
    List<ReadingDiagnostic>? diagnosticos,
    Future<void>? cancel,
  }) {
    plugin.script = mensagens;
    return OperationalPositionAcquirer(
      const GeolocatorPositionSource(),
      clock: () => agora,
    ).acquire(
      policy: policy,
      onReading: progresso?.add,
      onDiagnostic: diagnosticos?.add,
      cancel: cancel,
    );
  }

  OperationalFix aceita(OperationalFixResult r) {
    if (r case OperationalFixAcquired(:final fix)) return fix;
    fail('esperava uma posição aceita, veio $r');
  }

  OperationalFixFailed falhou(OperationalFixResult r) {
    if (r case OperationalFixFailed()) return r;
    fail('esperava falha, veio uma posição');
  }

  Future<void> esperarEscuta(FakeAndroidGeolocatorPlatform plugin) async {
    for (var i = 0; i < 200 && !plugin.listening; i++) {
      await Future<void>.delayed(const Duration(milliseconds: 1));
    }
    expect(plugin.listening, isTrue, reason: 'a captura não abriu o GPS');
  }

  group('o plugin instalado — caracterização', () {
    test('AndroidPosition.fromMap PERDE hasAccuracy; o número medido fica em accuracy', () {
      final mensagem = nativa(precisao: 17.5);

      // A interface calcula a bandeira certo, pela presença da chave…
      expect(Position.fromMap(mensagem).hasAccuracy, isTrue);

      // …e o plugin do Android a joga fora ao reconstruir a leitura.
      final android = AndroidPosition.fromMap(mensagem);
      expect(android.accuracy, 17.5);
      expect(
        android.hasAccuracy,
        isFalse,
        reason:
            'geolocator_android 4.6.2 não repassa hasAccuracy. Se este teste '
            'falhar depois de atualizar o plugin, ele passou a repassar: '
            'revisar measuredAccuracyMeters, não apagar o teste.',
      );
    });

    test('sem medida, o canal omite accuracy — e ela chega 0.0', () {
      final android = AndroidPosition.fromMap(nativa());
      expect(android.accuracy, 0.0);
      expect(android.hasAccuracy, isFalse);
      expect(Position.fromMap(nativa()).hasAccuracy, isFalse);
    });
  });

  group('measuredAccuracyMeters — o que é medida', () {
    test(
      'Android com 17,5 m medidos → 17,5: a bandeira perdida não decide',
      () {
        expect(
          measuredAccuracyMeters(
            AndroidPosition.fromMap(nativa(precisao: 17.5)),
          ),
          17.5,
        );
      },
    );

    test(
      'ACC-02 · Android SEM medida → null: nem 0 m, nem um valor presumido',
      () {
        expect(
          measuredAccuracyMeters(AndroidPosition.fromMap(nativa())),
          isNull,
        );
      },
    );

    Position posicao({required double accuracy, required bool hasAccuracy}) =>
        Position(
          latitude: _lat,
          longitude: _lng,
          timestamp: agora,
          accuracy: accuracy,
          altitude: 0,
          altitudeAccuracy: 0,
          heading: 0,
          headingAccuracy: 0,
          speed: 0,
          speedAccuracy: 0,
          hasAccuracy: hasAccuracy,
        );

    test('a plataforma afirma que mediu → o valor como veio; zero é recusado adiante', () {
      expect(
        measuredAccuracyMeters(posicao(accuracy: 18, hasAccuracy: true)),
        18,
      );

      final zero = measuredAccuracyMeters(
        posicao(accuracy: 0, hasAccuracy: true),
      );
      expect(zero, 0);
      expect(
        evaluateReading(
          RawPositionReading(
            latitude: _lat,
            longitude: _lng,
            timestamp: agora,
            accuracyMeters: zero,
          ),
          now: agora,
          policy: const OperationalFixPolicy(),
        ),
        ReadingVerdict.invalidAccuracy,
        reason: 'zero não é "zero metros de erro"',
      );
    });

    test('sem a bandeira, só número positivo e finito é medida', () {
      for (final lixo in [double.nan, double.infinity, -3.0, 0.0]) {
        expect(
          measuredAccuracyMeters(posicao(accuracy: lixo, hasAccuracy: false)),
          isNull,
          reason: '$lixo',
        );
      }
    });

    test('a leitura crua leva coordenada, instante e precisão como vieram, e os fatos do plugin', () {
      final android = AndroidPosition.fromMap(nativa(precisao: 17.5));
      final leitura = readingFromPlatformPosition(android);
      expect(leitura.latitude, _lat);
      expect(leitura.longitude, _lng);
      expect(leitura.timestamp, android.timestamp);
      expect(leitura.accuracyMeters, 17.5);

      final fatos = leitura.platform!;
      expect(fatos.type, 'AndroidPosition');
      expect(fatos.hasAccuracy, isFalse);
      expect(fatos.rawAccuracy, 17.5);
      expect(fatos.timestamp, android.timestamp);
    });
  });

  group('a captura sobre o plugin do Android', () {
    test(
      'ACC-01 · o caso do dono: 5 s de idade e 18 m MEDIDOS — aceita',
      () async {
        final plugin = installFakeAndroidGeolocator();
        final diagnosticos = <ReadingDiagnostic>[];
        final fix = aceita(
          await capturar(plugin, [
            nativa(precisao: 18),
          ], diagnosticos: diagnosticos),
        );
        expect(fix.accuracyMeters, 18);

        // O log que a validação física lê: o cru, ANTES do juízo, e o juízo.
        final d = diagnosticos.single;
        final nascida = agora.subtract(const Duration(seconds: 5));
        expect(
          d.rawLine,
          'raw_position n=1 sourceMode=primary type=AndroidPosition '
          'hasAccuracy=false rawAccuracy=18.0 rawFinite=true rawPositive=true '
          'ageMs=5000 timestampMs=${nascida.millisecondsSinceEpoch}',
        );
        expect(
          d.line,
          'gps_reading n=1 verdict=accepted ageMs=5000 '
          'bornBeforeCaptureMs=5000 accuracyMeters=18.0',
        );
        for (final linha in [d.rawLine!, d.line]) {
          expect(linha, isNot(contains('20.31')), reason: linha);
          expect(linha, isNot(contains('40.31')), reason: linha);
        }
      },
    );

    test(
      '17,5 m entram → a posição operacional carrega 17,5 m, sem arredondar',
      () async {
        final plugin = installFakeAndroidGeolocator();
        final fix = aceita(await capturar(plugin, [nativa(precisao: 17.5)]));
        expect(fix.accuracyMeters, 17.5);
        expect(fix.latitude, _lat);
        expect(fix.longitude, _lng);
        // O plugin entrega o instante em UTC: o mesmo momento, outro fuso.
        expect(
          fix.capturedAt.isAtSameMomentAs(
            agora.subtract(const Duration(seconds: 5)),
          ),
          isTrue,
        );
      },
    );

    test(
      'ACC-02 · leitura sem medida: noAccuracy, e o prazo esgota SEM posição',
      () async {
        final plugin = installFakeAndroidGeolocator();
        final diagnosticos = <ReadingDiagnostic>[];
        final falha = falhou(
          await capturar(plugin, [
            nativa(),
            nativa(idade: const Duration(seconds: 4)),
          ], diagnosticos: diagnosticos),
        );
        expect(falha.reason, OperationalFixFailure.timeout);
        expect(falha.bestAccuracyMeters, isNull);
        expect(falha.title, 'Localização não obtida');
        expect(diagnosticos.map((d) => d.verdict), [
          ReadingVerdict.noAccuracy,
          ReadingVerdict.noAccuracy,
        ]);
        expect(diagnosticos.first.rawLine, contains('rawAccuracy=0.0'));
        expect(diagnosticos.first.rawLine, contains('rawPositive=false'));
        expect(plugin.listening, isFalse, reason: 'o GPS foi desligado');
      },
    );

    test(
      'ACC-05 · 70 m e depois 25 m: aceita a SEGUNDA, no mesmo fluxo',
      () async {
        final plugin = installFakeAndroidGeolocator();
        final progresso = <double>[];
        final fix = aceita(
          await capturar(plugin, [
            nativa(precisao: 70),
            nativa(precisao: 25, idade: const Duration(seconds: 1)),
          ], progresso: progresso),
        );
        expect(fix.accuracyMeters, 25);
        expect(progresso, [
          70,
          25,
        ], reason: 'a tela viu a de 70 m, e só a usou como informação');
        expect(
          plugin.streamOpens,
          1,
          reason: 'um fluxo só, sem fonte alternativa',
        );
        expect(plugin.currentPositionCalls, 0);
        expect(plugin.lastKnownCalls, 0);
      },
    );

    test(
      '70 m é precisão CONHECIDA fora da política — não "sem precisão"',
      () async {
        final plugin = installFakeAndroidGeolocator();
        final diagnosticos = <ReadingDiagnostic>[];
        final falha = falhou(
          await capturar(plugin, [
            nativa(precisao: 70),
          ], diagnosticos: diagnosticos),
        );
        expect(diagnosticos.single.verdict, ReadingVerdict.inaccurate);
        expect(falha.bestAccuracyMeters, 70);
        expect(falha.title, 'Precisão do GPS insuficiente');
      },
    );

    test('50,0 m passa; 50,1 m não — o valor real, sem arredondar', () async {
      final plugin = installFakeAndroidGeolocator();
      expect(
        aceita(await capturar(plugin, [nativa(precisao: 50)])).accuracyMeters,
        50,
      );

      final falha = falhou(await capturar(plugin, [nativa(precisao: 50.1)]));
      expect(falha.bestAccuracyMeters, 50.1);
    });

    test('precisa (5 m) mas VELHA (12 s): recusada pela idade', () async {
      final plugin = installFakeAndroidGeolocator();
      final diagnosticos = <ReadingDiagnostic>[];
      falhou(
        await capturar(plugin, [
          nativa(precisao: 5, idade: const Duration(seconds: 12)),
        ], diagnosticos: diagnosticos),
      );
      expect(diagnosticos.single.verdict, ReadingVerdict.stale);
    });

    test('o pedido ao plugin: provedor fundido, maior prioridade, 1 s — e nada guardado', () async {
      final plugin = installFakeAndroidGeolocator();
      aceita(await capturar(plugin, [nativa(precisao: 12)]));

      final pedido = plugin.lastSettings;
      expect(pedido, isA<AndroidSettings>());
      final android = pedido! as AndroidSettings;
      expect(android.accuracy, LocationAccuracy.best);
      expect(android.distanceFilter, 0);
      expect(android.intervalDuration, const Duration(seconds: 1));
      expect(
        android.forceLocationManager,
        isFalse,
        reason: 'o fundido continua sendo a fonte: trocar de provedor não tinha prova',
      );
      expect(plugin.lastKnownCalls, 0);
      expect(plugin.currentPositionCalls, 0);
      expect(
        plugin.listening,
        isFalse,
        reason: 'o GPS foi desligado ao aceitar',
      );
    });

    test(
      'cancelar no meio da captura: nenhuma posição, e o GPS desligado',
      () async {
        final plugin = installFakeAndroidGeolocator();
        final cancelar = Completer<void>();
        final captura = capturar(
          plugin,
          const [],
          policy: const OperationalFixPolicy(),
          cancel: cancelar.future,
        );
        await esperarEscuta(plugin);
        plugin.emit(nativa());
        cancelar.complete();
        final falha = falhou(await captura);
        expect(falha.reason, OperationalFixFailure.cancelled);
        expect(falha.message, isNull);
        expect(plugin.listening, isFalse);
      },
    );

    test(
      'exceção do plugin no fluxo: falha TIPADA na hora, sem esperar o prazo',
      () async {
        final plugin = installFakeAndroidGeolocator();
        final captura = capturar(
          plugin,
          const [],
          policy: const OperationalFixPolicy(),
        );
        await esperarEscuta(plugin);
        plugin.emitError(const LocationServiceDisabledException());
        final falha = falhou(
          await captura.timeout(
            const Duration(seconds: 2),
            onTimeout: () => fail('a falha do plugin deixou a captura presa'),
          ),
        );
        expect(falha.reason, OperationalFixFailure.serviceDisabled);
        expect(plugin.listening, isFalse);
      },
    );
  });
}
